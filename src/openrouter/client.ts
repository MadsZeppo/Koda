import { PoolRouter } from "../router/modelRouter.js";
import type { ModelDiscoveryAdapter } from "../router/capabilityRegistry.js";
import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { Config } from "../config.js";
import type { Logger } from "../telemetry/logger.js";
import { Budget, parseUsage } from "./usage.js";
import {
  PARETO_CODE_MODEL,
  codingScore,
  type CodingTier,
} from "../router/codingDemand.js";
export interface CodingRoute {
  tier: Exclude<CodingTier, "frontier">;
  reason: string;
  attempt: number;
}
export type ModelDeadlineClass = "inspection" | "planning" | "implementation" | "finalization";
export const modelDeadlineClass = (stage: string): ModelDeadlineClass =>
  /final/i.test(stage) ? "finalization"
    : /^(?:inspect|discover|read)/i.test(stage) ? "inspection"
      : /^(?:plan|decompose)/i.test(stage) ? "planning" : "implementation";
const transientStatus = (status?: number) =>
  status === 408 ||
  status === 409 ||
  status === 425 ||
  status === 429 ||
  (status !== undefined && status >= 500 && status <= 599);
export function isTransientProviderError(error: unknown) {
  return (
    (error instanceof OpenAI.APIError && transientStatus(error.status)) ||
    error instanceof OpenAI.APIConnectionTimeoutError ||
    (error instanceof Error &&
      /\b(?:ETIMEDOUT|ECONNRESET|fetch failed|timeout|timed out|aborted)\b/i.test(error.message))
  );
}
export function isRouteEndpointIncompatibility(error: unknown) {
  return (
    error instanceof OpenAI.APIError && [400, 404].includes(error.status ?? 0)
  );
}
export class Gateway {
  private sdk: OpenAI;
  private readonly phaseSpent = { discovery: 0, planning: 0 };
  private readonly phaseReserved = { discovery: 0, planning: 0 };
  private readonly phaseTokens = { discovery: 0, planning: 0 };
  private readonly phaseReservedTokens = { discovery: 0, planning: 0 };
  readonly modelRouter?: PoolRouter;
  constructor(
    readonly config: Config,
    readonly logger: Logger,
    readonly budget: Budget,
    adapter?: ModelDiscoveryAdapter,
  ) {
    if (config.modelPool) this.modelRouter = new PoolRouter(config, logger, adapter);
    this.sdk = new OpenAI({
      apiKey: ((config.modelPool?.provider ?? "openrouter") === "openrouter"
        ? process.env.OPENROUTER_API_KEY : process.env.KODA_MODEL_API_KEY) || "missing",
      baseURL: config.baseUrl,
      maxRetries: 0,
      timeout: Math.max(...Object.values(config.modelTimeoutMs)),
    });
  }
  async call(
    model: string,
    messages: ChatCompletionMessageParam[],
    subtaskId: string,
    stage: string,
    attempt: number,
    tools?: ChatCompletionTool[],
    limits?: {
      maxOutputTokens?: number;
      requireTool?: boolean;
      timeoutMs?: number;
      codingRoute?: CodingRoute;
    },
  ) {
    const deadlineClass = modelDeadlineClass(stage);
    const configuredTimeout = this.config.modelTimeoutMs[deadlineClass];
    const maxOutputTokens = Math.min(
      limits?.maxOutputTokens ?? this.config.maxOutputTokens,
      this.config.maxOutputTokens,
    );
    if (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0)
      throw Error("Invalid output token limit");
    const timeoutMs = Math.min(
      limits?.timeoutMs ?? configuredTimeout,
      configuredTimeout,
      this.budget.remainingMs() - this.config.phaseBudget.verificationReserveMs,
    );
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw Error("Invalid model timeout");
    const bytes = Buffer.byteLength(JSON.stringify({ messages, tools }));
    const tokenBound = bytes + 256;
    const reserveTokens = tokenBound + maxOutputTokens;
    const pareto = model === PARETO_CODE_MODEL;
    if (
      pareto &&
      (!limits?.codingRoute ||
        !this.config.adaptiveCoding ||
        this.config.forceModel)
    )
      throw Error(
        "Pareto coding route requires an unforced adaptive coding demand",
      );
    const metadata =
      this.modelRouter && !pareto
        ? (await this.modelRouter.catalog.get()).get(model)
        : undefined;
    // The virtual router's catalog row is $0. Reserve against the configured
    // price ceiling, then settle only from authoritative response usage.
    const inputPrice =
      this.modelRouter && !pareto
        ? metadata?.inputPrice
        : this.config.maxInputPrice;
    const outputPrice =
      this.modelRouter && !pareto
        ? metadata?.outputPrice
        : this.config.maxOutputPrice;
    if (inputPrice === undefined || outputPrice === undefined)
      throw Error("Unknown model pricing; refusing request");
    if (
      metadata?.available === false ||
      (metadata?.contextLength && reserveTokens > metadata.contextLength)
    )
      throw Error("Model unavailable or context limit exceeded");
    const promptPrice = Math.min(inputPrice, this.config.maxInputPrice),
      completionPrice = Math.min(outputPrice, this.config.maxOutputPrice);
    const route = this.logger.events.findLast((event) =>
      event.subtaskId === subtaskId && event.type === "coding_route_decision");
    const fingerprint = this.logger.events.findLast((event) =>
      event.subtaskId === subtaskId && event.type === "task_fingerprint")?.fingerprint;
    const interactive = maxOutputTokens <= 4096;
    const providerPolicy = {
      require_parameters: true,
      allow_fallbacks: !this.config.forceModel,
      sort: { by: "price", partition: "none" },
      ...(interactive
        ? { preferred_max_latency: { p90: 3 } }
        : { preferred_min_throughput: { p90: 50 } }),
      max_price: { prompt: promptPrice, completion: completionPrice },
    };
    const openrouter = (this.config.modelPool?.provider ?? "openrouter") === "openrouter";
    const role = this.logger.events.findLast((event) =>
      event.type === "route" && event.subtaskId === subtaskId)?.role;
    const reasoningEffort = metadata?.supportedParameters?.includes("reasoning") && stage === "implement"
      ? role === "FRONTIER_MODEL" || route?.task_risk === "high" ||
          fingerprint?.difficulty?.changeRisk === "high" ||
          route?.verification_strength === "weak"
        ? "high"
        : (route?.verification_strength === "strong" && route?.task_risk === "low")
          ? "low" : "medium"
      : undefined;
    const sessionId = `${this.logger.runId}/${subtaskId}`;
    this.logger.log("provider_policy", { subtaskId, stage, model,
      session_id: openrouter ? sessionId : null, provider: openrouter ? providerPolicy : null,
      reasoning_effort: reasoningEffort ?? null });
    const operation = (outcome: "response" | "error", served: string | null,
      provider: unknown, wallClockMs: number, costUsd: number | null) => {
      if (!this.modelRouter) return;
      const providerName = typeof provider === "string" ? provider
        : provider && typeof provider === "object"
          ? String((provider as any).name ?? (provider as any).id ?? "") || null : null;
      this.modelRouter.history.recordOperation({
        type: "operational_call", timestamp: new Date().toISOString(),
        runId: this.logger.runId, subtaskId, stage,
        taskBucket: route?.task_bucket ??
          (fingerprint?.primary ? `${fingerprint.primary}_${fingerprint.scope}` : "general"),
        modelRequested: model, modelServed: served, provider: providerName,
        wallClockMs, outcome, costUsd,
        classification: outcome === "error" ? "OPERATIONAL_FAILURE" : undefined,
      });
    };
    const estimated =
      (tokenBound * promptPrice) / 1e6 +
      (maxOutputTokens * completionPrice) / 1e6;
    const phase = deadlineClass === "planning" ? "planning"
      : deadlineClass === "inspection" || deadlineClass === "finalization" ? "discovery" : undefined;
    if (phase) {
      const fraction = phase === "planning" ? this.config.phaseBudget.planningMaxFraction
        : this.config.phaseBudget.discoveryMaxFraction;
      if (this.phaseSpent[phase] + this.phaseReserved[phase] + estimated > this.budget.usd * fraction)
        throw Error(`${phase} phase budget exhausted`);
      if (this.phaseTokens[phase] + this.phaseReservedTokens[phase] + reserveTokens >
          this.budget.maxTokens * fraction)
        throw Error(`${phase} phase token budget exhausted`);
      const reserve = this.config.phaseBudget.implementationReserveFraction;
      if (estimated > this.budget.availableUsd(reserve) || reserveTokens > this.budget.availableTokens(reserve))
        throw Error(`${phase} cannot consume implementation reserve`);
      this.phaseReserved[phase] += estimated;
      this.phaseReservedTokens[phase] += reserveTokens;
    }
    let release: ReturnType<Budget["reserve"]>;
    try {
      release = this.budget.reserve(estimated, reserveTokens);
    } catch (error) {
      if (phase) {
        this.phaseReserved[phase] -= estimated;
        this.phaseReservedTokens[phase] -= reserveTokens;
      }
      throw error;
    }
    let phaseReleased = false;
    const releasePhase = (costUsd?: number | null, tokens = 0) => {
      if (!phase || phaseReleased) return;
      phaseReleased = true;
      this.phaseReserved[phase] -= estimated;
      this.phaseReservedTokens[phase] -= reserveTokens;
      if (costUsd !== undefined && costUsd !== null) this.phaseSpent[phase] += costUsd;
      this.phaseTokens[phase] += tokens;
    };
    const start = Date.now();
    let responseLogged = false;
    try {
      const response = await this.sdk.chat.completions.create(
        {
          model,
          messages,
          tools,
          tool_choice: limits?.requireTool ? "required" : undefined,
          max_tokens: maxOutputTokens,
          stream: false,
          ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
          ...({
            ...(pareto
              ? {
                  plugins: [
                    {
                      id: "pareto-router",
                      min_coding_score: codingScore(limits!.codingRoute!.tier),
                    },
                  ],
                }
              : {}),
            ...(openrouter ? { session_id: sessionId, provider: providerPolicy } : {}),
          } as any),
        },
        {
          timeout: timeoutMs,
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      const usage = parseUsage(response.usage);
      release(usage);
      releasePhase(usage.costUsd, usage.promptTokens + usage.completionTokens);
      this.logger.log("model_call", {
        subtaskId,
        stage,
        role:
          stage === "implement"
            ? this.logger.events.findLast(
                (e) => e.type === "route" && e.subtaskId === subtaskId,
              )?.role
            : "SCOUT_MODEL",
        modelRequested: model,
        modelReturned: response.model,
        codingTier: limits?.codingRoute?.tier,
        minCodingScore: limits?.codingRoute
          ? codingScore(limits.codingRoute.tier)
          : undefined,
        routeReason: limits?.codingRoute?.reason,
        routeAttempt: limits?.codingRoute?.attempt,
        provider: (response as any).provider ?? null,
        providerPolicy: openrouter ? providerPolicy : null,
        sessionId: openrouter ? sessionId : null,
        ttftMs: (response as any).ttft_ms ?? null,
        generationDurationMs: (response as any).generation_duration_ms ?? null,
        tokensPerSecond: Number.isFinite((response as any).generation_duration_ms) &&
          (response as any).generation_duration_ms > 0
          ? usage.completionTokens / ((response as any).generation_duration_ms / 1000) : null,
        timestampStart: new Date(start).toISOString(),
        timestampEnd: new Date().toISOString(),
        wallClockMs: Date.now() - start,
        ...usage,
        attempt,
        outcome: "response",
        responseId: response.id,
      });
      responseLogged = true;
      operation("response", response.model ?? null, (response as any).provider,
        Date.now() - start, usage.costUsd);
      if (usage.costUsd === null)
        throw Error(
          "OpenRouter omitted charged cost; stopping to avoid untracked spend",
        );
      if (pareto && (!response.model || response.model === PARETO_CODE_MODEL))
        throw Error("Pareto response omitted concrete served model");
      const message = response.choices[0]?.message;
      if (!message) throw Error("No model response");
      if (message.tool_calls?.length) {
        if (message.tool_calls.length > 8)
          throw Error("Tool protocol: too many calls");
        const ids = new Set<string>();
        for (const call of message.tool_calls) {
          if (call.type !== "function")
            throw Error("Tool protocol: custom tools unsupported");
          if (
            !call.id ||
            ids.has(call.id) ||
            !tools?.some(
              (t) =>
                t.type === "function" && t.function.name === call.function.name,
            )
          )
            throw Error("Tool protocol: unsupported or duplicate call");
          ids.add(call.id);
          try {
            const args = JSON.parse(call.function.arguments);
            if (!args || typeof args !== "object" || Array.isArray(args))
              throw Error();
          } catch {
            throw Error("Tool protocol: malformed arguments");
          }
        }
      }
      return message;
    } catch (e) {
      const rejected =
        !responseLogged &&
        e instanceof OpenAI.APIError &&
        ([400, 404].includes(e.status ?? 0) || transientStatus(e.status));
      const transient = !responseLogged && isTransientProviderError(e);
      if (rejected || transient) release(parseUsage({ cost: 0 }));
      else release();
      releasePhase(rejected || transient ? 0 : null);
      if (!responseLogged)
        this.logger.log("model_call", {
          subtaskId,
          stage,
          role:
            stage === "implement"
              ? this.logger.events.findLast(
                  (e) => e.type === "route" && e.subtaskId === subtaskId,
                )?.role
              : "SCOUT_MODEL",
          modelRequested: model,
          modelReturned: null,
          codingTier: limits?.codingRoute?.tier,
          minCodingScore: limits?.codingRoute
            ? codingScore(limits.codingRoute.tier)
            : undefined,
          routeReason: limits?.codingRoute?.reason,
          routeAttempt: limits?.codingRoute?.attempt,
          provider: null,
          timestampStart: new Date(start).toISOString(),
          timestampEnd: new Date().toISOString(),
          wallClockMs: Date.now() - start,
          ...parseUsage(rejected || transient ? { cost: 0 } : undefined),
          attempt,
          outcome: "error",
          classification: "OPERATIONAL_FAILURE",
          error: String(e),
        });
      if (!responseLogged) operation("error", null, null, Date.now() - start,
        rejected || transient ? 0 : null);
      this.logger.log("model_error", {
        subtaskId,
        stage,
        role:
          stage === "implement"
            ? this.logger.events.findLast(
                (e) => e.type === "route" && e.subtaskId === subtaskId,
              )?.role
            : "SCOUT_MODEL",
        modelRequested: model,
        attempt,
        wallClockMs: Date.now() - start,
        error: String(e),
        classification: "OPERATIONAL_FAILURE",
      });
      throw e;
    }
  }
  availableUsd(stage: string) {
    const deadlineClass = modelDeadlineClass(stage);
    return deadlineClass === "implementation"
      ? this.budget.remainingUsd()
      : this.budget.availableUsd(this.config.phaseBudget.implementationReserveFraction);
  }
  availableTokens(stage: string) {
    const deadlineClass = modelDeadlineClass(stage);
    return deadlineClass === "implementation"
      ? this.budget.remainingTokens()
      : this.budget.availableTokens(this.config.phaseBudget.implementationReserveFraction);
  }
}

export function canFallback(error: unknown, gateway: Gateway) {
  return (
    !gateway.budget.unknown &&
    gateway.budget.remainingMs() > 1 &&
    (isTransientProviderError(error) ||
      (error instanceof OpenAI.APIError &&
        [400, 404].includes(error.status ?? 0)) ||
      (error instanceof Error &&
        /No model response|protocol/.test(error.message)))
  );
}

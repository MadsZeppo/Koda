import {AUTO_MODEL,autoRequestPlugin,autoTaskTier} from "../router/openRouterAutoPolicy.js";
import { admitProviderPayload, MAX_PROVIDER_OUTPUT_TOKENS } from "../context/packetPolicy.js";
import { PoolRouter } from "../router/modelRouter.js";
import type { ModelDiscoveryAdapter } from "../router/capabilityRegistry.js";
import OpenAI from "openai";
import { providerTransport, providerErrorOrigin } from '../provider/transport.js';
import type {
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { Config } from "../config.js";
import type { Logger } from "../telemetry/logger.js";
import { Budget, estimateUsageCost, parseUsage } from "./usage.js";
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
export function isReasoningDisableRejected(error: unknown) {
  return (
    error instanceof OpenAI.APIError &&
    error.status === 400 &&
    /reasoning[^\n]*(?:mandatory|required|cannot be disabled)|(?:mandatory|required)[^\n]*reasoning/i.test(
      String(error),
    )
  );
}
export function isRouteEndpointIncompatibility(error: unknown) {
  return (
    error instanceof OpenAI.APIError && [400, 404].includes(error.status ?? 0)
  );
}
/** Provider reasoning depth follows semantic work, not consequence vocabulary. */
export function implementationReasoningEffort(route: any, fingerprint: any):
  "low" | "medium" | "high" {
  const semantic = fingerprint?.semanticComplexity ??
    fingerprint?.difficulty?.technicalComplexity ?? "medium";
  const coupling = fingerprint?.architecturalCoupling ??
    fingerprint?.difficulty?.architecturalComplexity ?? "medium";
  const localization = fingerprint?.localizationUncertainty ??
    fingerprint?.difficulty?.contextUncertainty ?? "medium";
  if (route?.verification_strength === "weak" || semantic === "high" ||
      coupling === "high" || localization === "high" ||
      fingerprint?.architectureHeavy || fingerprint?.crossComponent)
    return "high";
  if (route?.verification_strength === "strong" && semantic === "low" &&
      coupling === "low" && localization === "low") return "low";
  return "medium";
}
export class Gateway {
  private sdk: OpenAI;
  private readonly mandatoryReasoningModels = new Set<string>();
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
    if (config.modelPool) this.modelRouter = new PoolRouter(config, logger, adapter, () => budget.remainingUsd());
    const transport = providerTransport(config.baseUrl, config.modelPool?.provider);
    this.sdk = new OpenAI({
      apiKey: transport.apiKey,
      baseURL: transport.baseUrl,
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
      disableReasoning?: boolean;
      reasoningEffort?: "low" | "medium" | "high";
      responseFormat?: OpenAI.Chat.Completions.ChatCompletionCreateParams["response_format"];
    },
  ): Promise<ChatCompletionMessage> {
    const deadlineClass = modelDeadlineClass(stage);
    const configuredTimeout = this.config.modelTimeoutMs[deadlineClass];
    const maxOutputTokens = Math.min(
      limits?.maxOutputTokens ?? this.config.maxOutputTokens,
      MAX_PROVIDER_OUTPUT_TOKENS,
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
    let tokenBound = admitProviderPayload({ model, messages, tools, max_tokens: maxOutputTokens }, maxOutputTokens).inputTokens;
    let reserveTokens = tokenBound + maxOutputTokens;
    const auto = model === AUTO_MODEL;
    const autoSettings = this.config.routing.openRouterAuto;
    if(auto && (this.config.routing.authority !== "openrouter-auto" || !autoSettings)) throw Error("Auto requires explicit opt-in pool configuration");
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
      this.modelRouter && !pareto && !auto
        ? (await this.modelRouter.catalog.get()).get(model)
        : undefined;
    // The virtual router's catalog row is $0. Reserve against the configured
    // price ceiling, then settle only from authoritative response usage.
    const inputPrice =
      this.modelRouter && !pareto && !auto
        ? metadata?.inputPrice
        : this.config.maxInputPrice;
    const outputPrice =
      this.modelRouter && !pareto && !auto
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
    const reasoningMandatory = metadata?.reasoning?.mandatory === true || this.mandatoryReasoningModels.has(model);
    const requestedEffort = limits?.reasoningEffort ??
      (stage === "completion-review" && reasoningMandatory ? "low" : undefined);
    const supportedEfforts = metadata?.reasoning?.supported_efforts;
    const allowedEffort = !supportedEfforts || (requestedEffort && supportedEfforts.includes(requestedEffort))
      ? requestedEffort : undefined;
    const reasoningEffort = metadata?.supportedParameters?.includes("reasoning")
      ? allowedEffort ?? (stage === "implement" ? implementationReasoningEffort(route, fingerprint) : undefined)
      : undefined;
    const sessionId = `${this.logger.runId}/${subtaskId}`;
    this.logger.log("provider_policy", { subtaskId, stage, model,
      session_id: openrouter ? sessionId : null, provider: openrouter ? providerPolicy : null,
      reasoning_effort: reasoningEffort ?? null });
    const providerPayload = {
          ...(auto ? {plugins:[autoRequestPlugin({models:autoSettings!.models ?? [...(this.config.modelPool?.models.map(m=>m.id) ?? [])],costTier:autoSettings!.costTier==="auto"?autoTaskTier(fingerprint as any ?? {}):autoSettings!.costTier})]} : {}),
          model,
          messages,
          tools,
          tool_choice: limits?.requireTool ? "required" as const : undefined,
          max_tokens: maxOutputTokens,
          stream: false as const,
          ...(limits?.responseFormat && metadata?.supportedParameters?.includes("structured_outputs")
            ? { response_format: limits.responseFormat } : {}),
          ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
          ...(limits?.disableReasoning && !reasoningMandatory && metadata?.supportedParameters?.includes("reasoning")
            ? { reasoning: { enabled: false } } : {}),
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
        };
    const finalBound = admitProviderPayload(providerPayload, maxOutputTokens, metadata?.contextLength);
    tokenBound = finalBound.inputTokens;
    reserveTokens = tokenBound + maxOutputTokens;
    this.logger.log("provider_payload_bound", { subtaskId, stage, ...finalBound });
    const operation = (outcome: "response" | "error", served: string | null,
      provider: unknown, wallClockMs: number, costUsd: number | null,
      costSource?: "provider_reported" | "estimated_from_tokens",
      failureKind?: "tool_protocol_incompatible" | "timeout" | "provider") => {
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
        wallClockMs, outcome, costUsd, costSource,
        classification: outcome === "error" ? "OPERATIONAL_FAILURE" : undefined,
        failureKind,
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
    let providerResponseReceived = false;
    try {
      const response = await this.sdk.chat.completions.create(
        providerPayload,
        {
          timeout: timeoutMs,
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      providerResponseReceived = true;
      const providerUsage = parseUsage(response.usage);
      const estimatedUsageCost = providerUsage.costUsd === null
        ? estimateUsageCost(providerUsage, promptPrice, completionPrice)
        : null;
      if (providerUsage.costUsd === null && estimatedUsageCost === null)
        throw Error(
          "Provider omitted charged cost and usable token counts; stopping to avoid untracked spend",
        );
      const costSource = providerUsage.costUsd === null
        ? "estimated_from_tokens" as const
        : "provider_reported" as const;
      const usage = providerUsage.costUsd === null
        ? { ...providerUsage, costUsd: estimatedUsageCost! }
        : providerUsage;
      release.settle(usage);
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
        timeoutMs,
        ...usage,
        providerReportedCostUsd: providerUsage.costUsd,
        costSource,
        attempt,
        outcome: "response",
        responseId: response.id,
      });
      responseLogged = true;
      operation("response", response.model ?? null, (response as any).provider,
        Date.now() - start, usage.costUsd, costSource);
      if(auto && (!response.model || !(autoSettings!.models ?? this.config.modelPool?.models.map(m=>m.id) ?? []).includes(response.model))) throw Error("provider_protocol_error: Auto returned no authorized concrete model");
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
      const rejectedBeforeExecution =
        !responseLogged &&
        e instanceof OpenAI.APIError &&
        [400, 404].includes(e.status ?? 0);
      const transient = !responseLogged && isTransientProviderError(e);
      const unboundedCost = !responseLogged &&
        /omitted charged cost and usable token counts/i.test(String(e));
      // The request was bounded before dispatch. If usage is unavailable,
      // consume that entire reservation rather than poisoning every later call.
      if (unboundedCost) release.settleUncertain();
      else if (rejectedBeforeExecution) release.cancel();
      else if (!responseLogged) release.settleUncertain();
      // A response has already settled the reservation exactly once. Errors
      // while validating that response must not charge it a second time.
      if (rejectedBeforeExecution) releasePhase(0);
      else if (unboundedCost) releasePhase(estimated, reserveTokens);
      else if (!responseLogged) releasePhase(estimated, reserveTokens);
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
          timeoutMs,
          ...parseUsage(rejectedBeforeExecution ? { cost: 0 } : undefined),
          attempt,
          outcome: "error",
          classification: "OPERATIONAL_FAILURE",
          error: String(e),
        });
      if (!responseLogged) operation("error", null, null, Date.now() - start,
        rejectedBeforeExecution ? 0 : transient ? estimated : null, undefined,
        isRouteEndpointIncompatibility(e) && /tool_choice|tool protocol|tools?[^\n]*support/i.test(String(e))
          ? "tool_protocol_incompatible"
          : /timeout|timed out|ETIMEDOUT|AbortError/i.test(String(e)) ? "timeout" : "provider");
      this.logger.log("model_error", {
        errorOrigin: providerErrorOrigin(e),
        failureOrigin: providerResponseReceived ? "response_validation" : "provider",
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
      // A catalog advertising `reasoning` support does not prove that the
      // endpoint permits `{ enabled: false }`. Some endpoints require
      // reasoning. A rejected request has no provider usage, so retry the same
      // bounded request once without disabling reasoning. Completion review
      // must not inherit an expensive provider default after this rejection.
      if (limits?.disableReasoning && isReasoningDisableRejected(e)) {
        // Keep observed capability evidence for later review batches in this
        // run, including catalogs cached before reasoning metadata existed.
        this.mandatoryReasoningModels.add(model);
        this.logger.log("provider_parameter_retry", {
          subtaskId,
          stage,
          model,
          parameter: "reasoning.enabled",
          classification: "OPERATIONAL_FAILURE",
        });
        return this.call(model, messages, subtaskId, stage, attempt, tools, {
          ...limits,
          disableReasoning: false,
          reasoningEffort: limits?.reasoningEffort ?? (stage === "completion-review" ? "low" : undefined),
        });
      }
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

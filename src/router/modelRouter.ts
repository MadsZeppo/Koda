import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Config } from "../config.js";
import type { Logger } from "../telemetry/logger.js";
import { Catalog } from "../openrouter/catalog.js";
import { History, attributableCodingFailure } from "./history.js";
import { historyMatches, taskBucket, type Features } from "./features.js";
import { type PoolModel, type Metadata } from "./pool.js";
import { CapabilityRegistry, type ModelDiscoveryAdapter } from "./capabilityRegistry.js";
import { optimizeSpecialists } from "./routeOptimizer.js";
import type { TaskFingerprint } from "./taskFingerprint.js";
export interface Candidate {
  model: PoolModel;
  metadata: Metadata;
  quality: number;
  cost: number;
  latency: number;
  score: number;
  rejected?: string;
}
export function rankCandidates(
  models: PoolModel[],
  metadata: Map<string, Metadata>,
  history: ReturnType<History["read"]>,
  features: Features,
  routing: Config["routing"],
  inputTokens: number,
  outputTokens: number,
): Candidate[] {
  const candidates = models.map((model) => {
    const md = metadata.get(model.id) ?? {};
    const rows = history.filter(
      (r) =>
        r.modelRequested === model.id &&
        (r.verification !== "FAILED" || features.taskKind === "planning" || attributableCodingFailure(r)) &&
        historyMatches(r.features, features) &&
        !/provider|infra|timeout|rate.limit|transport|\b429\b|HTTP 5\d\d|unavailable|unknown pricing/i.test(
          r.verification === "FAILED" ? r.reason ?? "" : "",
        ) &&
        (features.taskKind === "planning"
          ? ["DAG_VALIDATED", "FAILED"]
          : ["VERIFIED_SUCCESS", "FAILED"]
        ).includes(r.verification),
    );
    const penalty =
      features.complexity === "large" && !model.strengths.includes("repo_scale")
        ? 0.12
        : features.complexity === "medium" &&
            !model.strengths.includes("reasoning")
          ? 0.04
          : 0;
    const prior = Math.max(0, model.qualityPrior - penalty);
    const successes = rows.filter(
      (r) =>
        r.verification === "VERIFIED_SUCCESS" ||
        (features.taskKind === "planning" &&
          r.verification === "DAG_VALIDATED"),
    ).length;
    // A single unsuccessful attempt is weak evidence about a model's ability
    // for this class. Repeated failures still lower the posterior below the
    // unchanged quality gate; verified successes add full positive evidence.
    const failureWeight = 0.2 * (rows.length - successes);
    const quality =
      (prior * routing.priorStrength + successes) /
      (routing.priorStrength + successes + failureWeight);
    const latency =
      (model.latencyPriorMs * routing.priorStrength +
        rows.reduce((n, r) => n + r.wallClockMs, 0)) /
      (routing.priorStrength + rows.length);
    const cost =
      md.inputPrice === undefined || md.outputPrice === undefined
        ? Infinity
        : (inputTokens * md.inputPrice + outputTokens * md.outputPrice) / 1e6;
    const plannerUnsupported =
      features.taskKind === "planning" &&
      (!model.strengths.includes("structured_output") ||
        (md.supportedParameters &&
          !md.supportedParameters.some((p) =>
            ["structured_outputs", "response_format"].includes(p),
          )));
    const rejected = plannerUnsupported
      ? "structured planning unsupported"
      : !model.enabled
        ? "disabled"
        : md.available === false
          ? "unavailable"
          : !Number.isFinite(cost)
            ? "unknown pricing"
            : md.contextLength && inputTokens + outputTokens > md.contextLength
              ? "context limit"
              : features.taskKind !== "planning" &&
                  (!model.strengths.includes("tool_use") ||
                    (md.supportedParameters &&
                      !md.supportedParameters.includes("tools")))
                ? "tools unsupported"
                : quality < routing.minimumQuality
                  ? "below quality threshold"
                  : undefined;
    return { model, metadata: md, quality, cost, latency, score: 0, rejected };
  });
  const eligible = candidates.filter((c) => !c.rejected);
  const costScale = Math.max(1e-9, ...eligible.map((c) => c.cost)),
    timeScale = Math.max(1, ...eligible.map((c) => c.latency));
  for (const c of candidates)
    c.score =
      (routing.costWeight * c.cost) / costScale +
      (routing.latencyWeight * c.latency) / timeScale;
  return candidates.sort(
    (a, b) => a.score - b.score || a.model.id.localeCompare(b.model.id),
  );
}
export class PoolRouter {
  readonly catalog: Catalog;
  readonly history: History;
  readonly capabilities: CapabilityRegistry;
  readonly disabled = new Set<string>();
  private readonly raceSelections = new Map<string, Set<string>>();
  constructor(
    readonly config: Config,
    readonly logger: Logger,
    adapter?: ModelDiscoveryAdapter,
  ) {
    const dir =
      config.routing.stateDirectory ??
      join(
        homedir(),
        ".koda",
        "model-router",
        createHash("sha256").update(config.baseUrl).digest("hex").slice(0, 12),
      );
    this.catalog = new Catalog(
      config.baseUrl,
      dir,
      config.routing.cacheTtlMs,
      config.modelPool!.models,
    );
    this.history = new History(dir);
    this.capabilities = new CapabilityRegistry(config, this.catalog, adapter);
  }
  async selectSpecialist(
    fingerprint: TaskFingerprint,
    features: Features,
    subtaskId: string,
    budgetUsd: number,
    raceGroup?: string,
  ) {
    const models = (await this.capabilities.forTask(fingerprint)).filter(
      (item) => !this.disabled.has(item.model.id),
    );
    const reserved = raceGroup ? this.raceSelections.get(raceGroup) ?? new Set<string>() : new Set<string>();
    const result = optimizeSpecialists(
      models, fingerprint, features, this.history.read(), this.config, budgetUsd,
      this.history.readOperations(), reserved,
    );
    const cascade = result.cascade;
    if (raceGroup && cascade.length) {
      reserved.add(cascade[0]!.model.id);
      this.raceSelections.set(raceGroup, reserved);
    }
    this.logger.log("specialist_route", {
      subtaskId, fingerprint, reason: result.reason,
      verification_strength: fingerprint.verificationStrength,
      allowed_quality_regret: result.allowedRegret,
      first_attempt_quality_floor: result.considered[0]?.firstAttemptQualityFloor ?? this.config.routing.minimumQuality,
      reference_model: result.reference?.model.id ?? null,
      reference_expected_success: result.reference?.quality ?? null,
      reference_conservative_success: result.reference?.conservativeQuality ?? null,
      reference_plan: result.referencePlan ?? null,
      reference_expected_cost_usd: result.referencePlan?.expectedCompletionCost ?? null,
      reference_expected_latency_ms: result.referencePlan?.expectedCompletionLatencyMs ?? null,
      selected_model: cascade[0]?.model.id ?? null,
      selected_plan: result.selectedPlan ?? null,
      expected_standalone_success: result.selectedPlan?.expectedStandaloneSuccess ?? null,
      expected_final_success: result.selectedPlan?.expectedFinalSuccess ?? null,
      expected_completion_cost_usd: result.selectedPlan?.expectedCompletionCost ?? null,
      expected_completion_latency_ms: result.selectedPlan?.expectedCompletionLatencyMs ?? null,
      quality_gap: result.selectedPlan?.qualityGap ?? null,
      plans: result.plans,
      fallback_chain: cascade.map((candidate) => candidate.model.id),
      candidates: result.considered.map((candidate) => ({
        id: candidate.model.id,
        rejected: candidate.rejected,
        success: candidate.quality,
        expected_final_success: candidate.expectedFinalSuccess,
        conservative_success: candidate.conservativeQuality,
        quality_gap: candidate.qualityGap,
        uncertainty: candidate.uncertainty,
        quality_floor_passed: candidate.qualityFloorPassed,
        confidence: candidate.confidence,
        call_cost_usd: Number.isFinite(candidate.cost) ? candidate.cost : null,
        expected_completion_cost_usd: Number.isFinite(candidate.expectedCompletionCost) ? candidate.expectedCompletionCost : null,
        expected_completion_latency_ms: Number.isFinite(candidate.expectedCompletionLatencyMs) ? candidate.expectedCompletionLatencyMs : null,
        latency_ms: candidate.latency,
        call_count: candidate.callCount,
        latency_ewma_ms: candidate.latencyEwmaMs,
        latency_p50_ms: candidate.latencyP50Ms,
        latency_p90_ms: candidate.latencyP90Ms,
        latency_sla_passed: candidate.latencySlaPassed,
        operational_error_rate: candidate.operationalErrorRate,
        evidence: candidate.evidence,
        capability_evidence: models.find((item) => item.model.id === candidate.model.id)?.capabilityEvidence ?? [],
      })),
    });
    return cascade;
  }
  recordServed(
    features: Features,
    subtaskId: string,
    since: number,
    verification: string,
    escalated: boolean,
    reason?: string,
    fingerprint?: TaskFingerprint,
  ) {
    if (verification !== "VERIFIED_SUCCESS" && !(verification === "FAILED" && escalated)) return;
    const calls = this.logger.events.slice(since).filter((event) =>
      event.type === "model_call" && event.subtaskId === subtaskId &&
      event.modelRequested === "openrouter/pareto-code" &&
      typeof event.modelReturned === "string" && event.modelReturned !== "openrouter/pareto-code" &&
      event.costUsd !== null,
    );
    for (const call of calls) {
      this.history.record({
        timestamp: new Date().toISOString(), runId: this.logger.runId, subtaskId,
        modelRequested: call.modelReturned, modelServed: call.modelReturned,
        features, fingerprint, verification, wallClockMs: call.wallClockMs,
        inputTokens: call.promptTokens, outputTokens: call.completionTokens,
        costUsd: call.costUsd, escalated, reason,
        failureAttribution: verification === "FAILED" && reason === "focused_verification_failed"
          ? "verified_patch_regression" as const : undefined,
      });
    }
  }
  async select(
    features: Features,
    subtaskId: string,
    excluded: string[] = [],
    previous?: PoolModel,
    fallback = false,
    raceGroup?: string,
  ) {
    const discovered = this.config.specialistRouting
      ? await this.capabilities.all() : undefined;
    const metadata = await this.catalog.get();
    let models = discovered?.map((item) => item.model) ?? this.config.modelPool!.models;
    if (
      features.taskKind === "planning" &&
      this.config.routing.plannerCandidates
    )
      models = models.filter((m) =>
        this.config.routing.plannerCandidates!.includes(m.id),
      );
    const considered = rankCandidates(
      models,
      metadata,
      this.history.read(),
      features,
      this.config.routing,
      features.contextBytes + 256,
      this.config.maxOutputTokens,
    );
    const force = this.config.forceModel;
    if (raceGroup)
      excluded = [...excluded, ...(this.raceSelections.get(raceGroup) ?? [])];
    const eligible = considered.filter(
      (c) =>
        !excluded.includes(c.model.id) &&
        !this.disabled.has(c.model.id) &&
        (!previous || fallback || c.model.id !== previous.id),
    );
    // A pinned evaluation model may be used for successive turns of the same
    // task. Run-local exclusion is for fallback candidates, not the pin.
    // Capability, availability, pricing and provider rejection still apply.
    const selected = force
      ? considered.find(
          (c) =>
            c.model.id === force &&
            !this.disabled.has(c.model.id) &&
            (!c.rejected || c.rejected === "below quality threshold"),
        )
      : eligible.find((c) => !c.rejected);
    this.logger.log("model_router", {
      subtaskId,
      selected_model: selected?.model.id ?? null,
      routing_reason: !selected
        ? "no eligible candidate"
        : force
          ? "forced evaluation"
          : `meets ${this.config.routing.minimumQuality} quality threshold; lowest weighted cost/latency`,
      estimated_quality: selected?.quality ?? null,
      task_bucket: taskBucket(features),
      features,
      candidates: considered.map((c) => ({
        id: c.model.id,
        quality: c.quality,
        cost_est: Number.isFinite(c.cost) ? c.cost : null,
        latency_est: c.latency,
        metadata: c.metadata,
        score: Number.isFinite(c.score) ? c.score : null,
        rejected:
          c.rejected ??
          (excluded.includes(c.model.id) && c.model.id !== force
            ? "already attempted or reserved for race"
            : this.disabled.has(c.model.id)
              ? "provider rejected in this run"
              : undefined),
      })),
      previous_model: previous?.id,
    });
    if (!selected)
      throw Error(
        force
          ? "Forced model unavailable, unsupported, or unpriced"
          : "No untried model meets quality, capability, availability and pricing requirements",
      );
    if (raceGroup) {
      const ids = this.raceSelections.get(raceGroup) ?? new Set<string>();
      ids.add(selected.model.id);
      this.raceSelections.set(raceGroup, ids);
    }
    return selected;
  }
  async selectFrontierRescue(features: Features, subtaskId: string) {
    const considered = rankCandidates(
      this.config.modelPool!.models.filter(
        (model) => model.tier === "frontier",
      ),
      await this.catalog.get(),
      this.history.read(),
      features,
      this.config.routing,
      features.contextBytes + 256,
      this.config.maxOutputTokens,
    );
    const selected = considered.find(
      (candidate) =>
        !candidate.rejected && !this.disabled.has(candidate.model.id),
    );
    this.logger.log("frontier_rescue_route", {
      subtaskId,
      selected_model: selected?.model.id ?? null,
      candidates: considered.map((candidate) => ({
        model: candidate.model.id,
        rejected: candidate.rejected,
      })),
    });
    if (!selected) throw Error("No eligible priced frontier rescue model");
    return selected;
  }
  record(
    model: PoolModel,
    features: Features,
    subtaskId: string,
    since: number,
    verification: string,
    escalated: boolean,
    reason?: string,
    fingerprint?: TaskFingerprint,
  ) {
    const calls = this.logger.events
      .slice(since)
      .filter(
        (e) =>
          e.type === "model_call" &&
          e.subtaskId === subtaskId &&
          e.modelRequested === model.id,
      );
    if (!calls.length) return;
    const record = {
      timestamp: new Date().toISOString(),
      runId: this.logger.runId,
      subtaskId,
      modelRequested: model.id,
      modelServed: calls.at(-1)?.modelReturned ?? null,
      features,
      fingerprint,
      verification,
      wallClockMs: calls.reduce((n, c) => n + c.wallClockMs, 0),
      inputTokens: calls.reduce((n, c) => n + c.promptTokens, 0),
      outputTokens: calls.reduce((n, c) => n + c.completionTokens, 0),
      costUsd: calls.some((c) => c.costUsd === null)
        ? null
        : calls.reduce((n, c) => n + c.costUsd, 0),
      escalated,
      reason,
      failureAttribution: verification === "FAILED" && reason === "focused_verification_failed"
        ? "verified_patch_regression" as const : undefined,
    };
    this.history.record(record);
    this.logger.log("model_attempt", record);
  }
}

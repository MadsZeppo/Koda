import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Config } from "../config.js";
import type { Logger } from "../telemetry/logger.js";
import { Catalog } from "../openrouter/catalog.js";
import { History, attributableCodingFailure } from "./history.js";
import { historyMatches, taskBucket, type Features } from "./features.js";
import { type PoolModel, type Metadata, supportsParameters } from "./pool.js";
import {
  CapabilityRegistry,
  type ModelDiscoveryAdapter,
} from "./capabilityRegistry.js";
import {
  optimizeSpecialists,
  type ExecutionPlanEstimate,
  type SpecialistEstimate,
} from "./routeOptimizer.js";
import type { TaskFingerprint } from "./taskFingerprint.js";
import {
  activeModelBoard,
  chooseAdaptiveRecovery,
  effectiveRecoveryFailureMode,
  freezeExecutionPolicy,
  requiredQualityClass,
  type FrozenExecutionPolicy,
  type RecoveryObservation,
} from "./controlPolicy.js";
import { usesDirectEditEngine } from "../agent/attemptPolicy.js";
export const routerStateDirectory = (config: Config) =>
  config.routing.stateDirectory ??
  join(
    homedir(),
    ".koda",
    "model-router",
    createHash("sha256").update(config.baseUrl).digest("hex").slice(0, 12),
  );
export interface FrozenExecutionPlan extends FrozenExecutionPolicy<SpecialistEstimate> {
  readonly type: "single" | "cascade";
  readonly executionEngine: TaskFingerprint["executionStrategy"];
  readonly initialCandidate: SpecialistEstimate;
  readonly evidenceClass: SpecialistEstimate["evidenceLevel"];
  readonly conservativeQuality: number;
  readonly expectedCostPerVerifiedSolve: number;
  readonly expectedLatencyMs: number;
  readonly expectedLatencyP50Ms?: number;
  readonly expectedLatencyP90Ms?: number;
  readonly expectedTotalCostUsd?: number;
  readonly optimizerScore?: number;
  readonly allowedQualityRegret?: number;
  readonly discoveredModelCount?: number;
  readonly evaluatedCandidates?: readonly SpecialistEstimate[];
  readonly evaluatedPlans?: readonly ExecutionPlanEstimate[];
  readonly whySelected: string;
  readonly verificationStrength: TaskFingerprint["verificationStrength"];
  readonly stopConditions: readonly string[];
}
export interface Candidate {
  model: PoolModel;
  metadata: Metadata;
  quality: number;
  cost: number;
  latency: number;
  score: number;
  /** Only execution incompatibilities belong here; quality targets are soft. */
  hardRejection?: string;
  softPenalties?: string[];
  qualityTargetMet?: boolean;
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
  limits: { budgetUsd?: number; excluded?: ReadonlySet<string> } = {},
): Candidate[] {
  const candidates = models.map((model) => {
    const md = metadata.get(model.id) ?? {};
    const protocolKnown =
      md.routableParameterSets !== undefined ||
      md.supportedParameters !== undefined;
    const rows = history.filter(
      (r) =>
        r.modelRequested === model.id &&
        (r.verification !== "FAILED" ||
          features.taskKind === "planning" ||
          attributableCodingFailure(r)) &&
        historyMatches(r.features, features) &&
        !/provider|infra|timeout|rate.limit|transport|\b429\b|HTTP 5\d\d|unavailable|unknown pricing/i.test(
          r.verification === "FAILED" ? (r.reason ?? "") : "",
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
      protocolKnown &&
      !["structured_outputs", "response_format"].some((parameter) =>
        supportsParameters(md, [parameter]),
      );
    const freeModel = model.id.endsWith(":free") ||
      model.id === "openrouter/free" ||
      (md.inputPrice === 0 && md.outputPrice === 0);
    const rejected = freeModel
      ? "free models temporarily disabled"
      : model.id.endsWith(":batch")
      ? "batch endpoint unsupported for interactive worker"
      : plannerUnsupported
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
                  protocolKnown &&
                  !supportsParameters(
                    md,
                    features.executionStrategy === "stable"
                      ? ["tools", "tool_choice"]
                      : ["tools"],
                  )
                ? "tools unsupported"
                : cost > (limits.budgetUsd ?? Infinity)
                  ? "remaining budget"
                  : limits.excluded?.has(model.id)
                    ? "already attempted or reserved for race"
                    : undefined;
    const qualityTargetMet = quality >= routing.minimumQuality;
    return {
      model,
      metadata: md,
      quality,
      cost,
      latency,
      score: 0,
      rejected,
      hardRejection: rejected,
      qualityTargetMet,
      softPenalties: qualityTargetMet ? [] : ["below preferred quality target"],
    };
  });
  const eligible = candidates.filter((c) => !c.rejected);
  const costScale = Math.max(1e-9, ...eligible.map((c) => c.cost)),
    timeScale = Math.max(1, ...eligible.map((c) => c.latency));
  for (const c of candidates)
    c.score =
      (routing.costWeight * c.cost) / costScale +
      (routing.latencyWeight * c.latency) / timeScale;
  const targetAvailable = eligible.some(
    (candidate) => candidate.qualityTargetMet,
  );
  return candidates.sort(
    (a, b) =>
      Number(!!a.hardRejection) - Number(!!b.hardRejection) ||
      (targetAvailable
        ? Number(b.qualityTargetMet) - Number(a.qualityTargetMet) ||
          a.score - b.score
        : b.quality - a.quality || a.score - b.score) ||
      a.model.id.localeCompare(b.model.id),
  );
}
export class PoolRouter {
  readonly catalog: Catalog;
  readonly history: History;
  readonly capabilities: CapabilityRegistry;
  readonly disabled = new Set<string>();
  private readonly raceSelections = new Map<string, Set<string>>();
  private readonly raceRoutingLocks = new Map<string, Promise<void>>();
  constructor(
    readonly config: Config,
    readonly logger: Logger,
    adapter?: ModelDiscoveryAdapter,
    private readonly remainingBudget: () => number = () => config.budgetUsd,
  ) {
    const dir = routerStateDirectory(config);
    this.catalog = new Catalog(
      config.baseUrl,
      dir,
      config.routing.cacheTtlMs,
      config.modelPool!.models,
    );
    this.history = new History(dir);
    this.capabilities = new CapabilityRegistry(
      config,
      this.catalog,
      adapter,
      dir,
    );
  }
  async freezeRunSnapshot() {
    await this.capabilities.freezeRunSnapshot();
  }
  async selectJointExecutionPlan(
    variants: ReadonlyArray<{
      executionStrategy: TaskFingerprint["executionStrategy"];
      fingerprint: TaskFingerprint;
      features: Features;
      prerequisiteCostUsd?: number;
      prerequisiteLatencyMs?: number;
    }>,
    subtaskId: string,
    budgetUsd: number,
  ) {
    const evaluated = [] as Array<{
      executionStrategy: TaskFingerprint["executionStrategy"];
      plan: FrozenExecutionPlan;
    }>;
    for (const variant of variants) {
      const plan = await this.selectExecutionPlan(
        variant.fingerprint,
        variant.features,
        `${subtaskId}:${variant.executionStrategy}`,
        budgetUsd,
      );
      const prerequisiteCost = variant.prerequisiteCostUsd ?? 0;
      const prerequisiteLatency = variant.prerequisiteLatencyMs ?? 0;
      const conservativeQuality = Math.max(0.05, plan.conservativeQuality);
      const adjusted = prerequisiteCost || prerequisiteLatency
        ? Object.freeze({
            ...plan,
            expectedTotalCostUsd:
              (plan.expectedTotalCostUsd ?? 0) + prerequisiteCost,
            expectedCostPerVerifiedSolve:
              ((plan.expectedTotalCostUsd ?? 0) + prerequisiteCost) /
              conservativeQuality,
            expectedLatencyMs: plan.expectedLatencyMs + prerequisiteLatency,
            expectedLatencyP50Ms:
              (plan.expectedLatencyP50Ms ?? plan.expectedLatencyMs) +
              prerequisiteLatency,
            expectedLatencyP90Ms:
              (plan.expectedLatencyP90Ms ?? plan.expectedLatencyMs) +
              prerequisiteLatency,
            optimizerScore:
              (plan.optimizerScore ?? 0) +
              prerequisiteCost / conservativeQuality +
              (this.config.routing.latencyWeight * prerequisiteLatency /
                conservativeQuality / 1000) * 0.00005,
            whySelected:
              `${plan.whySelected}; includes executable planning prerequisite`,
          })
        : plan;
      evaluated.push({ executionStrategy: variant.executionStrategy, plan: adjusted });
    }
    const reference = Math.max(...evaluated.flatMap(({ plan }) =>
      (plan.evaluatedPlans ?? [])
        .filter((candidate) => !candidate.hardRejection)
        .map((candidate) => candidate.conservativeFinalSuccess)));
    const safe = evaluated.filter(({ plan }) =>
      reference - plan.conservativeQuality <= (plan.allowedQualityRegret ?? 0) + 1e-9);
    const selected = safe.sort((a, b) =>
      (a.plan.optimizerScore ?? Infinity) - (b.plan.optimizerScore ?? Infinity) ||
      (a.plan.expectedLatencyP90Ms ?? a.plan.expectedLatencyMs) -
        (b.plan.expectedLatencyP90Ms ?? b.plan.expectedLatencyMs) ||
      a.plan.initialModel.localeCompare(b.plan.initialModel))[0];
    if (!selected) throw Error("No quality-safe model + execution strategy plan");
    const selectedCandidate = selected.plan.evaluatedCandidates?.find((candidate) =>
      candidate.model.id === selected.plan.initialModel);
    const planRows = evaluated.flatMap(({ executionStrategy, plan }) =>
      (plan.evaluatedPlans ?? []).map((candidatePlan) => ({
        execution_engine: executionStrategy,
        model: candidatePlan.models[0] ?? null,
        models: candidatePlan.models,
        expected_quality: candidatePlan.expectedFinalSuccess,
        conservative_quality: candidatePlan.conservativeFinalSuccess,
        uncertainty: plan.evaluatedCandidates?.find((candidate) =>
          candidate.model.id === candidatePlan.models[0])?.uncertainty ?? null,
        quality_safe:
          candidatePlan.eligible &&
          reference - candidatePlan.conservativeFinalSuccess <=
            (plan.allowedQualityRegret ?? 0) + 1e-9,
        expected_total_cost_usd: candidatePlan.expectedCompletionCost,
        expected_latency_p50_ms: candidatePlan.completionLatencyP50Ms,
        expected_latency_p90_ms: candidatePlan.completionLatencyP90Ms,
        rejection_reason: candidatePlan.hardRejection ??
          (!candidatePlan.eligible ? candidatePlan.reason :
            reference - candidatePlan.conservativeFinalSuccess >
              (plan.allowedQualityRegret ?? 0) + 1e-9
              ? "QUALITY_REJECTED"
              : null),
      })),
    );
    const plannedModels = new Set(planRows.flatMap((row) => row.models));
    const rejectedRows = evaluated.flatMap(({ executionStrategy, plan }) =>
      (plan.evaluatedCandidates ?? [])
        .filter((candidate) => !plannedModels.has(candidate.model.id) || candidate.hardRejection)
        .map((candidate) => ({
          execution_engine: executionStrategy,
          model: candidate.model.id,
          models: [candidate.model.id],
          expected_quality: candidate.quality,
          conservative_quality: candidate.conservativeQuality,
          uncertainty: candidate.uncertainty,
          quality_safe: false,
          expected_total_cost_usd: candidate.expectedAttemptCost,
          expected_latency_p50_ms: candidate.latencyP50Ms,
          expected_latency_p90_ms: candidate.latencyP90Ms,
          rejection_reason: candidate.hardRejection ?? candidate.rejected ??
            "NO_EXECUTABLE_PLAN",
        })),
    );
    const diagnostics = [...planRows, ...rejectedRows];
    this.logger.log("joint_execution_route", {
      subtaskId,
      total_discovered_models: new Set(evaluated.flatMap(({ plan }) =>
        (plan.evaluatedCandidates ?? []).map((candidate) => candidate.model.id))).size,
      total_compatible_models: new Set(evaluated.flatMap(({ plan }) =>
        (plan.evaluatedCandidates ?? [])
          .filter((candidate) => !candidate.hardRejection)
          .map((candidate) => candidate.model.id))).size,
      total_generated_model_engine_plans: planRows.length,
      quality_safe_plan_count: diagnostics.filter((row) => row.quality_safe).length,
      selected_engine: selected.executionStrategy,
      selected_model: selected.plan.initialModel,
      selected_plan: {
        execution_engine: selected.executionStrategy,
        models: selected.plan.qualityCascadeModelIds,
        expected_quality: selectedCandidate?.quality ?? null,
        conservative_quality: selected.plan.conservativeQuality,
        uncertainty: selectedCandidate?.uncertainty ?? null,
        expected_total_cost_usd: selected.plan.expectedTotalCostUsd,
        expected_latency_p50_ms: selected.plan.expectedLatencyP50Ms,
        expected_latency_p90_ms: selected.plan.expectedLatencyP90Ms,
      },
      ordered_frozen_recovery_plans: safe
        .filter((entry) => entry !== selected)
        .map((entry) => ({
          execution_engine: entry.executionStrategy,
          models: entry.plan.qualityCascadeModelIds,
          expected_total_cost_usd: entry.plan.expectedTotalCostUsd,
          expected_latency_p50_ms: entry.plan.expectedLatencyP50Ms,
          expected_latency_p90_ms: entry.plan.expectedLatencyP90Ms,
          conservative_quality: entry.plan.conservativeQuality,
        })),
      plans: diagnostics,
    });
    return selected;
  }
  async selectExecutionPlan(
    fingerprint: TaskFingerprint,
    features: Features,
    subtaskId: string,
    budgetUsd: number,
    raceGroup?: string,
    lockHeld = false,
  ): Promise<FrozenExecutionPlan> {
    if (raceGroup && !lockHeld) {
      const prior = this.raceRoutingLocks.get(raceGroup) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      const queued = prior.then(() => current);
      this.raceRoutingLocks.set(raceGroup, queued);
      await prior;
      try {
        return await this.selectExecutionPlan(
          fingerprint,
          features,
          subtaskId,
          budgetUsd,
          raceGroup,
          true,
        );
      } finally {
        release();
        if (this.raceRoutingLocks.get(raceGroup) === queued)
          this.raceRoutingLocks.delete(raceGroup);
      }
    }
    // Selection normally uses the last-known-good local catalog. On a genuine
    // cold start there is no price with which to enforce the run budget, so do
    // one catalog acquisition and rebuild from that cached result. Subsequent
    // selections never wait for the provider refresh.
    let discovered = await this.capabilities.forTask(fingerprint);
    const hasPricedCandidate = discovered.some(({ metadata }) =>
      Number.isFinite(metadata.inputPrice) &&
      Number.isFinite(metadata.outputPrice));
    if (!hasPricedCandidate) {
      await this.catalog.get();
      discovered = await this.capabilities.reloadCachedForTask(fingerprint);
    } else {
      void this.catalog.get().catch(() => undefined);
    }
    const models = discovered.filter(
      (item) => !this.disabled.has(item.model.id),
    );
    const reserved = raceGroup
      ? (this.raceSelections.get(raceGroup) ?? new Set<string>())
      : new Set<string>();
    const result = optimizeSpecialists(
      models,
      fingerprint,
      features,
      this.history.read(),
      this.config,
      budgetUsd,
      this.history.readOperations(),
      reserved,
      this.history.readEfficiency(),
    );
    const cascade = result.cascade;
    if (!cascade.length || !result.reference) {
      const diagnostic = {
        reference: result.reference?.model.id ?? null,
        allowed_regret: result.allowedRegret,
        candidates: result.considered.map((candidate) => ({
          id: candidate.model.id,
          tier: candidate.model.tier,
          rejected: candidate.rejected ?? null,
          hard_rejection: candidate.hardRejection ?? null,
          conservative_quality: candidate.conservativeQuality,
          quality: candidate.quality,
          quality_floor_passed: candidate.qualityFloorPassed,
          expected_attempt_cost: candidate.expectedAttemptCost,
          reservation_cost: candidate.reservationCost,
          expected_latency_ms: candidate.latencyEvidenceKnown
            ? candidate.expectedAttemptLatencyMs : null,
          latency_p90_ms: candidate.latencyP90Ms,
          deadline_feasible: candidate.deadlineFeasible,
          evidence_level: candidate.evidenceLevel,
          local_quality_evidence: candidate.localQualityEvidence,
        })),
        plans: result.plans.map((plan) => ({
          models: plan.models,
          eligible: plan.eligible,
          reason: plan.reason,
          hard_rejection: plan.hardRejection ?? null,
          quality_gap: plan.qualityGap,
          expected_cost: plan.expectedCompletionCost,
          expected_latency_ms: plan.latencyEvidenceKnown
            ? plan.expectedCompletionLatencyMs : null,
          conservative_final_success: plan.conservativeFinalSuccess,
        })),
      };

      this.logger.log("execution_plan_rejected", {
        subtaskId,
        ...diagnostic,
      });

      throw Error(
        "No compatible priced model fits the frozen execution policy: " +
          JSON.stringify(diagnostic),
      );
    }
    if (raceGroup && cascade.length) {
      reserved.add(cascade[0]!.model.id);
      this.raceSelections.set(raceGroup, reserved);
    }
    const board = activeModelBoard(
      result.considered,
      this.config.routing.shortlistSize,
    );
    // The optimizer's coding cascade remains authoritative. Also freeze one
    // bounded, quality-safe alternative first leg for provider/protocol
    // failure. Its own optimizer-approved cascade preserves the same final
    // quality floor; it is never eligible for coding-quality de-escalation.
    const selectedOptimizerPlan = result.selectedPlan;
    const qualitySafePlans = result.plans
      .filter((candidate) => candidate.eligible && !candidate.hardRejection)
      .sort((a, b) => a.score - b.score ||
        (a.completionLatencyP90Ms ?? a.expectedCompletionLatencyMs) -
          (b.completionLatencyP90Ms ?? b.expectedCompletionLatencyMs) ||
        a.models.join("\0").localeCompare(b.models.join("\0")));
    const byModel = new Map(result.considered.map((candidate) =>
      [candidate.model.id, candidate] as const));
    const safeModelIds = new Set(qualitySafePlans.flatMap((candidate) =>
      candidate.models));
    const qualityCandidatePool = [...new Map([
      ...cascade.map((candidate) => [candidate.model.id, candidate] as const),
      ...result.considered
        .filter((candidate) => safeModelIds.has(candidate.model.id) &&
          !candidate.hardRejection && !candidate.rejected &&
          candidate.conservativeQuality + 1e-9 >= cascade[0]!.conservativeQuality)
        .sort((a, b) => a.conservativeQuality - b.conservativeQuality ||
          a.expectedAttemptCost - b.expectedAttemptCost)
        .map((candidate) => [candidate.model.id, candidate] as const),
    ]).values()];
    // Freeze a genuinely bounded worker shortlist. The optimizer owns the
    // initial worker and one quality rescue; a separate peer may be reserved
    // for provider/protocol failure. This prevents recovery from turning the
    // full catalog into a sequential model loop.
    const qualityCandidates = qualityCandidatePool.slice(0, 2);
    const orderedRecoveryModelIds = [...new Set(qualitySafePlans
      .filter((candidate) => candidate !== selectedOptimizerPlan)
      .map((candidate) => candidate.models[0])
      .filter((id): id is string => !!id && id !== cascade[0]!.model.id))];
    const operationalRecovery = orderedRecoveryModelIds
      .map((id) => byModel.get(id))
      .filter((candidate): candidate is SpecialistEstimate =>
        !!candidate && !candidate.hardRejection && !candidate.rejected &&
        candidate.deadlineFeasible)
      .slice(0, Math.max(0, Math.min(1, this.config.maxIterations - 1)));
    const approvedCandidateSet = [...new Map([
      ...qualityCandidates,
      ...operationalRecovery,
    ].map((candidate) => [candidate.model.id, candidate] as const)).values()];
    const planId = `route-${createHash("sha256")
      .update(
        JSON.stringify({
          subtaskId,
          engine: fingerprint.executionStrategy,
          initial: cascade[0]!.model.id,
          approved: approvedCandidateSet.map((candidate) => candidate.model.id),
          verification: fingerprint.verificationStrength,
        }),
      )
      .digest("hex")
      .slice(0, 12)}`;
    const qualityClass = requiredQualityClass(fingerprint);
    const requiredQuality = Math.max(
      0.05,
      result.reference.conservativeQuality - result.allowedRegret,
    );
    const planType: FrozenExecutionPlan["type"] =
      cascade.length > 1 ? "cascade" : "single";
    const plan = freezeExecutionPolicy({
      id: planId,
      type: planType,
      executionEngine: fingerprint.executionStrategy,
      taskFingerprint: fingerprint,
      qualityClass,
      requiredQuality: Number(requiredQuality.toFixed(3)),
      approvedCandidateSet,
      qualityCascadeModelIds: qualityCandidates.map(
        (candidate) => candidate.model.id,
      ),
      operationalRecoveryModelIds: operationalRecovery.map(
        (candidate) => candidate.model.id,
      ),
      orderedRecoveryModelIds: operationalRecovery.map(
        (candidate) => candidate.model.id,
      ),
      activeBoard: board.board,
      referenceModel: result.reference.model.id,
      initialModel: cascade[0]!.model.id,
      initialCandidate: cascade[0]!,
      evidenceClass: cascade[0]!.evidenceLevel,
      conservativeQuality: Number(
        (
          result.selectedPlan?.conservativeFinalSuccess ??
          cascade[0]!.conservativeQuality
        ).toFixed(3),
      ),
      expectedCostPerVerifiedSolve:
        result.selectedPlan?.costPerVerifiedCompletion ??
        cascade[0]!.expectedCompletionCost /
          Math.max(0.05, cascade[0]!.conservativeQuality),
      expectedLatencyMs:
        result.selectedPlan?.expectedCompletionLatencyMs ??
        cascade[0]!.expectedCompletionLatencyMs,
      expectedLatencyP50Ms:
        result.selectedPlan?.completionLatencyP50Ms ?? undefined,
      expectedLatencyP90Ms:
        result.selectedPlan?.completionLatencyP90Ms ?? undefined,
      expectedTotalCostUsd: result.selectedPlan?.expectedCompletionCost,
      optimizerScore: result.selectedPlan?.score,
      allowedQualityRegret: result.allowedRegret,
      discoveredModelCount: result.considered.length,
      evaluatedCandidates: result.considered,
      evaluatedPlans: result.plans,
      whySelected: result.selectedPlan?.reason ?? result.reason,
      totalBudgetUsd: budgetUsd,
      latencyBudgetMs: this.config.stageMaxMinutes * 60_000,
      maxCodingAttempts: Math.min(
        this.config.maxIterations,
        approvedCandidateSet.length,
      ),
      maxScoutCalls: fingerprint.localizationConfidence === "low" ? 1 : 0,
      providerConstraints: {
        requiredParameters:
          fingerprint.executionStrategy === "stable" ||
            usesDirectEditEngine(fingerprint)
            ? ["tools", "tool_choice"]
            : ["tools"],
        sessionSticky: true,
      },
      writeScopes: Object.freeze([...features.likelyWritePaths]),
      verificationContract: {
        strength: fingerprint.verificationStrength,
        targeted: fingerprint.targetedExecutableVerification === true,
        broaderProject: fingerprint.broaderProjectVerification === true,
      },
      verificationStrength: fingerprint.verificationStrength,
      stopConditions: Object.freeze([
        "verified",
        "budget exhausted",
        "plan exhausted",
      ]),
    });
    this.logger.log("specialist_route", {
      subtaskId,
      fingerprint,
      reason: result.reason,
      selected_plan_id: plan.id,
      selected_plan_type: plan.type,
      execution_engine: plan.executionEngine,
      verification_strength: fingerprint.verificationStrength,
      quality_class: qualityClass,
      required_quality: Number(requiredQuality.toFixed(3)),
      model_evidence_class: cascade[0]?.evidenceLevel ?? "UNKNOWN",
      approved_recovery_candidates: approvedCandidateSet
        .slice(1)
        .map((candidate) => candidate.model.id),
      ordered_frozen_recovery_plans: qualitySafePlans
        .filter((candidate) => candidate !== selectedOptimizerPlan)
        .slice(0, Math.max(0, plan.maxCodingAttempts - 1))
        .map((candidate) => ({
          models: candidate.models,
          expected_final_success: candidate.expectedFinalSuccess,
          conservative_final_success: candidate.conservativeFinalSuccess,
          expected_total_cost_usd: candidate.expectedCompletionCost,
          latency_p50_ms: candidate.completionLatencyP50Ms,
          latency_p90_ms: candidate.completionLatencyP90Ms,
        })),
      quality_recovery_candidates: qualityCandidates
        .slice(1)
        .map((candidate) => candidate.model.id),
      operational_recovery_candidates: operationalRecovery.map(
        (candidate) => candidate.model.id,
      ),
      active_model_board: board.board.map((entry) => ({
        model: entry.candidate.model.id,
        lifecycle: entry.lifecycle,
        reason: entry.reason,
      })),
      allowed_quality_regret: result.allowedRegret,
      first_attempt_quality_floor:
        result.considered[0]?.firstAttemptQualityFloor ??
        this.config.routing.minimumQuality,
      reference_model: result.reference?.model.id ?? null,
      reference_expected_success: result.reference
        ? Number(result.reference.quality.toFixed(3))
        : null,
      reference_conservative_success: result.reference
        ? Number(result.reference.conservativeQuality.toFixed(3))
        : null,
      reference_plan: result.referencePlan ?? null,
      reference_expected_cost_usd:
        result.referencePlan?.expectedCompletionCost ?? null,
      reference_expected_latency_ms:
        result.referencePlan?.latencyEvidenceKnown
          ? result.referencePlan.expectedCompletionLatencyMs : null,
      selected_model: cascade[0]?.model.id ?? null,
      selected_plan: result.selectedPlan ?? null,
      expected_standalone_success: result.selectedPlan
        ? Number(result.selectedPlan.expectedStandaloneSuccess.toFixed(3))
        : null,
      expected_final_success: result.selectedPlan
        ? Number(result.selectedPlan.expectedFinalSuccess.toFixed(3))
        : null,
      conservative_quality: result.selectedPlan
        ? Number(result.selectedPlan.conservativeFinalSuccess.toFixed(3))
        : null,
      estimated_cost_per_verified_solve:
        result.selectedPlan?.costPerVerifiedCompletion ?? null,
      why_selected: result.selectedPlan?.reason ?? result.reason,
      expected_completion_cost_usd:
        result.selectedPlan?.expectedCompletionCost ?? null,
      expected_completion_cost_p50_usd:
        result.selectedPlan?.completionCostP50Usd ?? null,
      expected_completion_cost_p90_usd:
        result.selectedPlan?.completionCostP90Usd ?? null,
      expected_completion_cost_p99_usd:
        result.selectedPlan?.completionCostP99Usd ?? null,
      risk_adjusted_cost_per_verified_solve:
        result.selectedPlan?.riskAdjustedCostPerVerifiedCompletion ?? null,
      expected_completion_latency_ms:
        result.selectedPlan?.latencyEvidenceKnown
          ? result.selectedPlan.expectedCompletionLatencyMs : null,
      expected_completion_latency_p50_ms:
        result.selectedPlan?.completionLatencyP50Ms ?? null,
      expected_completion_latency_p90_ms:
        result.selectedPlan?.completionLatencyP90Ms ?? null,
      expected_completion_latency_p99_ms:
        result.selectedPlan?.completionLatencyP99Ms ?? null,
      expected_completion_tokens:
        result.selectedPlan?.completionTokensExpected ?? null,
      expected_completion_tokens_p50:
        result.selectedPlan?.completionTokensP50 ?? null,
      expected_completion_tokens_p90:
        result.selectedPlan?.completionTokensP90 ?? null,
      expected_completion_tokens_p99:
        result.selectedPlan?.completionTokensP99 ?? null,
      deadline_miss_probability:
        result.selectedPlan?.deadlineMissProbability ?? null,
      candidate_funnel: {
        catalog_plans: result.considered.length,
        compatible: result.considered.filter((candidate) => !candidate.hardRejection).length,
        runtime_feasible: result.considered.filter((candidate) =>
          !candidate.hardRejection && candidate.deadlineFeasible).length,
        quality_scored: result.plans.length,
        quality_safe: result.plans.filter((candidate) => candidate.eligible).length,
        economics_eligible: result.plans.filter((candidate) => candidate.eligible).length,
        selected: result.selectedPlan ? 1 : 0,
      },
      quality_gap: result.selectedPlan?.qualityGap ?? null,
      plans: result.plans,
      candidates: result.considered.map((candidate) => ({
        id: candidate.model.id,
        selected: candidate.model.id === cascade[0]?.model.id,
        recovery_eligible: approvedCandidateSet.slice(1).some((entry) =>
          entry.model.id === candidate.model.id),
        rejection_stage: candidate.hardRejection
          ? "COMPATIBILITY_REJECTED"
          : candidate.rejected
            ? candidate.rejected === "outside bounded routing shortlist"
              ? "ECONOMICS_NOT_SELECTED"
              : candidate.localQualityEvidence > 0
                ? "QUALITY_NEGATIVE_EVIDENCE_REJECTED"
                : "QUALITY_UNCERTAINTY_REJECTED"
            : candidate.model.id === cascade[0]?.model.id
              ? "SELECTED"
              : "ECONOMICS_NOT_SELECTED",
        primary_rejection_reason: candidate.rejected ?? null,
        rejected: candidate.rejected,
        hard_rejection: candidate.hardRejection ?? null,
        soft_penalties: candidate.softPenalties ?? [],
        reservation_cost_usd: Number.isFinite(candidate.reservationCost)
          ? candidate.reservationCost
          : null,
        success: candidate.quality,
        expected_final_success: candidate.expectedFinalSuccess,
        conservative_success: candidate.conservativeQuality,
        quality_gap: candidate.qualityGap,
        uncertainty: candidate.uncertainty,
        quality_floor_passed: candidate.qualityFloorPassed,
        first_attempt_quality_floor: candidate.firstAttemptQualityFloor,
        local_quality_evidence: candidate.localQualityEvidence,
        confidence: candidate.confidence,
        call_cost_usd: Number.isFinite(candidate.cost) ? candidate.cost : null,
        expected_completion_cost_usd: Number.isFinite(
          candidate.expectedCompletionCost,
        )
          ? candidate.expectedCompletionCost
          : null,
        expected_completion_latency_ms: candidate.latencyEvidenceKnown &&
          Number.isFinite(candidate.expectedCompletionLatencyMs)
          ? candidate.expectedCompletionLatencyMs
          : null,
        expected_input_tokens: candidate.expectedInputTokens,
        expected_output_tokens: candidate.expectedOutputTokens,
        expected_total_tokens: candidate.expectedTotalTokens,
        token_efficiency: candidate.tokenEfficiency,
        conservative_attempt_cost_usd: Number.isFinite(
          candidate.conservativeAttemptCost,
        )
          ? candidate.conservativeAttemptCost
          : null,
        p99_attempt_cost_usd: Number.isFinite(candidate.p99AttemptCost)
          ? candidate.p99AttemptCost
          : null,
        knowledge_sources: candidate.knowledgeSources,
        evidence_level: candidate.evidenceLevel,
        observation_count: candidate.observationCount,
        evidence_freshness: candidate.evidenceFreshness,
        latency_ms: candidate.latencyEvidenceKnown ? candidate.latency : null,
        call_count: candidate.callCount,
        latency_ewma_ms: candidate.latencyEvidenceKnown
          ? candidate.latencyEwmaMs : null,
        latency_p99_ms: candidate.latencyP99Ms,
        latency_p50_ms: candidate.latencyP50Ms,
        latency_p90_ms: candidate.latencyP90Ms,
        latency_sla_passed: candidate.latencySlaPassed,
        operational_error_rate: candidate.operationalErrorRate,
        evidence: candidate.evidence,
        capability_evidence:
          models.find((item) => item.model.id === candidate.model.id)
            ?.capabilityEvidence ?? [],
      })),
    });
    return plan;
  }
  selectRecoveryCandidate(
    plan: FrozenExecutionPlan,
    observation: RecoveryObservation,
    attempted: ReadonlySet<string>,
  ) {
    const effectiveFailureMode = effectiveRecoveryFailureMode(observation);
    const effectiveObservation =
      effectiveFailureMode === observation.failureMode
        ? observation
        : { ...observation, failureMode: effectiveFailureMode };
    const selected = chooseAdaptiveRecovery(
      plan,
      effectiveObservation,
      attempted,
    );
    this.logger.log("adaptive_recovery_decision", {
      previous_model: observation.previousModel,
      reported_failure_mode: observation.failureMode,
      failure_mode: effectiveFailureMode,
      failure_phase: observation.failurePhase,
      trajectory_summary: effectiveObservation,
      recovery_model: selected?.model.id ?? null,
      why_recovery_selected: selected
        ? effectiveFailureMode === "operational"
          ? "cheapest reliable frozen-board candidate satisfying the task quality floor"
          : "best frozen-board candidate for observed coding evidence"
        : "frozen policy exhausted",
      approved_recovery_candidates: plan.approvedCandidateSet.map(
        (candidate) => candidate.model.id,
      ).filter((id) => !attempted.has(id)),
    });
    return selected;
  }
  async selectSpecialist(
    fingerprint: TaskFingerprint,
    features: Features,
    subtaskId: string,
    budgetUsd: number,
    raceGroup?: string,
  ) {
    const plan = await this.selectExecutionPlan(
      fingerprint,
      features,
      subtaskId,
      budgetUsd,
      raceGroup,
    );
    return [
      plan.initialCandidate,
      ...plan.approvedCandidateSet.filter((candidate) =>
        candidate.model.id !== plan.initialModel &&
        (plan.qualityCascadeModelIds ?? []).includes(candidate.model.id),
      ),
    ];
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
    if (
      verification !== "VERIFIED_SUCCESS" &&
      !(verification === "FAILED" && escalated)
    )
      return;
    const calls = this.logger.events
      .slice(since)
      .filter(
        (event) =>
          event.type === "model_call" &&
          event.subtaskId === subtaskId &&
          event.modelRequested === "openrouter/pareto-code" &&
          typeof event.modelReturned === "string" &&
          event.modelReturned !== "openrouter/pareto-code" &&
          event.costUsd !== null,
      );
    for (const call of calls) {
      this.history.record({
        timestamp: new Date().toISOString(),
        runId: this.logger.runId,
        subtaskId,
        modelRequested: call.modelReturned,
        modelServed: call.modelReturned,
        features,
        fingerprint,
        verification,
        wallClockMs: call.wallClockMs,
        inputTokens: call.promptTokens,
        outputTokens: call.completionTokens,
        costUsd: call.costUsd,
        escalated,
        reason,
        failureAttribution:
          verification === "FAILED" && reason === "focused_verification_failed"
            ? ("verified_patch_regression" as const)
            : undefined,
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
    routeLimits?: {
      budgetUsd?: number;
      inputTokens?: number;
      outputTokens?: number;
    },
  ) {
    const discovered = this.config.specialistRouting
      ? await this.capabilities.all()
      : undefined;
    const metadata = await this.catalog.get();
    let models =
      discovered?.map((item) => item.model) ?? this.config.modelPool!.models;
    if (
      features.taskKind === "planning" &&
      this.config.routing.plannerCandidates
    )
      models = models.filter((m) =>
        this.config.routing.plannerCandidates!.includes(m.id),
      );
    const force = this.config.forceModel;
    if (raceGroup)
      excluded = [...excluded, ...(this.raceSelections.get(raceGroup) ?? [])];
    const blocked = new Set([
      ...excluded.filter((id) => id !== force),
      ...this.disabled,
    ]);
    if (previous && !fallback && previous.id !== force)
      blocked.add(previous.id);
    const considered = rankCandidates(
      models,
      metadata,
      this.history.read(),
      features,
      this.config.routing,
      routeLimits?.inputTokens ?? features.contextBytes + 256,
      routeLimits?.outputTokens ?? this.config.maxOutputTokens,
      {
        budgetUsd: Math.min(
          this.remainingBudget(),
          routeLimits?.budgetUsd ?? Infinity,
        ),
        excluded: blocked,
      },
    );
    // Forced evaluations still respect execution constraints, including budget.
    const selected = considered.find(
      (candidate) =>
        !candidate.hardRejection && (!force || candidate.model.id === force),
    );
    this.logger.log("model_router", {
      subtaskId,
      selected_model: selected?.model.id ?? null,
      routing_reason: !selected
        ? "no eligible candidate"
        : force
          ? "forced evaluation"
          : !selected.qualityTargetMet
            ? "safe cold-start fallback: strongest technically compatible priced model"
            : `meets ${this.config.routing.minimumQuality} quality threshold; lowest weighted cost/latency`,
      estimated_quality: selected?.quality ?? null,
      task_bucket: taskBucket(features),
      features,
      candidates: considered.map((c) => ({
        id: c.model.id,
        quality: c.quality,
        hard_rejection: c.hardRejection ?? null,
        soft_penalties: c.softPenalties ?? [],
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
          : "No untried compatible priced model fits the remaining budget",
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
      { budgetUsd: this.remainingBudget(), excluded: this.disabled },
    );
    const available = considered.filter(
      (candidate) =>
        !this.disabled.has(candidate.model.id) && !candidate.hardRejection,
    );
    const selected = available[0];
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
    const prediction = [...this.logger.events]
      .reverse()
      .find(
        (event) =>
          event.type === "specialist_route" &&
          event.subtaskId === subtaskId &&
          event.selected_model === model.id,
      );
    const worker = [...this.logger.events]
      .reverse()
      .find(
        (event) =>
          event.type === "coding_worker_stop" &&
          event.subtaskId === subtaskId &&
          event.model === model.id,
      );
    const verificationVector = this.logger.events
      .slice(since)
      .filter(
        (event) =>
          event.subtaskId === subtaskId &&
          (event.type === "verification" ||
            event.type === "aider_attempt_verification" ||
            event.type === "mini_swe_attempt_verification"),
      )
      .map((event) =>
        String(event.outcome ?? event.verification ?? "unknown"),
      );
    const contradictoryPositive =
      verification === "VERIFIED_SUCCESS" &&
      verificationVector.some((outcome) =>
        [
          "CHECK_FAIL",
          "INFRA_FAILURE",
          "CHECK_UNAVAILABLE",
          "CANDIDATE_NEUTRAL",
          "CANDIDATE_IMPROVEMENT",
        ].includes(outcome),
      );
    const recordedVerification = contradictoryPositive
      ? "NOT_FULLY_VERIFIED"
      : verification;
    if (contradictoryPositive)
      this.logger.log("verification_invariant_violation", {
        subtaskId,
        model: model.id,
        claimed_verification: verification,
        recorded_verification: recordedVerification,
        verification_vector: verificationVector,
      });
    const record = {
      timestamp: new Date().toISOString(),
      runId: this.logger.runId,
      subtaskId,
      modelRequested: model.id,
      modelServed: calls.at(-1)?.modelReturned ?? null,
      features,
      fingerprint,
      verification: recordedVerification,
      wallClockMs: calls.reduce((n, c) => n + c.wallClockMs, 0),
      inputTokens: calls.reduce((n, c) => n + c.promptTokens, 0),
      outputTokens: calls.reduce((n, c) => n + c.completionTokens, 0),
      cachedTokens: calls.reduce((n, c) => n + (c.cachedTokens ?? 0), 0),
      cacheWriteTokens: calls.reduce(
        (n, c) => n + (c.cacheWriteTokens ?? 0),
        0,
      ),
      costUsd: calls.some((c) => c.costUsd === null)
        ? null
        : calls.reduce((n, c) => n + c.costUsd, 0),
      escalated,
      reason,
      failureAttribution:
        recordedVerification === "FAILED" &&
        reason === "focused_verification_failed"
          ? ("verified_patch_regression" as const)
          : undefined,
      modelKnowledgeVersion: 1,
      planId: prediction?.selected_plan_id,
      nodeId: subtaskId,
      verificationStrength: fingerprint?.verificationStrength,
      predictedQuality: prediction?.expected_final_success,
      predictedTokens: prediction?.candidates?.find(
        (candidate: any) => candidate.id === model.id,
      )?.expected_total_tokens,
      predictedCostUsd: prediction?.expected_completion_cost_usd,
      predictedLatencyP50Ms: prediction?.expected_completion_latency_p50_ms,
      predictedLatencyP90Ms: prediction?.expected_completion_latency_p90_ms,
      turns: worker?.turns ?? worker?.steps,
      changedPaths: worker?.actual_changed_paths,
      terminationReason: worker?.termination_reason,
      failurePhase: worker?.progress_phase,
      progressPhase: worker?.progress_phase,
      mutationObserved: (worker?.actual_changed_paths?.length ?? 0) > 0,
      focusedVerification: [...this.logger.events]
        .reverse()
        .find(
          (event) =>
            (event.type === "aider_attempt_verification" ||
              event.type === "mini_swe_attempt_verification") &&
            event.subtaskId === subtaskId &&
            event.model === model.id,
        )?.outcome,
      timeToFirstMutationMs: worker?.time_to_first_mutation_ms ?? undefined,
      toolFailures: this.logger.events
        .slice(since)
        .filter(
          (event) =>
            event.subtaskId === subtaskId &&
            event.type === "tool_result" &&
            (event.ok === false || Number(event.exitCode ?? 0) !== 0),
        ).length,
      executionEngine: worker?.worker_engine === "direct-edit"
        ? ("direct-edit" as const)
        : worker?.worker_engine === "aider"
          ? ("aider" as const)
        : worker?.worker_engine === "mini-swe-agent"
          ? ("mini-swe-agent" as const)
          : undefined,
      contextStrategy: worker?.worker_engine === "direct-edit"
        ? ("localized" as const)
        : ("agentic" as const),
      routePolicyVersion: "evidence-quality-safe-v3",
      // Production routing is deterministic today. Recording this now keeps
      // the log schema usable when controlled exploration is introduced.
      selectionPropensity: 1,
      verificationVector,
    };
    this.history.record(record);
    this.logger.log("model_attempt", record);
    if (prediction)
      this.logger.log("routing_prediction_error", {
        subtaskId,
        predicted_model: prediction.selected_model,
        predicted_cost_usd: prediction.expected_completion_cost_usd,
        predicted_tokens:
          prediction.candidates?.find(
            (candidate: any) => candidate.id === model.id,
          )?.expected_total_tokens ?? null,
        predicted_latency_ms: prediction.expected_completion_latency_ms,
        predicted_success: prediction.expected_final_success,
        actual_cost_usd: record.costUsd,
        actual_input_tokens: record.inputTokens,
        actual_output_tokens: record.outputTokens,
        actual_wall_clock_ms: record.wallClockMs,
        verification_result: recordedVerification,
        failure_attribution:
          record.failureAttribution ??
          (recordedVerification === "FAILED"
            ? "operational_or_unattributed"
            : null),
        cost_error_usd:
          record.costUsd === null ||
          prediction.expected_completion_cost_usd === null
            ? null
            : record.costUsd - prediction.expected_completion_cost_usd,
        token_error:
          prediction.candidates?.find(
            (candidate: any) => candidate.id === model.id,
          )?.expected_total_tokens == null
            ? null
            : record.inputTokens +
              record.outputTokens -
              prediction.candidates.find(
                (candidate: any) => candidate.id === model.id,
              ).expected_total_tokens,
        latency_error_ms:
          prediction.expected_completion_latency_ms == null
            ? null
            : record.wallClockMs - prediction.expected_completion_latency_ms,
      });
  }
}

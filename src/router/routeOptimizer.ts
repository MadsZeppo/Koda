import type { Config } from "../config.js";
import { supportsParameters } from "./pool.js";
import {
  attributableCodingFailure,
  type Attempt,
  type OperationalCall,
} from "./history.js";
import { taskBucket } from "./features.js";
import type { Features } from "./features.js";
import type {
  SpecialistModel,
  SpecialistEvidence,
} from "./capabilityRegistry.js";
import type { TaskFingerprint, TaskDifficulty } from "./taskFingerprint.js";
import type { Candidate } from "./modelRouter.js";
import { estimateQuality } from "./knowledge/estimator.js";
import { contextualPairwiseRegret } from "./knowledge/contextual.js";
import {
  estimateEfficiency,
  estimateLatency,
  observedExecutionEngine,
  type TokenEfficiencyProfile,
} from "./knowledge/efficiency.js";
import type { EvidenceStrength } from "./controlPolicy.js";
import { usesDirectEditEngine } from "../agent/attemptPolicy.js";

export interface SpecialistEstimate extends Candidate {
  confidence: "high" | "medium" | "low";
  evidence: SpecialistEvidence[];
  expectedCompletionCost: number;
  expectedCompletionLatencyMs: number;
  expectedAttemptCost: number;
  /** Conservative first-call reservation; forecasts never replace this bound. */
  reservationCost: number;
  expectedAttemptLatencyMs: number;
  expectedInputTokens: number;
  expectedOutputTokens: number;
  expectedTotalTokens: number;
  p50AttemptCost: number;
  conservativeAttemptCost: number;
  p99AttemptCost: number;
  knowledgeSources: string[];
  evidenceLevel: EvidenceStrength;
  /** Task-local verified evidence weight; external samples are priors only. */
  localQualityEvidence: number;
  observationCount: number;
  evidenceFreshness: number;
  tokenEfficiency: TokenEfficiencyProfile;
  expectedFinalSuccess: number;
  uncertainty: number;
  conservativeQuality: number;
  qualityGap: number;
  qualityFloorPassed: boolean;
  firstAttemptQualityFloor: number;
  callCount: number;
  latencyEwmaMs: number;
  latencyP50Ms: number | null;
  latencyP90Ms: number | null;
  latencyP99Ms: number | null;
  latencyEvidenceKnown: boolean;
  latencySlaPassed: boolean;
  deadlineFeasible: boolean;
  operationalErrorRate: number;
  rejection?: string;
}
export interface ExecutionPlanEstimate {
  executionEngine: TaskFingerprint["executionStrategy"];
  models: string[];
  expectedStandaloneSuccess: number;
  expectedFinalSuccess: number;
  conservativeFinalSuccess: number;
  expectedCompletionCost: number;
  expectedCompletionLatencyMs: number;
  completionLatencyP50Ms: number | null;
  completionLatencyP90Ms: number | null;
  completionLatencyP99Ms: number | null;
  latencyEvidenceKnown: boolean;
  completionCostP50Usd: number;
  completionCostP90Usd: number;
  completionCostP99Usd: number;
  completionTokensExpected: number;
  completionTokensP50: number;
  completionTokensP90: number;
  completionTokensP99: number;
  riskAdjustedCostPerVerifiedCompletion: number;
  deadlineMissProbability: number;
  costPerVerifiedCompletion: number;
  latencyPerVerifiedCompletionMs: number;
  qualityGap: number;
  escalationProbability: number;
  verificationRecoveryCoverage: "targeted" | "none";
  recoveryEvidence: {
    samples: number;
    successes: number;
    rate: number;
    source: "koda_history" | "paired_external";
  } | null;
  score: number;
  eligible: boolean;
  hardRejection?: string;
  softPenalties: string[];
  reason: string;
  qualityProof?: {
    kind: "paired_task_regret";
    effectiveSamples: number;
    meanRegret: number;
    upperRegret: number;
    uncertainty: number;
  };
}
export interface SpecialistRoute {
  cascade: SpecialistEstimate[];
  considered: SpecialistEstimate[];
  reference?: SpecialistEstimate;
  plans: ExecutionPlanEstimate[];
  selectedPlan?: ExecutionPlanEstimate;
  referencePlan?: ExecutionPlanEstimate;
  allowedRegret: number;
  reason: string;
}

export interface JointExecutionRoute {
  executionStrategy: TaskFingerprint["executionStrategy"];
  route: SpecialistRoute;
  plan: ExecutionPlanEstimate;
}

/** Compare complete model + engine trajectories under one attainable reference. */
export function chooseJointExecutionRoute(
  routes: ReadonlyArray<{
    executionStrategy: TaskFingerprint["executionStrategy"];
    route: SpecialistRoute;
  }>,
): JointExecutionRoute | undefined {
  const executable = routes.flatMap(({ executionStrategy, route }) =>
    route.plans
      .filter((plan) => !plan.hardRejection)
      .map((plan) => ({ executionStrategy, route, plan })),
  );
  if (!executable.length) return undefined;
  const referenceQuality = Math.max(
    ...executable.map((entry) => entry.plan.conservativeFinalSuccess),
  );
  const safe = executable.filter(
    (entry) =>
      entry.plan.eligible &&
      referenceQuality - entry.plan.conservativeFinalSuccess <=
        entry.route.allowedRegret + 1e-9,
  );
  return safe.sort(
    (a, b) =>
      a.plan.score - b.plan.score ||
      (a.plan.completionLatencyP90Ms ?? a.plan.expectedCompletionLatencyMs) -
        (b.plan.completionLatencyP90Ms ?? b.plan.expectedCompletionLatencyMs) ||
      a.plan.models.join("\0").localeCompare(b.plan.models.join("\0")) ||
      String(a.executionStrategy).localeCompare(String(b.executionStrategy)),
  )[0];
}

const POLICY = {
  externalPriorWeight: 4,
  strongVerificationRegret: 0.065,
  // Recoverable failure coverage, not confidence that a passing check proves
  // correctness. Sparse evidence must not imply independent rescue success.
  latencyUsdPerSecond: 0.001,
  interactiveP90Ms: 15000,
} as const;
const clamp = (n: number) => Math.max(0.05, Math.min(0.995, n));
const betaLowerBound = (
  successes: number,
  failures: number,
  prior: number,
  strength: number,
) => {
  const alpha = prior * strength + successes;
  const beta = (1 - prior) * strength + failures;
  const mean = alpha / (alpha + beta);
  const deviation = Math.sqrt(
    (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1)),
  );
  return clamp(mean - 1.64 * deviation);
};
const failure = attributableCodingFailure;
const value = (level: TaskDifficulty[keyof TaskDifficulty]) =>
  level === "high" ? 2 : level === "medium" ? 1 : 0;
const difficultyDistance = (a: TaskDifficulty, b: TaskDifficulty) =>
  (Object.keys(a) as (keyof TaskDifficulty)[]).reduce(
    (n, key) => n + Math.abs(value(a[key]) - value(b[key])),
    0,
  );
const expectedFiniteLatency = (...values: Array<number | null | undefined>) =>
  Math.max(
    ...values.filter(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value) && value >= 0,
    ),
  );

function conditionalRecovery(
  history: Attempt[],
  initial: string,
  rescue: string,
  fp: TaskFingerprint,
  features: Features,
) {
  const relevant = history.filter(
    (row) => historyWeight(row, fp, features) >= 0.25,
  );
  const groups = new Map<string, Attempt[]>();
  for (const row of relevant) {
    const key = `${row.runId}:${row.subtaskId}`;
    const rows = groups.get(key) ?? [];
    rows.push(row);
    groups.set(key, rows);
  }
  let samples = 0,
    successes = 0;
  for (const rows of groups.values()) {
    const failedAt = rows.findIndex(
      (row) =>
        (row.modelServed ?? row.modelRequested) === initial &&
        attributableCodingFailure(row),
    );
    if (failedAt < 0) continue;
    const recovery = rows
      .slice(failedAt + 1)
      .find(
        (row) =>
          (row.modelServed ?? row.modelRequested) === rescue &&
          (row.verification === "VERIFIED_SUCCESS" ||
            attributableCodingFailure(row)),
      );
    if (!recovery) continue;
    samples++;
    if (recovery.verification === "VERIFIED_SUCCESS") successes++;
  }
  return {
    samples,
    successes,
    rate: (successes + 1) / (samples + 2),
    source: "koda_history" as const,
  };
}

/**
 * Local verified history is strongest when it describes the same task shape
 * and the same concrete write target. Cross-file history remains a weak prior
 * only; public routing evidence is responsible for broad cross-repository
 * transfer. This prevents one bad patch in one file from poisoning another
 * localized task while still allowing repeated matching outcomes to calibrate
 * a route quickly.
 */
function historyWeight(
  row: Attempt,
  current: TaskFingerprint,
  features: Features,
): number {
  const expectedEngine = usesDirectEditEngine(current)
    ? "direct-edit" : "mini-swe-agent";
  // Legacy rows remain useful as weak priors. Outcomes from another scaffold
  // never count as equivalent evidence for the current model × engine plan.
  // Preserve enough weight for pre-schema Koda outcomes to cross the existing
  // local-evidence gate, while still treating them as weaker than an exact
  // engine match. Newly recorded rows always carry the concrete engine.
  const engineTransfer = row.executionEngine === undefined ? 0.8
    : row.executionEngine === expectedEngine ? 1 : 0.25;
  if (taskBucket(row.features) !== taskBucket(features)) return 0.005 * engineTransfer;
  const prior = row.fingerprint;
  if (!prior) return row.features.taskKind === "planning" ? 0 : 0.05 * engineTransfer;
  if (
    prior.primary !== current.primary &&
    prior.taskFamily !== current.taskFamily
  )
    return 0.005 * engineTransfer;

  const priorPaths = new Set(row.features.likelyWritePaths);
  const currentPaths = features.likelyWritePaths;
  const hasComparablePaths = priorPaths.size > 0 && currentPaths.length > 0;
  const pathOverlap =
    hasComparablePaths && currentPaths.some((path) => priorPaths.has(path));
  const distance = difficultyDistance(prior.difficulty, current.difficulty);

  // Different concrete targets are deliberately weak local evidence. Public
  // benchmark knowledge handles generalization across repositories and files.
  if (hasComparablePaths && !pathOverlap) {
    // Exact-target production outcomes are deliberately task local. A failure
    // in another file is not evidence that this model will fail here; broad
    // transfer belongs to the versioned public/task-neighborhood evidence.
    return 0;
  }

  let weight = 0.45;
  if (prior.taskFamily && prior.taskFamily === current.taskFamily)
    weight += 0.2;
  if (prior.executionStrategy === current.executionStrategy) weight += 0.1;
  if (prior.scope === current.scope) weight += 0.08;
  if (prior.languages.some((language) => current.languages.includes(language)))
    weight += 0.07;
  if (distance === 0) weight += 0.1;
  else if (distance === 1) weight += 0.04;
  else if (distance > 2) weight *= 0.5;
  return Math.max(0.005, Math.min(1, weight * engineTransfer));
}

const affinity = (item: SpecialistModel, fp: TaskFingerprint) =>
  Number(item.model.strengths.includes(fp.primary)) +
  Number(
    fp.visualRelevant &&
      item.evidence.some((e) => e.source === "design_benchmark"),
  ) +
  Number(
    item.evidence.some(
      (e) =>
        e.source === "coding_benchmark" || e.source === "agentic_benchmark",
    ),
  );

/** Order every discovered candidate; capability and quality gates decide eligibility. */
export function curateSpecialists(
  models: SpecialistModel[],
  fp: TaskFingerprint,
  _tokens: { input: number; output: number },
  _budgetUsd: number,
): SpecialistModel[] {
  return [...models].sort(
    (a, b) =>
      affinity(b, fp) - affinity(a, fp) || a.model.id.localeCompare(b.model.id),
  );
}

export function optimizeSpecialists(
  models: SpecialistModel[],
  fp: TaskFingerprint,
  features: Features,
  history: Attempt[],
  config: Config,
  budgetUsd: number,
  operations: OperationalCall[] = [],
  excludedInitial: ReadonlySet<string> = new Set(),
  efficiencyHistory: Attempt[] = history,
): SpecialistRoute {
  const input = Math.ceil(features.contextBytes / 4) + 256;
  // Gateway reserves one token per input byte plus framing. Use the same
  // conservative bound for feasibility, and estimated tokens for economics.
  const reservationInput = features.contextBytes + 256;
  const expectedDefaultOutput = Math.min(
    config.maxOutputTokens,
    fp.effort === "complex" ? 2400 : fp.scope === "single" ? 800 : 1400,
  );
  const output = config.maxOutputTokens;
  // Executable, focused verification can reject a failed bounded attempt.
  // This changes the trial gate only; accepted work still needs every check.
  const focusedDetection = fp.verificationStrength === "strong" &&
    fp.targetedExecutableVerification !== false;
  const lowFalseAccept = fp.verifierFalseAcceptRisk === "low" || focusedDetection;
  const detectableRecovery = fp.recoveryDetectability === "high" || focusedDetection;
  const boundedBlastRadius = (fp.blastRadius ??
    (fp.scope === "cross-component" ? "cross-component" :
      fp.scope === "single" ? "single-file" : "package")) !== "cross-component";
  const economicalTrial =
    fp.verificationStrength === "strong" &&
    lowFalseAccept && detectableRecovery && boundedBlastRadius &&
    fp.localizationConfidence !== "low" &&
    !fp.architectureHeavy && !fp.publicApiRisk && !fp.schemaRisk &&
    !fp.configRisk;
  const firstAttemptQualityFloor = economicalTrial
    ? Math.max(
        0.05,
        config.routing.minimumQuality - POLICY.strongVerificationRegret,
      )
    : config.routing.minimumQuality;
  const considered: SpecialistEstimate[] = curateSpecialists(
    models,
    fp,
    { input, output },
    budgetUsd,
  ).map((item) => {
    const { model, metadata: md } = item;
    const protocolObservation = operations
      .filter((row) =>
        row.stage === "implement" &&
        row.modelRequested === model.id &&
        Date.now() - new Date(row.timestamp).getTime() <= config.routing.cacheTtlMs &&
        (row.outcome === "response" || row.failureKind === "tool_protocol_incompatible"))
      .at(-1);
    const observedProtocolIncompatible =
      protocolObservation?.failureKind === "tool_protocol_incompatible";
    const protocolKnown =
      md.routableParameterSets !== undefined ||
      md.supportedParameters !== undefined;
    const forecastCost =
      md.inputPrice === undefined || md.outputPrice === undefined
        ? Infinity
        : (input * md.inputPrice + expectedDefaultOutput * md.outputPrice) /
          1e6;
    const reservationCost =
      md.inputPrice === undefined || md.outputPrice === undefined
        ? Infinity
        : (reservationInput * md.inputPrice + output * md.outputPrice) / 1e6;
    const rejected = !model.enabled
      ? "disabled"
      : md.available === false
        ? "unavailable"
        : !Number.isFinite(forecastCost)
          ? "unknown pricing"
          : md.contextLength !== undefined &&
              reservationInput + output > md.contextLength
            ? "context limit"
            : (fp.toolsRequired || fp.executionStrategy === "stable") &&
                protocolKnown && !supportsParameters(md, ["tools"])
              ? "tools unsupported"
            : (fp.executionStrategy === "stable" || usesDirectEditEngine(fp)) &&
                  protocolKnown &&
                  !supportsParameters(md, ["tools", "tool_choice"])
                ? "tool_choice unsupported"
                : (fp.executionStrategy === "stable" || usesDirectEditEngine(fp)) &&
                    observedProtocolIncompatible
                  ? "observed tool protocol incompatibility"
                : fp.visionRequired && !item.vision
                  ? "vision unsupported"
                  : reservationCost > budgetUsd
                    ? "completion budget"
                    : undefined;
    const rows = history.filter(
      (row) =>
        (row.modelServed ?? row.modelRequested) === model.id &&
        (row.verification === "VERIFIED_SUCCESS" || failure(row)),
    );
    const weighted = rows.map((row) => ({
      row,
      weight: historyWeight(row, fp, features) * (failure(row) ? 0.5 : 1),
    }));
    const successes = weighted
      .filter(({ row }) => row.verification === "VERIFIED_SUCCESS")
      .reduce(
        (n, { row, weight }) =>
          n + weight * (row.features.acceptanceCheckCount > 0 ? 1 : 0.3),
        0,
      );
    const failures = weighted
      .filter(({ row }) => failure(row))
      .reduce((n, { weight }) => n + weight, 0);
    const evidenceCount = successes + failures;
    // A verified outcome is still a complete local observation even though
    // failures receive a smaller Bayesian quality weight above. Do not reuse
    // that quality discount as a sample-count discount: doing so allowed four
    // repeated, exact-target regressions to look like fewer than the three
    // samples required to enforce the first-attempt quality floor.
    const localQualityEvidence = rows.reduce(
      (count, row) => count + historyWeight(row, fp, features),
      0,
    );
    const external = estimateQuality(
      model.qualityPrior,
      fp,
      item.knowledge,
      item.evidence,
      model.id,
    );
    // Consequence changes the non-inferiority/recovery policy. It does not make
    // the code semantically harder for a model to produce. Keeping these axes
    // separate prevents scary nouns and file count from depressing quality.
    const demand =
      value(fp.semanticComplexity ?? fp.difficulty.technicalComplexity) +
      value(fp.architecturalCoupling ?? fp.difficulty.architecturalComplexity) +
      value(fp.localizationUncertainty ?? fp.difficulty.repoReasoningComplexity);
    const taskAdjustedPrior = clamp(
      external.estimatedSuccess +
        (model.strengths.includes(fp.primary) ? 0.015 : 0) -
        demand * Math.max(0, 0.995 - model.qualityPrior) * 0.2,
    );
    const externalWeight =
      external.confidence === "high"
        ? 10
        : external.confidence === "medium"
          ? 6
          : 4;
    const quality = clamp(
      (taskAdjustedPrior * externalWeight + successes) /
        (externalWeight + evidenceCount),
    );
    const domainEvidence = [fp.primary, ...fp.secondary].some(
      (kind) =>
        item.capabilityEvidence?.some(
          (e) => e.capability === kind && e.quality > 0,
        ) ?? model.strengths.includes(kind),
    );
    const transferableEvidence = item.evidence.some(
      (e) =>
        e.source === "coding_benchmark" ||
        e.source === "agentic_benchmark" ||
        e.source === "reasoning_benchmark" ||
        e.source === "terminal_benchmark" ||
        (fp.visualRelevant && e.source === "design_benchmark"),
    );
    const uncertainty = Math.max(
      0.015,
      external.uncertainty / Math.sqrt(1 + evidenceCount / 2) +
        value(fp.difficulty.contextUncertainty) * 0.008 +
        (!item.configured ? 0.02 : 0) +
        (!domainEvidence && !transferableEvidence ? 0.02 : 0),
    );
    const modelCalls = operations.filter(
      (row) =>
        row.stage === "implement" &&
        (row.modelServed ?? row.modelRequested) === model.id,
    );
    const bucketCalls = modelCalls.filter(
      (row) => row.taskBucket === taskBucket(features),
    );
    const recent = (bucketCalls.length >= 3 ? bucketCalls : modelCalls).slice(
      -24,
    );
    let ewma = model.latencyPriorMs;
    for (const call of recent) ewma = 0.25 * call.wallClockMs + 0.75 * ewma;
    const expectedEngine = usesDirectEditEngine(fp)
      ? "direct-edit" as const : "mini-swe-agent" as const;
    const attemptLatencyRows = efficiencyHistory.filter((row) =>
      (row.modelServed ?? row.modelRequested) === model.id &&
      observedExecutionEngine(row) === expectedEngine &&
      (taskBucket(row.features) === taskBucket(features) ||
        row.fingerprint?.taskFamily === fp.taskFamily));
    const latencyProfile = estimateLatency(
      model.latencyPriorMs,
      item.knowledge,
      fp,
      recent,
      attemptLatencyRows,
    );
    const latencyEvidenceKnown = item.latencyKnown !== false ||
      latencyProfile.evidenceKnown;
    const p50 = latencyEvidenceKnown ? latencyProfile.p50 : null;
    const p90 = latencyEvidenceKnown ? latencyProfile.p90 : null;
    const p99 = latencyEvidenceKnown ? latencyProfile.p99 : null;
    const operationalErrorRate = recent.length
      ? recent.filter((call) => call.outcome === "error").length /
        (recent.length + 4)
      : 0;
    const latencySlaPassed = p90 === null || p90 <= POLICY.interactiveP90Ms;
    const latency = ewma * (1 + operationalErrorRate);
    // A DIRECT model call cannot be a viable initial plan when Koda already
    // predicts that the request itself will outlive its hard implementation
    // deadline. Keep this separate from the softer interactive-SLA preference.
    const implementationTimeout = Number.isFinite(
      config.modelTimeoutMs?.implementation,
    )
      ? config.modelTimeoutMs.implementation
      : Infinity;
    const attemptTimeout = Number.isFinite(config.codingAttemptTimeoutMs)
      ? config.codingAttemptTimeoutMs
      : Infinity;
    const requestDeadlineMs = Math.min(implementationTimeout, attemptTimeout);
    const deadlineFeasible = !latencyEvidenceKnown ||
      expectedFiniteLatency(latency, p50, p90) <= requestDeadlineMs;
    // Attempts may contain multiple model calls. Learn their token/time totals
    // at current prices; provider errors never enter the quality posterior.
    const engine = usesDirectEditEngine(fp) ? "direct-edit" : "mini-swe-agent";
    const engineRows = efficiencyHistory.filter((row) => {
      if ((row.modelServed ?? row.modelRequested) !== model.id) return false;
      const observedEngine = observedExecutionEngine(row);
      return observedEngine === engine || observedEngine === undefined;
    });
    // Efficiency transfers by execution scaffold and task region. Exact source
    // paths are intentionally irrelevant here: a prior agent-loop overrun in
    // another repository is useful economic evidence, but not quality proof.
    const sameBucket = engineRows.filter((row) =>
      taskBucket(row.features) === taskBucket(features));
    const sameFamily = engineRows.filter((row) =>
      row.fingerprint?.taskFamily === fp.taskFamily);
    const comparableEfficiency = sameBucket.length ? sameBucket
      : sameFamily.length ? sameFamily : engineRows;
    const efficiencyWeighted = comparableEfficiency.map((row) => ({
      row,
      weight: taskBucket(row.features) === taskBucket(features) ? 1
        : row.fingerprint?.taskFamily === fp.taskFamily ? 0.6 : 0.2,
    }));
    const measured = efficiencyWeighted.filter(
      ({ row }) => row.inputTokens >= 0 && row.outputTokens >= 0,
    );
    const measuredWeight = measured.reduce(
      (sum, { weight }) => sum + weight,
      0,
    );
    const efficiency = estimateEfficiency(
      fp,
      input,
      config.maxOutputTokens,
      item.knowledge,
      measured.map(({ row }) => row),
    );
    const profileCost =
      md.inputPrice === undefined || md.outputPrice === undefined
        ? Infinity
        : (efficiency.expectedInputTokens * md.inputPrice +
            efficiency.expectedOutputTokens * md.outputPrice) /
          1e6;
    const expectedAttemptCost = Number.isFinite(profileCost)
      ? (profileCost * POLICY.externalPriorWeight +
          measured.reduce(
            (sum, { row, weight }) =>
              sum +
              (weight *
                (row.inputTokens * md.inputPrice! +
                  row.outputTokens * md.outputPrice!)) /
                1e6,
            0,
          )) /
        (POLICY.externalPriorWeight + measuredWeight)
      : Infinity;
    const conservativeAttemptCost =
      md.inputPrice === undefined || md.outputPrice === undefined
        ? Infinity
        : Math.max(
            expectedAttemptCost,
            (efficiency.p90TotalTokens *
              Math.max(md.inputPrice, md.outputPrice)) /
              1e6,
          );
    const p99AttemptCost =
      md.inputPrice === undefined || md.outputPrice === undefined
        ? Infinity
        : Math.max(
            conservativeAttemptCost,
            (efficiency.p99TotalTokens *
              Math.max(md.inputPrice, md.outputPrice)) /
              1e6,
          );
    const expectedAttemptLatencyMs = Math.max(
      latency,
      (model.latencyPriorMs * POLICY.externalPriorWeight +
        measured.reduce(
          (sum, { row, weight }) => sum + weight * row.wallClockMs,
          0,
        )) /
        (POLICY.externalPriorWeight + measuredWeight),
    );
    const evidenceLevel: EvidenceStrength =
      localQualityEvidence >= 8
        ? "PROVEN"
        : localQualityEvidence >= 3
          ? "SUPPORTED"
          : localQualityEvidence >= 1
            ? "PROMISING"
            : external.evidenceLevel;
    const conservativeQuality =
      evidenceCount > 0
        ? betaLowerBound(successes, failures, taskAdjustedPrior, externalWeight)
        : external.conservativeSuccess;
    return {
      model,
      metadata: md,
      quality,
      conservativeQuality,
      uncertainty,
      cost: expectedAttemptCost,
      latency,
      score: Infinity,
      // Sparse or conservative quality evidence is not technical
      // incompatibility. Keep every executable candidate for reference-relative
      // plan evaluation; uncertainty decides cheap-first versus safe-first.
      rejected,
      hardRejection: rejected,
      softPenalties: !latencyEvidenceKnown ? ["latency unknown"]
        : latencySlaPassed ? [] : ["preferred latency exceeded"],
      rejection: rejected,
      confidence:
        localQualityEvidence >= 5
          ? ("high" as const)
          : localQualityEvidence >= 1
            ? ("medium" as const)
            : external.confidence,
      evidence: [
        ...item.evidence,
        ...rows.map((row) => ({
          source: "verified_history" as const,
          value: row.verification === "VERIFIED_SUCCESS" ? 1 : 0,
          detail: row.verification,
        })),
      ],
      expectedCompletionCost: Infinity,
      expectedCompletionLatencyMs: Infinity,
      expectedAttemptCost,
      reservationCost,
      expectedAttemptLatencyMs,
      expectedFinalSuccess: quality,
      expectedInputTokens: efficiency.expectedInputTokens,
      expectedOutputTokens: efficiency.expectedOutputTokens,
      expectedTotalTokens: efficiency.expectedTotalTokens,
      p50AttemptCost: expectedAttemptCost,
      conservativeAttemptCost,
      p99AttemptCost,
      knowledgeSources: [...external.evidenceUsed, ...efficiency.evidenceUsed],
      evidenceLevel,
      localQualityEvidence,
      observationCount: Math.round(
        localQualityEvidence + external.observationCount,
      ),
      evidenceFreshness: external.evidenceFreshness,
      tokenEfficiency: efficiency,
      qualityGap: Infinity,
      qualityFloorPassed: false as boolean,
      firstAttemptQualityFloor,
      callCount: recent.length,
      latencyEwmaMs: ewma,
      latencyP50Ms: p50,
      latencyP90Ms: p90,
      latencyP99Ms: p99,
      latencyEvidenceKnown,
      latencySlaPassed,
      deadlineFeasible,
      operationalErrorRate,
    } satisfies SpecialistEstimate;
  });
  const technicallyEligible = considered.filter(
    (candidate) => !candidate.rejected,
  );

  const highRisk =
    fp.architectureHeavy || fp.crossComponent || fp.publicApiRisk ||
    fp.schemaRisk || fp.configRisk ||
    fp.difficulty.architecturalComplexity === "high" ||
    fp.verifierFalseAcceptRisk === "high" ||
    ((fp.consequenceRisk ?? fp.difficulty.changeRisk) === "high" &&
      !detectableRecovery);
  const allowedRegret =
    Math.min(
      config.routing.maxQualityRegret,
      fp.verificationStrength === "weak" ? 0.012 : 0.025,
    ) * (highRisk ? 0.5 : 1);

  // Hard execution constraints must be applied before choosing the quality
  // reference. A model that cannot execute inside the configured DIRECT
  // request deadline cannot define the quality target for runnable models.
  //
  // This is model/provider agnostic: executability, not tier or vendor,
  // determines whether a candidate may define the reference.
  const directDeadlineGuard =
    fp.executionStrategy === "direct" &&
    technicallyEligible.some(
      (candidate) =>
        !excludedInitial.has(candidate.model.id) && candidate.deadlineFeasible,
    );

  if (directDeadlineGuard) {
    for (const candidate of technicallyEligible) {
      if (candidate.deadlineFeasible) continue;
      candidate.rejected = candidate.rejection =
        "predicted model latency exceeds implementation request deadline";
      candidate.hardRejection = candidate.rejected;
      candidate.softPenalties = [
        ...(candidate.softPenalties ?? []),
        "request deadline infeasible",
      ];
    }
  }

  const eligible = considered.filter((candidate) => !candidate.rejected);

  // Quality parity is relative to the strongest candidate that can actually
  // execute under the same hard constraints as the selected plan.
  const reference = eligible
    .filter(
      (candidate) =>
        !excludedInitial.has(candidate.model.id) &&
        (fp.frontierJustified !== false ||
          candidate.model.tier !== "frontier"),
    )
    .sort(
      (a, b) =>
        b.conservativeQuality - a.conservativeQuality ||
        b.quality - a.quality ||
        a.cost - b.cost ||
        a.model.id.localeCompare(b.model.id),
    )[0];
  // This is a policy gate, not a fabricated probability. Only a targeted
  // executable oracle permits a cheap-first quality cascade. Every accepted
  // candidate still runs the complete final verification contract.
  const recoveryCoverage =
    fp.verificationStrength === "strong" &&
    fp.targetedExecutableVerification !== false
      ? ("targeted" as const)
      : ("none" as const);
  const shortlistLimit = config.routing.shortlistSize;
  const shortlistIds = new Set<string>();
  if (reference) shortlistIds.add(reference.model.id);
  const add = (candidate?: SpecialistEstimate) => {
    if (candidate && shortlistIds.size < shortlistLimit)
      shortlistIds.add(candidate.model.id);
  };
  // Reserve one bounded challenger slot for a technically executable,
  // economically promising model with sparse evidence. It is evaluated, not
  // declared safe: only strong deterministic verification plus a frozen
  // quality-safe recovery can make its plan eligible.
  if (economicalTrial && !highRisk)
    add([...eligible]
      .filter((candidate) => candidate.evidenceLevel === "UNKNOWN")
      .sort((a, b) => a.conservativeAttemptCost - b.conservativeAttemptCost ||
        a.expectedAttemptLatencyMs - b.expectedAttemptLatencyMs ||
        a.model.id.localeCompare(b.model.id))[0]);
  add(
    [...eligible].sort(
      (a, b) =>
        a.expectedAttemptCost - b.expectedAttemptCost ||
        b.conservativeQuality - a.conservativeQuality,
    )[0],
  );
  add(
    [...eligible].sort(
      (a, b) =>
        a.expectedAttemptCost / Math.max(a.quality, 0.05) -
          b.expectedAttemptCost / Math.max(b.quality, 0.05) ||
        a.expectedAttemptLatencyMs - b.expectedAttemptLatencyMs,
    )[0],
  );
  add(
    [...eligible].sort(
      (a, b) =>
        a.expectedAttemptCost / Math.max(a.conservativeQuality, 0.05) -
          b.expectedAttemptCost / Math.max(b.conservativeQuality, 0.05) ||
        a.expectedAttemptLatencyMs - b.expectedAttemptLatencyMs,
    )[0],
  );
  add(
    [...eligible].sort(
      (a, b) =>
        a.expectedAttemptLatencyMs - b.expectedAttemptLatencyMs ||
        b.conservativeQuality - a.conservativeQuality,
    )[0],
  );
  for (const tier of ["cheap", "fast", "strong", "frontier"] as const)
    add(
      [...eligible]
        .filter((candidate) => candidate.model.tier === tier)
        .sort(
          (a, b) =>
            b.conservativeQuality - a.conservativeQuality ||
            a.expectedAttemptCost - b.expectedAttemptCost,
        )[0],
    );
  for (const candidate of [...eligible].sort(
    (a, b) =>
      b.conservativeQuality - a.conservativeQuality ||
      a.uncertainty - b.uncertainty ||
      a.expectedAttemptCost - b.expectedAttemptCost,
  ))
    add(candidate);
  const shortlisted = eligible.filter((candidate) =>
    shortlistIds.has(candidate.model.id),
  );
  const plans: ExecutionPlanEstimate[] = [];
  const plansByInitial = new Map<string, ExecutionPlanEstimate[]>();
  const estimate = (
    initial: SpecialistEstimate,
    rescue?: SpecialistEstimate,
  ): ExecutionPlanEstimate => {
    const pairedProof = reference && reference.model.id !== initial.model.id
      ? contextualPairwiseRegret(initial.model.id, reference.model.id, fp,
          models.find((model) => model.model.id === initial.model.id)?.knowledge?.contextualValidated
            ? models.find((model) => model.model.id === initial.model.id)?.knowledge
            : undefined)
      : undefined;
    const usablePairedProof = pairedProof && pairedProof.effectiveSamples >= 20
      ? pairedProof : undefined;
    const kodaRecovery = rescue
      ? conditionalRecovery(
          history,
          initial.model.id,
          rescue.model.id,
          fp,
          features,
        )
      : undefined;
    const externalPair = rescue
      ? models
          .flatMap((model) => model.knowledge?.pairwiseEvidence ?? [])
          .find(
            (pair) =>
              pair.sampleSize >= config.routing.conditionalRecoveryMinSamples &&
              (!pair.taskFamily ||
                pair.taskFamily === (fp.taskFamily ?? fp.primary)) &&
              ((pair.candidateModelId === initial.model.id &&
                pair.referenceModelId === rescue.model.id) ||
                (pair.referenceModelId === initial.model.id &&
                  pair.candidateModelId === rescue.model.id)),
          )
      : undefined;
    const externalRecovery = externalPair
      ? (() => {
          const successes =
            externalPair.candidateModelId === initial.model.id
              ? externalPair.referenceOnly
              : externalPair.candidateOnly;
          const samples = successes + externalPair.bothFail;
          return {
            samples,
            successes,
            rate: (successes + 1) / (samples + 2),
            source: "paired_external" as const,
          };
        })()
      : undefined;
    const recorded =
      kodaRecovery &&
      kodaRecovery.samples >= config.routing.conditionalRecoveryMinSamples
        ? kodaRecovery
        : externalRecovery;
    const useRecorded =
      !!recorded &&
      recorded.samples >= config.routing.conditionalRecoveryMinSamples;
    // Sparse data receives only the rescue's measured quality advantage. Once
    // enough paired outcomes exist, use smoothed conditional recovery instead
    // of assuming model outcomes are independent.
    const sparseGain =
      rescue && recoveryCoverage === "targeted"
        ? Math.max(0, rescue.quality - initial.quality)
        : 0;
    const sparseConservativeGain =
      rescue && recoveryCoverage === "targeted"
        ? Math.max(0, rescue.conservativeQuality - initial.conservativeQuality)
        : 0;
    const recoveryRate = useRecorded ? recorded!.rate : null;
    const expectedFinalSuccess =
      initial.quality +
      (rescue
        ? useRecorded
          ? (1 - initial.quality) * recoveryRate!
          : sparseGain
        : 0);
    const conservativeFinalSuccess =
      initial.conservativeQuality +
      (rescue
        ? useRecorded
          ? (1 - initial.conservativeQuality) *
            Math.max(0, recoveryRate! - 1 / Math.sqrt(recorded!.samples))
          : sparseConservativeGain
        : 0);
    const escalationProbability =
      rescue && recoveryCoverage === "targeted" ? 1 - initial.quality : 0;
    const expectedCompletionCost =
      initial.expectedAttemptCost +
      escalationProbability * (rescue?.expectedAttemptCost ?? 0);
    const expectedCompletionLatencyMs =
      initial.expectedAttemptLatencyMs +
      escalationProbability * (rescue?.expectedAttemptLatencyMs ?? 0);
    const completionTokensExpected = initial.expectedTotalTokens +
      escalationProbability * (rescue?.expectedTotalTokens ?? 0);
    const latencyEvidenceKnown = initial.latencyEvidenceKnown &&
      (!rescue || rescue.latencyEvidenceKnown);
    const scoredLatencyP50Ms =
      (initial.latencyP50Ms ?? initial.expectedAttemptLatencyMs) +
      escalationProbability *
        (rescue?.latencyP50Ms ?? rescue?.expectedAttemptLatencyMs ?? 0);
    const scoredLatencyP90Ms =
      (initial.latencyP90Ms ?? initial.expectedAttemptLatencyMs) +
      escalationProbability *
        (rescue?.latencyP90Ms ?? rescue?.expectedAttemptLatencyMs ?? 0);
    const completionLatencyP50Ms = latencyEvidenceKnown
      ? scoredLatencyP50Ms : null;
    const completionLatencyP90Ms = latencyEvidenceKnown
      ? scoredLatencyP90Ms : null;
    // Mixture tails include recovery whenever its probability crosses the
    // requested quantile. These are trajectory bounds, not first-call price.
    const completionCostP50Usd = initial.p50AttemptCost +
      (rescue && escalationProbability >= 0.50 ? rescue.p50AttemptCost : 0);
    const completionCostP90Usd = initial.conservativeAttemptCost +
      (rescue && escalationProbability >= 0.10
        ? rescue.conservativeAttemptCost : 0);
    const completionCostP99Usd = initial.p99AttemptCost +
      (rescue && escalationProbability >= 0.01 ? rescue.p99AttemptCost : 0);
    const scoredLatencyP99Ms =
      (initial.latencyP99Ms ?? initial.expectedAttemptLatencyMs) +
      (rescue && escalationProbability >= 0.01
        ? rescue.latencyP99Ms ?? rescue.expectedAttemptLatencyMs : 0);
    const completionLatencyP99Ms = latencyEvidenceKnown
      ? scoredLatencyP99Ms : null;
    const completionTokensP50 = initial.tokenEfficiency.p50TotalTokens +
      (rescue && escalationProbability >= 0.50
        ? rescue.tokenEfficiency.p50TotalTokens : 0);
    const completionTokensP90 = initial.tokenEfficiency.p90TotalTokens +
      (rescue && escalationProbability >= 0.10
        ? rescue.tokenEfficiency.p90TotalTokens : 0);
    const completionTokensP99 = initial.tokenEfficiency.p99TotalTokens +
      (rescue && escalationProbability >= 0.01
        ? rescue.tokenEfficiency.p99TotalTokens : 0);
    const riskAdjustedCostPerVerifiedCompletion =
      (0.8 * expectedCompletionCost + 0.15 * completionCostP90Usd +
        0.05 * completionCostP99Usd) / Math.max(expectedFinalSuccess, 0.05);
    const deadlineMs = config.stageMaxMinutes * 60_000;
    const deadlineMissProbability = Math.min(1,
      initial.operationalErrorRate +
      (latencyEvidenceKnown && scoredLatencyP90Ms > deadlineMs ? 0.10 : 0) +
      (latencyEvidenceKnown && scoredLatencyP99Ms > deadlineMs ? 0.01 : 0));
    // Shared task uncertainty cancels in regret; additional uncertainty about a
    // candidate still counts. There is no absolute uncertainty veto for weak checks.
    const modeledQualityGap = reference
      ? Math.max(
          0,
          reference.quality - expectedFinalSuccess,
          reference.conservativeQuality - conservativeFinalSuccess,
        )
      : Infinity;
    const qualityGap = usablePairedProof
      ? usablePairedProof.upperRegret
      : modeledQualityGap;
    const initialGap = reference
      ? Math.max(
          0,
          reference.quality - initial.quality,
          reference.conservativeQuality - initial.conservativeQuality,
        )
      : Infinity;
    const hardRejection = !reference
      ? "no technically compatible priced reference"
      : excludedInitial.has(initial.model.id)
        ? "already reserved for race"
        : fp.frontierJustified === false &&
            initial.model.tier === "frontier"
          ? "frontier first attempt requires semantic justification"
        : // Historical attempt cost predicts retries; it cannot veto an affordable
          // first call. Rescue credit still requires funds for both reservations.
          initial.reservationCost +
              (rescue
                ? Math.max(rescue.reservationCost, rescue.expectedAttemptCost)
                : 0) >
            budgetUsd
          ? "completion budget"
          : undefined;
    const firstAttemptFloorFailed =
      initial.quality + 1e-9 < initial.firstAttemptQualityFloor &&
      (initial.localQualityEvidence >=
        config.routing.conditionalRecoveryMinSamples ||
        initial.quality < initial.firstAttemptQualityFloor -
          Math.max(0.08, allowedRegret * 4));
    const softPenalties = [
      ...(initial.softPenalties ?? []),
      ...(firstAttemptFloorFailed ? ["first-attempt quality floor"] : []),
      ...(highRisk && initialGap > allowedRegret
        ? ["high-risk first-attempt quality"]
        : []),
      ...(qualityGap > allowedRegret ? ["quality parity"] : []),
      ...(expectedCompletionCost > budgetUsd
        ? ["historical completion cost exceeds remaining budget"]
        : []),
    ];
    const qualityRejection =
      reference &&
      initial.evidenceLevel === "UNKNOWN" &&
      (reference.evidenceLevel === "PROVEN" ||
        reference.evidenceLevel === "SUPPORTED") &&
      initial.model.id !== reference.model.id &&
      !(rescue && recoveryCoverage === "targeted" && economicalTrial && !highRisk)
        ? "unknown quality cannot displace supported reference"
        : highRisk && initialGap > allowedRegret
            ? "high-risk first-attempt quality"
            : qualityGap > allowedRegret
              ? "quality parity"
              : firstAttemptFloorFailed
                ? "first-attempt quality floor"
              : undefined;
    const rejection = hardRejection ?? qualityRejection;
    const costPerVerifiedCompletion =
      expectedCompletionCost / expectedFinalSuccess;
    const latencyPerVerifiedCompletionMs =
      expectedCompletionLatencyMs / expectedFinalSuccess;
    return {
      executionEngine: fp.executionStrategy,
      models: [initial.model.id, ...(rescue ? [rescue.model.id] : [])],
      expectedStandaloneSuccess: initial.quality,
      expectedFinalSuccess,
      conservativeFinalSuccess,
      expectedCompletionCost,
      expectedCompletionLatencyMs,
      completionLatencyP50Ms,
      completionLatencyP90Ms,
      completionLatencyP99Ms,
      latencyEvidenceKnown,
      completionCostP50Usd,
      completionCostP90Usd,
      completionCostP99Usd,
      completionTokensExpected,
      completionTokensP50,
      completionTokensP90,
      completionTokensP99,
      riskAdjustedCostPerVerifiedCompletion,
      deadlineMissProbability,
      costPerVerifiedCompletion,
      latencyPerVerifiedCompletionMs,
      qualityGap,
      escalationProbability,
      verificationRecoveryCoverage: rescue ? recoveryCoverage : "none",
      recoveryEvidence: useRecorded ? recorded! : null,
      score:
        config.routing.costWeight * riskAdjustedCostPerVerifiedCompletion +
        ((config.routing.latencyWeight * scoredLatencyP90Ms) /
          Math.max(expectedFinalSuccess, 0.05) /
          1000) *
          POLICY.latencyUsdPerSecond +
        config.routing.latencyWeight * deadlineMissProbability * 0.02 +
        config.routing.latencyWeight * (initial.latencySlaPassed ? 0 : 0.02) +
        config.routing.latencyWeight * (latencyEvidenceKnown ? 0 : 0.001),
      eligible: !rejection,
      hardRejection,
      softPenalties,
      reason:
        rejection ??
        "within attainable reference regret; eligible completion economics",
      ...(usablePairedProof ? { qualityProof: {
        kind: "paired_task_regret" as const,
        effectiveSamples: usablePairedProof.effectiveSamples,
        meanRegret: usablePairedProof.meanRegret,
        upperRegret: usablePairedProof.upperRegret,
        uncertainty: usablePairedProof.uncertainty,
      } } : {}),
    };
  };
  // Score every executable model as a standalone model × engine plan. Keep
  // cascade construction bounded to the evidence/economics shortlist so the
  // broad dynamic catalog does not create an O(n²) recovery graph.
  for (const initial of eligible) {
    const standalone = estimate(initial);
    const alternatives = [standalone];
    for (const rescue of shortlistIds.has(initial.model.id) ? shortlisted : []) {
      if (
        rescue === initial ||
        (rescue.quality <= initial.quality &&
          rescue.conservativeQuality <= initial.conservativeQuality) ||
        rescue.conservativeQuality < initial.conservativeQuality
      )
        continue;
      alternatives.push(estimate(initial, rescue));
    }
    // A quality-safe first call still needs the bounded recovery edge that
    // preserves the selected plan's verified completion objective when the
    // first candidate actually fails. Price that complete policy instead of
    // treating a singleton counterfactual as permission to stop early.
    if (
      standalone.eligible &&
      alternatives.some((plan) => plan.models.length > 1 && plan.eligible)
    ) {
      standalone.eligible = false;
      standalone.reason = "existing recovery policy requires fallback";
    }
    plans.push(...alternatives);
    plansByInitial.set(initial.model.id, alternatives);
  }
  const costFirst =
    economicalTrial && recoveryCoverage === "targeted" && !highRisk;
  const interactiveRank = (plan: ExecutionPlanEstimate) =>
    plan.completionLatencyP90Ms === null ||
      plan.completionLatencyP90Ms <= POLICY.interactiveP90Ms ? 0 : 1;
  const order = (a: ExecutionPlanEstimate, b: ExecutionPlanEstimate) =>
    costFirst
      ? interactiveRank(a) - interactiveRank(b) ||
        a.riskAdjustedCostPerVerifiedCompletion -
          b.riskAdjustedCostPerVerifiedCompletion ||
        (a.completionLatencyP90Ms ?? a.expectedCompletionLatencyMs) -
          (b.completionLatencyP90Ms ?? b.expectedCompletionLatencyMs) ||
        b.conservativeFinalSuccess - a.conservativeFinalSuccess ||
        a.models.join("\0").localeCompare(b.models.join("\0"))
      : a.score - b.score ||
        a.models.join("\0").localeCompare(b.models.join("\0"));
  const selectedPlan = plans.filter((plan) => plan.eligible).sort(order)[0];
  const referencePlan = plans.find(
    (plan) =>
      plan.models.length === 1 && plan.models[0] === reference?.model.id,
  );
  for (const candidate of eligible) {
    const alternatives = plansByInitial.get(candidate.model.id);
    if (!alternatives) {
      candidate.rejected = candidate.rejection =
        "outside bounded routing shortlist";
      candidate.softPenalties = [
        ...(candidate.softPenalties ?? []),
        "shortlist economics/evidence",
      ];
      continue;
    }
    const best =
      alternatives.filter((plan) => plan.eligible).sort(order)[0] ??
      alternatives.sort(
        (a, b) => a.qualityGap - b.qualityGap || order(a, b),
      )[0]!;
    candidate.qualityFloorPassed = best.eligible;
    candidate.qualityGap = best.qualityGap;
    candidate.expectedFinalSuccess = best.expectedFinalSuccess;
    candidate.expectedCompletionCost = best.expectedCompletionCost;
    candidate.expectedCompletionLatencyMs = best.expectedCompletionLatencyMs;
    candidate.score = best.score;
    candidate.rejected = candidate.rejection = best.eligible
      ? undefined
      : best.reason;
    candidate.hardRejection = best.hardRejection;
    candidate.softPenalties = best.softPenalties;
  }
  const cascade =
    selectedPlan?.models.map((id) =>
      considered.find((candidate) => candidate.model.id === id)!,
    ) ?? [];
  return {
    cascade,
    considered,
    reference,
    plans,
    selectedPlan,
    referencePlan,
    allowedRegret,
    reason: costFirst
      ? "verified-quality regret gate first; expected cost per verified completion first and p90 latency second"
      : "attainable reference and conservative final-quality regret first; cost and preferred latency per verified completion second",
  };
}

import type { Config } from "../config.js";
import { supportsParameters } from "./pool.js";
import { attributableCodingFailure, type Attempt, type OperationalCall } from "./history.js";
import { taskBucket } from "./features.js";
import type { Features } from "./features.js";
import type { SpecialistModel, SpecialistEvidence } from "./capabilityRegistry.js";
import type { TaskFingerprint, TaskDifficulty } from "./taskFingerprint.js";
import type { Candidate } from "./modelRouter.js";
import { estimateQuality } from "./knowledge/estimator.js";
import { estimateEfficiency, estimateLatency, type TokenEfficiencyProfile } from "./knowledge/efficiency.js";
import type { EvidenceStrength } from "./controlPolicy.js";

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
  conservativeAttemptCost: number;
  knowledgeSources: string[];
  evidenceLevel: EvidenceStrength;
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
  latencySlaPassed: boolean;
  operationalErrorRate: number;
  rejection?: string;
}
export interface ExecutionPlanEstimate {
  models: string[];
  expectedStandaloneSuccess: number;
  expectedFinalSuccess: number;
  conservativeFinalSuccess: number;
  expectedCompletionCost: number;
  expectedCompletionLatencyMs: number;
  completionLatencyP50Ms: number;
  completionLatencyP90Ms: number;
  costPerVerifiedCompletion: number;
  latencyPerVerifiedCompletionMs: number;
  qualityGap: number;
  escalationProbability: number;
  verificationRecoveryCoverage: "targeted" | "none";
  recoveryEvidence: { samples: number; successes: number; rate: number;
    source: "koda_history" | "paired_external" } | null;
  score: number;
  eligible: boolean;
  hardRejection?: string;
  softPenalties: string[];
  reason: string;
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

const POLICY = {
  externalPriorWeight: 4,
  strongVerificationRegret: 0.065,
  // Recoverable failure coverage, not confidence that a passing check proves
  // correctness. Sparse evidence must not imply independent rescue success.
  latencyUsdPerSecond: 0.001,
  interactiveP90Ms: 15000,
} as const;
const clamp = (n: number) => Math.max(0.05, Math.min(0.995, n));
const betaLowerBound = (successes: number, failures: number, prior: number, strength: number) => {
  const alpha = prior * strength + successes;
  const beta = (1 - prior) * strength + failures;
  const mean = alpha / (alpha + beta);
  const deviation = Math.sqrt(alpha * beta /
    ((alpha + beta) ** 2 * (alpha + beta + 1)));
  return clamp(mean - 1.64 * deviation);
};
const failure = attributableCodingFailure;
const value = (level: TaskDifficulty[keyof TaskDifficulty]) => level === "high" ? 2 : level === "medium" ? 1 : 0;
const difficultyDistance = (a: TaskDifficulty, b: TaskDifficulty) =>
  (Object.keys(a) as (keyof TaskDifficulty)[]).reduce((n, key) => n + Math.abs(value(a[key]) - value(b[key])), 0);

function conditionalRecovery(history: Attempt[], initial: string, rescue: string,
  fp: TaskFingerprint, features: Features) {
  const relevant = history.filter((row) => historyWeight(row, fp, features) >= 0.25);
  const groups = new Map<string, Attempt[]>();
  for (const row of relevant) {
    const key = `${row.runId}:${row.subtaskId}`;
    const rows = groups.get(key) ?? [];
    rows.push(row); groups.set(key, rows);
  }
  let samples = 0, successes = 0;
  for (const rows of groups.values()) {
    const failedAt = rows.findIndex((row) =>
      (row.modelServed ?? row.modelRequested) === initial && attributableCodingFailure(row));
    if (failedAt < 0) continue;
    const recovery = rows.slice(failedAt + 1).find((row) =>
      (row.modelServed ?? row.modelRequested) === rescue &&
      (row.verification === "VERIFIED_SUCCESS" || attributableCodingFailure(row)));
    if (!recovery) continue;
    samples++;
    if (recovery.verification === "VERIFIED_SUCCESS") successes++;
  }
  return { samples, successes, rate: (successes + 1) / (samples + 2),
    source: "koda_history" as const };
}

/**
 * Learn across repositories and paths. File identity is not evidence of model
 * ability; task shape, language, execution contract and difficulty are.
 */
function historyWeight(row: Attempt, current: TaskFingerprint, features: Features): number {
  if (taskBucket(row.features) !== taskBucket(features)) return 0.02;
  const prior = row.fingerprint;
  if (!prior) return row.features.taskKind === "planning" ? 0 : 0.08;
  if (prior.primary !== current.primary && prior.taskFamily !== current.taskFamily) return 0.08;

  let weight = 0.35;
  if (prior.taskFamily && prior.taskFamily === current.taskFamily) weight += 0.25;
  if (prior.executionStrategy === current.executionStrategy) weight += 0.15;
  if (prior.scope === current.scope) weight += 0.10;
  if (prior.languages.some((language) => current.languages.includes(language))) weight += 0.10;
  const distance = difficultyDistance(prior.difficulty, current.difficulty);
  if (distance === 0) weight += 0.05;
  else if (distance > 2) weight *= 0.6;
  return Math.max(0.05, Math.min(1, weight));
}

const affinity = (item: SpecialistModel, fp: TaskFingerprint) =>
  Number(item.model.strengths.includes(fp.primary)) +
  Number(fp.visualRelevant && item.evidence.some((e) => e.source === "design_benchmark")) +
  Number(item.evidence.some((e) => e.source === "coding_benchmark" || e.source === "agentic_benchmark"));

/** Order every discovered candidate; capability and quality gates decide eligibility. */
export function curateSpecialists(models: SpecialistModel[], fp: TaskFingerprint,
  _tokens: { input: number; output: number }, _budgetUsd: number): SpecialistModel[] {
  return [...models].sort((a, b) => affinity(b, fp) - affinity(a, fp) || a.model.id.localeCompare(b.model.id));
}

export function optimizeSpecialists(models: SpecialistModel[], fp: TaskFingerprint,
  features: Features, history: Attempt[], config: Config, budgetUsd: number,
  operations: OperationalCall[] = [], excludedInitial: ReadonlySet<string> = new Set()): SpecialistRoute {
  const input = Math.ceil(features.contextBytes / 4) + 256;
  // Gateway reserves one token per input byte plus framing. Use the same
  // conservative bound for feasibility, and estimated tokens for economics.
  const reservationInput = features.contextBytes + 256;
  const expectedDefaultOutput = Math.min(config.maxOutputTokens,
    fp.effort === "complex" ? 2400 : fp.scope === "single" ? 800 : 1400);
  const output = config.maxOutputTokens;
  // Executable, focused verification can reject a failed bounded attempt.
  // This changes the trial gate only; accepted work still needs every check.
  const economicalTrial = fp.verificationStrength === "strong" &&
    fp.difficulty.changeRisk === "low" && !fp.architectureHeavy &&
    (fp.scope === "single" || fp.scope === "localized");
  const firstAttemptQualityFloor = economicalTrial
    ? Math.max(0.05, config.routing.minimumQuality - POLICY.strongVerificationRegret)
    : config.routing.minimumQuality;
  const considered: SpecialistEstimate[] = curateSpecialists(models, fp, { input, output }, budgetUsd).map((item) => {
    const { model, metadata: md } = item;
    const protocolKnown = md.routableParameterSets !== undefined || md.supportedParameters !== undefined;
    const forecastCost = md.inputPrice === undefined || md.outputPrice === undefined ? Infinity
      : (input * md.inputPrice + expectedDefaultOutput * md.outputPrice) / 1e6;
    const reservationCost = md.inputPrice === undefined || md.outputPrice === undefined ? Infinity
      : (reservationInput * md.inputPrice + output * md.outputPrice) / 1e6;
    const rejected = !model.enabled ? "disabled" : md.available === false ? "unavailable"
      : !Number.isFinite(forecastCost) ? "unknown pricing"
      : md.contextLength !== undefined && reservationInput + output > md.contextLength ? "context limit"
      : (fp.toolsRequired || fp.executionStrategy === "stable") &&
          (protocolKnown ? !supportsParameters(md, ["tools"]) : !model.strengths.includes("tool_use"))
        ? "tools unsupported"
      : fp.executionStrategy === "stable" && !supportsParameters(md, ["tools", "tool_choice"])
        ? "tool_choice unsupported"
      : fp.visionRequired && !item.vision ? "vision unsupported"
      : reservationCost > budgetUsd ? "completion budget" : undefined;
    const rows = history.filter((row) => (row.modelServed ?? row.modelRequested) === model.id &&
      (row.verification === "VERIFIED_SUCCESS" || failure(row)));
    const weighted = rows.map((row) => ({ row, weight: historyWeight(row, fp, features) *
      (failure(row) ? 0.5 : 1) }));
    const successes = weighted.filter(({ row }) => row.verification === "VERIFIED_SUCCESS")
      .reduce((n, { row, weight }) => n + weight * (row.features.acceptanceCheckCount > 0 ? 1 : 0.3), 0);
    const failures = weighted.filter(({ row }) => failure(row)).reduce((n, { weight }) => n + weight, 0);
    const evidenceCount = successes + failures;
    const external = estimateQuality(model.qualityPrior, fp, item.knowledge, item.evidence);
    const demand = value(fp.difficulty.technicalComplexity) + value(fp.difficulty.architecturalComplexity) +
      value(fp.difficulty.repoReasoningComplexity) + value(fp.difficulty.changeRisk) / 2;
    const taskAdjustedPrior = clamp(external.estimatedSuccess +
      (model.strengths.includes(fp.primary) ? 0.015 : 0) -
      demand * Math.max(0, 0.995 - model.qualityPrior) * 0.2);
    const externalWeight = external.confidence === "high" ? 10 : external.confidence === "medium" ? 6 : 4;
    const quality = clamp((taskAdjustedPrior * externalWeight + successes) /
      (externalWeight + evidenceCount));
    const domainEvidence = [fp.primary, ...fp.secondary].some((kind) =>
      item.capabilityEvidence?.some((e) => e.capability === kind && e.quality > 0) ??
      model.strengths.includes(kind));
    const transferableEvidence = item.evidence.some((e) =>
      e.source === "coding_benchmark" || e.source === "agentic_benchmark" ||
      e.source === "reasoning_benchmark" || e.source === "terminal_benchmark" ||
      (fp.visualRelevant && e.source === "design_benchmark"));
    const uncertainty = Math.max(0.015, external.uncertainty /
      Math.sqrt(1 + evidenceCount / 2) + value(fp.difficulty.contextUncertainty) * 0.008 +
      (!item.configured ? 0.02 : 0) + (!domainEvidence && !transferableEvidence ? 0.02 : 0));
    const modelCalls = operations.filter((row) =>
      row.stage === "implement" && (row.modelServed ?? row.modelRequested) === model.id);
    const bucketCalls = modelCalls.filter((row) => row.taskBucket === taskBucket(features));
    const recent = (bucketCalls.length >= 3 ? bucketCalls : modelCalls).slice(-24);
    let ewma = model.latencyPriorMs;
    for (const call of recent) ewma = 0.25 * call.wallClockMs + 0.75 * ewma;
    const latencyProfile = estimateLatency(model.latencyPriorMs, item.knowledge, fp, recent);
    const p50 = latencyProfile.p50;
    const p90 = latencyProfile.p90;
    const operationalErrorRate = recent.length
      ? recent.filter((call) => call.outcome === "error").length / (recent.length + 4) : 0;
    const latencySlaPassed = p90 <= POLICY.interactiveP90Ms;
    const latency = ewma * (1 + operationalErrorRate);
    // Attempts may contain multiple model calls. Learn their token/time totals
    // at current prices; provider errors never enter the quality posterior.
    const measured = weighted.filter(({ row }) => row.inputTokens >= 0 && row.outputTokens >= 0);
    const measuredWeight = measured.reduce((sum, { weight }) => sum + weight, 0);
    const efficiency = estimateEfficiency(fp, input, config.maxOutputTokens, item.knowledge,
      measured.map(({ row }) => row));
    const profileCost = md.inputPrice === undefined || md.outputPrice === undefined ? Infinity :
      (efficiency.expectedInputTokens * md.inputPrice + efficiency.expectedOutputTokens * md.outputPrice) / 1e6;
    const expectedAttemptCost = Number.isFinite(profileCost) ?
      (profileCost * POLICY.externalPriorWeight + measured.reduce((sum, { row, weight }) =>
        sum + weight * (row.inputTokens * md.inputPrice! + row.outputTokens * md.outputPrice!) / 1e6, 0)) /
      (POLICY.externalPriorWeight + measuredWeight) : Infinity;
    const conservativeAttemptCost = md.inputPrice === undefined || md.outputPrice === undefined ? Infinity :
      Math.max(expectedAttemptCost, efficiency.p90TotalTokens * Math.max(md.inputPrice, md.outputPrice) / 1e6);
    const expectedAttemptLatencyMs = Math.max(latency,
      (model.latencyPriorMs * POLICY.externalPriorWeight + measured.reduce((sum, { row, weight }) =>
        sum + weight * row.wallClockMs, 0)) / (POLICY.externalPriorWeight + measuredWeight));
    const evidenceLevel: EvidenceStrength = evidenceCount >= 8 ? "PROVEN"
      : evidenceCount >= 3 ? "SUPPORTED" : evidenceCount >= 1 ? "PROMISING"
        : external.evidenceLevel;
    const conservativeQuality = evidenceCount > 0
      ? betaLowerBound(successes, failures, taskAdjustedPrior, externalWeight)
      : external.conservativeSuccess;
    return {
      model, metadata: md, quality, conservativeQuality, uncertainty,
      cost: expectedAttemptCost, latency, score: Infinity,
      // Sparse or conservative quality evidence is not technical
      // incompatibility. Keep every executable candidate for reference-relative
      // plan evaluation; uncertainty decides cheap-first versus safe-first.
      rejected, hardRejection: rejected,
      softPenalties: latencySlaPassed ? [] : ["preferred latency exceeded"],
      rejection: rejected,
      confidence: evidenceCount >= 5 ? "high" as const : evidenceCount >= 1 ? "medium" as const : external.confidence,
      evidence: [...item.evidence, ...rows.map((row) => ({ source: "verified_history" as const,
        value: row.verification === "VERIFIED_SUCCESS" ? 1 : 0, detail: row.verification }))],
      expectedCompletionCost: Infinity, expectedCompletionLatencyMs: Infinity,
      expectedAttemptCost, reservationCost, expectedAttemptLatencyMs, expectedFinalSuccess: quality,
      expectedInputTokens: efficiency.expectedInputTokens,
      expectedOutputTokens: efficiency.expectedOutputTokens,
      expectedTotalTokens: efficiency.expectedTotalTokens,
      conservativeAttemptCost,
      knowledgeSources: [...external.evidenceUsed, ...efficiency.evidenceUsed],
      evidenceLevel,
      observationCount: Math.round(evidenceCount + external.observationCount),
      evidenceFreshness: external.evidenceFreshness,
      tokenEfficiency: efficiency,
      qualityGap: Infinity, qualityFloorPassed: false as boolean,
      firstAttemptQualityFloor,
      callCount: recent.length, latencyEwmaMs: ewma,
      latencyP50Ms: p50, latencyP90Ms: p90,
      latencySlaPassed, operationalErrorRate,
    } satisfies SpecialistEstimate;
  });
  const eligible = considered.filter((candidate) => !candidate.rejected);
  // A reference must itself be executable now. A reserved race participant or
  // unaffordable model cannot set an impossible quality target for this worker.
  const reference = eligible.filter((candidate) => !excludedInitial.has(candidate.model.id))
    .sort((a, b) => b.conservativeQuality - a.conservativeQuality || b.quality - a.quality ||
      a.cost - b.cost || a.model.id.localeCompare(b.model.id))[0];
  const highRisk = fp.difficulty.changeRisk === "high" || fp.architectureHeavy ||
    fp.difficulty.architecturalComplexity === "high";
  const allowedRegret = Math.min(config.routing.maxQualityRegret,
    fp.verificationStrength === "weak" ? 0.012 : 0.025) * (highRisk ? 0.5 : 1);
  // This is a policy gate, not a fabricated probability. Only a targeted
  // executable oracle permits a cheap-first quality cascade. Every accepted
  // candidate still runs the complete final verification contract.
  const recoveryCoverage = fp.verificationStrength === "strong" &&
    fp.targetedExecutableVerification !== false ? "targeted" as const : "none" as const;
  const shortlistLimit = config.routing.shortlistSize;
  const shortlistIds = new Set<string>();
  if (reference) shortlistIds.add(reference.model.id);
  const add = (candidate?: SpecialistEstimate) => {
    if (candidate && shortlistIds.size < shortlistLimit) shortlistIds.add(candidate.model.id);
  };
  add([...eligible].sort((a, b) => a.expectedAttemptCost - b.expectedAttemptCost ||
    b.conservativeQuality - a.conservativeQuality)[0]);
  add([...eligible].sort((a, b) =>
    a.expectedAttemptCost / Math.max(a.quality, 0.05) - b.expectedAttemptCost / Math.max(b.quality, 0.05) ||
    a.expectedAttemptLatencyMs - b.expectedAttemptLatencyMs)[0]);
  add([...eligible].sort((a, b) =>
    a.expectedAttemptCost / Math.max(a.conservativeQuality, 0.05) -
      b.expectedAttemptCost / Math.max(b.conservativeQuality, 0.05) ||
    a.expectedAttemptLatencyMs - b.expectedAttemptLatencyMs)[0]);
  add([...eligible].sort((a, b) => a.expectedAttemptLatencyMs - b.expectedAttemptLatencyMs ||
    b.conservativeQuality - a.conservativeQuality)[0]);
  for (const tier of ["cheap", "fast", "strong", "frontier"] as const)
    add([...eligible].filter((candidate) => candidate.model.tier === tier)
      .sort((a, b) => b.conservativeQuality - a.conservativeQuality ||
        a.expectedAttemptCost - b.expectedAttemptCost)[0]);
  for (const candidate of [...eligible].sort((a, b) =>
    b.conservativeQuality - a.conservativeQuality || a.uncertainty - b.uncertainty ||
    a.expectedAttemptCost - b.expectedAttemptCost)) add(candidate);
  const shortlisted = eligible.filter((candidate) => shortlistIds.has(candidate.model.id));
  const plans: ExecutionPlanEstimate[] = [];
  const plansByInitial = new Map<string, ExecutionPlanEstimate[]>();
  const estimate = (initial: SpecialistEstimate, rescue?: SpecialistEstimate): ExecutionPlanEstimate => {
    const kodaRecovery = rescue ? conditionalRecovery(history, initial.model.id, rescue.model.id, fp, features) : undefined;
    const externalPair = rescue ? models.flatMap((model) => model.knowledge?.pairwiseEvidence ?? [])
      .find((pair) => pair.sampleSize >= config.routing.conditionalRecoveryMinSamples &&
        (!pair.taskFamily || pair.taskFamily === (fp.taskFamily ?? fp.primary)) &&
        ((pair.candidateModelId === initial.model.id && pair.referenceModelId === rescue.model.id) ||
          (pair.referenceModelId === initial.model.id && pair.candidateModelId === rescue.model.id))) : undefined;
    const externalRecovery = externalPair ? (() => {
      const successes = externalPair.candidateModelId === initial.model.id
        ? externalPair.referenceOnly : externalPair.candidateOnly;
      const samples = successes + externalPair.bothFail;
      return { samples, successes, rate: (successes + 1) / (samples + 2),
        source: "paired_external" as const };
    })() : undefined;
    const recorded = kodaRecovery && kodaRecovery.samples >= config.routing.conditionalRecoveryMinSamples
      ? kodaRecovery : externalRecovery;
    const useRecorded = !!recorded && recorded.samples >= config.routing.conditionalRecoveryMinSamples;
    // Sparse data receives only the rescue's measured quality advantage. Once
    // enough paired outcomes exist, use smoothed conditional recovery instead
    // of assuming model outcomes are independent.
    const sparseGain = rescue && recoveryCoverage === "targeted"
      ? Math.max(0, rescue.quality - initial.quality) : 0;
    const sparseConservativeGain = rescue && recoveryCoverage === "targeted"
      ? Math.max(0, rescue.conservativeQuality - initial.conservativeQuality) : 0;
    const recoveryRate = useRecorded ? recorded!.rate : null;
    const expectedFinalSuccess = initial.quality + (rescue
      ? useRecorded ? (1 - initial.quality) * recoveryRate! : sparseGain : 0);
    const conservativeFinalSuccess = initial.conservativeQuality + (rescue
      ? useRecorded
        ? (1 - initial.conservativeQuality) * Math.max(0, recoveryRate! - 1 / Math.sqrt(recorded!.samples))
        : sparseConservativeGain : 0);
    const escalationProbability = rescue && recoveryCoverage === "targeted" ? 1 - initial.quality : 0;
    const expectedCompletionCost = initial.expectedAttemptCost + escalationProbability * (rescue?.expectedAttemptCost ?? 0);
    const expectedCompletionLatencyMs = initial.expectedAttemptLatencyMs + escalationProbability * (rescue?.expectedAttemptLatencyMs ?? 0);
    const completionLatencyP50Ms = initial.latencyP50Ms! + escalationProbability * (rescue?.latencyP50Ms ?? 0);
    const completionLatencyP90Ms = initial.latencyP90Ms! + escalationProbability * (rescue?.latencyP90Ms ?? 0);
    // Shared task uncertainty cancels in regret; additional uncertainty about a
    // candidate still counts. There is no absolute uncertainty veto for weak checks.
    const qualityGap = reference ? Math.max(0, reference.quality - expectedFinalSuccess,
      reference.conservativeQuality - conservativeFinalSuccess) : Infinity;
    const initialGap = reference ? Math.max(0, reference.quality - initial.quality,
      reference.conservativeQuality - initial.conservativeQuality) : Infinity;
    const hardRejection = !reference ? "no technically compatible priced reference"
      : excludedInitial.has(initial.model.id) ? "already reserved for race"
      // Historical attempt cost predicts retries; it cannot veto an affordable
      // first call. Rescue credit still requires funds for both reservations.
      : initial.reservationCost + (rescue ? Math.max(rescue.reservationCost, rescue.expectedAttemptCost) : 0) > budgetUsd
        ? "completion budget" : undefined;
    const softPenalties = [...initial.softPenalties ?? [],
      ...(highRisk && initialGap > allowedRegret ? ["high-risk first-attempt quality"] : []),
      ...(qualityGap > allowedRegret ? ["quality parity"] : []),
      ...(expectedCompletionCost > budgetUsd ? ["historical completion cost exceeds remaining budget"] : []),
    ];
    const qualityRejection = reference && initial.evidenceLevel === "UNKNOWN" &&
        (reference.evidenceLevel === "PROVEN" || reference.evidenceLevel === "SUPPORTED") &&
        initial.model.id !== reference.model.id
      ? "unknown quality cannot displace supported reference"
      : highRisk && initialGap > allowedRegret ? "high-risk first-attempt quality"
      : qualityGap > allowedRegret ? "quality parity" : undefined;
    const rejection = hardRejection ?? qualityRejection;
    const costPerVerifiedCompletion = expectedCompletionCost / expectedFinalSuccess;
    const latencyPerVerifiedCompletionMs = expectedCompletionLatencyMs / expectedFinalSuccess;
    return {
      models: [initial.model.id, ...(rescue ? [rescue.model.id] : [])],
      expectedStandaloneSuccess: initial.quality, expectedFinalSuccess, conservativeFinalSuccess,
      expectedCompletionCost, expectedCompletionLatencyMs, completionLatencyP50Ms, completionLatencyP90Ms,
      costPerVerifiedCompletion,
      latencyPerVerifiedCompletionMs, qualityGap, escalationProbability,
      verificationRecoveryCoverage: rescue ? recoveryCoverage : "none",
      recoveryEvidence: useRecorded ? recorded! : null,
      score: config.routing.costWeight * costPerVerifiedCompletion + config.routing.latencyWeight *
        completionLatencyP90Ms / Math.max(expectedFinalSuccess, 0.05) / 1000 * POLICY.latencyUsdPerSecond +
        config.routing.latencyWeight * (initial.latencySlaPassed ? 0 : 0.02),
      eligible: !rejection, hardRejection, softPenalties,
      reason: rejection ?? "within attainable reference regret; eligible completion economics",
    };
  };
  for (const initial of shortlisted) {
    const standalone = estimate(initial);
    const alternatives = [standalone];
    for (const rescue of shortlisted) {
      if (rescue === initial ||
          (rescue.quality <= initial.quality && rescue.conservativeQuality <= initial.conservativeQuality) ||
          rescue.conservativeQuality < initial.conservativeQuality) continue;
      alternatives.push(estimate(initial, rescue));
    }
    // Existing workers recover attributable failures when a stronger qualified
    // model is available. A singleton is a counterfactual, not permission to
    // abandon that recovery; price the complete executable policy instead.
    if (standalone.eligible && alternatives.some((plan) => plan.models.length > 1 && plan.eligible)) {
      standalone.eligible = false;
      standalone.reason = "existing recovery policy requires fallback";
    }
    plans.push(...alternatives);
    plansByInitial.set(initial.model.id, alternatives);
  }
  const costFirst = economicalTrial && recoveryCoverage === "targeted" && !highRisk;
  const order = (a: ExecutionPlanEstimate, b: ExecutionPlanEstimate) => costFirst
    ? a.costPerVerifiedCompletion - b.costPerVerifiedCompletion ||
      a.completionLatencyP90Ms - b.completionLatencyP90Ms ||
      b.conservativeFinalSuccess - a.conservativeFinalSuccess ||
      a.models.join("\0").localeCompare(b.models.join("\0"))
    : a.score - b.score || a.models.join("\0").localeCompare(b.models.join("\0"));
  const selectedPlan = plans.filter((plan) => plan.eligible).sort(order)[0];
  const referencePlan = plans.find((plan) => plan.models.length === 1 && plan.models[0] === reference?.model.id);
  for (const candidate of eligible) {
    const alternatives = plansByInitial.get(candidate.model.id);
    if (!alternatives) {
      candidate.rejected = candidate.rejection = "outside bounded routing shortlist";
      candidate.softPenalties = [...candidate.softPenalties ?? [], "shortlist economics/evidence"];
      continue;
    }
    const best = alternatives.filter((plan) => plan.eligible).sort(order)[0] ??
      alternatives.sort((a, b) => a.qualityGap - b.qualityGap || order(a, b))[0]!;
    candidate.qualityFloorPassed = best.eligible;
    candidate.qualityGap = best.qualityGap;
    candidate.expectedFinalSuccess = best.expectedFinalSuccess;
    candidate.expectedCompletionCost = best.expectedCompletionCost;
    candidate.expectedCompletionLatencyMs = best.expectedCompletionLatencyMs;
    candidate.score = best.score;
    candidate.rejected = candidate.rejection = best.eligible ? undefined : best.reason;
    candidate.hardRejection = best.hardRejection;
    candidate.softPenalties = best.softPenalties;
  }
  const cascade = selectedPlan?.models.map((id) => considered.find((candidate) => candidate.model.id === id)!) ?? [];
  return { cascade, considered, reference, plans, selectedPlan, referencePlan, allowedRegret,
    reason: costFirst
      ? "verified-quality regret gate first; expected cost per verified completion first and p90 latency second"
      : "attainable reference and conservative final-quality regret first; cost and preferred latency per verified completion second" };
}

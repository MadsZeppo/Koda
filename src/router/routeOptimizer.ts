import type { Config } from "../config.js";
import { attributableCodingFailure, type Attempt, type OperationalCall } from "./history.js";
import { taskBucket } from "./features.js";
import type { Features } from "./features.js";
import type { SpecialistModel, SpecialistEvidence } from "./capabilityRegistry.js";
import type { TaskFingerprint, TaskDifficulty } from "./taskFingerprint.js";
import type { Candidate } from "./modelRouter.js";

export interface SpecialistEstimate extends Candidate {
  confidence: "high" | "medium" | "low";
  evidence: SpecialistEvidence[];
  expectedCompletionCost: number;
  expectedCompletionLatencyMs: number;
  expectedAttemptCost: number;
  expectedAttemptLatencyMs: number;
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
  costPerVerifiedCompletion: number;
  latencyPerVerifiedCompletionMs: number;
  qualityGap: number;
  escalationProbability: number;
  detectionProbability: number;
  score: number;
  eligible: boolean;
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
  detection: { strong: 0.95, medium: 0.65, weak: 0.25 },
  latencyUsdPerSecond: 0.001,
  interactiveP90Ms: 15000,
} as const;
const clamp = (n: number) => Math.max(0.05, Math.min(0.995, n));
const failure = attributableCodingFailure;
const value = (level: TaskDifficulty[keyof TaskDifficulty]) => level === "high" ? 2 : level === "medium" ? 1 : 0;
const difficultyDistance = (a: TaskDifficulty, b: TaskDifficulty) =>
  (Object.keys(a) as (keyof TaskDifficulty)[]).reduce((n, key) => n + Math.abs(value(a[key]) - value(b[key])), 0);

/** Each historical observation contributes once at its closest similarity level. */
function historyWeight(row: Attempt, current: TaskFingerprint, features: Features): number {
  if (taskBucket(row.features) !== taskBucket(features)) return 0.005;
  const oldPaths = new Set(row.features.likelyWritePaths);
  if (oldPaths.size && features.likelyWritePaths.length &&
      !features.likelyWritePaths.some((path) => oldPaths.has(path))) return 0.05;
  const prior = row.fingerprint;
  if (!prior) return row.features.taskKind === "planning" ? 0 : 0.08;
  if (prior.primary !== current.primary) return 0.005;
  const distance = difficultyDistance(prior.difficulty, current.difficulty);
  if (distance === 0 && prior.frameworks.some((f) => current.frameworks.includes(f))) return 1;
  if (distance <= 1) return 0.65;
  return 0.25;
}

/** Difficulty is task demand; prior and observed outcomes are model ability. */
function abilityPrior(item: SpecialistModel, fp: TaskFingerprint): number {
  const coding = item.evidence.find((e) => e.source === "coding_benchmark")?.value;
  const agentic = item.evidence.find((e) => e.source === "agentic_benchmark")?.value;
  const reasoning = item.evidence.find((e) => e.source === "reasoning_benchmark")?.value;
  const terminal = item.evidence.find((e) => e.source === "terminal_benchmark")?.value;
  const design = item.evidence.find((e) => e.source === "design_benchmark")?.value;
  // Configured qualityPrior ranks models; it is not an observed Koda success rate.
  let ability = 0.70 + 0.25 * item.model.qualityPrior;
  // Benchmarks are weak relative evidence, never literal success probabilities.
  if (coding !== undefined) ability += (coding - 0.5) * 0.05;
  if (agentic !== undefined && fp.difficulty.repoReasoningComplexity !== "low") ability += (agentic - 0.5) * 0.05;
  if (reasoning !== undefined && (fp.architectureHeavy || fp.primary === "debugging")) ability += (reasoning - 0.5) * 0.04;
  if (terminal !== undefined && fp.toolsRequired) ability += (terminal - 0.5) * 0.025;
  if (design !== undefined && fp.visualRelevant) ability += Math.max(-0.025, Math.min(0.025, (design - 1200) / 16000));
  if (item.model.strengths.includes(fp.primary)) ability += 0.015;
  // A missing task-domain tag is uncertainty, not proof of inability. General
  // coding/agentic benchmarks transfer weakly to related coding work.
  const domain = [fp.primary, ...fp.secondary].filter((kind) =>
    ["frontend_ui", "sql_database", "refactor", "architecture"].includes(kind));
  if (fp.architectureHeavy && !domain.includes("architecture")) domain.push("architecture");
  const missingDomain = domain.some((kind) => !(item.capabilityEvidence?.some((e) =>
    e.capability === kind && e.quality > 0) ?? item.model.strengths.includes(kind)));
  if (missingDomain) {
    const transferable = coding !== undefined || agentic !== undefined || reasoning !== undefined || terminal !== undefined ||
      (fp.visualRelevant && design !== undefined) ||
      ((fp.architectureHeavy || domain.includes("refactor")) &&
        (item.model.strengths.includes("repo_scale") || item.model.strengths.includes("reasoning")));
    ability -= transferable ? 0.005 : fp.architectureHeavy ? 0.06 : 0.045;
  }
  const d = fp.difficulty;
  const demand = value(d.technicalComplexity) + value(d.architecturalComplexity) +
    value(d.repoReasoningComplexity) + value(d.interactionComplexity) / 2 +
    value(d.changeRisk) / 2;
  // High-ability models retain more quality as task demand increases.
  ability -= demand * Math.max(0, 0.985 - item.model.qualityPrior) * 0.2;
  if (fp.visualRelevant && d.visualComplexity === "high" && design === undefined) ability -= 0.025;
  return clamp(ability);
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
    const cost = md.inputPrice === undefined || md.outputPrice === undefined ? Infinity
      : (input * md.inputPrice + output * md.outputPrice) / 1e6;
    const rejected = !model.enabled ? "disabled" : md.available === false ? "unavailable"
      : !Number.isFinite(cost) ? "unknown pricing"
      : md.contextLength !== undefined && input + output > md.contextLength ? "context limit"
      : (fp.toolsRequired || fp.executionStrategy === "stable") && (md.supportedParameters
          ? !md.supportedParameters.includes("tools")
          : !model.strengths.includes("tool_use")) ? "tools unsupported"
      : fp.executionStrategy === "stable" && md.supportedParameters &&
          !md.supportedParameters.includes("tool_choice") ? "tool_choice unsupported"
      : fp.visionRequired && !item.vision ? "vision unsupported" : undefined;
    const rows = history.filter((row) => (row.modelServed ?? row.modelRequested) === model.id &&
      (row.verification === "VERIFIED_SUCCESS" || failure(row)));
    const weighted = rows.map((row) => ({ row, weight: historyWeight(row, fp, features) *
      (failure(row) ? 0.5 : 1) }));
    const successes = weighted.filter(({ row }) => row.verification === "VERIFIED_SUCCESS")
      .reduce((n, { row, weight }) => n + weight * (row.features.acceptanceCheckCount > 0 ? 1 : 0.3), 0);
    const failures = weighted.filter(({ row }) => failure(row)).reduce((n, { weight }) => n + weight, 0);
    const evidenceCount = successes + failures;
    const prior = abilityPrior(item, fp);
    const quality = clamp((prior * POLICY.externalPriorWeight + successes) /
      (POLICY.externalPriorWeight + evidenceCount));
    const domainEvidence = [fp.primary, ...fp.secondary].some((kind) =>
      item.capabilityEvidence?.some((e) => e.capability === kind && e.quality > 0) ??
      model.strengths.includes(kind));
    const transferableEvidence = item.evidence.some((e) =>
      e.source === "coding_benchmark" || e.source === "agentic_benchmark" ||
      e.source === "reasoning_benchmark" || e.source === "terminal_benchmark" ||
      (fp.visualRelevant && e.source === "design_benchmark"));
    const uncertainty = Math.max(0.015, (item.configured ? 0.07 : 0.09) /
      Math.sqrt(1 + evidenceCount / 2) + value(fp.difficulty.contextUncertainty) * 0.008 +
      (!domainEvidence && !transferableEvidence ? 0.02 : 0));
    const modelCalls = operations.filter((row) =>
      row.stage === "implement" && (row.modelServed ?? row.modelRequested) === model.id);
    const bucketCalls = modelCalls.filter((row) => row.taskBucket === taskBucket(features));
    const recent = (bucketCalls.length >= 3 ? bucketCalls : modelCalls).slice(-24);
    let ewma = model.latencyPriorMs;
    for (const call of recent) ewma = 0.25 * call.wallClockMs + 0.75 * ewma;
    const sorted = recent.map((call) => call.wallClockMs).sort((a, b) => a - b);
    const p50 = sorted.length >= 3 ? sorted[Math.floor((sorted.length - 1) * 0.5)]! : null;
    const p90 = sorted.length >= 5 ? sorted[Math.floor((sorted.length - 1) * 0.9)]! : null;
    const operationalErrorRate = recent.length
      ? recent.filter((call) => call.outcome === "error").length / (recent.length + 4) : 0;
    const latencySlaPassed = p90 === null || p90 <= POLICY.interactiveP90Ms;
    const latency = ewma * (1 + operationalErrorRate);
    // Attempts may contain multiple model calls. Learn their token/time totals
    // at current prices; provider errors never enter the quality posterior.
    const measured = weighted.filter(({ row }) => row.inputTokens >= 0 && row.outputTokens >= 0);
    const measuredWeight = measured.reduce((sum, { weight }) => sum + weight, 0);
    const expectedAttemptCost = Number.isFinite(cost) ?
      (cost * POLICY.externalPriorWeight + measured.reduce((sum, { row, weight }) =>
        sum + weight * (row.inputTokens * md.inputPrice! + row.outputTokens * md.outputPrice!) / 1e6, 0)) /
      (POLICY.externalPriorWeight + measuredWeight) : Infinity;
    const expectedAttemptLatencyMs = Math.max(latency,
      (model.latencyPriorMs * POLICY.externalPriorWeight + measured.reduce((sum, { row, weight }) =>
        sum + weight * row.wallClockMs, 0)) / (POLICY.externalPriorWeight + measuredWeight));
    return {
      model, metadata: md, quality, conservativeQuality: clamp(quality - uncertainty), uncertainty,
      cost, latency, score: Infinity,
      rejected: rejected ?? (quality < firstAttemptQualityFloor ? "minimum quality" : undefined),
      rejection: rejected ?? (quality < firstAttemptQualityFloor ? "minimum quality" : undefined),
      confidence: evidenceCount >= 5 ? "high" as const : item.evidence.some((e) => e.source.endsWith("benchmark")) || evidenceCount >= 1 ? "medium" as const : "low" as const,
      evidence: [...item.evidence, ...rows.map((row) => ({ source: "verified_history" as const,
        value: row.verification === "VERIFIED_SUCCESS" ? 1 : 0, detail: row.verification }))],
      expectedCompletionCost: Infinity, expectedCompletionLatencyMs: Infinity,
      expectedAttemptCost, expectedAttemptLatencyMs, expectedFinalSuccess: quality,
      qualityGap: Infinity, qualityFloorPassed: false as boolean,
      firstAttemptQualityFloor,
      callCount: recent.length, latencyEwmaMs: ewma,
      latencyP50Ms: p50, latencyP90Ms: p90,
      latencySlaPassed, operationalErrorRate,
    } satisfies SpecialistEstimate;
  });
  const eligible = considered.filter((candidate) => !candidate.rejected);
  const reference = [...eligible].filter((candidate) => candidate.quality >= config.routing.minimumQuality)
    .sort((a, b) => b.conservativeQuality - a.conservativeQuality || b.quality - a.quality ||
      a.cost - b.cost || a.model.id.localeCompare(b.model.id))[0];
  const highRisk = fp.difficulty.changeRisk === "high" || fp.architectureHeavy ||
    fp.difficulty.architecturalComplexity === "high";
  const allowedRegret = Math.min(config.routing.maxQualityRegret,
    fp.verificationStrength === "weak" ? 0.012 : 0.025) * (highRisk ? 0.5 : 1);
  const detectionProbability = POLICY.detection[fp.verificationStrength];
  const plans: ExecutionPlanEstimate[] = [];
  const plansByInitial = new Map<string, ExecutionPlanEstimate[]>();
  const estimate = (initial: SpecialistEstimate, rescue?: SpecialistEstimate): ExecutionPlanEstimate => {
    // Nested solvability is conservative about correlated errors: rescue earns
    // only its quality advantage, never (1 - pA) * pB independent-success credit.
    const expectedFinalSuccess = initial.quality + (rescue
      ? detectionProbability * Math.max(0, rescue.quality - initial.quality) : 0);
    const conservativeFinalSuccess = initial.conservativeQuality + (rescue
      ? detectionProbability * Math.max(0, rescue.conservativeQuality - initial.conservativeQuality) : 0);
    const escalationProbability = rescue ? detectionProbability * (1 - initial.quality) : 0;
    const expectedCompletionCost = initial.expectedAttemptCost + escalationProbability * (rescue?.expectedAttemptCost ?? 0);
    const expectedCompletionLatencyMs = initial.expectedAttemptLatencyMs + escalationProbability * (rescue?.expectedAttemptLatencyMs ?? 0);
    // Shared task uncertainty cancels in regret; additional uncertainty about a
    // candidate still counts. There is no absolute uncertainty veto for weak checks.
    const qualityGap = reference ? Math.max(0, reference.quality - expectedFinalSuccess,
      reference.conservativeQuality - conservativeFinalSuccess) : Infinity;
    const initialGap = reference ? Math.max(0, reference.quality - initial.quality,
      reference.conservativeQuality - initial.conservativeQuality) : Infinity;
    const rejection = !reference ? "minimum quality reference unavailable"
      : excludedInitial.has(initial.model.id) ? "already reserved for race"
      : highRisk && initialGap > allowedRegret ? "high-risk first-attempt quality"
      : !rescue && initial.quality < config.routing.minimumQuality ? "minimum quality"
      : qualityGap > allowedRegret ? "quality parity"
      // Never credit an escalation that the remaining budget cannot support.
      : Math.max(initial.cost, initial.expectedAttemptCost) + (rescue ? Math.max(rescue.cost, rescue.expectedAttemptCost) : 0) > budgetUsd
        ? "completion budget" : undefined;
    const costPerVerifiedCompletion = expectedCompletionCost / expectedFinalSuccess;
    const latencyPerVerifiedCompletionMs = expectedCompletionLatencyMs / expectedFinalSuccess;
    return {
      models: [initial.model.id, ...(rescue ? [rescue.model.id] : [])],
      expectedStandaloneSuccess: initial.quality, expectedFinalSuccess, conservativeFinalSuccess,
      expectedCompletionCost, expectedCompletionLatencyMs, costPerVerifiedCompletion,
      latencyPerVerifiedCompletionMs, qualityGap, escalationProbability,
      detectionProbability: rescue ? detectionProbability : 0,
      score: config.routing.costWeight * costPerVerifiedCompletion + config.routing.latencyWeight *
        latencyPerVerifiedCompletionMs / 1000 * POLICY.latencyUsdPerSecond +
        config.routing.latencyWeight * (initial.latencySlaPassed ? 0 : 0.02),
      eligible: !rejection, reason: rejection ?? "within reference regret; eligible completion economics",
    };
  };
  for (const initial of eligible) {
    const standalone = estimate(initial);
    const alternatives = [standalone];
    for (const rescue of eligible) {
      if (rescue === initial || rescue.quality < config.routing.minimumQuality ||
          rescue.quality <= initial.quality || rescue.conservativeQuality < initial.conservativeQuality) continue;
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
  const order = (a: ExecutionPlanEstimate, b: ExecutionPlanEstimate) =>
    a.score - b.score || a.models.join("\0").localeCompare(b.models.join("\0"));
  const selectedPlan = plans.filter((plan) => plan.eligible).sort(order)[0];
  const referencePlan = plans.find((plan) => plan.models.length === 1 && plan.models[0] === reference?.model.id);
  for (const candidate of eligible) {
    const alternatives = plansByInitial.get(candidate.model.id)!;
    const best = alternatives.filter((plan) => plan.eligible).sort(order)[0] ??
      alternatives.sort((a, b) => a.qualityGap - b.qualityGap || order(a, b))[0]!;
    candidate.qualityFloorPassed = best.eligible;
    candidate.qualityGap = best.qualityGap;
    candidate.expectedFinalSuccess = best.expectedFinalSuccess;
    candidate.expectedCompletionCost = best.expectedCompletionCost;
    candidate.expectedCompletionLatencyMs = best.expectedCompletionLatencyMs;
    candidate.score = best.score;
    candidate.rejected = candidate.rejection = best.eligible ? undefined : best.reason;
  }
  const cascade = selectedPlan?.models.map((id) => considered.find((candidate) => candidate.model.id === id)!) ?? [];
  return { cascade, considered, reference, plans, selectedPlan, referencePlan, allowedRegret,
    reason: "reference outcome and conservative final-quality regret first; cost and latency per verified completion second" };
}

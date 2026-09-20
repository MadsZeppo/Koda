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
export interface SpecialistRoute {
  cascade: SpecialistEstimate[];
  considered: SpecialistEstimate[];
  reference?: SpecialistEstimate;
  allowedRegret: number;
  reason: string;
}

const POLICY = {
  externalPriorWeight: 4,
  strongVerificationRegret: 0.065,
  mediumVerificationRegret: 0.015,
  weakUncertaintyLimit: 0.075,
  minimumEvidence: 0.1,
  latencyUsdPerSecond: 0.001,
  interactiveP90Ms: 15000,
} as const;
const clamp = (n: number) => Math.max(0.05, Math.min(0.995, n));
const failure = (row: Attempt) => attributableCodingFailure(row) &&
  !/provider|infra|timeout|rate.limit|transport|\b429\b|HTTP 5\d\d|unavailable|unknown pricing/i.test(row.reason ?? "");
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
  operations: OperationalCall[] = []): SpecialistRoute {
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
  const considered = curateSpecialists(models, fp, { input, output }, budgetUsd).map((item) => {
    const { model, metadata: md } = item;
    const cost = md.inputPrice === undefined || md.outputPrice === undefined ? Infinity
      : (input * md.inputPrice + output * md.outputPrice) / 1e6;
    const rejected = !model.enabled ? "disabled" : md.available === false ? "unavailable"
      : !Number.isFinite(cost) ? "unknown pricing" : cost > budgetUsd ? "run budget"
      : md.contextLength !== undefined && input + output > md.contextLength ? "context limit"
      : fp.toolsRequired && (md.supportedParameters
          ? !md.supportedParameters.includes("tools")
          : !model.strengths.includes("tool_use")) ? "tools unsupported"
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
    return {
      model, metadata: md, quality, conservativeQuality: clamp(quality - uncertainty), uncertainty,
      cost, latency, score: Infinity,
      rejected: rejected ?? (quality < firstAttemptQualityFloor ? "minimum quality" : undefined),
      rejection: rejected ?? (quality < firstAttemptQualityFloor ? "minimum quality" : undefined),
      confidence: evidenceCount >= 5 ? "high" as const : item.evidence.some((e) => e.source.endsWith("benchmark")) || evidenceCount >= 1 ? "medium" as const : "low" as const,
      evidence: [...item.evidence, ...rows.map((row) => ({ source: "verified_history" as const,
        value: row.verification === "VERIFIED_SUCCESS" ? 1 : 0, detail: row.verification }))],
      expectedCompletionCost: Infinity, expectedCompletionLatencyMs: Infinity,
      qualityGap: Infinity, qualityFloorPassed: false as boolean,
      firstAttemptQualityFloor,
      callCount: recent.length, latencyEwmaMs: ewma,
      latencyP50Ms: p50, latencyP90Ms: p90,
      latencySlaPassed, operationalErrorRate,
    } satisfies SpecialistEstimate;
  });
  const eligible = considered.filter((candidate) => !candidate.rejected);
  const reference = [...eligible].sort((a, b) => b.conservativeQuality - a.conservativeQuality || a.cost - b.cost)[0];
  const baseRegret = config.routing.maxQualityRegret;
  const allowedRegret = fp.verificationStrength === "strong" ? baseRegret + POLICY.strongVerificationRegret
    : fp.verificationStrength === "medium" ? baseRegret + POLICY.mediumVerificationRegret
    : Math.min(baseRegret, 0.012);
  for (const candidate of eligible) {
    candidate.qualityGap = (reference?.conservativeQuality ?? candidate.conservativeQuality) - candidate.conservativeQuality;
    const weakUncertain = fp.verificationStrength === "weak" && candidate.uncertainty > POLICY.weakUncertaintyLimit && candidate !== reference;
    candidate.qualityFloorPassed = candidate.qualityGap <= allowedRegret && !weakUncertain;
    if (!candidate.qualityFloorPassed) { candidate.rejected = weakUncertain ? "weak verification and uncertain quality" : "quality parity"; continue; }
    const rescue = candidate === reference ? undefined : reference;
    // One detected failure followed by the reference. No independent-success cascade multiplication.
    candidate.expectedCompletionCost = candidate.cost +
      (fp.verificationStrength === "weak" ? 0 : 1 - candidate.quality) * (rescue?.cost ?? 0);
    candidate.expectedCompletionLatencyMs = candidate.latency +
      (fp.verificationStrength === "weak" ? 0 : 1 - candidate.quality) * (rescue?.latency ?? 0);
    candidate.score = candidate.expectedCompletionCost + config.routing.latencyWeight *
      candidate.expectedCompletionLatencyMs / 1000 * POLICY.latencyUsdPerSecond +
      (candidate.latencySlaPassed ? 0 : 0.02);
  }
  const parity = eligible.filter((c) => c.qualityFloorPassed)
    .sort((a, b) => a.score - b.score || a.model.id.localeCompare(b.model.id));
  // Strong verification permits extra regret only when retry economics beat starting at the reference.
  const cascade = parity.filter((c) => c === reference || fp.verificationStrength !== "strong" ||
    c.qualityGap <= baseRegret || c.score < (reference?.score ?? Infinity));
  return { cascade, considered, reference, allowedRegret,
    reason: "quality and technical compatibility first; expected verified completion cost and latency second" };
}

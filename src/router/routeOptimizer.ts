import type { Config } from "../config.js";
import type { Attempt } from "./history.js";
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
  latencyUsdPerSecond: 0.0002,
} as const;
const clamp = (n: number) => Math.max(0.05, Math.min(0.995, n));
const failure = (row: Attempt) => row.verification === "FAILED" &&
  !/provider|infra|timeout|rate.limit|transport|HTTP 5\d\d|unavailable|unknown pricing/i.test(row.reason ?? "");
const value = (level: TaskDifficulty[keyof TaskDifficulty]) => level === "high" ? 2 : level === "medium" ? 1 : 0;
const difficultyDistance = (a: TaskDifficulty, b: TaskDifficulty) =>
  (Object.keys(a) as (keyof TaskDifficulty)[]).reduce((n, key) => n + Math.abs(value(a[key]) - value(b[key])), 0);

/** Each historical observation contributes once at its closest similarity level. */
function historyWeight(row: Attempt, current: TaskFingerprint): number {
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
  const design = item.evidence.find((e) => e.source === "design_benchmark")?.value;
  // Configured qualityPrior ranks models; it is not an observed Koda success rate.
  let ability = 0.70 + 0.25 * item.model.qualityPrior;
  // Benchmarks are weak relative evidence, never literal success probabilities.
  if (coding !== undefined) ability += (coding - 0.5) * 0.05;
  if (agentic !== undefined && fp.difficulty.repoReasoningComplexity !== "low") ability += (agentic - 0.5) * 0.05;
  if (design !== undefined && fp.visualRelevant) ability += Math.max(-0.025, Math.min(0.025, (design - 1200) / 16000));
  if (item.model.strengths.includes(fp.primary)) ability += 0.015;
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

/** Bound the pool without discarding the strongest-quality or cheapest known model. */
export function curateSpecialists(models: SpecialistModel[], fp: TaskFingerprint,
  _tokens: { input: number; output: number }, _budgetUsd: number): SpecialistModel[] {
  const byAffinity = [...models].sort((a, b) => affinity(b, fp) - affinity(a, fp) || a.model.id.localeCompare(b.model.id));
  const strongest = [...models].sort((a, b) => abilityPrior(b, fp) - abilityPrior(a, fp))[0];
  const cheapest = [...models].sort((a, b) =>
    (a.metadata.inputPrice ?? Infinity) + (a.metadata.outputPrice ?? Infinity) -
    (b.metadata.inputPrice ?? Infinity) - (b.metadata.outputPrice ?? Infinity))[0];
  return [...new Map([...byAffinity.slice(0, 6), strongest, cheapest].filter(Boolean).map((m) => [m!.model.id, m!])).values()].slice(0, 8);
}

export function optimizeSpecialists(models: SpecialistModel[], fp: TaskFingerprint,
  features: Features, history: Attempt[], config: Config, budgetUsd: number): SpecialistRoute {
  const input = Math.ceil(features.contextBytes / 4) + 256;
  const output = config.maxOutputTokens;
  const considered = curateSpecialists(models, fp, { input, output }, budgetUsd).map((item) => {
    const { model, metadata: md } = item;
    const cost = md.inputPrice === undefined || md.outputPrice === undefined ? Infinity
      : (input * md.inputPrice + output * md.outputPrice) / 1e6;
    const rejected = !model.enabled ? "disabled" : md.available === false ? "unavailable"
      : !Number.isFinite(cost) ? "unknown pricing" : cost > budgetUsd ? "run budget"
      : md.contextLength !== undefined && input + output > md.contextLength ? "context limit"
      : fp.toolsRequired && (!model.strengths.includes("tool_use") ||
          (md.supportedParameters && !md.supportedParameters.includes("tools"))) ? "tools unsupported"
      : fp.visionRequired && !item.vision ? "vision unsupported" : undefined;
    const rows = history.filter((row) => (row.modelServed ?? row.modelRequested) === model.id &&
      (row.verification === "VERIFIED_SUCCESS" || failure(row)));
    const weighted = rows.map((row) => ({ row, weight: historyWeight(row, fp) }));
    const successes = weighted.filter(({ row }) => row.verification === "VERIFIED_SUCCESS")
      .reduce((n, { row, weight }) => n + weight * (row.features.acceptanceCheckCount > 0 ? 1 : 0.3), 0);
    const failures = weighted.filter(({ row }) => failure(row)).reduce((n, { weight }) => n + weight, 0);
    const evidenceCount = successes + failures;
    const prior = abilityPrior(item, fp);
    const quality = clamp((prior * POLICY.externalPriorWeight + successes) /
      (POLICY.externalPriorWeight + evidenceCount));
    const uncertainty = Math.max(0.015, (item.configured ? 0.07 : 0.09) /
      Math.sqrt(1 + evidenceCount / 2) + value(fp.difficulty.contextUncertainty) * 0.008);
    const latency = rows.length ?
      (model.latencyPriorMs * 3 + rows.reduce((n, row) => n + row.wallClockMs, 0)) / (3 + rows.length)
      : model.latencyPriorMs;
    return {
      model, metadata: md, quality, conservativeQuality: clamp(quality - uncertainty), uncertainty,
      cost, latency, score: Infinity,
      rejected: rejected ?? (quality < config.routing.minimumQuality ? "minimum quality" : undefined),
      rejection: rejected ?? (quality < config.routing.minimumQuality ? "minimum quality" : undefined),
      confidence: evidenceCount >= 5 ? "high" as const : item.evidence.some((e) => e.source.endsWith("benchmark")) || evidenceCount >= 1 ? "medium" as const : "low" as const,
      evidence: [...item.evidence, ...rows.map((row) => ({ source: "verified_history" as const,
        value: row.verification === "VERIFIED_SUCCESS" ? 1 : 0, detail: row.verification }))],
      expectedCompletionCost: Infinity, expectedCompletionLatencyMs: Infinity,
      qualityGap: Infinity, qualityFloorPassed: false as boolean,
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
      candidate.expectedCompletionLatencyMs / 1000 * POLICY.latencyUsdPerSecond;
  }
  const parity = eligible.filter((c) => c.qualityFloorPassed)
    .sort((a, b) => a.score - b.score || a.model.id.localeCompare(b.model.id));
  // Strong verification permits extra regret only when retry economics beat starting at the reference.
  const cascade = parity.filter((c) => c === reference || fp.verificationStrength !== "strong" ||
    c.qualityGap <= baseRegret || c.score < (reference?.score ?? Infinity));
  const hasEvidence = cascade.some((c) => c.evidence.some((e) =>
    ["coding_benchmark", "agentic_benchmark", "design_benchmark", "verified_history"].includes(e.source)) ||
    c.model.strengths.includes(fp.primary));
  return { cascade: hasEvidence ? cascade : [], considered, reference, allowedRegret,
    reason: hasEvidence ? "near-reference conservative quality, then expected completion cost and latency"
      : "insufficient specialist evidence; retain Pareto coding route" };
}

import type { SpecialistEvidence } from "../capabilityRegistry.js";
import type { TaskFingerprint } from "../taskFingerprint.js";
import { normalizeRoutingTaskFamily } from "./identity.js";
import type { ModelRoutingKnowledge, RoutingKnowledgeObservation } from "./schema.js";

const clamp = (n: number) => Math.max(0.05, Math.min(0.995, n));
const taskFamily = (fp: TaskFingerprint) => normalizeRoutingTaskFamily(fp.taskFamily ?? fp.primary);
const fresh = (row: RoutingKnowledgeObservation) => {
  const max = row.freshnessDays ?? 730;
  const age = Math.max(0, (Date.now() - Date.parse(row.snapshotDate)) / 86_400_000);
  return Math.max(0.2, 1 - age / max);
};
const identityWeight = (row: RoutingKnowledgeObservation) =>
  row.identityLevel === "UNKNOWN" ? 0 : row.identityLevel === "FAMILY_TRANSFER" ? 0.32 : 1;
const taskWeight = (row: RoutingKnowledgeObservation, fp: TaskFingerprint) => {
  const target = taskFamily(fp);
  const families = (row.taskFamilies ?? []).map(normalizeRoutingTaskFamily).filter(Boolean);
  if (target && families.includes(target)) return 1;
  if (row.category === "agentic_swe") return fp.repoReasoningHeavy || fp.scope === "cross-component" ? 0.55 : 0.32;
  if (row.category === "terminal_tool" && fp.toolsRequired) return 0.24;
  if (row.category === "coding_reasoning") return 0.16;
  return 0;
};
const languageWeight = (row: RoutingKnowledgeObservation, fp: TaskFingerprint) => {
  if (!row.languages?.length || !fp.languages.length) return 0.85;
  return row.languages.some((language) => fp.languages.includes(language)) ? 1 : 0.28;
};
const specificity = (row: RoutingKnowledgeObservation, fp: TaskFingerprint) =>
  identityWeight(row) * taskWeight(row, fp) * languageWeight(row, fp);
const uncertaintyOf = (row: RoutingKnowledgeObservation) => row.sem !== undefined
  ? Math.min(0.25, Math.max(0.01, 1.96 * row.sem))
  : row.sampleSize ? Math.min(0.25, 1 / Math.sqrt(row.sampleSize)) : 0.18;

export interface QualityEstimate {
  estimatedSuccess: number;
  conservativeSuccess: number;
  uncertainty: number;
  confidence: "high" | "medium" | "low";
  evidenceUsed: string[];
  evidenceFreshness: number;
  evidenceLevel: "SUPPORTED" | "PROMISING" | "UNKNOWN";
  observationCount: number;
}

/**
 * Public benchmark scores are transfer priors, not literal probabilities for a
 * new repository. Exact model/task evidence can move the prior materially;
 * family/version transfer is intentionally weaker. Verified Koda history is
 * fused later in routeOptimizer and eventually dominates this cold-start prior.
 */
export function estimateQuality(qualityPrior: number, fp: TaskFingerprint,
  knowledge: ModelRoutingKnowledge | undefined, legacy: SpecialistEvidence[]): QualityEstimate {
  const anchor = 0.70 + 0.25 * qualityPrior;
  const relevant = (knowledge?.observations ?? []).filter((row) =>
    row.category !== "efficiency" && row.category !== "provider_capability" &&
    row.category !== "task_distribution" && row.category !== "market_signal" &&
    row.evidenceType !== "task_distribution" && row.evidenceType !== "market_adoption_signal" &&
    ["result_at_1", "success_rate"].includes(row.metric) && specificity(row, fp) > 0);

  let signal = 0;
  let weight = 0;
  let uncertaintyMass = 0;
  let freshnessMass = 0;
  for (const row of relevant) {
    const sampleSupport = Math.min(1, Math.sqrt(row.sampleSize ?? 1) / 6);
    const w = specificity(row, fp) * fresh(row) * sampleSupport;
    signal += w * (row.value - 0.5);
    uncertaintyMass += w * uncertaintyOf(row);
    freshnessMass += w * fresh(row);
    weight += w;
  }

  const legacyScores = legacy.filter((row) =>
    row.source.endsWith("benchmark") && row.source !== "design_benchmark");
  let legacySignal = 0;
  for (const row of legacyScores) legacySignal += (row.value - 0.5) * 0.012;

  const meanSignal = weight ? signal / weight : 0;
  // Evidence coverage controls how much a benchmark distribution may move the
  // configured cold anchor. This avoids pretending that a benchmark score is a
  // calibrated success probability on the current task.
  const coverage = Math.min(1, weight / 0.9);
  const estimatedSuccess = clamp(anchor + meanSignal * 0.18 * coverage + legacySignal);
  const evidenceUncertainty = relevant.length
    ? (uncertaintyMass / Math.max(weight, 0.001)) / Math.sqrt(1 + weight * 2)
    : 0.09;
  const sparsePenalty = relevant.length ? (coverage < 0.45 ? 0.035 : 0) : legacyScores.length ? 0.075 : 0.10;
  const totalUncertainty = Math.max(0.018, Math.min(0.20, evidenceUncertainty + sparsePenalty));
  const exactSupported = relevant.some((row) =>
    row.identityLevel === "EXACT" && taskWeight(row, fp) === 1 && (row.sampleSize ?? 0) >= 20);

  return {
    estimatedSuccess,
    conservativeSuccess: clamp(estimatedSuccess - totalUncertainty),
    uncertainty: totalUncertainty,
    confidence: exactSupported || weight >= 1.5 ? "high" : relevant.length || legacyScores.length ? "medium" : "low",
    evidenceUsed: relevant.map((row) => `${row.source}:${row.id}`),
    evidenceFreshness: weight ? freshnessMass / weight : 0,
    evidenceLevel: exactSupported ? "SUPPORTED"
      : relevant.length || legacyScores.length ? "PROMISING" : "UNKNOWN",
    observationCount: relevant.reduce((sum, row) => sum + (row.sampleSize ?? 1), 0),
  };
}

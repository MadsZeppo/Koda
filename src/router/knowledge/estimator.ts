import type { SpecialistEvidence } from "../capabilityRegistry.js";
import type { TaskFingerprint } from "../taskFingerprint.js";
import type { ModelRoutingKnowledge, RoutingKnowledgeObservation } from "./schema.js";

const clamp = (n: number) => Math.max(0.05, Math.min(0.995, n));
const taskFamily = (fp: TaskFingerprint) => fp.taskFamily ?? fp.primary;
const fresh = (row: RoutingKnowledgeObservation) => {
  const max = row.freshnessDays ?? 730;
  const age = Math.max(0, (Date.now() - Date.parse(row.snapshotDate)) / 86_400_000);
  return Math.max(0.2, 1 - age / max);
};
const specificity = (row: RoutingKnowledgeObservation, fp: TaskFingerprint) =>
  (row.identityLevel === "UNKNOWN" ? 0 : row.identityLevel === "FAMILY_TRANSFER" ? 0.25 : 1) *
  (row.taskFamilies?.includes(taskFamily(fp)) ? 1 : row.category === "agentic_swe" ? 0.55
    : row.category === "terminal_tool" && fp.toolsRequired ? 0.35
      : row.category === "coding_reasoning" ? 0.18 : 0);
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

/** Benchmarks adjust a cold rank anchor; their values never become universal task probabilities. */
export function estimateQuality(qualityPrior: number, fp: TaskFingerprint,
  knowledge: ModelRoutingKnowledge | undefined, legacy: SpecialistEvidence[]): QualityEstimate {
  const anchor = 0.70 + 0.25 * qualityPrior;
  const relevant = (knowledge?.observations ?? []).filter((row) =>
    row.category !== "efficiency" && row.category !== "provider_capability" &&
    row.category !== "task_distribution" && row.category !== "market_signal" &&
    row.evidenceType !== "task_distribution" && row.evidenceType !== "market_adoption_signal" &&
    ["result_at_1", "success_rate"].includes(row.metric) && specificity(row, fp) > 0);
  let adjustment = 0;
  let weight = 0;
  let uncertainty = 0.09;
  let freshness = 0;
  for (const row of relevant) {
    const w = specificity(row, fp) * fresh(row) * Math.min(1, (row.sampleSize ?? 12) / 40);
    // Relative signal is deliberately compressed: an agentic benchmark covers
    // a task distribution and harness, not this exact repository mutation.
    adjustment += w * (row.value - 0.5) * 0.18;
    uncertainty += w * uncertaintyOf(row);
    freshness += w * fresh(row);
    weight += w;
  }
  const legacyScores = legacy.filter((row) => row.source.endsWith("benchmark") && row.source !== "design_benchmark");
  for (const row of legacyScores) {
    adjustment += (row.value - 0.5) * 0.012;
    weight += 0.12;
  }
  const estimatedSuccess = clamp(anchor + adjustment / Math.max(1, weight));
  const evidenceUncertainty = relevant.length ? uncertainty / (1 + weight) : 0.09;
  const sparsePenalty = relevant.length ? 0 : legacyScores.length ? 0.075 : 0.10;
  const totalUncertainty = Math.max(0.018, Math.min(0.20, evidenceUncertainty + sparsePenalty));
  return {
    estimatedSuccess,
    conservativeSuccess: clamp(estimatedSuccess - totalUncertainty),
    uncertainty: totalUncertainty,
    confidence: relevant.length && weight >= 1.5 ? "high" : relevant.length || legacyScores.length ? "medium" : "low",
    evidenceUsed: relevant.map((row) => `${row.source}:${row.id}`),
    evidenceFreshness: weight ? freshness / weight : 0,
    evidenceLevel: relevant.some((row) => row.evidenceType === "paired_task_model" &&
      row.identityLevel === "EXACT" && (row.sampleSize ?? 0) >= 20) ? "SUPPORTED"
      : relevant.length || legacyScores.length ? "PROMISING" : "UNKNOWN",
    observationCount: relevant.reduce((sum, row) => sum + (row.sampleSize ?? 1), 0),
  };
}

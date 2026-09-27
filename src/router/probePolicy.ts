export type ModelOnboardingStage =
  | "UNKNOWN"
  | "METADATA_AVAILABLE"
  | "PROTOCOL_COMPATIBLE"
  | "PUBLIC_EVIDENCE_ONLY"
  | "PROBED"
  | "LIMITED_ELIGIBILITY"
  | "PRODUCTION_EVIDENCE"
  | "BROADER_ELIGIBILITY";

export interface OnboardingEvidence {
  metadataAvailable: boolean;
  protocolCompatible: boolean;
  publicSamples: number;
  probeSamples: number;
  verifiedProductionSamples: number;
  productionTaskFamilies: number;
}

export function modelOnboardingStage(evidence: OnboardingEvidence): ModelOnboardingStage {
  if (!evidence.metadataAvailable) return "UNKNOWN";
  if (!evidence.protocolCompatible) return "METADATA_AVAILABLE";
  if (evidence.verifiedProductionSamples >= 20 && evidence.productionTaskFamilies >= 3)
    return "BROADER_ELIGIBILITY";
  if (evidence.verifiedProductionSamples > 0) return "PRODUCTION_EVIDENCE";
  if (evidence.probeSamples >= 3) return "LIMITED_ELIGIBILITY";
  if (evidence.probeSamples > 0) return "PROBED";
  if (evidence.publicSamples > 0) return "PUBLIC_EVIDENCE_ONLY";
  return "PROTOCOL_COMPATIBLE";
}

export interface ProbeCandidate {
  modelId: string;
  taskFamily: string;
  stage: ModelOnboardingStage;
  uncertainty: number;
  expectedProbeCostUsd: number;
  /** Potential improvement over the current quality-safe Pareto board. */
  economicUpside: number;
  /** Distance from a production eligibility boundary; zero can change routing now. */
  eligibilityBoundaryDistance: number;
  protocolCompatible: boolean;
}

export interface ProbeDecision {
  candidate?: ProbeCandidate;
  expectedInformationValue: number;
  reason: string;
}

/**
 * Pick at most one bounded probe. The policy values evidence only when it can
 * plausibly move eligibility or the economic Pareto board; it never probes an
 * entire catalog merely because models are unknown.
 */
export function chooseNextProbe(candidates: ProbeCandidate[], remainingBudgetUsd: number): ProbeDecision {
  const ranked = candidates.flatMap((candidate) => {
    if (!candidate.protocolCompatible || candidate.expectedProbeCostUsd <= 0 ||
        candidate.expectedProbeCostUsd > remainingBudgetUsd ||
        candidate.stage === "BROADER_ELIGIBILITY") return [];
    const boundaryRelevance = Math.max(0, 1 - candidate.eligibilityBoundaryDistance / .15);
    const value = candidate.uncertainty * (boundaryRelevance + candidate.economicUpside) /
      candidate.expectedProbeCostUsd;
    return [{ candidate, value }];
  }).sort((a, b) => b.value - a.value ||
    a.candidate.expectedProbeCostUsd - b.candidate.expectedProbeCostUsd ||
    a.candidate.modelId.localeCompare(b.candidate.modelId));
  const best = ranked[0];
  // A probe whose evidence cannot move eligibility or economics has no launch value.
  if (!best || best.value < 1)
    return { expectedInformationValue: best?.value ?? 0,
      reason: "stop: no affordable probe is likely to change eligibility or Pareto position" };
  return { candidate: best.candidate, expectedInformationValue: best.value,
    reason: "highest bounded information value near an eligibility/economic boundary" };
}

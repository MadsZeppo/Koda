import type { TaskFingerprint } from "./taskFingerprint.js";
import { tierRank } from "./pool.js";

export type QualityClass = "LOW" | "MEDIUM" | "HIGH";
export type EvidenceStrength = "PROVEN" | "SUPPORTED" | "PROMISING" | "UNKNOWN" | "REJECTED";
export type ModelLifecycle = "REFERENCE" | "ACTIVE" | "CHALLENGER" | "QUARANTINED" | "UNKNOWN";
export type RecoveryFailureMode = "operational" | "no_mutation" | "verification_failure" |
  "compiler_failure" | "test_failure" | "context_limit" | "token_limit" |
  "discovery_limit" | "other";

export interface ControlCandidate {
  model: { id: string; tier: keyof typeof tierRank };
  quality: number;
  conservativeQuality: number;
  evidenceLevel: EvidenceStrength;
  observationCount: number;
  expectedAttemptCost: number;
  expectedAttemptLatencyMs: number;
  conservativeAttemptCost: number;
  operationalErrorRate: number;
  tokenEfficiency: { p90TotalTokens: number };
  hardRejection?: string;
}

export interface ActiveBoardEntry<T extends ControlCandidate = ControlCandidate> {
  candidate: T;
  lifecycle: ModelLifecycle;
  reason: string;
}

export interface RecoveryObservation {
  failureMode: RecoveryFailureMode;
  failurePhase: string;
  previousModel: string;
  mutationObserved: boolean;
  inputTokens?: number;
  outputTokens?: number;
  wallClockMs?: number;
  terminationReason?: string;
  codingAttempts?: number;
}

export interface FrozenExecutionPolicy<T extends ControlCandidate = ControlCandidate> {
  readonly id: string;
  readonly taskFingerprint: Readonly<TaskFingerprint>;
  readonly routingMode?: "quality_safe" | "bounded_zero_eligible_fallback";
  readonly qualityClass: QualityClass;
  readonly requiredQuality: number;
  readonly verificationStrength: TaskFingerprint["verificationStrength"];
  readonly approvedCandidateSet: readonly T[];
  readonly qualityCascadeModelIds?: readonly string[];
  readonly operationalRecoveryModelIds?: readonly string[];
  readonly orderedRecoveryModelIds?: readonly string[];
  readonly activeBoard: readonly ActiveBoardEntry<T>[];
  readonly referenceModel: string;
  readonly initialModel: string;
  readonly totalBudgetUsd: number;
  readonly latencyBudgetMs: number;
  readonly maxCodingAttempts: number;
  readonly maxScoutCalls: number;
  readonly providerConstraints: Readonly<Record<string, unknown>>;
  readonly writeScopes: readonly string[];
  readonly verificationContract: Readonly<Record<string, unknown>>;
  readonly stopConditions: readonly string[];
}

export function requiredQualityClass(fp: TaskFingerprint): QualityClass {
  const falseAccept = fp.verifierFalseAcceptRisk ??
    (fp.verificationStrength === "weak" ? "high" : "medium");
  const detectability = fp.recoveryDetectability ??
    (fp.verificationStrength === "strong" ? "high" : "low");
  const consequence = fp.consequenceRisk ?? fp.difficulty.changeRisk;
  if (falseAccept === "high" || fp.architectureHeavy || fp.crossComponent ||
      fp.publicApiRisk || fp.schemaRisk || fp.configRisk || fp.concurrencyRisk ||
      fp.difficulty.architecturalComplexity === "high")
    return "HIGH";
  if (consequence === "high" && detectability !== "high") return "HIGH";
  if (fp.scope === "multi-file" || fp.scope === "cross-component" ||
      fp.repoReasoningHeavy || fp.difficulty.technicalComplexity === "medium" ||
      fp.difficulty.contextUncertainty !== "low" || fp.verificationStrength === "medium" ||
      consequence === "high")
    return "MEDIUM";
  return "LOW";
}

const dominates = <T extends ControlCandidate>(a: T, b: T) =>
  a.conservativeQuality >= b.conservativeQuality &&
  a.expectedAttemptCost <= b.expectedAttemptCost &&
  a.expectedAttemptLatencyMs <= b.expectedAttemptLatencyMs &&
  (a.conservativeQuality > b.conservativeQuality ||
    a.expectedAttemptCost < b.expectedAttemptCost ||
    a.expectedAttemptLatencyMs < b.expectedAttemptLatencyMs);

export function activeModelBoard<T extends ControlCandidate>(candidates: readonly T[], limit: number) {
  const executable = candidates.filter((candidate) => !candidate.hardRejection);
  const reference = [...executable].sort((a, b) =>
    b.conservativeQuality - a.conservativeQuality || b.quality - a.quality ||
    a.expectedAttemptCost - b.expectedAttemptCost || a.model.id.localeCompare(b.model.id))[0];
  const pareto = executable.filter((candidate) =>
    !executable.some((other) => other !== candidate && dominates(other, candidate)));
  const protectedUnknown = [...executable]
    .filter((candidate) => candidate.evidenceLevel === "UNKNOWN")
    .sort((a, b) =>
      a.conservativeAttemptCost - b.conservativeAttemptCost ||
      a.expectedAttemptLatencyMs - b.expectedAttemptLatencyMs ||
      a.model.id.localeCompare(b.model.id))[0];
  const ordered = [...new Map([
    ...(reference ? [[reference.model.id, reference] as const] : []),
    ...(protectedUnknown && protectedUnknown !== reference
      ? [[protectedUnknown.model.id, protectedUnknown] as const] : []),
    ...pareto.sort((a, b) => b.conservativeQuality - a.conservativeQuality ||
      a.expectedAttemptCost - b.expectedAttemptCost ||
      a.expectedAttemptLatencyMs - b.expectedAttemptLatencyMs ||
      a.model.id.localeCompare(b.model.id)).map((candidate) => [candidate.model.id, candidate] as const),
  ]).values()].slice(0, Math.max(1, limit));
  const board: ActiveBoardEntry<T>[] = ordered.map((candidate) => ({
    candidate,
    lifecycle: candidate === reference ? "REFERENCE"
      : candidate.evidenceLevel === "PROVEN" || candidate.evidenceLevel === "SUPPORTED" ? "ACTIVE"
        : candidate.evidenceLevel === "PROMISING" ? "CHALLENGER" : "UNKNOWN",
    reason: candidate === reference ? "strongest conservative quality"
      : candidate.evidenceLevel === "UNKNOWN" ? "compatible but lacks comparable quality evidence"
        : "current quality/cost/latency Pareto candidate",
  }));
  return { reference, board, approved: board.map((entry) => entry.candidate) };
}

const evidenceRank: Record<EvidenceStrength, number> = {
  REJECTED: -1, UNKNOWN: 0, PROMISING: 1, SUPPORTED: 2, PROVEN: 3,
};

export function effectiveRecoveryFailureMode(
  observation: RecoveryObservation,
): RecoveryFailureMode {
  if (observation.failureMode === "operational") return "operational";
  if (observation.mutationObserved) return observation.failureMode;

  const reason = observation.terminationReason ?? "";
  if (
    /direct_edit_protocol_error/i.test(reason) ||
    /(?:tool[_ -]?choice|response[_ -]?format|json[_ -]?schema|no endpoints?(?:\s+found)?|unsupported|not support|requested parameters?|protocol|RepeatedFormatError|format error|HTTP\s*4(?:00|04))/i.test(reason)
  )
    return "operational";

  return observation.failureMode;
}

export function recoveryEvidenceSufficient<T extends ControlCandidate>(
  candidate: T,
  fp: TaskFingerprint,
  minSamples = 3,
): boolean {
  if (
    candidate.evidenceLevel === "PROVEN" ||
    candidate.evidenceLevel === "SUPPORTED"
  )
    return true;

  if (candidate.evidenceLevel !== "PROMISING") return false;

  const consequence = fp.consequenceRisk ?? fp.difficulty.changeRisk;
  const falseAccept =
    fp.verifierFalseAcceptRisk ??
    (fp.verificationStrength === "weak" ? "high" : "medium");
  const detectable =
    fp.recoveryDetectability ??
    (fp.verificationStrength === "strong" ? "high" : "low");
  const boundedBlastRadius =
    (fp.blastRadius ??
      (fp.scope === "cross-component"
        ? "cross-component"
        : fp.scope === "single"
          ? "single-file"
          : "package")) !== "cross-component";

  return (
    candidate.observationCount >= minSamples &&
    fp.verificationStrength === "strong" &&
    falseAccept === "low" &&
    detectable === "high" &&
    consequence !== "high" &&
    boundedBlastRadius &&
    !fp.architectureHeavy &&
    !fp.publicApiRisk &&
    !fp.schemaRisk &&
    !fp.configRisk
  );
}

export function chooseAdaptiveRecovery<T extends ControlCandidate>(
  policy: FrozenExecutionPolicy<T>,
  observation: RecoveryObservation,
  attempted: ReadonlySet<string>,
): T | undefined {
  const failureMode = effectiveRecoveryFailureMode(observation);
  if (
    failureMode !== "operational" &&
    (observation.codingAttempts ?? attempted.size) >= policy.maxCodingAttempts
  ) return undefined;
  const previous = policy.approvedCandidateSet.find(
    (candidate) => candidate.model.id === observation.previousModel,
  );
  const qualityCascade = policy.qualityCascadeModelIds
    ? new Set(policy.qualityCascadeModelIds)
    : undefined;
  const operationalRecovery = new Set(
    policy.operationalRecoveryModelIds ?? [],
  );

  let candidates = policy.approvedCandidateSet.filter(
    (candidate) => {
      const qualitySafe =
        candidate.conservativeQuality + 1e-9 >= policy.requiredQuality &&
        recoveryEvidenceSufficient(candidate, policy.taskFingerprint);

      // Operational failure is not negative coding evidence, so it may move to
      // any frozen recovery peer rather than monotonically escalating quality.
      // It still may not cross the frozen task-level quality floor.
      if (failureMode === "operational")
        return !attempted.has(candidate.model.id) &&
          !candidate.hardRejection &&
          qualitySafe;

      const optimizerApprovedQualityLeg =
        qualityCascade?.has(candidate.model.id) === true;
      return !attempted.has(candidate.model.id) &&
        !candidate.hardRejection &&
        candidate.conservativeQuality + 1e-9 >= policy.requiredQuality &&
        (optimizerApprovedQualityLeg ||
          recoveryEvidenceSufficient(candidate, policy.taskFingerprint));
    },
  );

  if (!candidates.length) return undefined;

  if (failureMode === "discovery_limit") {
    const priceCap = Math.min(
      0.01,
      Math.max(0.0025, (previous?.conservativeAttemptCost ?? 0.0025) * 4),
    );
    return candidates
      .filter((candidate) => candidate.conservativeAttemptCost <= priceCap)
      .sort((a, b) =>
        a.conservativeAttemptCost - b.conservativeAttemptCost ||
        a.expectedAttemptCost - b.expectedAttemptCost ||
        a.tokenEfficiency.p90TotalTokens - b.tokenEfficiency.p90TotalTokens ||
        b.conservativeQuality - a.conservativeQuality)[0];
  }

  if (failureMode !== "operational" && qualityCascade) {
    const qualityCandidates = candidates.filter((candidate) =>
      qualityCascade.has(candidate.model.id),
    );
    if (qualityCandidates.length) candidates = qualityCandidates;
  }

  if (failureMode !== "operational" && previous) {
    const nonDegrading = candidates.filter(
      (candidate) =>
        candidate.conservativeQuality + 1e-9 >=
        previous.conservativeQuality,
    );
    if (nonDegrading.length) candidates = nonDegrading;
  }

  const economics = (candidate: T) =>
    candidate.conservativeQuality > 0
      ? candidate.expectedAttemptCost / candidate.conservativeQuality
      : Infinity;

  if (failureMode === "operational") {
    const orderedRecovery = new Map(
      (policy.orderedRecoveryModelIds ?? []).map((id, index) => [id, index]),
    );
    return candidates.sort(
      (a, b) =>
        Number(!operationalRecovery.has(a.model.id)) -
          Number(!operationalRecovery.has(b.model.id)) ||
        (orderedRecovery.get(a.model.id) ?? Number.MAX_SAFE_INTEGER) -
          (orderedRecovery.get(b.model.id) ?? Number.MAX_SAFE_INTEGER) ||
        a.conservativeAttemptCost - b.conservativeAttemptCost ||
        economics(a) - economics(b) ||
        a.operationalErrorRate - b.operationalErrorRate ||
        a.expectedAttemptLatencyMs - b.expectedAttemptLatencyMs ||
        b.conservativeQuality - a.conservativeQuality ||
        a.model.id.localeCompare(b.model.id),
    )[0];
  }

  if (
    failureMode === "no_mutation" ||
    failureMode === "context_limit" ||
    failureMode === "token_limit"
  ) {
    return candidates.sort(
      (a, b) =>
        a.tokenEfficiency.p90TotalTokens -
          b.tokenEfficiency.p90TotalTokens ||
        b.conservativeQuality - a.conservativeQuality ||
        economics(a) - economics(b),
    )[0];
  }

  return candidates.sort(
    (a, b) =>
      b.conservativeQuality - a.conservativeQuality ||
      evidenceRank[b.evidenceLevel] - evidenceRank[a.evidenceLevel] ||
      economics(a) - economics(b) ||
      a.expectedAttemptLatencyMs - b.expectedAttemptLatencyMs,
  )[0];
}

export function freezeExecutionPolicy<P extends FrozenExecutionPolicy<ControlCandidate>>(policy: P): Readonly<P> {
  return Object.freeze({ ...policy,
    taskFingerprint: Object.freeze({ ...policy.taskFingerprint }),
    approvedCandidateSet: Object.freeze([...policy.approvedCandidateSet]),
    qualityCascadeModelIds: policy.qualityCascadeModelIds
      ? Object.freeze([...policy.qualityCascadeModelIds])
      : undefined,
    operationalRecoveryModelIds: policy.operationalRecoveryModelIds
      ? Object.freeze([...policy.operationalRecoveryModelIds])
      : undefined,
    orderedRecoveryModelIds: policy.orderedRecoveryModelIds
      ? Object.freeze([...policy.orderedRecoveryModelIds])
      : undefined,
    activeBoard: Object.freeze(policy.activeBoard.map((entry) => Object.freeze({ ...entry }))),
    providerConstraints: Object.freeze({ ...policy.providerConstraints }),
    writeScopes: Object.freeze([...policy.writeScopes]),
    verificationContract: Object.freeze({ ...policy.verificationContract }),
    stopConditions: Object.freeze([...policy.stopConditions]),
  }) as Readonly<P>;
}

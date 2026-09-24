import type { TaskFingerprint } from "./taskFingerprint.js";
import { tierRank } from "./pool.js";

export type QualityClass = "LOW" | "MEDIUM" | "HIGH";
export type EvidenceStrength = "PROVEN" | "SUPPORTED" | "PROMISING" | "UNKNOWN" | "REJECTED";
export type ModelLifecycle = "REFERENCE" | "ACTIVE" | "CHALLENGER" | "QUARANTINED" | "UNKNOWN";
export type RecoveryFailureMode = "operational" | "no_mutation" | "verification_failure" |
  "compiler_failure" | "test_failure" | "context_limit" | "token_limit" | "other";

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
}

export interface FrozenExecutionPolicy<T extends ControlCandidate = ControlCandidate> {
  readonly id: string;
  readonly taskFingerprint: Readonly<TaskFingerprint>;
  readonly qualityClass: QualityClass;
  readonly requiredQuality: number;
  readonly verificationStrength: TaskFingerprint["verificationStrength"];
  readonly approvedCandidateSet: readonly T[];
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
  if (fp.verificationStrength === "weak" || fp.architectureHeavy || fp.crossComponent ||
      fp.publicApiRisk || fp.schemaRisk || fp.configRisk || fp.concurrencyRisk ||
      fp.difficulty.changeRisk === "high" || fp.difficulty.architecturalComplexity === "high")
    return "HIGH";
  if (fp.scope === "multi-file" || fp.scope === "cross-component" ||
      fp.repoReasoningHeavy || fp.difficulty.technicalComplexity === "medium" ||
      fp.difficulty.contextUncertainty !== "low" || fp.verificationStrength === "medium")
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

/** Build a small production board from the discovery universe. */
export function activeModelBoard<T extends ControlCandidate>(candidates: readonly T[], limit: number) {
  const executable = candidates.filter((candidate) => !candidate.hardRejection);
  const reference = [...executable].sort((a, b) =>
    b.conservativeQuality - a.conservativeQuality || b.quality - a.quality ||
    a.expectedAttemptCost - b.expectedAttemptCost || a.model.id.localeCompare(b.model.id))[0];
  const pareto = executable.filter((candidate) =>
    !executable.some((other) => other !== candidate && dominates(other, candidate)));
  const ordered = [...new Map([
    ...(reference ? [[reference.model.id, reference] as const] : []),
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

/** Select only within the frozen board; coding recovery is quality-monotonic. */
export function chooseAdaptiveRecovery<T extends ControlCandidate>(
  policy: FrozenExecutionPolicy<T>, observation: RecoveryObservation,
  attempted: ReadonlySet<string>,
): T | undefined {
  if (attempted.size >= policy.maxCodingAttempts) return undefined;
  const previous = policy.approvedCandidateSet.find((candidate) =>
    candidate.model.id === observation.previousModel);
  let candidates = policy.approvedCandidateSet.filter((candidate) =>
    !attempted.has(candidate.model.id) && !candidate.hardRejection);
  if (observation.failureMode !== "operational" && previous)
    candidates = candidates.filter((candidate) =>
      tierRank[candidate.model.tier] >= tierRank[previous.model.tier] &&
      candidate.conservativeQuality >= previous.conservativeQuality - 1e-9);
  if (observation.failureMode === "operational" && previous) {
    const sideways = candidates.filter((candidate) =>
      tierRank[candidate.model.tier] === tierRank[previous.model.tier] &&
      candidate.conservativeQuality + 0.01 >= previous.conservativeQuality);
    if (sideways.length) candidates = sideways;
  }
  const economics = (candidate: T) => candidate.conservativeQuality > 0
    ? candidate.expectedAttemptCost / candidate.conservativeQuality : Infinity;
  return candidates.sort((a, b) => {
    if (observation.failureMode === "operational")
      return a.operationalErrorRate - b.operationalErrorRate ||
        a.expectedAttemptLatencyMs - b.expectedAttemptLatencyMs || economics(a) - economics(b);
    if (observation.failureMode === "no_mutation" || observation.failureMode === "context_limit" ||
        observation.failureMode === "token_limit")
      return a.tokenEfficiency.p90TotalTokens - b.tokenEfficiency.p90TotalTokens ||
        b.conservativeQuality - a.conservativeQuality || economics(a) - economics(b);
    return b.conservativeQuality - a.conservativeQuality ||
      evidenceRank[b.evidenceLevel] - evidenceRank[a.evidenceLevel] || economics(a) - economics(b);
  })[0];
}

export function freezeExecutionPolicy<P extends FrozenExecutionPolicy<ControlCandidate>>(policy: P): Readonly<P> {
  return Object.freeze({ ...policy,
    taskFingerprint: Object.freeze({ ...policy.taskFingerprint }),
    approvedCandidateSet: Object.freeze([...policy.approvedCandidateSet]),
    activeBoard: Object.freeze(policy.activeBoard.map((entry) => Object.freeze({ ...entry }))),
    providerConstraints: Object.freeze({ ...policy.providerConstraints }),
    writeScopes: Object.freeze([...policy.writeScopes]),
    verificationContract: Object.freeze({ ...policy.verificationContract }),
    stopConditions: Object.freeze([...policy.stopConditions]),
  }) as Readonly<P>;
}

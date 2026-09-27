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
  /** Models in the optimizer's coding-quality cascade, in escalation order. */
  readonly qualityCascadeModelIds?: readonly string[];
  /** Bounded peers approved only for provider/protocol recovery. */
  readonly operationalRecoveryModelIds?: readonly string[];
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

/** Build a small production board from the discovery universe. */
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
    // Sparse evidence is uncertainty, not permanent exclusion. Keep one
    // bounded challenger visible so strong verification can earn local proof.
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

/**
 * Provider/protocol incompatibility is operational evidence, not evidence that
 * the model could not solve the coding task.
 *
 * The executor can discover this either as an explicit infra failure or as a
 * successful provider response that fails Koda's required DIRECT protocol.
 */
export function effectiveRecoveryFailureMode(
  observation: RecoveryObservation,
): RecoveryFailureMode {
  if (observation.failureMode === "operational") return "operational";
  if (observation.mutationObserved) return observation.failureMode;

  const reason = observation.terminationReason ?? "";
  if (
    /direct_edit_protocol_error/i.test(reason) ||
    /(?:tool[_ -]?choice|response[_ -]?format|json[_ -]?schema|no endpoints?(?:\s+found)?|unsupported|not support|requested parameters?|protocol|HTTP\s*4(?:00|04))/i.test(reason)
  )
    return "operational";

  return observation.failureMode;
}

/**
 * Select only within the frozen board.
 *
 * Coding-quality recovery is monotonic: after actual coding evidence, do not
 * quality-downgrade.
 *
 * Operational recovery is different. The failed model/provider has not shown
 * weak coding ability; it has shown that this execution path is unavailable or
 * protocol-incompatible. In that case choose the cheapest reliable unattempted
 * candidate that still satisfies the frozen task-level quality floor. Model
 * tier is not a quality contract and must not force a trivial task onto an
 * expensive model.
 */
export function chooseAdaptiveRecovery<T extends ControlCandidate>(
  policy: FrozenExecutionPolicy<T>, observation: RecoveryObservation,
  attempted: ReadonlySet<string>,
): T | undefined {
  if (attempted.size >= policy.maxCodingAttempts) return undefined;

  const failureMode = effectiveRecoveryFailureMode(observation);
  const previous = policy.approvedCandidateSet.find((candidate) =>
    candidate.model.id === observation.previousModel);

  let candidates = policy.approvedCandidateSet.filter((candidate) =>
    !attempted.has(candidate.model.id) && !candidate.hardRejection);

  const qualityCascade = policy.qualityCascadeModelIds
    ? new Set(policy.qualityCascadeModelIds)
    : undefined;
  const operationalRecovery = new Set(
    policy.operationalRecoveryModelIds ?? [],
  );

  if (failureMode !== "operational") {
    if (qualityCascade)
      candidates = candidates.filter((candidate) =>
        qualityCascade.has(candidate.model.id));
    if (previous)
      candidates = candidates.filter((candidate) =>
        tierRank[candidate.model.tier] >= tierRank[previous.model.tier] &&
        candidate.conservativeQuality >= previous.conservativeQuality - 1e-9);
  }

  if (failureMode === "operational") {
    // The frozen requiredQuality is the contract. Do not inherit the failed
    // model's arbitrary marketing/configured tier as a new quality floor.
    candidates = candidates.filter((candidate) =>
      operationalRecovery.has(candidate.model.id) ||
      candidate.conservativeQuality + 1e-9 >= policy.requiredQuality);
  }

  if (!candidates.length) return undefined;

  const economics = (candidate: T) => candidate.conservativeQuality > 0
    ? candidate.expectedAttemptCost / candidate.conservativeQuality : Infinity;

  return candidates.sort((a, b) => {
    if (failureMode === "operational")
      return Number(!operationalRecovery.has(a.model.id)) -
          Number(!operationalRecovery.has(b.model.id)) ||
        a.operationalErrorRate - b.operationalErrorRate ||
        a.conservativeAttemptCost - b.conservativeAttemptCost ||
        a.expectedAttemptCost - b.expectedAttemptCost ||
        a.expectedAttemptLatencyMs - b.expectedAttemptLatencyMs ||
        b.conservativeQuality - a.conservativeQuality ||
        a.model.id.localeCompare(b.model.id);

    if (failureMode === "no_mutation" || failureMode === "context_limit" ||
        failureMode === "token_limit")
      return a.tokenEfficiency.p90TotalTokens - b.tokenEfficiency.p90TotalTokens ||
        b.conservativeQuality - a.conservativeQuality || economics(a) - economics(b);

    return b.conservativeQuality - a.conservativeQuality ||
      evidenceRank[b.evidenceLevel] - evidenceRank[a.evidenceLevel] ||
      economics(a) - economics(b);
  })[0];
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
    activeBoard: Object.freeze(policy.activeBoard.map((entry) => Object.freeze({ ...entry }))),
    providerConstraints: Object.freeze({ ...policy.providerConstraints }),
    writeScopes: Object.freeze([...policy.writeScopes]),
    verificationContract: Object.freeze({ ...policy.verificationContract }),
    stopConditions: Object.freeze([...policy.stopConditions]),
  }) as Readonly<P>;
}

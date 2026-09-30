import type { TaskFingerprint } from "../router/taskFingerprint.js";

export type AttemptLimitKind =
  | "step_limit"
  | "token_limit"
  | "cost_limit"
  | "token_preflight"
  | "discovery_limit"
  | "timeout"
  | "context_limit"
  | "run_budget"
  | "provider_limit"
  | "other";

export type AttemptProgressPhase =
  | "DISCOVERY"
  | "MUTATION_ATTEMPTED"
  | "MUTATION_OBSERVED"
  | "VERIFICATION_ATTEMPTED"
  | "REPAIR";

export const AIDER_PROMPT_OVERHEAD_TOKENS = 2_048;

export interface AttemptLimitPolicyInput {
  fingerprint: TaskFingerprint;
  effort: string;
  promptBytes: number;
  maxIterations: number;
  maxOutputTokens: number;
  learnedP90Tokens?: number;

  remainingTokens: number;
  stageMaxTokens: number;

  plannedBudgetUsd: number;
  remainingUsd: number;
  stageMaxUsd: number;

  promptPricePerMillion?: number;
  completionPricePerMillion?: number;

  remainingMs: number;
  configuredTimeoutMs: number;
  plannedLatencyP90Ms?: number;

  boundedDiscovery?: boolean;

  /** Whether this attempt may use Koda's one-call direct editor. */
  directEditEligible?: boolean;

  /** True whenever this concrete attempt runs through Aider. */
  aiderWorker?: boolean;

  /**
   * Per-provider-call context window.
   *
   * This is deliberately separate from Koda's cumulative attempt token
   * capacity.
   */
  modelContextTokens?: number;
}

/** True when Koda can execute the task through the one-call editor. */
export function usesDirectEditEngine(
  fingerprint: TaskFingerprint,
) {
  const localization =
    fingerprint.localizationConfidence ??
    (fingerprint.scope === "single" ? "high" : "low");

  const localized =
    localization === "high" &&
    (fingerprint.expectedFiles ?? 1) <= 1 &&
    !fingerprint.architectureHeavy &&
    !fingerprint.repoReasoningHeavy;

  return (
    localized &&
    fingerprint.scope === "single" &&
    (fingerprint.executionStrategy === "direct" ||
      fingerprint.executionStrategy === "planned")
  );
}

/**
 * Determine whether one bounded coding attempt can actually execute.
 *
 * Important distinction:
 *
 * - remainingTokens / stageMaxTokens = cumulative Koda attempt budget
 * - modelContextTokens = capacity of ONE provider request
 *
 * They must not be collapsed into one value.
 */
export function attemptLimitPolicy(
  input: AttemptLimitPolicyInput,
) {
  const localized =
    input.fingerprint.localizationConfidence === "high" &&
    (input.fingerprint.expectedFiles ?? 1) <= 1 &&
    !input.fingerprint.architectureHeavy &&
    !input.fingerprint.repoReasoningHeavy;

  /**
   * Aider is not DirectEdit.
   *
   * Without this guard a localized Aider task can accidentally inherit the
   * one-call DirectEdit viability assumptions.
   */
  const directEdit =
    !input.aiderWorker &&
    usesDirectEditEngine(input.fingerprint) &&
    input.directEditEligible !== false;

  const complex =
    !localized &&
    (input.effort === "complex" ||
      input.fingerprint.architectureHeavy ||
      input.fingerprint.repoReasoningHeavy ||
      input.fingerprint.crossComponent);

  const desiredSteps = localized
    ? 10
    : complex
      ? 16
      : 12;

  const viableCalls = input.boundedDiscovery
    ? 1
    : directEdit
      ? 1
      : input.aiderWorker
        ? 1
        : localized
          ? 4
          : complex
            ? 6
            : 5;

  const maxSteps = desiredSteps;

  /**
   * Planning estimate only.
   *
   * Actual provider accounting remains authoritative inside the worker.
   */
  const promptTokens = Math.max(
    256,
    Math.ceil(input.promptBytes / 4),
  );

  const perTurnOutput = input.boundedDiscovery
    ? Math.min(input.maxOutputTokens, 1_024)
    : directEdit || input.aiderWorker
      ? Math.min(input.maxOutputTokens, 4_096)
      : Math.min(input.maxOutputTokens, 512);

  const toolObservationTokens =
    directEdit ||
    input.boundedDiscovery ||
    input.aiderWorker
      ? 0
      : 900;

  const trajectoryPromptTokens =
    directEdit || input.boundedDiscovery
      ? Math.ceil(
          promptTokens *
            (input.boundedDiscovery ? 1.2 : 1),
        )
      : input.aiderWorker
        ? promptTokens
        : Math.ceil(
            promptTokens * viableCalls +
              (perTurnOutput + toolObservationTokens) *
                viableCalls *
                (viableCalls - 1) /
                2,
          );

  const trajectoryOutputTokens =
    input.boundedDiscovery
      ? Math.min(input.maxOutputTokens, 1_024)
      : directEdit || input.aiderWorker
        ? Math.min(input.maxOutputTokens, 4_096)
        : perTurnOutput * viableCalls;

  const aiderPromptTokens = input.aiderWorker
    ? promptTokens + AIDER_PROMPT_OVERHEAD_TOKENS
    : 0;

  const viablePromptTokens = Math.max(
    trajectoryPromptTokens,
    aiderPromptTokens,
  );

  const viableOutputTokens = Math.max(
    trajectoryOutputTokens,
    input.aiderWorker
      ? Math.min(input.maxOutputTokens, 4_096)
      : 0,
  );

  const trajectoryMinimumTokens =
    directEdit ||
    input.boundedDiscovery ||
    input.aiderWorker
      ? viablePromptTokens + viableOutputTokens
      : promptTokens +
        trajectoryOutputTokens +
        toolObservationTokens *
          Math.max(0, viableCalls - 1);

  const minimumViableTokens = trajectoryMinimumTokens;

  /**
   * Whole-attempt capacity.
   *
   * DO NOT clamp this with modelContextTokens.
   */
  const attemptTokenCapacity = Math.min(
    input.remainingTokens,
    input.stageMaxTokens,
  );

  /**
   * One provider request must fit inside the model context.
   */
  const providerContextRequired =
    viablePromptTokens + viableOutputTokens;

  const providerContextCapacity =
    input.modelContextTokens ?? Infinity;

  const boundedDiscoveryTokens =
    input.boundedDiscovery
      ? 16_000
      : 0;

  const maxTokens = Math.min(
    attemptTokenCapacity,
    Math.max(
      minimumViableTokens,
      input.maxOutputTokens * 2,
      boundedDiscoveryTokens,
      input.learnedP90Tokens ?? 0,
    ),
  );

  const minimumViableCostUsd =
    input.promptPricePerMillion === undefined ||
    input.completionPricePerMillion === undefined
      ? undefined
      : (
          viablePromptTokens *
            input.promptPricePerMillion +
          viableOutputTokens *
            input.completionPricePerMillion
        ) /
        1e6;

  const costCapacity = Math.min(
    input.remainingUsd,
    input.stageMaxUsd,
  );

  const plannedBudgetUsd =
    input.boundedDiscovery
      ? Math.max(
          input.plannedBudgetUsd * 1.5,
          (minimumViableCostUsd ?? 0) * 1.5,
        )
      : input.plannedBudgetUsd;

  const budgetUsd = Math.min(
    costCapacity,
    Math.max(
      Number.EPSILON,
      plannedBudgetUsd,
      minimumViableCostUsd ?? 0,
    ),
  );

  const minimumViableMs =
    input.boundedDiscovery
      ? 20_000
      : localized
        ? 10_000
        : complex
          ? 30_000
          : 20_000;

  const predictedDirectDeadline =
    directEdit &&
    Number.isFinite(input.plannedLatencyP90Ms) &&
    (input.plannedLatencyP90Ms ?? 0) > 0
      ? Math.max(
          10_000,
          Math.ceil(
            input.plannedLatencyP90Ms! * 1.5,
          ),
        )
      : Infinity;

  const timeoutMs = Math.min(
    input.configuredTimeoutMs,
    input.remainingMs,
    45_000,
    predictedDirectDeadline,
  );

  const nonViableLimitKind:
    | AttemptLimitKind
    | undefined =
    maxSteps < viableCalls
      ? "step_limit"
      : attemptTokenCapacity <
          minimumViableTokens
        ? "token_limit"
        : providerContextCapacity <
            providerContextRequired
          ? "context_limit"
          : minimumViableCostUsd !== undefined &&
              costCapacity <
                minimumViableCostUsd
            ? "cost_limit"
            : timeoutMs < minimumViableMs
              ? "timeout"
              : undefined;

  return {
    localized,
    directEdit,
    complex,

    maxSteps,
    viableCalls,

    maxTokens,
    budgetUsd,
    timeoutMs,

    minimumViableTokens,

    attemptTokenCapacity,
    providerContextRequired,
    providerContextCapacity,

    forecastProviderInputTokens:
      viablePromptTokens,

    forecastProviderOutputTokens:
      viableOutputTokens,

    minimumViableCostUsd,

    viable: !nonViableLimitKind,
    nonViableLimitKind,
  };
}

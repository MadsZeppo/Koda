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

// Aider's own system/repository framing sits on top of the file/task packet
// estimated by handoffPlanner. Keep one shared reserve so both layers agree.
export const AIDER_PROMPT_OVERHEAD_TOKENS = 5_120;
export const AIDER_PROMPT_HEADROOM_TOKENS = 0;

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
  directEditEligible?: boolean;
  aiderWorker?: boolean;
  modelContextTokens?: number;
}

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

function aiderAttemptLimitPolicy(
  input: AttemptLimitPolicyInput,
  localized: boolean,
  complex: boolean,
) {
  const promptTokens = Math.max(
    256,
    Math.ceil(input.promptBytes / 4),
  );

  const outputReserve = Math.min(
    input.maxOutputTokens,
    4_096,
  );

  const providerInputTokens =
    promptTokens +
    AIDER_PROMPT_OVERHEAD_TOKENS +
    AIDER_PROMPT_HEADROOM_TOKENS;

  const providerContextRequired =
    providerInputTokens +
    outputReserve;

  const providerContextCapacity =
    input.modelContextTokens ?? Infinity;

  // Aider is a coding SESSION, not a one-provider-call editor. One successful
  // provider call is sufficient for viability, but a healthy attempt needs
  // room for a follow-up call (for example after edit-format handling) without
  // Koda killing the worker immediately after its first response.
  const secondTurnInputTokens =
    providerInputTokens +
    outputReserve +
    512;

  const desiredTrajectoryTokens =
    providerContextRequired +
    secondTurnInputTokens +
    outputReserve;

  const minimumViableTokens =
    providerContextRequired;

  // stageMaxTokens remains the normal Mini-SWE/agentic stage bound, but it must
  // not make a grounded Aider session impossible merely because its complete
  // editable packet is larger than that historical cap. Aider can grow only to
  // the estimated healthy two-turn trajectory and never past the run budget.
  const attemptTokenCapacity =
    Math.min(
      input.remainingTokens,
      Math.max(
        input.stageMaxTokens,
        Math.min(
          input.remainingTokens,
          desiredTrajectoryTokens,
        ),
      ),
    );

  const maxTokens =
    Math.min(
      attemptTokenCapacity,
      Math.max(
        minimumViableTokens,
        desiredTrajectoryTokens,
        input.learnedP90Tokens ?? 0,
      ),
    );

  const firstTurnCostUsd =
    input.promptPricePerMillion === undefined ||
    input.completionPricePerMillion === undefined
      ? undefined
      : (
          providerInputTokens *
            input.promptPricePerMillion +
          outputReserve *
            input.completionPricePerMillion
        ) /
        1e6;

  const secondTurnCostUsd =
    input.promptPricePerMillion === undefined ||
    input.completionPricePerMillion === undefined
      ? undefined
      : (
          secondTurnInputTokens *
            input.promptPricePerMillion +
          outputReserve *
            input.completionPricePerMillion
        ) /
        1e6;

  const desiredSessionCostUsd =
    firstTurnCostUsd === undefined ||
    secondTurnCostUsd === undefined
      ? undefined
      : firstTurnCostUsd + secondTurnCostUsd;

  const costCapacity =
    Math.min(
      input.remainingUsd,
      input.stageMaxUsd,
    );

  const budgetUsd =
    Math.min(
      costCapacity,
      Math.max(
        Number.EPSILON,
        input.plannedBudgetUsd,
        firstTurnCostUsd ?? 0,
        desiredSessionCostUsd ?? 0,
      ),
    );

  const maxSteps = Math.max(
    2,
    Math.min(
      input.maxIterations,
      complex ? 4 : 3,
    ),
  );

  const viableCalls = Math.min(
    2,
    maxSteps,
  );

  const timeoutMs =
    Math.min(
      input.configuredTimeoutMs,
      input.remainingMs,
      90_000,
    );

  const minimumViableMs =
    localized
      ? 15_000
      : complex
        ? 30_000
        : 20_000;

  const nonViableLimitKind:
    | AttemptLimitKind
    | undefined =
    maxSteps < 1
      ? "step_limit"
      : input.remainingTokens < minimumViableTokens
        ? "token_limit"
        : providerContextCapacity < providerContextRequired
          ? "context_limit"
          : firstTurnCostUsd !== undefined &&
              costCapacity < firstTurnCostUsd
            ? "cost_limit"
            : timeoutMs < minimumViableMs
              ? "timeout"
              : undefined;

  return {
    localized,
    directEdit: false,
    complex,
    maxSteps,
    viableCalls,
    maxTokens,
    budgetUsd,
    timeoutMs,
    minimumViableTokens,
    desiredTrajectoryTokens,
    attemptTokenCapacity,
    providerContextRequired,
    providerContextCapacity,
    forecastProviderInputTokens:
      providerInputTokens,
    forecastProviderOutputTokens:
      outputReserve,
    minimumViableCostUsd:
      firstTurnCostUsd,
    viable: !nonViableLimitKind,
    nonViableLimitKind,
  };
}

export function attemptLimitPolicy(
  input: AttemptLimitPolicyInput,
) {
  const localized =
    input.fingerprint.localizationConfidence === "high" &&
    (input.fingerprint.expectedFiles ?? 1) <= 1 &&
    !input.fingerprint.architectureHeavy &&
    !input.fingerprint.repoReasoningHeavy;

  const directEdit =
    !input.aiderWorker &&
    usesDirectEditEngine(input.fingerprint) &&
    input.directEditEligible !== false;

  const complex =
    !localized &&
    Boolean(
      input.effort === "complex" ||
        input.fingerprint.architectureHeavy ||
        input.fingerprint.repoReasoningHeavy ||
        input.fingerprint.crossComponent,
    );

  if (input.aiderWorker) {
    return aiderAttemptLimitPolicy(
      input,
      localized,
      complex,
    );
  }

  const desiredSteps = localized
    ? 10
    : complex
      ? 16
      : 12;

  const viableCalls = input.boundedDiscovery
    ? 1
    : directEdit
      ? 1
      : localized
        ? 4
        : complex
          ? 6
          : 5;

  const maxSteps = desiredSteps;

  const promptTokens = Math.max(
    256,
    Math.ceil(input.promptBytes / 4),
  );

  const perTurnOutput = input.boundedDiscovery
    ? Math.min(input.maxOutputTokens, 1_024)
    : directEdit
      ? Math.min(input.maxOutputTokens, 4_096)
      : Math.min(input.maxOutputTokens, 512);

  const toolObservationTokens =
    directEdit ||
    input.boundedDiscovery
      ? 0
      : 900;

  const trajectoryPromptTokens =
    directEdit || input.boundedDiscovery
      ? Math.ceil(
          promptTokens *
            (input.boundedDiscovery ? 1.2 : 1),
        )
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
      : directEdit
        ? Math.min(input.maxOutputTokens, 4_096)
        : perTurnOutput * viableCalls;

  const peakProviderPromptTokens =
    directEdit ||
    input.boundedDiscovery
      ? trajectoryPromptTokens
      : Math.ceil(
          promptTokens +
            (perTurnOutput + toolObservationTokens) *
              Math.max(0, viableCalls - 1),
        );

  const peakProviderOutputTokens =
    directEdit ||
    input.boundedDiscovery
      ? trajectoryOutputTokens
      : perTurnOutput;

  const minimumViableTokens =
    peakProviderPromptTokens +
    peakProviderOutputTokens;

  const desiredTrajectoryTokens =
    trajectoryPromptTokens +
    trajectoryOutputTokens;

  const attemptTokenCapacity =
    Math.min(
      input.remainingTokens,
      input.stageMaxTokens,
    );

  const providerContextRequired =
    minimumViableTokens;

  const providerContextCapacity =
    input.modelContextTokens ?? Infinity;

  const boundedDiscoveryTokens =
    input.boundedDiscovery
      ? 16_000
      : 0;

  const maxTokens =
    Math.min(
      attemptTokenCapacity,
      Math.max(
        desiredTrajectoryTokens,
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
          trajectoryPromptTokens *
            input.promptPricePerMillion +
          trajectoryOutputTokens *
            input.completionPricePerMillion
        ) /
        1e6;

  const costCapacity =
    Math.min(
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

  const budgetUsd =
    Math.min(
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

  const timeoutMs =
    Math.min(
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
      : attemptTokenCapacity < minimumViableTokens
        ? "token_limit"
        : providerContextCapacity < providerContextRequired
          ? "context_limit"
          : minimumViableCostUsd !== undefined &&
              costCapacity < minimumViableCostUsd
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
    desiredTrajectoryTokens,
    attemptTokenCapacity,
    providerContextRequired,
    providerContextCapacity,
    forecastProviderInputTokens:
      trajectoryPromptTokens,
    forecastProviderOutputTokens:
      trajectoryOutputTokens,
    minimumViableCostUsd,
    viable: !nonViableLimitKind,
    nonViableLimitKind,
  };
}

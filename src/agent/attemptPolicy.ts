import type { TaskFingerprint } from "../router/taskFingerprint.js";

export type AttemptLimitKind = "step_limit" | "token_limit" | "cost_limit" |
  "token_preflight" | "discovery_limit" | "timeout" | "context_limit" | "run_budget" |
  "provider_limit" | "other";
export type AttemptProgressPhase = "DISCOVERY" | "MUTATION_ATTEMPTED" |
  "MUTATION_OBSERVED" | "VERIFICATION_ATTEMPTED" | "REPAIR";

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
  /** Whether the concrete write scope can use the one-call direct editor. */
  directEditEligible?: boolean;
}

/** True when Koda will execute this fingerprint through the one-call editor. */
export function usesDirectEditEngine(fingerprint: TaskFingerprint) {
  const localization = fingerprint.localizationConfidence ??
    (fingerprint.scope === "single" ? "high" : "low");
  const localized = localization === "high" &&
    (fingerprint.expectedFiles ?? 1) <= 1 &&
    !fingerprint.architectureHeavy && !fingerprint.repoReasoningHeavy;
  return localized && fingerprint.scope === "single" &&
    (fingerprint.executionStrategy === "direct" ||
      fingerprint.executionStrategy === "planned");
}

/** A bounded attempt must be able to execute its selected engine before it starts. */
export function attemptLimitPolicy(input: AttemptLimitPolicyInput) {
  const localized = input.fingerprint.localizationConfidence === "high" &&
    (input.fingerprint.expectedFiles ?? 1) <= 1 &&
    !input.fingerprint.architectureHeavy && !input.fingerprint.repoReasoningHeavy;

  // A localized single-file DIRECT attempt is dispatched by MiniSweWorker to
  // DirectEditWorker. That engine makes one structured model call and then
  // hands the mutation back to Koda for verification. Do not price its
  // viability as a four-turn mini-SWE inspect/edit/verify loop.
  const directEdit = usesDirectEditEngine(input.fingerprint) &&
    input.directEditEligible !== false;

  const complex = !localized && (input.effort === "complex" ||
    input.fingerprint.architectureHeavy || input.fingerprint.repoReasoningHeavy ||
    input.fingerprint.crossComponent);

  // Keep the existing step allowance even for DIRECT. DirectEditWorker itself
  // returns after one call, while the larger allowance keeps the existing
  // mini-SWE fallback bounded if direct editing is unsupported for the target.
  const desiredSteps = localized ? 10 : complex ? 16 : 12;
  const viableCalls = input.boundedDiscovery
    ? 1
    : directEdit
      ? 1
      : localized
        ? 4
        : complex
          ? 6
          : 5;

  // maxIterations bounds Koda's outer candidate/cascade attempts. It is not a
  // mini-SWE turn limit; coupling the two made two-attempt runs incapable of
  // completing even one inspect -> edit -> verify sequence.
  const maxSteps = desiredSteps;
  const promptTokens = Math.max(256, Math.ceil(input.promptBytes / 4));

  // Each mini-SWE tool round resends the conversation. DirectEditWorker has no
  // tool loop, so its viability bound contains one prompt plus one full bounded
  // completion instead of four repeated prompts and four 512-token turns.
  const perTurnOutput = input.boundedDiscovery
    ? Math.min(input.maxOutputTokens, 1024)
    : directEdit ? Math.min(input.maxOutputTokens, 4096)
    : Math.min(input.maxOutputTokens, 512);
  const toolObservationTokens = directEdit || input.boundedDiscovery ? 0 : 900;
  const viablePromptTokens = directEdit || input.boundedDiscovery
    ? Math.ceil(promptTokens * (input.boundedDiscovery ? 1.2 : 1))
    : Math.ceil(
        promptTokens * viableCalls +
        (perTurnOutput + toolObservationTokens) *
          viableCalls * (viableCalls - 1) / 2,
      );
  const viableOutputTokens = input.boundedDiscovery
    ? Math.min(input.maxOutputTokens, 1024)
    : directEdit
    ? Math.min(input.maxOutputTokens, 4096)
    : perTurnOutput * viableCalls;
  // The attempt-token ledger counts trajectory growth, while provider cost
  // must price every resent prompt in the multi-turn conversation.
  const minimumViableTokens = directEdit || input.boundedDiscovery
    ? viablePromptTokens + viableOutputTokens
    : promptTokens + viableOutputTokens +
      toolObservationTokens * Math.max(0, viableCalls - 1);

  const tokenCapacity = Math.min(input.remainingTokens, input.stageMaxTokens);
  const boundedDiscoveryTokens = input.boundedDiscovery ? 16_000 : 0;
  const maxTokens = Math.min(tokenCapacity, Math.max(minimumViableTokens,
    input.maxOutputTokens * 2, boundedDiscoveryTokens,
    input.learnedP90Tokens ?? 0));

  const minimumViableCostUsd = input.promptPricePerMillion === undefined ||
      input.completionPricePerMillion === undefined ? undefined :
    (viablePromptTokens * input.promptPricePerMillion +
      viableOutputTokens * input.completionPricePerMillion) / 1e6;

  const costCapacity = Math.min(input.remainingUsd, input.stageMaxUsd);
  const plannedBudgetUsd = input.boundedDiscovery
    ? Math.max(
        input.plannedBudgetUsd * 1.5,
        (minimumViableCostUsd ?? 0) * 1.5,
      )
    : input.plannedBudgetUsd;
  const budgetUsd = Math.min(costCapacity, Math.max(Number.EPSILON,
    plannedBudgetUsd, minimumViableCostUsd ?? 0));

  const minimumViableMs = input.boundedDiscovery
    ? 20_000
    : localized
      ? 10_000
      : complex
        ? 30_000
        : 20_000;
  // DIRECT is a single structured request. Once routing has a usable p90,
  // waiting many multiples of it only delays operational recovery. Keep a
  // 10s viability floor and 1.5 p90s of headroom; unknown latency retains
  // the configured hard deadline.
  const predictedDirectDeadline = directEdit &&
      Number.isFinite(input.plannedLatencyP90Ms) &&
      (input.plannedLatencyP90Ms ?? 0) > 0
    ? Math.max(10_000, Math.ceil(input.plannedLatencyP90Ms! * 1.5))
    : Infinity;
  const timeoutMs = Math.min(
    input.configuredTimeoutMs,
    input.remainingMs,
    input.boundedDiscovery ? 45_000 : 45_000,
    predictedDirectDeadline,
  );
  const nonViableLimitKind: AttemptLimitKind | undefined =
    maxSteps < viableCalls ? "step_limit" :
      tokenCapacity < minimumViableTokens ? "token_limit" :
        minimumViableCostUsd !== undefined && costCapacity < minimumViableCostUsd
          ? "cost_limit" : timeoutMs < minimumViableMs ? "timeout" : undefined;

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
    forecastProviderInputTokens: viablePromptTokens,
    forecastProviderOutputTokens: viableOutputTokens,
    minimumViableCostUsd,
    viable: !nonViableLimitKind,
    nonViableLimitKind,
  };
}

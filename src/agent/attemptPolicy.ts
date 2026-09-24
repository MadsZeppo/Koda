import type { TaskFingerprint } from "../router/taskFingerprint.js";

export type AttemptLimitKind = "step_limit" | "token_limit" | "cost_limit" |
  "token_preflight" | "timeout" | "context_limit" | "run_budget" |
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
}

/** A bounded attempt must be able to inspect, edit, and verify before it starts. */
export function attemptLimitPolicy(input: AttemptLimitPolicyInput) {
  const localized = input.fingerprint.localizationConfidence === "high" &&
    (input.fingerprint.expectedFiles ?? 1) <= 1 &&
    !input.fingerprint.architectureHeavy && !input.fingerprint.repoReasoningHeavy;
  const complex = !localized && (input.effort === "complex" ||
    input.fingerprint.architectureHeavy || input.fingerprint.repoReasoningHeavy ||
    input.fingerprint.crossComponent);
  const desiredSteps = localized ? 10 : complex ? 16 : 12;
  const viableCalls = localized ? 4 : complex ? 6 : 5;
  // maxIterations bounds Koda's outer candidate/cascade attempts. It is not a
  // mini-SWE turn limit; coupling the two made two-attempt runs incapable of
  // completing even one inspect -> edit -> verify sequence.
  const maxSteps = desiredSteps;
  const promptTokens = Math.max(256, Math.ceil(input.promptBytes / 4));
  // Each tool round resends the conversation and adds observations. This is a
  // cumulative billed-token bound, not a context-window estimate.
  const viablePromptTokens = Math.ceil(promptTokens * viableCalls * (localized ? 1.4 : 1.5));
  const viableOutputTokens = Math.min(input.maxOutputTokens, 512) * viableCalls;
  const minimumViableTokens = viablePromptTokens + viableOutputTokens;
  const tokenCapacity = Math.min(input.remainingTokens, input.stageMaxTokens);
  const maxTokens = Math.min(tokenCapacity, Math.max(minimumViableTokens,
    input.maxOutputTokens * 2, input.learnedP90Tokens ?? 0));
  const minimumViableCostUsd = input.promptPricePerMillion === undefined ||
      input.completionPricePerMillion === undefined ? undefined :
    (viablePromptTokens * input.promptPricePerMillion +
      viableOutputTokens * input.completionPricePerMillion) / 1e6;
  const costCapacity = Math.min(input.remainingUsd, input.stageMaxUsd);
  const budgetUsd = Math.min(costCapacity, Math.max(Number.EPSILON,
    input.plannedBudgetUsd, minimumViableCostUsd ?? 0));
  const minimumViableMs = localized ? 10_000 : complex ? 30_000 : 20_000;
  const timeoutMs = Math.min(input.configuredTimeoutMs, input.remainingMs, 45_000);
  const nonViableLimitKind: AttemptLimitKind | undefined =
    maxSteps < viableCalls ? "step_limit" :
      tokenCapacity < minimumViableTokens ? "token_limit" :
        minimumViableCostUsd !== undefined && costCapacity < minimumViableCostUsd
          ? "cost_limit" : timeoutMs < minimumViableMs ? "timeout" : undefined;
  return { localized, complex, maxSteps, viableCalls, maxTokens, budgetUsd,
    timeoutMs, minimumViableTokens, minimumViableCostUsd,
    viable: !nonViableLimitKind, nonViableLimitKind };
}

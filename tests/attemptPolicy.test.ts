import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AIDER_PROMPT_OVERHEAD_TOKENS,
  attemptLimitPolicy,
} from "../src/agent/attemptPolicy.js";
import type { TaskFingerprint } from "../src/router/taskFingerprint.js";

function fingerprint(overrides: Partial<TaskFingerprint> = {}): TaskFingerprint {
  return {
    primary: "testing",
    secondary: [],
    languages: ["typescript"],
    frameworks: ["nodejs"],
    scope: "single",
    effort: "normal",
    executionStrategy: "direct",
    visualRelevant: false,
    browserRelevant: false,
    terminalHeavy: false,
    repoReasoningHeavy: false,
    architectureHeavy: false,
    toolsRequired: true,
    visionRequired: false,
    verificationStrength: "strong",
    localizationConfidence: "high",
    expectedFiles: 1,
    crossComponent: false,
    difficulty: {
      technicalComplexity: "low",
      visualComplexity: "low",
      architecturalComplexity: "low",
      interactionComplexity: "low",
      repoReasoningComplexity: "low",
      changeRisk: "low",
      contextUncertainty: "low",
    },
    confidence: "high",
    reasons: [],
    ...overrides,
  };
}

const base = {
  effort: "normal",
  promptBytes: 17_428,
  maxIterations: 3,
  maxOutputTokens: 4_096,
  remainingTokens: 30_000,
  stageMaxTokens: 30_000,
  plannedBudgetUsd: 0.04,
  remainingUsd: 0.1187062,
  stageMaxUsd: 0.20,
  promptPricePerMillion: 4,
  completionPricePerMillion: 20,
  remainingMs: 45_000,
  configuredTimeoutMs: 45_000,
};

test("localized single-file DIRECT is budgeted as one structured model call", () => {
  const policy = attemptLimitPolicy({ ...base, fingerprint: fingerprint() });
  assert.equal(policy.localized, true);
  assert.equal(policy.directEdit, true);
  assert.equal(policy.viableCalls, 1);
  assert.equal(policy.viable, true);
  assert.equal(policy.nonViableLimitKind, undefined);
  assert.ok((policy.minimumViableCostUsd ?? Infinity) < base.remainingUsd);
});

test("localized single-file PLANNED worker uses the same one-call edit contract", () => {
  const policy = attemptLimitPolicy({
    ...base,
    fingerprint: fingerprint({ executionStrategy: "planned" }),
  });
  assert.equal(policy.localized, true);
  assert.equal(policy.directEdit, true);
  assert.equal(policy.viableCalls, 1);
  assert.equal(policy.viable, true);
});

test("localized STABLE keeps its bounded multi-turn viability policy", () => {
  const policy = attemptLimitPolicy({
    ...base,
    fingerprint: fingerprint({ executionStrategy: "stable" }),
  });
  assert.equal(policy.localized, true);
  assert.equal(policy.directEdit, false);
  assert.equal(policy.viableCalls, 4);
  assert.equal(policy.viable, false);
  assert.equal(policy.nonViableLimitKind, "cost_limit");
  assert.ok((policy.minimumViableCostUsd ?? 0) > base.remainingUsd);
});

test("multi-file DIRECT never receives the one-call direct-edit budget contract", () => {
  const policy = attemptLimitPolicy({
    ...base,
    fingerprint: fingerprint({ scope: "multi-file", expectedFiles: 2 }),
  });
  assert.equal(policy.directEdit, false);
  assert.ok(policy.viableCalls > 1);
});

test("broad DIRECT scope budgets the actual multi-turn Mini-SWE provider trajectory", () => {
  const policy = attemptLimitPolicy({
    ...base,
    fingerprint: fingerprint(),
    directEditEligible: false,
    plannedBudgetUsd: 0.004,
    remainingUsd: 0.30,
    stageMaxUsd: 0.30,
  });
  const initialPrompt = Math.max(256, Math.ceil(base.promptBytes / 4));
  const simulatedProviderInput = initialPrompt * policy.viableCalls +
    (512 + 900) * policy.viableCalls * (policy.viableCalls - 1) / 2;
  const simulatedCost = (simulatedProviderInput * base.promptPricePerMillion +
    512 * policy.viableCalls * base.completionPricePerMillion) / 1e6;

  assert.equal(policy.directEdit, false);
  assert.equal(policy.viableCalls, 4);
  assert.ok((policy.minimumViableCostUsd ?? 0) >= simulatedCost);
  assert.ok(policy.budgetUsd >= simulatedCost,
    "healthy discover/read/mutate/verify loop is funded before dispatch");
});

test("DIRECT uses routed p90 to bound a stalled provider without changing the hard cap", () => {
  const measured = attemptLimitPolicy({
    ...base,
    fingerprint: fingerprint(),
    plannedLatencyP90Ms: 3_400,
  });
  const unknown = attemptLimitPolicy({ ...base, fingerprint: fingerprint() });
  assert.equal(measured.timeoutMs, 10_000);
  assert.equal(unknown.timeoutMs, 45_000);
  assert.equal(measured.viable, true);
});

test("unknown localization can start from a bounded discovery packet", () => {
  const policy = attemptLimitPolicy({
    ...base,
    promptBytes: 4_000,
    learnedP90Tokens: 50_259,
    remainingUsd: 0.20,
    stageMaxUsd: 0.20,
    fingerprint: fingerprint({
      scope: "multi-file",
      executionStrategy: "stable",
      localizationConfidence: "low",
      expectedFiles: 4,
    }),
  });
  assert.equal(policy.directEdit, false);
  assert.equal(policy.viable, true);
  assert.ok(policy.minimumViableTokens < base.remainingTokens);
  assert.ok(policy.forecastProviderInputTokens > 15_000);
});

test("bounded discovery starts even when the unresolved task fingerprint is broad", () => {
  const policy = attemptLimitPolicy({
    ...base,
    promptBytes: 16_000,
    learnedP90Tokens: 50_000,
    boundedDiscovery: true,
    fingerprint: fingerprint({
      scope: "cross-component",
      executionStrategy: "direct",
      localizationConfidence: "low",
      expectedFiles: 10,
      crossComponent: true,
    }),
  });
  assert.equal(policy.viableCalls, 1);
  assert.equal(policy.viable, true);
  assert.ok(policy.minimumViableTokens < 10_000);
  assert.ok(policy.maxTokens >= 16_000);
  assert.equal(policy.timeoutMs, 45_000);
  assert.ok(policy.budgetUsd > base.plannedBudgetUsd);
});

test("Aider is budgeted as a multi-call coding session rather than a one-call editor", () => {
  const policy = attemptLimitPolicy({
    ...base,
    fingerprint: fingerprint({
      scope: "multi-file",
      expectedFiles: 2,
      localizationConfidence: "high",
    }),
    aiderWorker: true,
    directEditEligible: false,
    promptBytes: 76_968,
    remainingTokens: 120_000,
    stageMaxTokens: 30_000,
    remainingUsd: 1,
    stageMaxUsd: 1,
    modelContextTokens: 128_000,
  });

  const promptTokens = Math.ceil(76_968 / 4);
  const firstTurn = promptTokens + AIDER_PROMPT_OVERHEAD_TOKENS + 4_096;
  assert.equal(policy.directEdit, false);
  assert.equal(policy.viableCalls, 2);
  assert.equal(policy.minimumViableTokens, firstTurn);
  assert.equal(policy.providerContextRequired, firstTurn);
  assert.ok(policy.desiredTrajectoryTokens > firstTurn);
  assert.ok(policy.maxTokens > base.stageMaxTokens,
    "Aider may exceed the historical 30k Mini-SWE stage cap when its grounded session requires it");
  assert.equal(policy.viable, true);
});

test("Aider context overflow rejects the model instead of switching coding engines", () => {
  const policy = attemptLimitPolicy({
    ...base,
    fingerprint: fingerprint({ scope: "multi-file", expectedFiles: 2 }),
    aiderWorker: true,
    directEditEligible: false,
    promptBytes: 76_968,
    remainingTokens: 120_000,
    stageMaxTokens: 30_000,
    remainingUsd: 1,
    stageMaxUsd: 1,
    modelContextTokens: 20_000,
  });
  assert.equal(policy.viable, false);
  assert.equal(policy.nonViableLimitKind, "context_limit");
});

test("Aider receives a longer subprocess deadline than the old 45 second Mini-SWE cap", () => {
  const policy = attemptLimitPolicy({
    ...base,
    fingerprint: fingerprint({ scope: "multi-file", expectedFiles: 2 }),
    aiderWorker: true,
    promptBytes: 4_000,
    remainingTokens: 100_000,
    stageMaxTokens: 30_000,
    remainingUsd: 1,
    stageMaxUsd: 1,
    remainingMs: 120_000,
    configuredTimeoutMs: 120_000,
    modelContextTokens: 128_000,
  });
  assert.equal(policy.timeoutMs, 90_000);
  assert.equal(policy.viable, true);
});

test("agentic multi-turn budgeting funds the cumulative trajectory instead of only the largest single turn", () => {
  const policy = attemptLimitPolicy({
    ...base,
    fingerprint: fingerprint({
      scope: "multi-file",
      executionStrategy: "stable",
      localizationConfidence: "high",
      expectedFiles: 2,
      repoReasoningHeavy: true,
    }),
    promptBytes: 4_744,
    plannedBudgetUsd: 0.16,
    remainingUsd: 1,
    stageMaxUsd: 1,
    modelContextTokens: 128_000,
  });
  assert.equal(policy.viableCalls, 6);
  assert.equal(policy.minimumViableTokens, 8_758);
  assert.equal(policy.providerContextRequired, 8_758);
  assert.equal(policy.desiredTrajectoryTokens, 31_368);
  assert.equal(policy.maxTokens, 30_000);
  assert.equal(policy.viable, true);
});

test("provider context checks use the largest single turn, not cumulative repeated prompt billing", () => {
  const policy = attemptLimitPolicy({
    ...base,
    fingerprint: fingerprint({
      scope: "multi-file",
      executionStrategy: "stable",
      localizationConfidence: "high",
      expectedFiles: 2,
      repoReasoningHeavy: true,
    }),
    promptBytes: 4_744,
    plannedBudgetUsd: 0.16,
    remainingUsd: 1,
    stageMaxUsd: 1,
    modelContextTokens: 9_000,
  });
  assert.equal(policy.providerContextRequired, 8_758);
  assert.ok(policy.desiredTrajectoryTokens > 30_000);
  assert.equal(policy.nonViableLimitKind, undefined);
  assert.equal(policy.viable, true);
});

test('progressive complex workers use configured session deadline while discovery remains bounded',()=>{
 const input={...base,configuredTimeoutMs:120_000,remainingMs:90_000,fingerprint:fingerprint({scope:'cross-component',expectedFiles:5,crossComponent:true,localizationConfidence:'low'})};
 assert.equal(attemptLimitPolicy(input).timeoutMs,90_000);
 assert.equal(attemptLimitPolicy({...input,boundedDiscovery:true}).timeoutMs,45_000);
 assert.equal(attemptLimitPolicy({...input,remainingMs:30_000}).timeoutMs,30_000);
});

test('native progressive admission separates dispatch minimum from trajectory forecast and retains hard budgets',()=>{
 const input={...base,promptBytes:32_000,remainingTokens:15_000,stageMaxTokens:15_000,remainingUsd:.15,plannedBudgetUsd:.15,stageMaxUsd:.15,
  promptPricePerMillion:2,completionPricePerMillion:10,fingerprint:fingerprint({scope:'multi-file',crossComponent:true,expectedFiles:5,localizationConfidence:'low'})};
 const conservative=attemptLimitPolicy(input);
 const progressive=attemptLimitPolicy({...input,progressiveCompaction:true});
 assert.equal(conservative.viable,false);
 assert.equal(progressive.viable,true);
 assert.ok(progressive.desiredTrajectoryTokens>progressive.maxTokens,'forecast remains conservative rather than pretending the full trajectory fits');
 assert.equal(progressive.maxTokens,15_000);assert.equal(progressive.budgetUsd,.15);
 assert.equal(attemptLimitPolicy({...input,progressiveCompaction:true,remainingUsd:.001}).nonViableLimitKind,'cost_limit');
});

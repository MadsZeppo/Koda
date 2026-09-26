import { test } from "node:test";
import assert from "node:assert/strict";

import { attemptLimitPolicy } from "../src/agent/attemptPolicy.js";
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
  const policy = attemptLimitPolicy({
    ...base,
    fingerprint: fingerprint(),
  });

  assert.equal(policy.localized, true);
  assert.equal(policy.directEdit, true);
  assert.equal(policy.viableCalls, 1);
  assert.equal(policy.viable, true);
  assert.equal(policy.nonViableLimitKind, undefined);
  assert.ok((policy.minimumViableCostUsd ?? Infinity) < base.remainingUsd);
});

test("localized STABLE keeps the existing multi-turn mini-SWE viability bound", () => {
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
    fingerprint: fingerprint({
      scope: "multi-file",
      expectedFiles: 2,
    }),
  });

  assert.equal(policy.directEdit, false);
  assert.ok(policy.viableCalls > 1);
});

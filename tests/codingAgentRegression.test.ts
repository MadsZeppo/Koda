import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AIDER_PROMPT_HEADROOM_TOKENS,
  AIDER_PROMPT_OVERHEAD_TOKENS,
  attemptLimitPolicy,
} from "../src/agent/attemptPolicy.js";
import {
  chooseExecutionStrategy,
  directWritePaths,
} from "../src/router/executionStrategy.js";
import type { TaskFingerprint } from "../src/router/taskFingerprint.js";
import type { RepoProfile } from "../src/types.js";

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

function profile(): RepoProfile {
  const files = [
    "src/planner/taskCompiler.ts",
    "tests/planner.test.ts",
    "src/agent/tools.ts",
    "src/config.ts",
    "src/openrouter/client.ts",
    "src/openrouter/usage.ts",
    "package.json",
  ];
  return {
    root: "/fixture",
    commit: "base",
    status: "",
    diff: "",
    files,
    topLevel: [],
    extensions: { ".ts": 6, ".json": 1 },
    symbols: [],
    packageManager: "pnpm",
    scripts: { test: "tsx --test tests/*.test.ts", typecheck: "tsc --noEmit" },
    configs: {},
    verificationCommands: ["pnpm run test", "pnpm run typecheck"],
  };
}

test("Aider reserves bounded framing headroom beyond the old exact-minimum 27,434-token budget", () => {
  const promptBytes = 76_968;
  const oldExactMinimum = Math.ceil(promptBytes / 4) + 4_096 + 4_096;
  assert.equal(oldExactMinimum, 27_434);

  const policy = attemptLimitPolicy({
    fingerprint: fingerprint(),
    effort: "normal",
    promptBytes,
    maxIterations: 12,
    maxOutputTokens: 4_096,
    remainingTokens: 60_000,
    stageMaxTokens: 60_000,
    plannedBudgetUsd: 1,
    remainingUsd: 1,
    stageMaxUsd: 1,
    promptPricePerMillion: 1,
    completionPricePerMillion: 1,
    remainingMs: 45_000,
    configuredTimeoutMs: 45_000,
    directEditEligible: false,
    aiderWorker: true,
    modelContextTokens: 128_000,
  });

  const estimatedPrompt = Math.ceil(promptBytes / 4);
  const expectedMinimum =
    estimatedPrompt +
    AIDER_PROMPT_OVERHEAD_TOKENS +
    AIDER_PROMPT_HEADROOM_TOKENS +
    4_096;

  assert.equal(policy.viableCalls, 1);
  assert.equal(policy.viable, true);
  assert.equal(policy.minimumViableTokens, expectedMinimum);
  assert.ok(policy.maxTokens >= expectedMinimum);
  assert.ok(policy.maxTokens > oldExactMinimum);
  assert.ok(
    policy.forecastProviderInputTokens >=
      estimatedPrompt + AIDER_PROMPT_OVERHEAD_TOKENS + AIDER_PROMPT_HEADROOM_TOKENS,
  );
});

test("an explicit source change plus deterministic tests remains one bounded DIRECT workstream", () => {
  const repository = profile();
  const task =
    "Add normalizeTaskLabel to src/planner/taskCompiler.ts and add deterministic tests in tests/planner.test.ts. Preserve existing behavior.";

  const strategy = chooseExecutionStrategy(task, repository);

  assert.equal(strategy.execution_strategy, "direct");
  assert.equal(strategy.preciseTarget, undefined);
  assert.ok(strategy.likelyFiles.includes("src/planner/taskCompiler.ts"));

  assert.deepEqual(
    directWritePaths(
      ["src/planner/taskCompiler.ts", "tests/planner.test.ts"],
      repository,
      task,
    ),
    ["src/planner/taskCompiler.ts", "tests/planner.test.ts"],
  );
});

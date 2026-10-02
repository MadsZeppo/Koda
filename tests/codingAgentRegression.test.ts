import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  AIDER_PROMPT_OVERHEAD_TOKENS,
  attemptLimitPolicy,
} from "../src/agent/attemptPolicy.js";
import { planCodingHandoff } from "../src/agent/handoffPlanner.js";
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

test("Aider reserves provider framing while treating the attempt as a multi-call coding session", () => {
  const promptBytes = 76_968;
  const policy = attemptLimitPolicy({
    fingerprint: fingerprint({ scope: "multi-file", expectedFiles: 2 }),
    effort: "normal",
    promptBytes,
    maxIterations: 12,
    maxOutputTokens: 4_096,
    remainingTokens: 120_000,
    stageMaxTokens: 30_000,
    plannedBudgetUsd: 1,
    remainingUsd: 1,
    stageMaxUsd: 1,
    promptPricePerMillion: 1,
    completionPricePerMillion: 1,
    remainingMs: 120_000,
    configuredTimeoutMs: 120_000,
    directEditEligible: false,
    aiderWorker: true,
    modelContextTokens: 128_000,
  });

  const estimatedPrompt = Math.ceil(promptBytes / 4);
  const expectedFirstTurn = estimatedPrompt + AIDER_PROMPT_OVERHEAD_TOKENS + 4_096;
  assert.equal(policy.viableCalls, 2);
  assert.equal(policy.viable, true);
  assert.equal(policy.minimumViableTokens, expectedFirstTurn);
  assert.equal(policy.providerContextRequired, expectedFirstTurn);
  assert.ok(policy.maxTokens > 30_000);
  assert.ok(policy.desiredTrajectoryTokens > policy.minimumViableTokens);
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

test("the normalizeTaskLabel smoke scope goes localization -> Aider and never AgenticCodingWorker", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-coding-regression-"));
  try {
    await mkdir(join(root, "src/planner"), { recursive: true });
    await mkdir(join(root, "tests"), { recursive: true });

    await writeFile(
      join(root, "src/planner/taskCompiler.ts"),
      "export const existing = 1;\n" + "x".repeat(12_000),
    );
    await writeFile(
      join(root, "tests/planner.test.ts"),
      "import { test } from 'node:test';\n" + "y".repeat(68_000),
    );

    const handoff = await planCodingHandoff({
      repoPath: root,
      task: "Add normalizeTaskLabel and deterministic tests.",
      writeScope: ["src/planner/taskCompiler.ts", "tests/planner.test.ts"],
      attemptTokenCapacity: 19_725,
      modelContextTokens: 128_000,
      maxOutputTokens: 4_096,
      costCapacityUsd: 1,
      promptPricePerMillion: 1,
      completionPricePerMillion: 4,
      directEditEligible: false,
    });

    assert.equal(handoff.mode, "aider");
    assert.deepEqual(handoff.aiderFiles?.editable, [
      "src/planner/taskCompiler.ts",
      "tests/planner.test.ts",
    ]);

    const policy = attemptLimitPolicy({
      fingerprint: fingerprint({
        scope: "multi-file",
        expectedFiles: 2,
        localizationConfidence: "high",
      }),
      effort: "normal",
      promptBytes: handoff.estimatedPromptBytes,
      maxIterations: 12,
      maxOutputTokens: 4_096,
      remainingTokens: 120_000,
      stageMaxTokens: 30_000,
      plannedBudgetUsd: 0.2,
      remainingUsd: 1,
      stageMaxUsd: 1,
      promptPricePerMillion: 1,
      completionPricePerMillion: 4,
      remainingMs: 120_000,
      configuredTimeoutMs: 120_000,
      aiderWorker: true,
      modelContextTokens: 128_000,
    });

    assert.equal(policy.viable, true);
    assert.ok(
      policy.maxTokens > 19_725,
      "the old smoke must not be killed by the historical 19,725-token agentic budget",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

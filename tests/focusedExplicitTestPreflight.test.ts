import test from "node:test";
import assert from "node:assert/strict";

import { focusedVerificationCheck } from "../src/verifier/selection.js";

test("explicit existing test target is a focused baseline even when source is trimmed from context", () => {
  const profile = {
    packageManager: "pnpm",
    scripts: {
      test: "tsx --test tests/*.test.ts",
    },
    files: [
      "src/planner/taskCompiler.ts",
      "tests/planner.test.ts",
    ],
    verificationCommands: ["pnpm run test"],
    ecosystem: {
      projectUnits: [],
    },
  } as any;

  const subtask = {
    id: "direct",
    title: "Add normalizeTaskLabel",
    objective: "Add normalizeTaskLabel and deterministic tests",
    dependsOn: [],
    likelyReadPaths: ["tests/planner.test.ts"],
    likelyWritePaths: [
      "src/planner/taskCompiler.ts",
      "tests/planner.test.ts",
    ],
    integrationContract: "Preserve existing public interfaces",
    verificationCommands: [],
    estimatedDifficulty: "normal",
    parallelSafe: false,
  } as any;

  // Reproduce the real smoke: the compact worker context retained the test,
  // but the source file was trimmed out by the context byte budget.
  const context = {
    files: [
      {
        path: "tests/planner.test.ts",
        snippet: "import { normalizeTaskLabel } from '../src/planner/taskCompiler.js';\n",
      },
    ],
    repoMap: ["tests/planner.test.ts"],
    localDependencies: [],
  } as any;

  assert.equal(
    focusedVerificationCheck(subtask, profile, context),
    "pnpm exec tsx --test 'tests/planner.test.ts'",
  );
});

test("a not-yet-created explicit test target is not executed as baseline", () => {
  const profile = {
    packageManager: "pnpm",
    scripts: {
      test: "tsx --test tests/*.test.ts",
    },
    files: ["src/planner/taskCompiler.ts"],
    verificationCommands: ["pnpm run test"],
    ecosystem: {
      projectUnits: [],
    },
  } as any;

  const subtask = {
    id: "direct",
    title: "Add helper and test",
    objective: "Add helper and a new deterministic test",
    dependsOn: [],
    likelyReadPaths: [],
    likelyWritePaths: [
      "src/planner/taskCompiler.ts",
      "tests/newPlanner.test.ts",
    ],
    integrationContract: "Preserve existing public interfaces",
    verificationCommands: [],
    estimatedDifficulty: "normal",
    parallelSafe: false,
  } as any;

  const context = {
    files: [],
    repoMap: [],
    localDependencies: [],
  } as any;

  assert.equal(focusedVerificationCheck(subtask, profile, context), undefined);
});

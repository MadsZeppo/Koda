import test from "node:test";
import assert from "node:assert/strict";

import { fastPathExploration } from "../src/agent/openHandsExplorer.js";

test("explicit source plus explicit test skips OpenHands and stays bounded", () => {
  const profile = {
    files: [
      "src/planner/taskCompiler.ts",
      "tests/planner.test.ts",
      "src/other.ts",
    ],
  } as any;

  const strategy = {
    execution_strategy: "direct",
    execution_effort: "normal",
    strategy_reason: "bounded direct workstream",
    likelyFiles: [
      "src/planner/taskCompiler.ts",
      "tests/planner.test.ts",
    ],
  } as any;

  const task =
    "Add a normalizeTaskLabel helper in src/planner/taskCompiler.ts and add deterministic tests in tests/planner.test.ts.";

  const result = fastPathExploration(task, profile, strategy);

  assert.ok(result);
  assert.equal(result.confidence, "high");
  assert.deepEqual(
    result.editableCandidates.map(({ path }) => path),
    ["src/planner/taskCompiler.ts", "tests/planner.test.ts"],
  );
  assert.deepEqual(result.relatedTests, []);
});

test("explicit test remains read-only when task does not request test mutation", () => {
  const profile = {
    files: [
      "src/planner/taskCompiler.ts",
      "tests/planner.test.ts",
    ],
  } as any;

  const strategy = {
    execution_strategy: "direct",
    execution_effort: "normal",
    strategy_reason: "bounded direct workstream",
    likelyFiles: [
      "src/planner/taskCompiler.ts",
      "tests/planner.test.ts",
    ],
  } as any;

  const task =
    "Fix src/planner/taskCompiler.ts. Use tests/planner.test.ts only to understand the expected behavior.";

  const result = fastPathExploration(task, profile, strategy);

  assert.ok(result);
  assert.deepEqual(
    result.editableCandidates.map(({ path }) => path),
    ["src/planner/taskCompiler.ts"],
  );
  assert.deepEqual(result.relatedTests, ["tests/planner.test.ts"]);
});

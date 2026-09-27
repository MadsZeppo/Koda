import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePlan } from "../src/orchestrator/coalesce.js";
import type { Plan, Subtask } from "../src/planner/schemas.js";
const task = (
  id: string,
  paths: string[],
  dependsOn: string[] = [],
): Subtask => ({
  id,
  title: `Fix ${id}`,
  objective: `Fix ${id}`,
  likelyReadPaths: paths,
  likelyWritePaths: paths,
  dependsOn,
  integrationContract: `Preserve ${id}`,
  verificationCommands: [`node --test ${id}.test.js`],
  estimatedDifficulty: "normal",
  parallelSafe: true,
});
const plan = (subtasks: Subtask[]): Plan => ({
  taskSummary: "fix",
  acceptanceCriteria: ["tests pass"],
  subtasks,
});
test("coalescing normalizes writes and preserves unioned checks and real dependencies", () => {
  const result = normalizePlan(
    plan([
      task("a", ["./calculator.js"]),
      task("b", ["calculator.js"]),
      task("c", ["report.js"], ["a", "b"]),
    ]),
  );
  assert.equal(result.before, 3);
  assert.equal(result.after, 2);
  assert.deepEqual(result.plan.subtasks[1]!.dependsOn, ["a"]);
  assert.equal(result.plan.subtasks[0]!.verificationCommands.length, 2);
  assert.match(result.plan.subtasks[0]!.objective, /Fix a\n\nFix b/);
  const dependent = normalizePlan(
    plan([task("a", ["calculator.js"]), task("b", ["calculator.js"], ["a"])]),
  );
  assert.equal(dependent.after, 2);
});
test("coalescing keeps independent writes separate and does not merge broad wildcard guesses", () => {
  for (const writes of [
    [["src/api/serializer.ts"], ["src/utils/slug.ts"]],
    [["."], ["."]],
    [["src/*"], ["src/*"]],
  ])
    assert.equal(
      normalizePlan(plan([task("a", writes[0]!), task("b", writes[1]!)])).after,
      2,
    );
});
test("coalescing keeps a shared verified invariant atomic only when the inspected graph connects it", () => {
  const store = {
    ...task("store", ["src/store.js"]),
    likelyReadPaths: ["src/store.js"],
    verificationCommands: ["node --test test/transfer.test.js"],
  };
  const transfer = {
    ...task("transfer", ["src/transfer.js"]),
    likelyReadPaths: ["src/transfer.js", "src/store.js"],
    verificationCommands: ["node --test test/transfer.test.js"],
  };
  assert.equal(normalizePlan(plan([store, transfer])).after, 1);
  assert.equal(
    normalizePlan(plan([
      { ...store, likelyReadPaths: ["src/store.js"] },
      { ...transfer, likelyReadPaths: ["src/transfer.js"] },
    ])).after,
    2,
  );
});
test("context-only DAG nodes are removed with dependency rewiring; real artifacts remain", () => {
  const inspect = {
    ...task("inspect", ["."]),
    title: "Inspect repository",
    objective: "Read source and identify tests",
  };
  const result = normalizePlan(
    plan([
      inspect,
      task("a", ["a.js"], ["inspect"]),
      task("b", ["b.js"], ["a"]),
    ]),
  );
  assert.deepEqual(result.removedContextTasks, ["inspect"]);
  assert.deepEqual(
    result.plan.subtasks.map((t) => t.dependsOn),
    [[], ["a"]],
  );
  const artifact = {
    ...inspect,
    likelyWritePaths: ["report.json"],
    reusableArtifact: "report.json",
  };
  assert.equal(
    normalizePlan(
      plan([
        artifact,
        task("a", ["a.js"], ["inspect"]),
        task("b", ["b.js"], ["inspect"]),
      ]),
    ).after,
    3,
  );
  assert.throws(() => normalizePlan(plan([inspect])), /only context/);
});

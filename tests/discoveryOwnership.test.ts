import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  reconcilePlannedPaths,
  validatePlanningCandidate,
} from "../src/planner/policy.js";
import { overlap } from "../src/orchestrator/dag.js";
import { profileRepo } from "../src/repo/profiler.js";
import { taskRelevantMutationPaths } from "../src/agent/mutationInvariant.js";

test("Stable production delegates localization and coding to mini-SWE", async () => {
  const run = await readFile(
    new URL("../src/run.ts", import.meta.url),
    "utf8",
  );

  assert.match(run, /from "\.\/agent\/miniSweExecutor\.js"/);
  assert.doesNotMatch(run, /prepareStableWorker\(/);
  assert.doesNotMatch(run, /buildRepairPacket\(/);

  const stableStart = run.indexOf(
    'if (strategy.execution_strategy === "stable") {',
  );
  const directStart = run.indexOf(
    '} else if (strategy.execution_strategy === "direct") {',
    stableStart,
  );

  assert.ok(stableStart >= 0);
  assert.ok(directStart > stableStart);

  const stable = run.slice(stableStart, directStart);

  assert.match(stable, /likelyWritePaths:\s*\["\."\]/);
  assert.match(stable, /parallelSafe:\s*false/);
  assert.match(stable, /stable_discovery_start/);
  assert.match(stable, /const actualChangedPaths =/);
  assert.match(stable, /likelyWritePaths:\s*actualChangedPaths/);
  assert.match(stable, /stable_discovery_scope_locked/);
  assert.match(
    stable,
    /changed tests without an explicit test-edit request/,
  );
});

test("directory ownership counts concrete implementation changes", () => {
  assert.deepEqual(
    taskRelevantMutationPaths(
      "Fix the API request handler",
      ["apps/api"],
      [
        { path: "apps/api/routes/orders.ts" },
        { path: "tests/orders.test.ts" },
      ],
    ),
    ["apps/api/routes/orders.ts"],
  );

  assert.deepEqual(
    taskRelevantMutationPaths(
      "Fix the API request handler",
      ["."],
      [{ path: "src/value.ts" }],
    ),
    ["src/value.ts"],
  );
});

test("planner accepts existing disjoint directory ownership roots", async () => {
  const parent = await mkdtemp(join(tmpdir(), "koda-dir-ownership-"));
  const repo = join(parent, "repo");

  try {
    await mkdir(join(repo, "apps/api/routes"), { recursive: true });
    await mkdir(join(repo, "apps/web/components"), { recursive: true });

    await writeFile(
      join(repo, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    await writeFile(
      join(repo, "apps/api/routes/orders.ts"),
      "export const orders = 1;\n",
    );
    await writeFile(
      join(repo, "apps/web/components/orders.ts"),
      "export const Orders = 1;\n",
    );

    const profile = await profileRepo(repo);

    const raw = validatePlanningCandidate({
      taskSummary: "Change independent API and web behavior",
      acceptanceCriteria: ["Both independent changes work"],
      subtasks: [
        {
          id: "api",
          title: "Fix API",
          objective: "Fix API behavior inside apps/api",
          dependsOn: [],
          likelyReadPaths: ["apps/api"],
          likelyWritePaths: ["apps/api"],
          integrationContract: "Preserve the API interface",
          verificationCommands: [],
          estimatedDifficulty: "normal",
          parallelSafe: true,
        },
        {
          id: "web",
          title: "Fix web",
          objective: "Fix web behavior inside apps/web",
          dependsOn: [],
          likelyReadPaths: ["apps/web"],
          likelyWritePaths: ["apps/web"],
          integrationContract: "Preserve the web interface",
          verificationCommands: [],
          estimatedDifficulty: "normal",
          parallelSafe: true,
        },
      ],
    });

    const plan = await reconcilePlannedPaths(
      raw,
      "Fix the API and web behavior independently",
      profile,
    );

    assert.deepEqual(
      plan.subtasks.map((subtask) => subtask.likelyWritePaths),
      [["apps/api"], ["apps/web"]],
    );

    assert.equal(overlap(plan.subtasks[0]!, plan.subtasks[1]!), false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("planner still rejects repository-wide ownership in planned work", () => {
  assert.throws(
    () =>
      validatePlanningCandidate({
        taskSummary: "Unsafe broad plan",
        acceptanceCriteria: ["Done"],
        subtasks: [
          {
            id: "broad",
            title: "Broad",
            objective: "Change everything",
            dependsOn: [],
            likelyReadPaths: ["."],
            likelyWritePaths: ["."],
            integrationContract: "Anything",
            verificationCommands: [],
            estimatedDifficulty: "normal",
            parallelSafe: true,
          },
        ],
      }),
    /write responsibility/,
  );
});

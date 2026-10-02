import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";

import {
  evidenceBasedCompletionRepairScope,
  implement,
} from "../src/agent/codingExecutor.js";
import type { CodingWorker } from "../src/agent/codingWorker.js";
import { Budget } from "../src/openrouter/usage.js";
import { Logger } from "../src/telemetry/logger.js";
import { config } from "../src/config.js";

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "koda-completion-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "tests"), { recursive: true });
  await writeFile(join(root, "src/outcome.cjs"), "module.exports = 1;\n");
  await writeFile(join(root, "src/wiring.cjs"), "module.exports = null;\n");
  await writeFile(
    join(root, "tests/outcome.test.cjs"),
    "const {test}=require('node:test');test('placeholder',()=>{});\n",
  );
  await writeFile(
    join(root, "tests/unrelated.test.cjs"),
    "const {test}=require('node:test');test('unrelated',()=>{});\n",
  );

  await execa("git", ["init", "-q"], { cwd: root });
  await execa("git", ["add", "."], { cwd: root });
  await execa(
    "git",
    [
      "-c",
      "user.name=Koda",
      "-c",
      "user.email=koda@localhost",
      "commit",
      "-qm",
      "baseline",
    ],
    { cwd: root },
  );

  return root;
}

test(
  "completion repair discovers the relevant repository test when initial likelyTests is empty",
  async (t) => {
    const root = await fixture(t);
    const repositoryPaths = [
      "src/outcome.cjs",
      "src/wiring.cjs",
      "tests/outcome.test.cjs",
      "tests/unrelated.test.cjs",
    ];

    const scope = await evidenceBasedCompletionRepairScope({
      root,
      task: "Create the outcome behavior and add a focused regression test",
      currentWriteScope: ["src/outcome.cjs", "src/wiring.cjs"],
      authorizedReadPaths: ["src/wiring.cjs"],
      repositoryPaths,
      reviewerDiagnostics:
        "The implementation exists but the focused regression test is missing.",
    });

    assert.deepEqual(scope, [
      "src/outcome.cjs",
      "src/wiring.cjs",
      "tests/outcome.test.cjs",
    ]);
    assert.equal(scope.includes("tests/unrelated.test.cjs"), false);
  },
);

test(
  "rejected completion review expands an empty test scope, continuation mutates the test, and review can pass",
  async (t) => {
    const root = await fixture(t);
    const cfg = await config(undefined, { maxIterations: 1, maxInputPrice: 1, maxOutputPrice: 1 });
    const logger = new Logger(join(root, ".koda"), "completion-scope-e2e", true);

    let workerCalls = 0;
    const codingWorker: CodingWorker = {
      engine: "agentic",
      async run(workerInput) {
        workerCalls++;

        if (workerCalls === 1) {
          assert.deepEqual(workerInput.writeScope, [
            "src/outcome.cjs",
            "src/wiring.cjs",
          ]);
          assert.equal(
            workerInput.writeScope.includes("tests/outcome.test.cjs"),
            false,
          );
          await writeFile(join(root, "src/outcome.cjs"), "module.exports = 3;\n");
          return {
            exitStatus: "completed",
            model: workerInput.model,
            engine: "agentic",
            engineVersion: "test",
            changedPaths: ["src/outcome.cjs"],
            wallClockMs: 1,
          };
        }

        assert.ok(
          workerInput.writeScope.includes("tests/outcome.test.cjs"),
          "completion repair must authorize the repository-backed focused test",
        );
        assert.equal(
          workerInput.writeScope.includes("tests/unrelated.test.cjs"),
          false,
          "scope expansion must not grant unrelated tests",
        );
        assert.equal(
          workerInput.context?.completionRepair?.mutationRequiredBeforeDiscovery,
          true,
        );
        assert.match(
          workerInput.context?.diagnostics ?? "",
          /unresolved requirements/i,
        );

        await writeFile(
          join(root, "src/wiring.cjs"),
          "module.exports = require('./outcome.cjs');\n",
        );
        await writeFile(
          join(root, "tests/outcome.test.cjs"),
          "const {test}=require('node:test');const a=require('node:assert/strict');test('wired outcome',()=>a.equal(require('../src/wiring.cjs'),3));\n",
        );

        return {
          exitStatus: "completed",
          model: workerInput.model,
          engine: "agentic",
          engineVersion: "test",
          changedPaths: [
            "src/outcome.cjs",
            "src/wiring.cjs",
            "tests/outcome.test.cjs",
          ],
          wallClockMs: 1,
        };
      },
    };

    let reviews = 0;
    const output = await implement(
      {
        config: cfg,
        logger,
        budget: new Budget(1, 100_000, 60_000),
      } as any,
      root,
      "Create outcome behavior. Wire it into telemetry. Add a focused regression test.",
      {
        id: "stable",
        title: "Outcome",
        objective: "Implement and wire outcome with a focused regression test",
        // Intentionally no test path here: this reproduces likelyTests: [].
        likelyReadPaths: ["src/wiring.cjs"],
        likelyWritePaths: ["src/outcome.cjs", "src/wiring.cjs"],
        dependsOn: [],
        integrationContract: "Wiring uses outcome and the focused test passes",
        verificationCommands: ["node --test tests/outcome.test.cjs"],
        estimatedDifficulty: "normal",
        parallelSafe: false,
      } as any,
      {
        acceptanceCriteria: [
          "Outcome behavior exists",
          "Wiring uses the outcome",
          "Focused regression test covers the behavior",
        ],
      },
      {
        files: [
          "src/outcome.cjs",
          "src/wiring.cjs",
          "tests/outcome.test.cjs",
          "tests/unrelated.test.cjs",
        ],
        verificationCommands: ["node --test tests/outcome.test.cjs"],
      } as any,
      {
        model: "foo/bar",
        codingWorker,
        completionReviewer: async (reviewInput) => {
          reviews++;
          const passed = reviews > 1;
          return {
            passed,
            requirements: reviewInput.requirements.map((requirement, index) => ({
              id: requirement.id,
              satisfied: passed || index === 0,
              evidence: passed
                ? "full diff plus focused regression test"
                : index === 0
                  ? "initial implementation exists"
                  : "wiring and focused regression test are still missing",
            })),
            summary: passed
              ? "completion repair finished the task"
              : "partial implementation; focused regression test is missing",
          };
        },
      },
    );

    assert.equal(workerCalls, 2);
    assert.equal(reviews, 2);
    assert.equal(output.verification.status, "VERIFIED_SUCCESS");

    const expansion = logger.events.find(
      (event) => event.type === "completion_repair_scope_expanded",
    );
    assert.ok(expansion, "repair scope expansion should be observable");
    assert.ok(
      (expansion?.added_paths as string[] | undefined)?.includes(
        "tests/outcome.test.cjs",
      ),
    );
    assert.equal(
      (expansion?.added_paths as string[] | undefined)?.includes(
        "tests/unrelated.test.cjs",
      ),
      false,
    );
    assert.ok(
      logger.events.some(
        (event) => event.type === "completion_review" && event.passed === true,
      ),
    );
  },
);

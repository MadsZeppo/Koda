import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { implement } from "../src/agent/loop.js";
import { git } from "../src/repo/commands.js";
import { profileRepo } from "../src/repo/profiler.js";
import { config } from "../src/config.js";
import { Gateway } from "../src/openrouter/client.js";
import { Budget } from "../src/openrouter/usage.js";
import { Logger } from "../src/telemetry/logger.js";
import type { EvidencePacket, Plan, Subtask } from "../src/planner/schemas.js";

for (const scenario of [
  "passing",
  "specific-failure",
  "trivial",
  "no-checks",
  "untracked-file",
  "generic-pass",
  "additive-pass",
] as const) {
  test(`verified no-op gate: ${scenario}`, async () => {
    const repo = await mkdtemp(join(tmpdir(), "koda-noop-gate-"));
    const output = await mkdtemp(join(tmpdir(), "koda-noop-log-"));
    try {
      await git(repo, "init");
      await git(repo, "config", "user.name", "Test");
      await git(repo, "config", "user.email", "test@localhost");
      await writeFile(join(repo, "value.cjs"), "module.exports = 42;\n");
      for (const [name, expected] of [
        ["smoke", 42],
        ["target", 43],
      ] as const)
        await writeFile(
          join(repo, `${name}.test.cjs`),
          `const {test}=require('node:test');const assert=require('node:assert/strict');test('${name}',()=>assert.equal(require('./value.cjs'),${expected}));\n`,
        );
      await git(repo, "add", ".");
      await git(repo, "commit", "-m", "verification fixture");
      const profile = await profileRepo(repo);
      profile.verificationCommands =
        scenario === "no-checks" ? [] : ["node --test smoke.test.cjs"];
      const subtask: Subtask = {
        id: "target",
        title: "Target",
        objective:
          scenario === "additive-pass"
            ? "Add a regression test for the target"
            : "Satisfy the target check",
        dependsOn: [],
        likelyReadPaths: ["value.cjs"],
        likelyWritePaths: ["value.cjs"],
        integrationContract: "Export the required value",
        verificationCommands:
          scenario === "passing" || scenario === "additive-pass"
            ? ["node --test smoke.test.cjs"]
            : scenario === "generic-pass"
              ? ["node --check value.cjs"]
              : scenario === "specific-failure"
                ? ["node --test target.test.cjs"]
                : scenario === "trivial"
                  ? ["true"]
                  : [],
        estimatedDifficulty: "normal",
        parallelSafe: true,
      };
      const plan: Plan = {
        taskSummary: subtask.objective,
        acceptanceCriteria: ["Target verification passes"],
        subtasks: [subtask],
      };
      const evidence: EvidencePacket = {
        relevantFiles: ["value.cjs"],
        symbols: [],
        reproduction: "",
        failingTests: [],
        likelyRootCause: "",
        dependencies: [],
        uncertainty: "low",
        suggestedApproach: "Inspect the value",
        evidence: [],
      };
      const logger = new Logger(output, "noop-test", true);
      const gateway = new Gateway(
        await config(undefined, { models: {}, maxIterations: 1 }),
        logger,
        new Budget(5, 100000, 60000),
      );
      let modelCalls = 0;
      gateway.call = async () => {
        modelCalls++;
        return { role: "assistant", content: "done", refusal: null };
      };
      // Even an empty untracked file must not be mistaken for a clean worktree.
      if (scenario === "untracked-file")
        await writeFile(join(repo, "new.txt"), "");
      const result = implement(
        gateway,
        repo,
        plan.taskSummary,
        subtask,
        plan,
        profile,
        { evidence },
      );
      if (
        scenario === "specific-failure" ||
        scenario === "untracked-file" ||
        scenario === "additive-pass"
      )
        await assert.rejects(result, /iteration budget exhausted/);
      else
        assert.equal(
          (await result).verification.status,
          ["trivial", "no-checks", "generic-pass"].includes(scenario)
            ? "NOT_FULLY_VERIFIED"
            : "VERIFIED_SUCCESS",
        );
      assert.equal(modelCalls, scenario === "passing" ? 0 : 1);
      assert.equal(
        logger.events.filter((e) => e.type === "no_changes_required").length,
        scenario === "passing" ? 1 : 0,
      );
      if (scenario === "specific-failure")
        assert.ok(
          logger.events
            .filter((e) => e.type === "verification")
            .every(
              (e) =>
                e.command === "node --test target.test.cjs" && e.exitCode !== 0,
            ),
        );
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(output, { recursive: true, force: true });
    }
  });
}

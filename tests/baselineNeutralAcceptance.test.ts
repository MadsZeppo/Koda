import test from "node:test";
import assert from "node:assert/strict";

import {
  verificationAgainstBaseline,
  verificationRegressions,
  verificationResult,
} from "../src/verifier/verifier.js";
import {
  completionReviewGate,
  completionReviewMessages,
} from "../src/agent/completionReview.js";
import type { CommandResult } from "../src/types.js";

const pass = (
  command: string,
  kind: "test" | "typecheck" = "typecheck",
): CommandResult => ({
  command,
  cwd: ".",
  kind,
  source: "task_or_targeted_check",
  requirement: "required",
  outcome: "CHECK_PASS",
  exitCode: 0,
  stdout: "ok",
  stderr: "",
  wallClockMs: 1,
  timedOut: false,
});

const existingPlannerFailure = (duration: string): CommandResult => ({
  command: "pnpm exec tsx --test 'tests/planner.test.ts'",
  cwd: ".",
  kind: "test",
  source: "task_or_targeted_check",
  requirement: "required",
  outcome: "CHECK_FAIL",
  exitCode: 1,
  stdout: [
    "not ok 1 - planned discovery is read-only and its evidence reaches the dependent coder",
    "  ---",
    "  error: assertion failed",
    "  actual: NOT_FULLY_VERIFIED",
    "  expected: VERIFIED_SUCCESS",
    "  operator: strictEqual",
    "  ...",
    "1..1",
    "# fail 1",
    `# duration_ms ${duration}`,
  ].join("\n"),
  stderr: "",
  wallClockMs: Number(duration),
  timedOut: false,
});

test("unchanged baseline test failure plus executable typecheck pass is verified success", () => {
  const baseline = verificationResult([
    existingPlannerFailure("14600"),
    pass("pnpm run typecheck"),
  ]);
  const candidate = verificationResult([
    existingPlannerFailure("14377"),
    pass("pnpm run typecheck"),
  ]);

  const relative = verificationAgainstBaseline(
    baseline,
    candidate,
    ["src/planner/taskCompiler.ts", "tests/planner.test.ts"],
  );

  assert.equal(relative.status, "VERIFIED_SUCCESS");
  assert.equal(verificationRegressions(baseline, candidate).length, 0);
  assert.match(
    relative.checks[0]!.source ?? "",
    /baseline_unchanged$/,
  );
  assert.equal(relative.checks[1]!.outcome, "CHECK_PASS");
});

test("new candidate failure remains failed even when another check passes", () => {
  const baseline = verificationResult([
    existingPlannerFailure("14600"),
    pass("pnpm run typecheck"),
  ]);
  const candidate = verificationResult([
    {
      ...existingPlannerFailure("14377"),
      stdout: existingPlannerFailure("14377").stdout +
        "\nnot ok 2 - normalizeTaskLabel new regression\n  ---\n  error: assertion failed\n  ...\n# fail 2",
    },
    pass("pnpm run typecheck"),
  ]);

  const relative = verificationAgainstBaseline(
    baseline,
    candidate,
    ["src/planner/taskCompiler.ts", "tests/planner.test.ts"],
  );

  assert.equal(relative.status, "FAILED");
  assert.ok(verificationRegressions(baseline, candidate).length > 0);
});

test("completion review receives baseline-known failures separately from blocking checks", () => {
  const baseline = verificationResult([
    existingPlannerFailure("14600"),
    pass("pnpm run typecheck"),
  ]);
  const candidate = verificationAgainstBaseline(
    baseline,
    verificationResult([
      existingPlannerFailure("14377"),
      pass("pnpm run typecheck"),
    ]),
    ["src/planner/taskCompiler.ts", "tests/planner.test.ts"],
  );

  const messages = completionReviewMessages({
    task: "Add normalizeTaskLabel and deterministic tests",
    requirements: [{ id: "R1", text: "Add normalizeTaskLabel and tests" }],
    diff: "diff --git a/src/planner/taskCompiler.ts b/src/planner/taskCompiler.ts",
    changedPaths: ["src/planner/taskCompiler.ts", "tests/planner.test.ts"],
    changedSymbols: ["normalizeTaskLabel"],
    workerExitStatus: "completed",
    verification: candidate,
  });

  const payload = JSON.parse(messages[1]!.content);
  assert.equal(payload.verification.status, "VERIFIED_SUCCESS");
  assert.equal(payload.verification.baselineKnownFailures.length, 1);
  assert.equal(
    payload.verification.baselineKnownFailures[0].attribution,
    "BASELINE_FAILURE_UNCHANGED",
  );
  assert.deepEqual(
    payload.verification.checks.map((check: { command: string }) => check.command),
    ["pnpm run typecheck"],
  );
});

test("completion gate promotes baseline-relative success when no requirement remains unresolved", () => {
  assert.equal(
    completionReviewGate("CANDIDATE_NEUTRAL", []).status,
    "VERIFIED_SUCCESS",
  );
  assert.equal(
    completionReviewGate("CANDIDATE_IMPROVEMENT", []).status,
    "VERIFIED_SUCCESS",
  );
});

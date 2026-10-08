import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { config } from "../src/config.js";
import { Budget } from "../src/openrouter/usage.js";
import { Gateway } from "../src/openrouter/client.js";
import { Logger } from "../src/telemetry/logger.js";
import { profileRepo } from "../src/repo/profiler.js";
import {
  OpenHandsExplorer,
  OpenHandsOperationalError,
  deterministicRepositoryExploration,
  fastPathExploration,
  strategyWithExploration,
  type OpenHandsInvocation,
  type OpenHandsReport,
  type RepositoryExploration,
} from "../src/agent/openHandsExplorer.js";
import { chooseExecutionStrategy } from "../src/router/executionStrategy.js";
import {
  completionReviewGate,
  parseCompletionReview,
} from "../src/agent/completionReview.js";
import { planCodingHandoff } from "../src/agent/handoffPlanner.js";
import {
  verificationAgainstBaseline,
  verificationResult,
} from "../src/verifier/verifier.js";
import type { CommandResult } from "../src/types.js";

async function fixture(t: any) {
  const base = await mkdtemp(join(tmpdir(), "koda-offline20-"));
  const root = join(base, "repo");
  await mkdir(join(root, "src/planner"), { recursive: true });
  await mkdir(join(root, "src/agent"), { recursive: true });
  await mkdir(join(root, "tests"), { recursive: true });
  await writeFile(join(root, "src/planner/taskCompiler.ts"), [
    "export function compileTaskSummary(value: string) {",
    "  return value.trim();",
    "}",
    "export const plannerTaskSummary = compileTaskSummary;",
    "",
  ].join("\n"));
  await writeFile(join(root, "src/agent/other.ts"), "export const unrelatedAgentValue = 1;\n");
  await writeFile(join(root, "tests/planner.test.ts"), [
    "import { compileTaskSummary } from '../src/planner/taskCompiler.js';",
    "void compileTaskSummary;",
    "",
  ].join("\n"));
  await writeFile(join(root, "package.json"), JSON.stringify({
    scripts: { typecheck: "echo typecheck-pass" },
  }));
  t.after(() => rm(base, { recursive: true, force: true }));

  const settings = await config(undefined, {
    models: { SCOUT_MODEL: "mock/explorer" },
    budgetUsd: 1,
    maxTokens: 60_000,
    stageMaxTokens: 20_000,
    stageMaxUsd: .5,
    stageMaxMinutes: 2,
    baseUrl: "http://127.0.0.1:1/v1",
    routing: { stateDirectory: join(base, "routing") },
  });
  const logger = new Logger(join(base, "logs"), "offline20", true);
  const gateway = new Gateway(settings, logger, new Budget(1, 60_000, 120_000));
  return { base, root, profile: await profileRepo(root), gateway, logger };
}

const exploration = (overrides: Partial<RepositoryExploration> = {}): RepositoryExploration => ({
  confidence: "high",
  editableCandidates: [{
    path: "src/planner/taskCompiler.ts",
    reason: "Task summary compilation is implemented here",
  }],
  readonlyFiles: [],
  relatedTests: ["tests/planner.test.ts"],
  dependencies: [],
  evidence: [{
    path: "src/planner/taskCompiler.ts",
    detail: "compileTaskSummary is declared here",
  }],
  unresolvedQuestions: [],
  ...overrides,
});

const report = (result = exploration()): OpenHandsReport => ({
  status: "completed",
  sdkVersion: "offline",
  providerDispatched: false,
  result,
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  modelCalls: 0,
  toolCalls: 0,
  filesInspected: ["src/planner/taskCompiler.ts", "tests/planner.test.ts"],
  wallClockMs: 1,
});

const check = (
  command: string,
  exitCode: number,
  stdout: string,
  source = "offline",
): CommandResult => ({
  command,
  cwd: ".",
  exitCode,
  stdout,
  stderr: "",
  wallClockMs: 1,
  timedOut: false,
  outcome: exitCode === 0 ? "CHECK_PASS" : "CHECK_FAIL",
  kind: command.includes("typecheck") ? "typecheck" : "test",
  requirement: "required",
  source,
});

test("01 explicit existing source path uses zero-call fast path", async (t) => {
  const f = await fixture(t);
  const task = "Change src/planner/taskCompiler.ts without unrelated edits.";
  const result = fastPathExploration(task, f.profile, chooseExecutionStrategy(task, f.profile));
  assert.deepEqual(result?.editableCandidates.map((item) => item.path), ["src/planner/taskCompiler.ts"]);
});

test("02 explicit missing file is allowed only because user named it", async (t) => {
  const f = await fixture(t);
  const task = "Create src/planner/newHelper.ts and make no unrelated changes.";
  const result = fastPathExploration(task, f.profile, chooseExecutionStrategy(task, f.profile));
  assert.deepEqual(result?.editableCandidates.map((item) => item.path), ["src/planner/newHelper.ts"]);
});

test("03 explicit source plus requested test mutation keeps both writable", async (t) => {
  const f = await fixture(t);
  const task = "Update src/planner/taskCompiler.ts and add tests in tests/planner.test.ts.";
  const result = fastPathExploration(task, f.profile, chooseExecutionStrategy(task, f.profile));
  assert.deepEqual(result?.editableCandidates.map((item) => item.path).sort(), [
    "src/planner/taskCompiler.ts",
    "tests/planner.test.ts",
  ].sort());
});

test("04 deterministic fallback localizes task summary work without a model", async (t) => {
  const f = await fixture(t);
  const result = await deterministicRepositoryExploration(
    f.root,
    "Find where task summaries are compiled or normalized before planning and add whitespace normalization.",
    f.profile,
  );
  assert.ok(result.editableCandidates.some((item) => item.path === "src/planner/taskCompiler.ts"));
});

test("05 deterministic fallback never returns repository root as write scope", async (t) => {
  const f = await fixture(t);
  const result = await deterministicRepositoryExploration(f.root, "normalize task summaries", f.profile);
  assert.equal(result.editableCandidates.some((item) => item.path === "."), false);
});

test("06 deterministic fallback never invents a missing file", async (t) => {
  const f = await fixture(t);
  const result = await deterministicRepositoryExploration(f.root, "add imaginary frobnicator module", f.profile);
  assert.ok(result.editableCandidates.every((item) => f.profile.files.includes(item.path)));
});

test("07 low-confidence OpenHands cannot authorize speculative missing files", async (t) => {
  const f = await fixture(t);
  const result = await new OpenHandsExplorer(f.gateway, {
    runner: async () => report(exploration({
      confidence: "low",
      editableCandidates: [
        { path: "src/planner/madeUp.ts", reason: "maybe useful" },
        { path: "src/planner/taskCompiler.ts", reason: "existing implementation" },
      ],
      evidence: [{ path: "src/planner/taskCompiler.ts", detail: "existing implementation" }],
    })),
  }).explore({ repoPath: f.root, task: "Normalize task summaries", profile: f.profile });
  assert.deepEqual(result.editableCandidates.map((item) => item.path), ["src/planner/taskCompiler.ts"]);
});

test("08 high-confidence OpenHands may authorize a missing implementation file", async (t) => {
  const f = await fixture(t);
  const result = await new OpenHandsExplorer(f.gateway, {
    runner: async () => report(exploration({
      confidence: "high",
      editableCandidates: [{ path: "src/planner/newHelper.ts", reason: "new helper is required" }],
      relatedTests: [],
      evidence: [{ path: "src/planner/newHelper.ts", detail: "new helper design" }],
    })),
  }).explore({ repoPath: f.root, task: "Create a dedicated planner helper module", profile: f.profile });
  assert.deepEqual(result.editableCandidates.map((item) => item.path), ["src/planner/newHelper.ts"]);
});

test("09 related tests remain read-only when test mutation is not requested", async (t) => {
  const f = await fixture(t);
  const route = strategyWithExploration("Fix task summary normalization", chooseExecutionStrategy("Fix task summary normalization", f.profile), exploration());
  assert.ok(route.likelyFiles.includes("tests/planner.test.ts"));
});

test("10 generic test requests retain related tests as readonly context", async (t) => {
  const f = await fixture(t);
  const evidence = exploration();
  strategyWithExploration("Fix task summary normalization and add deterministic tests", chooseExecutionStrategy("Fix task summary normalization and add deterministic tests", f.profile), evidence);
  assert.equal(evidence.editableCandidates.some((item) => item.path === "tests/planner.test.ts"), false);
  assert.ok(evidence.relatedTests.includes("tests/planner.test.ts"));
});

test("11 OpenHands exploration is bounded so coding and review retain the run budget", async (t) => {
  const f = await fixture(t);
  let invocation: OpenHandsInvocation | undefined;
  await new OpenHandsExplorer(f.gateway, {
    runner: async (value) => { invocation = value; return report(); },
  }).explore({ repoPath: f.root, task: "Locate task summary normalization", profile: f.profile });
  assert.equal(invocation?.maxIterations, 6);
  assert.equal(invocation?.maxFilesRead, 16);
});

test("12 OpenHands total timeout is bounded below the coding critical path", async (t) => {
  const f = await fixture(t);
  let invocation: OpenHandsInvocation | undefined;
  await new OpenHandsExplorer(f.gateway, {
    runner: async (value) => { invocation = value; return report(); },
  }).explore({ repoPath: f.root, task: "Locate task summary normalization", profile: f.profile });
  assert.ok((invocation?.timeoutMs ?? 0) <= 45_000);
  assert.ok((invocation?.timeoutMs ?? 0) >= 30_000);
});

test("13 injected OpenHands operational failure stays operational and never fabricates root scope", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    new OpenHandsExplorer(f.gateway, {
      runner: async () => { throw new OpenHandsOperationalError("offline timeout"); },
    }).explore({ repoPath: f.root, task: "Locate implementation", profile: f.profile }),
    /offline timeout/,
  );
});

test("14 OpenHands read-only guard restores attempted mutations", async (t) => {
  const f = await fixture(t);
  const original = await readFile(join(f.root, "src/planner/taskCompiler.ts"), "utf8");
  await assert.rejects(
    new OpenHandsExplorer(f.gateway, {
      runner: async () => {
        await writeFile(join(f.root, "src/planner/taskCompiler.ts"), "mutated\n");
        return report();
      },
    }).explore({ repoPath: f.root, task: "Inspect task summaries", profile: f.profile }),
    /read-only violation/i,
  );
  assert.equal(await readFile(join(f.root, "src/planner/taskCompiler.ts"), "utf8"), original);
});

test("15 completed OpenHands with empty scope falls back to bounded local localization", async (t) => {
  const f = await fixture(t);
  const result = await new OpenHandsExplorer(f.gateway, {
    runner: async () => ({
      ...report(exploration({
        confidence: "low",
        editableCandidates: [],
        readonlyFiles: [],
        relatedTests: [],
        evidence: [],
        unresolvedQuestions: ["could not establish write scope"],
      })),
      filesInspected: ["src/planner/taskCompiler.ts", "src/agent/other.ts"],
    }),
  }).explore({
    repoPath: f.root,
    task: "Find where task summaries are compiled or normalized before planning.",
    profile: f.profile,
  });
  assert.ok(result.editableCandidates.some((item) => item.path === "src/planner/taskCompiler.ts"));
  assert.equal(result.editableCandidates.some((item) => item.path === "."), false);
});

test("16 completion review accepts fenced JSON", () => {
  const review = parseCompletionReview(
    "```json\n{\"passed\":true,\"requirements\":[{\"id\":\"R1\",\"satisfied\":true,\"evidence\":\"diff\"}],\"summary\":\"ok\"}\n```",
    [{ id: "R1", text: "Implement" }],
  );
  assert.equal(review.passed, true);
});

test("17 completion review accepts requirement-labelled prose", () => {
  const review = parseCompletionReview(
    "R1: satisfied - diff proves it\nR2: satisfied - focused test proves it\nOverall: passed",
    [{ id: "R1", text: "Implement" }, { id: "R2", text: "Test" }],
  );
  assert.equal(review.passed, true);
});

test("18 unstructured completion review becomes unresolved instead of throwing", () => {
  const review = parseCompletionReview("Looks fine.", [{ id: "R1", text: "Implement" }]);
  assert.equal(review.passed, false);
  assert.equal(review.requirements[0]?.satisfied, false);
});

test("19 unchanged baseline failure plus executable pass is accepted", () => {
  const baseline = verificationResult([
    check("pnpm test", 1, "not ok 1 - old repository failure"),
    check("pnpm run typecheck", 0, "typecheck ok"),
  ]);
  const candidate = verificationResult([
    check("pnpm test", 1, "not ok 1 - old repository failure"),
    check("pnpm run typecheck", 0, "typecheck ok"),
  ]);
  const relative = verificationAgainstBaseline(baseline, candidate, ["src/planner/taskCompiler.ts"]);
  assert.equal(relative.status, "VERIFIED_SUCCESS");
});

test("20 newly introduced verification failure is rejected", () => {
  const baseline = verificationResult([
    check("pnpm test", 0, "ok 1 - baseline"),
    check("pnpm run typecheck", 0, "typecheck ok"),
  ]);
  const candidate = verificationResult([
    check("pnpm test", 1, "not ok 1 - new regression"),
    check("pnpm run typecheck", 0, "typecheck ok"),
  ]);
  const relative = verificationAgainstBaseline(baseline, candidate, ["src/planner/taskCompiler.ts"]);
  assert.equal(relative.status, "FAILED");
});

test("21 bounded localized source plus test scope hands off to Aider, not agentic discovery", async (t) => {
  const f = await fixture(t);
  const handoff = await planCodingHandoff({
    repoPath: f.root,
    task: "Normalize task summary whitespace and add deterministic tests.",
    writeScope: ["src/planner/taskCompiler.ts", "tests/planner.test.ts"],
    attemptTokenCapacity: 30_000,
    modelContextTokens: 128_000,
    maxOutputTokens: 4_096,
    costCapacityUsd: 1,
    promptPricePerMillion: 1,
    completionPricePerMillion: 4,
    directEditEligible: false,
  });
  assert.equal(handoff.mode, "aider");
  assert.deepEqual(handoff.aiderFiles?.editable.sort(), [
    "src/planner/taskCompiler.ts",
    "tests/planner.test.ts",
  ].sort());
  assert.equal(completionReviewGate("VERIFIED_SUCCESS", []).status, "VERIFIED_SUCCESS");
});

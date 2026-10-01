import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { config } from "../src/config.js";
import { Budget } from "../src/openrouter/usage.js";
import { Gateway } from "../src/openrouter/client.js";
import { Logger } from "../src/telemetry/logger.js";
import { profileRepo } from "../src/repo/profiler.js";
import {
  OpenHandsExplorer,
  OpenHandsOperationalError,
  fastPathExploration,
  strategyWithExploration,
  type OpenHandsInvocation,
  type OpenHandsReport,
  type RepositoryExploration,
} from "../src/agent/openHandsExplorer.js";
import { chooseExecutionStrategy } from "../src/router/executionStrategy.js";
import { selectAiderFiles } from "../src/agent/aiderExecutor.js";
import { inferRepositoryDependencies } from "../src/orchestrator/dag.js";
import { schedule } from "../src/orchestrator/scheduler.js";
import type { Plan, Subtask } from "../src/planner/schemas.js";

async function fixture(t: any) {
  const base = await mkdtemp(join(tmpdir(), "koda-openhands-test-"));
  const root = join(base, "repo");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "tests"));
  await writeFile(join(root, "src/budget.ts"), "export const attemptBudget = 8192;\n");
  await writeFile(join(root, "src/router.ts"), "import { attemptBudget } from './budget.js';\nexport const route = attemptBudget;\n");
  await writeFile(join(root, "src/other.ts"), "export const unrelated = true;\n");
  await writeFile(join(root, "tests/budget.test.ts"), "import { attemptBudget } from '../src/budget.js';\n");
  t.after(() => rm(base, { recursive: true, force: true }));
  const settings = await config(undefined, {
    models: { SCOUT_MODEL: "mock/explorer" },
    budgetUsd: 1,
    maxTokens: 50_000,
    stageMaxTokens: 20_000,
    stageMaxUsd: .5,
    stageMaxMinutes: 1,
    baseUrl: "http://127.0.0.1:1/v1",
  });
  const logger = new Logger(join(base, "logs"), "openhands-test", true);
  const gateway = new Gateway(settings, logger, new Budget(1, 50_000, 60_000));
  return { root, profile: await profileRepo(root), gateway, logger };
}

const exploration = (overrides: Partial<RepositoryExploration> = {}): RepositoryExploration => ({
  confidence: "high",
  editableCandidates: [{ path: "src/budget.ts", reason: "defines the attempt budget" }],
  readonlyFiles: [{ path: "src/router.ts", reason: "consumes the budget" }],
  relatedTests: ["tests/budget.test.ts"],
  dependencies: [{ from: "src/router.ts", to: "src/budget.ts", kind: "import" }],
  evidence: [{ path: "src/budget.ts", detail: "attemptBudget is defined here" }],
  unresolvedQuestions: [],
  ...overrides,
});

const report = (result = exploration()): OpenHandsReport => ({
  status: "completed",
  sdkVersion: "1.50.0",
  providerDispatched: true,
  result,
  inputTokens: 300,
  outputTokens: 80,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  costUsd: .001,
  modelCalls: 3,
  toolCalls: 7,
  filesInspected: ["src/budget.ts", "src/router.ts", "tests/budget.test.ts"],
  wallClockMs: 25,
});

test("exact existing path uses the conservative zero-call fast path", async (t) => {
  const f = await fixture(t);
  const task = "Change src/budget.ts to use a larger constant.";
  const route = chooseExecutionStrategy(task, f.profile);
  const result = fastPathExploration(task, f.profile, route);
  assert.deepEqual(result?.editableCandidates.map(({ path }) => path), ["src/budget.ts"]);
  assert.deepEqual(result?.readonlyFiles, []);
});

test("exact missing file path uses the zero-call fast path and remains exact scope", async (t) => {
  const f = await fixture(t);
  const path = "tests/newFocusedSelection.test.ts";
  const task = `Create a new test file named ${path}. Make no unrelated changes.`;
  const route = chooseExecutionStrategy(task, f.profile);
  const result = fastPathExploration(task, f.profile, route);
  assert.equal(route.preciseTarget, path);
  assert.deepEqual(result?.editableCandidates.map(({ path }) => path), [path]);
  assert.equal(result?.confidence, "high");
});

test("no-path behavior task uses OpenHands and forwards implementation evidence to Aider", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const result = await new OpenHandsExplorer(f.gateway, { runner: async () => { calls++; return report(); } }).explore({
    repoPath: f.root,
    task: "Fix coding attempts that exhaust their budget before provider dispatch.",
    profile: f.profile,
  });
  const selected = selectAiderFiles({
    repoPath: f.root, attemptId: "test", task: "fix", model: "mock/model",
    budgetUsd: .1, maxTokens: 10_000, maxSteps: 1, timeoutMs: 1,
    requestTimeoutMs: 1, commandTimeoutMs: 1, maxOutputTokens: 1,
    baseUrl: "http://localhost", writeScope: result.editableCandidates.map(({ path }) => path),
    context: {
      relevantFiles: [...result.editableCandidates, ...result.readonlyFiles].map(({ path }) => path),
      completePaths: result.editableCandidates.map(({ path }) => path),
      evidence: { relevantFiles: result.editableCandidates.map(({ path }) => path) },
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(selected.editable, ["src/budget.ts"]);
  assert.deepEqual(selected.readOnly, ["src/router.ts"]);
});

test("OpenHands evidence overrides a wrong cheap initial hint", async (t) => {
  const f = await fixture(t);
  const route = strategyWithExploration("Fix provider budget exhaustion", {
    execution_strategy: "direct", execution_effort: "normal",
    strategy_reason: "cheap hint", likelyFiles: ["src/other.ts"], preciseTarget: "src/other.ts",
  }, exploration());
  assert.equal(route.preciseTarget, "src/budget.ts");
  assert.equal(route.likelyFiles.includes("src/other.ts"), false);
});

test("multiple implementation candidates remain in the authorized scope", async (t) => {
  const f = await fixture(t);
  const result = await new OpenHandsExplorer(f.gateway, { runner: async () => report(exploration({
    editableCandidates: [
      { path: "src/budget.ts", reason: "defines budget" },
      { path: "src/router.ts", reason: "applies budget" },
    ],
    readonlyFiles: [],
  })) }).explore({ repoPath: f.root, task: "Update budget routing", profile: f.profile });
  assert.deepEqual(result.editableCandidates.map(({ path }) => path), ["src/budget.ts", "src/router.ts"]);
});

test("OpenHands may authorize a safe missing path as a new editable file", async (t) => {
  const f = await fixture(t);
  const result = await new OpenHandsExplorer(f.gateway, {
    runner: async () => report(exploration({
      editableCandidates: [{
        path: "src/executionOutcome.ts",
        reason: "A new reusable module is the smallest design",
      }],
      readonlyFiles: [{ path: "src/router.ts", reason: "integration context" }],
      dependencies: [{
        from: "src/router.ts",
        to: "src/executionOutcome.ts",
        kind: "will import",
      }],
      evidence: [{
        path: "src/executionOutcome.ts",
        detail: "authorized new module",
      }],
    })),
  }).explore({ repoPath: f.root, task: "Create a reusable execution outcome module", profile: f.profile });

  assert.deepEqual(result.editableCandidates.map(({ path }) => path), [
    "src/executionOutcome.ts",
  ]);
});

test("missing read-only and evidence paths remain invalid", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    new OpenHandsExplorer(f.gateway, {
      runner: async () => report(exploration({
        readonlyFiles: [{ path: "src/missing.ts", reason: "not inspected" }],
      })),
    }).explore({ repoPath: f.root, task: "Inspect budgeting", profile: f.profile }),
    /unknown repository path/,
  );
});

test("readonly dependencies and tests never become editable", async (t) => {
  const f = await fixture(t);
  const result = await new OpenHandsExplorer(f.gateway, { runner: async () => report() }).explore({
    repoPath: f.root, task: "Fix attempt budgeting", profile: f.profile,
  });
  assert.deepEqual(result.readonlyFiles.map(({ path }) => path), ["src/router.ts"]);
  assert.deepEqual(result.relatedTests, ["tests/budget.test.ts"]);
  assert.equal(result.editableCandidates.some(({ path }) => path === "src/router.ts"), false);
});

test("invalid and escaping OpenHands paths are rejected", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    new OpenHandsExplorer(f.gateway, { runner: async () => report(exploration({
      editableCandidates: [{ path: "../outside.ts", reason: "invalid" }],
    })) }).explore({ repoPath: f.root, task: "Fix budget", profile: f.profile }),
    OpenHandsOperationalError,
  );
});

test("OpenHands operational failure is classified without coding-model quality evidence", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    new OpenHandsExplorer(f.gateway, { runner: async () => ({
      ...report(), status: "infra_failure", result: undefined, providerDispatched: false,
      error: "SDK unavailable",
    }) }).explore({ repoPath: f.root, task: "Fix budget", profile: f.profile }),
    /SDK unavailable/,
  );
  assert.equal(f.logger.events.some((event) => event.type === "model_attempt"), false);
  assert.equal(f.logger.events.findLast((event) => event.type === "repo_exploration_failure")?.operational, true);
});

const subtask = (id: string, writes: string[], reads: string[] = []): Subtask => ({
  id, title: id, objective: id, dependsOn: [], likelyReadPaths: reads,
  likelyWritePaths: writes, integrationContract: id, verificationCommands: [],
  estimatedDifficulty: "normal", parallelSafe: true,
});

test("large exploration evidence can build dependency-aware work units", () => {
  const provider = { ...subtask("budget", ["src/budget.ts"]), provides: ["AttemptBudget"] };
  const consumer = { ...subtask("router", ["src/router.ts"], ["src/budget.ts"]), consumes: ["AttemptBudget"] };
  const plan: Plan = { taskSummary: "budget and router", acceptanceCriteria: ["works"], subtasks: [provider, consumer] };
  const inferred = inferRepositoryDependencies(plan, exploration().dependencies);
  assert.deepEqual(consumer.dependsOn, ["budget"]);
  assert.equal(inferred.length, 1);
});

test("independent evidence-backed work remains parallel", async () => {
  const plan = [subtask("budget", ["src/budget.ts"]), subtask("other", ["src/other.ts"])];
  let active = 0, peak = 0;
  const result = await schedule(plan, 2, async () => {
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
  });
  assert.equal(peak, 2);
  assert.equal(result.peak, 2);
});

test("producer and consumer evidence preserves dependency order", async () => {
  const provider = subtask("budget", ["src/budget.ts"]);
  const consumer = { ...subtask("router", ["src/router.ts"]), dependsOn: ["budget"] };
  const order: string[] = [];
  await schedule([provider, consumer], 2, async (item) => { order.push(item.id); });
  assert.deepEqual(order, ["budget", "router"]);
});

test("scope expansion uses a bounded OpenHands continuation with prior evidence", async (t) => {
  const f = await fixture(t);
  let invocation: OpenHandsInvocation | undefined;
  const previous = exploration({ confidence: "medium" });
  await new OpenHandsExplorer(f.gateway, { runner: async (value) => { invocation = value; return report(); } }).explore({
    repoPath: f.root, task: "Investigate the requested additional write path", profile: f.profile,
    previousExploration: previous, continuationReason: "scope_expansion_required: src/router.ts",
  });
  assert.deepEqual(invocation?.previousExploration, previous);
  assert.match(invocation?.continuationReason ?? "", /scope_expansion_required/);
  assert.ok((invocation?.maxTokens ?? Infinity) <= 12_000);
  assert.ok((invocation?.maxTokens ?? Infinity) <= f.gateway.config.stageMaxTokens);
  assert.ok((invocation?.maxInputTokens ?? Infinity) +
    (invocation?.maxOutputTokens ?? Infinity) <= f.gateway.config.maxTokens);
});

test("verification diagnostics can drive an evidence-preserving continuation", async (t) => {
  const f = await fixture(t);
  let invocation: OpenHandsInvocation | undefined;
  await new OpenHandsExplorer(f.gateway, { runner: async (value) => { invocation = value; return report(); } }).explore({
    repoPath: f.root, task: "Resolve the failed focused verification", profile: f.profile,
    previousExploration: exploration(), continuationReason: "Type error references src/router.ts:1",
  });
  assert.match(invocation?.continuationReason ?? "", /src\/router\.ts/);
  assert.equal(invocation?.previousExploration?.editableCandidates[0]?.path, "src/budget.ts");
});

test("read-only guard restores the repository if a runner attempts mutation", async (t) => {
  const f = await fixture(t);
  const original = await readFile(join(f.root, "src/budget.ts"), "utf8");
  await assert.rejects(
    new OpenHandsExplorer(f.gateway, { runner: async () => {
      await writeFile(join(f.root, "src/budget.ts"), "mutated\n");
      return report();
    } }).explore({ repoPath: f.root, task: "Inspect budget", profile: f.profile }),
    /read-only violation/i,
  );
  assert.equal(await readFile(join(f.root, "src/budget.ts"), "utf8"), original);
});

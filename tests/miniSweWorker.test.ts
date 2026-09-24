import { test } from "node:test";
import assert from "node:assert/strict";
import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { MiniSweWorker, redactOpenRouterSecret, sanitizeOpenRouterApiKey, type MiniSweBridgeRunner } from "../src/agent/miniSweWorker.js";
import { MINI_SWE_VERSION } from "../src/agent/miniSweRuntime.js";
import { Budget } from "../src/openrouter/usage.js";
import { Logger } from "../src/telemetry/logger.js";
import { implement } from "../src/agent/miniSweExecutor.js";
import { config } from "../src/config.js";
import { modelSchema } from "../src/router/pool.js";
import { WriteScope } from "../src/repo/writeScope.js";
import { attemptLimitPolicy } from "../src/agent/attemptPolicy.js";

const result = (model: string, extra: Record<string, unknown> = {}) => ({
  exitStatus: "completed" as const, model, engine: "mini-swe-agent" as const,
  engineVersion: MINI_SWE_VERSION, costUsd: 0.002, inputTokens: 20,
  outputTokens: 10, wallClockMs: 5, changedPaths: [],
  terminationReason: "Submitted", ...extra,
});
const input = (repoPath: string, model = "vendor/coder") => ({
  repoPath, attemptId: "test-attempt", task: "Update both scoped files", model, budgetUsd: 0.02,
  maxTokens: 1000, maxSteps: 4, timeoutMs: 10_000, requestTimeoutMs: 30_000,
  commandTimeoutMs: 2_000,
  maxOutputTokens: 500, baseUrl: "https://openrouter.ai/api/v1",
  sessionId: "run/test-attempt/vendor-coder",
  writeScope: ["src/a.ts", "src/b.ts"], context: { relevantFiles: ["src/a.ts"] },
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "koda-mini-worker-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/a.ts"), "export const a = 1;\n");
  await writeFile(join(root, "src/b.ts"), "export const b = 1;\n");
  await writeFile(join(root, "outside.ts"), "safe\n");
  return root;
}

test("MiniSweWorker passes one exact routed model, worktree, limits, and accepts scoped multi-file changes", async () => {
  const root = await fixture();
  let received: any;
  const runner: MiniSweBridgeRunner = async (request) => {
    received = request;
    await writeFile(join(request.repoPath, "src/a.ts"), "export const a = 2;\n");
    await writeFile(join(request.repoPath, "src/b.ts"), "export const b = 2;\n");
    return result(request.model, { trajectoryPath: request.trajectoryPath,
      cachedInputTokens: 12, cacheWriteTokens: 3 });
  };
  try {
    const budget = new Budget(1, 10_000, 30_000);
    const worker = new MiniSweWorker(budget, new Logger(join(root, ".koda"), "worker", true), { runner });
    const output = await worker.run(input(root));
    assert.equal(received.model, "vendor/coder");
    assert.notEqual(received.repoPath, root, "mini-SWE runs in Koda's disposable scoped copy");
    assert.equal(received.budgetUsd, 0.02);
    assert.equal(received.maxSteps, 4);
    assert.equal(received.sessionId, "run/test-attempt/vendor-coder");
    assert.deepEqual(output.changedPaths, ["src/a.ts", "src/b.ts"]);
    assert.equal(budget.spent, 0.002);
    assert.equal(budget.tokens, 30);
    assert.equal(output.cachedInputTokens, 12);
    assert.equal(output.cacheWriteTokens, 3);
    assert.equal(budget.reserved, 0);
    assert.equal(budget.reservedTokens, 0);
    const released = budget.reserve(0.99, 9_000);
    released.cancel();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("DIRECT narrow scope keeps mini-SWE IPC outside the candidate repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-mini-direct-ipc-"));
  const runtime = await mkdtemp(join(tmpdir(), "koda-mini-runtime-"));
  const logRoot = await mkdtemp(join(tmpdir(), "koda-mini-log-"));
  const pythonBin = (
    await execa("python3", [
      "-c",
      "import sys; print(getattr(sys, '_base_executable', None) or sys.executable)",
    ])
  ).stdout.trim();
  const python = join(runtime, "venv", "bin", "python");
  const bridge = join(runtime, "venv", "koda_bridge.py");
  const previousKey = process.env.OPENROUTER_API_KEY;
  try {
    await mkdir(join(runtime, "venv", "bin"), { recursive: true });
    await writeFile(join(root, "calculator.js"), "export const add=(a,b)=>a-b;\n");
    await writeFile(python, `#!/bin/sh\nexec ${JSON.stringify(pythonBin)} "$@"\n`);
    await chmod(python, 0o755);
    await writeFile(bridge, `import json, pathlib, sys
r=json.load(sys.stdin)
pathlib.Path(r["repoPath"], "calculator.js").write_text("export const add=(a,b)=>a+b;\\n")
pathlib.Path(r["trajectoryPath"]).write_text("{}")
print(json.dumps({"exitStatus":"completed","model":r["model"],"engine":"mini-swe-agent","engineVersion":"${MINI_SWE_VERSION}","costUsd":0.001,"inputTokens":4,"outputTokens":2,"wallClockMs":1,"terminationReason":"Submitted"}))
`);
    process.env.OPENROUTER_API_KEY = "test-key";
    const logger = new Logger(logRoot, "direct-ipc", true);
    const worker = new MiniSweWorker(new Budget(1, 1000, 30_000), logger,
      { ensureRuntime: async () => python });
    const output = await worker.run({ ...input(root), task: "Fix calculator",
      writeScope: ["calculator.js"] });
    assert.equal(output.exitStatus, "completed", output.fatalError);
    assert.deepEqual(output.changedPaths, ["calculator.js"]);
    assert.equal(await readFile(join(root, "calculator.js"), "utf8"),
      "export const add=(a,b)=>a+b;\n");
    await assert.rejects(access(join(root, ".koda")));
    assert.equal(new WriteScope(["."], logger, "reserved-check").allows(".koda/unauthorized"), false);
    assert.equal(logger.events.some((event) => event.type === "write_scope_violation"), false);
  } finally {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
    await Promise.all([root, runtime, logRoot].map((path) =>
      rm(path, { recursive: true, force: true })));
  }
});

test("OpenRouter credential handoff trims boundary whitespace and rejects missing placeholders", () => {
  assert.equal(sanitizeOpenRouterApiKey("  test-key\n"), "test-key");
  assert.throws(() => sanitizeOpenRouterApiKey(" \n "), /INFRA_FAILURE.*missing/);
  assert.throws(() => sanitizeOpenRouterApiKey(" REDACTED "), /INFRA_FAILURE.*placeholder/);
  assert.throws(() => sanitizeOpenRouterApiKey("key\nvalue"), /INFRA_FAILURE.*malformed/);
  assert.equal(redactOpenRouterSecret("error test-key artifact test-key", "test-key"),
    "error [REDACTED] artifact [REDACTED]");
});

test("single Stable full-scope attempt executes in candidate workspace and rolls back infra failure", async () => {
  const root = await fixture();
  const budget = new Budget(0.05, 2_000, 30_000);
  let receivedPath = "";
  try {
    const worker = new MiniSweWorker(budget, new Logger(join(root, ".koda"), "direct", true), {
      runner: async (request) => {
        receivedPath = request.repoPath;
        await writeFile(join(request.repoPath, "src/a.ts"), "broken\n");
        return { ...result(request.model), costUsd: undefined, inputTokens: undefined,
          outputTokens: undefined, exitStatus: "infra_failure" as const,
          fatalError: "provider timeout" };
      },
    });
    const output = await worker.run({ ...input(root), writeScope: ["."],
      directFullScope: true, budgetUsd: 0.02 });
    assert.equal(receivedPath, root, "full Stable scope avoids an extra repository copy");
    assert.equal(output.exitStatus, "infra_failure");
    assert.equal(await readFile(join(root, "src/a.ts"), "utf8"), "export const a = 1;\n");
    assert.equal(budget.spent, 0.02);
    assert.equal(budget.unknown, false);
    const retry = budget.reserve(0.02, 500);
    retry.cancel();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("successful Stable full-scope attempt returns exact changed paths", async () => {
  const root = await fixture();
  try {
    const worker = new MiniSweWorker(new Budget(1, 10_000, 30_000),
      new Logger(join(root, ".koda"), "direct-success", true), { runner: async (request) => {
        await writeFile(join(request.repoPath, "src/a.ts"), "export const a = 9;\n");
        return result(request.model);
      } });
    const output = await worker.run({ ...input(root), writeScope: ["."], directFullScope: true });
    assert.deepEqual(output.changedPaths, ["src/a.ts"]);
    assert.equal(await readFile(join(root, "src/a.ts"), "utf8"), "export const a = 9;\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("MiniSweWorker rejects out-of-scope changes and any internal model switch", async () => {
  const root = await fixture();
  try {
    const scopeEscape = new MiniSweWorker(new Budget(1, 1000, 30_000),
      new Logger(join(root, ".koda"), "scope", true), { runner: async (request) => {
        await writeFile(join(request.repoPath, "outside.ts"), "unsafe\n");
        return result(request.model);
      } });
    const escaped = await scopeEscape.run(input(root));
    assert.equal(escaped.exitStatus, "failed");
    assert.equal(await readFile(join(root, "outside.ts"), "utf8"), "safe\n");

    const switched = new MiniSweWorker(new Budget(1, 1000, 30_000),
      new Logger(join(root, ".koda"), "switch", true), { runner: async (request) => {
        await writeFile(join(request.repoPath, "src/a.ts"), "changed\n");
        return result("vendor/other");
      } });
    const changedModel = await switched.run(input(root));
    assert.equal(changedModel.exitStatus, "infra_failure");
    assert.equal(await readFile(join(root, "src/a.ts"), "utf8"), "export const a = 1;\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("parallel MiniSweWorkers receive independent writable worktrees", async () => {
  const [a, b] = await Promise.all([fixture(), fixture()]);
  const seen: string[] = [];
  const runner: MiniSweBridgeRunner = async (request) => {
    seen.push(request.repoPath);
    await writeFile(join(request.repoPath, "src/a.ts"), `// ${request.model}\n`);
    return result(request.model);
  };
  try {
    await Promise.all([a, b].map((root, index) =>
      new MiniSweWorker(new Budget(1, 1000, 30_000), new Logger(join(root, ".koda"), `p${index}`, true), { runner })
        .run(input(root, `vendor/model-${index}`))));
    assert.equal(new Set(seen).size, 2);
    assert.notEqual(await readFile(join(a, "src/a.ts"), "utf8"),
      await readFile(join(b, "src/a.ts"), "utf8"));
  } finally {
    await Promise.all([a, b].map((root) => rm(root, { recursive: true, force: true })));
  }
});

test("Koda verification rejects a completed bad patch, restores it, and routes a clean second attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-mini-executor-"));
  await mkdir(join(root, "src")); await mkdir(join(root, "tests"));
  await writeFile(join(root, "src/value.cjs"), "module.exports = 1;\n");
  await writeFile(join(root, "tests/value.test.cjs"),
    "const test=require('node:test'),a=require('node:assert/strict');test('not broken',()=>a.notEqual(require('../src/value.cjs'),2));\n");
  await execa("git", ["init", "-q"], { cwd: root });
  await execa("git", ["add", "."], { cwd: root });
  await execa("git", ["-c", "user.name=Koda", "-c", "user.email=koda@example.invalid",
    "commit", "-qm", "fixture"], { cwd: root });
  const cheap = modelSchema.parse({ id: "cheap", tier: "cheap", qualityPrior: .9 });
  const strong = modelSchema.parse({ id: "strong", tier: "strong", qualityPrior: .99 });
  const candidate = (model: typeof cheap) => ({ model, metadata: { inputPrice: 1, outputPrice: 1,
    supportedParameters: ["tools", "tool_choice"] }, quality: model.qualityPrior,
    cost: .01, latency: 1, score: 1 });
  const attempts: any[] = [], records: any[] = [], starts: string[] = [];
  const codingWorker = { run: async (request: any) => {
    starts.push(await readFile(join(request.repoPath, "src/value.cjs"), "utf8"));
    await writeFile(join(request.repoPath, "src/value.cjs"),
      request.model === "cheap" ? "module.exports = 2;\n" : "module.exports = 3;\n");
    attempts.push(request);
    return { ...result(request.model), changedPaths: ["src/value.cjs"] };
  } };
  try {
    const cfg = await config(undefined, { specialistRouting: true, maxIterations: 10,
      modelPool: { provider: "openrouter", models: [cheap, strong] } });
    const logger = new Logger(join(root, ".koda"), "executor", true);
    const gateway: any = { config: cfg, logger, budget: new Budget(1, 100_000, 60_000),
      modelRouter: {
        selectSpecialist: async () => [candidate(cheap), candidate(strong)],
        select: async () => { throw Error("exhausted"); },
        record: (...args: any[]) => records.push(args),
      } };
    const subtask: any = { id: "change", title: "Change value", objective: "Change value safely",
      likelyReadPaths: ["src/value.cjs", "tests/value.test.cjs"],
      likelyWritePaths: ["src/value.cjs"], dependsOn: [], integrationContract: "value remains valid",
      verificationCommands: ["node --test tests/value.test.cjs"], estimatedDifficulty: "normal",
      parallelSafe: false };
    const profile: any = { files: ["src/value.cjs", "tests/value.test.cjs"],
      verificationCommands: subtask.verificationCommands };
    const output = await implement(gateway, root, subtask.objective, subtask,
      { acceptanceCriteria: ["value is valid"] }, profile, {
        codingWorker, compiledContext: { files: [], localDependencies: [], completePaths: [],
          repoMap: [] },
      });
    assert.equal(output.verification.status, "VERIFIED_SUCCESS");
    assert.deepEqual(attempts.map((attempt) => attempt.model), ["cheap", "strong"]);
    assert.deepEqual(starts, ["module.exports = 1;\n", "module.exports = 1;\n"]);
    assert.equal(await readFile(join(root, "src/value.cjs"), "utf8"), "module.exports = 3;\n");
    assert.deepEqual(records.map((record) => record[4]), ["FAILED", "VERIFIED_SUCCESS"]);
    assert.equal(logger.events.filter((event) => event.type === "attempt_rollback").length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("mini-SWE infrastructure failure falls back without poisoning model quality", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-mini-infra-"));
  await mkdir(join(root, "src")); await mkdir(join(root, "tests"));
  await writeFile(join(root, "src/value.cjs"), "module.exports = 1;\n");
  await writeFile(join(root, "tests/value.test.cjs"),
    "const test=require('node:test'),a=require('node:assert/strict');test('value',()=>a.equal(require('../src/value.cjs'),3));\n");
  await execa("git", ["init", "-q"], { cwd: root });
  await execa("git", ["add", "."], { cwd: root });
  await execa("git", ["-c", "user.name=Koda", "-c", "user.email=koda@example.invalid",
    "commit", "-qm", "fixture"], { cwd: root });
  const cheap = modelSchema.parse({ id: "cheap", tier: "cheap", qualityPrior: .9 });
  const strong = modelSchema.parse({ id: "strong", tier: "strong", qualityPrior: .99 });
  const candidate = (model: typeof cheap) => ({ model, metadata: { inputPrice: 1, outputPrice: 1,
    supportedParameters: ["tools", "tool_choice"] }, quality: model.qualityPrior,
    cost: .01, latency: 1, score: 1 });
  const quality: any[] = [], operations: any[] = [], attempts: string[] = [];
  try {
    const cfg = await config(undefined, { specialistRouting: true, maxIterations: 10,
      modelPool: { provider: "openrouter", models: [cheap, strong] } });
    const logger = new Logger(join(root, ".koda"), "infra", true);
    const gateway: any = { config: cfg, logger, budget: new Budget(1, 10_000, 60_000),
      modelRouter: { selectSpecialist: async () => [candidate(cheap), candidate(strong)],
        select: async () => { throw Error("exhausted"); },
        record: (...args: any[]) => quality.push(args),
        history: { recordOperation: (entry: any) => operations.push(entry) } } };
    const worker = { run: async (request: any) => {
      attempts.push(request.model);
      if (request.model === "cheap") return { ...result(request.model),
        exitStatus: "infra_failure" as const, changedPaths: [],
        fatalError: "provider timeout" };
      await writeFile(join(request.repoPath, "src/value.cjs"), "module.exports = 3;\n");
      return { ...result(request.model), changedPaths: ["src/value.cjs"] };
    } };
    const subtask: any = { id: "infra", title: "Fix value", objective: "Fix value",
      likelyReadPaths: ["src/value.cjs", "tests/value.test.cjs"],
      likelyWritePaths: ["src/value.cjs"], dependsOn: [], integrationContract: "tests pass",
      verificationCommands: ["node --test tests/value.test.cjs"], estimatedDifficulty: "normal",
      parallelSafe: false };
    const output = await implement(gateway, root, subtask.objective, subtask,
      { acceptanceCriteria: ["tests pass"] },
      { files: subtask.likelyReadPaths, verificationCommands: subtask.verificationCommands } as any,
      { codingWorker: worker, compiledContext: { files: [], localDependencies: [],
        completePaths: [], repoMap: [] } });
    assert.equal(output.verification.status, "VERIFIED_SUCCESS");
    assert.deepEqual(attempts, ["cheap", "strong"]);
    assert.deepEqual(quality.map((entry) => entry[4]), ["VERIFIED_SUCCESS"]);
    assert.equal(operations.length, 1);
    assert.equal(operations[0].classification, "OPERATIONAL_FAILURE");
    assert.equal(logger.events.find((event) => event.type === "model_attempt")?.escalated, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

const executionFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-bounded-plan-"));
  await mkdir(join(root, "src")); await mkdir(join(root, "tests"));
  await writeFile(join(root, "src/value.cjs"), "module.exports = 1;\n");
  await writeFile(join(root, "tests/value.test.cjs"),
    "const test=require('node:test'),a=require('node:assert/strict');test('value',()=>a.equal(require('../src/value.cjs'),2));\n");
  await execa("git", ["init", "-q"], { cwd: root });
  await execa("git", ["add", "."], { cwd: root });
  await execa("git", ["-c", "user.name=Koda", "-c", "user.email=koda@example.invalid",
    "commit", "-qm", "fixture"], { cwd: root });
  return root;
};

const routed = (model: ReturnType<typeof modelSchema.parse>) => ({
  model, metadata: { inputPrice: 1, outputPrice: 2,
    supportedParameters: ["tools", "tool_choice"] },
  quality: model.qualityPrior, cost: 0.01, latency: 100, score: 1,
  expectedAttemptCost: 0.01, conservativeAttemptCost: 0.03,
  reservationCost: 0.02, tokenEfficiency: { p90TotalTokens: 7_000 },
});

const boundedSubtask = {
  id: "bounded", title: "Fix value", objective: "Fix value",
  likelyReadPaths: ["src/value.cjs", "tests/value.test.cjs"],
  likelyWritePaths: ["src/value.cjs"], dependsOn: [], integrationContract: "tests pass",
  verificationCommands: ["node --test tests/value.test.cjs"],
  estimatedDifficulty: "normal" as const, parallelSafe: false,
};

test("specialist execution plan is monotonic, bounded, and stops without catalog scanning", async () => {
  const root = await executionFixture();
  const cheap = modelSchema.parse({ id: "cheap-a", tier: "cheap", qualityPrior: .9 });
  const frontier = modelSchema.parse({ id: "frontier-b", tier: "frontier", qualityPrior: .99 });
  const unrelated = modelSchema.parse({ id: "cheap-c", tier: "cheap", qualityPrior: .91 });
  const requests: any[] = [];
  let genericSelections = 0;
  try {
    const cfg = await config(undefined, { specialistRouting: true, maxIterations: 18,
      codingAttemptTimeoutMs: 120_000,
      modelPool: { provider: "openrouter", models: [cheap, frontier, unrelated] } });
    const logger = new Logger(join(root, ".koda"), "bounded-plan", true);
    const gateway: any = { config: cfg, logger, budget: new Budget(.3, 200_000, 300_000),
      modelRouter: {
        selectSpecialist: async () => [routed(cheap), routed(frontier)],
        select: async () => { genericSelections++; return routed(unrelated); },
        record: () => undefined,
        history: { recordOperation: () => undefined },
      } };
    const worker = { run: async (request: any) => {
      requests.push(request);
      return { ...result(request.model), changedPaths: [], costUsd: 0.007,
        inputTokens: 7_000, outputTokens: 1_000, terminationReason: "LimitsExceeded",
        limitKind: "token_limit" as const, progressPhase: "DISCOVERY" as const, steps: 2 };
    } };
    const output = await implement(gateway, root, boundedSubtask.objective, boundedSubtask,
      { acceptanceCriteria: ["tests pass"] },
      { files: boundedSubtask.likelyReadPaths,
        verificationCommands: boundedSubtask.verificationCommands } as any,
      { codingWorker: worker, compiledContext: { files: [], localDependencies: [],
        completePaths: [], repoMap: [] } });
    assert.equal(output.verification.status, "NOT_FULLY_VERIFIED");
    assert.deepEqual(requests.map((request) => request.model), ["cheap-a", "frontier-b"]);
    assert.equal(genericSelections, 0, "exhausted quality plans never scan the generic catalog");
    assert.ok(requests.every((request) => request.budgetUsd === 0.03));
    assert.ok(requests.every((request) => request.maxTokens === 8_192));
    assert.ok(requests.every((request) => request.maxSteps === 10));
    assert.ok(requests.every((request) => request.timeoutMs === 45_000));
    assert.ok(requests.every((request) => request.promptPricePerMillion === 1 &&
      request.completionPricePerMillion === 2));
    assert.equal(await readFile(join(root, "src/value.cjs"), "utf8"), "module.exports = 1;\n");
    const attempts = logger.events.filter((event) => event.type === "model_attempt");
    assert.equal(attempts.at(-1)?.escalated, false);
    assert.equal(logger.events.filter((event) => event.type === "attempt_prediction_error").length, 2);
    assert.ok(logger.events.filter((event) => event.type === "coding_worker_stop")
      .every((event) => event.limit_kind === "token_limit"));
    assert.ok(logger.events.every((event) => event.affects_coding_quality !== true));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a scoped mutation at the worker token boundary is verified before any fallback", async () => {
  const root = await executionFixture();
  const cheap = modelSchema.parse({ id: "cheap-boundary", tier: "cheap", qualityPrior: .95 });
  const frontier = modelSchema.parse({ id: "frontier-unused", tier: "frontier", qualityPrior: .99 });
  const requests: any[] = [];
  try {
    const cfg = await config(undefined, { specialistRouting: true, maxIterations: 18,
      context: { toolResultBytes: 2048 },
      modelPool: { provider: "openrouter", models: [cheap, frontier] } });
    const logger = new Logger(join(root, ".koda"), "mutation-boundary", true);
    const gateway: any = { config: cfg, logger, budget: new Budget(.3, 200_000, 300_000),
      modelRouter: {
        selectSpecialist: async () => [routed(cheap), routed(frontier)],
        select: async () => { throw Error("generic routing forbidden"); },
        record: () => undefined, history: { recordOperation: () => undefined },
      } };
    const output = await implement(gateway, root, boundedSubtask.objective, boundedSubtask,
      { acceptanceCriteria: ["tests pass"] },
      { files: boundedSubtask.likelyReadPaths,
        verificationCommands: boundedSubtask.verificationCommands } as any,
      { codingWorker: { run: async (request: any) => {
          requests.push(request);
          await writeFile(join(request.repoPath, "src/value.cjs"), "module.exports = 2;\n");
          return { ...result(request.model), exitStatus: "failed" as const,
            changedPaths: ["src/value.cjs"], terminationReason: "LimitsExceeded",
            limitKind: "token_limit" as const,
            progressPhase: "MUTATION_OBSERVED" as const, steps: 4 };
        } }, compiledContext: { files: [], localDependencies: [],
          completePaths: [], repoMap: [] } });
    assert.equal(output.verification.status, "VERIFIED_SUCCESS");
    assert.deepEqual(requests.map((request) => request.model), [cheap.id]);
    assert.equal(requests[0].returnOnMutation, true);
    assert.equal(requests[0].maxToolOutputBytes, 2048);
    assert.equal(await readFile(join(root, "src/value.cjs"), "utf8"), "module.exports = 2;\n");
    assert.equal(logger.events.filter((event) => event.type === "mini_swe_fallback").length, 0);
    assert.equal(logger.events.find((event) =>
      event.type === "execution_limit_candidate_preserved")?.limit_kind, "token_limit");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("exhausted specialist plan permits one explicit same-tier operational fallback", async () => {
  const root = await executionFixture();
  const first = modelSchema.parse({ id: "frontier-a", tier: "frontier", qualityPrior: .99 });
  const sideways = modelSchema.parse({ id: "frontier-b", tier: "frontier", qualityPrior: .99 });
  const requests: string[] = [], quality: any[] = [], operations: any[] = [];
  let genericSelections = 0;
  try {
    const cfg = await config(undefined, { specialistRouting: true, maxIterations: 18,
      modelPool: { provider: "openrouter", models: [first, sideways] } });
    const logger = new Logger(join(root, ".koda"), "sideways", true);
    const gateway: any = { config: cfg, logger, budget: new Budget(.3, 200_000, 300_000),
      modelRouter: {
        selectSpecialist: async () => [routed(first)],
        select: async () => { genericSelections++; return routed(sideways); },
        record: (...args: any[]) => quality.push(args),
        history: { recordOperation: (entry: any) => operations.push(entry) },
      } };
    const worker = { run: async (request: any) => {
      requests.push(request.model);
      if (request.model === first.id) return { ...result(request.model),
        exitStatus: "infra_failure" as const, changedPaths: [],
        fatalError: "provider timeout", terminationReason: "infrastructure_failure" };
      await writeFile(join(request.repoPath, "src/value.cjs"), "module.exports = 2;\n");
      return { ...result(request.model), changedPaths: ["src/value.cjs"] };
    } };
    const output = await implement(gateway, root, boundedSubtask.objective, boundedSubtask,
      { acceptanceCriteria: ["tests pass"] },
      { files: boundedSubtask.likelyReadPaths,
        verificationCommands: boundedSubtask.verificationCommands } as any,
      { codingWorker: worker, compiledContext: { files: [], localDependencies: [],
        completePaths: [], repoMap: [] } });
    assert.equal(output.verification.status, "VERIFIED_SUCCESS");
    assert.deepEqual(requests, ["frontier-a", "frontier-b"]);
    assert.equal(genericSelections, 1);
    assert.equal(operations.length, 1);
    assert.deepEqual(quality.map((entry) => entry[4]), ["VERIFIED_SUCCESS"],
      "provider failure creates no negative coding-quality evidence");
    assert.equal(logger.events.find((event) => event.type === "model_attempt")?.escalated, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("known-cost LimitsExceeded settles actual usage once and preserves remaining budget", async () => {
  const root = await fixture();
  try {
    const budget = new Budget(.1, 1_000, 30_000);
    const worker = new MiniSweWorker(budget, new Logger(join(root, ".koda"), "limits", true), {
      runner: async (request) => ({ ...result(request.model), exitStatus: "failed" as const,
        costUsd: .01, inputTokens: 80, outputTokens: 20,
        terminationReason: "LimitsExceeded" }),
    });
    const output = await worker.run({ ...input(root), budgetUsd: .04, maxTokens: 400 });
    assert.equal(output.terminationReason, "LimitsExceeded");
    assert.equal(budget.spent, .01);
    assert.equal(budget.tokens, 100);
    assert.equal(budget.unknown, false);
    assert.equal(budget.reserved, 0);
    assert.equal(budget.reservedTokens, 0);
    const next = budget.reserve(.09, 900);
    next.cancel();
  } finally { await rm(root, { recursive: true, force: true }); }
});

const localizedPolicy = (overrides: Record<string, unknown> = {}) => attemptLimitPolicy({
  fingerprint: { localizationConfidence: "high", expectedFiles: 1,
    architectureHeavy: false, repoReasoningHeavy: false, crossComponent: false } as any,
  effort: "normal", promptBytes: 18_083, maxIterations: 18,
  maxOutputTokens: 4096, learnedP90Tokens: 8_192,
  remainingTokens: 200_000, stageMaxTokens: 30_000,
  plannedBudgetUsd: .005, remainingUsd: .1, stageMaxUsd: 1,
  promptPricePerMillion: .1, completionPricePerMillion: .2,
  remainingMs: 60_000, configuredTimeoutMs: 120_000,
  ...overrides,
} as any);

test("localized coding policy is viable beyond the old six-step ceiling while hard bounds cooperate", () => {
  const policy = localizedPolicy();
  assert.equal(policy.viable, true);
  assert.equal(policy.maxSteps, 10);
  assert.ok(policy.minimumViableTokens > 18_517,
    "the policy accounts for cumulative conversational prompt usage");
  assert.ok(policy.maxTokens <= 30_000, "stage token safety remains hard");
  assert.ok(policy.timeoutMs <= 45_000, "attempt timeout remains hard");
});

test("attempt viability fails closed for independent token, cost, and timeout limits", () => {
  assert.equal(localizedPolicy({ stageMaxTokens: 5_000 }).nonViableLimitKind, "token_limit");
  assert.equal(localizedPolicy({ remainingUsd: .001, promptPricePerMillion: 100,
    completionPricePerMillion: 100 }).nonViableLimitKind, "cost_limit");
  assert.equal(localizedPolicy({ remainingMs: 5_000 }).nonViableLimitKind, "timeout");
  assert.equal(localizedPolicy({ maxIterations: 2 }).maxSteps, 10,
    "outer candidate attempts do not truncate the inner agent action sequence");
});

test("mini-SWE limit telemetry preserves the exact limiting dimension and progress phase", async () => {
  const root = await fixture();
  try {
    const worker = new MiniSweWorker(new Budget(.1, 10_000, 30_000),
      new Logger(join(root, ".koda"), "limit-kind", true), { runner: async (request) => ({
        ...result(request.model), exitStatus: "failed" as const,
        terminationReason: "LimitsExceeded", limitKind: "token_preflight",
        configuredTokenLimit: request.maxTokens, consumedTokens: request.maxTokens - 100,
        remainingTokens: 100, exactLimitFired: "token_preflight",
        progressPhase: "DISCOVERY", steps: 2,
      }) });
    const output = await worker.run(input(root));
    assert.equal(output.limitKind, "token_preflight");
    assert.equal(output.configuredTokenLimit, 1000);
    assert.equal(output.consumedTokens, 900);
    assert.equal(output.remainingTokens, 100);
    assert.equal(output.exactLimitFired, "token_preflight");
    assert.equal(output.progressPhase, "DISCOVERY");
    assert.equal(output.steps, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("mini-SWE distinguishes next-request preflight from the authoritative consumed token limit", async () => {
  const bridge = join(process.cwd(), "workers/miniswe/bridge.py");
  const source = `import importlib.util, json
spec=importlib.util.spec_from_file_location("bridge", ${JSON.stringify(bridge)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps({
  "preflight": m._token_limit_state(27848, 26190, 2000),
  "hard": m._token_limit_state(27848, 27848, 1),
  "available": m._token_limit_state(27848, 20000, 1000),
}))`;
  const execution = await execa("python3", ["-c", source]);
  const states = JSON.parse(execution.stdout);
  assert.deepEqual(states.preflight, {
    limit_kind: "token_preflight", configured_token_limit: 27848,
    consumed_tokens: 26190, remaining_tokens: 1658, next_prompt_tokens: 2000,
  });
  assert.equal(states.hard.limit_kind, "token_limit");
  assert.ok(states.hard.consumed_tokens >= states.hard.configured_token_limit);
  assert.equal(states.available.limit_kind, "");
});

test("progress watchdog permits novel exploration through mutation and verification but stops repeats", async () => {
  const bridge = join(process.cwd(), "workers/miniswe/bridge.py");
  const source = `import importlib.util, json
spec=importlib.util.spec_from_file_location("bridge", ${JSON.stringify(bridge)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
useful=m.ProgressWatchdog(".")
for i in range(7): useful.observe([f"sed -n '{i+1}p' target.py"], "a", "a")
useful.observe(["cat > target.py <<'EOF'\\nchanged\\nEOF"], "a", "b")
useful.observe(["pytest -q"], "b", "b")
loop=m.ProgressWatchdog(".")
for i in range(4): loop.observe(["cat target.py"], "a", "a")
print(json.dumps({"useful_stalled":useful.stalled,"phase":useful.phase,"loop_stalled":loop.stalled}))`;
  const execution = await execa("python3", ["-c", source]);
  assert.deepEqual(JSON.parse(execution.stdout), {
    useful_stalled: false, phase: "VERIFICATION_ATTEMPTED", loop_stalled: true,
  });
});

test("mini-SWE detects scoped mutations without Git and bounds command output", async () => {
  const bridge = join(process.cwd(), "workers/miniswe/bridge.py");
  const root = await mkdtemp(join(tmpdir(), "koda-bridge-signature-"));
  try {
    await writeFile(join(root, "target.py"), "before\n");
    const source = `import importlib.util, json
from pathlib import Path
spec=importlib.util.spec_from_file_location("bridge", ${JSON.stringify(bridge)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
root=${JSON.stringify(root)}
before=m._paths_signature(root,["target.py"])
Path(root,"target.py").write_text("after\\n")
after=m._paths_signature(root,["target.py"])
bounded=m._truncate_output("x"*10000,1000)
print(json.dumps({"changed":before!=after,"bytes":len(bounded.encode()),"marker":"Koda truncated" in bounded}))`;
    const execution = await execa("python3", ["-c", source]);
    assert.deepEqual(JSON.parse(execution.stdout), { changed: true, bytes: 1000, marker: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("non-viable frozen attempt is rejected before worker invocation", async () => {
  const root = await executionFixture();
  const only = modelSchema.parse({ id: "bounded", tier: "fast", qualityPrior: .95 });
  let workerCalls = 0;
  try {
    const cfg = await config(undefined, { specialistRouting: true, maxIterations: 18,
      stageMaxTokens: 100, modelPool: { provider: "openrouter", models: [only] } });
    const logger = new Logger(join(root, ".koda"), "non-viable", true);
    const gateway: any = { config: cfg, logger,
      budget: new Budget(.3, 200_000, 300_000), modelRouter: {
        selectSpecialist: async () => [routed(only)],
        select: async () => { throw Error("generic routing forbidden"); },
        record: () => undefined, history: { recordOperation: () => undefined },
      } };
    const output = await implement(gateway, root, boundedSubtask.objective, boundedSubtask,
      { acceptanceCriteria: ["tests pass"] },
      { files: boundedSubtask.likelyReadPaths,
        verificationCommands: boundedSubtask.verificationCommands } as any,
      { codingWorker: { run: async () => { workerCalls++; return result(only.id); } },
        compiledContext: { files: [], localDependencies: [], completePaths: [], repoMap: [] } });
    assert.equal(output.verification.status, "NOT_FULLY_VERIFIED");
    assert.equal(workerCalls, 0);
    assert.equal(logger.events.find((event) => event.type === "coding_attempt_non_viable")
      ?.limit_kind, "token_limit");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("exhausted run budget stops the selected plan without model or catalog retries", async () => {
  const root = await executionFixture();
  const cheap = modelSchema.parse({ id: "cheap-budget", tier: "cheap", qualityPrior: .9 });
  const frontier = modelSchema.parse({ id: "frontier-budget", tier: "frontier", qualityPrior: .99 });
  let workerCalls = 0, genericSelections = 0;
  try {
    const cfg = await config(undefined, { specialistRouting: true, maxIterations: 18,
      modelPool: { provider: "openrouter", models: [cheap, frontier] } });
    const logger = new Logger(join(root, ".koda"), "budget-stop", true);
    const budget = new Budget(.3, 100, 300_000);
    budget.reserve(.01, 100).settle({ promptTokens: 80, completionTokens: 20,
      reasoningTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, costUsd: .01, raw: null });
    const gateway: any = { config: cfg, logger, budget,
      modelRouter: {
        selectSpecialist: async () => [routed(cheap), routed(frontier)],
        select: async () => { genericSelections++; return routed(frontier); },
        record: () => undefined,
        history: { recordOperation: () => undefined },
      } };
    const output = await implement(gateway, root, boundedSubtask.objective, boundedSubtask,
      { acceptanceCriteria: ["tests pass"] },
      { files: boundedSubtask.likelyReadPaths,
        verificationCommands: boundedSubtask.verificationCommands } as any,
      { codingWorker: { run: async () => { workerCalls++; return {
          ...result(cheap.id), changedPaths: [] }; } },
        compiledContext: { files: [], localDependencies: [], completePaths: [], repoMap: [] } });
    assert.equal(output.verification.status, "NOT_FULLY_VERIFIED");
    assert.equal(workerCalls, 0);
    assert.equal(genericSelections, 0);
    assert.equal(logger.events.find((event) => event.type === "execution_plan_exhausted")?.reason,
      "run_budget_exhausted");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("clean bootstrap creates and reuses Koda's pinned isolated mini-SWE runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-mini-bootstrap-"));
  const bin = join(root, "bin"), cache = join(root, "cache");
  await mkdir(bin);
  const uv = join(bin, "uv");
  await writeFile(uv, `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'uv 1'; exit 0; fi
if [ "$1" = "venv" ]; then
  for value in "$@"; do target="$value"; done
  mkdir -p "$target/bin"
  printf '#!/bin/sh\\nexit 0\\n' > "$target/bin/python"
  chmod +x "$target/bin/python"
  exit 0
fi
if [ "$1" = "pip" ]; then exit 0; fi
exit 1
`, { mode: 0o755 });
  try {
    const source = `import { ensureMiniSweRuntime, MINI_SWE_VERSION } from ${JSON.stringify(
      new URL("../src/agent/miniSweRuntime.ts", import.meta.url).href)};
const first = await ensureMiniSweRuntime(); const second = await ensureMiniSweRuntime();
console.log(JSON.stringify({first, second, version: MINI_SWE_VERSION}));`;
    const boot = await execa(process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", source], {
        cwd: process.cwd(), env: { ...process.env, KODA_RUNTIME_CACHE: cache,
          PATH: `${bin}:${process.env.PATH}` },
      });
    const output = JSON.parse(boot.stdout);
    assert.equal(output.version, MINI_SWE_VERSION);
    assert.equal(output.first, output.second);
    assert.match(output.first, new RegExp(`mini-swe-agent-${MINI_SWE_VERSION}`));
    await access(join(cache, `mini-swe-agent-${MINI_SWE_VERSION}`, "venv", "koda_bridge.py"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("production run imports only the MiniSwe executor and bootstrap pin is exact", async () => {
  const runSource = await readFile(join(process.cwd(), "src/run.ts"), "utf8");
  const requirements = await readFile(join(process.cwd(), "workers/miniswe/requirements.txt"), "utf8");
  const bridge = await readFile(join(process.cwd(), "workers/miniswe/bridge.py"), "utf8");
  assert.match(runSource, /from "\.\/agent\/miniSweExecutor\.js"/);
  assert.doesNotMatch(runSource, /from "\.\/agent\/loop\.js"/);
  assert.equal(requirements.trim(), `mini-swe-agent==${MINI_SWE_VERSION}`);
  assert.match(bridge, /from minisweagent\.agents\.default import DefaultAgent/);
  assert.match(bridge, /from minisweagent\.models\.litellm_model import LitellmModel/);
  assert.match(bridge, /class BoundedLitellmModel/);
  assert.match(bridge, /token_limit=request\["maxTokens"\]/);
  assert.match(bridge, /"api_key": api_key/);
  assert.match(bridge, /"timeout": max\(1, request\.get\("requestTimeoutMs", 30000\)/);
  assert.match(bridge, /trajectory\.write_text\(json\.dumps\(serialized/);
  assert.doesNotMatch(bridge, /RouletteModel|InterleavingModel/);
});

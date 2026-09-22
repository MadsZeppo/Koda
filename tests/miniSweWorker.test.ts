import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { MiniSweWorker, type MiniSweBridgeRunner } from "../src/agent/miniSweWorker.js";
import { MINI_SWE_VERSION } from "../src/agent/miniSweRuntime.js";
import { Budget } from "../src/openrouter/usage.js";
import { Logger } from "../src/telemetry/logger.js";
import { implement } from "../src/agent/miniSweExecutor.js";
import { config } from "../src/config.js";
import { modelSchema } from "../src/router/pool.js";

const result = (model: string, extra: Record<string, unknown> = {}) => ({
  exitStatus: "completed" as const, model, engine: "mini-swe-agent" as const,
  engineVersion: MINI_SWE_VERSION, costUsd: 0.002, inputTokens: 20,
  outputTokens: 10, wallClockMs: 5, terminationReason: "Submitted", ...extra,
});
const input = (repoPath: string, model = "vendor/coder") => ({
  repoPath, attemptId: "test-attempt", task: "Update both scoped files", model, budgetUsd: 0.02,
  maxTokens: 1000, maxSteps: 4, timeoutMs: 10_000, commandTimeoutMs: 2_000,
  maxOutputTokens: 500, baseUrl: "https://openrouter.ai/api/v1",
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
    return result(request.model, { trajectoryPath: request.trajectoryPath });
  };
  try {
    const budget = new Budget(1, 10_000, 30_000);
    const worker = new MiniSweWorker(budget, new Logger(join(root, ".koda"), "worker", true), { runner });
    const output = await worker.run(input(root));
    assert.equal(received.model, "vendor/coder");
    assert.notEqual(received.repoPath, root, "mini-SWE runs in Koda's disposable scoped copy");
    assert.equal(received.budgetUsd, 0.02);
    assert.equal(received.maxSteps, 4);
    assert.deepEqual(output.changedPaths, ["src/a.ts", "src/b.ts"]);
    assert.equal(budget.spent, 0.002);
    assert.equal(budget.tokens, 30);
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
    const cfg = await config(undefined, { specialistRouting: true, maxIterations: 3,
      modelPool: { provider: "openrouter", models: [cheap, strong] } });
    const logger = new Logger(join(root, ".koda"), "executor", true);
    const gateway: any = { config: cfg, logger, budget: new Budget(1, 10_000, 60_000),
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
    const cfg = await config(undefined, { specialistRouting: true, maxIterations: 2,
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
  assert.doesNotMatch(bridge, /RouletteModel|InterleavingModel/);
});

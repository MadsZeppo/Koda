import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { config } from "../src/config.js";
import { run } from "./helpers/run.js";
import { git } from "../src/repo/commands.js";
import { profileRepo } from "../src/repo/profiler.js";
import { Gateway } from "../src/openrouter/client.js";
import { Budget } from "../src/openrouter/usage.js";
import { Logger } from "../src/telemetry/logger.js";
import {
  extractStableDeclaration,
  prepareStableWorker,
} from "../src/agent/stable.js";
import { stableReadyForFinalVerification } from "../src/agent/loop.js";
import { AgentTools } from "../src/agent/tools.js";
import { WriteScope } from "../src/repo/writeScope.js";
import type { Subtask } from "../src/planner/schemas.js";
import { emitFixtureMetrics } from "../benchmarks/deterministicMetrics.js";

const declaration = (path = "src/a.ts") => ({
  issue: "The implementation returns an incorrect value",
  writePaths: [path],
  evidence: {
    relevantFiles: ["src/a.ts"],
    symbols: ["a"],
    reproduction: "inspection",
    failingTests: [],
    likelyRootCause: "small defect",
    dependencies: [],
    uncertainty: "low",
    suggestedApproach: "apply the focused fix",
    evidence: ["src/a.ts was read"],
  },
  requiredChange: "Correct the implementation while preserving its interface",
  regressionTest: "Prove the corrected behavior with a focused regression test",
  relevantDetails: ["Keep the change localized"],
});

for (const [name, render] of [
  ["pure JSON", (json: string) => json],
  ["JSON in a fenced block", (json: string) => `\`\`\`json\n${json}\n\`\`\``],
  [
    "JSON followed by explanation",
    (json: string) => `${json}\nThis is the requested scope.`,
  ],
  ["text before JSON", (json: string) => `Inspection complete.\n${json}`],
] as const)
  test(`stable declaration extraction: ${name}`, () => {
    const expected = declaration();
    assert.deepEqual(
      extractStableDeclaration(render(JSON.stringify(expected))),
      expected,
    );
  });

test("stable declaration extraction accepts the first schema-valid object", () => {
  assert.deepEqual(
    extractStableDeclaration(
      `${JSON.stringify({ unrelated: true })}\n${JSON.stringify(declaration("src/first.ts"))}\n${JSON.stringify(declaration("src/second.ts"))}`,
    ).writePaths,
    ["src/first.ts"],
  );
});

test("stable completion rejects writes accompanied by a failed targeted command", () => {
  const paths = ["src/a.ts", "tests/a.test.ts"];
  const events = paths.map((path) => ({ type: "write_success", path }));
  assert.equal(
    stableReadyForFinalVerification(paths, events, "real diff", [
      { command: "npm test", exitCode: 1 },
    ]),
    false,
  );
  assert.equal(
    stableReadyForFinalVerification(paths, events, "real diff", [
      { command: "npm test", exitCode: 0 },
    ]),
    true,
  );
  assert.equal(
    stableReadyForFinalVerification(paths, events.slice(0, 1), "real diff", []),
    true,
  );
  assert.equal(stableReadyForFinalVerification(paths, events, "", []), false);
});

test("Stable inspection uses the universal selector when local scope remains ambiguous", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-stable-universal-route-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/first.js"), "export const first = 1;\n");
    await writeFile(join(root, "src/second.js"), "export const second = 2;\n");
    await git(root, "init", "-q");
    await git(root, "config", "user.name", "Stable Selector Test");
    await git(root, "config", "user.email", "stable-selector@test.local");
    await git(root, "add", ".");
    await git(root, "commit", "-qm", "baseline");
    const logger = new Logger(join(root, ".git", "log"), "stable-universal", true);
    const gateway = new Gateway(await config(undefined, { models: {} }), logger,
      new Budget(1, 100000, 60000));
    (gateway.config as any).specialistRouting = true;
    let specialistCalls = 0;
    (gateway as any).modelRouter = {
      selectSpecialist: async (fingerprint: any, features: any) => {
        specialistCalls++;
        assert.equal(features.executionStrategy, "stable");
        assert.equal(fingerprint.primary, "debugging");
        assert.equal(fingerprint.visualRelevant, false);
        return [{ model: { id: "qualified-worker", tier: "cheap", strengths: ["tool_use"] },
          metadata: { supportedParameters: ["tools", "tool_choice"] } }];
      },
      select: async () => { throw Error("legacy Stable selection must not run"); },
    };
    (gateway as any).call = async (model: string) => {
      modelCalls++;
      assert.equal(model, "qualified-worker");
      return { role: "assistant", content: null, tool_calls: [{ id: "no-scope", type: "function",
        function: { name: "report_no_scope", arguments: JSON.stringify({ reason: "The relevant implementation is ambiguous" }) } }] };
    };
    const objective = "Inspect the two local implementations and fix the specific bug";
    let modelCalls = 0;
    const work: Subtask = { id: "stable", title: objective, objective, dependsOn: [],
      likelyReadPaths: ["src/first.js", "src/second.js"], likelyWritePaths: [], readOnly: true,
      integrationContract: "", verificationCommands: [], estimatedDifficulty: "normal", parallelSafe: false };
    await assert.rejects(prepareStableWorker(gateway, root, objective, work,
      await profileRepo(root), { files: [
        { path: "src/first.js", snippet: "// specific bug\nexport const first = 1;" },
        { path: "src/second.js", snippet: "// specific bug\nexport const second = 2;" },
      ], repoMap: ["src/first.js", "src/second.js"], localDependencies: [] }), /no actionable scope/i);
    assert.equal(specialistCalls, 1);
    assert.equal(modelCalls, 1, "the no-scope fallback is bounded to one attempt");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an initial empty mutation scope gets one bounded deterministic fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-stable-actionable-fallback-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/target.ts"), "export const target = 1;\n");
    await git(root, "init", "-q");
    await git(root, "config", "user.name", "Scope Fallback Test");
    await git(root, "config", "user.email", "scope-fallback@test.local");
    await git(root, "add", ".");
    await git(root, "commit", "-qm", "baseline");
    const logger = new Logger(join(root, ".git", "fallback-log"), "scope-fallback", true);
    const gateway = new Gateway(await config(undefined, { models: {} }), logger,
      new Budget(1, 100000, 60000));
    let calls = 0;
    (gateway as any).call = async () => {
      calls++;
      return { role: "assistant", content: null, tool_calls: [{ id: "none", type: "function",
        function: { name: "report_no_scope", arguments: JSON.stringify({
          reason: "The initial inspection did not identify an actionable file",
        }) } }] };
    };
    const objective = "Inspect and fix src/target.ts, then verify the behavior";
    const work: Subtask = { id: "stable", title: objective, objective, dependsOn: [],
      likelyReadPaths: ["src/target.ts"], likelyWritePaths: [], readOnly: true,
      integrationContract: "Fix the named implementation", verificationCommands: [],
      estimatedDifficulty: "normal", parallelSafe: false };
    const prepared = await prepareStableWorker(gateway, root, objective, work,
      await profileRepo(root), { files: [{ path: "src/target.ts", snippet: "export const target = 1;" }],
        repoMap: ["src/target.ts"], localDependencies: [] });
    assert.deepEqual(prepared.writePaths, ["src/target.ts"]);
    assert.equal(calls, 1);
    assert.equal(logger.events.filter((event) =>
      event.type === "stable_actionable_scope_fallback").length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("no-scope fallback ranks inspected content and locks only the evidence-backed source and test", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-stable-ranked-fallback-"));
  try {
    await mkdir(join(root, "src", "agent"), { recursive: true });
    await mkdir(join(root, "tests"));
    await writeFile(join(root, "src/agent/prompts.ts"),
      "export const scopePrompt = 'require concrete inspection evidence before scope lock';\n");
    await writeFile(join(root, "src/run.ts"), "export const run = () => 'unrelated orchestration';\n");
    await writeFile(join(root, "tests/prompts.test.ts"),
      "import { scopePrompt } from '../src/agent/prompts.js'; test('scope evidence', () => scopePrompt.includes('evidence'));\n");
    await git(root, "init", "-q"); await git(root, "config", "user.name", "Ranked Fallback");
    await git(root, "config", "user.email", "ranked@test.local"); await git(root, "add", ".");
    await git(root, "commit", "-qm", "baseline");
    const logger = new Logger(join(root, ".git", "fallback-log"), "ranked-fallback", true);
    const gateway = new Gateway(await config(undefined, { models: {} }), logger,
      new Budget(1, 100000, 60000));
    let calls = 0;
    (gateway as any).call = async () => {
      calls++;
      return { role: "assistant", content: null, tool_calls: [{ id: "none", type: "function",
        function: { name: "report_no_scope", arguments: JSON.stringify({
          reason: "The model did not gather repository evidence",
        }) } }] };
    };
    const objective = "Fix the scope prompt inspection evidence behavior and update the regression test";
    const work: Subtask = { id: "stable", title: objective, objective, dependsOn: [],
      likelyReadPaths: ["src/agent/prompts.ts", "src/run.ts", "tests/prompts.test.ts"],
      likelyWritePaths: [], readOnly: true, integrationContract: "Keep the scope conservative",
      verificationCommands: [], estimatedDifficulty: "normal", parallelSafe: false };
    const prepared = await prepareStableWorker(gateway, root, objective, work,
      await profileRepo(root), { files: [
        { path: "src/agent/prompts.ts", snippet: "export const scopePrompt = 'require concrete inspection evidence before scope lock';" },
        { path: "src/run.ts", snippet: "export const run = () => 'unrelated orchestration';" },
        { path: "tests/prompts.test.ts", snippet: "import { scopePrompt } from '../src/agent/prompts.js'; test('scope evidence', () => scopePrompt.includes('evidence'));" },
      ], repoMap: ["src/agent/prompts.ts", "src/run.ts", "tests/prompts.test.ts"], localDependencies: [] });
    assert.deepEqual(prepared.writePaths, ["src/agent/prompts.ts", "tests/prompts.test.ts"]);
    assert.ok(!prepared.writePaths.includes("src/run.ts"));
    assert.equal(calls, 0, "ranked local context locks scope before model discovery");
    assert.equal(logger.events.filter((event) => event.type === "stable_actionable_scope_fallback").length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("repository filenames without inspected content do not authorize fallback writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-stable-filename-only-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/first.ts"), "export const first = 1;\n");
    await writeFile(join(root, "src/second.ts"), "export const second = 2;\n");
    await git(root, "init", "-q"); await git(root, "config", "user.name", "Filename Test");
    await git(root, "config", "user.email", "filename@test.local"); await git(root, "add", ".");
    await git(root, "commit", "-qm", "baseline");
    const logger = new Logger(join(root, ".git", "fallback-log"), "filename-only", true);
    const gateway = new Gateway(await config(undefined, { models: {} }), logger,
      new Budget(1, 100000, 60000));
    let calls = 0;
    (gateway as any).call = async () => {
      calls++;
      return { role: "assistant", content: "I could not identify the implementation." };
    };
    const objective = "Implement the requested behavior with a focused test";
    const work: Subtask = { id: "stable", title: objective, objective, dependsOn: [],
      likelyReadPaths: ["src/first.ts", "src/second.ts"], likelyWritePaths: [], readOnly: true,
      integrationContract: "", verificationCommands: [], estimatedDifficulty: "normal", parallelSafe: false };
    await assert.rejects(prepareStableWorker(gateway, root, objective, work,
      await profileRepo(root), { files: [], repoMap: ["src/first.ts", "src/second.ts"],
        localDependencies: [] }), /no actionable evidence/i);
    assert.equal(calls, 1);
    assert.equal(logger.events.filter((event) => event.type === "stable_actionable_scope_fallback").length, 1);
    assert.deepEqual(logger.events.find((event) =>
      event.type === "stable_actionable_scope_fallback")?.paths, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("deterministic Stable repair locks source before any inspection-model call and keeps test read-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-stable-local-scope-"));
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "tests"));
    await writeFile(join(root, "src/checkout.js"),
      "import { subtotal } from './subtotal.js'; export const total = (items) => subtotal(items) - 1;\n");
    await writeFile(join(root, "src/subtotal.js"), "export const subtotal = (items) => items.length;\n");
    await writeFile(join(root, "tests/checkout.test.js"),
      "import { test } from 'node:test'; import { total } from '../src/checkout.js'; test('total', () => { if (total([1,2]) !== 2) throw Error('wrong'); });\n");
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" } }));
    await git(root, "init", "-q");
    await git(root, "config", "user.name", "Stable Scope Test");
    await git(root, "config", "user.email", "stable-scope@test.local");
    await git(root, "add", ".");
    await git(root, "commit", "-qm", "baseline");
    const logger = new Logger(join(root, "log"), "local-stable", true);
    const gateway = new Gateway(await config(undefined, { models: {} }), logger,
      new Budget(1, 100000, 60000));
    (gateway as any).call = async () => { throw Error("inspection model must not be called"); };
    const objective = "Fix src/checkout.js total while preserving subtotal behavior. Verify tests pass.";
    const subtask: Subtask = { id: "stable", title: objective, objective, dependsOn: [],
      likelyReadPaths: ["src/checkout.js", "src/subtotal.js", "tests/checkout.test.js"],
      likelyWritePaths: [], readOnly: true, integrationContract: "Preserve subtotal",
      verificationCommands: [], estimatedDifficulty: "normal", parallelSafe: false };
    const prepared = await prepareStableWorker(gateway, root, objective, subtask,
      await profileRepo(root), { files: [
        { path: "src/checkout.js", snippet: "export const total = (items) => subtotal(items) - 1;" },
        { path: "src/subtotal.js", snippet: "export const subtotal = (items) => items.length;" },
        { path: "tests/checkout.test.js", snippet: "import { total } from '../src/checkout.js'" },
      ], repoMap: ["src/checkout.js", "src/subtotal.js", "tests/checkout.test.js"], localDependencies: [] });
    assert.deepEqual(prepared.writePaths, ["src/checkout.js"]);
    assert.equal(logger.events.filter((event) => event.type === "model_call").length, 0);
    assert.equal(logger.events.find((event) => event.type === "stable_scope_locked")?.deterministic, true);
    assert.ok(prepared.evidence.relevantFiles.includes("tests/checkout.test.js"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Stable resolves a test-to-wrapper-to-implementation chain without model inspection", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-stable-import-chain-"));
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "tests"));
    await writeFile(join(root, "src/response.js"),
      "import { findUser } from './users.js'; export const response = (id) => findUser(id);\n");
    await writeFile(join(root, "src/users.js"), "export const findUser = (id) => ({ id: -1 });\n");
    await writeFile(join(root, "tests/response.test.js"),
      "import { test } from 'node:test'; import { response } from '../src/response.js'; test('user lookup', () => { if (response(3).id !== 3) throw Error('wrong user'); });\n");
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" } }));
    await git(root, "init", "-q");
    await git(root, "config", "user.name", "Stable Scope Test");
    await git(root, "config", "user.email", "stable-scope@test.local");
    await git(root, "add", ".");
    await git(root, "commit", "-qm", "baseline");
    const logger = new Logger(join(root, "log"), "chain-stable", true);
    const gateway = new Gateway(await config(undefined, { models: {} }), logger,
      new Budget(1, 100000, 60000));
    (gateway as any).call = async () => { throw Error("inspection model must not be called"); };
    const objective = "Fix user lookup shown by tests/response.test.js; preserve the response wrapper.";
    const subtask: Subtask = { id: "stable", title: objective, objective, dependsOn: [],
      likelyReadPaths: ["tests/response.test.js", "src/response.js", "src/users.js"],
      likelyWritePaths: [], readOnly: true, integrationContract: "Keep the wrapper",
      verificationCommands: [], estimatedDifficulty: "normal", parallelSafe: false };
    const prepared = await prepareStableWorker(gateway, root, objective, subtask,
      await profileRepo(root), { files: [
        { path: "tests/response.test.js", snippet: "response(3).id !== 3" },
        { path: "src/response.js", snippet: "response = (id) => findUser(id)" },
        { path: "src/users.js", snippet: "findUser = (id) => ({ id: -1 })" },
      ], repoMap: ["tests/response.test.js", "src/response.js", "src/users.js"], localDependencies: [] });
    assert.deepEqual(prepared.writePaths, ["src/users.js"]);
    assert.ok(prepared.evidence.relevantFiles.includes("tests/response.test.js"));
    assert.equal(logger.events.filter((event) => event.type === "model_call").length, 0);
    const apiTask = "Fix the user API response behavior so existing users still work and missing users return the expected 404 response. Verify all tests.";
    const apiPrepared = await prepareStableWorker(gateway, root, apiTask,
      { ...subtask, title: apiTask, objective: apiTask }, await profileRepo(root),
      { files: [
        { path: "tests/response.test.js", snippet: "import { response } from '../src/response.js'" },
        { path: "src/response.js", snippet: "response = (id) => findUser(id)" },
        { path: "src/users.js", snippet: "findUser = (id) => ({ id: -1 })" },
      ], repoMap: ["tests/response.test.js", "src/response.js", "src/users.js"], localDependencies: [] });
    assert.deepEqual(apiPrepared.writePaths, ["src/response.js"]);
    assert.equal(logger.events.filter((event) => event.type === "model_call").length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("coupled implementation and test paths lock together while unrelated files stay unwritable", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-coupled-scope-"));
  const repo = join(root, "repo");
  try {
    await mkdir(join(repo, "src"), { recursive: true });
    await mkdir(join(repo, "tests"), { recursive: true });
    await writeFile(join(repo, "src/a.ts"), "export const a = 1;\n");
    await writeFile(join(repo, "src/unrelated.ts"), "export const unrelated = 1;\n");
    await writeFile(join(repo, "tests/a.test.ts"), "// focused test\n");
    await git(repo, "init", "-q");
    await git(repo, "config", "user.name", "Stable Scope Test");
    await git(repo, "config", "user.email", "stable-scope@test.local");
    await git(repo, "add", ".");
    await git(repo, "commit", "-qm", "baseline");
    const logger = new Logger(join(root, "log"), "coupled-scope", true);
    const gateway = new Gateway(await config(undefined, { models: {} }), logger,
      new Budget(1, 100000, 60000));
    let calls = 0;
    (gateway as any).call = async () => {
      calls++;
      return calls === 1
        ? { role: "assistant", content: null, tool_calls: [{ id: "read", type: "function",
            function: { name: "read_file", arguments: JSON.stringify({ path: "src/a.ts" }) } }] }
        : { role: "assistant", content: null, tool_calls: [{ id: "lock", type: "function",
            function: { name: "lock_write_scope", arguments: JSON.stringify({
              paths: ["src/a.ts", "tests/a.test.ts"], reason: "Fix and test the requested issue",
            }) } }] };
    };
    const subtask: Subtask = { id: "stable", title: "Fix a and test", objective: "Fix src/a.ts and add a test",
      dependsOn: [], likelyReadPaths: ["src/a.ts"], likelyWritePaths: [], readOnly: true,
      integrationContract: "focused test", verificationCommands: [], estimatedDifficulty: "normal", parallelSafe: false };
    const prepared = await prepareStableWorker(gateway, repo, subtask.objective, subtask,
      await profileRepo(repo), { files: [{ path: "src/a.ts", snippet: "export const a = 1;" }],
        repoMap: ["src/a.ts", "tests/a.test.ts"], localDependencies: [] });
    assert.deepEqual(prepared.writePaths, ["src/a.ts", "tests/a.test.ts"]);
    assert.equal(calls, 1, "decisive source and matching test avoid model finalization");
    const tools = new AgentTools(repo, false, 1000, logger, "stable", 4000,
      new WriteScope(prepared.writePaths, logger, "stable"));
    await assert.rejects(tools.execute("write_file", { path: "src/unrelated.ts", content: "bad" }));
    assert.equal(await readFile(join(repo, "src/unrelated.ts"), "utf8"), "export const unrelated = 1;\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Stable finalizes after relevant reads and locks coupled feature and focused test files", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-stable-feature-scope-"));
  const repo = join(root, "repo");
  try {
    await mkdir(join(repo, "src"), { recursive: true });
    await mkdir(join(repo, "tests"), { recursive: true });
    await writeFile(join(repo, "src/cli.ts"), "export const cli = 'flag';\n");
    await writeFile(join(repo, "src/run.ts"), "export const run = 'flag';\n");
    await writeFile(join(repo, "src/unrelated.ts"), "export const unrelated = 1;\n");
    await writeFile(join(repo, "tests/cli.test.ts"), "// flag test\n");
    await git(repo, "init", "-q");
    await git(repo, "config", "user.name", "Stable Feature Test");
    await git(repo, "config", "user.email", "stable-feature@test.local");
    await git(repo, "add", ".");
    await git(repo, "commit", "-qm", "baseline");
    const logger = new Logger(join(root, "log"), "feature-scope", true);
    const gateway = new Gateway(await config(undefined, { models: {} }), logger,
      new Budget(1, 100000, 60000));
    const requests: { tools: string[]; limits: any }[] = [];
    (gateway as any).call = async (_model: string, _messages: unknown,
      _subtask: string, _stage: string, _iteration: number, tools: any[], limits: any) => {
      requests.push({ tools: tools.map((tool) => tool.function.name), limits });
      return requests.length === 1
        ? { role: "assistant", content: null, tool_calls: [
            { id: "cli", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "src/cli.ts" }) } },
            { id: "run", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "src/run.ts" }) } },
          ] }
        : { role: "assistant", content: null, tool_calls: [
            { id: "lock", type: "function", function: { name: "lock_write_scope", arguments: JSON.stringify({
              paths: ["src/cli.ts", "src/run.ts", "tests/cli.test.ts"], reason: "Plumb the flag through CLI and run with a focused test",
            }) } },
          ] };
    };
    const subtask: Subtask = { id: "stable", title: "Add CLI flag", objective: "Add a flag in src/cli.ts and src/run.ts with focused tests",
      dependsOn: [], likelyReadPaths: ["src/cli.ts", "src/run.ts"], likelyWritePaths: [], readOnly: true,
      integrationContract: "focused tests", verificationCommands: [], estimatedDifficulty: "normal", parallelSafe: false };
    const result = await prepareStableWorker(gateway, repo, subtask.objective, subtask,
      await profileRepo(repo), { files: [], repoMap: [], localDependencies: [] });
    assert.deepEqual(result.writePaths, ["src/cli.ts", "src/run.ts", "tests/cli.test.ts"]);
    assert.equal(requests.length, 1, "decisive coupled source and test evidence skips finalization");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ambiguous Stable scope times out within the configured finalization budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-stable-scope-timeout-"));
  const repo = join(root, "repo");
  try {
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, "src/a.ts"), "export const a = 1;\n");
    await git(repo, "init", "-q");
    await git(repo, "config", "user.name", "Stable Timeout Test");
    await git(repo, "config", "user.email", "stable-timeout@test.local");
    await git(repo, "add", ".");
    await git(repo, "commit", "-qm", "baseline");
    const logger = new Logger(join(root, "log"), "scope-timeout", true);
    const gateway = new Gateway(await config(undefined, { models: {}, commandTimeoutMs: 60 }),
      logger, new Budget(1, 100000, 60000));
    let calls = 0;
    (gateway as any).call = async () => {
      calls++;
      if (calls === 1) return { role: "assistant", content: null, tool_calls: [{
        id: "read", type: "function", function: { name: "read_file", arguments: '{"path":"src/a.ts"}' },
      }] };
      return new Promise(() => {});
    };
    const task = "Inspect src/a.ts and find a small issue to fix";
    const subtask: Subtask = { id: "stable", title: task, objective: task,
      dependsOn: [], likelyReadPaths: ["src/a.ts"], likelyWritePaths: [], readOnly: true,
      integrationContract: "focused change", verificationCommands: [], estimatedDifficulty: "normal", parallelSafe: false };
    const started = Date.now();
    await assert.rejects(prepareStableWorker(gateway, repo, task, subtask, await profileRepo(repo),
      { files: [], repoMap: [], localDependencies: [] }), /scope finalization timed out/);
    assert.ok(Date.now() - started < 1500, "hanging provider must not hold the scope phase");
    assert.equal(calls, 2, "timeout does not start a second hanging correction");
    assert.equal(await readFile(join(repo, "src/a.ts"), "utf8"), "export const a = 1;\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reading an unrelated file does not authorize it as a Stable write path", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-stable-unrelated-scope-"));
  const repo = join(root, "repo");
  try {
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, "src/cli.ts"), "export const cli = 'flag';\n");
    await writeFile(join(repo, "src/unrelated.ts"), "export const unrelated = 1;\n");
    await git(repo, "init", "-q");
    await git(repo, "config", "user.name", "Stable Scope Test");
    await git(repo, "config", "user.email", "stable-scope@test.local");
    await git(repo, "add", ".");
    await git(repo, "commit", "-qm", "baseline");
    const logger = new Logger(join(root, "log"), "unrelated-scope", true);
    const gateway = new Gateway(await config(undefined, { models: {} }), logger,
      new Budget(1, 100000, 60000));
    let calls = 0;
    (gateway as any).call = async () => {
      calls++;
      return calls === 1
        ? { role: "assistant", content: null, tool_calls: [
            { id: "cli", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "src/cli.ts" }) } },
            { id: "other", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "src/unrelated.ts" }) } },
          ] }
        : { role: "assistant", content: null, tool_calls: [
            { id: `lock-${calls}`, type: "function", function: { name: "lock_write_scope", arguments: JSON.stringify({
              paths: ["src/cli.ts", "src/unrelated.ts"], reason: "Attempt to include an unrelated inspected file",
            }) } },
          ] };
    };
    const subtask: Subtask = { id: "stable", title: "Add CLI flag", objective: "Add a CLI flag in src/cli.ts",
      dependsOn: [], likelyReadPaths: ["src/cli.ts"], likelyWritePaths: [], readOnly: true,
      integrationContract: "focused tests", verificationCommands: [], estimatedDifficulty: "normal", parallelSafe: false };
    const prepared = await prepareStableWorker(gateway, repo, subtask.objective, subtask,
      await profileRepo(repo), { files: [], repoMap: [], localDependencies: [] });
    assert.deepEqual(prepared.writePaths, ["src/cli.ts"]);
    assert.equal(calls, 1);
    assert.equal(await readFile(join(repo, "src/unrelated.ts"), "utf8"), "export const unrelated = 1;\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("inspected CLI routing plumbing and its focused test are authorized, but arbitrary tests are not", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-stable-routing-scope-"));
  const repo = join(root, "repo");
  try {
    await mkdir(join(repo, "src/router"), { recursive: true });
    await mkdir(join(repo, "tests"), { recursive: true });
    await writeFile(join(repo, "src/cli.ts"), "import { run } from './run.js'; export const cli = run;\n");
    await writeFile(join(repo, "src/run.ts"), "import { route } from './router/modelRouter.js'; export const run = route;\n");
    await writeFile(join(repo, "src/router/modelRouter.ts"), "import { fingerprint } from './taskFingerprint.js'; export const route = fingerprint;\n");
    await writeFile(join(repo, "src/router/taskFingerprint.ts"), "export const fingerprint = 'routing';\n");
    await writeFile(join(repo, "tests/modelRouter.test.ts"), "import { route } from '../src/router/modelRouter.js'; // focused route test\n");
    await writeFile(join(repo, "tests/unrelated.test.ts"), "export const unrelated = true;\n");
    await git(repo, "init", "-q");
    await git(repo, "config", "user.name", "Stable Routing Test");
    await git(repo, "config", "user.email", "stable-routing@test.local");
    await git(repo, "add", ".");
    await git(repo, "commit", "-qm", "baseline");
    const profile = await profileRepo(repo);
    const sourcePaths = ["src/cli.ts", "src/run.ts", "src/router/modelRouter.ts", "src/router/taskFingerprint.ts"];
    const task = "Add --explain-routing to the CLI and focused tests";
    const subtask: Subtask = { id: "stable", title: task, objective: task, dependsOn: [],
      likelyReadPaths: sourcePaths, likelyWritePaths: [], readOnly: true,
      integrationContract: "focused tests", verificationCommands: [], estimatedDifficulty: "normal", parallelSafe: false };
    for (const testPath of ["tests/modelRouter.test.ts", "tests/unrelated.test.ts"]) {
      const logger = new Logger(join(root, `log-${testPath.split("/").at(-1)}`), "routing-scope", true);
      const gateway = new Gateway(await config(undefined, { models: {} }), logger,
        new Budget(1, 100000, 60000));
      let calls = 0;
      (gateway as any).call = async (_model: string, messages: any[],
        _subtask: string, _stage: string, _iteration: number, tools: any[]) => {
        calls++;
        if (calls === 1)
          return { role: "assistant", content: null, tool_calls: sourcePaths.map((file, i) => ({
            id: `read-${i}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: file }) },
          })) };
        assert.deepEqual(tools.map((tool) => tool.function.name), ["lock_write_scope", "report_no_scope"]);
        assert.ok(JSON.stringify(messages).length < 3000, "finalization sends a compact evidence summary");
        assert.ok(!JSON.stringify(messages).includes("export const fingerprint"), "source contents are not resent");
        return { role: "assistant", content: null, tool_calls: [{
          id: `lock-${calls}`, type: "function", function: { name: "lock_write_scope", arguments: JSON.stringify({
            paths: [...sourcePaths, testPath], reason: "Plumb routing metadata through CLI, run, and router with a focused test",
          }) },
        }] };
      };
      const prepared = prepareStableWorker(gateway, repo, task, subtask, profile,
        { files: [], repoMap: sourcePaths, localDependencies: [] });
      if (testPath === "tests/modelRouter.test.ts") {
        assert.deepEqual((await prepared).writePaths, [...sourcePaths, testPath]);
        assert.equal(calls, 2, "ambiguous coupled feature uses one scope finalization call");
      } else {
        const fallback = await prepared;
        assert.ok(!fallback.writePaths.includes("tests/unrelated.test.ts"));
        assert.ok(fallback.writePaths.every((file) => sourcePaths.includes(file) ||
          file === "tests/modelRouter.test.ts"));
        assert.equal(calls, 3, "invalid scope gets only one correction");
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function repairFixture(repairContent: string, endlessTools = false, noScope = false) {
  const root = await mkdtemp(join(tmpdir(), "koda-stable-repair-"));
  const repo = join(root, "repo");
  const output = join(root, "output");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src/a.ts"), "export const a = 1;\n");
  await git(repo, "init", "-q");
  await git(repo, "config", "user.name", "Stable Repair Test");
  await git(repo, "config", "user.email", "stable-repair@test.local");
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "baseline");
  const profile = await profileRepo(repo);
  const logger = new Logger(output, "stable-repair", true);
  const gateway = new Gateway(
    await config(undefined, { models: {} }),
    logger,
    new Budget(1, 100000, 60000),
  );
  const calls: { tools: unknown; stage: string; limits: any }[] = [];
  (gateway as any).call = async (
    _model: string,
    _messages: unknown,
    _subtask: string,
    stage: string,
    _iteration: number,
    tools: unknown,
    limits: any,
  ) => {
    calls.push({ tools, stage, limits });

    if (calls.length === 1 || endlessTools) {
      return {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `read-a-${calls.length}`,
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: "src/a.ts" }),
            },
          },
        ],
      };
    }

    return {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: `lock-${calls.length}`,
          type: "function",
          function: {
            name: noScope ? "report_no_scope" : "lock_write_scope",
            arguments: noScope ? JSON.stringify({ reason: "No safe actionable issue was found in the inspected source" }) :
              calls.length === 2 ? JSON.stringify({}) : repairContent,
          },
        },
      ],
    };
  };

  const subtask: Subtask = {
    id: "stable",
    title: "Inspect and fix a",
    objective: "Inspect and fix src/a.ts",
    dependsOn: [],
    likelyReadPaths: ["src/a.ts"],
    likelyWritePaths: [],
    readOnly: true,
    integrationContract: "Declare the exact write scope",
    verificationCommands: [],
    estimatedDifficulty: "normal",
    parallelSafe: false,
  };
  const prepared = prepareStableWorker(
    gateway,
    repo,
    subtask.objective,
    subtask,
    profile,
    {
      files: [{ path: "src/a.ts", snippet: "export const a = 1;\n" }],
      repoMap: ["src/a.ts"],
      localDependencies: [],
    },
  );
  return { root, repo, calls, prepared };
}

test("invalid lock_write_scope arguments can be corrected in the same bounded inspection", async () => {
  const fixture = await repairFixture(JSON.stringify({ paths: ["src/a.ts"], reason: "Fix the inspected source file" }));
  try {
    assert.deepEqual((await fixture.prepared).writePaths, ["src/a.ts"]);
    assert.equal(fixture.calls.length, 3);
    assert.ok(fixture.calls.every((call) => call.tools));
    assert.ok(
      fixture.calls[0]!.limits.timeoutMs === 30000 &&
      fixture.calls.slice(1).every((call) =>
        call.limits.timeoutMs <= 10000 && call.limits.requireTool === true),
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("failed lock_write_scope attempts leave the workspace unchanged", async () => {
  const fixture = await repairFixture("still not JSON");
  try {
    await assert.rejects(
      fixture.prepared,
      /bounded budget without locking a write scope/,
    );
    assert.equal(fixture.calls.length, 3);
    assert.ok(fixture.calls.every((call) => call.tools));
    assert.deepEqual(
      (fixture.calls.at(-1)!.tools as any[]).map((tool) => tool.function.name),
      ["lock_write_scope", "report_no_scope"],
    );
    assert.equal(
      await readFile(join(fixture.repo, "src/a.ts"), "utf8"),
      "export const a = 1;\n",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("non-actionable stable inspection stops before coding", async () => {
  const fixture = await repairFixture("", false, true);

  try {
    await assert.rejects(
      fixture.prepared,
      /no actionable scope/,
    );
    assert.equal(fixture.calls.length, 2);
    assert.deepEqual(fixture.calls.map((call) => call.stage), ["inspect", "finalize"]);
    assert.ok(fixture.calls.every((call) => call.tools));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("stable inspection tool use has a hard bounded termination", async () => {
  const fixture = await repairFixture("", true);

  try {
    await assert.rejects(
      fixture.prepared,
      /bounded budget without locking a write scope/,
    );
    assert.equal(fixture.calls.length, 3);
    assert.ok(fixture.calls.every((call) => call.tools));
    assert.deepEqual(
      (fixture.calls.at(-1)!.tools as any[]).map((tool) => tool.function.name),
      ["lock_write_scope", "report_no_scope"],
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("stable mode locks scope, preserves work across transient fallback, and verifies once", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-stable-"));
  const repo = join(root, "repo");
  const output = join(root, "report");
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "tests"));
  await writeFile(
    join(repo, "package.json"),
    JSON.stringify({
      type: "commonjs",
      scripts: {
        test: "node --test tests/*.test.cjs",
        typecheck: "node --check src/calculator.cjs",
      },
    }),
  );
  await writeFile(
    join(repo, "src/calculator.cjs"),
    "exports.add=(a,b)=>a-b;\n",
  );
  await writeFile(
    join(repo, "tests/calculator.test.cjs"),
    "const {test}=require('node:test');const assert=require('node:assert/strict');const {add}=require('../src/calculator.cjs');test('positive',()=>assert.equal(add(2,3),5));\n",
  );
  await git(repo, "init", "-q");
  await git(repo, "config", "user.name", "Stable Test");
  await git(repo, "config", "user.email", "stable@test.local");
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "broken");

  const requests: any[] = [];
  let cheapCodingCalls = 0;
  let strongCodingCalls = 0;
  let repairCodingCalls = 0;
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith("/models")) {
      res.end(
        JSON.stringify({
          data: ["cheap", "strong"].map((id) => ({
            id,
            context_length: 100000,
            pricing: { prompt: "0.0000001", completion: "0.0000002" },
            supported_parameters: ["tools", "tool_choice", "structured_outputs"],
          })),
        }),
      );
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const inspection = body.messages[0].content.includes("read-only inspection phase") ||
      body.tools?.some((tool: any) => tool.function?.name === "lock_write_scope");
    if (inspection) {
      const declarationPayload = {
        paths: ["src/calculator.cjs", "tests/calculator.test.cjs"],
        reason: "Fix addition and add a focused regression test",
      };

      const message =
        body.tools?.some((tool: any) => tool.function?.name === "read_file")
          ? {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "read-source",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: JSON.stringify({
                      path: "src/calculator.cjs",
                    }),
                  },
                },
                {
                  id: "read-test",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: JSON.stringify({
                      path: "tests/calculator.test.cjs",
                    }),
                  },
                },
              ],
            }
          : {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "lock-stable-scope",
                  type: "function",
                  function: {
                    name: "lock_write_scope",
                    arguments: JSON.stringify(declarationPayload),
                  },
                },
              ],
            };

      res.end(
        JSON.stringify({
          id: "inspection",
          model: body.model,
          choices: [{ index: 0, message }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 10,
            cost: 0,
          },
        }),
      );
      return;
    }

    if (
      body.messages[0].content.includes(
        "repairing one failed Stable final verification",
      )
    ) {
      repairCodingCalls++;
      const repairInput = JSON.parse(body.messages[1].content);
      assert.equal(repairInput.repairAttempt, 1);
      assert.equal(repairInput.failedChecks[0].command, "npm run test");
      assert.match(repairInput.failedChecks[0].stdout, /calculator\.test\.cjs/);
      assert.deepEqual(repairInput.lockedWritePaths, [
        "src/calculator.cjs",
        "tests/calculator.test.cjs",
      ]);
      assert.ok(
        repairInput.currentLockedFiles.some(
          (file: any) =>
            file.path === "src/calculator.cjs" && file.content.includes("a+b"),
        ),
      );
      assert.deepEqual(repairInput.changedFiles, [
        "src/calculator.cjs",
        "tests/calculator.test.cjs",
      ]);
      assert.equal(repairInput.context, undefined);
      assert.equal(repairInput.profile, undefined);
      assert.ok(
        body.tools.every((tool: any) =>
          ["write_file", "run_command"].includes(tool.function.name),
        ),
      );
      const message = {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "repair-final-test",
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({
                path: "tests/calculator.test.cjs",
                content:
                  "const {test}=require('node:test');const assert=require('node:assert/strict');const {add}=require('../src/calculator.cjs');test('positive',()=>assert.equal(add(2,3),5));test('negative',()=>assert.equal(add(-2,3),1));\n",
              }),
            },
          },
        ],
      };
      res.end(
        JSON.stringify({
          id: "stable-final-repair",
          model: body.model,
          choices: [{ index: 0, message }],
          usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0 },
        }),
      );
      return;
    }

    if (body.model === "cheap") {
      cheapCodingCalls++;
      res.writeHead(520);
      res.end(JSON.stringify({ error: { message: "transient upstream" } }));
      return;
    }
    if (body.model === "strong") {
      strongCodingCalls++;
      const message = { role: "assistant", content: null, tool_calls: [{
        id: "implement-both", type: "function", function: {
          name: "apply_patch", arguments: JSON.stringify({ edits: [
            { path: "src/calculator.cjs", oldText: "a-b", newText: "a+b" },
            { path: "tests/calculator.test.cjs", oldText: "test('positive'", newText: "test('negative',()=>assert.equal(add(-2,3),1));test('positive'" },
          ] }),
        },
      }] };
      res.end(JSON.stringify({ id: "strong-mutation", model: body.model,
        choices: [{ index: 0, message }],
        usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0 } }));
      return;
    }
    if (body.model === "cheap" && cheapCodingCalls++ === 0) {
      const availableTools = body.tools.map((tool: any) => tool.function.name);
      assert.ok(availableTools.includes("read_file"));
      assert.ok(!availableTools.includes("search_code"));
      assert.ok(!availableTools.includes("list_files"));
      const message = {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "implementation-read",
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: "src/calculator.cjs" }),
            },
          },
        ],
      };
      res.end(
        JSON.stringify({
          id: "cheap-read",
          model: body.model,
          choices: [{ index: 0, message }],
          usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0 },
        }),
      );
      return;
    }
    if (body.model === "cheap" && cheapCodingCalls === 2) {
      const availableTools = body.tools.map((tool: any) => tool.function.name);
      assert.deepEqual(availableTools, ["write_file", "run_command"]);
      assert.equal(body.tool_choice, "required");
      res.end(
        JSON.stringify({
          id: "cheap-missing-required-tool",
          model: body.model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "blocked-rediscovery",
                    type: "function",
                    function: {
                      name: "run_command",
                      arguments: JSON.stringify({
                        command: "rg -n 'add' src tests",
                      }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0 },
        }),
      );
      return;
    }
    if (body.model === "cheap" && cheapCodingCalls === 3) {
      // The first exact-text mutation assumes stale source and exits without
      // touching the workspace. Stable must recover with a bounded reread.
      res.end(
        JSON.stringify({
          id: "cheap-failed-mutation",
          model: body.model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "failed-replace",
                    type: "function",
                    function: {
                      name: "run_command",
                      arguments: JSON.stringify({
                        command:
                          "node -e \"const fs=require('fs'); const p='src/calculator.cjs'; const s=fs.readFileSync(p,'utf8'); if(!s.includes('missing exact text'))process.exit(1); fs.writeFileSync(p,s.replace('missing exact text','fixed'))\"",
                      }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0 },
        }),
      );
      return;
    }
    if (body.model === "cheap" && cheapCodingCalls === 4) {
      assert.ok(
        body.tools.some((tool: any) => tool.function.name === "read_file"),
      );
      res.end(
        JSON.stringify({
          id: "cheap-exact-reread",
          model: body.model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "reread-locked-source",
                    type: "function",
                    function: {
                      name: "read_file",
                      arguments: JSON.stringify({ path: "src/calculator.cjs" }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0 },
        }),
      );
      return;
    }
    if (body.model === "cheap" && cheapCodingCalls === 5) {
      const availableTools = body.tools.map((tool: any) => tool.function.name);
      assert.deepEqual(availableTools, ["write_file", "run_command"]);
      assert.equal(body.tool_choice, "required");
      const message = {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "fix-source",
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({
                path: "src/calculator.cjs",
                content: "exports.add=(a,b)=>a+b;\n",
              }),
            },
          },
        ],
      };
      res.end(
        JSON.stringify({
          id: "cheap-edit",
          model: body.model,
          choices: [{ index: 0, message }],
          usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0 },
        }),
      );
      return;
    }
    if (body.model === "cheap") {
      res.writeHead(520);
      res.end(JSON.stringify({ error: { message: "transient upstream" } }));
      return;
    }
    strongCodingCalls++;
    const message =
      strongCodingCalls === 1
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "add-regression",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({
                    path: "tests/calculator.test.cjs",
                    content:
                      "const {test}=require('node:test');const assert=require('node:assert/strict');const {add}=require('../src/calculator.cjs');test('positive',()=>assert.equal(add(2,3),5));test('negative',()=>assert.equal(add(-2,3),2));\n",
                  }),
                },
              },
            ],
          }
        : { role: "assistant", content: "Implementation complete." };
    res.end(
      JSON.stringify({
        id: "strong",
        model: body.model,
        choices: [{ index: 0, message }],
        usage: {
          prompt_tokens: strongCodingCalls === 1 ? 30010 : 10,
          completion_tokens: 10,
          cost: 0,
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const pool = {
      provider: "openrouter" as const,
      models: [
        {
          id: "cheap",
          tier: "fast" as const,
          qualityPrior: 0.95,
          latencyPriorMs: 100,
          strengths: ["coding", "tool_use", "structured_output"],
        },
        {
          id: "strong",
          tier: "strong" as const,
          qualityPrior: 0.99,
          latencyPriorMs: 1000,
          strengths: ["coding", "tool_use", "reasoning", "structured_output"],
        },
      ],
    };
    const result = await run({
      repo,
      task: "Inspect src/calculator.cjs and tests/calculator.test.cjs, find one small issue, fix it, and add a focused regression test. Do not change dependencies, do not weaken existing tests, and do not perform unrelated refactors.",
      config: await config(undefined, {
        modelPool: pool,
        baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
        routing: { stateDirectory: join(root, "routing") },
        budgetUsd: 0.1,
      }),
      output,
      quiet: true,
    });
    assert.equal(result.execution_strategy, "stable");
    assert.equal(result.plannerModelCalls, 0);
    assert.equal(result.coderExecutions, 2);
    assert.equal(result.status, "VERIFIED_SUCCESS", result.error);
    assert.equal(repairCodingCalls, 0);
    assert.equal(result.fallbacks, 1);
    const events = (await readFile(join(output, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    emitFixtureMetrics("stable-recovery-and-missing-test", result, events);
    const discoveryStart = events.find((event) => event.type === "stable_discovery_start");
    assert.deepEqual(discoveryStart.initial_write_scope, ["."]);
    const discoveryLock = events.find((event) =>
      event.type === "stable_discovery_scope_locked");
    assert.deepEqual(discoveryLock.actual_changed_paths,
      ["src/calculator.cjs", "tests/calculator.test.cjs"]);
    assert.deepEqual(discoveryLock.repair_write_scope,
      discoveryLock.actual_changed_paths);
    const codingStarts = events.filter(
      (event) =>
        event.type === "coding_worker_start" &&
        event.worker_engine === "mini-swe-agent",
    );
    const codingStops = events.filter(
      (event) =>
        event.type === "coding_worker_stop" &&
        event.worker_engine === "mini-swe-agent",
    );

    const firstCodingStart = events.findIndex((event) => event.type === "coding_worker_start");
    assert.equal(events.slice(0, firstCodingStart).some((event) =>
      (event.type === "verification" || event.type === "final_verification") &&
      /(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:build|test)\b/.test(event.command ?? "")), false,
    "ambiguous Stable does not run broad repository verification before mutation");

    assert.equal(codingStarts.length, 2);
    assert.equal(codingStops.length, 2);
    assert.deepEqual(
      codingStarts.map((event) => event.model),
      ["cheap", "strong"],
    );

    for (const event of codingStarts) {
      assert.deepEqual(event.assigned_write_scope, ["."],
        "initial and fallback mini-SWE attempts own the isolated Stable workspace");
    }

    assert.ok(
      events.some(
        (event) =>
          event.type === "mini_swe_fallback" &&
          event.from === "cheap" &&
          event.to === "strong",
      ),
      "operational failure should fall back from cheap to strong through mini-SWE",
    );

    assert.ok(
      events.some(
        (event) =>
          event.type === "mini_swe_attempt_verification" &&
          event.model === "strong" &&
          event.outcome === "VERIFIED_SUCCESS",
      ),
      "strong mini-SWE attempt should pass Koda verification",
    );

    assert.ok(events.some((event) =>
      event.type === "final_verification" && event.outcome === "CHECK_PASS"),
    "Koda final verification remains authoritative after mini-SWE discovery");

    assert.match(
      await readFile(
        join(result.integration!.path, "src/calculator.cjs"),
        "utf8",
      ),
      /a\+b/,
    );
    assert.match(
      await readFile(
        join(result.integration!.path, "tests/calculator.test.cjs"),
        "utf8",
      ),
      /negative/,
    );
    assert.equal(
      await readFile(join(repo, "src/calculator.cjs"), "utf8"),
      "exports.add=(a,b)=>a-b;\n",
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

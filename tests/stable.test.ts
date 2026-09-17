import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { config } from "../src/config.js";
import { run } from "../src/run.js";
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
    await assert.rejects(prepareStableWorker(gateway, repo, subtask.objective, subtask,
      await profileRepo(repo), { files: [], repoMap: [], localDependencies: [] }),
      /bounded budget without locking a write scope/);
    assert.equal(calls, 3);
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
        await assert.rejects(prepared, /bounded budget without locking a write scope/);
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
    assert.ok(fixture.calls.every((call) => call.stage === "inspect"));
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
    assert.equal(result.coderExecutions, 1);
    assert.equal(result.status, "VERIFIED_SUCCESS", result.error);
    assert.equal(repairCodingCalls, 0);
    assert.equal(result.fallbacks, 1);
    const events = (await readFile(join(output, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    emitFixtureMetrics("stable-recovery-and-missing-test", result, events);
    assert.deepEqual(
      events.find((event) => event.type === "stable_scope_locked")
        .allowed_write_paths,
      ["src/calculator.cjs", "tests/calculator.test.cjs"],
    );
    const firstCoderRequest = requests.find(
      (request) =>
        request.model === "cheap" &&
        !request.messages[0].content.includes("read-only inspection phase") &&
        !request.tools?.some((tool: any) => tool.function?.name === "lock_write_scope"),
    );
    assert.match(
      firstCoderRequest.messages[0].content,
      /Inspection is complete\. Implement the change now/,
    );
    const coderInput = JSON.parse(firstCoderRequest.messages[1].content);
    assert.match(coderInput.inspectionHandoff.issue, /Fix addition/);
    assert.match(coderInput.inspectionHandoff.requiredChange, /Inspect src\/calculator\.cjs/);
    assert.deepEqual(coderInput.inspectionHandoff.evidence.relevantFiles,
      ["src/calculator.cjs", "tests/calculator.test.cjs"]);
    assert.deepEqual(coderInput.repairPacket.allowedWritePaths,
      ["src/calculator.cjs", "tests/calculator.test.cjs"]);
    assert.deepEqual(coderInput.repairPacket.files.map((file: any) => file.path),
      coderInput.repairPacket.allowedWritePaths);
    assert.deepEqual(firstCoderRequest.tools.map((tool: any) => tool.function.name),
      ["apply_patch", "edit_file", "write_file"]);
    assert.equal(firstCoderRequest.tool_choice, "required");
    const lockedAt = events.findIndex(
      (event) => event.type === "stable_scope_locked",
    );
    assert.deepEqual(
      events
        .slice(lockedAt + 1)
        .filter((event) => event.type === "tool")
        .slice(0, 2)
        .map((event) => event.name),
      ["apply_patch"],
    );
    assert.equal(
      events.filter((event) => event.type === "verification").length,
      0,
    );
    assert.deepEqual(
      events.find((event) => event.type === "verification_selection").commands,
      ["npm run test", "npm run typecheck"],
    );
    assert.equal(
      events.filter((event) => event.type === "final_verification").length,
      2,
    );
    assert.ok(
      events
        .filter((event) => event.type === "final_verification")
        .slice(-2)
        .every((event) => event.outcome === "CHECK_PASS"),
    );
    assert.equal(events.filter((event) => event.type === "stable_repair_verification").length, 0);
    assert.ok(events.some((event) => event.type === "stable_focused_verification" && event.outcome === "CHECK_PASS"));
    assert.equal(
      events.find((event) => event.type === "ready_for_final_verification")
        .reason,
      "task_diff_verified",
    );
    assert.equal(events.filter((event) => event.type === "stable_action_repair").length, 0);
    assert.equal(events.filter((event) => event.type === "stable_mutation_repair").length, 0);
    const focused = events.find(
      (event) => event.type === "stable_context_focused",
    );
    assert.deepEqual(focused.files, [
      "src/calculator.cjs",
      "tests/calculator.test.cjs",
    ]);
    const fallback = events.find((event) => event.type === "model_fallback");
    assert.equal(fallback.previous_model, "cheap");
    assert.equal(fallback.selected_model, "strong");
    assert.ok(!events.some((event) => event.type === "specialist_outcome" &&
      event.model === "cheap" && event.verification === "FAILED"));
    assert.deepEqual(JSON.parse(requests.find((request) =>
      request.model === "strong" && !request.tools?.some((tool: any) =>
        tool.function?.name === "lock_write_scope")).messages[1].content)
      .repairPacket.allowedWritePaths, ["src/calculator.cjs", "tests/calculator.test.cjs"]);
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

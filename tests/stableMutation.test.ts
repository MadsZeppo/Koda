import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, symlink, link, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { config } from "../src/config.js";
import { run } from "../src/run.js";
import { git } from "../src/repo/commands.js";
import { AgentTools, toolDefinitions } from "../src/agent/tools.js";
import { WriteScope } from "../src/repo/writeScope.js";
import { Logger } from "../src/telemetry/logger.js";
import { buildRepairPacket } from "../src/agent/repairPacket.js";
import { profileRepo } from "../src/repo/profiler.js";
import { chooseExecutionStrategy } from "../src/router/executionStrategy.js";
import { taskFingerprint } from "../src/router/taskFingerprint.js";
import { extractFeatures } from "../src/router/features.js";
import { implement } from "../src/agent/loop.js";
import { Gateway } from "../src/openrouter/client.js";
import { Budget } from "../src/openrouter/usage.js";
import type { Subtask } from "../src/planner/schemas.js";

const dogfoodTask = "Add a CLI flag --explain-routing that prints the selected coding model, task fingerprint, quality reference, estimated quality gap, estimated cost, and fallback chain before execution. Keep normal behavior unchanged when the flag is absent. Add focused tests for the new flag.";

test("exact Stable CLI task mutates from a bounded RepairPacket before targeted verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-stable-mutation-"));
  const repo = join(root, "repo");
  const output = join(root, "output");
  const requests: any[] = [];
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.endsWith("/models")) {
      response.end(JSON.stringify({ data: [{ id: "coder", context_length: 100000,
        pricing: { prompt: "0.0000001", completion: "0.0000002" },
        supported_parameters: ["tools", "tool_choice", "structured_outputs"] }] }));
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const names = body.tools.map((tool: any) => tool.function.name);
    const tool = (id: string, name: string, args: object) => ({ id, type: "function",
      function: { name, arguments: JSON.stringify(args) } });
    let message: any;
    if (names.includes("lock_write_scope")) {
      assert.ok(names.includes("read_file"), "local evidence must avoid a scope-finalization model call");
      message = { role: "assistant", content: null, tool_calls: [
            tool("read-cli", "read_file", { path: "src/cli.ts" }),
            tool("read-run", "read_file", { path: "src/run.ts" }),
            tool("read-router", "read_file", { path: "src/router/modelRouter.ts" }),
          ] };
    } else {
      assert.deepEqual(names, ["apply_patch", "edit_file", "write_file"]);
      assert.equal(body.tool_choice, "required");
      const input = JSON.parse(body.messages[1].content);
      assert.deepEqual(input.repairPacket.allowedWritePaths,
        ["src/cli.ts", "src/run.ts", "tests/adaptiveCoding.test.cjs"]);
      assert.deepEqual(input.repairPacket.files.map((file: any) => file.path),
        input.repairPacket.allowedWritePaths);
      const large = input.repairPacket.files.find((file: any) => file.path === "src/run.ts");
      assert.equal(large.complete, false);
      assert.ok(large.content.length < 5000);
      message = { role: "assistant", content: null, tool_calls: [tool("patch", "apply_patch", { edits: [
        { path: "src/cli.ts", oldText: "const flag = false;", newText: "const flag = true;" },
        { path: "src/run.ts", oldText: "const routingInfo = 'hidden';", newText: "const routingInfo = 'visible';" },
        { path: "tests/adaptiveCoding.test.cjs", oldText: "assert.equal(true, true);", newText: "assert.equal(true, true); assert.match(require('node:fs').readFileSync('src/run.ts','utf8'), /visible/);" },
      ] })] };
    }
    response.end(JSON.stringify({ id: `mock-${requests.length}`, model: body.model,
      choices: [{ index: 0, message }], usage: { prompt_tokens: 20, completion_tokens: 20, cost: 0 } }));
  });
  try {
    await mkdir(join(repo, "src/router"), { recursive: true });
    await mkdir(join(repo, "tests"), { recursive: true });
    await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: {
      test: "node --test tests/*.test.cjs", typecheck: "node --check src/cli.ts",
    } }));
    await writeFile(join(repo, "src/cli.ts"), "import { run } from './run.js';\nconst flag = false;\nexport { run, flag };\n");
    await writeFile(join(repo, "src/run.ts"),
      "const routingInfo = 'hidden';\n" + "// routing context\n".repeat(500) + "export { routingInfo };\n");
    await writeFile(join(repo, "src/router/modelRouter.ts"), "export const model = 'coder';\n");
    await writeFile(join(repo, "tests/adaptiveCoding.test.cjs"),
      "const {test}=require('node:test'); const assert=require('node:assert/strict'); const related = \"require('../src/run.ts')\"; // src/cli.ts src/run.ts\ntest('routing explanation',()=>{assert.equal(true, true);});\n");
    await git(repo, "init", "-q");
    await git(repo, "config", "user.name", "Stable Mutation Test");
    await git(repo, "config", "user.email", "stable-mutation@test.local");
    await git(repo, "add", ".");
    await git(repo, "commit", "-qm", "baseline");
    const profile = await profileRepo(repo);
    assert.equal(chooseExecutionStrategy(dogfoodTask, profile).execution_strategy, "stable");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const result = await run({ repo, task: dogfoodTask, quiet: true, output,
      config: await config(undefined, { modelPool: { provider: "openrouter", models: [{
        id: "coder", tier: "fast", qualityPrior: 0.95, latencyPriorMs: 100,
        strengths: ["coding", "tool_use", "structured_output"],
      }] }, baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      routing: { stateDirectory: join(root, "routing") }, budgetUsd: 0.1 }) });
    assert.equal(result.status, "VERIFIED_SUCCESS", result.error);
    const events = (await readFile(join(output, "events.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    const lock = events.findIndex((event) => event.type === "stable_scope_locked");
    assert.equal(events[lock]?.deterministic, true);
    assert.equal(events.filter((event) => event.type === "stable_finalization_start").length, 0);
    assert.ok(events.findIndex((event) => event.type === "stable_context_focused") > lock);
    assert.equal(requests.length, 2, "one inspection call and one mutation call");
    const mutation = events.findIndex((event) => event.type === "write_success" && event.source === "apply_patch");
    const focused = events.findIndex((event) => event.type === "stable_focused_verification");
    const final = events.findIndex((event) => event.type === "final_verification");
    assert.ok(lock >= 0 && mutation > lock && focused > mutation && final > focused);
    assert.ok(!events.slice(lock, mutation).some((event) => event.type === "tool" &&
      ["read_file", "search_code", "run_command", "list_files"].includes(event.name)));
    assert.equal(events.find((event) => event.type === "task_fingerprint")?.fingerprint.primary, "implementation");
    assert.ok(events.find((event) => event.type === "task_fingerprint")?.fingerprint.secondary.includes("testing"));
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

for (const failure of ["timeout", "429", "no-scope"] as const) {
test(`Stable scope ${failure} falls back to concrete evidence and reaches verified coding`, async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-stable-scope-fallback-"));
  const repo = join(root, "repo"), output = join(root, "output");
  const requests: any[] = [];
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.endsWith("/models")) {
      response.end(JSON.stringify({ data: ["coder", "fallback"].map((id) => ({ id, context_length: 100000,
        pricing: { prompt: "0.0000001", completion: "0.0000002" },
        supported_parameters: ["tools", "tool_choice", "structured_outputs"] })) }));
      return;
    }
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    const names = body.tools?.map((tool: any) => tool.function.name) ?? [];
    const tool = (id: string, name: string, args: object) => ({ id, type: "function",
      function: { name, arguments: JSON.stringify(args) } });
    if (failure === "no-scope" && names.includes("search_code")) {
      response.end(JSON.stringify({ id: "no-scope", model: body.model, choices: [{ index: 0,
        message: { role: "assistant", content: null, tool_calls: [
          tool("none", "report_no_scope", { reason: "No safe scope could be identified by this model." }),
        ] } }], usage: { prompt_tokens: 20, completion_tokens: 20, cost: 0 } }));
      return;
    }
    if (names.includes("search_code")) {
      response.end(JSON.stringify({ id: "inspect", model: body.model, choices: [{ index: 0,
        message: { role: "assistant", content: null, tool_calls: [
          tool("search", "search_code", { query: "scope_target" }),
        ] } }], usage: { prompt_tokens: 20, completion_tokens: 20, cost: 0 } }));
      return;
    }
    if (names.includes("lock_write_scope")) {
      if (failure === "429") {
        response.statusCode = 429;
        response.end(JSON.stringify({ error: { message: "Provider returned error" } }));
        return;
      }
      // Simulate a provider that returns after Koda's hard scope deadline.
      await new Promise((resolve) => setTimeout(resolve, 3500));
      if (!response.destroyed) response.end(JSON.stringify({ id: "late", model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: "late" } }],
        usage: { prompt_tokens: 20, completion_tokens: 20, cost: 0 } }));
      return;
    }
    response.end(JSON.stringify({ id: "code", model: body.model, choices: [{ index: 0,
      message: { role: "assistant", content: null, tool_calls: [tool("fix", "write_file", {
        path: "src/a.js", content: "// scope_target\nexport function a(){ return true; }\n",
      })] } }], usage: { prompt_tokens: 20, completion_tokens: 20, cost: 0 } }));
  });
  try {
    await mkdir(join(repo, "src"), { recursive: true });
    await mkdir(join(repo, "tests"));
    await writeFile(join(repo, "src/a.js"), "// scope_target\nexport function a(){ return false; }\n");
    await writeFile(join(repo, "src/b.js"), "// scope_target\nexport const b = 1;\n");
    await writeFile(join(repo, "src/c.js"), "// scope_target\nexport const c = 1;\n");
    await writeFile(join(repo, "tests/a.test.js"), "import test from 'node:test'; import assert from 'node:assert/strict'; import {a} from '../src/a.js'; test('a',()=>assert.equal(a(),true));\n");
    await writeFile(join(repo, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" } }));
    await git(repo, "init", "-q"); await git(repo, "config", "user.name", "Scope Fallback");
    await git(repo, "config", "user.email", "scope@test.local"); await git(repo, "add", ".");
    await git(repo, "commit", "-qm", "baseline");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const task = "Inspect src/a.js, src/b.js, and src/c.js for scope_target, fix the localized behavior, and add a focused regression test.";
    const result = await run({ repo, task, output, quiet: true, config: await config(undefined, {
      modelPool: { provider: "openrouter", models: ["coder", "fallback"].map((id) => ({ id, tier: "fast" as const,
        qualityPrior: 0.95, latencyPriorMs: 100,
        strengths: ["coding", "tool_use", "structured_output"] })) },
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      commandTimeoutMs: 3000, routing: { stateDirectory: join(root, "routing") }, budgetUsd: 0.1,
    }) });
    assert.equal(result.execution_strategy, "stable");
    assert.equal(result.status, "VERIFIED_SUCCESS", result.error);
    const events = (await readFile(join(output, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.type === (failure === "no-scope"
      ? "stable_actionable_scope_fallback" : "stable_scope_finalization_fallback")));
    assert.equal(requests.filter((request) => request.tools?.some((tool: any) =>
      tool.function.name === "lock_write_scope") && !request.tools?.some((tool: any) =>
      tool.function.name === "search_code")).length, failure === "no-scope" ? 0 : 1,
      "no second finalizer model request");
    assert.ok(events.some((event) => event.type === "coding_worker_start"));
    assert.ok(events.some((event) => event.type === "write_success" && event.path === "src/a.js"));
    assert.ok(events.some((event) => event.type === "final_verification" && event.outcome === "CHECK_PASS"));
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

}

test("RepairPacket includes every locked path and bounds a large implementation file", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-repair-packet-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/cli.ts"), "const flag = false;\n");
    await writeFile(join(root, "src/run.ts"), "const routingInfo = 'hidden';\n" + "// filler\n".repeat(1200));
    const profile = await profileRepo(root);
    const { packet } = await buildRepairPacket(root, dogfoodTask, ["src/cli.ts", "src/run.ts"],
      profile, ["pnpm run test"], 16000);
    assert.deepEqual(packet.files.map((file) => file.path), packet.allowedWritePaths);
    assert.equal(packet.files[0]!.complete, true);
    assert.equal(packet.files[1]!.complete, false);
    assert.ok(packet.files[1]!.content.length < 5000);
    assert.deepEqual(packet.verificationCommands, ["pnpm run test"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("apply_patch validates multi-file hunks, creation, deletion and write-scope aliases before mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-apply-patch-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/a.ts"), "alpha\nbeta\ngamma\n");
    await writeFile(join(root, "src/b.ts"), "one\ntwo\n");
    await writeFile(join(root, "src/delete.ts"), "remove me\n");
    await writeFile(join(root, "src/outside.ts"), "outside\n");
    await symlink("outside.ts", join(root, "src/symlink.ts"));
    await link(join(root, "src/outside.ts"), join(root, "src/hardlink.ts"));
    const logger = new Logger(join(root, "log"), "apply-patch", true);
    const scope = new WriteScope(["src/a.ts", "src/b.ts", "src/new.ts", "src/delete.ts",
      "src/symlink.ts", "src/hardlink.ts"], logger, "stable");
    const tools = new AgentTools(root, false, 1000, logger, "stable", 4000, scope);
    await assert.rejects(tools.execute("apply_patch", { edits: [
      { path: "src/a.ts", oldText: "alpha", newText: "ALPHA" },
      { path: "src/b.ts", oldText: "missing", newText: "X" },
    ] }), /exactly once/);
    await tools.execute("apply_patch", { edits: [
      { path: "src/a.ts", oldText: "alpha", newText: "ALPHA" },
      { path: "src/a.ts", oldText: "gamma", newText: "GAMMA" },
    ] });
    assert.equal(await readFile(join(root, "src/a.ts"), "utf8"), "ALPHA\nbeta\nGAMMA\n");
    await tools.execute("apply_patch", { edits: [
      { path: "src/a.ts", oldText: "ALPHA", newText: "alpha" },
      { path: "src/a.ts", oldText: "GAMMA", newText: "gamma" },
    ] });
    assert.equal(await readFile(join(root, "src/a.ts"), "utf8"), "alpha\nbeta\ngamma\n");
    for (const path of ["src/outside.ts", "../escape.ts", "src/symlink.ts", "src/hardlink.ts"])
      await assert.rejects(tools.execute("apply_patch", { edits: [
        { path: "src/a.ts", oldText: "alpha", newText: "ALPHA" },
        { path, oldText: "outside", newText: "changed" },
      ] }));
    assert.equal(await readFile(join(root, "src/a.ts"), "utf8"), "alpha\nbeta\ngamma\n");
    assert.equal(await readFile(join(root, "src/outside.ts"), "utf8"), "outside\n");
    await tools.execute("apply_patch", { edits: [
      { path: "src/a.ts", hunks: [
        { oldText: "alpha", newText: "ALPHA" },
        { oldText: "gamma", newText: "GAMMA" },
      ] },
      { path: "src/b.ts", oldText: "two", newText: "TWO" },
      { path: "src/new.ts", createContent: "created\n" },
      { path: "src/delete.ts", delete: true },
    ] });
    assert.equal(await readFile(join(root, "src/a.ts"), "utf8"), "ALPHA\nbeta\nGAMMA\n");
    assert.equal(await readFile(join(root, "src/b.ts"), "utf8"), "one\nTWO\n");
    assert.equal(await readFile(join(root, "src/new.ts"), "utf8"), "created\n");
    await assert.rejects(readFile(join(root, "src/delete.ts")), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Stable retries a mechanical patch error with the same model, then requires mutation after context", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-stable-patch-recovery-"));
  const logRoot = await mkdtemp(join(tmpdir(), "koda-stable-patch-log-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/a.ts"), "import { b } from './b.js';\nexport const a = b + 1;\n");
    await writeFile(join(root, "src/b.ts"), "export const b = 1;\n");
    await git(root, "init", "-q");
    await git(root, "config", "user.name", "Patch Recovery Test");
    await git(root, "config", "user.email", "patch-recovery@test.local");
    await git(root, "add", ".");
    await git(root, "commit", "-qm", "baseline");
    const schema = toolDefinitions.find((tool: any) => tool.function.name === "apply_patch") as any;
    assert.deepEqual(Object.keys(schema.function.parameters.properties.edits.items.properties),
      ["path", "oldText", "newText"], "the model sees one canonical existing-file patch API");
    const logger = new Logger(join(logRoot, "log"), "patch-recovery", true);
    const gateway = new Gateway(await config(undefined, { models: {} }), logger,
      new Budget(1, 100000, 60000));
    const calls: { model: string; tools: string[]; messages: any[] }[] = [];
    const tool = (id: string, name: string, args: object) => ({ id, type: "function",
      function: { name, arguments: JSON.stringify(args) } });
    (gateway as any).call = async (model: string, messages: any[], _id: string,
      _stage: string, _iteration: number, offered: any[]) => {
      calls.push({ model, messages, tools: offered.map((item) => item.function.name) });
      if (calls.length === 1) return { role: "assistant", content: null, tool_calls: [
        tool("bad", "apply_patch", { edits: [{ path: "src/a.ts", oldText: "missing", newText: "fixed" }] }),
      ] };
      if (calls.length === 2) {
        assert.ok(JSON.stringify(messages).includes("oldText must occur exactly once"));
        assert.ok(JSON.stringify(messages).includes("export const a = b + 1"));
        assert.ok(offered.some((item) => item.function.name === "request_context"),
          JSON.stringify(offered.map((item) => item.function.name)));
        return { role: "assistant", content: null, tool_calls: [
          tool("context", "request_context", { path: "src/a.ts", symbol: "export const a" }),
        ] };
      }
      assert.equal(calls.length, 3);
      assert.ok(!JSON.stringify(messages).includes("request_context is limited"), "locked source context must be authorized");
      assert.ok(JSON.stringify(messages).includes("next response MUST call apply_patch"));
      assert.ok(!offered.some((item) => item.function.name === "request_context"));
      return { role: "assistant", content: null, tool_calls: [
        tool("good", "apply_patch", { edits: [{ path: "src/a.ts", oldText: "b + 1", newText: "b + 2" }] }),
      ] };
    };
    const profile = await profileRepo(root);
    const task = "Fix src/a.ts using src/b.ts";
    const subtask: Subtask = { id: "stable", title: task, objective: task,
      dependsOn: [], likelyReadPaths: ["src/a.ts", "src/b.ts"], likelyWritePaths: ["src/a.ts"],
      readOnly: false, integrationContract: "focused fix", verificationCommands: [],
      estimatedDifficulty: "normal", parallelSafe: false };
    const { packet, context } = await buildRepairPacket(root, task, ["src/a.ts"], profile, [], 16000);
    assert.ok(packet.importLinks.some(([, file]) => file === "src/b.ts"));
    await implement(gateway, root, task, subtask, { acceptanceCriteria: [task] }, profile, {
      compiledContext: context, repairPacket: packet, finalVerificationOnly: true,
      stableHandoff: { issue: "Correct the source", writePaths: ["src/a.ts"],
        evidence: { relevantFiles: ["src/a.ts", "src/b.ts"], symbols: [], reproduction: "read source",
          failingTests: [], likelyRootCause: "wrong offset", dependencies: ["src/b.ts"], uncertainty: "low",
          suggestedApproach: "replace offset", evidence: ["read src/a.ts"] },
        requiredChange: "Change b + 1 to b + 2", regressionTest: "Check the corrected source" },
    });
    assert.equal(await readFile(join(root, "src/a.ts"), "utf8"),
      "import { b } from './b.js';\nexport const a = b + 2;\n");
    assert.equal(new Set(calls.map((call) => call.model)).size, 1);
    assert.deepEqual(calls[0]!.tools, ["apply_patch", "edit_file", "write_file"]);
    assert.equal(logger.events.filter((event) => event.type === "stable_mutation_tool_recovery").length, 1);
    assert.ok(!logger.events.some((event) => event.type === "escalation"));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(logRoot, { recursive: true, force: true });
  }
});

for (const firstValue of [2, 9]) test(`Stable verifies a partial allowed scope immediately and ${firstValue === 9 ? "repairs once" : "finishes"}`, async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-stable-partial-scope-"));
  const logRoot = await mkdtemp(join(tmpdir(), "koda-stable-partial-log-"));
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "tests"));
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test tests/*.test.cjs" } }));
    for (const file of ["a", "b", "c"])
      await writeFile(join(root, `src/${file}.cjs`), "module.exports = 1;\n");
    for (const file of ["a", "b", "c"])
      await writeFile(join(root, `tests/${file}.test.cjs`),
        `const {test}=require('node:test'); const assert=require('node:assert/strict'); test('${file}',()=>assert.equal(require('../src/${file}.cjs'), ${file === "c" ? 1 : 2}));\n`);
    await git(root, "init", "-q");
    await git(root, "config", "user.name", "Partial Scope Test");
    await git(root, "config", "user.email", "partial-scope@test.local");
    await git(root, "add", ".");
    await git(root, "commit", "-qm", "baseline");
    const logger = new Logger(join(logRoot, "log"), "partial-scope", true);
    const gateway = new Gateway(await config(undefined, { models: {} }), logger,
      new Budget(1, 100000, 60000));
    let calls = 0;
    (gateway as any).call = async (_model: string, messages: any[], _id: string,
      _stage: string, _iteration: number, offered: any[]) => {
      calls++;
      assert.ok(offered.every((item) => ["apply_patch", "edit_file", "write_file", "request_context"]
        .includes(item.function.name)));
      if (calls === 2) assert.ok(JSON.stringify(messages).includes("currentLockedFiles"));
      return { role: "assistant", content: null, tool_calls: [{ id: `patch-${calls}`, type: "function",
        function: { name: "apply_patch", arguments: JSON.stringify({ edits: calls === 1
          ? [{ path: "src/a.cjs", oldText: "= 1", newText: `= ${firstValue}` },
             { path: "src/b.cjs", oldText: "= 1", newText: "= 2" }]
          : [{ path: "src/a.cjs", oldText: "= 9", newText: "= 2" }] }) } }] };
    };
    const profile = await profileRepo(root);
    const task = "Fix a and b with focused tests";
    const paths = ["src/a.cjs", "src/b.cjs", "src/c.cjs"];
    const subtask: Subtask = { id: "stable", title: task, objective: task,
      dependsOn: [], likelyReadPaths: paths, likelyWritePaths: paths, readOnly: false,
      integrationContract: "focused tests", verificationCommands: [],
      estimatedDifficulty: "normal", parallelSafe: false };
    const { packet, context } = await buildRepairPacket(root, task, paths, profile, [], 16000);
    const verificationContext = { ...context, files: [...context.files,
      ...await Promise.all(["a", "b", "c"].map(async (file) => ({
        path: `tests/${file}.test.cjs`, snippet: await readFile(join(root, `tests/${file}.test.cjs`), "utf8"),
      }))) ] };
    await implement(gateway, root, task, subtask, { acceptanceCriteria: [task] }, profile, {
      compiledContext: verificationContext, repairPacket: packet, finalVerificationOnly: true,
      stableHandoff: { issue: "Correct a and b", writePaths: paths,
        evidence: { relevantFiles: paths, symbols: [], reproduction: "read sources",
          failingTests: [], likelyRootCause: "wrong values", dependencies: [], uncertainty: "low",
          suggestedApproach: "replace values", evidence: ["read sources"] },
        requiredChange: "Set a and b to 2", regressionTest: "Run focused tests" },
    });
    assert.equal(calls, firstValue === 9 ? 2 : 1, "verification precedes any extra coder call");
    assert.equal(await readFile(join(root, "src/c.cjs"), "utf8"), "module.exports = 1;\n");
    assert.ok(logger.events.some((event) => event.type === "ready_for_final_verification"));
    assert.ok(!logger.events.some((event) => event.type === "stable_missing_write_paths" || event.type === "escalation"));
    const focused = logger.events.filter((event) => event.type === "stable_focused_verification");
    assert.ok(focused.length >= (firstValue === 9 ? 2 : 1), "targeted verification runs after each mutation");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(logRoot, { recursive: true, force: true });
  }
});

test("Stable fallback after a failed focused check sees clean source and rejected diff", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-stable-diff-fallback-"));
  const logRoot = await mkdtemp(join(tmpdir(), "koda-stable-diff-log-"));
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "tests"));
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test tests/*.test.cjs" } }));
    await writeFile(join(root, "src/a.cjs"), "module.exports = 1;\n");
    await writeFile(join(root, "tests/a.test.cjs"),
      "const {test}=require('node:test'); const assert=require('node:assert/strict'); test('a',()=>assert.equal(require('../src/a.cjs'), 2));\n");
    await git(root, "init", "-q");
    await git(root, "config", "user.name", "Diff Fallback Test");
    await git(root, "config", "user.email", "diff-fallback@test.local");
    await git(root, "add", ".");
    await git(root, "commit", "-qm", "baseline");
    const logger = new Logger(join(logRoot, "log"), "diff-fallback", true);
    const settings = await config(undefined, { modelPool: { provider: "openrouter", models: [
      { id: "A", tier: "fast", qualityPrior: 0.95, latencyPriorMs: 100, strengths: ["coding", "tool_use"] },
      { id: "B", tier: "strong", qualityPrior: 0.99, latencyPriorMs: 100, strengths: ["coding", "tool_use"] },
    ] }, adaptiveCoding: false, specialistRouting: false, budgetUsd: 1 });
    const gateway = new Gateway(settings, logger, new Budget(1, 100000, 60000));
    const pool = gateway.modelRouter! as any;
    const candidate = (id: string, tier: string) => ({ model: { id, tier, qualityPrior: 0.95 },
      metadata: { inputPrice: 1, outputPrice: 1, supportedParameters: ["tools", "tool_choice"] }, quality: 0.95 });
    pool.select = async (_features: unknown, _subtask: string, excluded: string[] = []) =>
      excluded.includes("A") ? candidate("B", "strong") : candidate("A", "fast");
    const served: string[] = [];
    (gateway as any).call = async (model: string, messages: any[]) => {
      served.push(model);
      if (served.length === 2) throw Error("Tool protocol: transient provider failure");
      if (model === "B") {
        assert.equal(await readFile(join(root, "src/a.cjs"), "utf8"), "module.exports = 1;\n");
        assert.ok(JSON.stringify(messages).includes("module.exports = 9"), "fallback gets rejected diff");
        assert.ok(JSON.stringify(messages).includes("currentLockedFiles"));
      }
      return { role: "assistant", content: null, tool_calls: [{ id: `patch-${served.length}`, type: "function",
        function: { name: "apply_patch", arguments: JSON.stringify({ edits: [{
          path: "src/a.cjs", oldText: "= 1", newText: model === "A" ? "= 9" : "= 2",
        }] }) } }] };
    };
    const profile = await profileRepo(root);
    const task = "Fix src/a.cjs and test it";
    const subtask: Subtask = { id: "stable", title: task, objective: task,
      dependsOn: [], likelyReadPaths: ["src/a.cjs"], likelyWritePaths: ["src/a.cjs"], readOnly: false,
      integrationContract: "focused test", verificationCommands: [], estimatedDifficulty: "normal", parallelSafe: false };
    const { packet, context } = await buildRepairPacket(root, task, ["src/a.cjs"], profile, [], 16000);
    const verificationContext = { ...context, files: [...context.files, {
      path: "tests/a.test.cjs", snippet: await readFile(join(root, "tests/a.test.cjs"), "utf8"),
    }] };
    await implement(gateway, root, task, subtask, { acceptanceCriteria: [task] }, profile, {
      compiledContext: verificationContext, repairPacket: packet, finalVerificationOnly: true,
      stableHandoff: { issue: "Correct a", writePaths: ["src/a.cjs"],
        evidence: { relevantFiles: ["src/a.cjs"], symbols: [], reproduction: "read source",
          failingTests: [], likelyRootCause: "wrong value", dependencies: [], uncertainty: "low",
          suggestedApproach: "replace value", evidence: ["read src/a.cjs"] },
        requiredChange: "Set a to 2", regressionTest: "Run focused test" },
    });
    assert.deepEqual(served, ["A", "A", "B"]);
    assert.equal(await readFile(join(root, "src/a.cjs"), "utf8"), "module.exports = 2;\n");
    const events = logger.events;
    assert.ok(events.findIndex((event) => event.type === "stable_focused_verification") <
      events.findIndex((event) => event.type === "model_fallback"));
    assert.ok(events.some((event) => event.type === "ready_for_final_verification" && event.diffBytes > 0));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(logRoot, { recursive: true, force: true });
  }
});

test("implementation plus focused tests fingerprints as implementation with secondary testing", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-fingerprint-feature-"));
  try {
    await writeFile(join(root, "feature.ts"), "export const feature = true;\n");
    const profile = await profileRepo(root);
    const subtask: Subtask = { id: "stable", title: dogfoodTask, objective: dogfoodTask,
      dependsOn: [], likelyReadPaths: [], likelyWritePaths: ["feature.ts"],
      integrationContract: "focused test", verificationCommands: [],
      estimatedDifficulty: "normal", parallelSafe: false };
    const features = extractFeatures(subtask, profile, 100, undefined, "stable");
    const fingerprint = taskFingerprint(subtask, profile, features, "normal");
    assert.equal(fingerprint.primary, "implementation");
    assert.ok(fingerprint.secondary.includes("testing"));
    for (const [objective, expected] of [
      ["Fix parsing bug and add a regression test", "debugging"],
      ["Refactor cache and preserve behavior", "refactor"],
      ["Add tests for the existing cache implementation", "testing"],
    ] as const) {
      const changed = { ...subtask, title: objective, objective };
      assert.equal(taskFingerprint(changed, profile,
        extractFeatures(changed, profile, 100, undefined, "stable"), "normal").primary, expected);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Stable no-mutation budget survives provider fallback and protocol failures do not enter quality history", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-stable-global-budget-"));
  const logRoot = await mkdtemp(join(tmpdir(), "koda-stable-global-log-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/a.ts"), "export const a = 1;\n");
    await git(root, "init", "-q");
    await git(root, "config", "user.name", "Stable Budget Test");
    await git(root, "config", "user.email", "stable-budget@test.local");
    await git(root, "add", ".");
    await git(root, "commit", "-qm", "baseline");
    const logger = new Logger(join(logRoot, "log"), "stable-budget", true);
    const settings = await config(undefined, { modelPool: { provider: "openrouter", models: [
      { id: "A", tier: "fast", qualityPrior: 0.95, latencyPriorMs: 100, strengths: ["coding", "tool_use"] },
      { id: "B", tier: "strong", qualityPrior: 0.99, latencyPriorMs: 100, strengths: ["coding", "tool_use"] },
    ] }, adaptiveCoding: false, specialistRouting: false, budgetUsd: 1 });
    const gateway = new Gateway(settings, logger, new Budget(1, 100000, 60000));
    const pool = gateway.modelRouter! as any;
    const candidate = (id: string, tier: string) => ({ model: { id, tier, qualityPrior: 0.95 },
      metadata: { inputPrice: 1, outputPrice: 1, supportedParameters: ["tools", "tool_choice"] }, quality: 0.95 });
    pool.select = async (_features: unknown, _subtask: string, excluded: string[] = []) =>
      excluded.includes("A") ? candidate("B", "strong") : candidate("A", "fast");
    const recorded: string[] = [];
    pool.record = (_model: any, _features: unknown, _id: string, _since: number, status: string) => recorded.push(status);
    const models: string[] = [];
    (gateway as any).call = async (model: string, _messages: unknown, _id: string,
      _stage: string, _iteration: number, offered: any[]) => {
      models.push(model);
      assert.ok(offered.every((tool) => ["write_file", "edit_file", "apply_patch", "request_context"]
        .includes(tool.function.name)));
      if (models.length === 2) throw Error("Tool protocol: provider rejected required parameters");
      return { role: "assistant", content: "I am thinking", tool_calls: [] };
    };
    const profile = await profileRepo(root);
    const subtask: Subtask = { id: "stable", title: "Fix src/a.ts", objective: "Fix src/a.ts",
      dependsOn: [], likelyReadPaths: ["src/a.ts"], likelyWritePaths: ["src/a.ts"],
      integrationContract: "focused fix", verificationCommands: [],
      estimatedDifficulty: "normal", parallelSafe: false };
    const { packet, context } = await buildRepairPacket(root, subtask.objective,
      subtask.likelyWritePaths, profile, [], 16000);
    await assert.rejects(implement(gateway, root, subtask.objective, subtask,
      { acceptanceCriteria: [subtask.objective] }, profile, {
        compiledContext: context, repairPacket: packet, finalVerificationOnly: true,
        stableHandoff: { issue: "Fix the inspected source", writePaths: ["src/a.ts"],
          evidence: { relevantFiles: ["src/a.ts"], symbols: [], reproduction: "read source",
            failingTests: [], likelyRootCause: "small issue", dependencies: [], uncertainty: "low",
            suggestedApproach: "apply fix", evidence: ["read src/a.ts"] },
          requiredChange: "Fix the source now", regressionTest: "Check the corrected source" },
      }), /mutation protocol exhausted/);
    assert.deepEqual(models, ["A", "A", "B", "B"]);
    assert.deepEqual(recorded, [], "protocol and provider failures do not alter quality history");
    assert.equal(await readFile(join(root, "src/a.ts"), "utf8"), "export const a = 1;\n");
    const compatibleGateway = new Gateway(settings,
      new Logger(join(logRoot, "compatible-log"), "compatible-budget", true),
      new Budget(1, 100000, 60000));
    const compatiblePool = compatibleGateway.modelRouter! as any;
    compatiblePool.select = async (_features: unknown, _subtask: string, excluded: string[] = []) =>
      excluded.includes("A") ? candidate("B", "strong") : {
        ...candidate("A", "fast"), metadata: { inputPrice: 1, outputPrice: 1,
          supportedParameters: ["tools"] },
      };
    const compatibleHistory: string[] = [];
    compatiblePool.record = (_model: any, _features: unknown, _id: string,
      _since: number, status: string) => compatibleHistory.push(status);
    const served: string[] = [];
    (compatibleGateway as any).call = async (model: string) => {
      served.push(model);
      return { role: "assistant", content: null, tool_calls: [{ id: "edit", type: "function",
        function: { name: "edit_file", arguments: JSON.stringify({
          path: "src/a.ts", oldText: "a = 1", newText: "a = 2",
        }) } }] };
    };
    await implement(compatibleGateway, root, subtask.objective, subtask,
      { acceptanceCriteria: [subtask.objective] }, profile, {
        compiledContext: context, repairPacket: packet, finalVerificationOnly: true,
        stableHandoff: { issue: "Fix the inspected source", writePaths: ["src/a.ts"],
          evidence: { relevantFiles: ["src/a.ts"], symbols: [], reproduction: "read source",
            failingTests: [], likelyRootCause: "small issue", dependencies: [], uncertainty: "low",
            suggestedApproach: "apply fix", evidence: ["read src/a.ts"] },
          requiredChange: "Fix the source now", regressionTest: "Check the corrected source" },
      });
    assert.deepEqual(served, ["B"], "known tool-choice-incompatible A is filtered before a paid call");
    assert.deepEqual(compatibleHistory, []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(logRoot, { recursive: true, force: true });
  }
});

test("Stable large source context selects task symbol beyond imports and allows one bounded locked excerpt", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-context-region-"));
  try {
    const content = "from helpers import normalize_value\n" + "# unrelated padding\n".repeat(400) +
      "def normalize_value(data):\n    return data\n";
    await writeFile(join(root, "logic.py"), content);
    await writeFile(join(root, "unrelated.py"), "secret = 1\n");
    const profile = await profileRepo(root);
    const { packet } = await buildRepairPacket(root, "Fix normalize_value for binary data", ["logic.py"], profile, [], 16000);
    assert.match(packet.files[0]!.content, /def normalize_value/);
    assert.ok(packet.files[0]!.startLine > 350);
    const logger = new Logger(join(root, "log"), "context", true);
    const tools = new AgentTools(root, false, 1000, logger, "stable", 4000,
      new WriteScope(["logic.py"], logger, "stable"), ["logic.py"]);
    const result = await tools.execute("request_context", { path: "logic.py", symbol: "def normalize_value" });
    assert.match(String(result), /return data/);
    assert.ok(Buffer.byteLength(String(result)) <= 3200);
    await assert.rejects(tools.execute("request_context", { path: "logic.py" }), /limited to one/);
    const denied = new AgentTools(root, false, 1000, logger, "stable", 4000, undefined, ["logic.py"]);
    await assert.rejects(denied.execute("request_context", { path: "unrelated.py" }), /trusted/);
    assert.equal(await readFile(join(root, "logic.py"), "utf8"), content);
  } finally { await rm(root, { recursive: true, force: true }); }
});

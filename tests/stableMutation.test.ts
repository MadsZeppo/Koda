import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, symlink, link, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { config } from "../src/config.js";
import { run } from "./helpers/run.js";
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
import { summarize } from "../src/telemetry/summary.js";
import { verificationResult } from "../src/verifier/verifier.js";
import { prepareStableWorker } from "../src/agent/stable.js";
import { compileContext } from "../src/context/compiler.js";

const dogfoodTask = "Add a CLI flag --explain-routing that prints the selected coding model, task fingerprint, quality reference, estimated quality gap, estimated cost, and fallback chain before execution. Keep normal behavior unchanged when the flag is absent. Add focused tests for the new flag.";

test("unknown Stable scope is acquired locally before coding starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-stable-local-discovery-"));
  const logRoot = await mkdtemp(join(tmpdir(), "koda-stable-local-discovery-log-"));
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "tests"));
    await writeFile(join(root, "src/cachePolicy.cjs"),
      "// stale cache refresh deadline\nmodule.exports = () => 1;\n");
    await writeFile(join(root, "src/unrelated.cjs"), "module.exports = 'unrelated';\n");
    await writeFile(join(root, "tests/cachePolicy.test.cjs"),
      "const {test}=require('node:test');const assert=require('node:assert/strict');const policy=require('../src/cachePolicy.cjs');test('cache policy',()=>assert.ok(Number.isFinite(policy())));\n");
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: {
      test: "node --test tests/cachePolicy.test.cjs",
    } }));
    await git(root, "init", "-q");
    await git(root, "config", "user.name", "Local Discovery");
    await git(root, "config", "user.email", "local-discovery@test.local");
    await git(root, "add", ".");
    await git(root, "commit", "-qm", "baseline");

    const task = "Correct stale cache refresh deadline behavior and add a focused regression test";
    const profile = await profileRepo(root);
    const settings = await config(undefined, { modelPool: { provider: "openrouter", models: [
      { id: "coder", tier: "fast", qualityPrior: 0.99, latencyPriorMs: 100,
        strengths: ["coding", "tool_use"] },
    ] }, adaptiveCoding: false, specialistRouting: false, budgetUsd: 1 });
    const logger = new Logger(join(logRoot, "log"), "local-discovery", true);
    const gateway = new Gateway(settings, logger, new Budget(1, 100000, 60000));
    const pool = gateway.modelRouter! as any;
    pool.select = async () => ({ model: { id: "coder", tier: "fast", qualityPrior: 0.99,
      strengths: ["coding", "tool_use"] }, metadata: { inputPrice: 1, outputPrice: 1,
      supportedParameters: ["tools", "tool_choice"] }, quality: 0.99 });
    pool.record = () => undefined;
    const inspection: Subtask = { id: "stable", title: task, objective: task,
      dependsOn: [], likelyReadPaths: [], likelyWritePaths: [], readOnly: true,
      integrationContract: "Implement the requested behavior", verificationCommands: [],
      estimatedDifficulty: "normal", parallelSafe: false };
    const context = await compileContext(root, task, [], profile, settings.context);
    const stages: string[] = [];
    (gateway as any).call = async (_model: string, _messages: unknown, _id: string,
      stage: string) => {
      stages.push(stage);
      assert.notEqual(stage, "inspect", "deterministic discovery must precede model inspection");
      return { role: "assistant", content: null, tool_calls: [{ id: "implement", type: "function",
        function: { name: "edit_file", arguments: JSON.stringify({ path: "src/cachePolicy.cjs",
          oldText: "module.exports = () => 1;", newText: "module.exports = () => 2;" }) } }] };
    };
    const prepared = await prepareStableWorker(gateway, root, task, inspection, profile, context);
    assert.deepEqual(prepared.writePaths,
      ["src/cachePolicy.cjs", "tests/cachePolicy.test.cjs"]);
    assert.equal(stages.length, 0);

    const subtask: Subtask = { ...inspection, readOnly: false,
      likelyWritePaths: prepared.writePaths,
      verificationCommands: ["node --test tests/cachePolicy.test.cjs"] };
    const { packet, context: codingContext } = await buildRepairPacket(root, task,
      prepared.writePaths, profile, profile.verificationCommands, 16000, prepared.evidence,
      ["tests/cachePolicy.test.cjs"]);
    const result = await implement(gateway, root, task, subtask,
      { acceptanceCriteria: [task] }, profile, { compiledContext: codingContext,
        evidence: prepared.evidence, finalVerificationOnly: true,
        stableHandoff: prepared.handoff, repairPacket: packet });
    assert.notEqual(result.verification.status, "FAILED");
    assert.match(await readFile(join(root, "src/cachePolicy.cjs"), "utf8"), /=> 2/);
    assert.ok(stages.length > 0, "coding worker was invoked after scope lock");
    assert.ok(logger.events.some((event) => event.type === "stable_scope_locked" &&
      event.deterministic === true));
    assert.ok(logger.events.some((event) => event.type === "write_success" &&
      event.path === "src/cachePolicy.cjs"));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(logRoot, { recursive: true, force: true });
  }
});

test("Stable discovers one local check when routing context has checks but no focused check", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-stable-post-mutation-check-"));
  const logRoot = await mkdtemp(join(tmpdir(), "koda-stable-post-mutation-check-log-"));
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "tests"));
    await writeFile(join(root, "src/value.mjs"), "export const value = 1;\n");
    await writeFile(join(root, "tests/value.test.mjs"),
      "import {test} from 'node:test';import assert from 'node:assert/strict';import {value} from '../src/value.mjs';test('value',()=>assert.equal(value,2));\n");
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module", scripts: {
      build: "node --check src/value.mjs",
      test: "node --test tests/value.test.mjs",
    } }));
    await git(root, "init", "-q"); await git(root, "config", "user.name", "Post Mutation");
    await git(root, "config", "user.email", "post-mutation@test.local");
    await git(root, "add", "."); await git(root, "commit", "-qm", "baseline");

    const settings = await config(undefined, { modelPool: { provider: "openrouter", models: [
      { id: "coder", tier: "fast", qualityPrior: 0.99, latencyPriorMs: 100,
        strengths: ["coding", "tool_use"] },
    ] }, adaptiveCoding: false, specialistRouting: false, budgetUsd: 1 });
    const logger = new Logger(join(logRoot, "log"), "post-mutation", true);
    const gateway = new Gateway(settings, logger, new Budget(1, 100000, 60000));
    const pool = gateway.modelRouter! as any;
    pool.select = async () => ({ model: { id: "coder", tier: "fast", qualityPrior: 0.99,
      strengths: ["coding", "tool_use"] }, metadata: { inputPrice: 1, outputPrice: 1,
      supportedParameters: ["tools", "tool_choice"] }, quality: 0.99 });
    pool.record = () => undefined;
    let calls = 0;
    (gateway as any).call = async (_model: string, messages: any[]) => {
      calls++;
      if (calls === 1)
        return { role: "assistant", content: null, tool_calls: [{ id: "bad", type: "function",
          function: { name: "write_file", arguments: JSON.stringify({ path: "src/value.mjs",
            content: "export const value = 1;\nexport const value = 2;\n" }) } }] };
      const repair = JSON.parse(messages.at(-1).content);
      assert.match(JSON.stringify(repair.failedChecks), /already been declared|SyntaxError/);
      assert.match(repair.currentLockedFiles[0].content, /value = 1.*value = 2/s);
      return { role: "assistant", content: null, tool_calls: [{ id: "repair", type: "function",
        function: { name: "write_file", arguments: JSON.stringify({ path: "src/value.mjs",
          content: "export const value = 2;\n" }) } }] };
    };

    const task = "Change the value implementation to 2 and preserve its test";
    const profile = await profileRepo(root);
    const subtask: Subtask = { id: "stable", title: task, objective: task,
      dependsOn: [], likelyReadPaths: ["src/value.mjs", "tests/value.test.mjs"],
      likelyWritePaths: ["src/value.mjs"], readOnly: false,
      integrationContract: "Keep the repository test passing", verificationCommands: [],
      estimatedDifficulty: "normal", parallelSafe: false };
    const { packet, context } = await buildRepairPacket(root, task,
      subtask.likelyWritePaths, profile, profile.verificationCommands, 16000);
    assert.ok(packet.verificationCommands.length > 0,
      "the routing/repair packet contains a broad repository check");
    const sourceOnlyContext = { ...context,
      files: context.files.filter((file) => file.path === "src/value.mjs") };
    const result = await implement(gateway, root, task, subtask,
      { acceptanceCriteria: [task] }, profile, { compiledContext: sourceOnlyContext,
        finalVerificationOnly: true,
        stableHandoff: { issue: "Change value", writePaths: ["src/value.mjs"],
          evidence: { relevantFiles: ["src/value.mjs", "tests/value.test.mjs"], symbols: ["value"],
            reproduction: "repository test", failingTests: [], likelyRootCause: "wrong value",
            dependencies: [], uncertainty: "low", suggestedApproach: "edit value",
            evidence: ["read source and test"] }, requiredChange: "Set value to 2",
          regressionTest: "Run repository test" }, repairPacket: packet });

    assert.equal(calls, 2, "the same coder repairs from deterministic local feedback");
    assert.notEqual(result.verification.status, "FAILED",
      "the worker returns the repaired candidate for authoritative final verification");
    assert.equal(await readFile(join(root, "src/value.mjs"), "utf8"),
      "export const value = 2;\n");
    assert.equal(logger.events.filter((event) =>
      event.type === "verification_recovery_attempt").length, 1);
    assert.ok(logger.events.some((event) => event.type === "stable_focused_verification" &&
      event.outcome === "CHECK_FAIL"));
    assert.ok(logger.events.some((event) => event.type === "stable_same_model_repair"));
    assert.equal(logger.events.filter((event) => event.type === "model_fallback").length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(logRoot, { recursive: true, force: true });
  }
});

test("test-only Stable scope targets the existing test and refreshes after a no-op edit", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-stable-test-scope-"));
  const logRoot = await mkdtemp(join(tmpdir(), "koda-stable-test-scope-log-"));
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "tests"));
    const source = "module.exports = () => ({ selectedModel: 'cheap', expectedCompletionCost: 1 });\n";
    const originalTest = "const {test}=require('node:test');const assert=require('node:assert/strict');const route=require('../src/run.cjs');test('route telemetry',()=>assert.equal(route().selectedModel,'cheap'));\n";
    await writeFile(join(root, "src/run.cjs"), source);
    await writeFile(join(root, "tests/routeTelemetry.test.cjs"), originalTest);
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: {
      test: "node --test tests/routeTelemetry.test.cjs",
    } }));
    await git(root, "init", "-q"); await git(root, "config", "user.name", "Test Scope");
    await git(root, "config", "user.email", "test-scope@test.local");
    await git(root, "add", "."); await git(root, "commit", "-qm", "baseline");

    const task = "Add a deterministic unit test that verifies route telemetry includes the selected model and expected completion cost.";
    const profile = await profileRepo(root);
    const settings = await config(undefined, { modelPool: { provider: "openrouter", models: [
      { id: "coder", tier: "fast", qualityPrior: 0.99, latencyPriorMs: 100,
        strengths: ["coding", "tool_use"] },
    ] }, adaptiveCoding: false, specialistRouting: false, budgetUsd: 1 });
    const logger = new Logger(join(logRoot, "log"), "test-scope", true);
    const gateway = new Gateway(settings, logger, new Budget(1, 100000, 60000));
    const pool = gateway.modelRouter! as any;
    pool.select = async () => ({ model: { id: "coder", tier: "fast", qualityPrior: 0.99,
      strengths: ["coding", "tool_use"] }, metadata: { inputPrice: 1, outputPrice: 1,
      supportedParameters: ["tools", "tool_choice"] }, quality: 0.99 });
    pool.record = () => undefined;
    const inspection: Subtask = { id: "stable", title: task, objective: task,
      dependsOn: [], likelyReadPaths: [], likelyWritePaths: [], readOnly: true,
      integrationContract: "Add the deterministic unit test", verificationCommands: [],
      estimatedDifficulty: "normal", parallelSafe: false };
    const context = await compileContext(root, task, [], profile, settings.context);
    let codingCalls = 0;
    (gateway as any).call = async (_model: string, messages: any[], _id: string,
      stage: string) => {
      assert.notEqual(stage, "inspect");
      codingCalls++;
      if (codingCalls === 1)
        return { role: "assistant", content: null, tool_calls: [{ id: "noop", type: "function",
          function: { name: "edit_file", arguments: JSON.stringify({
            path: "tests/routeTelemetry.test.cjs", oldText: "selectedModel", newText: "selectedModel",
          }) } }] };
      const retry = JSON.parse(messages.at(-1).content);
      assert.match(retry.instruction, /re-read from disk.*stale oldText/);
      assert.equal(retry.currentLockedFiles[0].content, originalTest);
      return { role: "assistant", content: null, tool_calls: [{ id: "test", type: "function",
        function: { name: "edit_file", arguments: JSON.stringify({
          path: "tests/routeTelemetry.test.cjs",
          oldText: "assert.equal(route().selectedModel,'cheap')",
          newText: "assert.deepEqual(route(),{selectedModel:'cheap',expectedCompletionCost:1})",
        }) } }] };
    };

    const prepared = await prepareStableWorker(gateway, root, task, inspection, profile, context);
    assert.deepEqual(prepared.writePaths, ["tests/routeTelemetry.test.cjs"]);
    const subtask: Subtask = { ...inspection, readOnly: false,
      likelyWritePaths: prepared.writePaths,
      verificationCommands: ["node --test tests/routeTelemetry.test.cjs"] };
    const { packet, context: codingContext } = await buildRepairPacket(root, task,
      prepared.writePaths, profile, profile.verificationCommands, 16000, prepared.evidence,
      prepared.writePaths);
    const result = await implement(gateway, root, task, subtask,
      { acceptanceCriteria: [task] }, profile, { compiledContext: codingContext,
        evidence: prepared.evidence, finalVerificationOnly: true,
        stableHandoff: prepared.handoff, repairPacket: packet });
    assert.notEqual(result.verification.status, "FAILED");
    assert.equal(await readFile(join(root, "src/run.cjs"), "utf8"), source);
    assert.equal(codingCalls, 2);
    assert.equal(logger.events.filter((event) => event.type === "write_success").length, 1,
      "an identical edit is not reported as a successful write");
    const summary = summarize(logger, result.verification.status, 1, result.verification,
      ["tests/routeTelemetry.test.cjs"]);
    assert.deepEqual(summary.workerScopes.map((scope) => scope.allowed_write_paths),
      [["tests/routeTelemetry.test.cjs"]]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(logRoot, { recursive: true, force: true });
  }
});

test("an already-covered explicit test task verifies without any coding model call", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-stable-test-covered-"));
  const repo = join(root, "repo"), output = join(root, "output");
  try {
    await mkdir(join(repo, "src"), { recursive: true }); await mkdir(join(repo, "tests"));
    await writeFile(join(repo, "src/router.cjs"),
      "module.exports=()=>({selected_model:'cheap',expected_completion_cost_usd:0.2});\n");
    await writeFile(join(repo, "tests/router.test.cjs"),
      "const {test}=require('node:test');const assert=require('node:assert/strict');const route=require('../src/router.cjs');\n" +
      "test('route telemetry',()=>{const event=route();assert.equal(event.selected_model,'cheap');assert.equal(event.expected_completion_cost_usd,0.2);});\n");
    for (let index = 0; index < 9; index++)
      await writeFile(join(repo, `src/helper${index}.cjs`), `module.exports=${index};\n`);
    for (let index = 0; index < 12; index++)
      await writeFile(join(repo, `tests/noise${index}.test.cjs`),
        `const {test}=require('node:test');test('noise ${index}',()=>{}); // route telemetry selected model expected completion cost\n`);
    await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: {
      test: "node --test tests/*.test.cjs",
    } }));
    await git(repo, "init", "-q"); await git(repo, "config", "user.name", "Covered Test");
    await git(repo, "config", "user.email", "covered@test.local");
    await git(repo, "add", "."); await git(repo, "commit", "-qm", "baseline");
    const task = "Add a deterministic unit test that verifies route telemetry includes the selected model and expected completion cost.";
    const settings = await config(undefined, { adaptiveCoding: false, specialistRouting: false,
      baseUrl: "http://127.0.0.1:1/v1", budgetUsd: 0.1 });
    const result = await run({ repo, task, output, quiet: true, config: settings });
    const events = (await readFile(join(output, "events.jsonl"), "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(result.status, "VERIFIED_SUCCESS", JSON.stringify({ error: result.error,
      events: events.slice(-12) }));
    assert.equal(result.candidateProduced, false);
    assert.equal(events.some((event) => event.type === "model_call"), false);
    assert.equal(events.some((event) => event.type === "coding_worker_start"), false);
    assert.ok(events.some((event) => event.type === "no_changes_required" &&
      event.reason === "acceptance_checks_already_pass"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a verified no-change result never enters final coding repair", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-stable-no-change-final-"));
  const repo = join(root, "repo"), output = join(root, "output");
  let verificationCalls = 0;
  const verificationServer = createServer((_request, response) => {
    verificationCalls++;
    response.end(verificationCalls === 2 ? "fail" : "pass");
  });
  try {
    await new Promise<void>((resolve) =>
      verificationServer.listen(0, "127.0.0.1", resolve));
    const port = (verificationServer.address() as any).port;
    await mkdir(join(repo, "src"), { recursive: true });
    await mkdir(join(repo, "tests"));
    const source =
      "module.exports=()=>({selected_model:'cheap',expected_completion_cost_usd:0.2});\n";
    const testSource =
      "const {test}=require('node:test');const assert=require('node:assert/strict');" +
      "const route=require('../src/router.cjs');" +
      "test('route telemetry',async()=>{const event=route();" +
      "assert.equal(event.selected_model,'cheap');" +
      "assert.equal(event.expected_completion_cost_usd,0.2);" +
      `assert.equal(await (await fetch('http://127.0.0.1:${port}')).text(),'pass');});\n`;
    await writeFile(join(repo, "src/router.cjs"), source);
    await writeFile(join(repo, "tests/router.test.cjs"), testSource);
    for (let index = 0; index < 9; index++)
      await writeFile(join(repo, `src/helper${index}.cjs`), `module.exports=${index};\n`);
    for (let index = 0; index < 12; index++)
      await writeFile(join(repo, `tests/noise${index}.test.cjs`),
        `const {test}=require('node:test');test('noise ${index}',()=>{}); // route telemetry selected model expected completion cost\n`);
    await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: {
      test: "node --test tests/router.test.cjs",
    } }));
    await git(repo, "init", "-q");
    await git(repo, "config", "user.name", "No Change Final");
    await git(repo, "config", "user.email", "no-change-final@test.local");
    await git(repo, "add", ".");
    await git(repo, "commit", "-qm", "baseline");

    const task = "Add a deterministic unit test that verifies route telemetry includes the selected model and expected completion cost.";
    const result = await run({ repo, task, output, quiet: true, config: await config(undefined, {
      adaptiveCoding: true, specialistRouting: false,
      baseUrl: "http://127.0.0.1:1/v1", budgetUsd: 0.1,
    }) });
    const events = (await readFile(join(output, "events.jsonl"), "utf8")).trim()
      .split("\n").map((line) => JSON.parse(line));
    const noChanges = events.findIndex((event) => event.type === "no_changes_required" &&
      event.status === "VERIFIED_SUCCESS");

    assert.ok(noChanges >= 0, "focused verification proves the existing assertion");
    assert.equal(result.status, "FAILED", "a failed required final check remains strict");
    assert.equal(result.candidateProduced, false);
    assert.deepEqual(result.changedFiles, []);
    assert.equal(events.slice(noChanges + 1).filter((event) => event.type === "model_call").length, 0);
    assert.equal(events.some((event) => event.type === "stable_final_repair_start"), false);
    assert.equal(events.some((event) => event.type === "stable_final_repair_attempt"), false);
    assert.ok(events.some((event) => event.type === "final_verification" &&
      event.outcome === "CHECK_FAIL"));
    assert.ok(events.some((event) => event.type === "final_baseline_verification" &&
      event.outcome === "CHECK_PASS"));
    assert.equal(await readFile(join(repo, "src/router.cjs"), "utf8"), source);
    assert.equal(await readFile(join(repo, "tests/router.test.cjs"), "utf8"), testSource);
    assert.equal((await git(repo, "status", "--porcelain")).trim(), "");
  } finally {
    if (verificationServer.listening)
      await new Promise<void>((resolve) => verificationServer.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("Stable test task filters incompatible endpoints and recovers a formatting-stale edit locally", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-stable-test-e2e-"));
  const repo = join(root, "repo"), output = join(root, "output");
  const requests: any[] = [];
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.endsWith("/models")) {
      const row = (id: string, prompt: string, endpointParameters: string[][]) => ({
        id, context_length: 100000,
        pricing: { prompt, completion: prompt },
        // The incompatible model advertises the union, while no concrete
        // endpoint can satisfy Koda's required protocol in one request.
        supported_parameters: ["tools", "tool_choice"],
        endpoints: endpointParameters.map((supported_parameters) => ({ supported_parameters })),
      });
      response.end(JSON.stringify({ data: [
        row("incompatible-cheap", "0.00000001", [["tools"], ["tool_choice"]]),
        row("compatible-cheap", "0.00000002", [["tools", "tool_choice"]]),
        row("expensive-fallback", "0.000002", [["tools", "tool_choice"]]),
      ] }));
      return;
    }
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    assert.notEqual(body.model, "incompatible-cheap");
    assert.equal(body.tool_choice, "required", JSON.stringify({ url: request.url,
      tools: body.tools?.map((entry: any) => entry.function?.name) }));
    const input = JSON.parse(body.messages[1].content);
    assert.deepEqual(input.repairPacket.allowedWritePaths, ["."]);
    assert.match(JSON.stringify(input), /selectedModel/);
    const message = { role: "assistant", content: null, tool_calls: [{
      id: "stale-formatting", type: "function", function: {
        name: "edit_file", arguments: JSON.stringify({
          path: "tests/routeDecision.test.cjs",
          oldText: "const telemetry = route();\nassert.equal(telemetry.selectedModel, 'cheap');",
          newText: "const telemetry = route();\n  assert.equal(telemetry.selectedModel, 'cheap');\n  assert.equal(telemetry.expectedCompletionCost, 1);",
        }),
      },
    }] };
    response.end(JSON.stringify({ id: "compatible-response", model: body.model,
      choices: [{ index: 0, message }],
      usage: { prompt_tokens: 30, completion_tokens: 20, cost: 0 } }));
  });
  try {
    await mkdir(join(repo, "src"), { recursive: true });
    await mkdir(join(repo, "tests"));
    await writeFile(join(repo, "src/gateway.cjs"),
      "module.exports = () => ({ selectedModel: 'cheap', expectedCompletionCost: 1 });\n");
    for (let index = 0; index < 9; index++)
      await writeFile(join(repo, `src/helper${index}.cjs`), `module.exports = ${index};\n`);
    await writeFile(join(repo, "tests/routeDecision.test.cjs"),
      "const {test}=require('node:test');\nconst assert=require('node:assert/strict');\nconst route=require('../src/gateway.cjs');\ntest('route telemetry', () => {\n  const telemetry = route();\n  assert.equal(telemetry.selectedModel, 'cheap');\n});\n");
    for (let index = 0; index < 12; index++)
      await writeFile(join(repo, `tests/noise${index}.test.cjs`),
        `const {test}=require('node:test'); test('noise ${index}',()=>{}); // route telemetry selected model expected completion cost\n`);
    await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: {
      test: "node --test tests/*.test.cjs",
    } }));
    await git(repo, "init", "-q"); await git(repo, "config", "user.name", "Stable E2E");
    await git(repo, "config", "user.email", "stable-e2e@test.local");
    await git(repo, "add", "."); await git(repo, "commit", "-qm", "baseline");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const task = "Add a deterministic unit test that verifies route telemetry includes the selected model and expected completion cost.";
    const models = [
      { id: "incompatible-cheap", tier: "cheap" as const, qualityPrior: 0.95,
        latencyPriorMs: 50, strengths: ["coding", "tool_use"] },
      { id: "compatible-cheap", tier: "cheap" as const, qualityPrior: 0.95,
        latencyPriorMs: 60, strengths: ["coding", "tool_use"] },
      { id: "expensive-fallback", tier: "strong" as const, qualityPrior: 0.95,
        latencyPriorMs: 100, strengths: ["coding", "tool_use"] },
    ];
    const settings = await config(undefined, { modelPool: { provider: "openrouter", models },
      specialistRouting: true, adaptiveCoding: false,
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      routing: { stateDirectory: join(root, "routing") }, budgetUsd: 0.1 });
    const profile = await profileRepo(repo);
    assert.equal(chooseExecutionStrategy(task, profile).execution_strategy, "stable");
    const result = await run({ repo, task, output, quiet: true, config: settings });
    assert.equal(result.status, "VERIFIED_SUCCESS", result.error);
    assert.equal(requests.length, 1, "recoverable stale formatting needs one cheap model call");
    assert.equal(requests.some((request) => request.model === "incompatible-cheap"), false);
    assert.equal(requests.some((request) => request.model === "expensive-fallback"), false);
    const events = (await readFile(join(output, "events.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(events.find((event) => event.type === "stable_discovery_start")
      .initial_write_scope, ["."]);
    const scope = events.find((event) => event.type === "stable_discovery_scope_locked");
    assert.deepEqual(scope.actual_changed_paths, ["tests/routeDecision.test.cjs"]);
    assert.deepEqual(scope.repair_write_scope, scope.actual_changed_paths);
    assert.ok(events.some((event) => event.type === "edit_file_context_refreshed" &&
      event.recovered === true));
    assert.ok(events.some((event) => event.type === "write_success" &&
      event.path === "tests/routeDecision.test.cjs"));
    assert.ok(events.some((event) => event.type === "final_verification" &&
      event.outcome === "CHECK_PASS" && /test/.test(event.command)));
    assert.equal(events.some((event) => event.type === "model_fallback"), false);
    const usage = events.filter((event) => event.type === "model_call")
      .reduce((sum, event) => sum + event.promptTokens + event.completionTokens, 0);
    assert.equal(usage, 50);
    assert.equal((await readFile(join(repo, "tests/routeDecision.test.cjs"), "utf8"))
      .includes("telemetry.expectedCompletionCost"), false,
    "preview keeps the original write scope untouched");
    assert.match(await readFile(result.candidatePatchPath!, "utf8"),
      /telemetry\.expectedCompletionCost/);
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("compiler failure repair receives only error-linked definitions and current source", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-stable-grounded-repair-"));
  const logRoot = await mkdtemp(join(tmpdir(), "koda-stable-grounded-repair-log-"));
  try {
    await mkdir(join(root, "src")); await mkdir(join(root, "tests"));
    await writeFile(join(root, "src/router.ts"),
      "export interface Router { choose(): string; expectedCost(): number; }\n");
    await writeFile(join(root, "src/feature.ts"),
      "import type { Router } from './router.js'; export const route = (router: Router) => router.choose();\n");
    await writeFile(join(root, "tests/typecheck.test.cjs"),
      "const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');test('typecheck',()=>{const s=fs.readFileSync('src/feature.ts','utf8');if(s.includes('inventedMember'))console.error(\"src/feature.ts(1,90): error TS2339: Property 'inventedMember' does not exist on type 'Router'.\");assert.ok(!s.includes('inventedMember'));});\n");
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: {
      test: "node --test tests/typecheck.test.cjs",
    } }));
    await git(root, "init", "-q"); await git(root, "config", "user.name", "Grounded Repair");
    await git(root, "config", "user.email", "grounded@test.local");
    await git(root, "add", "."); await git(root, "commit", "-qm", "baseline");
    const task = "Expose the route result without inventing members on its Router dependency";
    const profile = await profileRepo(root);
    const settings = await config(undefined, { modelPool: { provider: "openrouter", models: [
      { id: "coder", tier: "fast", qualityPrior: 0.99, latencyPriorMs: 100,
        strengths: ["coding", "tool_use"] },
    ] }, adaptiveCoding: false, specialistRouting: false, budgetUsd: 1 });
    const logger = new Logger(join(logRoot, "log"), "grounded-repair", true);
    const gateway = new Gateway(settings, logger, new Budget(1, 100000, 60000));
    const pool = gateway.modelRouter! as any;
    pool.select = async () => ({ model: { id: "coder", tier: "fast", qualityPrior: 0.99,
      strengths: ["coding", "tool_use"] }, metadata: { inputPrice: 1, outputPrice: 1,
      supportedParameters: ["tools", "tool_choice"] }, quality: 0.99 });
    pool.record = () => undefined;
    let calls = 0;
    (gateway as any).call = async (_model: string, messages: any[]) => {
      calls++;
      const input = JSON.parse(messages[1].content);
      if (calls === 1) {
        assert.ok(input.repairPacket.definitions.some((item: any) =>
          /interface Router/.test(item.content) && /expectedCost/.test(item.content)));
        return { role: "assistant", content: null, tool_calls: [{ id: "bad", type: "function",
          function: { name: "edit_file", arguments: JSON.stringify({ path: "src/feature.ts",
            oldText: "router.choose()", newText: "router.inventedMember" }) } }] };
      }
      assert.equal(input.repairPacket, undefined, "repair does not resend generic initial context");
      assert.equal(input.inspectionHandoff, undefined);
      assert.match(input.failedChecks[0].stdout + input.failedChecks[0].stderr,
        /inventedMember.*Router/s);
      assert.ok(input.relevantDefinitions.some((item: any) =>
        /interface Router/.test(item.content) && /choose\(\).*expectedCost\(\)/s.test(item.content)));
      assert.equal(new Set(input.relevantDefinitions.map((item: any) =>
        `${item.path}:${item.startLine}:${item.symbol}`)).size, input.relevantDefinitions.length);
      assert.ok(Buffer.byteLength(messages[1].content) < 12000);
      return { role: "assistant", content: null, tool_calls: [{ id: "repair", type: "function",
        function: { name: "edit_file", arguments: JSON.stringify({ path: "src/feature.ts",
          oldText: "router.inventedMember", newText: "router.expectedCost()" }) } }] };
    };
    const paths = ["src/feature.ts"];
    const subtask: Subtask = { id: "stable", title: task, objective: task, dependsOn: [],
      likelyReadPaths: ["src/router.ts", "tests/typecheck.test.cjs"], likelyWritePaths: paths,
      readOnly: false, integrationContract: "Keep Router API usage valid",
      verificationCommands: ["node --test tests/typecheck.test.cjs"],
      estimatedDifficulty: "normal", parallelSafe: false };
    const { packet, context } = await buildRepairPacket(root, task, paths, profile,
      subtask.verificationCommands, 16000, undefined, ["tests/typecheck.test.cjs"]);
    const result = await implement(gateway, root, task, subtask,
      { acceptanceCriteria: [task] }, profile, { compiledContext: context,
        finalVerificationOnly: true, stableHandoff: { issue: "Use the Router API",
          writePaths: paths, evidence: { relevantFiles: [...paths, "src/router.ts"], symbols: [],
            reproduction: "focused type check", failingTests: [], likelyRootCause: "API use",
            dependencies: ["src/router.ts"], uncertainty: "low", suggestedApproach: "use real API",
            evidence: ["read target and Router"] }, requiredChange: "Use a real Router member",
          regressionTest: "Run focused type check" }, repairPacket: packet });
    assert.notEqual(result.verification.status, "FAILED");
    assert.equal(calls, 2);
    assert.match(await readFile(join(root, "src/feature.ts"), "utf8"), /expectedCost\(\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(logRoot, { recursive: true, force: true });
  }
});

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
      assert.ok(["apply_patch", "edit_file", "write_file"].every((name) =>
        names.includes(name)));
      assert.equal(body.tool_choice, "required");
      const input = JSON.parse(body.messages[1].content);
      assert.deepEqual(input.repairPacket.allowedWritePaths, ["."]);
      assert.ok(input.repairPacket.files.some((file: any) => file.path === "src/run.ts"));
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
    const mutation = events.findIndex((event) =>
      event.type === "coding_worker_stop" &&
      event.worker_engine === "mini-swe-agent" &&
      (event.actual_changed_paths?.length ?? 0) > 0);
    const lock = events.findIndex((event) => event.type === "stable_discovery_scope_locked");
    assert.deepEqual(events[lock]?.repair_write_scope,
      ["src/cli.ts", "src/run.ts", "tests/adaptiveCoding.test.cjs"]);
    assert.equal(events.filter((event) => event.type === "stable_finalization_start").length, 0);
    assert.equal(requests.length, 1, "mini-SWE performs discovery and coding in one attempt");
    const focused = events.findIndex((event) =>
      event.type === "stable_focused_verification");
    const final = events.findIndex((event) => event.type === "final_verification");
    assert.ok(mutation >= 0 && lock > mutation && final > lock);
    assert.equal(events.find((event) => event.type === "task_fingerprint")?.fingerprint.primary, "implementation");
    assert.ok(events.find((event) => event.type === "task_fingerprint")?.fingerprint.secondary.includes("testing"));
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

for (const failure of ["timeout", "429", "no-scope"] as const) {
test(`Stable ${failure} legacy pre-localizer state does not block mini-SWE discovery`, async () => {
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
    const inspection = body.messages?.[0]?.content?.includes("read-only inspection phase") ||
      names.includes("lock_write_scope");
    if (failure === "no-scope" && inspection && names.includes("search_code")) {
      response.end(JSON.stringify({ id: "no-scope", model: body.model, choices: [{ index: 0,
        message: { role: "assistant", content: null, tool_calls: [
          tool("none", "report_no_scope", { reason: "No safe scope could be identified by this model." }),
        ] } }], usage: { prompt_tokens: 20, completion_tokens: 20, cost: 0 } }));
      return;
    }
    if (inspection && names.includes("search_code")) {
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
    assert.deepEqual(events.find((event) => event.type === "stable_discovery_start")
      .initial_write_scope, ["."]);
    const lock = events.find((event) => event.type === "stable_discovery_scope_locked");
    assert.deepEqual(lock.actual_changed_paths, ["src/a.js"]);
    assert.deepEqual(lock.repair_write_scope, ["src/a.js"]);
    assert.equal(requests.filter((request) => request.tools?.some((tool: any) =>
      tool.function.name === "lock_write_scope")).length, 0,
    "production Stable does not call the legacy pre-localizer");
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
    ] }), /local refresh|exactly once/);
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

test("Stable retries a mechanical patch error from compact refreshed target state", async () => {
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
        assert.ok(JSON.stringify(messages).includes("oldText was not found after local refresh"));
        assert.ok(JSON.stringify(messages).includes("export const a = b + 1"));
        assert.ok(!offered.some((item) => item.function.name === "request_context"),
          "target-state recovery must not request unchanged context");
        assert.ok(!JSON.stringify(messages).includes("repairPacket"),
          "retry must not resend the original context packet");
        return { role: "assistant", content: null, tool_calls: [
          tool("good", "apply_patch", { edits: [{ path: "src/a.ts", oldText: "b + 1", newText: "b + 2" }] }),
        ] };
      }
      throw Error("unexpected extra model call");
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
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0]!.tools,
      ["apply_patch", "edit_file", "write_file", "request_context"]);
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
      if (calls >= 2) assert.ok(JSON.stringify(messages).includes("currentLockedFiles"));
      return { role: "assistant", content: null, tool_calls: [{ id: `patch-${calls}`, type: "function",
        function: { name: "apply_patch", arguments: JSON.stringify({ edits: calls === 1
          ? [{ path: "src/a.cjs", oldText: "= 1", newText: `= ${firstValue}` },
             { path: "src/b.cjs", oldText: "= 1", newText: "= 2" }]
          : [{ path: "src/a.cjs", oldText: calls === 2 ? "= 99" : "= 9", newText: "= 2" }] }) } }] };
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
    assert.equal(calls, firstValue === 9 ? 3 : 1,
      "one stale repair edit gets one compact current-state retry without fallback");
    assert.equal(await readFile(join(root, "src/c.cjs"), "utf8"), "module.exports = 1;\n");
    assert.ok(logger.events.some((event) => event.type === "ready_for_final_verification"));
    assert.ok(!logger.events.some((event) => event.type === "stable_missing_write_paths" || event.type === "escalation"));
    if (firstValue === 9) assert.ok(logger.events.some((event) =>
      event.type === "stable_mutation_tool_recovery" && event.reason === "repair_tool_state_refreshed"));
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
    logger.log("execution_strategy", { execution_strategy: "stable", execution_effort: "tiny" });
    const settings = await config(undefined, { modelPool: { provider: "openrouter", models: [
      { id: "A", tier: "fast", qualityPrior: 0.95, latencyPriorMs: 100, strengths: ["coding", "tool_use"] },
      { id: "B", tier: "strong", qualityPrior: 0.99, latencyPriorMs: 100, strengths: ["coding", "tool_use"] },
    ] }, adaptiveCoding: false, specialistRouting: false, budgetUsd: 1 });
    const gateway = new Gateway(settings, logger, new Budget(1, 100000, 60000));
    const pool = gateway.modelRouter! as any;
    const candidate = (id: string, tier: string) => ({ model: { id, tier, qualityPrior: 0.95 },
      metadata: { inputPrice: 1, outputPrice: 1, supportedParameters: ["tools", "tool_choice"] }, quality: 0.95 });
    let initialFeatures: ReturnType<typeof extractFeatures> | undefined;
    pool.select = async (features: ReturnType<typeof extractFeatures>, _subtask: string, excluded: string[] = []) => {
      initialFeatures ??= features;
      return excluded.includes("A") ? candidate("B", "strong") : candidate("A", "fast");
    };
    const served: string[] = [];
    (gateway as any).call = async (model: string, messages: any[], _subtask: string,
      _stage: string, _turn: number, tools: unknown) => {
      served.push(model);
      if (served.length === 1) {
        assert.equal(initialFeatures?.contextBytes, Buffer.byteLength(JSON.stringify({ messages, tools })));
        assert.equal(initialFeatures?.acceptanceCheckCount, 1);
        assert.equal(initialFeatures?.hasFailingTests, true);
      }
      if (served.length === 2) throw Error("Tool protocol: transient provider failure");
      if (model === "B" && served.length === 3) {
        assert.equal(await readFile(join(root, "src/a.cjs"), "utf8"), "module.exports = 1;\n");
        assert.ok(JSON.stringify(messages).includes("module.exports = 9"), "fallback gets rejected diff");
        assert.ok(JSON.stringify(messages).includes("currentLockedFiles"));
      }
      return { role: "assistant", content: null, tool_calls: [{ id: `patch-${served.length}`, type: "function",
        function: { name: "apply_patch", arguments: JSON.stringify({ edits: [{
          path: "src/a.cjs", oldText: served.length === 4 ? "= 8" : "= 1",
          newText: model === "A" ? "= 9" : served.length === 3 ? "= 8" : "= 2",
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
    assert.deepEqual(served, ["A", "A", "B", "B"],
      "the operational fallback gets its own same-model repair after restoring clean source");
    assert.equal(await readFile(join(root, "src/a.cjs"), "utf8"), "module.exports = 2;\n");
    const events = logger.events;
    const fingerprint = events.find((event) => event.type === "task_fingerprint")?.fingerprint;
    assert.equal(fingerprint?.verificationStrength, "strong");
    assert.equal(fingerprint?.effort, "tiny");
    assert.ok(events.findIndex((event) => event.type === "stable_focused_verification") <
      events.findIndex((event) => event.type === "model_fallback"));
    assert.ok(events.some((event) => event.type === "ready_for_final_verification" && event.diffBytes > 0));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(logRoot, { recursive: true, force: true });
  }
});

test("repair-to-baseline is rejected and escalates until a real implementation mutation passes", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-stable-baseline-repair-"));
  const logRoot = await mkdtemp(join(tmpdir(), "koda-stable-baseline-log-"));
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "tests"));
    const originalTest = "const {test}=require('node:test');const assert=require('node:assert/strict');test('loads',()=>assert.ok(Number.isFinite(require('../src/value.cjs'))));\n";
    await writeFile(join(root, "src/value.cjs"), "module.exports = 1;\n");
    await writeFile(join(root, "tests/value.test.cjs"), originalTest);
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: {
      test: "node --test tests/value.test.cjs",
    } }));
    await git(root, "init", "-q"); await git(root, "config", "user.name", "Baseline Repair");
    await git(root, "config", "user.email", "baseline-repair@test.local");
    await git(root, "add", "."); await git(root, "commit", "-qm", "baseline");

    const logger = new Logger(join(logRoot, "log"), "baseline-repair", true);
    const settings = await config(undefined, { modelPool: { provider: "openrouter", models: [
      { id: "cheap", tier: "fast", qualityPrior: 0.95, latencyPriorMs: 100,
        strengths: ["coding", "tool_use"] },
      { id: "strong", tier: "strong", qualityPrior: 0.99, latencyPriorMs: 100,
        strengths: ["coding", "tool_use"] },
    ] }, adaptiveCoding: false, specialistRouting: false, budgetUsd: 1 });
    const gateway = new Gateway(settings, logger, new Budget(1, 100000, 60000));
    const pool = gateway.modelRouter! as any;
    const candidate = (id: string, tier: string) => ({ model: { id, tier, qualityPrior: 0.95 },
      metadata: { inputPrice: 1, outputPrice: 1,
        supportedParameters: ["tools", "tool_choice"] }, quality: 0.95 });
    pool.select = async (_features: unknown, _subtask: string, excluded: string[] = []) =>
      excluded.includes("cheap") ? candidate("strong", "strong") : candidate("cheap", "fast");
    const history: { model: string; status: string; reason: string }[] = [];
    pool.record = (model: any, _features: unknown, _id: string, _since: number,
      status: string, _escalated: boolean, reason: string) =>
      history.push({ model: model.id, status, reason });
    const served: string[] = [];
    const tool = (id: string, name: string, args: object) => ({ id, type: "function",
      function: { name, arguments: JSON.stringify(args) } });
    (gateway as any).call = async (model: string, messages: any[]) => {
      served.push(model);
      const initial = JSON.parse(messages[1].content);
      if (served.length === 1)
        assert.ok(initial.repairPacket.files.some((file: any) =>
          file.path === "src/value.cjs" && file.content.includes("module.exports = 1")),
        "the coder receives deterministic implementation source before mutating");
      else
        assert.ok(initial.currentLockedFiles.some((file: any) => file.path === "src/value.cjs"),
        "repair receives freshly grounded locked source");
      if (served.length === 1)
        return { role: "assistant", content: null, tool_calls: [
          tool("break-test", "write_file", { path: "tests/value.test.cjs", content: "PLACEHOLDER_XYZ\n" }),
        ] };
      if (served.length === 2)
        return { role: "assistant", content: null, tool_calls: [
          tool("restore-test", "write_file", { path: "tests/value.test.cjs", content: originalTest }),
        ] };
      assert.equal(model, "strong");
      if (served.length === 3)
        return { role: "assistant", content: null, tool_calls: [
          tool("test-only", "write_file", { path: "tests/value.test.cjs",
            content: `${originalTest}// still passing, but not an implementation\n` }),
        ] };
      return { role: "assistant", content: null, tool_calls: [
        tool("implement", "edit_file", { path: "src/value.cjs",
          oldText: "module.exports = 1;", newText: "module.exports = 2;" }),
      ] };
    };
    const profile = await profileRepo(root);
    const task = "Change the value implementation in src/value.cjs and keep its focused test passing";
    const paths = ["src/value.cjs", "tests/value.test.cjs"];
    const subtask: Subtask = { id: "stable", title: task, objective: task,
      dependsOn: [], likelyReadPaths: paths, likelyWritePaths: paths, readOnly: false,
      integrationContract: "implementation change", verificationCommands: ["node --test tests/value.test.cjs"],
      estimatedDifficulty: "normal", parallelSafe: false };
    const { packet, context } = await buildRepairPacket(root, task, paths, profile,
      subtask.verificationCommands, 16000);
    await implement(gateway, root, task, subtask, { acceptanceCriteria: [task] }, profile, {
      compiledContext: context, repairPacket: packet, finalVerificationOnly: true,
      stableHandoff: { issue: "Change the implementation", writePaths: paths,
        evidence: { relevantFiles: paths, symbols: [], reproduction: "focused test passes",
          failingTests: [], likelyRootCause: "requested implementation change", dependencies: [],
          uncertainty: "low", suggestedApproach: "edit source", evidence: ["read source and test"] },
        requiredChange: "Change source value", regressionTest: "Keep focused test passing" },
    });
    assert.deepEqual(served, ["cheap", "cheap", "strong", "strong"]);
    assert.equal(await readFile(join(root, "src/value.cjs"), "utf8"), "module.exports = 2;\n");
    assert.match(await readFile(join(root, "tests/value.test.cjs"), "utf8"),
      /not an implementation/);
    assert.equal(logger.events.filter((event) => event.type === "attempt_checkpoint_promoted").length, 1);
    assert.equal(logger.events.find((event) => event.type === "attempt_checkpoint_promoted")?.model,
      "strong");
    assert.ok(logger.events.some((event) => event.type === "stable_mutation_invariant_rejected" &&
      event.reason === "repair_returned_to_baseline"));
    assert.ok(logger.events.some((event) => event.type === "stable_mutation_invariant_rejected" &&
      event.reason === "test_only_mutation"));
    assert.ok(logger.events.some((event) => event.type === "model_fallback"));
    assert.ok(!logger.events.some((event) => event.type === "ready_for_final_verification" &&
      event.diffBytes === 0));
    assert.ok(history.some((entry) => entry.model === "cheap" && entry.status === "FAILED" &&
      /returned to baseline/.test(entry.reason)));
    assert.equal(summarize(logger, "VERIFIED_SUCCESS", 1, verificationResult([]),
      ["src/value.cjs"]).escalations, 1);
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

test("Stable no-mutation budget keeps provider failures operational and attributes repeated model no-ops", async () => {
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
    assert.deepEqual(recorded, ["FAILED"],
      "provider failures stay operational while repeated model no-ops are attributable");
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

const runSpecialistProviderFallback = async (
  specialistIds: string[],
  poolFallbackId?: string,
) => {
  const root = await mkdtemp(join(tmpdir(), "koda-stable-specialist-fallback-"));
  const logRoot = await mkdtemp(join(tmpdir(), "koda-stable-specialist-fallback-log-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/a.ts"), "export const a = 1;\n");
  await git(root, "init", "-q");
  await git(root, "config", "user.name", "Specialist Fallback Test");
  await git(root, "config", "user.email", "specialist-fallback@test.local");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "baseline");
  const logger = new Logger(join(logRoot, "log"), "specialist-fallback", true);
  const settings = await config(undefined, { modelPool: { provider: "openrouter", models: [
    { id: "specialist", tier: "fast", qualityPrior: 0.95, latencyPriorMs: 100,
      strengths: ["coding", "tool_use"] },
    { id: "specialist-next", tier: "strong", qualityPrior: 0.97, latencyPriorMs: 100,
      strengths: ["coding", "tool_use"] },
    { id: "pool-fallback", tier: "strong", qualityPrior: 0.99, latencyPriorMs: 100,
      strengths: ["coding", "tool_use"] },
  ] }, adaptiveCoding: false, specialistRouting: true, budgetUsd: 1 });
  const gateway = new Gateway(settings, logger, new Budget(1, 100000, 60000));
  const pool = gateway.modelRouter! as any;
  const candidate = (id: string, tier = "fast") => ({
    model: { id, tier, qualityPrior: 0.95, strengths: ["coding", "tool_use"] },
    metadata: { inputPrice: 1, outputPrice: 1,
      supportedParameters: ["tools", "tool_choice"] },
    quality: 0.95,
  });
  pool.selectSpecialist = async () => specialistIds.map((id, index) =>
    candidate(id, index ? "strong" : "fast"));
  const poolSelections: Array<{ excluded: string[]; previous: string; escalated: boolean }> = [];
  pool.select = async (_features: unknown, _subtask: string, excluded: string[] = [],
    previous: any, escalated: boolean) => {
    poolSelections.push({ excluded: [...excluded], previous: previous.id, escalated });
    return poolFallbackId ? candidate(poolFallbackId, "strong") : undefined;
  };
  const qualityHistory: string[] = [];
  pool.record = (_model: unknown, _features: unknown, _id: string, _since: number,
    status: string) => qualityHistory.push(status);
  const served: string[] = [];
  (gateway as any).call = async (model: string) => {
    served.push(model);
    if (model === specialistIds[0])
      throw Error("AbortError: This operation was aborted");
    return { role: "assistant", content: null, tool_calls: [{ id: "edit", type: "function",
      function: { name: "edit_file", arguments: JSON.stringify({
        path: "src/a.ts", oldText: "a = 1", newText: "a = 2",
      }) } }] };
  };
  const profile = await profileRepo(root);
  const task = "Fix src/a.ts";
  const subtask: Subtask = { id: "stable", title: task, objective: task,
    dependsOn: [], likelyReadPaths: ["src/a.ts"], likelyWritePaths: ["src/a.ts"],
    readOnly: false, integrationContract: "focused fix", verificationCommands: [],
    estimatedDifficulty: "normal", parallelSafe: false };
  const { packet, context } = await buildRepairPacket(root, task, ["src/a.ts"], profile, [], 16000);
  const execute = () => implement(gateway, root, task, subtask,
    { acceptanceCriteria: [task] }, profile, {
      compiledContext: context, repairPacket: packet, finalVerificationOnly: true,
      stableHandoff: { issue: "Fix the inspected source", writePaths: ["src/a.ts"],
        evidence: { relevantFiles: ["src/a.ts"], symbols: [], reproduction: "read source",
          failingTests: [], likelyRootCause: "small issue", dependencies: [], uncertainty: "low",
          suggestedApproach: "apply fix", evidence: ["read src/a.ts"] },
        requiredChange: "Fix the source now", regressionTest: "Check the corrected source" },
    });
  return { root, logRoot, logger, served, poolSelections, qualityHistory, execute };
};

test("Stable exhausts the specialist cascade into the dynamic pool after an operational failure", async () => {
  const fixture = await runSpecialistProviderFallback(["specialist"], "pool-fallback");
  try {
    await fixture.execute();
    assert.deepEqual(fixture.served, ["specialist", "pool-fallback"]);
    assert.deepEqual(fixture.poolSelections, [{
      excluded: ["specialist"], previous: "specialist", escalated: true,
    }], "the failed specialist is excluded from the authoritative pool fallback");
    assert.deepEqual(fixture.qualityHistory, [],
      "an operational provider failure does not poison verified quality history");
    const attempt = fixture.logger.events.find((event) => event.type === "model_attempt");
    assert.equal(attempt?.modelRequested, "specialist");
    assert.equal(attempt?.escalated, true);
    assert.match(String(attempt?.reason), /infrastructure fallback succeeded/);
    assert.equal(await readFile(join(fixture.root, "src/a.ts"), "utf8"),
      "export const a = 2;\n");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.logRoot, { recursive: true, force: true });
  }
});

test("Stable uses the next specialist before the broader pool", async () => {
  const fixture = await runSpecialistProviderFallback(
    ["specialist", "specialist-next"], "pool-fallback");
  try {
    await fixture.execute();
    assert.deepEqual(fixture.served, ["specialist", "specialist-next"]);
    assert.equal(fixture.poolSelections.length, 0);
    assert.equal(fixture.logger.events.find((event) =>
      event.type === "model_attempt")?.escalated, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.logRoot, { recursive: true, force: true });
  }
});

test("Stable reports exhausted operational fallback without false escalation", async () => {
  const fixture = await runSpecialistProviderFallback(["specialist"]);
  try {
    await assert.rejects(fixture.execute(), /operation was aborted/);
    assert.deepEqual(fixture.served, ["specialist"]);
    assert.deepEqual(fixture.qualityHistory, []);
    const attempt = fixture.logger.events.find((event) => event.type === "model_attempt");
    assert.equal(attempt?.modelRequested, "specialist");
    assert.equal(attempt?.escalated, false);
    assert.match(String(attempt?.reason), /infrastructure fallback exhausted/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.logRoot, { recursive: true, force: true });
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
    const pathResult = await tools.execute("request_context", { path: "logic.py" });
    assert.match(String(pathResult), /from helpers import normalize_value/);
    const symbolTools = new AgentTools(root, false, 1000, logger, "stable-symbol", 4000,
      new WriteScope(["logic.py"], logger, "stable-symbol"), ["logic.py"]);
    const result = await symbolTools.execute("request_context", { path: "logic.py", symbol: "def normalize_value" });
    assert.match(String(result), /return data/);
    assert.ok(Buffer.byteLength(String(result)) <= 3200);
    await assert.rejects(tools.execute("request_context", { path: "logic.py" }), /limited to one/);
    const staleSymbolTools = new AgentTools(root, false, 1000, logger, "stable-stale-symbol", 4000,
      new WriteScope(["logic.py"], logger, "stable-stale-symbol"), ["logic.py"]);
    const stale = await staleSymbolTools.execute("request_context", {
      path: "logic.py", symbol: "src/router/modelRouter.ts",
    });
    assert.match(String(stale), /returning trusted file context/);
    assert.match(String(stale), /from helpers import normalize_value/);
    const denied = new AgentTools(root, false, 1000, logger, "stable", 4000, undefined, ["logic.py"]);
    await assert.rejects(denied.execute("request_context", { path: "unrelated.py" }), /trusted/);
    assert.equal(await readFile(join(root, "logic.py"), "utf8"), content);
  } finally { await rm(root, { recursive: true, force: true }); }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileTaskSpec } from "../src/planner/taskSpec.js";
import { compileTask } from "../src/planner/taskCompiler.js";
import { normalizePlan } from "../src/orchestrator/coalesce.js";
import { codingCapacity, admitProviderPayload, providerPayloadBound, MAX_TASK_SPEC_BYTES,
  MAX_PROVIDER_INPUT_TOKENS, MAX_CODING_PACKET_BYTES } from "../src/context/packetPolicy.js";
import { strategyWithExploration } from "../src/agent/openHandsExplorer.js";
import { planCodingHandoff } from "../src/agent/handoffPlanner.js";

test("large repeated prompts produce a bounded lossless TaskSpec preserving literals and paths", () => {
  const requirement = 'Modify src/example.ts. Preserve the exact literal `value-{id}`. Add focused tests.';
  const original = Array(20000).fill(requirement).join("\n");
  const spec = compileTaskSpec(original);
  assert.equal(spec.original, original);
  assert.ok(Buffer.byteLength(spec.routingPrompt) <= MAX_TASK_SPEC_BYTES);
  assert.ok(spec.exactLiterals.includes("value-{id}"));
  assert.ok(spec.explicitPaths.includes("src/example.ts"));
  assert.ok(spec.constraints.some((value) => value.includes("Preserve")));
});

test("unique requirements are partitioned without dropping later constraints", () => {
  const requirements = Array.from({ length: 200 }, (_, index) => `Preserve distinct requirement ${index} and its exact literal \`entry-${index}\`.`);
  const spec = compileTaskSpec(requirements.join("\n"));
  assert.ok(spec.parts.length > 1);
  assert.ok(spec.parts.every((part) => Buffer.byteLength(part) <= MAX_TASK_SPEC_BYTES));
  for (const requirement of requirements) assert.ok(spec.parts.some((part) => part.includes(requirement)));
});

test("final provider serialization is admitted against a conservative hard bound", () => {
  const payload = { model: "arbitrary/provider", messages: [{ role: "user", content: "å🙂漢".repeat(500) }],
    tools: [{ type: "function", function: { name: "tool", parameters: { type: "object" } } }] };
  const admitted = admitProviderPayload(payload, 1000);
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < admitted.inputTokens);
  assert.equal(admitted.inputTokens, providerPayloadBound(payload));
  assert.throws(() => admitProviderPayload({ messages: [{ content: "x".repeat(MAX_PROVIDER_INPUT_TOKENS) }] }, 1000), /preflight/);
  assert.throws(() => admitProviderPayload(payload, 1000, admitted.inputTokens + 999), /preflight/);
});

test("first attempt capacity preserves both recovery and final review budgets", () => {
  const first = codingCapacity(140000, .3, false);
  assert.ok(first.tokens < 70000);
  assert.ok(first.usd <= .21);
  const remainingTokens = 140000 - first.tokens;
  const remainingUsd = .3 - first.usd;
  const recovery = codingCapacity(remainingTokens, remainingUsd, true);
  assert.ok(recovery.tokens > 10000);
  assert.ok(recovery.usd > 0);
  assert.ok(remainingTokens - recovery.tokens > 0);
  assert.ok(remainingUsd - recovery.usd > 0);
});

test("related tests remain context by default even when generic test writing is requested", () => {
  const exploration: any = { confidence: "medium", editableCandidates: [{ path: "src/example.ts", reason: "implementation" }],
    readonlyFiles: [], relatedTests: ["tests/example.test.ts", "tests/other.test.ts"], dependencies: [], evidence: [], unresolvedQuestions: [] };
  strategyWithExploration("Correct behavior and add focused tests", { execution_strategy: "planned",
    execution_effort: "normal", strategy_reason: "task", likelyFiles: [] } as any, exploration);
  assert.deepEqual(exploration.editableCandidates.map((file: any) => file.path), ["src/example.ts"]);
  assert.equal(exploration.relatedTests.length, 2);
});

test("broad file packets decompose into dependent exact scopes without coalescing them back", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "koda-packet-plan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"));
  const files = ["src/first.ts", "src/second.ts"];
  for (const file of files) await writeFile(join(root, file), "// implementation\n".repeat(3000));
  const plan = await compileTask({ config: { planner: {} }, logger: { log() {} } } as any,
    "Modify both source components while preserving their public interface.",
    { files, verificationCommands: [] } as any, undefined,
    { editableCandidates: files.map((path) => ({ path, reason: "existing implementation" })), relatedTests: [], readonlyFiles: [] } as any, root);
  const normalized = normalizePlan(plan).plan;
  assert.equal(normalized.subtasks.length, 2);
  assert.deepEqual(normalized.subtasks[1]!.dependsOn, [normalized.subtasks[0]!.id]);
  assert.ok(normalized.subtasks.every((task) => task.likelyWritePaths.length === 1 && !task.parallelSafe));
  assert.ok(normalized.subtasks.every((task) => Buffer.byteLength(task.objective) < MAX_TASK_SPEC_BYTES));
});

test("output-limit recovery never resends the full localized file packet", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "koda-packet-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "example.ts"), "export const value=1;\n");
  const plan = await planCodingHandoff({ repoPath: root, task: "Correct the value", writeScope: ["example.ts"],
    attemptTokenCapacity: 100000, remainingRunTokens: 100000, modelContextTokens: 1000000,
    maxOutputTokens: 4096, costCapacityUsd: 1, directEditEligible: false,
    context: { relevantFiles: ["example.ts"], evidence: { relevantFiles: ["example.ts"] },
      implementationRecovery: { reason: "output_limit" } } });
  assert.equal(plan.mode, "agentic");
  assert.ok(plan.estimatedPromptBytes < MAX_CODING_PACKET_BYTES);
  assert.match(plan.reason, /continuation/);
});

test("model-independent output and context caps reject oversized completions before dispatch", () => {
  assert.throws(() => admitProviderPayload({ messages: [{ content: "small" }] }, 4097), /preflight/);
  assert.throws(() => admitProviderPayload({ messages: [{ content: "small" }] }, 1000, 500), /preflight/);
});

test("TaskSpec preserves sentence punctuation and newlines inside exact literals", () => {
  const spec = compileTaskSpec('Set the message to "Ready. Go!" and the template to `first\nsecond`. Preserve it exactly.');
  assert.ok(spec.routingPrompt.includes('"Ready. Go!"'));
  assert.ok(spec.routingPrompt.includes('`first\nsecond`'));
});

test("decomposed multi-file work produces actual mutations and passes real focused and final checks", async (t) => {
  const { implement } = await import("../src/agent/codingExecutor.js");
  const { config } = await import("../src/config.js");
  const { Budget } = await import("../src/openrouter/usage.js");
  const { Logger } = await import("../src/telemetry/logger.js");
  const { verify } = await import("../src/verifier/verifier.js");
  const { readFile } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "koda-packet-mutation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src")); await mkdir(join(root, "tests"));
  const files = ["src/first.cjs", "src/second.cjs"];
  for (const file of files) {
    await writeFile(join(root, file), "module.exports = 1;\n" + "// bounded context\n".repeat(3000));
    const name = file.split("/").pop()!;
    await writeFile(join(root, `tests/${name}.test.cjs`),
      `const {test}=require('node:test');const a=require('node:assert/strict');test('value',()=>a.equal(require('../${file}'),2));\n`);
  }
  const { execa } = await import("execa");
  await execa("git", ["init", "-q"], { cwd: root });
  await execa("git", ["add", "src", "tests"], { cwd: root });
  await execa("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-qm", "baseline"], { cwd: root });
  const cfg = await config(undefined, { maxIterations: 1, maxInputPrice: 1, maxOutputPrice: 1 });
  const gateway: any = { config: cfg, logger: new Logger(join(root, ".koda"), "bounded-mutation", true),
    budget: new Budget(1, 100000, 60000) };
  const profile: any = { files, verificationCommands: [] };
  const plan = await compileTask(gateway, "Change both component values to two.", profile, undefined,
    { editableCandidates: files.map((path) => ({ path, reason: "source" })), relatedTests: [], readonlyFiles: [] } as any, root);
  for (const task of plan.subtasks) {
    const file = task.likelyWritePaths[0]!;
    task.verificationCommands = [`node --test tests/${file.split("/").pop()!}.test.cjs`, `node --check ${file}`];
    const result = await implement(gateway, root, "Change both component values to two.", task, plan, profile, {
      model: "arbitrary/model", codingWorker: { engine: "agentic", async run(input) {
        assert.deepEqual(input.writeScope, [file]);
        const source = await readFile(join(root, file), "utf8");
        await writeFile(join(root, file), source.replace("exports = 1", "exports = 2"));
        return { exitStatus: "completed", model: input.model, engine: "agentic", engineVersion: "fixture",
          changedPaths: [file], wallClockMs: 1 };
      } }, compiledContext: { files: [{ path: file, snippet: "module.exports = 1;" }],
        localDependencies: [], completePaths: [file], repoMap: files } as any,
    });
    assert.equal(result.verification.status, "VERIFIED_SUCCESS");
    assert.ok((await readFile(join(root, file), "utf8")).startsWith("module.exports = 2;"));
    await execa("git", ["add", file], { cwd: root });
    await execa("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-qm", "integrated scoped contribution"], { cwd: root });
  }
  const final = await verify(root, ["node --test tests/*.test.cjs", ...files.map((file) => `node --check ${file}`)], 10000);
  assert.equal(final.status, "VERIFIED_SUCCESS");
  assert.ok(final.checks.every((check) => check.outcome === "CHECK_PASS"));
});

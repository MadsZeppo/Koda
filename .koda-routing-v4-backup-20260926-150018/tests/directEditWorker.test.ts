import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DirectEditWorker, type DirectEditRequester } from "../src/agent/directEditWorker.js";
import type { CodingWorkerInput } from "../src/agent/codingWorker.js";
import { Budget } from "../src/openrouter/usage.js";
import { Logger } from "../src/telemetry/logger.js";

const input = (repoPath: string, target = "tests/controlPolicy.test.ts"): CodingWorkerInput => ({
  repoPath,
  attemptId: "direct",
  task: "Add a deterministic regression test proving recovery stops when maxCodingAttempts is reached.",
  model: "vendor/direct-model",
  budgetUsd: 0.05,
  maxTokens: 12_000,
  maxSteps: 10,
  timeoutMs: 45_000,
  requestTimeoutMs: 30_000,
  commandTimeoutMs: 5_000,
  maxOutputTokens: 4_096,
  maxToolOutputBytes: 4_000,
  promptPricePerMillion: 1,
  completionPricePerMillion: 2,
  baseUrl: "https://openrouter.ai/api/v1",
  sessionId: "run/direct/vendor-direct-model",
  writeScope: [target],
  returnOnMutation: true,
  context: {
    relevantFiles: [target, "src/router/controlPolicy.ts"],
    sourceFiles: [{
      path: "src/router/controlPolicy.ts",
      snippet: "export function chooseAdaptiveRecovery() { return null; }",
    }],
  },
});

const usage = {
  prompt_tokens: 120,
  completion_tokens: 60,
  cost: 0.001,
  prompt_tokens_details: { cached_tokens: 20 },
};

test("DIRECT edit worker performs one structured call, mutates only the locked target and returns immediately", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-direct-edit-"));
  const logs = await mkdtemp(join(tmpdir(), "koda-direct-edit-logs-"));
  await mkdir(join(root, "tests"), { recursive: true });
  await mkdir(join(root, "src/router"), { recursive: true });
  await writeFile(join(root, "tests/controlPolicy.test.ts"),
    "import { test } from 'node:test';\n\ntest('existing', () => {});\n");
  await writeFile(join(root, "src/router/controlPolicy.ts"), "export const maxCodingAttempts = 2;\n");
  let calls = 0;
  const requester: DirectEditRequester = async (_input, messages, tool, maxOutputTokens) => {
    calls++;
    assert.equal(tool.type, "function");
    assert.equal(tool.function.name, "submit_direct_edit");
    assert.ok(maxOutputTokens <= 4096);
    assert.match(JSON.stringify(messages), /controlPolicy\.test\.ts/);
    return {
      model: "vendor/direct-model",
      usage,
      toolCalls: [{
        type: "function",
        function: {
          name: "submit_direct_edit",
          arguments: JSON.stringify({
            path: "tests/controlPolicy.test.ts",
            edits: [{
              oldText: "test('existing', () => {});",
              newText: "test('existing', () => {});\n\ntest('recovery stops at maxCodingAttempts', () => {});",
            }],
          }),
        },
      }],
    };
  };

  try {
    const worker = new DirectEditWorker(
      new Budget(1, 100_000, 60_000),
      new Logger(logs, "direct-one-shot", true),
      requester,
    );
    const result = await worker.run(input(root));
    assert.equal(calls, 1);
    assert.equal(result.exitStatus, "completed");
    assert.equal(result.engine, "direct-edit");
    assert.equal(result.steps, 1);
    assert.equal(result.progressPhase, "MUTATION_OBSERVED");
    assert.deepEqual(result.changedPaths, ["tests/controlPolicy.test.ts"]);
    assert.match(await readFile(join(root, "tests/controlPolicy.test.ts"), "utf8"),
      /recovery stops at maxCodingAttempts/);
    assert.equal(await readFile(join(root, "src/router/controlPolicy.ts"), "utf8"),
      "export const maxCodingAttempts = 2;\n");
  } finally {
    await Promise.all([root, logs].map((path) => rm(path, { recursive: true, force: true })));
  }
});

test("DIRECT edit worker rejects a model attempt to write outside the locked target", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-direct-edit-scope-"));
  const logs = await mkdtemp(join(tmpdir(), "koda-direct-edit-scope-logs-"));
  await mkdir(join(root, "tests"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "tests/controlPolicy.test.ts"), "test('safe', () => {});\n");
  await writeFile(join(root, "src/other.ts"), "export const safe = true;\n");
  const requester: DirectEditRequester = async () => ({
    model: "vendor/direct-model",
    usage,
    toolCalls: [{
      type: "function",
      function: {
        name: "submit_direct_edit",
        arguments: JSON.stringify({
          path: "src/other.ts",
          edits: [{ oldText: "true", newText: "false" }],
        }),
      },
    }],
  });

  try {
    const worker = new DirectEditWorker(
      new Budget(1, 100_000, 60_000),
      new Logger(logs, "direct-scope", true),
      requester,
    );
    const result = await worker.run(input(root));
    assert.equal(result.exitStatus, "failed");
    assert.equal(result.terminationReason, "direct_edit_protocol_error");
    assert.equal(await readFile(join(root, "src/other.ts"), "utf8"),
      "export const safe = true;\n");
  } finally {
    await Promise.all([root, logs].map((path) => rm(path, { recursive: true, force: true })));
  }
});

test("DIRECT edit worker can create a new locked target without repository discovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-direct-create-"));
  const logs = await mkdtemp(join(tmpdir(), "koda-direct-create-logs-"));
  await mkdir(join(root, "src"), { recursive: true });
  const requester: DirectEditRequester = async () => ({
    model: "vendor/direct-model",
    usage,
    toolCalls: [{
      type: "function",
      function: {
        name: "submit_direct_edit",
        arguments: JSON.stringify({
          path: "src/newHelper.ts",
          createContent: "export const answer = 42;\n",
        }),
      },
    }],
  });

  try {
    const worker = new DirectEditWorker(
      new Budget(1, 100_000, 60_000),
      new Logger(logs, "direct-create", true),
      requester,
    );
    const request = input(root, "src/newHelper.ts");
    request.task = "Create src/newHelper.ts exporting answer = 42.";
    const result = await worker.run(request);
    assert.equal(result.exitStatus, "completed");
    assert.equal(await readFile(join(root, "src/newHelper.ts"), "utf8"),
      "export const answer = 42;\n");
  } finally {
    await Promise.all([root, logs].map((path) => rm(path, { recursive: true, force: true })));
  }
});

test("DIRECT edit worker tolerates neutral optional tool defaults on an existing target", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-direct-neutral-"));
  const logs = await mkdtemp(join(tmpdir(), "koda-direct-neutral-logs-"));
  await mkdir(join(root, "tests"), { recursive: true });
  await writeFile(join(root, "tests/controlPolicy.test.ts"), "test('existing', () => {});\n");
  const requester: DirectEditRequester = async () => ({
    model: "vendor/direct-model",
    usage,
    toolCalls: [{
      type: "function",
      function: {
        name: "submit_direct_edit",
        arguments: JSON.stringify({
          path: "tests/controlPolicy.test.ts",
          edits: [{ oldText: "existing", newText: "updated" }],
          createContent: "",
          delete: false,
        }),
      },
    }],
  });

  try {
    const worker = new DirectEditWorker(
      new Budget(1, 100_000, 60_000),
      new Logger(logs, "direct-neutral", true),
      requester,
    );
    const result = await worker.run(input(root));
    assert.equal(result.exitStatus, "completed");
    assert.match(await readFile(join(root, "tests/controlPolicy.test.ts"), "utf8"), /updated/);
  } finally {
    await Promise.all([root, logs].map((path) => rm(path, { recursive: true, force: true })));
  }
});

test("DIRECT edit worker still rejects a non-empty createContent combined with edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-direct-conflict-"));
  const logs = await mkdtemp(join(tmpdir(), "koda-direct-conflict-logs-"));
  await mkdir(join(root, "tests"), { recursive: true });
  await writeFile(join(root, "tests/controlPolicy.test.ts"), "test('existing', () => {});\n");
  const requester: DirectEditRequester = async () => ({
    model: "vendor/direct-model",
    usage,
    toolCalls: [{
      type: "function",
      function: {
        name: "submit_direct_edit",
        arguments: JSON.stringify({
          path: "tests/controlPolicy.test.ts",
          edits: [{ oldText: "existing", newText: "updated" }],
          createContent: "not allowed for an existing file",
          delete: false,
        }),
      },
    }],
  });

  try {
    const worker = new DirectEditWorker(
      new Budget(1, 100_000, 60_000),
      new Logger(logs, "direct-conflict", true),
      requester,
    );
    const result = await worker.run(input(root));
    assert.equal(result.exitStatus, "failed");
    assert.equal(result.terminationReason, "direct_edit_protocol_error");
    assert.equal(await readFile(join(root, "tests/controlPolicy.test.ts"), "utf8"),
      "test('existing', () => {});\n");
  } finally {
    await Promise.all([root, logs].map((path) => rm(path, { recursive: true, force: true })));
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";

import {
  DirectEditWorker,
  directEditRequestTimeoutMs,
  type DirectEditRequester,
} from "../src/agent/directEditWorker.js";
import type { CodingWorkerInput } from "../src/agent/codingWorker.js";
import { Budget } from "../src/openrouter/usage.js";
import { Logger } from "../src/telemetry/logger.js";

const input = (
  repoPath: string,
  target = "tests/controlPolicy.test.ts",
): CodingWorkerInput => ({
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
    sourceFiles: [
      {
        path: "src/router/controlPolicy.ts",
        snippet:
          "export function chooseAdaptiveRecovery(policy, attempted) {\n" +
          "  if (attempted.size >= policy.maxCodingAttempts) return undefined;\n" +
          "}\n",
      },
    ],
  },
});

const usage = {
  prompt_tokens: 120,
  completion_tokens: 60,
  cost: 0.001,
  prompt_tokens_details: {
    cached_tokens: 20,
  },
};

const validEditResponse = () => ({
  model: "vendor/direct-model",
  usage,
  content: null,
  toolCalls: [
    {
      type: "function",
      function: {
        name: "submit_direct_edit",
        arguments: JSON.stringify({
          path: "tests/controlPolicy.test.ts",
          edits: [
            {
              oldText: "test('existing', () => {});",
              newText:
                "test('existing', () => {});\n\n" +
                "test('recovery stops at maxCodingAttempts', () => {});",
            },
          ],
        }),
      },
    },
  ],
});

const exactEditResponse = (
  path: string,
  oldText: string,
  newText: string,
  responseUsage: unknown = usage,
) => ({
  model: "vendor/direct-model",
  usage: responseUsage,
  content: null,
  toolCalls: [
    {
      type: "function",
      function: {
        name: "submit_direct_edit",
        arguments: JSON.stringify({
          path,
          edits: [{ oldText, newText }],
        }),
      },
    },
  ],
});

test("DIRECT uses the coding-attempt timeout instead of silently shortening it to the generic model timeout", () => {
  const request = input("/tmp/repo");

  assert.equal(request.timeoutMs, 45_000);

  assert.equal(request.requestTimeoutMs, 30_000);

  assert.equal(directEditRequestTimeoutMs(request), 45_000);
});

test("DIRECT immediately returns an operational incompatibility when required tool choice is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-direct-required-tool-"));
  const logs = await mkdtemp(join(tmpdir(), "koda-direct-required-tool-logs-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src/value.js"), "export const value = 1;\n");

  const requestBodies: any[] = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const requestBody = JSON.parse(raw);
    requestBodies.push(requestBody);
    response.setHeader("content-type", "application/json");
    if (requestBody.tool_choice === "required") {
      response.statusCode = 404;
      response.end(
        JSON.stringify({
          error: {
            message:
              "No endpoints found that support the provided 'tool_choice' value.",
            code: 404,
          },
        }),
      );
      return;
    }
    assert.fail("Koda must not weaken DIRECT to auto after a required tool protocol rejection");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key";

  try {
    const request = input(root, "src/value.js");
    request.task = "Change the exported value to 2.";
    request.baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`;
    const logger = new Logger(logs, "direct-required-tool", true);
    const result = await new DirectEditWorker(
      new Budget(1, 100_000, 60_000),
      logger,
    ).run(request);

    assert.deepEqual(requestBodies.map((body) => body.tool_choice), ["required"]);
    assert.equal(result.exitStatus, "infra_failure");
    assert.match(result.fatalError ?? "", /tool_choice/i);
    assert.equal(
      await readFile(join(root, "src/value.js"), "utf8"),
      "export const value = 1;\n",
    );
    assert.equal(
      logger.events.filter(
        (event) => event.type === "direct_edit_protocol_incompatible",
      ).length,
      1,
    );
  } finally {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all(
      [root, logs].map((path) => rm(path, { recursive: true, force: true })),
    );
  }
});

test("DIRECT edit worker performs one structured call, mutates only the locked target and returns immediately", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-direct-edit-"));

  const logs = await mkdtemp(join(tmpdir(), "koda-direct-edit-logs-"));

  await mkdir(join(root, "tests"), {
    recursive: true,
  });

  await mkdir(join(root, "src/router"), {
    recursive: true,
  });

  await writeFile(
    join(root, "tests/controlPolicy.test.ts"),
    "import { test } from 'node:test';\n\n" + "test('existing', () => {});\n",
  );

  await writeFile(
    join(root, "src/router/controlPolicy.ts"),
    "export const maxCodingAttempts = 2;\n",
  );

  let calls = 0;

  const requester: DirectEditRequester = async (
    _input,
    messages,
    tool,
    maxOutputTokens,
  ) => {
    calls++;

    assert.equal(tool.type, "function");

    assert.equal(tool.function.name, "submit_direct_edit");

    assert.ok(maxOutputTokens <= 2048);

    const serialized = JSON.stringify(messages);

    assert.match(serialized, /controlPolicy\.test\.ts/);

    assert.match(serialized, /attempted\.size >= policy\.maxCodingAttempts/);

    return validEditResponse();
  };

  try {
    const logger = new Logger(logs, "direct-one-shot", true);

    const worker = new DirectEditWorker(
      new Budget(1, 100_000, 60_000),
      logger,
      requester,
    );

    const result = await worker.run(input(root));

    assert.equal(calls, 1);

    assert.equal(result.exitStatus, "completed");

    assert.equal(result.engine, "direct-edit");

    assert.equal(result.steps, 1);

    assert.equal(result.progressPhase, "MUTATION_OBSERVED");

    assert.deepEqual(result.changedPaths, ["tests/controlPolicy.test.ts"]);

    assert.match(
      await readFile(join(root, "tests/controlPolicy.test.ts"), "utf8"),
      /recovery stops at maxCodingAttempts/,
    );

    assert.equal(
      await readFile(join(root, "src/router/controlPolicy.ts"), "utf8"),
      "export const maxCodingAttempts = 2;\n",
    );

    const providerPolicy = logger.events.find(
      (event) => event.type === "provider_policy",
    );

    assert.deepEqual(providerPolicy?.provider?.sort, {
      by: "price",
      partition: "none",
    });

    assert.deepEqual(providerPolicy?.provider?.preferred_max_latency, {
      p90: 3,
    });
  } finally {
    await Promise.all(
      [root, logs].map((path) =>
        rm(path, {
          recursive: true,
          force: true,
        }),
      ),
    );
  }
});

test("DIRECT grounds repeated task symbols in both declarations and enforcing definitions", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-direct-symbol-grounding-"));
  const logs = await mkdtemp(
    join(tmpdir(), "koda-direct-symbol-grounding-logs-"),
  );
  await mkdir(join(root, "tests"), { recursive: true });
  await mkdir(join(root, "src/router"), { recursive: true });
  await writeFile(
    join(root, "tests/controlPolicy.test.ts"),
    "import { test } from 'node:test';\n\ntest('existing', () => {});\n",
  );
  const implementation = [
    "export interface Policy { maxCodingAttempts: number }",
    ...Array.from(
      { length: 120 },
      (_, index) => `export const unrelated${index} = ${index};`,
    ),
    "export function chooseAdaptiveRecovery(policy: Policy, attempted: Set<string>) {",
    "  if (attempted.size >= policy.maxCodingAttempts) return undefined;",
    "  return 'next';",
    "}",
  ].join("\n");
  await writeFile(join(root, "src/router/controlPolicy.ts"), implementation);

  let calls = 0;
  const requester: DirectEditRequester = async (_request, messages) => {
    calls++;
    const prompt = JSON.stringify(messages);
    assert.match(prompt, /interface Policy \{ maxCodingAttempts: number \}/);
    assert.match(
      prompt,
      /attempted\.size >= policy\.maxCodingAttempts/,
      "the bounded prompt must include the enforcing definition, not only the first declaration",
    );
    return validEditResponse();
  };

  try {
    const request = input(root);
    request.maxTokens = 8192;
    request.maxOutputTokens = 2048;
    request.context!.sourceFiles = [
      { path: "src/router/controlPolicy.ts", snippet: implementation },
    ];
    const result = await new DirectEditWorker(
      new Budget(1, 100_000, 60_000),
      new Logger(logs, "direct-symbol-grounding", true),
      requester,
    ).run(request);

    assert.equal(calls, 1);
    assert.equal(result.exitStatus, "completed");
    assert.deepEqual(result.changedPaths, ["tests/controlPolicy.test.ts"]);
  } finally {
    await Promise.all(
      [root, logs].map((path) => rm(path, { recursive: true, force: true })),
    );
  }
});

test("DIRECT repairs one missing tool call on the same model before escalating", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-direct-repair-"));

  const logs = await mkdtemp(join(tmpdir(), "koda-direct-repair-logs-"));

  await mkdir(join(root, "tests"), {
    recursive: true,
  });

  await writeFile(
    join(root, "tests/controlPolicy.test.ts"),
    "test('existing', () => {});\n",
  );

  let calls = 0;

  const requester: DirectEditRequester = async (_input, messages) => {
    calls++;

    if (calls === 1) {
      return {
        model: "vendor/direct-model",
        usage,
        content: "I will add the regression test.",
        toolCalls: [],
      };
    }

    assert.equal(calls, 2);

    assert.match(JSON.stringify(messages), /PROTOCOL REPAIR/);

    assert.match(JSON.stringify(messages), /submit_direct_edit exactly once/);

    return validEditResponse();
  };

  try {
    const logger = new Logger(logs, "direct-protocol-repair", true);

    const worker = new DirectEditWorker(
      new Budget(1, 100_000, 60_000),
      logger,
      requester,
    );

    const result = await worker.run(input(root));

    assert.equal(calls, 2);

    assert.equal(result.exitStatus, "completed");

    assert.equal(result.steps, 2);

    assert.deepEqual(result.changedPaths, ["tests/controlPolicy.test.ts"]);

    assert.match(
      await readFile(join(root, "tests/controlPolicy.test.ts"), "utf8"),
      /maxCodingAttempts/,
    );

    assert.ok(
      logger.events.some(
        (event) => event.type === "direct_edit_protocol_repair",
      ),
    );
  } finally {
    await Promise.all(
      [root, logs].map((path) =>
        rm(path, {
          recursive: true,
          force: true,
        }),
      ),
    );
  }
});

test("DIRECT stops after one bounded protocol repair if the model still refuses the tool contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-direct-repair-fail-"));

  const logs = await mkdtemp(join(tmpdir(), "koda-direct-repair-fail-logs-"));

  await mkdir(join(root, "tests"), {
    recursive: true,
  });

  await writeFile(
    join(root, "tests/controlPolicy.test.ts"),
    "test('existing', () => {});\n",
  );

  let calls = 0;

  const requester: DirectEditRequester = async () => {
    calls++;

    return {
      model: "vendor/direct-model",
      usage,
      content: "I cannot provide the requested tool call.",
      toolCalls: [],
    };
  };

  try {
    const worker = new DirectEditWorker(
      new Budget(1, 100_000, 60_000),
      new Logger(logs, "direct-protocol-repair-fail", true),
      requester,
    );

    const result = await worker.run(input(root));

    assert.equal(calls, 2);

    assert.equal(result.exitStatus, "failed");

    assert.equal(result.terminationReason, "direct_edit_protocol_error");

    assert.match(result.fatalError ?? "", /after bounded protocol repair/);
  } finally {
    await Promise.all(
      [root, logs].map((path) =>
        rm(path, {
          recursive: true,
          force: true,
        }),
      ),
    );
  }
});

test("DIRECT edit worker rejects a model attempt to write outside the locked target", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-direct-edit-scope-"));

  const logs = await mkdtemp(join(tmpdir(), "koda-direct-edit-scope-logs-"));

  await mkdir(join(root, "tests"), {
    recursive: true,
  });

  await mkdir(join(root, "src"), {
    recursive: true,
  });

  await writeFile(
    join(root, "tests/controlPolicy.test.ts"),
    "test('safe', () => {});\n",
  );

  await writeFile(join(root, "src/other.ts"), "export const safe = true;\n");

  const requester: DirectEditRequester = async () => ({
    model: "vendor/direct-model",
    usage,
    toolCalls: [
      {
        type: "function",
        function: {
          name: "submit_direct_edit",
          arguments: JSON.stringify({
            path: "src/other.ts",
            edits: [
              {
                oldText: "true",
                newText: "false",
              },
            ],
          }),
        },
      },
    ],
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

    assert.equal(
      await readFile(join(root, "src/other.ts"), "utf8"),
      "export const safe = true;\n",
    );
  } finally {
    await Promise.all(
      [root, logs].map((path) =>
        rm(path, {
          recursive: true,
          force: true,
        }),
      ),
    );
  }
});

test("DIRECT edit worker can create a new locked target without repository discovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-direct-create-"));

  const logs = await mkdtemp(join(tmpdir(), "koda-direct-create-logs-"));

  await mkdir(join(root, "src"), {
    recursive: true,
  });

  const requester: DirectEditRequester = async () => ({
    model: "vendor/direct-model",
    usage,
    toolCalls: [
      {
        type: "function",
        function: {
          name: "submit_direct_edit",
          arguments: JSON.stringify({
            path: "src/newHelper.ts",
            createContent: "export const answer = 42;\n",
          }),
        },
      },
    ],
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

    assert.equal(
      await readFile(join(root, "src/newHelper.ts"), "utf8"),
      "export const answer = 42;\n",
    );
  } finally {
    await Promise.all(
      [root, logs].map((path) =>
        rm(path, {
          recursive: true,
          force: true,
        }),
      ),
    );
  }
});

test("DIRECT edit worker tolerates neutral optional tool defaults on an existing target", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-direct-neutral-"));

  const logs = await mkdtemp(join(tmpdir(), "koda-direct-neutral-logs-"));

  await mkdir(join(root, "tests"), {
    recursive: true,
  });

  await writeFile(
    join(root, "tests/controlPolicy.test.ts"),
    "test('existing', () => {});\n",
  );

  const requester: DirectEditRequester = async () => ({
    model: "vendor/direct-model",
    usage,
    toolCalls: [
      {
        type: "function",
        function: {
          name: "submit_direct_edit",
          arguments: JSON.stringify({
            path: "tests/controlPolicy.test.ts",
            edits: [
              {
                oldText: "existing",
                newText: "updated",
              },
            ],
            createContent: "",
            delete: false,
          }),
        },
      },
    ],
  });

  try {
    const worker = new DirectEditWorker(
      new Budget(1, 100_000, 60_000),
      new Logger(logs, "direct-neutral", true),
      requester,
    );

    const result = await worker.run(input(root));

    assert.equal(result.exitStatus, "completed");

    assert.match(
      await readFile(join(root, "tests/controlPolicy.test.ts"), "utf8"),
      /updated/,
    );
  } finally {
    await Promise.all(
      [root, logs].map((path) =>
        rm(path, {
          recursive: true,
          force: true,
        }),
      ),
    );
  }
});

test("DIRECT edit worker still rejects a non-empty createContent combined with edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-direct-conflict-"));

  const logs = await mkdtemp(join(tmpdir(), "koda-direct-conflict-logs-"));

  await mkdir(join(root, "tests"), {
    recursive: true,
  });

  await writeFile(
    join(root, "tests/controlPolicy.test.ts"),
    "test('existing', () => {});\n",
  );

  const requester: DirectEditRequester = async () => ({
    model: "vendor/direct-model",
    usage,
    toolCalls: [
      {
        type: "function",
        function: {
          name: "submit_direct_edit",
          arguments: JSON.stringify({
            path: "tests/controlPolicy.test.ts",
            edits: [
              {
                oldText: "existing",
                newText: "updated",
              },
            ],
            createContent: "not allowed for an existing file",
            delete: false,
          }),
        },
      },
    ],
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

    assert.equal(
      await readFile(join(root, "tests/controlPolicy.test.ts"), "utf8"),
      "test('existing', () => {});\n",
    );
  } finally {
    await Promise.all(
      [root, logs].map((path) =>
        rm(path, {
          recursive: true,
          force: true,
        }),
      ),
    );
  }
});

test("DIRECT repairs malformed JSON on the same model and aggregates both provider calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-direct-json-repair-"));
  const logs = await mkdtemp(join(tmpdir(), "koda-direct-json-repair-logs-"));
  await mkdir(join(root, "tests"), { recursive: true });
  await writeFile(
    join(root, "tests/controlPolicy.test.ts"),
    "test('existing', () => {});\n",
  );

  const seenInputs: CodingWorkerInput[] = [];
  let calls = 0;
  const requester: DirectEditRequester = async (request, messages) => {
    seenInputs.push(request);
    calls++;
    if (calls === 1) {
      return {
        model: "vendor/direct-model",
        usage: { prompt_tokens: 100, completion_tokens: 30, cost: 0.001 },
        toolCalls: [
          {
            type: "function",
            function: { name: "submit_direct_edit", arguments: '{"path":' },
          },
        ],
      };
    }
    const repair = JSON.stringify(messages);
    assert.match(repair, /arguments were not valid JSON/);
    assert.match(repair, /PREVIOUS ATTEMPT/);
    assert.match(repair, /\{\\"path\\":/);
    assert.match(repair, /test\('existing'/);
    return exactEditResponse(
      "tests/controlPolicy.test.ts",
      "test('existing', () => {});",
      "test('existing', () => {});\ntest('repaired', () => {});",
      { prompt_tokens: 80, completion_tokens: 20, cost: 0.002 },
    );
  };

  try {
    const logger = new Logger(logs, "direct-json-repair", true);
    const result = await new DirectEditWorker(
      new Budget(1, 100_000, 60_000),
      logger,
      requester,
    ).run(input(root));

    assert.equal(result.exitStatus, "completed");
    assert.equal(calls, 2);
    assert.equal(result.steps, 2);
    assert.equal(result.inputTokens, 180);
    assert.equal(result.outputTokens, 50);
    assert.equal(result.costUsd, 0.003);
    assert.ok(
      seenInputs.every((request) => request.model === "vendor/direct-model"),
    );
    assert.ok(seenInputs.every((request) => request.attemptId === "direct"));
    assert.ok(
      seenInputs.every(
        (request) => request.sessionId === "run/direct/vendor-direct-model",
      ),
    );
    const callsLogged = logger.events.filter(
      (event) => event.type === "model_call",
    );
    assert.equal(callsLogged.length, 1);
    assert.equal(callsLogged[0]?.providerCalls, 2);
    assert.equal(callsLogged[0]?.structuralRepair, true);
    assert.equal(callsLogged[0]?.promptTokens, 180);
    assert.equal(callsLogged[0]?.completionTokens, 50);
    assert.equal(callsLogged[0]?.costUsd, 0.003);
    assert.equal(
      logger.events.some((event) => event.type === "model_attempt"),
      false,
    );
  } finally {
    await Promise.all(
      [root, logs].map((path) => rm(path, { recursive: true, force: true })),
    );
  }
});

test("DIRECT refreshes the target after ambiguous oldText and repairs it exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-direct-ambiguous-repair-"));
  const logs = await mkdtemp(
    join(tmpdir(), "koda-direct-ambiguous-repair-logs-"),
  );
  await mkdir(join(root, "src"), { recursive: true });
  const source =
    "export const first = 1;\nexport const second = 1;\n" +
    Array.from(
      { length: 240 },
      (_, index) => `export const filler${index} = ${index};\n`,
    ).join("");
  await writeFile(join(root, "src/value.ts"), source);

  let calls = 0;
  const seenModels: string[] = [];
  let legacyByteCeiling = 0;
  let repairOutputLimit = 0;
  const requester: DirectEditRequester = async (
    request,
    messages,
    tool,
    maxOutputTokens,
  ) => {
    calls++;
    seenModels.push(request.model);
    if (calls === 1) {
      return exactEditResponse(
        "src/value.ts",
        " = 1;",
        ` = 2;\n${"// attempted structural payload\n".repeat(100)}`,
        { prompt_tokens: 1840, completion_tokens: 299, cost: 0.00046 },
      );
    }
    repairOutputLimit = maxOutputTokens;
    legacyByteCeiling =
      Buffer.byteLength(JSON.stringify({ messages, tools: [tool] })) + 256;
    const repair = JSON.stringify(messages);
    assert.match(repair, /oldText must occur exactly once/);
    assert.match(repair, /export const first = 1/);
    assert.match(repair, /export const second = 1/);
    return exactEditResponse(
      "src/value.ts",
      "export const second = 1;",
      "export const second = 2;",
    );
  };

  try {
    const logger = new Logger(logs, "direct-ambiguous-repair", true);
    const request = input(root, "src/value.ts");
    request.task = "Change only the second exported value to 2.";
    request.budgetUsd = 0.0036164;
    request.maxTokens = 8192;
    request.maxOutputTokens = 2048;
    request.promptPricePerMillion = 0.12;
    request.completionPricePerMillion = 0.8;
    const result = await new DirectEditWorker(
      new Budget(0.01, 20_000, 60_000),
      logger,
      requester,
    ).run(request);

    assert.equal(result.exitStatus, "completed");
    assert.equal(calls, 2);
    assert.deepEqual(seenModels, [request.model, request.model]);
    assert.ok(
      legacyByteCeiling > 6053,
      "the production regression would reject this repair when bytes are counted as tokens",
    );
    assert.ok(
      repairOutputLimit >= 128,
      "reported remaining tokens and dollars must fund the same-model repair",
    );
    assert.equal(
      await readFile(join(root, "src/value.ts"), "utf8"),
      source.replace("export const second = 1;", "export const second = 2;"),
    );
    const repairEvent = logger.events.find(
      (event) => event.type === "direct_edit_protocol_repair",
    );
    assert.equal(repairEvent?.repair_reason, "mechanical_patch_rejected");
    assert.equal(repairEvent?.structural_repair, true);
    assert.equal(repairEvent?.same_model, true);
    assert.ok(repairEvent?.repair_prompt_token_ceiling < 6053);
  } finally {
    await Promise.all(
      [root, logs].map((path) => rm(path, { recursive: true, force: true })),
    );
  }
});

test("DIRECT refreshes stale oldText before one corrected same-model edit", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-direct-stale-repair-"));
  const logs = await mkdtemp(join(tmpdir(), "koda-direct-stale-repair-logs-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src/value.ts"), "export const value = 1;\n");

  let calls = 0;
  const requester: DirectEditRequester = async (_request, messages) => {
    calls++;
    if (calls === 1) {
      return exactEditResponse(
        "src/value.ts",
        "export const value = 0;",
        "export const value = 2;",
      );
    }
    const repair = JSON.stringify(messages);
    assert.match(repair, /oldText was not found after local refresh/);
    assert.match(repair, /export const value = 1/);
    return exactEditResponse(
      "src/value.ts",
      "export const value = 1;",
      "export const value = 2;",
    );
  };

  try {
    const request = input(root, "src/value.ts");
    request.task = "Change the exported value to 2.";
    const result = await new DirectEditWorker(
      new Budget(1, 100_000, 60_000),
      new Logger(logs, "direct-stale-repair", true),
      requester,
    ).run(request);
    assert.equal(result.exitStatus, "completed");
    assert.equal(calls, 2);
    assert.equal(
      await readFile(join(root, "src/value.ts"), "utf8"),
      "export const value = 2;\n",
    );
  } finally {
    await Promise.all(
      [root, logs].map((path) => rm(path, { recursive: true, force: true })),
    );
  }
});

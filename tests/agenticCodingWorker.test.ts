import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  access,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Budget } from "../src/openrouter/usage.js";
import {
  AgenticCodingWorker,
  type AgenticCodingResponse,
} from "../src/agent/agenticCodingWorker.js";
import { AgentTools } from "../src/agent/tools.js";

test(
  "agentic worker can create a file in an empty repo without preloading repository contents",
  async () => {
    const root =
      await mkdtemp(
        join(
          tmpdir(),
          "koda-agentic-",
        ),
      );

    const logger = {
      events: [] as any[],
      log(
        type: string,
        payload: any,
      ) {
        this.events.push({
          type,
          ...payload,
        });
      },
    } as any;

    const budget =
      new Budget(
        1,
        20_000,
        60_000,
      );

    let call = 0;

    const worker =
      new AgenticCodingWorker(
        budget,
        logger,
        async () => {
          call++;

          if (call === 1) {
            return {
              model: "mock/model",
              usage: {
                prompt_tokens: 50,
                completion_tokens: 20,
                cost: 0.0001,
              },
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: {
                      name: "write_file",
                      arguments:
                        JSON.stringify({
                          path: "hello.txt",
                          content:
                            "hello\n",
                        }),
                    },
                  },
                ],
              },
            } satisfies AgenticCodingResponse;
          }

          return {
            model: "mock/model",
            usage: {
              prompt_tokens: 70,
              completion_tokens: 10,
              cost: 0.0001,
            },
            message: {
              content: "done",
              tool_calls: [],
            },
          } satisfies AgenticCodingResponse;
        },
      );

    const result =
      await worker.run({
        repoPath: root,
        attemptId: "test",
        task:
          "Create hello.txt containing hello",
        model: "mock/model",
        budgetUsd: 0.1,
        maxTokens: 10_000,
        maxSteps: 4,
        timeoutMs: 30_000,
        requestTimeoutMs:
          5_000,
        commandTimeoutMs:
          5_000,
        maxOutputTokens:
          1_000,
        baseUrl:
          "http://unused",
        writeScope: ["."],
        promptPricePerMillion:
          1,
        completionPricePerMillion:
          1,
      });

    assert.equal(
      result.exitStatus,
      "completed",
    );

    assert.deepEqual(
      result.changedPaths,
      ["hello.txt"],
    );

    assert.equal(
      await readFile(
        join(
          root,
          "hello.txt",
        ),
        "utf8",
      ),
      "hello\n",
    );

    assert.ok(call >= 2);
  },
);

test("agentic mode supplies bounded excerpts and enforces implementation after two useful reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-agentic-excerpts-"));
  await writeFile(join(root, "a.ts"), "export function a() { return 1; }\n");
  await writeFile(join(root, "b.ts"), "export function b() { return 1; }\n");
  const events: any[] = [];
  const logger = { events, log: (type: string, payload: any) => events.push({ type, ...payload }) } as any;
  let calls = 0;
  const worker = new AgenticCodingWorker(new Budget(1, 20_000, 60_000), logger,
    async (_input, messages) => {
      calls++;
      if (calls === 1) {
        assert.match(String((messages[1] as any).content), /FILE EXCERPT a\.ts/);
        return { model: "mock", usage: { prompt_tokens: 200, completion_tokens: 50, cost: .0001 }, message: {
          tool_calls: ["a.ts", "b.ts", "a.ts", "b.ts", "a.ts", "b.ts"].map((path, index) => ({ id: `r${index}`, type: "function",
            function: { name: "read_file", arguments: JSON.stringify({ path, startLine: index + 1, endLine: index + 20 }) } })),
        } } as AgenticCodingResponse;
      }
      if (calls === 2) {
        const implementationPacket = String((messages[1] as any)?.content ?? "");

        assert.match(
          implementationPacket,
          /IMPLEMENTATION PHASE/,
        );

        assert.match(
          implementationPacket,
          /DISCOVERY EVIDENCE/,
        );

        assert.equal(
          messages.filter((message: any) => message.role === "tool").length,
          0,
          "old discovery tool history must be discarded before implementation",
        );
      }
      return { model: "mock", usage: { prompt_tokens: 300, completion_tokens: 50, cost: .0001 }, message: {
        tool_calls: [{ id: "edit", type: "function", function: { name: "edit_file", arguments: JSON.stringify({
          path: "a.ts", oldText: "return 1", newText: "return 2",
        }) } }],
      } } as AgenticCodingResponse;
    });
  const result = await worker.run({ repoPath: root, attemptId: "excerpt", task: "Update a using b", model: "mock",
    budgetUsd: .1, maxTokens: 10_000, maxSteps: 3, timeoutMs: 30_000, requestTimeoutMs: 5_000,
    commandTimeoutMs: 5_000, maxOutputTokens: 1_000, baseUrl: "unused", writeScope: ["a.ts"],
    context: { sourceFiles: [{ path: "a.ts", snippet: "export function a() { return 1; }" },
      { path: "b.ts", snippet: "export function b() { return 1; }" }], relevantFiles: ["a.ts", "b.ts"] } });
  assert.equal(result.exitStatus, "completed");
  assert.match(await readFile(join(root, "a.ts"), "utf8"), /return 2/);
  assert.ok(events.some((event) => event.type === "agentic_implementation_transition"));
  assert.equal(events.filter((event) => event.type === "agentic_discovery_call_deferred").length, 4);
});

test("repository reads deduplicate exact path and line ranges and expose a cheap outline", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-agent-tools-outline-"));
  await writeFile(join(root, "large.ts"), "export interface Item {}\nexport function run() { return 1; }\n");
  const logger = { log() {} } as any;
  const tools = new AgentTools(root, false, 5_000, logger, "outline");
  const first = await tools.execute("read_file", { path: "large.ts", startLine: 1, endLine: 20 });
  const repeated = await tools.execute("read_file", { path: "large.ts", startLine: 1, endLine: 20 });
  const outline = await tools.execute("file_outline", { path: "large.ts" });
  assert.match(first, /interface Item/);
  assert.match(repeated, /Already read/);
  assert.match(outline, /1: export interface Item/);
  assert.match(outline, /2: export function run/);
});

test("completion repair exposes only mutation tools and run_command cannot bypass the gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-completion-repair-"));
  await writeFile(join(root, "target.ts"), "export const value = 1;\n");
  const events: any[] = [];
  let call = 0;
  const worker = new AgenticCodingWorker(
    new Budget(1, 20_000, 60_000),
    { events, log: (type: string, payload: any) => events.push({ type, ...payload }) } as any,
    async (_input, _messages, tools) => {
      call++;
      const names = tools.flatMap((tool) =>
        "function" in tool ? [tool.function.name] : []).sort();
      if (call === 1) {
        assert.deepEqual(names, ["apply_patch", "edit_file", "write_file"]);
        return { model: "mock", usage: { prompt_tokens: 100, completion_tokens: 20, cost: .0001 }, message: {
          tool_calls: [{ id: "command", type: "function", function: {
            name: "run_command", arguments: JSON.stringify({ command: "printf bypass > target.ts" }),
          } }],
        } } as AgenticCodingResponse;
      }
      if (call === 2) {
        assert.deepEqual(names, ["apply_patch", "edit_file", "write_file"]);
        return { model: "mock", usage: { prompt_tokens: 120, completion_tokens: 30, cost: .0001 }, message: {
          tool_calls: [{ id: "edit", type: "function", function: {
            name: "edit_file", arguments: JSON.stringify({ path: "target.ts", oldText: "value = 1", newText: "value = 2" }),
          } }],
        } } as AgenticCodingResponse;
      }
      assert.ok(names.includes("run_command"), "normal repair tools reopen after mutation");
      return { model: "mock", usage: { prompt_tokens: 100, completion_tokens: 10, cost: .0001 }, message: {
        content: "done", tool_calls: [],
      } } as AgenticCodingResponse;
    },
  );
  const result = await worker.run({ repoPath: root, attemptId: "repair", task: "Finish R2", model: "mock",
    budgetUsd: .1, maxTokens: 10_000, maxSteps: 4, timeoutMs: 30_000, requestTimeoutMs: 5_000,
    commandTimeoutMs: 5_000, maxOutputTokens: 1_000, baseUrl: "unused", writeScope: ["target.ts"],
    context: { diagnostics: "R2 is missing", previousFailedDiff: "partial diff", completionRepair: {
      unresolvedRequirementIds: ["R2"], mutationRequiredBeforeDiscovery: true,
    } } });
  assert.equal(result.exitStatus, "completed");
  assert.equal(await readFile(join(root, "target.ts"), "utf8"), "export const value = 2;\n");
  assert.ok(events.some((event) => event.type === "completion_repair_tool_deferred" && event.tool === "run_command"));
});

test("completion repair requires another mutation after two reopened discovery reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-completion-repair-reads-"));
  await writeFile(join(root, "target.ts"), "export const value = 1;\n");
  let call = 0;
  const toolNames: string[][] = [];
  const worker = new AgenticCodingWorker(new Budget(1, 20_000, 60_000),
    { events: [], log() {} } as any, async (_input, _messages, tools) => {
      call++;
      toolNames.push(tools.flatMap((tool) => "function" in tool ? [tool.function.name] : []));
      const toolCall = (name: string, args: object) => ({ id: `c${call}`, type: "function", function: {
        name, arguments: JSON.stringify(args),
      } });
      if (call === 1) return { model: "mock", usage: { prompt_tokens: 100, completion_tokens: 20 }, message: {
        tool_calls: [toolCall("edit_file", { path: "target.ts", oldText: "value = 1", newText: "value = 2" })],
      } } as AgenticCodingResponse;
      if (call === 2) return { model: "mock", usage: { prompt_tokens: 100, completion_tokens: 20 }, message: {
        tool_calls: [
          toolCall("read_file", { path: "target.ts" }),
          { ...toolCall("file_outline", { path: "target.ts" }), id: "outline" },
        ],
      } } as AgenticCodingResponse;
      if (call === 3) return { model: "mock", usage: { prompt_tokens: 100, completion_tokens: 20 }, message: {
        tool_calls: [toolCall("edit_file", { path: "target.ts", oldText: "value = 2", newText: "value = 3" })],
      } } as AgenticCodingResponse;
      return { model: "mock", usage: { prompt_tokens: 100, completion_tokens: 10 }, message: { content: "done" } } as AgenticCodingResponse;
    });
  const result = await worker.run({ repoPath: root, attemptId: "repair-reads", task: "Finish R2", model: "mock",
    budgetUsd: .1, maxTokens: 10_000, maxSteps: 5, timeoutMs: 30_000, requestTimeoutMs: 5_000,
    commandTimeoutMs: 5_000, maxOutputTokens: 1_000, baseUrl: "unused", writeScope: ["target.ts"],
    context: { completionRepair: { unresolvedRequirementIds: ["R2"], mutationRequiredBeforeDiscovery: true } } });
  assert.equal(result.exitStatus, "completed");
  assert.ok(toolNames[1]!.includes("read_file"));
  assert.deepEqual(toolNames[2]!.sort(), ["apply_patch", "edit_file", "write_file"]);
  assert.match(await readFile(join(root, "target.ts"), "utf8"), /value = 3/);
});

test(
  "agentic worker bounds discovery history and reaches mutation under the former smoke token limit",
  async () => {
    const root = await mkdtemp(
      join(
        tmpdir(),
        "koda-agentic-history-",
      ),
    );

    await writeFile(
      join(root, "target.ts"),
      "export const value = 1;\n",
    );

    for (let index = 0; index < 8; index++) {
      await writeFile(
        join(root, `context-${index}.ts`),
        Array.from(
          { length: 500 },
          (_, line) =>
            `export const context_${index}_${line} = ${line};`,
        ).join("\n"),
      );
    }

    const logger = {
      events: [] as any[],
      log(
        type: string,
        payload: any,
      ) {
        this.events.push({
          type,
          ...payload,
        });
      },
    } as any;

    const budget = new Budget(
      1,
      30_000,
      60_000,
    );

    let call = 0;
    let sawBoundedHistory = false;

    const worker = new AgenticCodingWorker(
      budget,
      logger,
      async (
        _input,
        messages,
      ) => {
        call++;

        if (call === 1) {
          return {
            model: "mock/model",
            usage: {
              prompt_tokens: 500,
              completion_tokens: 100,
              cost: 0.0001,
            },
            message: {
              content: null,
              tool_calls: Array.from(
                { length: 8 },
                (_, index) => ({
                  id: `read-${index}`,
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: JSON.stringify({
                      path: index === 0 ? "target.ts" : `context-${index}.ts`,
                      startLine: 1,
                      endLine: 400,
                    }),
                  },
                }),
              ),
            },
          } satisfies AgenticCodingResponse;
        }

        if (call === 2) {
          const toolContents = messages
            .filter(
              (message: any) =>
                message.role === "tool",
            )
            .map(
              (message: any) =>
                String(message.content),
            );

          const implementationPacket =
            String((messages[1] as any)?.content ?? "");

          sawBoundedHistory =
            messages.length === 2 &&
            implementationPacket.includes(
              "IMPLEMENTATION PHASE",
            ) &&
            implementationPacket.includes(
              "DISCOVERY EVIDENCE",
            ) &&
            toolContents.length === 0;

          return {
            model: "mock/model",
            usage: {
              prompt_tokens: 1_500,
              completion_tokens: 100,
              cost: 0.0001,
            },
            message: {
              content: null,
              tool_calls: [
                {
                  id: "edit-1",
                  type: "function",
                  function: {
                    name: "edit_file",
                    arguments: JSON.stringify({
                      path: "target.ts",
                      oldText:
                        "export const value = 1;",
                      newText:
                        "export const value = 2;",
                    }),
                  },
                },
              ],
            },
          } satisfies AgenticCodingResponse;
        }

        return {
          model: "mock/model",
          usage: {
            prompt_tokens: 800,
            completion_tokens: 50,
            cost: 0.0001,
          },
          message: {
            content: "done",
            tool_calls: [],
          },
        } satisfies AgenticCodingResponse;
      },
    );

    const result = await worker.run({
      repoPath: root,
      attemptId: "history-test",
      task:
        "Inspect the context files and update target.ts",
      model: "mock/model",
      budgetUsd: 0.1,
      // This is deliberately the exact broken limit from the smoke log. The
      // worker must compact old tool output rather than fail before call 2.
      maxTokens: 8_758,
      maxSteps: 5,
      timeoutMs: 30_000,
      requestTimeoutMs: 5_000,
      commandTimeoutMs: 5_000,
      maxOutputTokens: 1_200,
      maxToolOutputBytes: 4_000,
      contextWindowTokens: 128_000,
      baseUrl: "http://unused",
      writeScope: ["target.ts"],
      promptPricePerMillion: 1,
      completionPricePerMillion: 1,
    });

    assert.equal(
      result.exitStatus,
      "completed",
    );
    assert.equal(
      result.limitKind,
      undefined,
    );
    assert.ok(
      call >= 3,
      "worker should reach the mutation and completion turns",
    );
    assert.equal(
      sawBoundedHistory,
      true,
      "discovery history should be replaced by a compact implementation packet before mutation",
    );
    assert.equal(
      await readFile(
        join(root, "target.ts"),
        "utf8",
      ),
      "export const value = 2;\n",
    );
    assert.equal(
      logger.events.filter(
        (event: any) =>
          event.type ===
          "agentic_discovery_call_deferred",
      ).length,
      6,
    );
  },
);

const workerInput = (root: string) => ({ repoPath: root, attemptId: "focused", task: "Correct a single value", model: "mock",
  budgetUsd: .1, maxTokens: 20_000, maxSteps: 6, timeoutMs: 30_000, requestTimeoutMs: 5_000,
  commandTimeoutMs: 5_000, maxOutputTokens: 1_000, baseUrl: "unused", writeScope: ["."], returnOnMutation: true });
const toolCall = (name: string, args: object, id = name) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const response = (...calls: ReturnType<typeof toolCall>[]): AgenticCodingResponse => ({ model: "mock",
  usage: { prompt_tokens: 100, completion_tokens: 20 }, message: { tool_calls: calls } });

test("root scoped single-file task returns inside the first mutation batch without running queued tests", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-root-return-"));
  await writeFile(join(root, "value.ts"), "export const value = 1;\n");
  let calls = 0;
  const worker = new AgenticCodingWorker(new Budget(1, 30_000, 60_000), { log() {} } as any, async () => {
    if (++calls === 1) return response(toolCall("read_file", { path: "value.ts" }));
    assert.equal(calls, 2, "no provider request after mutation");
    return response(toolCall("edit_file", { path: "value.ts", oldText: "= 1", newText: "= 2" }),
      toolCall("run_command", { command: "touch tests-ran" }),
      toolCall("write_file", { path: "extra.txt", content: "unexpected" }));
  });
  const result = await worker.run(workerInput(root));
  assert.equal(result.terminationReason, "candidate_ready_for_verification");
  assert.deepEqual(result.changedPaths, ["value.ts"]);
  assert.equal(calls, 2);
  await assert.rejects(access(join(root, "tests-ran")));
  await assert.rejects(access(join(root, "extra.txt")));
});

test("two successful searches cannot force mutation-only mode before a real read", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-search-read-"));
  await writeFile(join(root, "value.ts"), "export const value = 1;\n");
  let calls = 0;
  const worker = new AgenticCodingWorker(new Budget(1, 30_000, 60_000), { log() {} } as any,
    async (_input, messages, tools) => {
      calls++;
      const names = tools.flatMap((tool) => "function" in tool ? [tool.function.name] : []);
      if (calls === 1) return response(toolCall("search_code", { query: "value" }, "s1"), toolCall("search_code", { query: "export" }, "s2"));
      if (calls === 2) {
        assert.ok(names.includes("read_file"));
        assert.doesNotMatch(JSON.stringify(messages), /IMPLEMENTATION PHASE/);
        return response(toolCall("read_file", { path: "value.ts" }));
      }
      assert.ok(names.includes("read_file"), "unresolved root scope retains precise reads");
      return response(toolCall("edit_file", { path: "value.ts", oldText: "= 1", newText: "= 2" }));
    });
  assert.equal((await worker.run(workerInput(root))).exitStatus, "completed");
  assert.equal(calls, 3);
});

test("located code is forced through a bounded read before token accounting can starve the mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-read-reserve-"));
  await writeFile(join(root, "value.ts"), "export const value = 1;\n");
  let calls = 0;
  const worker = new AgenticCodingWorker(new Budget(1, 30_000, 60_000), { log() {} } as any,
    async (_input, _messages, tools) => {
      calls++;
      const names = tools.flatMap((tool) => "function" in tool ? [tool.function.name] : []);
      if (calls === 1) return { model: "mock", usage: { prompt_tokens: 4373, completion_tokens: 91 },
        message: { tool_calls: [toolCall("search_code", { query: "value" }, "s1"),
          toolCall("search_code", { query: "export" }, "s2")] } };
      if (calls === 2) {
        assert.deepEqual(names, ["read_file"], "located paths must advance to READ instead of another broad search turn");
        return { model: "mock", usage: { prompt_tokens: 6189, completion_tokens: 93 },
          message: { tool_calls: [toolCall("read_file", { path: "value.ts", startLine: 1, endLine: 20 })] } };
      }
      return response(toolCall("edit_file", { path: "value.ts", oldText: "= 1", newText: "= 2" }));
    });
  const result = await worker.run({ ...workerInput(root), maxTokens: 19_510 });
  assert.equal(calls, 3);
  assert.equal(result.terminationReason, "candidate_ready_for_verification");
  assert.equal(await readFile(join(root, "value.ts"), "utf8"), "export const value = 2;\n");
});

test("test-writing worker rejects paths outside the discovered runner glob", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-test-glob-"));
  await mkdir(join(root, "src"));
  await mkdir(join(root, "checks"));
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "tsx --test checks/*.test.ts" } }));
  let calls = 0;
  const worker = new AgenticCodingWorker(new Budget(1, 30_000, 60_000), { log() {} } as any,
    async (_input, messages) => {
      calls++;
      if (calls === 1) return response(toolCall("read_file", { path: "package.json" }));
      if (calls === 2) return response(toolCall("write_file", { path: "src/value.test.ts", content: "test" }));
      assert.match(JSON.stringify(messages), /test path must match/);
      return response(toolCall("write_file", { path: "checks/value.test.ts", content: "test" }));
    });
  const result = await worker.run({ ...workerInput(root), task: "Add a regression test" });
  assert.deepEqual(result.changedPaths, ["checks/value.test.ts"]);
  await assert.rejects(access(join(root, "src/value.test.ts")));
});


test("an existing file cannot be mutated from search results without reading it", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-mutation-read-"));
  await writeFile(join(root, "value.ts"), "export const value = 1;\n");
  let calls = 0;
  const worker = new AgenticCodingWorker(new Budget(1, 30_000, 60_000), { log() {} } as any,
    async () => {
      calls++;
      if (calls === 1) return response(toolCall("edit_file", { path: "value.ts", oldText: "= 1", newText: "= 2" }));
      assert.match(await readFile(join(root, "value.ts"), "utf8"), /= 1/);
      if (calls === 2) return response(toolCall("read_file", { path: "value.ts" }));
      return response(toolCall("edit_file", { path: "value.ts", oldText: "= 1", newText: "= 2" }));
    });
  assert.equal((await worker.run(workerInput(root))).exitStatus, "completed");
  assert.equal(calls, 3);
});


test("test-writing discovery retains read contents and allows the missing implementation read before a correct test mutation", async () => {
  const { verify } = await import("../src/verifier/verifier.js");
  const root = await mkdtemp(join(tmpdir(), "koda-root-evidence-"));
  await mkdir(join(root, "src"));
  await mkdir(join(root, "tests"));
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test tests/*.test.cjs" } }));
  await writeFile(join(root, "src/delivery.cjs"), "module.exports = () => ({engine: 'local', estimatedSpend: 0.25});\n");
  const original = "const {test}=require('node:test');const assert=require('node:assert/strict');const delivery=require('../src/delivery.cjs');\n" +
    "// existing setup\n".repeat(55) + "// IMPORTANT EXISTING TEST SETUP\n";
  await writeFile(join(root, "tests/delivery.test.cjs"), original);
  let calls = 0;
  const worker = new AgenticCodingWorker(new Budget(1, 30_000, 60_000), { log() {} } as any,
    async (_input, messages, tools) => {
      calls++;
      if (calls === 1) return response(toolCall("search_code", { query: "delivery" }, "s1"),
        toolCall("search_code", { query: "estimatedSpend" }, "s2"), toolCall("read_file", { path: "tests/delivery.test.cjs" }));
      if (calls === 2) {
        assert.match(JSON.stringify(messages), /IMPORTANT EXISTING TEST SETUP/,
          "implementation transition must preserve the actual read, not just a short search summary");
        assert.ok(tools.some((tool) => "function" in tool && tool.function.name === "read_file"));
        return response(toolCall("read_file", { path: "src/delivery.cjs" }));
      }
      assert.match(JSON.stringify(messages), /estimatedSpend: 0.25/);
      return response(toolCall("edit_file", { path: "tests/delivery.test.cjs", oldText: "// IMPORTANT EXISTING TEST SETUP",
        newText: "test('delivery metadata',()=>{const event=delivery();assert.equal(event.engine,'local');assert.equal(event.estimatedSpend,0.25);});" }));
    });
  const result = await worker.run({ ...workerInput(root), writeScope: ["tests/delivery.test.cjs"],
    task: "Add a deterministic test for delivery metadata" });
  assert.equal(calls, 3);
  assert.deepEqual(result.changedPaths, ["tests/delivery.test.cjs"]);
  const verification = await verify(root, ["node --test tests/delivery.test.cjs", "node --check tests/delivery.test.cjs"], () => 5000);
  assert.equal(verification.status, "VERIFIED_SUCCESS");
  assert.match(await readFile(join(root, "tests/delivery.test.cjs"), "utf8"), /assert.equal\(event.engine,'local'\).*assert.equal\(event.estimatedSpend,0.25\)/);
});

test("two prose-only model turns stop without exhausting the coding budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-no-tool-progress-"));
  let calls = 0;
  const worker = new AgenticCodingWorker(new Budget(1, 30_000, 60_000), { log() {} } as any, async () => {
    calls++;
    return { model: "mock", usage: { prompt_tokens: 100, completion_tokens: 20 }, message: { content: "I will inspect and implement." } };
  });
  const result = await worker.run(workerInput(root));
  assert.equal(calls, 2);
  assert.equal(result.exitStatus, "failed");
  assert.equal(result.terminationReason, "agentic_no_tool_progress");
  assert.deepEqual(result.changedPaths, []);
});

test("known tool-incompatible endpoint is rejected without a provider dispatch or model-quality failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-tool-compatibility-"));
  let calls = 0;
  const worker = new AgenticCodingWorker(new Budget(1, 30_000, 60_000), { log() {} } as any, async () => { calls++; return response(); });
  const result = await worker.run({ ...workerInput(root), modelMetadata: {
    supportedParameters: ["tools", "tool_choice"], routableParameterSets: [["tools"], ["tool_choice"]],
  } });
  assert.equal(calls, 0, "parameters must be co-supported by the same routable endpoint");
  assert.equal(result.exitStatus, "infra_failure");
  assert.match(result.fatalError ?? "", /tools and tool_choice together/);
});

test("provider request timeout is bounded by remaining worker time", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-attempt-deadline-"));
  const worker = new AgenticCodingWorker(new Budget(1, 30_000, 60_000), { log() {} } as any, async (input) => {
    assert.ok(input.requestTimeoutMs <= 1000);
    throw Error("AbortError: request timed out");
  });
  const result = await worker.run({ ...workerInput(root), timeoutMs: 1000, requestTimeoutMs: 45000 });
  assert.equal(result.exitStatus, "infra_failure");
});

test("real worker HTTP protocol requires tools and returns a runnable deterministic test candidate", async () => {
  const { createServer } = await import("node:http");
  const { verify } = await import("../src/verifier/verifier.js");
  const root = await mkdtemp(join(tmpdir(), "koda-worker-http-"));
  await mkdir(join(root, "src"));
  await mkdir(join(root, "tests"));
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test tests/*.test.cjs" } }));
  await writeFile(join(root, "src/delivery.cjs"), "module.exports = () => ({engine: 'local', estimatedSpend: 0.25});\n");
  const testSource = "const {test}=require('node:test');const assert=require('node:assert/strict');const delivery=require('../src/delivery.cjs');test('delivery metadata',()=>{const event=delivery();assert.equal(event.engine,'local');assert.equal(event.estimatedSpend,0.25);});\n";
  const requests: any[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    requests.push(payload);
    const calls = requests.length === 1
      ? [toolCall("read_file", { path: "src/delivery.cjs" })]
      : [toolCall("write_file", { path: "tests/delivery.test.cjs", content: testSource })];
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "mock-completion", object: "chat.completion", created: 1, model: "mock",
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0 },
      choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: calls } }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "local-protocol-test-key";
  try {
    const address = server.address() as { port: number };
    const worker = new AgenticCodingWorker(new Budget(1, 30_000, 60_000), { log() {} } as any);
    const result = await worker.run({ ...workerInput(root), task: "Add a deterministic test for delivery metadata",
      baseUrl: `http://127.0.0.1:${address.port}/v1`, modelMetadata: { supportedParameters: ["tools", "tool_choice"] } });
    assert.equal(requests.length, 2);
    assert.ok(requests.every((request) => request.tool_choice === "required"));
    assert.equal(result.terminationReason, "candidate_ready_for_verification");
    assert.deepEqual(result.changedPaths, ["tests/delivery.test.cjs"]);
    assert.equal(await readFile(join(root, "tests/delivery.test.cjs"), "utf8"), testSource);
    const verification = await verify(root,
      ["node --test tests/delivery.test.cjs", "node --check tests/delivery.test.cjs"], () => 5000);
    assert.equal(verification.status, "VERIFIED_SUCCESS");
  } finally {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("localized output-limit continuation reads known contracts and mutates without rediscovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-localized-recovery-"));
  await writeFile(join(root, "value.ts"), "export const value = 1;\n");
  await writeFile(join(root, "setup.ts"), "export const setup = true;\n");
  await writeFile(join(root, "contract.ts"), "export const requiredValue = 3;\n");
  let calls = 0;
  const events: any[] = [];
  const worker = new AgenticCodingWorker(new Budget(1, 30_000, 60_000),
    { log(type: string, payload: any) { events.push({ type, ...payload }); } } as any,
    async (_input, messages, tools) => {
      calls++;
      const names = tools.map((tool) => "function" in tool ? tool.function.name : "");
      assert.ok(!names.includes("search_code"), "retained scope must not restart broad search");
      assert.ok(!names.includes("list_files"));
      const packet = JSON.stringify(messages);
      assert.match(packet, /contract\.ts/);
      assert.match(packet, /retained-symbol/);
      if (calls === 1) {
        assert.ok(names.includes("read_file"), "a real read still precedes implementation");
        assert.ok(!names.includes("edit_file"));
        return response(toolCall("read_file", { path: "value.ts", startLine: 1, endLine: 1 }));
      }
      if (calls === 2) return response(toolCall("read_file", { path: "setup.ts", startLine: 1, endLine: 1 }));
      if (calls === 3) {
        assert.ok(names.includes("read_file"), "necessary contract read remains available after two observations");
        return response(toolCall("read_file", { path: "contract.ts", startLine: 1, endLine: 1 }));
      }
      assert.equal(calls, 4);
      assert.match(packet, /requiredValue = 3/);
      assert.ok(!names.includes("read_file"), "bounded contract reads advance to mutation");
      return response(toolCall("edit_file", { path: "value.ts", oldText: "= 1", newText: "= 3" }));
    });
  const result = await worker.run({ ...workerInput(root), task: "Correct value and cover its test contract",
    writeScope: ["value.ts"], context: { implementationRecovery: { reason: "output_limit" },
      relevantFiles: ["value.ts", "setup.ts", "contract.ts"],
      sourceFiles: [{ path: "value.ts", snippet: "export const value = 1;" }],
      evidence: { symbols: ["retained-symbol"] } } });
  assert.equal(result.exitStatus, "completed");
  assert.deepEqual(result.changedPaths, ["value.ts"]);
  assert.equal(calls, 4);
  assert.equal(events.filter((event) => event.type === "agentic_discovery_call_deferred").length, 0);
  assert.ok(events.some((event) => event.type === "agentic_implementation_transition" &&
    event.useful_discovery_steps === 1), "retained localization needs one real read, not another discovery cycle");
});

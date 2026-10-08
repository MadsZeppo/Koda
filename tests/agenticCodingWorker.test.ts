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
  agenticPromptBytes,
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

test("localized multi-file work reads every existing target and returns after the complete mutation batch", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-agentic-multifile-"));
  await writeFile(join(root, "a.ts"), "export const a = 1;\n");
  await writeFile(join(root, "b.ts"), "export const b = 1;\n");
  let call = 0;
  const worker = new AgenticCodingWorker(new Budget(1, 20_000, 60_000),
    { events: [], log() {} } as any, async (_input, _messages, tools) => {
      call++;
      const names = tools.flatMap((tool) => "function" in tool ? [tool.function.name] : []);
      const invoke = (id: string, name: string, args: object) => ({ id, type: "function", function: {
        name, arguments: JSON.stringify(args),
      } });
      if (call === 1) {
        assert.equal(names.includes("edit_file"), false);
        return { model: "mock", usage: { prompt_tokens: 100, completion_tokens: 20 }, message: {
          tool_calls: [invoke("read-a", "read_file", { path: "a.ts" })],
        } } as AgenticCodingResponse;
      }
      if (call === 2) {
        assert.equal(names.includes("edit_file"), false, "one target read must not authorize guessing edits to another target");
        return { model: "mock", usage: { prompt_tokens: 100, completion_tokens: 20 }, message: {
          tool_calls: [invoke("read-b", "read_file", { path: "b.ts" })],
        } } as AgenticCodingResponse;
      }
      assert.ok(names.includes("apply_patch"));
      return { model: "mock", usage: { prompt_tokens: 120, completion_tokens: 40 }, message: {
        tool_calls: [invoke("mutate", "apply_patch", { edits: [
          { path: "a.ts", oldText: "a = 1", newText: "a = 2" },
          { path: "b.ts", oldText: "b = 1", newText: "b = 2" },
          { path: "new.ts", createContent: "export const ready = true;\n" },
        ] })],
      } } as AgenticCodingResponse;
    });
  const result = await worker.run({ repoPath: root, attemptId: "multi", task: "Update a and b and create new", model: "mock",
    budgetUsd: .1, maxTokens: 10_000, maxSteps: 8, timeoutMs: 30_000, requestTimeoutMs: 5_000,
    commandTimeoutMs: 5_000, maxOutputTokens: 1_000, baseUrl: "unused",
    writeScope: ["a.ts", "b.ts", "new.ts"], context: { implementationRecovery: { reason: "bounded multi-file packet" } } });
  assert.equal(result.exitStatus, "completed");
  assert.deepEqual(result.changedPaths.sort(), ["a.ts", "b.ts", "new.ts"]);
  assert.equal(call, 3, "the worker must not spend another model turn after the complete mutation batch");
});

test("large write scope starts a grounded edit without reading every authorized file", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-agentic-large-scope-"));
  for (let index = 0; index < 6; index++)
    await writeFile(join(root, `file-${index}.ts`), `export const value${index} = 1;\n`);
  const events: any[] = [];
  const logger = { events, log: (type: string, payload: any) => events.push({ type, ...payload }) } as any;
  const call = (id: string, name: string, args: object) => ({ id, type: "function", function: {
    name, arguments: JSON.stringify(args),
  } });
  let turns = 0;
  const worker = new AgenticCodingWorker(new Budget(1, 20_000, 60_000), logger,
    async (_input, _messages, tools) => {
      turns++;
      const names = tools.flatMap((tool) => "function" in tool ? [tool.function.name] : []);
      const usage = { prompt_tokens: 700, completion_tokens: 100, cost: 0.0001 };
      if (turns === 1) return { model: "mock", usage, message: { tool_calls: [
        call("read-0", "read_file", { path: "file-0.ts" }),
        call("read-1", "read_file", { path: "file-1.ts" }),
      ] } } as AgenticCodingResponse;
      if (turns === 2) {
        assert.deepEqual(names.sort(), ["apply_patch", "edit_file", "write_file"]);
        return { model: "mock", usage, message: { tool_calls: [
          call("edit-0", "edit_file", { path: "file-0.ts", oldText: "value0 = 1", newText: "value0 = 2" }),
          call("unread-2", "edit_file", { path: "file-2.ts", oldText: "value2 = 1", newText: "value2 = 2" }),
        ] } } as AgenticCodingResponse;
      }
      if (turns === 3) {
        assert.ok(names.includes("read_file"), "discovery reopens after a real mutation");
        assert.match(await readFile(join(root, "file-2.ts"), "utf8"), /value2 = 1/,
          "a file may not be edited before it is read");
        return { model: "mock", usage, message: { tool_calls: [
          call("read-2", "read_file", { path: "file-2.ts" }),
        ] } } as AgenticCodingResponse;
      }
      if (turns === 4) return { model: "mock", usage, message: { tool_calls: [
        call("edit-2", "edit_file", { path: "file-2.ts", oldText: "value2 = 1", newText: "value2 = 2" }),
      ] } } as AgenticCodingResponse;
      return { model: "mock", usage, message: { content: "done", tool_calls: [] } } as AgenticCodingResponse;
    });
  const result = await worker.run({ repoPath: root, attemptId: "large-scope", task: "Improve several components",
    model: "mock", budgetUsd: 0.1, maxTokens: 12_000, maxSteps: 6, timeoutMs: 30_000,
    requestTimeoutMs: 5_000, commandTimeoutMs: 5_000, maxOutputTokens: 1_000, baseUrl: "unused",
    writeScope: Array.from({ length: 6 }, (_, index) => `file-${index}.ts`),
    context: { implementationRecovery: { reason: "bounded coding packet" } } });
  assert.equal(result.exitStatus, "completed");
  assert.deepEqual(result.changedPaths.sort(), ["file-0.ts", "file-2.ts"]);
  assert.ok(events.some((event) => event.type === "agentic_implementation_transition"));
});

test("malformed tool arguments retry once with retained reads and a bounded edit", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-agentic-protocol-"));
  await writeFile(join(root, "page.tsx"), "export const title = 'old';\n");
  const events: any[] = [];
  const logger = { events, log: (type: string, payload: any) => events.push({ type, ...payload }) } as any;
  let turns = 0;
  const worker = new AgenticCodingWorker(new Budget(1, 20_000, 60_000), logger,
    async (_input, messages, tools) => {
      turns++;
      if (turns === 1) return { model: "mock", usage: { prompt_tokens: 100, completion_tokens: 20 }, message: {
        tool_calls: [{ id: "read", type: "function", function: { name: "read_file",
          arguments: JSON.stringify({ path: "page.tsx" }) } }],
      } } as AgenticCodingResponse;
      if (turns === 2) throw Error("502 OpenRouter returned a malformed response (invalid_tool_arguments)");
      assert.ok(messages.some((message) => message.role === "user" &&
        String(message.content).includes("invalid JSON")));
      assert.ok(tools.some((tool) => "function" in tool && tool.function.name === "edit_file"));
      return { model: "mock", usage: { prompt_tokens: 120, completion_tokens: 30 }, message: {
        tool_calls: [{ id: "edit", type: "function", function: { name: "edit_file",
          arguments: JSON.stringify({ path: "page.tsx", oldText: "title = 'old'", newText: "title = 'new'" }) } }],
      } } as AgenticCodingResponse;
    });
  const result = await worker.run({ repoPath: root, attemptId: "protocol-retry", task: "Change the title",
    model: "mock", budgetUsd: 0.1, maxTokens: 5_000, maxSteps: 4, timeoutMs: 30_000,
    requestTimeoutMs: 5_000, commandTimeoutMs: 5_000, maxOutputTokens: 1_000, baseUrl: "unused",
    writeScope: ["page.tsx"], returnOnMutation: true });
  assert.equal(result.exitStatus, "completed");
  assert.equal(turns, 3);
  assert.match(await readFile(join(root, "page.tsx"), "utf8"), /title = 'new'/);
  assert.equal(events.filter((event) => event.type === "agentic_tool_protocol_retry").length, 1);
});

test("a rejected tool envelope does not consume the only verification repair step", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-agentic-repair-protocol-"));
  await writeFile(join(root, "page.tsx"), "export const title = 'old';\n");
  const events: any[] = [];
  let requests = 0;
  const worker = new AgenticCodingWorker(new Budget(1, 20_000, 60_000), {
    events, log: (type: string, payload: any) => events.push({ type, ...payload }),
  } as any, async () => {
    requests++;
    if (requests === 1)
      throw Error("502 OpenRouter returned a malformed response (invalid_tool_arguments)");
    return { model: "mock", usage: { prompt_tokens: 120, completion_tokens: 30 }, message: {
      tool_calls: [{ id: "edit", type: "function", function: { name: "edit_file",
        arguments: JSON.stringify({ path: "page.tsx", oldText: "title = 'old'", newText: "title = 'new'" }) } }],
    } } as AgenticCodingResponse;
  });
  const result = await worker.run({ repoPath: root, attemptId: "one-step-repair",
    task: "Fix the candidate lint error", model: "mock", budgetUsd: 0.1,
    maxTokens: 5_000, maxSteps: 1, timeoutMs: 30_000, requestTimeoutMs: 5_000,
    commandTimeoutMs: 5_000, maxOutputTokens: 1_000, baseUrl: "unused",
    writeScope: ["page.tsx"], context: { completionRepair: {
      unresolvedRequirementIds: ["VERIFICATION_REGRESSION"], mutationRequiredBeforeDiscovery: true,
    } } });
  assert.equal(requests, 2);
  assert.equal(result.exitStatus, "completed");
  assert.deepEqual(result.changedPaths, ["page.tsx"]);
  assert.match(await readFile(join(root, "page.tsx"), "utf8"), /title = 'new'/);
  assert.equal(events.filter((event) => event.type === "agentic_tool_protocol_retry").length, 1);
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

test("unknown location follows imports, makes multiple mutations and completes with the complete long task", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-progressive-general-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/main.cjs"), "const {value}=require('./math.cjs');exports.assemble=()=>value;\n");
  await writeFile(join(root, "src/math.cjs"), "exports.value=1;\n");
  const task = ["Fix assemble behavior; preserve all existing exports.",
    ...Array.from({ length: 120 }, (_, i) => `Constraint ${i}: preserve compatibility for caller ${i}.`),
    "Finally create a focused regression test asserting assemble returns exactly 3."].join("\n");
  let turn = 0;
  const logger = { events: [] as any[], log(type: string, payload: any) { this.events.push({type, ...payload}); } } as any;
  const worker = new AgenticCodingWorker(new Budget(1, 80_000, 60_000), logger,
    async (_input, messages) => {
      turn++;
      assert.ok(messages.some((message) => typeof message.content === "string" && message.content.includes(task)),
        "Every provider request must preserve requirements at both ends of the task");
      if (turn === 4) assert.ok(messages.some((message) => message.role === "tool" && String(message.content).includes("exports.value=1")),
        "The imported implementation must actually be read before editing");
      const calls = [
        ["search_code", { query: "assemble" }],
        ["read_file", { path: "src/main.cjs" }],
        ["read_file", { path: "src/math.cjs" }],
        ["edit_file", { path: "src/math.cjs", oldText: "value=1", newText: "value=3" }],
        ["file_outline", { path: "src/main.cjs" }],
        ["write_file", { path: "tests/assemble.test.cjs", content: "const {test}=require('node:test');const a=require('node:assert/strict');test('assemble',()=>a.equal(require('../src/main.cjs').assemble(),3));\n" }],
      ] as const;
      const next = calls[turn - 1];
      return { model: "mock", usage: { prompt_tokens: 100, completion_tokens: 20 }, message: next
        ? { tool_calls: [{ id: `turn-${turn}`, type: "function", function: { name: next[0], arguments: JSON.stringify(next[1]) } }] }
        : { content: "Completed implementation and regression test" } } as AgenticCodingResponse;
    });
  const result = await worker.run({ repoPath: root, attemptId: "progressive", task, model: "mock",
    budgetUsd: .5, maxTokens: 40_000, maxSteps: 8, timeoutMs: 30_000, requestTimeoutMs: 5_000,
    commandTimeoutMs: 5_000, maxOutputTokens: 1_000, baseUrl: "unused", writeScope: ["."] });
  assert.equal(result.exitStatus, "completed");
  assert.equal(turn, 7);
  assert.deepEqual(result.changedPaths.sort(), ["src/math.cjs", "tests/assemble.test.cjs"]);
  const { execa } = await import("execa");
  await execa(process.execPath, ["--test", "tests/assemble.test.cjs"], { cwd: root });
  await execa(process.execPath, ["--check", "src/math.cjs"], { cwd: root });
});

test("agentic creates multiple concrete files in an empty repository before completing", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-empty-multi-"));
  let turn = 0;
  const worker = new AgenticCodingWorker(new Budget(1, 30_000, 60_000), { log() {}, events: [] } as any,
    async (_input, _messages, tools) => {
      turn++;
      assert.ok(tools.some((tool) => tool.type === "function" && tool.function.name === "write_file"), "Missing localized targets must remain creatable");
      return { model: "mock", usage: { prompt_tokens: 100, completion_tokens: 20 }, message: turn <= 2
        ? { tool_calls: [{ id: `new-${turn}`, type: "function", function: { name: "write_file", arguments: JSON.stringify({
          path: turn === 1 ? "src/answer.cjs" : "tests/answer.test.cjs",
          content: turn === 1 ? "exports.answer=42;\n" : "const {test}=require('node:test');const a=require('node:assert/strict');test('answer',()=>a.equal(require('../src/answer.cjs').answer,42));\n",
        }) } }] } : { content: "done" } } as AgenticCodingResponse;
    });
  const result = await worker.run({ repoPath: root, attemptId: "empty-multi", task: "Create src/answer.cjs exporting answer=42 and tests/answer.test.cjs verifying it.",
    model: "mock", budgetUsd: .5, maxTokens: 20_000, maxSteps: 4, timeoutMs: 30_000, requestTimeoutMs: 5_000,
    commandTimeoutMs: 5_000, maxOutputTokens: 1_000, baseUrl: "unused", writeScope: ["src/answer.cjs", "tests/answer.test.cjs"],
    context: { implementationRecovery: { reason: "complete_packet_preflight" }, relevantFiles: ["src/answer.cjs", "tests/answer.test.cjs"] } });
  assert.equal(result.exitStatus, "completed", JSON.stringify(result));
  assert.equal(turn, 2, "complete bounded scope returns immediately after its final mutation");
  assert.equal(result.changedPaths.length, 2);
  const { execa } = await import("execa");
  await execa(process.execPath, ["--test", "tests/answer.test.cjs"], { cwd: root });
});

test('partial multifile mutation compacts history and finishes remaining edits within the same attempt',async()=>{
 const root=await mkdtemp(join(tmpdir(),'koda-mutation-compact-'));
 await writeFile(join(root,'first.ts'),'export const first = 1;');
 await writeFile(join(root,'second.ts'),'export const second = 1;');
 let calls=0;
 const events:string[]=[];
 const worker=new AgenticCodingWorker(new Budget(1,20000,60000),{log(type:string){events.push(type);}} as any,async (_input,messages)=>{
  calls++;
  if(calls===1)return response(toolCall('read_file',{path:'first.ts'}),toolCall('read_file',{path:'second.ts'}));
  if(calls===2)return {...response(toolCall('edit_file',{path:'first.ts',oldText:'= 1',newText:'= 2'})),message:{content:'old verbose reasoning '.repeat(3000),tool_calls:[toolCall('edit_file',{path:'first.ts',oldText:'= 1',newText:'= 2'})]}};
  assert.ok(!JSON.stringify(messages).includes('old verbose reasoning'));
  assert.match(JSON.stringify(messages),/CURRENT FILE first.ts/);
  assert.match(JSON.stringify(messages),/first = 2/);
  assert.match(JSON.stringify(messages),/Preserve this exact requirement/);
  return response(toolCall('edit_file',{path:'second.ts',oldText:'= 1',newText:'= 2'}));
 });
 const r=await worker.run({...workerInput(root),task:'Update both values. Preserve this exact requirement.',writeScope:['first.ts','second.ts'],returnOnMutation:false,maxTokens:9000});
 assert.equal(calls,3);
 assert.ok(events.includes('agentic_mutation_history_compact_retry'));
 assert.deepEqual(r.changedPaths.sort(),['first.ts','second.ts']);
 assert.match(await readFile(join(root,'second.ts'),'utf8'),/second = 2/);
});

test('explicit affordable provider output limit retries the same request once without rediscovery',async()=>{
 const root=await mkdtemp(join(tmpdir(),'koda-credit-retry-'));
 let calls=0;
 let rejectedMessages='';
 const worker=new AgenticCodingWorker(new Budget(1,20000,60000),{log(){}} as any,async(input,messages,_tools,output)=>{
  calls++;
  assert.equal(input.model,'mock');
  if(calls===1){assert.equal(output,1000);rejectedMessages=JSON.stringify(messages);throw Error('402 This request requires more credits. You requested up to 1000 tokens, but can only afford 500.');}
  assert.equal(output,500);
  assert.equal(JSON.stringify(messages),rejectedMessages);
  return response(toolCall('write_file',{path:'value.ts',content:'export const value=1;'}));
 });
 const r=await worker.run({...workerInput(root),maxSteps:1});
 assert.equal(calls,2);assert.equal(r.exitStatus,'completed');assert.deepEqual(r.changedPaths,['value.ts']);
});

test('exhausted credits without an affordable output bound stop without repeated dispatch',async()=>{
 const root=await mkdtemp(join(tmpdir(),'koda-credit-empty-'));
 let calls=0;
 const worker=new AgenticCodingWorker(new Budget(1,20000,60000),{log(){}} as any,async()=>{calls++;throw Error('402 available credits exceeded by in-flight requests');});
 const r=await worker.run(workerInput(root));
 assert.equal(calls,1);assert.equal(r.exitStatus,'infra_failure');assert.equal(r.costUsd,undefined);
 assert.equal(r.inputTokens,undefined);assert.equal(r.outputTokens,undefined);
});

test('provider failure preserves known usage and candidate for recovery without fabricated total cost',async()=>{
 const root=await mkdtemp(join(tmpdir(),'koda-known-receipts-'));
 let calls=0;
 const worker=new AgenticCodingWorker(new Budget(1,20000,60000),{log(){}} as any,async()=>{
  if(++calls===1)return response(toolCall('write_file',{path:'first.ts',content:'export const first=1;'}));
  throw Error('Request was aborted.');
 });
 const r=await worker.run({...workerInput(root),returnOnMutation:false,writeScope:['first.ts','second.ts']});
 assert.equal(r.exitStatus,'infra_failure');assert.deepEqual(r.changedPaths,['first.ts']);
 assert.equal(r.inputTokens,100);assert.equal(r.outputTokens,20);assert.equal(r.consumedTokens,120);assert.equal(r.costUsd,undefined);
});

test('native forecast uses bounded repair evidence independently of raw verifier output size',()=>{
 const task='Preserve the complete task literal EXACT_REQUIRED_VALUE';
 const context={implementationRecovery:{reason:'bounded_coding_packet'},diagnostics:'FAIL exact assertion\n'+'trace '.repeat(100000),previousFailedDiff:'diff '.repeat(100000),relevantFiles:['src/value.ts'],sourceFiles:[{path:'src/value.ts',snippet:'source '.repeat(100000)}]};
 const a=agenticPromptBytes({task,writeScope:['src/value.ts'],context});
 const b=agenticPromptBytes({task,writeScope:['src/value.ts'],context:{...context,diagnostics:context.diagnostics.slice(0,3000),previousFailedDiff:context.previousFailedDiff.slice(0,3000),sourceFiles:[]}});
 assert.equal(a,b);assert.ok(a<32000);assert.ok(agenticPromptBytes({task:task.repeat(2),writeScope:['src/value.ts'],context})>a,'task is preserved rather than silently truncated');
});

test('requested tests continue in the same worker session after premature completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'koda-test-continuation-'));
  await mkdir(join(root, 'tests'));
  await writeFile(join(root, 'value.ts'), 'export const value = 1;\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({scripts:{test:'tsx --test tests/*.test.ts'}}));
  let calls=0;
  const events:any[]=[];
  const worker = new AgenticCodingWorker(new Budget(1, 30_000, 60_000), {log(type:string,data:any){events.push({type,...data});}} as any,
    async (_input,messages)=>{
      calls++;
      if(calls===1)return response(toolCall('read_file',{path:'value.ts'}));
      if(calls===2)return response(toolCall('edit_file',{path:'value.ts',oldText:'= 1',newText:'= 2'}));
      if(calls===3)return {...response(),message:{content:'Done'}};
      if(calls===4){assert.match(JSON.stringify(messages),/requested test mutation is missing/);return response(toolCall('write_file',{path:'tests/value.test.ts',content:'import {value} from "../value.js";\n'}));}
      return {...response(),message:{content:'Done'}};
    });
  const result=await worker.run({...workerInput(root),task:'Change value to 2 and add regression tests',returnOnMutation:false});
  assert.equal(result.exitStatus,'completed');
  assert.deepEqual(result.changedPaths.sort(),['tests/value.test.ts','value.ts']);
  assert.equal(calls,5);
  assert.equal(events.filter(e=>e.type==='agentic_missing_tests_continuation').length,1);
});

test('aborted dispatched Agentic turn remains an unknown-cost receipt', async () => {
 const root=await mkdtemp(join(tmpdir(),'koda-aborted-receipt-'));
 const events:any[]=[];
 const worker=new AgenticCodingWorker(new Budget(1,20000,60000),{events,log(type:string,payload:any){events.push({type,...payload});}} as any,async()=>{throw Error('Request was aborted.');});
 const result=await worker.run({...workerInput(root)});
 assert.equal(result.exitStatus,'infra_failure');
 const calls=events.filter(e=>e.type==='model_call');
 assert.equal(calls.length,1);
 assert.equal(calls[0].costUsd,null);
 assert.equal(calls[0].costSource,'missing');
 assert.equal(calls[0].outcome,'OPERATIONAL_FAILURE');
});

test('tiny worker compacts directly after its first relevant read',async()=>{
 const root=await mkdtemp(join(tmpdir(),'koda-first-read-'));
 await writeFile(join(root,'value.ts'),'export const value = 1;\n');
 const events:any[]=[];let turn=0;
 const worker=new AgenticCodingWorker(new Budget(1,20000,60000),{events,log(type:string,payload:any){events.push({type,...payload});}} as any,async()=>{
  if(++turn===1)return response(toolCall('read_file',{path:'value.ts'}));
  assert.equal(events.filter(e=>e.type==='agentic_implementation_transition').length,1);
  return response(toolCall('edit_file',{path:'value.ts',oldText:'value = 1',newText:'value = 2'}));
 });
 const result=await worker.run({...workerInput(root),writeScope:['value.ts']});
 assert.deepEqual(result.changedPaths,['value.ts']);assert.equal(turn,2);
});

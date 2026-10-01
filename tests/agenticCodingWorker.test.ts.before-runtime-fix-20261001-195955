import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
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
      assert.ok(messages.some((message: any) => String(message.content).includes("enough distinct repository evidence")));
      assert.equal(
        messages.filter((message: any) => String(message.content).includes("Discovery phase complete")).length,
        4,
      );
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
                      path: `context-${index}.ts`,
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

          sawBoundedHistory =
            toolContents.filter((content) =>
              content.includes(
                "Discovery phase complete",
              ),
            ).length === 6;

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
      "discovery calls beyond the useful-evidence bound should be deferred before the next provider call",
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

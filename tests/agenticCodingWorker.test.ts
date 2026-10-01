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

test(
  "agentic worker compacts discovery history instead of token-preflighting before mutation",
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
    let sawCompactedHistory = false;

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

          sawCompactedHistory =
            toolContents.some((content) =>
              content.includes(
                "Koda compacted older tool output",
              ),
            );

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
      sawCompactedHistory,
      true,
      "older discovery output should be compacted before the next provider call",
    );
    assert.equal(
      await readFile(
        join(root, "target.ts"),
        "utf8",
      ),
      "export const value = 2;\n",
    );
    assert.ok(
      logger.events.some(
        (event: any) =>
          event.type ===
          "agentic_history_compaction",
      ),
    );
  },
);

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
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

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { config } from "../src/config.js";
import { calibrateModels } from "../src/calibration.js";
import { codingWorkerFactory } from "./helpers/run.js";

test("strict calibration compares two models on one frozen baseline without changing the original", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-calibration-test-"));
  const repo = join(root, "repo");
  const output = join(root, "results");
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "tests"));
  await writeFile(
    join(repo, "package.json"),
    JSON.stringify({
      scripts: { test: "node --test tests/*.test.cjs" },
    }),
  );
  await writeFile(join(repo, "src/add.cjs"), "module.exports=(a,b)=>a-b;\n");
  await writeFile(
    join(repo, "tests/add.test.cjs"),
    "const {test}=require('node:test');const assert=require('node:assert/strict');const add=require('../src/add.cjs');test('sum',()=>assert.equal(add(2,3),5));\n",
  );
  const requests: any[] = [];
  let substituteModel = false;
  let modelACalls = 0;
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith("/models")) {
      res.end(
        JSON.stringify({
          data: ["model-a", "model-b"].map((id) => ({
            id,
            context_length: 100000,
            pricing: { prompt: "0.000001", completion: "0.000002" },
            supported_parameters: ["tools"],
          })),
        }),
      );
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    if (body.model === "model-a") modelACalls++;
    const inspect = body.model === "model-a" && modelACalls < 3;
    const message = inspect
      ? {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: `inspect-${modelACalls}`,
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: "src/add.cjs" }),
            },
          }],
        }
      : body.model === "model-a" || substituteModel
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "fix",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({
                    path: "src/add.cjs",
                    content: "module.exports=(a,b)=>a+b;\n",
                  }),
                },
              },
            ],
          }
        : { role: "assistant", content: "done" };
    res.end(
      JSON.stringify({
        id: "mock",
        model: substituteModel ? "model-a" : body.model,
        choices: [{ index: 0, message }],
        usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0001 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const c = await config(undefined, {
      modelPool: {
        provider: "openrouter",
        models: ["model-a", "model-b"].map((id) => ({
          id,
          tier: "fast",
          qualityPrior: 0.95,
          latencyPriorMs: 100,
          strengths: ["coding", "tool_use"],
        })),
      },
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      routing: { stateDirectory: join(root, "routing") },
      budgetUsd: 0.1,
      maxIterations: 3,
      stageMaxTokens: 30000,
    });
    const result = await calibrateModels({
      repo,
      task: "Fix src/add.cjs so addition returns the sum.",
      taskId: "same-task",
      models: ["model-a", "model-b"],
      config: c,
      output,
      codingWorkerFactory,
    });
    const rows = result.results as any[];
    assert.deepEqual(
      rows.map((row) => row.forcedModel),
      ["model-a", "model-b"],
    );
    assert.deepEqual(
      rows.map((row) => row.status),
      ["VERIFIED_SUCCESS", "NOT_FULLY_VERIFIED"],
    );
    assert.deepEqual(
      rows.map((row) => row.verified),
      [true, false],
    );
    assert.equal(rows[0].baselineHash, rows[1].baselineHash);
    assert.equal(rows[0].taskId, "same-task");
    assert.equal(rows[0].taskFeatureBucket, "localized_bugfix");
    assert.equal(rows[0].executionStrategy, "direct");
    assert.equal(rows[0].finalVerificationStatus, "VERIFIED_SUCCESS");
    assert.equal(rows[0].inputTokens, rows[0].modelCalls * 100);
    assert.equal(rows[0].outputTokens, rows[0].modelCalls * 20);
    assert.equal(
      rows[0].totalTokens,
      rows[0].inputTokens + rows[0].outputTokens,
    );
    assert.equal(rows[0].costUsd, rows[0].modelCalls * 0.0001);
    assert.ok(rows[0].wallClockMs > 0);
    assert.ok(rows[0].verificationCalls > 0);
    assert.equal(rows[0].fallbacks, 0);
    assert.equal(rows[0].modelCalls, 3);
    assert.deepEqual(rows[0].servedModels, ["model-a", "model-a", "model-a"]);
    assert.doesNotMatch(rows[0].failureReason ?? "", /Forced model unavailable/);
    assert.equal(rows[1].fallbacks, 0);
    assert.equal(rows[1].failureClass, "RUN_ERROR");
    assert.ok(rows[1].servedModels.every((model: string) => model === "model-b"));
    assert.ok(
      requests.every((request) => request.provider.allow_fallbacks === false),
    );
    assert.ok(
      requests.filter((request) => request.model === "model-a").length >= 1,
    );
    assert.ok(
      requests.filter((request) => request.model === "model-b").length >= 1,
    );
    assert.ok(
      requests
        .find((request) => request.model === "model-a")
        .messages[1].content.includes("a-b"),
    );
    assert.ok(
      requests
        .find((request) => request.model === "model-b")
        .messages[1].content.includes("a-b"),
    );
    assert.notEqual(rows[0].report, rows[1].report);
    assert.equal(
      await readFile(join(repo, "src/add.cjs"), "utf8"),
      "module.exports=(a,b)=>a-b;\n",
    );
    const saved = JSON.parse(
      await readFile(join(output, "comparison.json"), "utf8"),
    );
    assert.equal(saved.mode, "strict");
    assert.deepEqual(
      saved.results.map((row: any) => row.forcedModel),
      ["model-a", "model-b"],
    );
    assert.match(
      await readFile(join(output, "comparison.md"), "utf8"),
      /model-a \| true/,
    );
    substituteModel = true;
    const mismatch = await calibrateModels({
      repo,
      task: "Fix src/add.cjs so addition returns the sum.",
      models: ["model-b"],
      config: c,
      output: join(root, "substitution"),
      codingWorkerFactory,
    });
    assert.equal(mismatch.results[0]!.status, "FAILED");
    assert.equal(mismatch.results[0]!.failureClass, "MODEL_MISMATCH");
    assert.equal(
      mismatch.results[0]!.finalVerificationStatus,
      "VERIFIED_SUCCESS",
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

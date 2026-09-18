import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { execa } from "execa";
import { config } from "../src/config.js";
import { run } from "../src/run.js";
import { Gateway } from "../src/openrouter/client.js";
import { Budget } from "../src/openrouter/usage.js";
import { Logger } from "../src/telemetry/logger.js";
import { extractFeatures } from "../src/router/features.js";
import {
  codingDemand,
  codingScore,
  nextCodingTier,
  qualityFailure,
} from "../src/router/codingDemand.js";
import type { Subtask } from "../src/planner/schemas.js";
import type { RepoProfile } from "../src/types.js";

const profile = {
  files: ["src/a.ts"],
  root: ".",
  commit: "",
  status: "",
  diff: "",
  topLevel: [],
  extensions: {},
  symbols: [],
  packageManager: "",
  scripts: {},
  configs: {},
  verificationCommands: [],
} satisfies RepoProfile;
const subtask = (
  paths: string[],
  difficulty: Subtask["estimatedDifficulty"] = "normal",
  dependsOn: string[] = [],
): Subtask => ({
  id: "work",
  title: "Fix code",
  objective: "Fix code",
  dependsOn,
  likelyReadPaths: paths,
  likelyWritePaths: paths,
  integrationContract: "Preserve behavior",
  verificationCommands: [],
  estimatedDifficulty: difficulty,
  parallelSafe: true,
});

test("adaptive coding demand is deterministic per coding subtask, without history or API calls", () => {
  const direct = subtask(["src/a.ts"]);
  const stable = subtask(["src/a.ts", "tests/a.test.ts"]);
  const independent = subtask(["src/b.ts"], "low");
  const coupled = subtask(["src/a.ts", "other/b.ts"], "high");
  assert.equal(
    codingDemand(
      extractFeatures(direct, profile, 100, undefined, "direct"),
      direct,
      "tiny",
    )?.tier,
    "low",
  );
  assert.equal(
    codingDemand(
      extractFeatures(direct, profile, 100, undefined, "direct"),
      direct,
      "normal",
    )?.tier,
    "low",
  );
  assert.equal(
    codingDemand(
      extractFeatures(stable, profile, 100, undefined, "stable"),
      stable,
    )?.tier,
    "medium",
  );
  assert.equal(
    codingDemand(
      extractFeatures(independent, profile, 100, undefined, "planned"),
      independent,
    )?.tier,
    "medium",
  );
  assert.equal(
    codingDemand(
      extractFeatures(coupled, profile, 100, undefined, "planned"),
      coupled,
    )?.tier,
    "high",
  );
  assert.equal(
    codingDemand(
      {
        ...extractFeatures(direct, profile, 100, undefined, "planned"),
        taskKind: "planning",
      },
      direct,
    ),
    undefined,
  );
  assert.equal(
    codingDemand(
      extractFeatures(
        { ...direct, readOnly: true, likelyWritePaths: [] },
        profile,
        100,
        undefined,
        "planned",
      ),
      { ...direct, readOnly: true, likelyWritePaths: [] },
    ),
    undefined,
  );
  assert.equal(codingScore("low"), 0);
  assert.equal(codingScore("medium"), 0.33);
  assert.equal(codingScore("high"), 0.66);
});

test("quality escalation is bounded and ignores infrastructure checks", () => {
  assert.equal(nextCodingTier("low"), "medium");
  assert.equal(nextCodingTier("medium"), "high");
  assert.equal(nextCodingTier("high"), "frontier");
  assert.equal(nextCodingTier("frontier"), undefined);
  assert.equal(qualityFailure([{ outcome: "CHECK_FAIL" }], false), true);
  assert.equal(qualityFailure([{ outcome: "INFRA_FAILURE" }], false), false);
  assert.equal(qualityFailure([{ outcome: "CHECK_PASS" }], false), false);
});

test("Pareto requests use tier plugin and stable worker session; telemetry records served model and charged cost", async () => {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    requests.push(JSON.parse(body));
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id: "mock",
        object: "chat.completion",
        model: "served-cheap-model",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "done" },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.002 },
      }),
    );
  });
  const directory = await mkdtemp(join(tmpdir(), "koda-adaptive-test-"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw Error("missing server address");
    const settings = await config(undefined, {
      adaptiveCoding: true,
      baseUrl: `http://127.0.0.1:${address.port}`,
      maxOutputTokens: 100,
    });
    const logger = new Logger(directory, "run-adaptive", true);
    const budget = new Budget(5, 100000, 30000);
    const gateway = new Gateway(settings, logger, budget);
    const messages = [{ role: "user" as const, content: "edit" }];
    const route = { tier: "low" as const, reason: "tiny", attempt: 0 };
    await gateway.call(
      "openrouter/pareto-code",
      messages,
      "a",
      "implement",
      0,
      undefined,
      { codingRoute: route },
    );
    await gateway.call(
      "openrouter/pareto-code",
      messages,
      "a",
      "implement",
      1,
      undefined,
      { codingRoute: route },
    );
    await gateway.call(
      "openrouter/pareto-code",
      messages,
      "b",
      "implement",
      0,
      undefined,
      { codingRoute: route },
    );
    assert.deepEqual(
      requests.map((r) => r.model),
      Array(3).fill("openrouter/pareto-code"),
    );
    assert.deepEqual(
      requests.map((r) => r.plugins[0]),
      Array(3).fill({ id: "pareto-router", min_coding_score: 0 }),
    );
    assert.equal(requests[0].provider.require_parameters, true);
    assert.equal(requests[0].session_id, requests[1].session_id);
    assert.notEqual(requests[0].session_id, requests[2].session_id);
    assert.deepEqual(requests[0].provider.sort, { by: "price", partition: "none" });
    assert.deepEqual(requests[0].provider.preferred_max_latency, { p90: 3 });
    assert.equal(
      logger.events.find((e) => e.type === "model_call")?.modelReturned,
      "served-cheap-model",
    );
    assert.equal(budget.spent, 0.006);
    const pinned = await config(undefined, {
      modelPool: {
        provider: "openrouter",
        models: [
          {
            id: "pinned",
            tier: "frontier",
            qualityPrior: 0.99,
            latencyPriorMs: 1000,
            strengths: ["coding", "tool_use", "structured_output"],
          },
        ],
      },
      adaptiveCoding: true,
      forceModel: "pinned",
      baseUrl: `http://127.0.0.1:${address.port}`,
    });
    const pinnedGateway = new Gateway(pinned, logger, budget);
    await assert.rejects(
      () =>
        pinnedGateway.call(
          "openrouter/pareto-code",
          messages,
          "forced",
          "implement",
          0,
          undefined,
          { codingRoute: route },
        ),
      /unforced adaptive coding demand/,
    );
    assert.equal(requests.length, 3);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

for (const rescueToFrontier of [false, true])
  test(
    rescueToFrontier
      ? "verified low, medium and high failures reach explicit frontier rescue"
      : "verified low-tier coding failure escalates to medium and stops after success",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "koda-adaptive-run-"));
      const requests: any[] = [];
      const server = createServer(async (req, res) => {
        res.setHeader("content-type", "application/json");
        if (req.url?.endsWith("/models")) {
          res.end(
            JSON.stringify({
              data: [
                {
                  id: "frontier",
                  context_length: 100000,
                  pricing: { prompt: "0.000001", completion: "0.000002" },
                  supported_parameters: ["tools", "structured_outputs"],
                },
              ],
            }),
          );
          return;
        }
        let raw = "";
        for await (const part of req) raw += part;
        const body = JSON.parse(raw);
        requests.push(body);
        const score = body.plugins?.[0]?.min_coding_score;
        const content =
          score === 0
            ? "export function add(a,b){return a-b}"
            : rescueToFrontier && score === 0.33
              ? "export function add(a,b){return a*b}"
              : rescueToFrontier && score === 0.66
                ? "export function add(a,b){return a/b}"
                : "export function add(a,b){return a+b}";
        res.end(
          JSON.stringify({
            id: `mock-${requests.length}`,
            model:
              score === 0
                ? "served-low"
                : score === 0.33
                  ? "served-medium"
                  : score === 0.66
                    ? "served-high"
                    : "frontier",
            choices: [
              {
                index: 0,
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: `edit-${requests.length}`,
                      type: "function",
                      function: {
                        name: "write_file",
                        arguments: JSON.stringify({
                          path: "src/calculator.js",
                          content,
                        }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 10, cost: 0.0001 },
          }),
        );
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      try {
        await execa(process.execPath, [
          resolve("scripts/create-routing-fixtures.mjs"),
          root,
        ]);
        const settings = await config(undefined, {
          modelPool: {
            provider: "openrouter",
            models: [
              {
                id: "frontier",
                tier: "frontier",
                qualityPrior: 0.99,
                latencyPriorMs: 1000,
                strengths: [
                  "coding",
                  "tool_use",
                  "reasoning",
                  "repo_scale",
                  "structured_output",
                ],
              },
            ],
          },
          adaptiveCoding: true,
          specialistRouting: false,
          baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
          routing: { stateDirectory: join(root, "state") },
        });
        const result = await run({
          repo: join(root, "direct"),
          task: "In src/calculator.js, fix the add function so all tests pass.",
          config: settings,
          quiet: true,
          output: join(root, "report"),
        });
        assert.equal(result.status, "VERIFIED_SUCCESS", result.error);
        assert.deepEqual(
          requests.map((r) => r.plugins?.[0]?.min_coding_score),
          rescueToFrontier ? [0, 0.33, 0.66, undefined] : [0, 0.33],
          JSON.stringify({
            strategy: result.execution_strategy,
            effort: result.execution_effort,
            reason: result.strategy_reason,
          }),
        );
        assert.equal(result.escalations, rescueToFrontier ? 3 : 1);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    },
  );

for (const cheapFails of [false, true])
  test(cheapFails
    ? "specialist DIRECT routes cheap failed verification to stronger candidate"
    : "specialist DIRECT completes focused fix cheaply with one terminal success", async () => {
    const root = await mkdtemp(join(tmpdir(), "koda-specialist-direct-"));
    const requests: any[] = [];
    const server = createServer(async (req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/models")) {
        res.end(JSON.stringify({ data: ["cheap", "strong"].map((id) => ({
          id, context_length: 100000, supported_parameters: ["tools"],
          pricing: { prompt: id === "cheap" ? "0.0000001" : "0.00001",
            completion: id === "cheap" ? "0.0000002" : "0.00002" },
        })) }));
        return;
      }
      if (!req.url?.includes("chat/completions")) {
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      let raw = "";
      for await (const part of req) raw += part;
      const body = JSON.parse(raw);
      requests.push(body);
      const bad = cheapFails && body.model === "cheap";
      res.end(JSON.stringify({ id: `mock-${requests.length}`, model: body.model,
        choices: [{ index: 0, finish_reason: "tool_calls", message: {
          role: "assistant", content: null, tool_calls: [{ id: `write-${requests.length}`,
            type: "function", function: { name: "write_file", arguments: JSON.stringify({
              path: "src/calculator.js",
              content: bad ? "export function add(a,b){return a-b}" : "export function add(a,b){return a+b}",
            }) } }],
        } }], usage: { prompt_tokens: 20, completion_tokens: 10, cost: 0.0001 } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      await execa(process.execPath, [resolve("scripts/create-routing-fixtures.mjs"), root]);
      const settings = await config(undefined, {
        modelPool: { provider: "openrouter", models: [
          { id: "cheap", tier: "cheap", qualityPrior: 0.94, latencyPriorMs: 500,
            strengths: ["coding", "tool_use"] },
          { id: "strong", tier: "strong", qualityPrior: 0.99, latencyPriorMs: 3000,
            strengths: ["coding", "tool_use", "reasoning"] },
        ] }, adaptiveCoding: false, specialistRouting: true,
        baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
        routing: { stateDirectory: join(root, "state") },
      });
      // Metadata is refreshed before execution; worker selection only reads the snapshot.
      await new Gateway(settings, new Logger(join(root, "refresh-log"), "refresh", true),
        new Budget(1, 10000, 30000)).modelRouter!.capabilities.refresh();
      const result = await run({ repo: join(root, "direct"),
        task: "Find why the test is failing, fix the implementation, and verify that all tests pass.",
        config: settings, quiet: true, output: join(root, "report") });
      assert.equal(result.status, "VERIFIED_SUCCESS", result.error);
      assert.equal(result.frontierCalls, 0);
      assert.deepEqual(requests.map((request) => request.model),
        cheapFails ? ["cheap", "strong"] : ["cheap"]);
      const events = (await readFile(join(root, "report", "events.jsonl"), "utf8"))
        .trim().split("\n").map((line) => JSON.parse(line));
      assert.deepEqual(events.find((event) => event.type === "worker_scope")?.allowed_write_paths,
        ["src/calculator.js"]);
      assert.equal(events.find((event) => event.type === "coding_route_decision")?.task_bucket,
        "localized_bugfix");
      assert.equal(events.find((event) => event.type === "coding_route_decision")?.verification_strength,
        "strong");
      const attempts = events.filter((event) => event.type === "model_attempt");
      assert.deepEqual(attempts.map((event) => event.verification),
        cheapFails ? ["FAILED", "VERIFIED_SUCCESS"] : ["VERIFIED_SUCCESS"]);
      assert.equal(attempts.some((event) => event.reason === "worker ended"), false);
      assert.equal(events.find((event) => event.type === "coding_route_decision")?.candidate, "cheap");
      if (cheapFails) assert.equal(events.find((event) =>
        event.type === "coding_route_escalation")?.to, "strong");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });

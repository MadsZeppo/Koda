import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { modelSchema, routingSchema } from "../src/router/pool.js";
import { extractFeatures, taskBucket } from "../src/router/features.js";
import { rankCandidates } from "../src/router/modelRouter.js";
import { History } from "../src/router/history.js";
import { Catalog } from "../src/openrouter/catalog.js";
import { Logger } from "../src/telemetry/logger.js";
import { summarize } from "../src/telemetry/summary.js";
const features = extractFeatures(
  {
    id: "fix",
    title: "Fix add",
    objective: "Fix add",
    likelyWritePaths: ["add.ts"],
    likelyReadPaths: [],
    dependsOn: [],
    integrationContract: "",
    verificationCommands: ["node --test"],
    estimatedDifficulty: "normal",
    parallelSafe: true,
  },
  { files: ["add.ts"] } as any,
  1000,
);
const cheap = modelSchema.parse({
  id: "cheap",
  tier: "cheap",
  qualityPrior: 0.94,
  latencyPriorMs: 4000,
});
const frontier = modelSchema.parse({
  id: "frontier",
  tier: "frontier",
  qualityPrior: 0.99,
  latencyPriorMs: 10000,
  strengths: ["coding", "tool_use", "reasoning", "repo_scale"],
});
const metadata = new Map<string, import("../src/router/pool.js").Metadata>([
  ["cheap", { available: true, inputPrice: 0.1, outputPrice: 0.2 }],
  ["frontier", { available: true, inputPrice: 10, outputPrice: 20 }],
]);
const rank = (
  models = [cheap, frontier],
  history: any[] = [],
  md = metadata,
  settings = {},
) =>
  rankCandidates(
    models,
    md,
    history,
    features,
    routingSchema.parse(settings),
    1000,
    100,
  ).filter((c) => !c.rejected)[0];
test("quality gate precedes cost; latency breaks similar-cost ties", () => {
  assert.equal(rank()?.model.id, "cheap");
  assert.equal(
    rank([{ ...cheap, qualityPrior: 0.7 }, frontier])?.model.id,
    "frontier",
  );
  assert.equal(
    rank(
      [
        { ...cheap, latencyPriorMs: 10000 },
        { ...frontier, latencyPriorMs: 1000 },
      ],
      [],
      new Map([
        ["cheap", { inputPrice: 1, outputPrice: 1 }],
        ["frontier", { inputPrice: 1.01, outputPrice: 1.01 }],
      ]),
    )?.model.id,
    "frontier",
  );
  assert.equal(rank([cheap], [], new Map())?.model.id, undefined);
  assert.equal(
    rank(
      [cheap],
      [],
      new Map([["cheap", { available: false, inputPrice: 0, outputPrice: 0 }]]),
    )?.model.id,
    undefined,
  );
});
test("durable smoothed history changes routing for matching task features", async () => {
  const dir = await mkdtemp(join(tmpdir(), "koda-history-"));
  try {
    const ledger = new History(dir);
    assert.equal(rank()?.model.id, "cheap");
    for (let i = 0; i < 25; i++)
      for (const model of [cheap, frontier])
        ledger.record({
          timestamp: new Date().toISOString(),
          runId: "test",
          subtaskId: "fix",
          modelRequested: model.id,
          modelServed: model.id,
          features,
          verification: model.id === "cheap" ? "FAILED" : "VERIFIED_SUCCESS",
          failureAttribution: model.id === "cheap" ? "verified_patch_regression" : undefined,
          wallClockMs: 1000,
          inputTokens: 100,
          outputTokens: 20,
          costUsd: 0.001,
          escalated: false,
        });
    assert.equal(
      rank([cheap, frontier], new History(dir).read())?.model.id,
      "frontier",
    );
    assert.ok(rank([cheap, frontier], ledger.read())!.quality < 1);
    await writeFile(join(dir, "attempts.jsonl"), "partial", { flag: "a" });
    assert.equal(ledger.read().length, 50);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("legacy operational failures are ignored while attributed patch regressions lower coding quality", async () => {
  const dir = await mkdtemp(join(tmpdir(), "koda-history-attribution-"));
  try {
    const ledger = new History(dir);
    const row = (reason: string, failureAttribution?: "verified_patch_regression") => ({
      timestamp: new Date().toISOString(), runId: reason, subtaskId: "fix",
      modelRequested: cheap.id, modelServed: cheap.id, features,
      verification: "FAILED", wallClockMs: 1000, inputTokens: 100,
      outputTokens: 20, costUsd: 0.001, escalated: true, reason,
      failureAttribution,
    });
    for (let i = 0; i < 20; i++) ledger.record(row(`legacy no_mutation ${i}`));
    ledger.recordOperation({
      type: "operational_call", timestamp: new Date().toISOString(),
      runId: "provider-429", subtaskId: "fix", stage: "implement",
      taskBucket: "localized_bugfix", modelRequested: cheap.id,
      modelServed: null, provider: "test-provider", wallClockMs: 10,
      outcome: "error", costUsd: null,
    });
    assert.equal(ledger.read().length, 0);
    assert.equal(ledger.readOperations().length, 1);
    assert.equal(rank([cheap, frontier], ledger.read())?.model.id, cheap.id);
    for (let i = 0; i < 20; i++) ledger.record(row(`focused_verification_failed ${i}`, "verified_patch_regression"));
    assert.equal(ledger.read().length, 20);
    assert.equal(rank([cheap, frontier], ledger.read())?.model.id, frontier.id);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("failed final integration does not turn a worker success into model-quality failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "koda-history-final-"));
  try {
    const ledger = new History(dir);
    ledger.record({ timestamp: new Date().toISOString(), runId: "failed-run", subtaskId: "fix",
      modelRequested: cheap.id, modelServed: cheap.id, features,
      verification: "VERIFIED_SUCCESS", wallClockMs: 1000,
      inputTokens: 100, outputTokens: 20, costUsd: 0.001, escalated: false });
    ledger.finalize("failed-run", "FAILED");
    assert.equal(ledger.read().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("frontier rescue metric excludes initial frontier routing and counts later quality rescue", async () => {
  const dir = await mkdtemp(join(tmpdir(), "koda-frontier-metric-"));
  try {
    const logger = new Logger(dir, "metric-run", true);
    const call = { subtaskId: "direct", role: "FRONTIER_MODEL", modelRequested: "frontier",
      modelReturned: "frontier", stage: "implement", promptTokens: 10,
      completionTokens: 10, costUsd: 0.01, wallClockMs: 100, cachedTokens: 0,
      cacheWriteTokens: 0 };
    const verification = { status: "VERIFIED_SUCCESS", dimensions: {}, checks: [] } as any;
    logger.log("model_call", call);
    assert.equal(summarize(logger, "VERIFIED_SUCCESS", 100, verification, []).frontierCalls, 0);
    logger.log("escalation", { subtaskId: "direct", from: "CHEAP_CODER_A", to: "FRONTIER_MODEL" });
    logger.log("model_call", call);
    assert.equal(summarize(logger, "VERIFIED_SUCCESS", 200, verification, []).frontierCalls, 1);
    logger.log("model_fallback", { subtaskId: "stable", from: "cheap", to: "frontier",
      verifiedQualityFailure: true });
    logger.log("model_call", { ...call, subtaskId: "stable" });
    assert.equal(summarize(logger, "VERIFIED_SUCCESS", 300, verification, []).frontierCalls, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("catalog caches one refresh, uses stale cache, fallback metadata, and unknown prices", async () => {
  const dir = await mkdtemp(join(tmpdir(), "koda-catalog-"));
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        data: [
          {
            id: "cheap",
            context_length: 8000,
            pricing: {
              prompt: "0.000001",
              completion: "0.000002",
              overrides: [{ prompt: "0.000003" }],
            },
            supported_parameters: ["tools"],
          },
        ],
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const catalog = new Catalog(url, dir, 10000, [cheap, frontier]);
    const [a, b] = await Promise.all([catalog.get(), catalog.get()]);
    assert.equal(requests, 1);
    assert.equal(a.get("cheap")?.inputPrice, 3);
    assert.equal(b.get("frontier")?.available, false);
    await new Catalog(url, dir, 10000, [cheap, frontier]).get();
    assert.equal(requests, 1);
    await new Promise<void>((r) => server.close(() => r()));
    assert.equal(
      (await new Catalog(url, dir, 1, [cheap]).get()).get("cheap")?.outputPrice,
      2,
    );
    const other = join(dir, "other");
    assert.equal(
      (
        await new Catalog(url, other, 1, [
          { ...cheap, fallback: { inputPrice: 5, outputPrice: 6 } },
        ]).get()
      ).get("cheap")?.inputPrice,
      5,
    );
    assert.equal(
      (await new Catalog(url, other, 1, [cheap]).get()).get("cheap")
        ?.inputPrice,
      undefined,
    );
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("pool config and concurrent race selection preserve independent candidate identities", async () => {
  const { config } = await import("../src/config.js");
  const { PoolRouter } = await import("../src/router/modelRouter.js");
  const { Logger } = await import("../src/telemetry/logger.js");
  const dir = await mkdtemp(join(tmpdir(), "koda-pool-select-"));
  try {
    const cfg = await config(undefined, {
      modelsFile: join(process.cwd(), "koda.models.json"),
    });
    assert.ok(cfg.modelPool!.models.length >= 5);
    assert.equal(
      (await config(undefined, { models: { CHEAP_CODER_A: "legacy" } }))
        .modelPool,
      undefined,
    );
    const local = await config(undefined, {
      modelPool: { provider: "openrouter", models: [cheap, frontier] },
      routing: { stateDirectory: dir },
    });
    const router = new PoolRouter(local, new Logger(dir, "race", true));
    router.catalog.get = async () => metadata;
    const [a, b] = await Promise.all([
      router.select(features, "candidate-one", [], undefined, false, "group"),
      router.select(features, "candidate-two", [], undefined, false, "group"),
    ]);
    assert.notEqual(a.model.id, b.model.id);
    assert.equal(
      (await router.select(features, "unrelated")).model.id,
      "cheap",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const codingFeatures = (
  strategy: "direct" | "stable" | "planned",
  objective: string,
  paths: string[],
  parallelSafe = false,
) =>
  extractFeatures(
    {
      id: "work",
      title: objective,
      objective,
      likelyWritePaths: paths,
      likelyReadPaths: paths,
      dependsOn: [],
      integrationContract: "verified result",
      verificationCommands: ["pnpm test"],
      estimatedDifficulty: "normal",
      parallelSafe,
    },
    { files: paths } as any,
    1000,
    undefined,
    strategy,
  );

test("task buckets distinguish execution strategies and independent versus coupled work", () => {
  assert.equal(
    taskBucket(codingFeatures("direct", "Update add.ts", ["add.ts"])),
    "tiny_local_edit",
  );
  assert.equal(
    taskBucket(codingFeatures("direct", "Fix add.ts", ["add.ts"])),
    "localized_bugfix",
  );
  assert.equal(
    taskBucket(
      codingFeatures("stable", "Inspect add.ts, fix bug, add test", [
        "add.ts",
        "add.test.ts",
      ]),
    ),
    "inspect_fix_test",
  );
  assert.equal(
    taskBucket(
      codingFeatures("planned", "Change source and test", [
        "src/add.ts",
        "tests/add.test.ts",
      ]),
    ),
    "multi_file_coupled",
  );
  assert.equal(
    taskBucket(codingFeatures("planned", "Update add.ts", ["add.ts"], true)),
    "parallel_independent",
  );
  const complex = codingFeatures("planned", "Debug complex integration", [
    "add.ts",
  ]);
  assert.equal(
    taskBucket({ ...complex, complexity: "large" }),
    "complex_debugging",
  );
});

test("verified history moves inspect-fix-test from cheap to strong without contaminating a tiny edit", () => {
  const stable = codingFeatures(
    "stable",
    "Inspect add.ts, fix bug and add regression test",
    ["add.ts", "add.test.ts"],
  );
  const tiny = codingFeatures("direct", "Fix add.ts", ["add.ts"]);
  const choose = (f: typeof stable, rows: any[]) =>
    rankCandidates(
      [cheap, frontier],
      metadata,
      rows,
      f,
      routingSchema.parse({}),
      1000,
      100,
    ).find((candidate) => !candidate.rejected);
  const failure = (i: number) => ({
    timestamp: new Date().toISOString(),
    runId: `failure-${i}`,
    subtaskId: "stable",
    modelRequested: "cheap",
    modelServed: "cheap",
    features: stable,
    verification: "FAILED",
    failureAttribution: "verified_patch_regression" as const,
    wallClockMs: 1000,
    inputTokens: 100,
    outputTokens: 20,
    costUsd: 0.001,
    escalated: false,
  });
  assert.equal(choose(stable, [])?.model.id, "cheap");
  assert.equal(
    choose(stable, [failure(0)])?.model.id,
    "cheap",
    "one failure is not a blacklist",
  );
  assert.equal(
    choose(stable, [{ ...failure(0), reason: "HTTP 429 Too Many Requests" }])?.model.id,
    "cheap",
    "provider rate limits are not coding-quality failures",
  );
  const failures = Array.from({ length: 6 }, (_, i) => failure(i));
  assert.equal(
    choose(stable, failures)?.model.id,
    "frontier",
    "repeated similar failures lower quality below the gate",
  );
  assert.equal(
    choose(tiny, failures)?.model.id,
    "cheap",
    "unrelated easy work retains the cheap model",
  );
  const successes = Array.from({ length: 10 }, (_, i) => ({
    ...failure(i),
    verification: "VERIFIED_SUCCESS",
  }));
  const recovered = rankCandidates(
    [cheap, frontier],
    metadata,
    [...failures, ...successes],
    stable,
    routingSchema.parse({}),
    1000,
    100,
  );
  assert.ok(
    recovered.find((candidate) => candidate.model.id === "cheap")!.quality >
      rankCandidates(
        [cheap, frontier],
        metadata,
        failures,
        stable,
        routingSchema.parse({}),
        1000,
        100,
      ).find((candidate) => candidate.model.id === "cheap")!.quality,
  );
});

test("router rejects unpriced models before ranking and excludes failed candidates only in the current run", async () => {
  const { config } = await import("../src/config.js");
  const { PoolRouter } = await import("../src/router/modelRouter.js");
  const { Logger } = await import("../src/telemetry/logger.js");
  const dir = await mkdtemp(join(tmpdir(), "koda-task-routing-"));
  try {
    const cfg = await config(undefined, {
      modelPool: { provider: "openrouter", models: [cheap, frontier] },
      routing: { stateDirectory: dir },
    });
    const logger = new Logger(dir, "routing", true);
    const router = new PoolRouter(cfg, logger);
    router.catalog.get = async () =>
      new Map([
        ["cheap", { available: true }],
        ["frontier", { available: true, inputPrice: 10, outputPrice: 20 }],
      ]);
    assert.equal(
      (await router.select(features, "unpriced")).model.id,
      "frontier",
    );
    router.catalog.get = async () => metadata;
    assert.equal((await router.select(features, "initial")).model.id, "cheap");
    for (const [strategy, objective, paths, expected] of [
      ["direct", "Fix add.ts", ["add.ts"], "localized_bugfix"],
      [
        "stable",
        "Inspect add.ts, fix bug and add regression test",
        ["add.ts", "add.test.ts"],
        "inspect_fix_test",
      ],
      ["planned", "Update add.ts", ["add.ts"], "parallel_independent"],
    ] as const) {
      await router.select(
        codingFeatures(strategy, objective, [...paths], strategy === "planned"),
        `strategy-${strategy}`,
      );
      assert.equal(
        logger.events.findLast((event) => event.type === "model_router")
          ?.task_bucket,
        expected,
      );
    }
    assert.equal(
      (await router.select(features, "fallback", ["cheap"])).model.id,
      "frontier",
    );
    const nextRun = new PoolRouter(cfg, new Logger(dir, "next-run", true));
    nextRun.catalog.get = async () => metadata;
    assert.equal((await nextRun.select(features, "fresh")).model.id, "cheap");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("strict forced routing reuses its pin but rejects invalid candidates", async () => {
  const { config } = await import("../src/config.js");
  const { PoolRouter } = await import("../src/router/modelRouter.js");
  const { Logger } = await import("../src/telemetry/logger.js");
  const dir = await mkdtemp(join(tmpdir(), "koda-forced-routing-"));
  try {
    const cfg = await config(undefined, {
      modelPool: { provider: "openrouter", models: [cheap, frontier] },
      forceModel: "cheap",
      routing: { stateDirectory: dir },
    });
    const router = new PoolRouter(cfg, new Logger(dir, "forced", true));
    router.catalog.get = async () => metadata;
    assert.equal((await router.select(features, "first")).model.id, "cheap");
    assert.equal(
      (await router.select(features, "again", ["cheap"], cheap, true)).model.id,
      "cheap",
    );
    assert.equal(
      (await router.select(features, "third", ["cheap"], cheap, true)).model.id,
      "cheap",
    );
    for (const invalid of [
      { available: false, inputPrice: 0.1, outputPrice: 0.2 },
      { available: true },
      { available: true, inputPrice: 0.1, outputPrice: 0.2, supportedParameters: [] },
    ]) {
      router.catalog.get = async () => new Map([
        ["cheap", invalid],
        ["frontier", metadata.get("frontier")!],
      ]);
      await assert.rejects(
        router.select(features, "invalid", ["cheap"], cheap, true),
        /Forced model unavailable/,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

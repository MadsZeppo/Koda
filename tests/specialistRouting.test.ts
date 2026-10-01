import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { modelSchema, routingSchema } from "../src/router/pool.js";
import { Catalog } from "../src/openrouter/catalog.js";
import { CapabilityRegistry } from "../src/router/capabilityRegistry.js";
import { config } from "../src/config.js";
import {
  PoolRouter,
  selectQualitySafeJointPlan,
  zeroEligibleCodingFallback,
} from "../src/router/modelRouter.js";
import { Gateway } from "../src/openrouter/client.js";
import { Budget } from "../src/openrouter/usage.js";
import { Logger } from "../src/telemetry/logger.js";
import { optimizeSpecialists } from "../src/router/routeOptimizer.js";
import {
  taskFingerprint,
  type TaskFingerprint,
} from "../src/router/taskFingerprint.js";
import { extractFeatures } from "../src/router/features.js";
import { taskBucket } from "../src/router/features.js";
import {
  chooseExecutionStrategy,
  directWritePaths,
} from "../src/router/executionStrategy.js";
import type { SpecialistModel } from "../src/router/capabilityRegistry.js";
import type { Attempt, OperationalCall } from "../src/router/history.js";

const profile = {
  files: ["src/Dashboard.tsx", "src/state.ts", "tests/dashboard.test.ts"],
  verificationCommands: ["pnpm test"],
} as any;
const subtask = (
  objective: string,
  paths = ["src/Dashboard.tsx"],
  checks: string[] = [],
) => ({
  id: "ui",
  title: objective,
  objective,
  likelyReadPaths: paths,
  likelyWritePaths: paths,
  dependsOn: [],
  integrationContract: "",
  verificationCommands: checks,
  estimatedDifficulty: "normal" as const,
  parallelSafe: true,
});
const scenario = (
  objective: string,
  paths?: string[],
  checks?: string[],
  strategy = "direct",
) => {
  const task = subtask(objective, paths, checks);
  const features = extractFeatures(task, profile, 2000, undefined, strategy);
  return {
    features,
    fingerprint: taskFingerprint(task, profile, features, "normal"),
  };
};
const cheap: SpecialistModel = {
  model: modelSchema.parse({
    id: "older-any-provider",
    tier: "cheap",
    qualityPrior: 0.95,
    latencyPriorMs: 1000,
    strengths: ["coding", "tool_use", "frontend_ui", "backend"],
  }),
  metadata: {
    available: true,
    inputPrice: 0.1,
    outputPrice: 0.2,
    contextLength: 100000,
    supportedParameters: ["tools", "tool_choice"],
  },
  vision: false,
  configured: true,
  evidence: [{ source: "design_benchmark", value: 1380, detail: "design" }],
};
const strong: SpecialistModel = {
  model: modelSchema.parse({
    id: "another-provider",
    tier: "strong",
    qualityPrior: 0.965,
    latencyPriorMs: 6000,
    strengths: ["coding", "tool_use", "frontend_ui", "backend", "repo_scale"],
  }),
  metadata: {
    available: true,
    inputPrice: 8,
    outputPrice: 12,
    contextLength: 100000,
    supportedParameters: ["tools", "tool_choice"],
  },
  vision: false,
  configured: true,
  evidence: [{ source: "design_benchmark", value: 1200, detail: "design" }],
};
const settings = {
  maxOutputTokens: 1000,
  routing: routingSchema.parse({ maxQualityRegret: 0.025, latencyWeight: 0.4 }),
} as any;
const route = (
  fp: TaskFingerprint,
  features: ReturnType<typeof scenario>["features"],
  history: Attempt[] = [],
  models = [cheap, strong],
  operations: OperationalCall[] = [],
) =>
  optimizeSpecialists(models, fp, features, history, settings, 10, operations);

test("zero-eligible fallback softens latency and quality filters but preserves compatibility and budget", () => {
  const s = scenario("Implement a coupled change and verify it", ["src/Dashboard.tsx"], ["pnpm test"]);
  const estimates = route(s.fingerprint, s.features).considered;
  assert.ok(estimates.length >= 2);
  const affordable = {
    ...estimates[0]!,
    rejected: "quality parity",
    rejection: "quality parity",
    hardRejection: undefined,
    reservationCost: 0.02,
    quality: 0.82,
    conservativeQuality: 0.78,
  };
  const slowStronger = {
    ...estimates[1]!,
    rejected: "predicted model latency exceeds implementation request deadline",
    rejection: "predicted model latency exceeds implementation request deadline",
    hardRejection: "predicted model latency exceeds implementation request deadline",
    reservationCost: 0.03,
    quality: 0.90,
    conservativeQuality: 0.84,
    deadlineFeasible: false,
    latencyP90Ms: 120_000,
  };
  const unavailable = {
    ...slowStronger,
    model: { ...slowStronger.model, id: "unavailable" },
    metadata: { ...slowStronger.metadata, available: false },
    hardRejection: "unavailable",
  };
  const overBudget = {
    ...slowStronger,
    model: { ...slowStronger.model, id: "over-budget" },
    reservationCost: 2,
    hardRejection: "completion budget",
  };
  const selected = zeroEligibleCodingFallback(
    [affordable, slowStronger, unavailable, overBudget],
    0.1,
    2,
  );
  assert.ok(selected.length >= 1);
  assert.equal(selected[0]!.model.id, affordable.model.id);
  assert.equal(selected[1]!.model.id, slowStronger.model.id,
    "a stronger bounded recovery remains available after first-attempt rejection");
  assert.ok(selected.some((candidate) => candidate.model.id === slowStronger.model.id),
    "predicted latency must rank rather than eliminate a usable model");
  assert.ok(selected.every((candidate) => candidate.metadata.available !== false));
  assert.ok(selected.every((candidate) => candidate.reservationCost <= 0.1));
  assert.ok(selected.every((candidate) => candidate.hardRejection === undefined));
});

test("zero-eligible fallback remains bounded and returns no model when every candidate is technically invalid", () => {
  const s = scenario("Implement a change", ["src/Dashboard.tsx"]);
  const estimate = route(s.fingerprint, s.features).considered[0]!;
  const invalid = ["unavailable", "context limit", "batch endpoint unsupported for interactive worker"]
    .map((reason, index) => ({
      ...estimate,
      model: { ...estimate.model, id: `invalid-${index}` },
      rejected: reason,
      rejection: reason,
      hardRejection: reason,
      reservationCost: 0.001,
    }));
  assert.deepEqual(zeroEligibleCodingFallback(invalid, 1, 2), []);
  assert.deepEqual(zeroEligibleCodingFallback([{ ...estimate, reservationCost: 2 }], 1, 2), []);
});

test("joint routing can execute a finite zero-eligible fallback plan", () => {
  const fallbackPlan = {
    initialModel: "fallback",
    conservativeQuality: 0.78,
    allowedQualityRegret: 0.2,
    optimizerScore: 0.01,
    expectedLatencyMs: 20_000,
    expectedCostPerVerifiedSolve: 0.02,
    evaluatedPlans: [{ conservativeFinalSuccess: Number.NaN, hardRejection: "quality" }],
  } as any;
  const selected = selectQualitySafeJointPlan([{
    executionStrategy: "stable" as const,
    plan: fallbackPlan,
  }]);
  assert.equal(selected?.plan.initialModel, "fallback");
});
const observed = (
  model: string,
  fp: TaskFingerprint,
  features: ReturnType<typeof scenario>["features"],
  verification: string,
  reason?: string,
): Attempt => ({
  timestamp: "2026-01-01",
  runId: "r",
  subtaskId: "ui",
  modelRequested: model,
  modelServed: model,
  features,
  fingerprint: fp,
  verification,
  wallClockMs: 1000,
  inputTokens: 100,
  outputTokens: 100,
  costUsd: 0.01,
  escalated: verification !== "VERIFIED_SUCCESS",
  reason,
  failureAttribution:
    verification === "FAILED" && !/provider|HTTP 429/i.test(reason ?? "")
      ? "verified_patch_regression"
      : undefined,
});

test("Aider rejects repeated failures of both edit formats before cheapest-worker economics", () => {
  const s = scenario("Find and fix the bounded defect", ["."], [], "direct");
  const fp = {
    ...s.fingerprint,
    boundedDiscovery: true,
    localizationConfidence: "low" as const,
    expectedFiles: 2,
  };
  const operations: OperationalCall[] = [0, 1].map((index) => ({
    type: "operational_call",
    timestamp: new Date(Date.now() - index * 1000).toISOString(),
    runId: `format-${index}`,
    subtaskId: "ui",
    stage: "implement",
    taskBucket: taskBucket(s.features),
    modelRequested: cheap.model.id,
    modelServed: cheap.model.id,
    provider: "aider",
    wallClockMs: 100,
    outcome: "error",
    costUsd: 0.0001,
    editFormat: index === 0 ? "diff" : "whole",
    failureKind: "edit_format",
  }));
  const result = route(fp, s.features, [], [cheap, strong], operations);
  assert.equal(
    result.considered.find((item) => item.model.id === cheap.model.id)
      ?.hardRejection,
    "observed Aider edit-format incompatibility",
  );
  assert.equal(result.cascade[0]?.model.id, strong.model.id);
});

test("cheap OpenRouter models remain eligible without a static Mini-SWE certificate", () => {
  const s = scenario("Find and fix the bounded defect", ["."], [], "direct");
  const fp = { ...s.fingerprint, boundedDiscovery: true,
    localizationConfidence: "low" as const };
  const uncertified = {
    ...cheap,
    model: { ...cheap.model, id: "inclusionai/ling-3.0-flash" },
  };
  const certified = {
    ...strong,
    model: { ...strong.model, id: "openai/gpt-5-mini" },
  };
  const result = route(fp, s.features, [], [uncertified, certified]);
  assert.notEqual(result.considered.find((candidate) =>
    candidate.model.id === uncertified.model.id)?.hardRejection,
  "Mini-SWE protocol not certified");
  assert.ok(result.cascade.some((candidate) =>
    candidate.model.id === uncertified.model.id));
});

test("DeepSeek native tool models remain eligible for Mini-SWE", () => {
  const s = scenario("Find and fix the bounded defect", ["."], [], "direct");
  const fp = { ...s.fingerprint, boundedDiscovery: true,
    localizationConfidence: "low" as const };
  const deepseek = {
    ...cheap,
    model: { ...cheap.model, id: "deepseek/deepseek-v4.1-flash" },
  };
  const result = route(fp, s.features, [], [deepseek]);
  assert.notEqual(result.considered[0]?.hardRejection,
    "Mini-SWE protocol not certified");
  assert.equal(result.cascade[0]?.model.id, deepseek.model.id);
});

test("universal selector considers every discovered model and chooses the cheapest quality-preserving plan", () => {
  const model = (
    id: string,
    strengths: string[],
    price: number,
  ): SpecialistModel => ({
    model: modelSchema.parse({
      id,
      tier: "fast",
      qualityPrior: 0.95,
      latencyPriorMs: 1000,
      strengths: ["tool_use", ...strengths],
    }),
    metadata: {
      available: true,
      inputPrice: price,
      outputPrice: price,
      contextLength: 100000,
      supportedParameters: ["tools", "tool_choice"],
    },
    vision: false,
    configured: true,
    evidence: [
      {
        source: "configured_prior",
        value: 0.95,
        detail: "configured capability",
      },
    ],
  });
  const fillers = Array.from({ length: 10 }, (_, i) =>
    model(`filler-${i}`, ["coding"], 0.01),
  );
  const ui = model("ui-specialist", ["coding", "frontend_ui"], 0.2);
  const database = model(
    "database-specialist",
    ["coding", "sql_database"],
    0.15,
  );
  const refactor = model(
    "repo-refactor-specialist",
    ["coding", "refactor", "repo_scale"],
    0.25,
  );
  const tiny = model("tiny-specialist", ["coding"], 0.005);
  const all = [...fillers, ui, database, refactor, tiny];
  const uiTask = scenario(
    "Fix React UI layout",
    ["src/Dashboard.tsx"],
    ["node --test tests/dashboard.test.ts"],
  );
  const uiRoute = route(uiTask.fingerprint, uiTask.features, [], all);
  assert.equal(uiRoute.cascade[0]?.model.id, tiny.model.id);
  assert.equal(
    uiRoute.reference?.model.id,
    tiny.model.id,
    "a configured specialty label alone does not create a stronger quality claim",
  );
  const dbTask = scenario(
    "Fix SQL database query",
    ["src/query.sql"],
    ["node --test tests/query.test.ts"],
  );
  assert.equal(
    route(dbTask.fingerprint, dbTask.features, [], all).cascade[0]?.model.id,
    tiny.model.id,
    "unverified configured specialty tags do not override economics",
  );
  const refactorTask = scenario(
    "Refactor repository module",
    ["src/state.ts"],
    ["node --test tests/state.test.ts"],
  );
  assert.equal(
    route(refactorTask.fingerprint, refactorTask.features, [], all).cascade[0]
      ?.model.id,
    tiny.model.id,
  );
  const tinyTask = scenario(
    "Correct a value",
    ["src/state.ts"],
    ["node --test tests/state.test.ts"],
  );
  const tinyResult = route(tinyTask.fingerprint, tinyTask.features, [], all);
  assert.equal(
    tinyResult.considered.length,
    all.length,
    "no fixed shortlist truncates discovery",
  );
  assert.equal(tinyResult.cascade[0]?.model.id, tiny.model.id);
  const unknown = model("unknown-specialty", [], 0.0001);
  assert.equal(
    route(
      dbTask.fingerprint,
      dbTask.features,
      [],
      [unknown, database],
    ).considered.find((candidate) => candidate.model.id === unknown.model.id)!
      .hardRejection,
    undefined,
    "unknown evidence is uncertainty, not technical incompatibility",
  );
});

test("missing soft domain tags remain eligible when benchmark evidence supports verified quality", () => {
  const task = scenario(
    "Debug backend request handling and refactor the failing path",
    ["src/request.ts"],
    ["node --test tests/request.test.ts"],
  );
  const economical: SpecialistModel = {
    model: modelSchema.parse({
      id: "economical-benchmarked",
      tier: "fast",
      qualityPrior: 0.99,
      latencyPriorMs: 400,
      strengths: [],
    }),
    metadata: {
      available: true,
      inputPrice: 0.1,
      outputPrice: 0.1,
      contextLength: 100000,
      supportedParameters: ["tools", "tool_choice"],
    },
    vision: false,
    configured: true,
    evidence: [
      { source: "coding_benchmark", value: 0.98, detail: "coding" },
      { source: "agentic_benchmark", value: 0.96, detail: "agentic" },
    ],
  };
  const reference = {
    ...strong,
    model: {
      ...strong.model,
      strengths: [...strong.model.strengths, "debugging", "refactor"],
    },
  };
  const result = route(
    task.fingerprint,
    task.features,
    [],
    [economical, reference],
  );
  const candidate = result.considered.find(
    (entry) => entry.model.id === economical.model.id,
  )!;
  assert.equal(candidate.rejected, undefined);
  assert.equal(result.cascade[0]?.model.id, economical.model.id);
  assert.ok(candidate.uncertainty > 0);
  const noTools = {
    ...economical,
    metadata: { ...economical.metadata, supportedParameters: [] },
  };
  assert.equal(
    route(
      task.fingerprint,
      task.features,
      [],
      [noTools, reference],
    ).considered.find((entry) => entry.model.id === economical.model.id)
      ?.rejected,
    undefined,
  );
});

test("worker selection reads precomputed capability data without calling the discovery adapter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "koda-cached-route-"));
  try {
    const cfg = await config(undefined, {
      baseUrl: "http://127.0.0.1:1",
      modelPool: {
        provider: "local-compatible",
        models: [
          modelSchema.parse({
            ...cheap.model,
            fallback: cheap.metadata,
          }),
        ],
      },
      routing: { stateDirectory: directory },
    });
    let discoveries = 0;
    const pool = new PoolRouter(
      cfg,
      new Logger(directory, "cached-route", true),
      {
        discover: async () => {
          discoveries++;
          throw Error("discovery is outside the hot route");
        },
      },
    );
    const s = scenario("Correct a value", ["src/state.ts"]);
    const first = await pool.selectSpecialist(
      s.fingerprint,
      s.features,
      "first",
      10,
    );
    const second = await pool.selectSpecialist(
      s.fingerprint,
      s.features,
      "second",
      10,
    );
    assert.equal(discoveries, 0);
    assert.equal(first[0]?.model.id, cheap.model.id);
    assert.deepEqual(
      first.map((entry) => entry.model.id),
      second.map((entry) => entry.model.id),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("non-OpenRouter discovery adapter exposes every model but keeps unknown evidence unknown", async () => {
  const configured = modelSchema.parse({
    id: "configured",
    tier: "fast",
    qualityPrior: 0.95,
    latencyPriorMs: 1000,
    strengths: ["coding", "tool_use"],
  });
  const cfg = await config(undefined, {
    baseUrl: "http://localhost:1/v1",
    modelPool: { provider: "local-compatible", models: [configured] },
  });
  const dynamic = new Map<string, any>();
  const catalog = {
    directory: "/unused",
    get: async () => new Map(dynamic),
    addDynamic: (rows: Iterable<[string, any]>) => {
      for (const [id, metadata] of rows) dynamic.set(id, metadata);
    },
  } as any;
  let calls = 0;
  const adapter = {
    discover: async () => {
      calls++;
      return {
        baseUrl: cfg.baseUrl,
        retrievedAt: Date.now(),
        models: ["configured", "benchmarked", "unknown"].map((id) => ({
          id,
          context_length: 100000,
          supported_parameters: ["tools", "tool_choice"],
          pricing: {
            prompt: id === "configured" ? "0.00001" : "0.0000002",
            completion: id === "configured" ? "0.00002" : "0.0000004",
          },
        })),
        benchmarks: [{ model_permaslug: "benchmarked", coding_index: 90 }],
        classifications: [],
      };
    },
  };
  const registry = new CapabilityRegistry(cfg, catalog, adapter);
  const s = scenario(
    "Correct a value",
    ["src/state.ts"],
    ["node --test tests/state.test.ts"],
  );
  await registry.freezeRunSnapshot();
  await registry.freezeRunSnapshot();
  const discovered = await registry.forTask(s.fingerprint);
  assert.equal(calls, 1);
  assert.deepEqual(discovered.map((item) => item.model.id).sort(), [
    "benchmarked",
    "configured",
    "unknown",
  ]);
  assert.deepEqual(
    discovered.find((item) => item.model.id === "unknown")!.evidence,
    [],
  );
  const routed = optimizeSpecialists(
    discovered,
    s.fingerprint,
    s.features,
    [],
    {
      ...settings,
      codingAttemptTimeoutMs: 1_000,
      modelTimeoutMs: { implementation: 1_000 },
    } as any,
    10,
  );
  assert.equal(
    routed.cascade[0]?.model.id,
    "benchmarked",
    "an adapter-discovered qualified model can beat the configured pool",
  );
  const benchmarked = routed.considered.find(
    (candidate) => candidate.model.id === "benchmarked",
  )!;
  assert.equal(benchmarked.latencyEvidenceKnown, false);
  assert.equal(benchmarked.latencyP50Ms, null);
  assert.equal(benchmarked.latencyP90Ms, null);
  assert.equal(benchmarked.deadlineFeasible, true,
    "a synthetic latency fallback must not reject a discovered model");
  assert.ok(benchmarked.softPenalties?.includes("latency unknown"));
  assert.match(
    routed.considered.find(
      (candidate) => candidate.model.id === "unknown",
    )!.rejected!,
    /minimum quality|quality parity/,
  );
});

test("non-OpenRouter compatible provider receives no OpenRouter-only request fields", async () => {
  const requests: any[] = [];
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/models") {
      response.statusCode = 404;
      response.end("{}");
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    response.end(
      JSON.stringify({
        id: "mock",
        model: "local-model",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "ok" },
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 1, cost: 0.000001 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const directory = await mkdtemp(join(tmpdir(), "koda-local-provider-"));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const cfg = await config(undefined, {
      baseUrl: `http://127.0.0.1:${address.port}`,
      modelPool: {
        provider: "local-compatible",
        models: [
          modelSchema.parse({
            id: "local-model",
            tier: "fast",
            qualityPrior: 0.95,
            latencyPriorMs: 1000,
            strengths: ["coding", "tool_use"],
          }),
        ],
      },
      routing: { stateDirectory: directory },
    });
    const gateway = new Gateway(
      cfg,
      new Logger(directory, "local-provider", true),
      new Budget(1, 10000, 30000),
      {
        discover: async () => ({
          baseUrl: cfg.baseUrl,
          retrievedAt: Date.now(),
          classifications: [],
          benchmarks: [],
          models: [
            {
              id: "local-model",
              context_length: 100000,
              pricing: { prompt: "0.0000001", completion: "0.0000002" },
              supported_parameters: ["tools"],
            },
          ],
        }),
      },
    );
    await gateway.modelRouter!.capabilities.refresh();
    await gateway.call(
      "local-model",
      [{ role: "user", content: "hello" }],
      "task",
      "implement",
      0,
    );
    assert.equal(requests.length, 1);
    assert.equal("provider" in requests[0], false);
    assert.equal("session_id" in requests[0], false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("focused failing test is read-only evidence for one localized implementation repair", () => {
  const task =
    "Find why the test is failing, fix the implementation, and verify that all tests pass.";
  const repository = {
    ...profile,
    files: ["add.js", "tests/add.test.js", "package.json"],
    verificationCommands: ["npm run test"],
    symbols: [],
  } as any;
  const strategy = chooseExecutionStrategy(task, repository);
  assert.equal(strategy.execution_strategy, "direct");
  const writes = directWritePaths(strategy.likelyFiles, repository, task);
  assert.deepEqual(writes, ["add.js"]);
  const work = {
    ...subtask(task, writes),
    likelyReadPaths: strategy.likelyFiles,
  };
  const verification = {
    checks: [
      { command: "node --test tests/add.test.js", outcome: "CHECK_FAIL" },
    ],
    failedChecks: 1,
  } as any;
  const features = extractFeatures(
    work,
    repository,
    1200,
    verification,
    "direct",
  );
  const fingerprint = taskFingerprint(
    work,
    repository,
    features,
    "normal",
    verification,
  );
  assert.equal(taskBucket(features), "localized_bugfix");
  assert.equal(fingerprint.primary, "debugging");
  assert.ok(fingerprint.secondary.includes("testing"));
  assert.equal(fingerprint.scope, "single");
  assert.equal(fingerprint.verificationStrength, "strong");
  assert.equal(fingerprint.difficulty.technicalComplexity, "low");
  assert.equal(fingerprint.difficulty.architecturalComplexity, "low");
  assert.equal(fingerprint.difficulty.repoReasoningComplexity, "low");
  assert.equal(fingerprint.architectureHeavy, false);
  assert.equal(fingerprint.repoReasoningHeavy, false);
  assert.equal(fingerprint.difficulty.changeRisk, "low");
  assert.equal(fingerprint.difficulty.contextUncertainty, "low");
  const economical = {
    ...cheap,
    model: { ...cheap.model, qualityPrior: 0.72 },
  };
  const result = route(fingerprint, features, [], [economical, strong]);
  assert.equal(result.cascade[0]?.model.id, cheap.model.id);
  assert.ok(
    result.cascade[0]!.firstAttemptQualityFloor <
      settings.routing.minimumQuality,
  );
  assert.ok(result.cascade[0]!.expectedCompletionCost < result.reference!.cost);
  fingerprint.verificationStrength = "weak";
  fingerprint.difficulty.changeRisk = "high";
  assert.equal(
    route(fingerprint, features, [], [economical, strong]).cascade[0]?.model.id,
    strong.model.id,
  );
});

test("independent JavaScript repairs require only their own concrete capabilities", () => {
  const repository = {
    ...profile,
    files: [
      "src/first.js",
      "src/second.js",
      "tests/first.test.js",
      "tests/second.test.js",
    ],
  } as any;
  for (const file of ["src/first.js", "src/second.js"]) {
    const work = {
      ...subtask(
        `Repair the failing behavior in ${file}. Only this independent component is assigned.`,
        [file],
        [`node --test tests/${file.split("/")[1]!.replace(".js", ".test.js")}`],
      ),
      id: file,
      likelyReadPaths: [file, "src/Dashboard.tsx", "tests/second.test.js"],
    };
    const features = extractFeatures(
      work,
      repository,
      1000,
      undefined,
      "planned",
    );
    const fp = taskFingerprint(work, repository, features, "normal");
    assert.equal(fp.primary, "debugging");
    assert.equal(fp.visualRelevant, false);
    assert.equal(fp.architectureHeavy, false);
    assert.equal(fp.repoReasoningHeavy, false);
    assert.equal(fp.difficulty.architecturalComplexity, "low");
    assert.equal(
      fp.secondary.some((kind) =>
        ["frontend_ui", "architecture", "sql_database"].includes(kind),
      ),
      false,
    );
    assert.equal(
      route(fp, features, [], [cheap, strong]).cascade[0]?.model.id,
      cheap.model.id,
      "an unrelated capability must not exclude a qualified economical coder",
    );
  }
});

test("repeated slow interactive calls demote a cheaper qualified model without changing its quality history", () => {
  const s = scenario(
    "Fix backend endpoint",
    ["src/api.ts"],
    ["node --test tests/api.test.ts"],
  );
  s.fingerprint.verificationStrength = "strong";
  s.fingerprint.verifierFalseAcceptRisk = "low";
  s.fingerprint.recoveryDetectability = "high";
  const call = (
    model: string,
    ms: number,
    outcome: "response" | "error" = "response",
  ): OperationalCall => ({
    type: "operational_call",
    timestamp: "2026-01-01",
    runId: "latency",
    subtaskId: "ui",
    stage: "implement",
    taskBucket: "localized_bugfix",
    modelRequested: model,
    modelServed: outcome === "response" ? model : null,
    provider: "mock-provider",
    wallClockMs: ms,
    outcome,
    costUsd: outcome === "response" ? 0.001 : 0,
  });
  const operations = [
    ...Array.from({ length: 8 }, () => call(cheap.model.id, 70000)),
    ...Array.from({ length: 8 }, () => call(strong.model.id, 1200)),
  ];
  const result = route(
    s.fingerprint,
    s.features,
    [],
    [cheap, strong],
    operations,
  );
  assert.equal(result.cascade[0]?.model.id, strong.model.id);
  const slow = result.considered.find(
    (candidate) => candidate.model.id === cheap.model.id,
  )!;
  assert.equal(slow.callCount, 8);
  assert.ok(slow.latencyP90Ms! >= 70000);
  assert.equal(slow.latencySlaPassed, false);
  const fastUnqualified = {
    ...cheap,
    model: { ...cheap.model, qualityPrior: 0.1 },
  };
  const verifiedCascade = route(
    s.fingerprint,
    s.features,
    [],
    [fastUnqualified, strong],
    Array.from({ length: 8 }, () => call(cheap.model.id, 100)),
  ).cascade;
  assert.equal(
    verifiedCascade[0]?.model.id,
    strong.model.id,
    "strong verification cannot manufacture quality evidence for a known-low candidate",
  );
  const infra = Array.from({ length: 8 }, () =>
    call(cheap.model.id, 30000, "error"),
  );
  const qualityBefore = route(s.fingerprint, s.features, [], [cheap, strong])
    .considered[0]!.quality;
  const qualityAfter = route(
    s.fingerprint,
    s.features,
    [],
    [cheap, strong],
    infra,
  ).considered[0]!.quality;
  assert.equal(qualityAfter, qualityBefore);
  assert.ok(
    route(
      s.fingerprint,
      s.features,
      [],
      [cheap, strong],
      infra,
    ).considered.find((candidate) => candidate.model.id === cheap.model.id)!
      .operationalErrorRate > 0,
  );
});

test("difficulty is multidimensional and changes UI choice from cheaper specialist to strong reference", () => {
  const simple = scenario("Change card spacing in React Dashboard.tsx");
  const complex = scenario(
    "Redesign React dashboard, restructure state and connect new data flow across components",
    ["src/Dashboard.tsx", "src/state.ts"],
  );
  assert.equal(simple.fingerprint.primary, "frontend_ui");
  assert.equal(complex.fingerprint.primary, "frontend_ui");
  assert.equal(simple.fingerprint.difficulty.technicalComplexity, "low");
  assert.equal(complex.fingerprint.difficulty.technicalComplexity, "high");
  assert.equal(
    route(simple.fingerprint, simple.features).cascade[0]?.model.id,
    cheap.model.id,
  );
  const hard = route(complex.fingerprint, complex.features);
  assert.equal(hard.reference?.model.id, strong.model.id);
  assert.equal(hard.cascade[0]?.model.id, strong.model.id);
  assert.equal(
    hard.considered.find((c) => c.model.id === cheap.model.id)
      ?.qualityFloorPassed,
    false,
  );
});

test("backend complexity, quality parity, unknown pricing and provider-independent IDs", () => {
  const simple = scenario("Add backend endpoint", ["src/api.ts"]);
  const complex = scenario(
    "Debug backend endpoint across modules and migrate database schema",
    ["src/api.ts", "src/db.ts"],
  );
  const strongDb = {
    ...strong,
    model: {
      ...strong.model,
      strengths: [...strong.model.strengths, "sql_database"],
    },
  };
  assert.equal(
    route(simple.fingerprint, simple.features).cascade[0]?.model.id,
    cheap.model.id,
  );
  assert.equal(
    route(complex.fingerprint, complex.features, [], [cheap, strongDb])
      .cascade[0]?.model.id,
    strong.model.id,
  );
  const unpriced = { ...cheap, metadata: { available: true } };
  assert.equal(
    route(simple.fingerprint, simple.features, [], [unpriced, strong])
      .cascade[0]?.model.id,
    strong.model.id,
  );
});

test("strong focused verification can bridge a quality gap too large for weak UI checks", () => {
  assert.equal(
    scenario("Polish React layout", undefined, ["pnpm run typecheck"])
      .fingerprint.verificationStrength,
    "weak",
  );
  const s = scenario("Change React layout", undefined, [
    "node --test tests/dashboard.test.ts",
  ]);
  const lessCertainCheap = {
    ...cheap,
    model: { ...cheap.model, qualityPrior: 0.89 },
    evidence: [
      { source: "design_benchmark" as const, value: 1200, detail: "design" },
    ],
  };
  s.fingerprint.verificationStrength = "strong";
  s.fingerprint.verifierFalseAcceptRisk = "low";
  s.fingerprint.recoveryDetectability = "high";
  const strongRoute = route(
    s.fingerprint,
    s.features,
    [],
    [lessCertainCheap, strong],
  );
  assert.equal(strongRoute.cascade[0]?.model.id, cheap.model.id);
  assert.ok(
    strongRoute.cascade[0]!.expectedCompletionCost <
      strongRoute.reference!.cost,
  );
  s.fingerprint.verificationStrength = "weak";
  s.fingerprint.verifierFalseAcceptRisk = "high";
  s.fingerprint.recoveryDetectability = "low";
  const weakRoute = route(
    s.fingerprint,
    s.features,
    [],
    [lessCertainCheap, strong],
  );
  assert.equal(weakRoute.cascade[0]?.model.id, strong.model.id);
  assert.equal(
    weakRoute.considered.find((c) => c.model.id === cheap.model.id)
      ?.qualityFloorPassed,
    false,
  );
});

test("task-specific verified history can overcome prior then verified failures reverse it; infra does not count", () => {
  const s = scenario("Change React card spacing");
  const success = Array.from({ length: 18 }, () =>
    observed(cheap.model.id, s.fingerprint, s.features, "VERIFIED_SUCCESS"),
  );
  assert.equal(
    route(s.fingerprint, s.features, success).reference?.model.id,
    cheap.model.id,
  );
  const failed = Array.from({ length: 18 }, () =>
    observed(
      cheap.model.id,
      s.fingerprint,
      s.features,
      "FAILED",
      "test assertion",
    ),
  );
  assert.equal(
    route(s.fingerprint, s.features, [...success, ...failed]).reference?.model
      .id,
    strong.model.id,
  );
  const infra = Array.from({ length: 50 }, () =>
    observed(
      cheap.model.id,
      s.fingerprint,
      s.features,
      "FAILED",
      "provider HTTP 520",
    ),
  );
  assert.equal(
    route(s.fingerprint, s.features, success.concat(infra)).reference?.model.id,
    cheap.model.id,
  );
  const unrelated = scenario("Fix API", ["src/api.ts"]);
  assert.notEqual(
    route(unrelated.fingerprint, unrelated.features, failed).considered.find(
      (c) => c.model.id === cheap.model.id,
    )?.quality,
    route(unrelated.fingerprint, unrelated.features, []).considered.find(
      (c) => c.model.id === cheap.model.id,
    )?.quality,
  );
});

test("one localized failure does not poison another file, and HTTP 429 is operational evidence only", () => {
  const first = scenario(
    "Fix API lookup",
    ["src/api.ts"],
    ["node --test tests/api.test.ts"],
  );
  const next = scenario(
    "Fix user lookup",
    ["src/users.ts"],
    ["node --test tests/users.test.ts"],
  );
  const baseline = route(next.fingerprint, next.features);
  const oneFailure = observed(
    cheap.model.id,
    first.fingerprint,
    first.features,
    "FAILED",
    "focused assertion failed",
  );
  const after = route(next.fingerprint, next.features, [oneFailure]);
  assert.equal(after.cascade[0]?.model.id, baseline.cascade[0]?.model.id);
  const baseQuality = baseline.considered.find(
    (c) => c.model.id === cheap.model.id,
  )!.quality;
  assert.ok(
    baseQuality -
      after.considered.find((c) => c.model.id === cheap.model.id)!.quality <
      0.01,
  );
  const rateLimited = observed(
    cheap.model.id,
    first.fingerprint,
    first.features,
    "FAILED",
    "HTTP 429 Too Many Requests",
  );
  assert.equal(
    route(first.fingerprint, first.features, [rateLimited]).considered.find(
      (c) => c.model.id === cheap.model.id,
    )!.quality,
    route(first.fingerprint, first.features).considered.find(
      (c) => c.model.id === cheap.model.id,
    )!.quality,
  );
});

test("weak verification remains conservative without collapsing a quality plateau", () => {
  for (const strategy of ["direct", "stable", "planned"]) {
    const s = scenario("Change React layout", undefined, [], strategy);
    assert.equal(s.fingerprint.executionStrategy, strategy);
  }
  const s = scenario("Change React layout");
  s.fingerprint.verificationStrength = "weak";
  s.fingerprint.difficulty.contextUncertainty = "high";
  const dynamic = { ...cheap, configured: false };
  const result = route(s.fingerprint, s.features, [], [dynamic, strong]);
  assert.equal(result.cascade[0]?.model.id, cheap.model.id);
  assert.ok(result.selectedPlan!.qualityGap <= result.allowedRegret);
  assert.equal(
    result.considered.find((c) => c.model.id === cheap.model.id)?.confidence,
    "low",
  );
});

test("a 0.99 configured prior alone is weak evidence, while verified history tightens uncertainty", () => {
  const s = scenario("Fix backend endpoint", ["src/api.ts"]);
  const opusStyle = {
    ...strong,
    model: { ...strong.model, id: "arbitrary-opus-style", qualityPrior: 0.99 },
    evidence: [],
  };
  const cold = route(s.fingerprint, s.features, [], [opusStyle]).considered[0]!;
  assert.equal(cold.confidence, "low");
  assert.ok(cold.uncertainty >= 0.07);
  assert.ok(cold.conservativeQuality < 0.93);
  const successes = Array.from({ length: 30 }, () =>
    observed(opusStyle.model.id, s.fingerprint, s.features, "VERIFIED_SUCCESS"),
  );
  const warm = route(s.fingerprint, s.features, successes, [opusStyle])
    .considered[0]!;
  assert.equal(warm.confidence, "high");
  assert.ok(warm.uncertainty < cold.uncertainty);
  assert.ok(warm.conservativeQuality > cold.conservativeQuality);
});

test("cold start always builds a safe relative plan when every quality estimate is below the legacy floor", () => {
  const s = scenario(
    "Debug a multi-file request flow",
    ["src/api.ts", "src/state.ts"],
    [],
    "stable",
  );
  const compatible = (
    id: string,
    prior: number,
    price: number,
  ): SpecialistModel => ({
    model: modelSchema.parse({
      id,
      tier: prior > 0.6 ? "frontier" : "fast",
      qualityPrior: prior,
      latencyPriorMs: prior > 0.6 ? 5000 : 1000,
      strengths: ["coding", "tool_use", "reasoning", "repo_scale"],
    }),
    metadata: {
      available: true,
      inputPrice: price,
      outputPrice: price,
      contextLength: 100000,
      supportedParameters: ["tools", "tool_choice"],
    },
    vision: false,
    configured: false,
    evidence: [],
  });
  const economical = compatible("cold-economical", 0.55, 0.1);
  const safest = compatible("cold-safest", 0.7, 2);
  const result = route(s.fingerprint, s.features, [], [economical, safest]);
  assert.ok(
    result.considered.every(
      (candidate) => candidate.quality < settings.routing.minimumQuality,
    ),
  );
  assert.equal(result.reference?.model.id, safest.model.id);
  assert.ok(
    result.selectedPlan,
    "sparse quality evidence cannot terminate routing",
  );
  assert.ok(result.cascade.length > 0);
  assert.equal(result.selectedPlan!.qualityGap <= result.allowedRegret, true);
});

test("general pool falls back to the strongest compatible model when absolute quality evidence is sparse", async () => {
  const dir = await mkdtemp(join(tmpdir(), "koda-cold-pool-"));
  try {
    const low = modelSchema.parse({
      id: "low-prior",
      tier: "fast",
      qualityPrior: 0.4,
      latencyPriorMs: 500,
      strengths: ["coding", "tool_use"],
    });
    const safer = modelSchema.parse({
      id: "safe-prior",
      tier: "frontier",
      qualityPrior: 0.7,
      latencyPriorMs: 1000,
      strengths: ["coding", "tool_use"],
    });
    const cfg = await config(undefined, {
      baseUrl: "http://127.0.0.1:1",
      specialistRouting: false,
      routing: { stateDirectory: dir, minimumQuality: 0.95 },
      modelPool: { provider: "local-compatible", models: [low, safer] },
    });
    const pool = new PoolRouter(cfg, new Logger(dir, "cold-pool", true));
    (pool.catalog as any).get = async () =>
      new Map([
        [
          low.id,
          {
            available: true,
            inputPrice: 0.1,
            outputPrice: 0.1,
            contextLength: 100000,
            supportedParameters: ["tools"],
          },
        ],
        [
          safer.id,
          {
            available: true,
            inputPrice: 1,
            outputPrice: 1,
            contextLength: 100000,
            supportedParameters: ["tools"],
          },
        ],
      ]);
    const s = scenario("Fix backend request", ["src/api.ts"]);
    const selected = await pool.select(s.features, "cold");
    assert.equal(selected.model.id, safer.id);
    assert.equal(
      pool.logger.events.find((event) => event.type === "model_router")
        ?.routing_reason,
      "safe cold-start fallback: strongest technically compatible priced model",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cached capability evidence admits a newly listed priced model without code changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "koda-specialist-"));
  const raw = (id: string, prompt: string, completion: string) => ({
    id,
    pricing: { prompt, completion, request: "0" },
    context_length: 32000,
    supported_parameters: ["tools"],
    architecture: { input_modalities: ["text"] },
  });
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/models")
      response.end(
        JSON.stringify({
          data: [
            raw(cheap.model.id, "0.0000001", "0.0000002"),
            raw("newly-listed", "0.0000003", "0.0000004"),
          ],
        }),
      );
    else if (request.url === "/benchmarks")
      response.end(
        JSON.stringify({
          data: [
            {
              model_permaslug: "newly-listed",
              coding_index: 95,
              agentic_index: 90,
            },
          ],
        }),
      );
    else response.end(JSON.stringify({ data: { classifications: [] } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const config = {
      baseUrl,
      modelPool: { models: [cheap.model] },
      routing: { cacheTtlMs: 60000 },
    } as any;
    const catalog = new Catalog(baseUrl, dir, 60000, [cheap.model]);
    const registry = new CapabilityRegistry(config, catalog);
    const s = scenario("Fix backend endpoint", ["src/api.ts"]);
    await registry.refresh();
    const models = await registry.forTask(s.fingerprint);
    assert.equal(
      models.find((m) => m.model.id === "newly-listed")?.metadata.inputPrice,
      0.3,
    );
    assert.equal(
      models.find((m) => m.model.id === "newly-listed")?.metadata
        .routableParameterSets,
      undefined,
      "a local provider fixture may use its declared model-level protocol",
    );
    assert.ok((await catalog.get()).has("newly-listed"));
    assert.equal(
      models
        .find((m) => m.model.id === "newly-listed")
        ?.evidence.some((e) => e.source === "coding_benchmark"),
      true,
    );
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Artificial Analysis exact IDs seed cached priors and degrade to cache without fuzzy matching", async () => {
  const dir = await mkdtemp(join(tmpdir(), "koda-aa-prior-"));
  const priorKey = process.env.ARTIFICIAL_ANALYSIS_API_KEY;
  const priorUrl = process.env.KODA_ARTIFICIAL_ANALYSIS_URL;
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/aa")
      response.end(
        JSON.stringify({
          data: [
            {
              id: "aa-mapped",
              openrouter_api_id: "vendor/mapped",
              evaluations: {
                artificial_analysis_coding_index: 94,
                artificial_analysis_intelligence_index: 88,
              },
              median_output_tokens_per_second: 120,
              median_time_to_first_token_seconds: 0.8,
            },
            {
              id: "aa-unmapped",
              name: "Mapped",
              slug: "mapped",
              evaluations: { artificial_analysis_coding_index: 99 },
            },
          ],
        }),
      );
    else if (request.url === "/models")
      response.end(
        JSON.stringify({
          data: [
            {
              id: "vendor/mapped",
              context_length: 100000,
              pricing: { prompt: "0.0000002", completion: "0.0000004" },
              supported_parameters: ["tools"],
            },
          ],
        }),
      );
    else if (request.url === "/benchmarks")
      response.end(JSON.stringify({ data: [] }));
    else response.end(JSON.stringify({ data: { classifications: [] } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    process.env.ARTIFICIAL_ANALYSIS_API_KEY = "test-key";
    process.env.KODA_ARTIFICIAL_ANALYSIS_URL = `${baseUrl}/aa`;
    const configured = modelSchema.parse({
      id: "vendor/mapped",
      tier: "fast",
      qualityPrior: 0.5,
      latencyPriorMs: 1000,
      strengths: ["coding", "tool_use"],
    });
    const cfg = await config(undefined, {
      baseUrl,
      routing: { stateDirectory: dir },
      modelPool: { provider: "openrouter", models: [configured] },
    });
    const registry = new CapabilityRegistry(
      cfg,
      new Catalog(baseUrl, dir, 60000, [configured]),
    );
    const models = await registry.refresh();
    const mapped = models.find((item) => item.model.id === "vendor/mapped");
    assert.ok(
      mapped?.evidence.some(
        (item) =>
          item.source === "coding_benchmark" &&
          item.detail === "Artificial Analysis coding index" &&
          item.value === 0.94,
      ),
    );
    assert.equal(
      models.some(
        (item) => item.model.id === "aa-unmapped" || item.model.id === "mapped",
      ),
      false,
      "names and slugs never create fuzzy provider mappings",
    );
    const cache = JSON.parse(
      await readFile(join(dir, "artificial-analysis.json"), "utf8"),
    );
    assert.deepEqual(cache.unmatched, ["aa-unmapped"]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.env.KODA_ARTIFICIAL_ANALYSIS_URL = "http://127.0.0.1:1/unavailable";
    const cached = await new CapabilityRegistry(
      cfg,
      new Catalog(baseUrl, dir, 60000, [configured]),
    ).refresh();
    assert.ok(
      cached
        .find((item) => item.model.id === "vendor/mapped")
        ?.evidence.some(
          (item) => item.detail === "Artificial Analysis coding index",
        ),
    );
  } finally {
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    if (priorKey === undefined) delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;
    else process.env.ARTIFICIAL_ANALYSIS_API_KEY = priorKey;
    if (priorUrl === undefined) delete process.env.KODA_ARTIFICIAL_ANALYSIS_URL;
    else process.env.KODA_ARTIFICIAL_ANALYSIS_URL = priorUrl;
    await rm(dir, { recursive: true, force: true });
  }
});

test("parallel PLANNED coding subtasks choose independently and report reference parity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "koda-parallel-specialists-"));
  try {
    const logger = new Logger(dir, "mock-run", true);
    const pool = new PoolRouter(
      {
        ...settings,
        baseUrl: "http://127.0.0.1:1",
        modelPool: { models: [cheap.model, strong.model] },
        routing: { ...settings.routing, stateDirectory: dir },
      } as any,
      logger,
    );
    (pool.capabilities as any).forTask = async () => [cheap, strong];
    const easy = scenario(
      "Change React card spacing",
      undefined,
      [],
      "planned",
    );
    const hard = scenario(
      "Redesign React dashboard and migrate state architecture across modules and components",
      ["src/Dashboard.tsx", "src/state.ts", "api/state.ts"],
      [],
      "planned",
    );
    for (let i = 0; i < 12; i++)
      pool.history.record({
        ...observed(
          cheap.model.id,
          hard.fingerprint,
          hard.features,
          "FAILED",
          "focused test assertion",
        ),
        failureAttribution: "verified_patch_regression",
      });
    const [easyChoice, hardChoice] = await Promise.all([
      pool.selectSpecialist(easy.fingerprint, easy.features, "easy", 10),
      pool.selectSpecialist(hard.fingerprint, hard.features, "hard", 10),
    ]);
    assert.equal(easyChoice[0]?.model.id, cheap.model.id);
    assert.equal(hardChoice[0]?.model.id, strong.model.id);
    const routes = logger.events.filter((e) => e.type === "specialist_route");
    assert.equal(routes.length, 2);
    assert.equal(routes[1].reference_model, strong.model.id);
    assert.equal(typeof routes[0].candidates[0].quality_gap, "number");
    assert.equal(typeof routes[0].candidates[0].uncertainty, "number");
    for (const event of routes) {
      assert.equal(event.selected_model, event.selected_plan.models[0]);
      assert.equal(event.execution_engine, event.fingerprint.executionStrategy);
      assert.equal(event.selected_plan.executionEngine, event.execution_engine);
      assert.ok(Array.isArray(event.approved_recovery_candidates));
      assert.deepEqual(
        [event.selected_model, ...event.quality_recovery_candidates],
        event.selected_plan.models,
        "coding recovery must remain the optimizer-selected quality cascade",
      );
      assert.ok(event.operational_recovery_candidates.length <= 1);
      assert.equal(
        event.expected_standalone_success,
        Number(event.selected_plan.expectedStandaloneSuccess.toFixed(3)),
      );
      assert.equal(
        event.expected_final_success,
        Number(event.selected_plan.expectedFinalSuccess.toFixed(3)),
      );
      assert.equal(
        event.expected_completion_cost_usd,
        event.selected_plan.expectedCompletionCost,
      );
      assert.equal(
        event.expected_completion_latency_ms,
        event.selected_plan.expectedCompletionLatencyMs,
      );
      assert.equal(
        event.expected_completion_latency_p90_ms,
        event.selected_plan.completionLatencyP90Ms,
      );
      assert.equal(event.expected_completion_latency_p99_ms,
        event.selected_plan.completionLatencyP99Ms);
      assert.equal(event.expected_completion_cost_p90_usd,
        event.selected_plan.completionCostP90Usd);
      assert.equal(event.expected_completion_cost_p99_usd,
        event.selected_plan.completionCostP99Usd);
      assert.equal(event.risk_adjusted_cost_per_verified_solve,
        event.selected_plan.riskAdjustedCostPerVerifiedCompletion);
      assert.equal(event.deadline_miss_probability,
        event.selected_plan.deadlineMissProbability);
      assert.equal(event.quality_gap, event.selected_plan.qualityGap);
      assert.equal(typeof event.candidates[0].expected_total_tokens, "number");
      assert.ok(Array.isArray(event.candidates[0].knowledge_sources));
      assert.ok(
        event.plans.every((plan: any) => typeof plan.reason === "string"),
      );
    }
    const since = logger.events.length;
    logger.log("model_call", {
      subtaskId: "easy",
      modelRequested: cheap.model.id,
      modelReturned: cheap.model.id,
      wallClockMs: 900,
      promptTokens: 120,
      completionTokens: 30,
      costUsd: 0.001,
    });
    pool.record(
      cheap.model,
      easy.features,
      "easy",
      since,
      "VERIFIED_SUCCESS",
      false,
      undefined,
      easy.fingerprint,
    );
    const error = logger.events.find(
      (event) => event.type === "routing_prediction_error",
    );
    assert.equal(error.predicted_model, cheap.model.id);
    assert.equal(error.actual_input_tokens, 120);
    assert.equal(typeof error.token_error, "number");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("race reservations select complete plans without silently removing their rescue", async () => {
  const dir = await mkdtemp(join(tmpdir(), "koda-race-plans-"));
  try {
    const logger = new Logger(dir, "race-plans", true);
    const middle = {
      ...cheap,
      model: { ...cheap.model, id: "middle", qualityPrior: 0.94 },
      metadata: { ...cheap.metadata, inputPrice: 1, outputPrice: 2 },
    };
    const pool = new PoolRouter(
      {
        ...settings,
        baseUrl: "http://127.0.0.1:1",
        modelPool: { models: [cheap.model, middle.model, strong.model] },
        routing: { ...settings.routing, stateDirectory: dir },
      } as any,
      logger,
    );
    (pool.capabilities as any).forTask = async () => [cheap, middle, strong];
    const task = scenario(
      "Fix backend endpoint",
      ["src/api.ts"],
      ["node --test tests/api.test.ts"],
    );
    const choices = await Promise.all(
      ["first", "second"].map((id) =>
        pool.selectSpecialist(task.fingerprint, task.features, id, 10, "race"),
      ),
    );
    assert.notEqual(choices[0]![0]!.model.id, choices[1]![0]!.model.id);
    const routes = logger.events.filter(
      (event) => event.type === "specialist_route",
    );
    for (const [index, event] of routes.entries()) {
      assert.equal(event.selected_model, choices[index]![0]!.model.id);
      assert.deepEqual(
        new Set([event.selected_model, ...event.quality_recovery_candidates]),
        new Set(choices[index]!.map((candidate) => candidate.model.id)),
      );
      assert.ok(event.operational_recovery_candidates.length <= 1);
      assert.deepEqual(
        new Set(event.approved_recovery_candidates),
        new Set([
          ...event.quality_recovery_candidates,
          ...event.operational_recovery_candidates,
        ]),
        "the frozen policy exposes exactly one bounded operational peer in addition to its quality cascade",
      );
    }
    assert.equal(routes[0]!.reference_model, routes[1]!.reference_model);
    assert.ok(
      routes[1]!.plans.some(
        (plan: any) => plan.reason === "already reserved for race",
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Aider Stable plans accept text models without forced tool choice", () => {
  const task = scenario(
    "Fix backend endpoint",
    ["src/api.ts"],
    ["node --test tests/api.test.ts"],
    "stable",
  );
  const compatible = {
    ...strong,
    metadata: {
      ...strong.metadata,
      supportedParameters: ["tools", "tool_choice"],
    },
  };
  const toolsOnly = {
    ...cheap,
    metadata: {
      ...cheap.metadata,
      supportedParameters: ["tools"],
    },
  };
  for (const toolsRequired of [true, false]) {
    const result = route(
      { ...task.fingerprint, toolsRequired },
      task.features,
      [],
      [toolsOnly, compatible],
    );
    assert.equal(
      result.considered.find(
        (candidate) => candidate.model.id === toolsOnly.model.id,
      )?.rejected,
      undefined,
    );
    assert.deepEqual(result.selectedPlan?.models, [cheap.model.id, strong.model.id]);
  }
});

test("Aider accepts unknown metadata and models without tool support", () => {
  const stableTask = scenario(
    "Fix backend endpoint",
    ["src/api.ts"],
    ["node --test tests/api.test.ts"],
    "stable",
  );
  const unknown = {
    ...cheap,
    model: { ...cheap.model, id: "unknown-protocol" },
    metadata: {
      available: true,
      inputPrice: cheap.metadata.inputPrice,
      outputPrice: cheap.metadata.outputPrice,
      contextLength: cheap.metadata.contextLength,
    },
  };
  const toolsOnly = {
    ...cheap,
    model: { ...cheap.model, id: "tools-without-forced-choice" },
    metadata: { ...cheap.metadata, supportedParameters: ["tools"] },
  };
  const noTools = {
    ...cheap,
    model: { ...cheap.model, id: "explicitly-no-tools" },
    metadata: { ...cheap.metadata, supportedParameters: [] },
  };
  const result = route(
    stableTask.fingerprint,
    stableTask.features,
    [],
    [unknown, toolsOnly, noTools, strong],
  );
  assert.equal(result.considered.find((candidate) =>
    candidate.model.id === unknown.model.id)?.hardRejection, undefined);
  assert.equal(result.considered.find((candidate) =>
    candidate.model.id === toolsOnly.model.id)?.hardRejection,
  undefined);
  assert.equal(result.considered.find((candidate) =>
    candidate.model.id === noTools.model.id)?.hardRejection,
  undefined);
});

test("Aider localized PLANNED edits accept endpoints without forced tool choice", () => {
  const task = scenario(
    "Fix the isolated dashboard calculation",
    ["src/Dashboard.tsx"],
    ["node --test tests/dashboard.test.ts"],
    "planned",
  );
  const toolsOnly = {
    ...cheap,
    metadata: {
      ...cheap.metadata,
      supportedParameters: ["tools"],
      routableParameterSets: [["tools"]],
    },
  };
  const compatible = {
    ...strong,
    metadata: {
      ...strong.metadata,
      supportedParameters: ["tools", "tool_choice"],
      routableParameterSets: [["tools", "tool_choice"]],
    },
  };
  const result = route(task.fingerprint, task.features, [], [toolsOnly, compatible]);
  assert.equal(
    result.considered.find((candidate) => candidate.model.id === toolsOnly.model.id)?.rejected,
    undefined,
  );
  assert.deepEqual(result.selectedPlan?.models, [cheap.model.id, strong.model.id]);
});

test("legacy tool protocol failures do not establish Aider format incompatibility", () => {
  const task = scenario(
    "Fix the isolated dashboard calculation",
    ["src/Dashboard.tsx"],
    ["node --test tests/dashboard.test.ts"],
    "planned",
  );
  const compatibleCheap = {
    ...cheap,
    metadata: {
      ...cheap.metadata,
      supportedParameters: ["tools", "tool_choice"],
      routableParameterSets: [["tools", "tool_choice"]],
    },
  };
  const compatibleStrong = {
    ...strong,
    metadata: {
      ...strong.metadata,
      supportedParameters: ["tools", "tool_choice"],
      routableParameterSets: [["tools", "tool_choice"]],
    },
  };
  const failed: OperationalCall = {
    type: "operational_call",
    timestamp: new Date().toISOString(),
    runId: "protocol-run",
    subtaskId: "ui",
    stage: "implement",
    taskBucket: "debugging_single",
    modelRequested: compatibleCheap.model.id,
    modelServed: null,
    provider: "openrouter",
    wallClockMs: 50,
    outcome: "error",
    costUsd: null,
    classification: "OPERATIONAL_FAILURE",
    failureKind: "tool_protocol_incompatible",
  };
  const rejected = route(
    task.fingerprint,
    task.features,
    [],
    [compatibleCheap, compatibleStrong],
    [failed],
  );
  assert.equal(
    rejected.considered.find((candidate) =>
      candidate.model.id === compatibleCheap.model.id)?.rejected,
    undefined,
  );
  assert.deepEqual(rejected.selectedPlan?.models, [compatibleCheap.model.id, compatibleStrong.model.id]);

  const recovered = route(
    task.fingerprint,
    task.features,
    [],
    [compatibleCheap, compatibleStrong],
    [failed, { ...failed, outcome: "response", modelServed: compatibleCheap.model.id,
      costUsd: 0.001, failureKind: undefined }],
  );
  assert.equal(
    recovered.considered.find((candidate) =>
      candidate.model.id === compatibleCheap.model.id)?.rejected,
    undefined,
  );
});

test("Aider does not require an endpoint with a tool protocol", () => {
  const task = scenario(
    "Add a focused test",
    ["tests/api.test.ts"],
    ["node --test tests/api.test.ts"],
    "stable",
  );
  const splitEndpoints = {
    ...cheap,
    metadata: {
      ...cheap.metadata,
      supportedParameters: ["tools", "tool_choice"],
      routableParameterSets: [["tools"], ["tool_choice"]],
    },
  };
  const compatible = {
    ...strong,
    metadata: {
      ...strong.metadata,
      supportedParameters: ["tools", "tool_choice"],
      routableParameterSets: [["tools", "tool_choice"]],
    },
  };
  const result = route(
    task.fingerprint,
    task.features,
    [],
    [splitEndpoints, compatible],
  );
  assert.equal(
    result.considered.find(
      (candidate) => candidate.model.id === splitEndpoints.model.id,
    )?.rejected,
    undefined,
  );
  assert.deepEqual(result.selectedPlan?.models, [cheap.model.id, strong.model.id]);
});

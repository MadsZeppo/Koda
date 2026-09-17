import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { modelSchema, routingSchema } from "../src/router/pool.js";
import { Catalog } from "../src/openrouter/catalog.js";
import { CapabilityRegistry } from "../src/router/capabilityRegistry.js";
import { PoolRouter } from "../src/router/modelRouter.js";
import { Logger } from "../src/telemetry/logger.js";
import { optimizeSpecialists } from "../src/router/routeOptimizer.js";
import { taskFingerprint, type TaskFingerprint } from "../src/router/taskFingerprint.js";
import { extractFeatures } from "../src/router/features.js";
import type { SpecialistModel } from "../src/router/capabilityRegistry.js";
import type { Attempt } from "../src/router/history.js";

const profile = { files: ["src/Dashboard.tsx", "src/state.ts", "tests/dashboard.test.ts"], verificationCommands: ["pnpm test"] } as any;
const subtask = (objective: string, paths = ["src/Dashboard.tsx"], checks: string[] = []) => ({
  id: "ui", title: objective, objective, likelyReadPaths: paths, likelyWritePaths: paths,
  dependsOn: [], integrationContract: "", verificationCommands: checks,
  estimatedDifficulty: "normal" as const, parallelSafe: true,
});
const scenario = (objective: string, paths?: string[], checks?: string[], strategy = "direct") => {
  const task = subtask(objective, paths, checks);
  const features = extractFeatures(task, profile, 2000, undefined, strategy);
  return { features, fingerprint: taskFingerprint(task, profile, features, "normal") };
};
const cheap: SpecialistModel = {
  model: modelSchema.parse({ id: "older-any-provider", tier: "cheap", qualityPrior: 0.95,
    latencyPriorMs: 1000, strengths: ["coding", "tool_use", "frontend_ui", "backend"] }),
  metadata: { available: true, inputPrice: 0.1, outputPrice: 0.2, contextLength: 100000, supportedParameters: ["tools"] },
  vision: false, configured: true,
  evidence: [{ source: "design_benchmark", value: 1380, detail: "design" }],
};
const strong: SpecialistModel = {
  model: modelSchema.parse({ id: "another-provider", tier: "strong", qualityPrior: 0.965,
    latencyPriorMs: 6000, strengths: ["coding", "tool_use", "frontend_ui", "backend", "repo_scale"] }),
  metadata: { available: true, inputPrice: 8, outputPrice: 12, contextLength: 100000, supportedParameters: ["tools"] },
  vision: false, configured: true,
  evidence: [{ source: "design_benchmark", value: 1200, detail: "design" }],
};
const settings = { maxOutputTokens: 1000, routing: routingSchema.parse({ maxQualityRegret: 0.025, latencyWeight: 0.4 }) } as any;
const route = (fp: TaskFingerprint, features: ReturnType<typeof scenario>["features"],
  history: Attempt[] = [], models = [cheap, strong]) =>
  optimizeSpecialists(models, fp, features, history, settings, 10);
const observed = (model: string, fp: TaskFingerprint, features: ReturnType<typeof scenario>["features"],
  verification: string, reason?: string): Attempt => ({
  timestamp: "2026-01-01", runId: "r", subtaskId: "ui", modelRequested: model,
  modelServed: model, features, fingerprint: fp, verification, wallClockMs: 1000,
  inputTokens: 100, outputTokens: 100, costUsd: 0.01, escalated: verification !== "VERIFIED_SUCCESS", reason,
});

test("difficulty is multidimensional and changes UI choice from cheaper specialist to strong reference", () => {
  const simple = scenario("Change card spacing in React Dashboard.tsx");
  const complex = scenario("Redesign React dashboard, restructure state and connect new data flow across components",
    ["src/Dashboard.tsx", "src/state.ts"]);
  assert.equal(simple.fingerprint.primary, "frontend_ui");
  assert.equal(complex.fingerprint.primary, "frontend_ui");
  assert.equal(simple.fingerprint.difficulty.technicalComplexity, "low");
  assert.equal(complex.fingerprint.difficulty.technicalComplexity, "high");
  assert.equal(route(simple.fingerprint, simple.features).cascade[0]?.model.id, cheap.model.id);
  const hard = route(complex.fingerprint, complex.features);
  assert.equal(hard.reference?.model.id, strong.model.id);
  assert.equal(hard.cascade[0]?.model.id, strong.model.id);
  assert.equal(hard.considered.find((c) => c.model.id === cheap.model.id)?.qualityFloorPassed, false);
});

test("backend complexity, quality parity, unknown pricing and provider-independent IDs", () => {
  const simple = scenario("Add backend endpoint", ["src/api.ts"]);
  const complex = scenario("Debug backend endpoint across modules and migrate database schema",
    ["src/api.ts", "src/db.ts"]);
  assert.equal(route(simple.fingerprint, simple.features).cascade[0]?.model.id, cheap.model.id);
  assert.equal(route(complex.fingerprint, complex.features).cascade[0]?.model.id, strong.model.id);
  const unpriced = { ...cheap, metadata: { available: true } };
  assert.equal(route(simple.fingerprint, simple.features, [], [unpriced, strong]).cascade[0]?.model.id, strong.model.id);
});

test("strong focused verification can justify a cheaper first attempt; weak UI verification cannot", () => {
  assert.equal(scenario("Polish React layout", undefined, ["pnpm run typecheck"]).fingerprint.verificationStrength, "weak");
  const s = scenario("Change React layout", undefined, ["node --test tests/dashboard.test.ts"]);
  const lessCertainCheap = { ...cheap,
    model: { ...cheap.model, qualityPrior: 0.91 },
    evidence: [{ source: "design_benchmark" as const, value: 1200, detail: "design" }] };
  s.fingerprint.verificationStrength = "strong";
  const strongRoute = route(s.fingerprint, s.features, [], [lessCertainCheap, strong]);
  assert.equal(strongRoute.cascade[0]?.model.id, cheap.model.id);
  assert.ok(strongRoute.cascade[0]!.expectedCompletionCost < strongRoute.reference!.cost);
  s.fingerprint.verificationStrength = "weak";
  const weakRoute = route(s.fingerprint, s.features, [], [lessCertainCheap, strong]);
  assert.equal(weakRoute.cascade[0]?.model.id, strong.model.id);
  assert.equal(weakRoute.considered.find((c) => c.model.id === cheap.model.id)?.qualityFloorPassed, false);
});

test("task-specific verified history can overcome prior then verified failures reverse it; infra does not count", () => {
  const s = scenario("Change React card spacing");
  const success = Array.from({ length: 18 }, () => observed(cheap.model.id, s.fingerprint, s.features, "VERIFIED_SUCCESS"));
  assert.equal(route(s.fingerprint, s.features, success).reference?.model.id, cheap.model.id);
  const failed = Array.from({ length: 18 }, () => observed(cheap.model.id, s.fingerprint, s.features, "FAILED", "test assertion"));
  assert.equal(route(s.fingerprint, s.features, [...success, ...failed]).reference?.model.id, strong.model.id);
  const infra = Array.from({ length: 50 }, () => observed(cheap.model.id, s.fingerprint, s.features, "FAILED", "provider HTTP 520"));
  assert.equal(route(s.fingerprint, s.features, success.concat(infra)).reference?.model.id, cheap.model.id);
  const unrelated = scenario("Fix API", ["src/api.ts"]);
  assert.notEqual(route(unrelated.fingerprint, unrelated.features, failed).considered.find((c) => c.model.id === cheap.model.id)?.quality,
    route(unrelated.fingerprint, unrelated.features, []).considered.find((c) => c.model.id === cheap.model.id)?.quality);
});

test("high uncertainty blocks weakly verified cheap choice and execution strategies are retained", () => {
  for (const strategy of ["direct", "stable", "planned"]) {
    const s = scenario("Change React layout", undefined, [], strategy);
    assert.equal(s.fingerprint.executionStrategy, strategy);
  }
  const s = scenario("Change React layout");
  s.fingerprint.verificationStrength = "weak";
  s.fingerprint.difficulty.contextUncertainty = "high";
  const dynamic = { ...cheap, configured: false };
  const result = route(s.fingerprint, s.features, [], [dynamic, strong]);
  assert.equal(result.cascade[0]?.model.id, strong.model.id);
  assert.match(result.considered.find((c) => c.model.id === cheap.model.id)?.rejected ?? "", /uncertain|quality/);
});

test("a 0.99 configured prior alone is weak evidence, while verified history tightens uncertainty", () => {
  const s = scenario("Fix backend endpoint", ["src/api.ts"]);
  const opusStyle = { ...strong, model: { ...strong.model, id: "arbitrary-opus-style", qualityPrior: 0.99 }, evidence: [] };
  const cold = route(s.fingerprint, s.features, [], [opusStyle]).considered[0]!;
  assert.equal(cold.confidence, "low");
  assert.ok(cold.uncertainty >= 0.07);
  assert.ok(cold.conservativeQuality < 0.93);
  const successes = Array.from({ length: 30 }, () => observed(opusStyle.model.id, s.fingerprint, s.features, "VERIFIED_SUCCESS"));
  const warm = route(s.fingerprint, s.features, successes, [opusStyle]).considered[0]!;
  assert.equal(warm.confidence, "high");
  assert.ok(warm.uncertainty < cold.uncertainty);
  assert.ok(warm.conservativeQuality > cold.conservativeQuality);
});

test("cached capability evidence admits a newly listed priced model without code changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "koda-specialist-"));
  const raw = (id: string, prompt: string, completion: string) => ({
    id, pricing: { prompt, completion, request: "0" }, context_length: 32000,
    supported_parameters: ["tools"], architecture: { input_modalities: ["text"] },
  });
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/models") response.end(JSON.stringify({ data: [
      raw(cheap.model.id, "0.0000001", "0.0000002"), raw("newly-listed", "0.0000003", "0.0000004"),
    ] }));
    else if (request.url === "/benchmarks") response.end(JSON.stringify({ data: [
      { model_permaslug: "newly-listed", coding_index: 95, agentic_index: 90 },
    ] }));
    else response.end(JSON.stringify({ data: { classifications: [] } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const config = { baseUrl, modelPool: { models: [cheap.model] }, routing: { cacheTtlMs: 60000 } } as any;
    const catalog = new Catalog(baseUrl, dir, 60000, [cheap.model]);
    const registry = new CapabilityRegistry(config, catalog);
    const s = scenario("Fix backend endpoint", ["src/api.ts"]);
    const models = await registry.forTask(s.fingerprint);
    assert.equal(models.find((m) => m.model.id === "newly-listed")?.metadata.inputPrice, 0.3);
    assert.ok((await catalog.get()).has("newly-listed"));
    assert.equal(models.find((m) => m.model.id === "newly-listed")?.evidence.some((e) => e.source === "coding_benchmark"), true);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("parallel PLANNED coding subtasks choose independently and report reference parity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "koda-parallel-specialists-"));
  try {
    const logger = new Logger(dir, "mock-run", true);
    const pool = new PoolRouter({ ...settings, baseUrl: "http://127.0.0.1:1", modelPool: { models: [cheap.model, strong.model] },
      routing: { ...settings.routing, stateDirectory: dir } } as any, logger);
    (pool.capabilities as any).forTask = async () => [cheap, strong];
    const easy = scenario("Change React card spacing", undefined, [], "planned");
    const hard = scenario("Redesign React dashboard and migrate state architecture across modules and components",
      ["src/Dashboard.tsx", "src/state.ts", "api/state.ts"], [], "planned");
    for (let i = 0; i < 12; i++)
      pool.history.record(observed(cheap.model.id, hard.fingerprint, hard.features, "FAILED", "focused test assertion"));
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
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config } from "../src/config.js";
import { estimateQuality } from "../src/router/knowledge/estimator.js";
import { RoutingKnowledgeStore } from "../src/router/knowledge/store.js";
import type { ModelRoutingKnowledge, RoutingKnowledgeObservation, RoutingKnowledgeSnapshot } from "../src/router/knowledge/schema.js";
import type { SpecialistModel } from "../src/router/capabilityRegistry.js";
import { optimizeSpecialists } from "../src/router/routeOptimizer.js";
import { modelSchema, routingSchema } from "../src/router/pool.js";
import type { TaskFingerprint } from "../src/router/taskFingerprint.js";
import { extractFeatures } from "../src/router/features.js";
import type { OperationalCall } from "../src/router/history.js";

const fp = (strength: TaskFingerprint["verificationStrength"] = "weak"): TaskFingerprint => ({
  taskFamily: "localized_bugfix", primary: "debugging", secondary: ["testing"],
  languages: ["typescript"], frameworks: [], scope: "single", effort: "normal",
  executionStrategy: "direct", visualRelevant: false, browserRelevant: false,
  terminalHeavy: false, repoReasoningHeavy: false, architectureHeavy: false,
  toolsRequired: true, visionRequired: false, verificationStrength: strength,
  scopeUncertainty: "low", targetedExecutableVerification: strength !== "weak",
  focusedFailingReproduction: strength === "strong", broaderProjectVerification: true,
  difficulty: { technicalComplexity: "low", visualComplexity: "low", architecturalComplexity: "low",
    interactionComplexity: "low", repoReasoningComplexity: "low", changeRisk: "low", contextUncertainty: "low" },
  confidence: "high", reasons: [],
});
const features = extractFeatures({ id: "fix", title: "Fix value", objective: "Fix value",
  likelyReadPaths: ["src/value.ts", "tests/value.test.ts"], likelyWritePaths: ["src/value.ts"],
  dependsOn: [], integrationContract: "", verificationCommands: ["node --test tests/value.test.ts"],
  estimatedDifficulty: "normal", parallelSafe: true }, { files: ["src/value.ts", "tests/value.test.ts"] } as any,
2000, undefined, "direct");
const row = (id: string, metric: RoutingKnowledgeObservation["metric"], value: number,
  category: RoutingKnowledgeObservation["category"] = "efficiency"): RoutingKnowledgeObservation => ({
  id: `${id}-${metric}`, category, source: "deterministic-fixture", sourceDate: "2026-09-01",
  snapshotDate: "2026-09-01", displayModel: id, canonicalModelId: id, metric, value,
  unit: metric.includes("latency") ? "milliseconds" : metric.includes("tokens") ? "tokens" : "ratio",
  taskFamilies: ["localized_bugfix"], sampleSize: 100,
});
const knowledge = (id: string, observations: RoutingKnowledgeObservation[]): ModelRoutingKnowledge => ({
  snapshotId: "fixture-v1", observations: observations.filter((entry) => entry.canonicalModelId === id),
});
const model = (id: string, price: number, qualityPrior = .95,
  observations: RoutingKnowledgeObservation[] = []): SpecialistModel => ({
  model: modelSchema.parse({ id, tier: "fast", qualityPrior, latencyPriorMs: 1000, strengths: ["coding", "tool_use", "debugging"] }),
  metadata: { available: true, inputPrice: price, outputPrice: price, contextLength: 20_000_000,
    supportedParameters: ["tools"] }, configured: true, vision: false, evidence: [],
  knowledge: knowledge(id, observations),
});
const route = (models: SpecialistModel[], maxOutputTokens = 4096, operations: OperationalCall[] = []) =>
  optimizeSpecialists(models, fp(), features, [], { maxOutputTokens,
    routing: routingSchema.parse({ costWeight: 1, latencyWeight: 0 }) } as Config, 100, operations);

test("versioned knowledge uses explicit canonical IDs and leaves display-name-only public evidence unmapped", () => {
  const snapshot: RoutingKnowledgeSnapshot = { schemaVersion: 1, snapshotId: "mapping-v1", createdAt: "2026-09-01",
    observations: [row("mapped", "result_at_1", .8, "agentic_swe"),
      { ...row("different-id", "result_at_1", .99, "agentic_swe"), canonicalModelId: undefined, displayModel: "mapped" }] };
  const store = new RoutingKnowledgeStore(snapshot);
  assert.equal(store.forModel("mapped").observations.length, 1);
  assert.equal(store.unmapped().length, 1);
});

test("agentic benchmark evidence adjusts a task prior without becoming its literal success probability", () => {
  const observation = row("measured", "result_at_1", .42, "agentic_swe");
  const estimate = estimateQuality(.96, fp(), knowledge("measured", [observation]), []);
  assert.notEqual(estimate.estimatedSuccess, .42);
  assert.ok(estimate.conservativeSuccess < estimate.estimatedSuccess);
  assert.deepEqual(estimate.evidenceUsed, ["deterministic-fixture:measured-result_at_1"]);
});

test("agentically token-heavy cheap model can lose to a nominally costlier efficient model", () => {
  const rows = [row("cheap-heavy", "total_tokens", 8_000_000), row("efficient", "total_tokens", 100_000)];
  const result = route([model("cheap-heavy", .05, .96, rows), model("efficient", .5, .96, rows)]);
  assert.equal(result.selectedPlan?.models[0], "efficient");
  assert.ok(result.considered.find((entry) => entry.model.id === "cheap-heavy")!.expectedTotalTokens >
    result.considered.find((entry) => entry.model.id === "efficient")!.expectedTotalTokens);
});

test("sparse configured quality cannot beat a task-proven reference solely on price", () => {
  const provenRows = [row("proven", "result_at_1", .8, "agentic_swe")];
  const result = route([model("sparse-cheap", .00001, .99), model("proven", 2, .97, provenRows)]);
  assert.equal(result.reference?.model.id, "proven");
  assert.equal(result.selectedPlan?.models[0], "proven");
  assert.match(result.considered.find((entry) => entry.model.id === "sparse-cheap")?.rejected ?? "", /quality/);
});

test("maxOutputTokens changes reservation but not an unchanged expected-token forecast", () => {
  const low = route([model("bounded", 1)], 4096).considered[0]!;
  const high = route([model("bounded", 1)], 8192).considered[0]!;
  assert.equal(low.expectedOutputTokens, high.expectedOutputTokens);
  assert.equal(low.expectedAttemptCost, high.expectedAttemptCost);
  assert.ok(high.reservationCost > low.reservationCost);
});

test("long-tail p90 latency can demote an otherwise equivalent economical plan", () => {
  const calls = (id: string, values: number[]): OperationalCall[] => values.map((wallClockMs) => ({
    type: "operational_call", timestamp: "2026-09-01", runId: id, subtaskId: "fix", stage: "implement",
    taskBucket: "localized_bugfix", modelRequested: id, modelServed: id, provider: "fixture",
    wallClockMs, outcome: "response", costUsd: .01,
  }));
  const operations = [...calls("long-tail", [500, 500, 500, 500, 90_000, 90_000]),
    ...calls("stable", [1500, 1500, 1500, 1500, 1500, 1500])];
  const result = optimizeSpecialists([model("long-tail", .1), model("stable", .1)], fp(), features, [], {
    maxOutputTokens: 4096, routing: routingSchema.parse({ costWeight: 0, latencyWeight: 1 }),
  } as Config, 100, operations);
  assert.equal(result.selectedPlan?.models[0], "stable");
  assert.ok(result.considered.find((entry) => entry.model.id === "long-tail")!.latencyP90Ms! > 80_000);
});

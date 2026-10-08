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
import type { Attempt } from "../src/router/history.js";
import { estimateEfficiency } from "../src/router/knowledge/efficiency.js";

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
    supportedParameters: ["tools", "tool_choice"] }, configured: true, vision: false, evidence: [],
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

test("knowledge lookup indexes the snapshot once instead of rescanning it per routed model", () => {
  let iterations = 0;
  const source = Array.from({ length: 2_000 }, (_, index) => ({
    ...row(`vendor/claude-sonnet-${index}`, "result_at_1", .8, "agentic_swe"),
    canonicalModelId: `vendor/claude-sonnet-${index}`,
  }));
  const observations = new Proxy(source, {
    get(target, property, receiver) {
      if (property === Symbol.iterator) return function* () {
        iterations++;
        yield* target;
      };
      return Reflect.get(target, property, receiver);
    },
  });
  const store = new RoutingKnowledgeStore({ schemaVersion: 2,
    snapshotId: "indexed", createdAt: "2026-09-01", observations });
  const constructionIterations = iterations;
  for (let index = 0; index < 200; index++)
    store.forModel(`vendor/claude-sonnet-${index}`);
  assert.equal(iterations, constructionIterations,
    "routing model expansion must use the prebuilt family index");
  assert.equal(store.forModel("vendor/claude-sonnet-1"),
    store.forModel("vendor/claude-sonnet-1"), "model views are memoized");
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

test("agentic recovery latency does not make the same model's Aider route deadline-infeasible", () => {
  const calls = (provider: string, values: number[]): OperationalCall[] => values.map((wallClockMs) => ({
    type: "operational_call", timestamp: "2026-09-01", runId: provider, subtaskId: "fix",
    stage: "implement", taskBucket: "localized_bugfix", modelRequested: "recovered",
    modelServed: "recovered", provider, wallClockMs, outcome: "response", costUsd: .01,
  }));
  const operations = [
    ...calls("agentic", [180_000, 220_000, 260_000]),
    ...calls("aider", [4_000, 5_000, 6_000, 7_000, 120_000, 130_000]),
  ];
  const result = optimizeSpecialists([model("recovered", .1)], fp(), features, [], {
    maxOutputTokens: 4096,
    codingAttemptTimeoutMs: 90_000,
    modelTimeoutMs: { implementation: 90_000 },
    routing: routingSchema.parse({ costWeight: 0, latencyWeight: 1 }),
  } as Config, 100, operations);
  const candidate = result.considered[0]!;
  assert.equal(candidate.deadlineFeasible, true);
  assert.equal(candidate.hardRejection, undefined);
  assert.ok((candidate.latencyP50Ms ?? Infinity) < 90_000);
  assert.ok((candidate.latencyP90Ms ?? 0) > 90_000,
    "long-tail risk remains visible to plan scoring without becoming incompatibility");
});

test("Aider trajectory economics distinguish localized and broad tasks and learn limit overruns", () => {
  const direct = fp("strong");
  const agentic = { ...direct, executionStrategy: "stable", scope: "multi-file" as const,
    expectedFiles: 3, localizationConfidence: "high" as const };
  const directEstimate = estimateEfficiency(direct, 4_000, 8_192, undefined, []);
  const agenticPrior = estimateEfficiency(agentic, 4_000, 8_192, undefined, []);
  assert.ok(agenticPrior.expectedTotalTokens > directEstimate.expectedTotalTokens * 3);
  assert.ok(agenticPrior.p99TotalTokens > agenticPrior.p90TotalTokens);
  const overrun: Attempt = { timestamp: "2026-09-01", runId: "limit", subtaskId: "fix",
    modelRequested: "agentic", modelServed: "agentic", features,
    fingerprint: agentic, verification: "NOT_FULLY_VERIFIED", wallClockMs: 43_100,
    inputTokens: 20_000, outputTokens: 3_689, costUsd: .174645, escalated: false,
    terminationReason: "cost_limit", executionEngine: "aider",
    contextStrategy: "agentic" };
  const learned = estimateEfficiency(agentic, 4_000, 8_192, undefined, [overrun]);
  const wrongEngine = estimateEfficiency(direct, 4_000, 8_192, undefined, [overrun]);
  assert.equal(learned.expectedTotalTokens, 23_689);
  assert.ok(learned.p90TotalTokens >= learned.expectedTotalTokens);
  assert.ok(learned.p99TotalTokens >= learned.p90TotalTokens);
  assert.equal(wrongEngine.expectedTotalTokens, directEstimate.expectedTotalTokens,
    "broad Aider overruns cannot inflate localized Aider economics");
});

test("legacy DirectEdit usage cannot collapse a multi-turn agent token forecast", () => {
  const direct = fp("strong");
  const agentic = { ...direct, executionStrategy: "planned" as const,
    scope: "multi-file" as const, expectedFiles: 3,
    localizationConfidence: "high" as const };
  const legacyDirect: Attempt = {
    timestamp: "2026-09-01", runId: "legacy-direct", subtaskId: "fix-one",
    modelRequested: "economical", modelServed: "economical", features,
    fingerprint: direct, verification: "VERIFIED_SUCCESS", wallClockMs: 8_432,
    inputTokens: 1_405, outputTokens: 157, costUsd: .000095,
    escalated: false, turns: 1,
  };
  const prior = estimateEfficiency(agentic, 1_270, 8_192, undefined, []);
  const estimate = estimateEfficiency(agentic, 1_270, 8_192, undefined,
    [legacyDirect]);
  assert.deepEqual(estimate, prior,
    "an inferable legacy DirectEdit row is not current Aider efficiency evidence");
  assert.ok(estimate.p90TotalTokens > 10_000);
  const agenticFeatures = { ...features, executionStrategy: "planned",
    estimatedFiles: 3, implementationFiles: 3,
    likelyWritePaths: ["src/a.ts", "src/b.ts", "src/c.ts"] } as typeof features;
  const routed = optimizeSpecialists([model("economical", 1)], agentic,
    agenticFeatures, [], { maxOutputTokens: 8192,
      routing: routingSchema.parse({}) } as Config, 10, [], new Set(),
    [legacyDirect]);
  assert.ok(routed.considered[0]!.expectedTotalTokens > 10_000,
    "the production optimizer retains the agentic trajectory estimate");
});

test("stale public token quantiles cannot undercut a newer trajectory estimate", () => {
  const agentic = { ...fp("strong"), executionStrategy: "stable" as const,
    scope: "multi-file" as const, expectedFiles: 3,
    localizationConfidence: "high" as const };
  const observations = [
    { ...row("agentic", "total_tokens", 20_000), engine: "aider" as const },
    { ...row("agentic", "total_tokens_p90", 1_529), engine: "aider" as const },
    { ...row("agentic", "total_tokens_p99", 1_000), engine: "aider" as const },
  ];
  const estimate = estimateEfficiency(agentic, 4_000, 8_192,
    knowledge("agentic", observations), []);
  assert.equal(estimate.expectedTotalTokens, 20_000);
  assert.ok(estimate.p90TotalTokens >= estimate.expectedTotalTokens);
  assert.ok(estimate.p99TotalTokens >= estimate.p90TotalTokens);
});

test("agentic overruns transfer by engine and task region without becoming quality evidence", () => {
  const agenticFeatures = { ...features, executionStrategy: "planned",
    estimatedFiles: 3, implementationFiles: 3,
    likelyWritePaths: ["src/a.ts", "src/b.ts", "src/c.ts"] } as typeof features;
  const agentic = { ...fp("strong"), executionStrategy: "planned" as const,
    scope: "multi-file" as const, expectedFiles: 3,
    localizationConfidence: "high" as const };
  const overrun: Attempt = { timestamp: "2026-09-01", runId: "overrun",
    subtaskId: "flow", modelRequested: "agentic", modelServed: "agentic",
    features: agenticFeatures, fingerprint: agentic,
    verification: "NOT_FULLY_VERIFIED", wallClockMs: 43_100,
    inputTokens: 20_000, outputTokens: 3_689, costUsd: .174645,
    escalated: false, terminationReason: "cost_limit",
    executionEngine: "aider", contextStrategy: "agentic" };
  const result = optimizeSpecialists([model("agentic", 1)], agentic,
    agenticFeatures, [], { maxOutputTokens: 8192,
      routing: routingSchema.parse({}) } as Config, 10, [], new Set(), [overrun]);
  const candidate = result.considered[0]!;
  assert.equal(candidate.expectedTotalTokens, 23_689);
  assert.ok(candidate.tokenEfficiency.p90TotalTokens >= 23_689);
  assert.equal(candidate.localQualityEvidence, 0,
    "an efficiency overrun must not become semantic quality evidence");
});

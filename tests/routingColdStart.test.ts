import { test } from "node:test";
import assert from "node:assert/strict";

import type { Config } from "../src/config.js";
import { CODEROUTER_RESULTS_URL, CODEROUTER_TASKS_URL } from "../src/router/knowledge/bootstrap.js";
import { estimateQuality } from "../src/router/knowledge/estimator.js";
import { estimateLatency } from "../src/router/knowledge/efficiency.js";
import { contextualQuality } from "../src/router/knowledge/contextual.js";
import { modelFamilyKey, normalizeRoutingTaskFamily } from "../src/router/knowledge/identity.js";
import { RoutingKnowledgeStore } from "../src/router/knowledge/store.js";
import type { RoutingKnowledgeSnapshot } from "../src/router/knowledge/schema.js";
import type { EvidenceSourceInput } from "../src/router/knowledge/ingest.js";
import { validateColdStartPolicy } from "../src/router/knowledge/validation.js";
import type { SpecialistModel } from "../src/router/capabilityRegistry.js";
import { extractFeatures } from "../src/router/features.js";
import { modelSchema, routingSchema } from "../src/router/pool.js";
import { optimizeSpecialists } from "../src/router/routeOptimizer.js";
import type { TaskFingerprint } from "../src/router/taskFingerprint.js";

const lowRiskDirectFingerprint = (): TaskFingerprint => ({
  taskFamily: "localized_bugfix",
  primary: "debugging",
  secondary: ["testing"],
  languages: ["typescript"],
  frameworks: ["nodejs"],
  scope: "single",
  effort: "normal",
  executionStrategy: "direct",
  visualRelevant: false,
  browserRelevant: false,
  terminalHeavy: false,
  repoReasoningHeavy: false,
  architectureHeavy: false,
  toolsRequired: true,
  visionRequired: false,
  verificationStrength: "strong",
  targetedExecutableVerification: true,
  broaderProjectVerification: true,
  localizationConfidence: "high",
  expectedFiles: 1,
  difficulty: {
    technicalComplexity: "low",
    visualComplexity: "low",
    architecturalComplexity: "low",
    interactionComplexity: "low",
    repoReasoningComplexity: "low",
    changeRisk: "low",
    contextUncertainty: "low",
  },
  confidence: "high",
  routingTerms: ["discount", "round", "money"],
  reasons: [],
});

const features = extractFeatures({
  id: "fix",
  title: "Fix deterministic test helper",
  objective: "Fix deterministic test helper",
  likelyReadPaths: ["src/value.ts", "tests/value.test.ts"],
  likelyWritePaths: ["src/value.ts"],
  dependsOn: [],
  integrationContract: "",
  verificationCommands: ["pnpm exec tsx --test tests/value.test.ts"],
  estimatedDifficulty: "normal",
  parallelSafe: true,
}, {
  files: ["src/value.ts", "tests/value.test.ts"],
  verificationCommands: ["pnpm test"],
} as any, 2000, {
  checks: [{ command: "pnpm exec tsx --test tests/value.test.ts", outcome: "CHECK_PASS" }],
} as any, "direct");

const specialist = (id: string, price: number, qualityPrior: number, latencyPriorMs: number): SpecialistModel => ({
  model: modelSchema.parse({
    id,
    tier: price < 0.2 ? "cheap" : "fast",
    qualityPrior,
    latencyPriorMs,
    strengths: ["coding", "tool_use", "debugging"],
  }),
  metadata: {
    available: true,
    inputPrice: price,
    outputPrice: price,
    contextLength: 1_000_000,
    supportedParameters: ["tools", "tool_choice"],
  },
  configured: true,
  vision: false,
  evidence: [],
});

test("CodeRouter cold-start input uses probing data rather than the held-out ID test set", () => {
  assert.match(CODEROUTER_RESULTS_URL, /id_probing_results_long\.csv$/);
  assert.doesNotMatch(CODEROUTER_RESULTS_URL, /id_test_results_long\.csv$/);
  assert.match(CODEROUTER_TASKS_URL, /id_probing_tasks\.jsonl$/);
});

test("public model revisions transfer only inside a conservative model family", () => {
  assert.equal(modelFamilyKey("glm-5"), "glm-5");
  assert.equal(modelFamilyKey("z-ai/glm-5.3-flash"), "glm-5");
  assert.equal(modelFamilyKey("Qwen3-Max"), "qwen3");
  assert.equal(modelFamilyKey("qwen/qwen3-coder-next"), "qwen3");
  assert.notEqual(modelFamilyKey("glm-5"), modelFamilyKey("qwen/qwen3-coder-next"));
});

test("RoutingKnowledgeStore exposes UNKNOWN public rows as weak family transfer, never exact identity", () => {
  const snapshot: RoutingKnowledgeSnapshot = {
    schemaVersion: 2,
    snapshotId: "public-fixture",
    createdAt: "2026-09-01T00:00:00.000Z",
    observations: [{
      id: "glm-public",
      category: "agentic_swe",
      evidenceType: "paired_task_model",
      source: "coderouterbench-id-probing",
      sourceDate: "2026-06-22",
      snapshotDate: "2026-09-01",
      displayModel: "glm-5",
      externalModelName: "glm-5",
      identityLevel: "UNKNOWN",
      metric: "result_at_1",
      value: 0.78,
      unit: "ratio",
      taskFamilies: ["bug_fixing"],
      sampleSize: 80,
    }],
  };
  const store = new RoutingKnowledgeStore(snapshot);
  const transferred = store.forModel("z-ai/glm-5.3-flash").observations;
  assert.equal(transferred.length, 1);
  assert.equal(transferred[0]!.identityLevel, "FAMILY_TRANSFER");
  assert.equal(transferred[0]!.canonicalModelId, "z-ai/glm-5.3-flash");
  assert.equal(store.forModel("qwen/qwen3-coder-next").observations.length, 0);
});

test("public bug_fixing evidence is relevant to Koda localized_bugfix tasks", () => {
  assert.equal(normalizeRoutingTaskFamily("bug_fixing"), "debugging");
  assert.equal(normalizeRoutingTaskFamily("localized_bugfix"), "debugging");
  const snapshot: RoutingKnowledgeSnapshot = {
    schemaVersion: 2,
    snapshotId: "public-fixture",
    createdAt: "2026-09-01T00:00:00.000Z",
    observations: [{
      id: "glm-public",
      category: "agentic_swe",
      evidenceType: "paired_task_model",
      source: "coderouterbench-id-probing",
      sourceDate: "2026-06-22",
      snapshotDate: "2026-09-01",
      displayModel: "glm-5",
      externalModelName: "glm-5",
      identityLevel: "UNKNOWN",
      metric: "result_at_1",
      value: 0.80,
      unit: "ratio",
      taskFamilies: ["bug_fixing"],
      sampleSize: 100,
    }],
  };
  const knowledge = new RoutingKnowledgeStore(snapshot).forModel("z-ai/glm-5.3-flash");
  const estimate = estimateQuality(0.93, lowRiskDirectFingerprint(), knowledge, []);
  assert.ok(estimate.evidenceUsed.some((entry) => entry.includes("glm-public")));
  assert.equal(estimate.evidenceLevel, "PROMISING");
});

test("strongly verified low-risk DIRECT routing minimizes expected verified cost before latency", () => {
  const cheap = specialist("vendor/cheap", 0.05, 0.94, 7_000);
  const fast = specialist("vendor/fast", 0.50, 0.95, 500);
  const result = optimizeSpecialists(
    [cheap, fast],
    lowRiskDirectFingerprint(),
    features,
    [],
    {
      maxOutputTokens: 4096,
      routing: routingSchema.parse({ costWeight: 0, latencyWeight: 1 }),
    } as Config,
    1,
  );
  assert.equal(result.selectedPlan?.models[0], "vendor/cheap");
  assert.match(result.reason, /expected cost per verified completion first/);
});

const contextualSnapshot = (candidateFailures: number): RoutingKnowledgeSnapshot => ({
  schemaVersion: 2,
  snapshotId: `contextual-${candidateFailures}`,
  createdAt: "2026-09-01T00:00:00.000Z",
  observations: [
    { id: "cheap-success", category: "agentic_swe", source: "paired-probing",
      sourceDate: "2026-09-01", snapshotDate: "2026-09-01", displayModel: "cheap",
      canonicalModelId: "vendor/cheap", identityLevel: "EXACT", metric: "success_rate",
      value: .9, unit: "ratio", sampleSize: 96 },
    { id: "reference-success", category: "agentic_swe", source: "paired-probing",
      sourceDate: "2026-09-01", snapshotDate: "2026-09-01", displayModel: "reference",
      canonicalModelId: "vendor/reference", identityLevel: "EXACT", metric: "success_rate",
      value: .99, unit: "ratio", sampleSize: 96 },
    { id: "cheap-cost", category: "efficiency", source: "paired-probing",
      sourceDate: "2026-09-01", snapshotDate: "2026-09-01", displayModel: "cheap",
      canonicalModelId: "vendor/cheap", identityLevel: "EXACT", metric: "current_repriced_cost_usd",
      value: .01, unit: "usd", sampleSize: 96 },
    { id: "reference-cost", category: "efficiency", source: "paired-probing",
      sourceDate: "2026-09-01", snapshotDate: "2026-09-01", displayModel: "reference",
      canonicalModelId: "vendor/reference", identityLevel: "EXACT", metric: "current_repriced_cost_usd",
      value: 1, unit: "usd", sampleSize: 96 },
  ],
  validation: { sourceId: "heldout", evaluatedTasks: 96, selectedSuccessRate: 1,
    referenceSuccessRate: 1, observedRegret: 0, upperRegret95: .017,
    selectedCostUsd: 1, referenceCostUsd: 100, maxAllowedRegret: .02, passed: true },
  taskCases: Array.from({ length: 96 }, (_, index) => ({
    sourceId: "paired-probing",
    taskKey: `task-${index}`,
    taskFamily: "localized_bugfix",
    languages: ["typescript"],
    routingTerms: ["discount", "round", "money", `case${index}`],
    outcomes: [
      { modelId: "vendor/cheap", success: index >= candidateFailures, identityLevel: "EXACT" as const },
      { modelId: "vendor/reference", success: true, identityLevel: "EXACT" as const },
    ],
  })),
});

const holdout = (cheapFailures: number): EvidenceSourceInput => ({
  id: "heldout", type: "paired_task_model",
  tasks: Array.from({ length: 64 }, (_, index) => ({ taskKey: `heldout-${index}`,
    taskFamily: "localized_bugfix", languages: ["typescript"],
    routingTerms: ["discount", "round", "money", `heldout${index}`] })),
  records: Array.from({ length: 64 }, (_, index) => [
    { taskKey: `heldout-${index}`, taskFamily: "localized_bugfix",
      canonicalModelId: "vendor/cheap", identityLevel: "EXACT" as const,
      success: index >= cheapFailures, reportedCostUsd: .01 },
    { taskKey: `heldout-${index}`, taskFamily: "localized_bugfix",
      canonicalModelId: "vendor/reference", identityLevel: "EXACT" as const,
      success: true, reportedCostUsd: 1 },
  ]).flat(),
});

test("task-level paired evidence proves a cheap model is inside the frontier quality plateau", () => {
  const store = new RoutingKnowledgeStore(contextualSnapshot(0));
  const cheap = { ...specialist("vendor/cheap", 0.02, 0.82, 1_000),
    knowledge: store.forModel("vendor/cheap") };
  const reference = { ...specialist("vendor/reference", 2, 0.99, 2_000),
    knowledge: store.forModel("vendor/reference") };
  const result = optimizeSpecialists([cheap, reference], lowRiskDirectFingerprint(), features, [], {
    maxOutputTokens: 4096,
    routing: routingSchema.parse({ costWeight: 1, latencyWeight: 0, maxQualityRegret: .02 }),
  } as Config, 10);
  assert.equal(result.reference?.model.id, "vendor/reference");
  assert.equal(result.selectedPlan?.models[0], "vendor/cheap");
  assert.equal(result.selectedPlan?.qualityProof?.kind, "paired_task_regret");
  assert.ok(result.selectedPlan!.qualityProof!.upperRegret <= result.allowedRegret);
  assert.ok(result.considered.find((row) => row.model.id === "vendor/cheap")!.knowledgeSources
    .includes("paired-probing:task-neighborhood"));
});

test("a cheap model with material paired losses cannot buy its way through the quality gate", () => {
  const store = new RoutingKnowledgeStore(contextualSnapshot(30));
  const cheap = { ...specialist("vendor/cheap", 0.00001, 0.99, 500),
    knowledge: store.forModel("vendor/cheap") };
  const reference = { ...specialist("vendor/reference", 2, 0.99, 2_000),
    knowledge: store.forModel("vendor/reference") };
  const result = optimizeSpecialists([cheap, reference], lowRiskDirectFingerprint(), features, [], {
    maxOutputTokens: 4096,
    routing: routingSchema.parse({ costWeight: 1, latencyWeight: 0, maxQualityRegret: .02 }),
  } as Config, 10);
  assert.equal(result.selectedPlan?.models[0], "vendor/reference");
  const cheapPlan = result.plans.find((plan) => plan.models.length === 1 && plan.models[0] === "vendor/cheap")!;
  assert.equal(cheapPlan.eligible, false);
  assert.match(cheapPlan.reason, /quality parity/);
  assert.ok(cheapPlan.qualityProof!.upperRegret > result.allowedRegret);
});

test("held-out replay activates only a policy whose conservative regret remains inside the quality gate", () => {
  const passed = validateColdStartPolicy(contextualSnapshot(0), holdout(0), .03, 50);
  assert.equal(passed.passed, true);
  assert.equal(passed.evaluatedTasks, 64);
  assert.equal(passed.observedRegret, 0);
  assert.ok(passed.selectedCostUsd < passed.referenceCostUsd);

  const failed = validateColdStartPolicy(contextualSnapshot(0), holdout(20), .03, 50);
  assert.equal(failed.passed, false);
  assert.ok(failed.upperRegret95 > failed.maxAllowedRegret);
});



test("DIRECT one-call latency does not inherit whole-agent benchmark completion latency", () => {
  const knowledge = {
    snapshotId: "latency-fixture",
    observations: [{
      id: "agentic-latency", category: "efficiency", evidenceType: "aggregate",
      source: "swe-rebench", sourceDate: "2026-09-01", snapshotDate: "2026-09-01",
      canonicalModelId: "vendor/direct", identityLevel: "EXACT",
      metric: "completion_latency_p90_ms", value: 90_000, unit: "ms",
      taskFamilies: ["debugging"], sampleSize: 100,
    }],
    pairwiseEvidence: [],
  } as any;
  const estimate = estimateLatency(3_000, knowledge, lowRiskDirectFingerprint(), []);
  assert.equal(estimate.p50, 3_000);
  assert.equal(estimate.p90, 5_400);
});

test("task evidence is discounted across a different execution engine", () => {
  const taskCases = Array.from({ length: 40 }, (_, index) => [
    { sourceId: "direct-harness", harness: "direct-v1", engine: "direct-edit" as const,
      taskKey: `direct-${index}`, taskFamily: "localized_bugfix", languages: ["typescript"],
      routingTerms: ["discount", "round", "money"], evidenceQuality: 1,
      contaminationConfidence: 1, outcomes: [{ modelId: "vendor/model", success: true,
        identityLevel: "EXACT" as const }] },
    { sourceId: "agent-harness", harness: "agent-v1", engine: "mini-swe-agent" as const,
      taskKey: `agent-${index}`, taskFamily: "localized_bugfix", languages: ["typescript"],
      routingTerms: ["discount", "round", "money"], evidenceQuality: 1,
      contaminationConfidence: 1, outcomes: [{ modelId: "vendor/model", success: false,
        identityLevel: "EXACT" as const }] },
  ]).flat();
  const knowledge = { snapshotId: "engine-sensitive", observations: [], taskCases };
  const direct = contextualQuality("vendor/model", .5, lowRiskDirectFingerprint(), knowledge);
  const agentic = contextualQuality("vendor/model", .5, {
    ...lowRiskDirectFingerprint(), executionStrategy: "stable",
  }, knowledge);
  assert.ok(direct && agentic);
  assert.ok(direct.mean > agentic.mean);
  assert.equal(direct.sourceDiversity, 2);
});

test("DIRECT never selects a model whose predicted call latency exceeds its hard request deadline when a viable alternative exists", () => {
  const slowCheap = specialist("vendor/slow-cheap", 0.01, 0.95, 45_000);
  const fast = specialist("vendor/fast-enough", 0.25, 0.95, 2_000);
  const result = optimizeSpecialists(
    [slowCheap, fast],
    lowRiskDirectFingerprint(),
    features,
    [],
    {
      maxOutputTokens: 4096,
      codingAttemptTimeoutMs: 45_000,
      modelTimeoutMs: { implementation: 30_000 },
      routing: routingSchema.parse({ costWeight: 1, latencyWeight: 0 }),
    } as Config,
    1,
  );
  assert.equal(result.selectedPlan?.models[0], "vendor/fast-enough");
  const slow = result.considered.find((candidate) => candidate.model.id === "vendor/slow-cheap")!;
  assert.equal(slow.deadlineFeasible, false);
  assert.equal(slow.hardRejection, "predicted model latency exceeds implementation request deadline");
});

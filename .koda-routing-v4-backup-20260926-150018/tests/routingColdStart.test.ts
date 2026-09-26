import { test } from "node:test";
import assert from "node:assert/strict";

import type { Config } from "../src/config.js";
import { CODEROUTER_RESULTS_URL } from "../src/router/knowledge/bootstrap.js";
import { estimateQuality } from "../src/router/knowledge/estimator.js";
import { modelFamilyKey, normalizeRoutingTaskFamily } from "../src/router/knowledge/identity.js";
import { RoutingKnowledgeStore } from "../src/router/knowledge/store.js";
import type { RoutingKnowledgeSnapshot } from "../src/router/knowledge/schema.js";
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
    supportedParameters: ["tools"],
  },
  configured: true,
  vision: false,
  evidence: [],
});

test("CodeRouter cold-start input uses probing data rather than the held-out ID test set", () => {
  assert.match(CODEROUTER_RESULTS_URL, /id_probing_results_long\.csv$/);
  assert.doesNotMatch(CODEROUTER_RESULTS_URL, /id_test_results_long\.csv$/);
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

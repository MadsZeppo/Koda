import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config } from "../src/config.js";
import type { SpecialistModel } from "../src/router/capabilityRegistry.js";
import { extractFeatures, taskBucket } from "../src/router/features.js";
import type { Attempt, OperationalCall } from "../src/router/history.js";
import { modelSchema, routingSchema } from "../src/router/pool.js";
import { optimizeSpecialists } from "../src/router/routeOptimizer.js";
import type { TaskFingerprint } from "../src/router/taskFingerprint.js";
import type { RepoProfile } from "../src/types.js";

const features = extractFeatures({
  id: "change", title: "Implement a bounded change", objective: "Implement a bounded change",
  likelyReadPaths: ["src/value.ts"], likelyWritePaths: ["src/value.ts"],
  dependsOn: [], integrationContract: "", verificationCommands: ["node --test tests/value.test.ts"],
  estimatedDifficulty: "normal", parallelSafe: true,
}, { files: ["src/value.ts", "tests/value.test.ts"] } as RepoProfile, 2000, undefined, "direct");

const fingerprint = (verificationStrength: TaskFingerprint["verificationStrength"] = "strong"): TaskFingerprint => ({
  primary: "implementation", secondary: [], languages: ["typescript"], frameworks: [],
  scope: "single", effort: "normal", executionStrategy: "direct",
  visualRelevant: false, browserRelevant: false, terminalHeavy: false,
  repoReasoningHeavy: false, architectureHeavy: false, toolsRequired: true, visionRequired: false,
  verificationStrength, confidence: "high", reasons: [],
  difficulty: { technicalComplexity: "low", visualComplexity: "low", architecturalComplexity: "low",
    interactionComplexity: "low", repoReasoningComplexity: "low", changeRisk: "low", contextUncertainty: "low" },
});

const model = (id: string, qualityPrior: number, price: number, latencyPriorMs = 1000): SpecialistModel => ({
  model: modelSchema.parse({ id, tier: "fast", qualityPrior, latencyPriorMs, strengths: ["coding", "tool_use"] }),
  metadata: { available: true, inputPrice: price, outputPrice: price, contextLength: 100000, supportedParameters: ["tools"] },
  configured: true, evidence: [], vision: false,
});
const efficient = () => model("efficient", 0.8, 0.1);
const reference = () => model("reference", 0.99, 10, 6000);
const route = (models: SpecialistModel[], fp = fingerprint(), history: Attempt[] = [],
  operations: OperationalCall[] = [], settings: Parameters<typeof routingSchema.parse>[0] = {}) =>
  optimizeSpecialists(models, fp, features, history, {
    maxOutputTokens: 1000, routing: routingSchema.parse(settings),
  } as Config, 10, operations);
const plan = (result: ReturnType<typeof route>, ...ids: string[]) => {
  const found = result.plans.find((candidate) => candidate.models.join("\0") === ids.join("\0"));
  assert.ok(found, `Expected an evaluated plan for ${ids.join(" -> ")}`);
  return found;
};
const observation = (id: string, fp = fingerprint(), overrides: Partial<Attempt> = {}): Attempt => ({
  timestamp: "2026-01-01T00:00:00Z", runId: "observed-run", subtaskId: "change",
  modelRequested: id, modelServed: id, features, fingerprint: fp, verification: "VERIFIED_SUCCESS",
  wallClockMs: 1000, inputTokens: 100, outputTokens: 100, costUsd: 0.01, escalated: false,
  ...overrides,
});

test("verified rescue makes an economical first attempt competitive with reference-first", () => {
  const result = route([efficient(), reference()]);
  const cascade = plan(result, "efficient", "reference");
  const standalone = plan(result, "efficient");
  const referenceFirst = plan(result, "reference");
  assert.deepEqual(result.selectedPlan?.models, ["efficient", "reference"]);
  assert.deepEqual(result.cascade.map((candidate) => candidate.model.id), result.selectedPlan.models);
  assert.equal(result.reference?.model.id, "reference");
  assert.equal(cascade.eligible, true);
  assert.equal(standalone.eligible, false, "standalone quality alone does not justify the economical first attempt");
  assert.ok(cascade.expectedFinalSuccess > cascade.expectedStandaloneSuccess);
  assert.ok(cascade.expectedFinalSuccess <= referenceFirst.expectedFinalSuccess,
    "rescue does not assume independent model successes");
  assert.ok(cascade.qualityGap <= result.allowedRegret);
  assert.ok(cascade.expectedCompletionCost < referenceFirst.expectedCompletionCost);
  assert.ok(cascade.expectedCompletionLatencyMs < referenceFirst.expectedCompletionLatencyMs);
  assert.ok(cascade.costPerVerifiedCompletion < referenceFirst.costPerVerifiedCompletion);
  assert.ok(cascade.expectedCompletionCost > result.cascade[0]!.cost, "economics include possible rescue cost");
  assert.ok(cascade.escalationProbability > 0 && cascade.escalationProbability < 1);
  assert.ok(cascade.reason.length > 0);
});

test("material final quality loss rejects a cheap plan despite its lower completion cost", () => {
  const result = route([model("efficient", 0.6, 0.00001), reference()], fingerprint("weak"), [], [],
    { minimumQuality: 0.75 });
  const cheapPlan = plan(result, "efficient", "reference");
  assert.ok(cheapPlan.expectedCompletionCost < result.referencePlan!.expectedCompletionCost);
  assert.ok(cheapPlan.qualityGap > result.allowedRegret);
  assert.equal(cheapPlan.eligible, false);
  assert.match(cheapPlan.reason, /quality|regret/i);
  assert.equal(result.selectedPlan?.models[0], "reference");
});

test("weak verification preserves a quality plateau for equally uncertain configured models", () => {
  const models = [model("efficient", 0.98, 0.1), reference(), model("middle", 0.985, 5, 3000)];
  const result = route(models, fingerprint("weak"));
  assert.equal(result.reference?.model.id, "reference");
  assert.equal(result.considered.length, models.length);
  assert.ok(result.considered.every((candidate) => candidate.confidence === "low"));
  assert.ok(result.considered.every((candidate) => candidate.uncertainty === result.reference!.uncertainty));
  assert.ok(result.considered.every((candidate) => candidate.rejected === undefined),
    "unknown quality evidence is not technical incompatibility");
  assert.equal(result.selectedPlan?.models[0], "efficient");
  assert.ok(result.selectedPlan!.qualityGap <= result.allowedRegret);
  assert.ok(result.selectedPlan!.costPerVerifiedCompletion < result.referencePlan!.costPerVerifiedCompletion);
});

test("high-risk cross-component changes can require a strong initial attempt", () => {
  const fp = fingerprint();
  fp.scope = "cross-component";
  fp.architectureHeavy = true;
  fp.repoReasoningHeavy = true;
  fp.difficulty = { ...fp.difficulty, technicalComplexity: "high", architecturalComplexity: "high",
    repoReasoningComplexity: "high", changeRisk: "high" };
  const capable = reference();
  capable.model.strengths.push("architecture", "repo_scale");
  const economical = model("efficient", 0.975, 0.01);
  economical.model.strengths.push("architecture", "repo_scale");
  assert.equal(route([economical, capable]).selectedPlan?.models[0], "efficient");
  const result = route([economical, capable], fp);
  assert.equal(result.selectedPlan?.models[0], "reference");
  assert.equal(result.cascade[0]?.model.id, "reference");
  const cheap = result.considered.find((candidate) => candidate.model.id === "efficient")!;
  assert.ok(cheap.quality >= cheap.firstAttemptQualityFloor, "the basic quality floor alone is insufficient for this risk");
  assert.match(cheap.rejected ?? "", /high-risk/i);
});

test("technical incompatibility remains a hard rejection for every execution plan", () => {
  const noTools = model("no-tools", 1, 0.00001);
  noTools.metadata.supportedParameters = [];
  const shortContext = model("short-context", 1, 0.00001);
  shortContext.metadata.contextLength = 100;
  const noVision = model("no-vision", 1, 0.00001);
  const unavailable = model("unavailable", 1, 0.00001);
  unavailable.metadata.available = false;
  const disabled = model("disabled", 1, 0.00001);
  disabled.model.enabled = false;
  const capable = reference();
  capable.vision = true;
  const fp = { ...fingerprint(), visionRequired: true };
  const result = route([noTools, shortContext, noVision, unavailable, disabled, capable], fp);
  assert.equal(result.considered.length, 6);
  for (const [id, reason] of [["no-tools", "tools unsupported"], ["short-context", "context limit"],
    ["no-vision", "vision unsupported"], ["unavailable", "unavailable"], ["disabled", "disabled"]]) {
    assert.equal(result.considered.find((candidate) => candidate.model.id === id)?.rejected, reason);
    assert.ok(result.plans.every((candidate) => !candidate.eligible || !candidate.models.includes(id!)));
  }
  assert.equal(result.selectedPlan?.models[0], "reference");
});

test("provider and verification infrastructure evidence never lowers coding quality", () => {
  const models = [model("efficient", 0.98, 0.1), reference()];
  const prior = route(models);
  const reasons = ["provider timeout", "HTTP 429", "HTTP 503", "sandbox unavailable", "dependencies_not_available",
    "environment_provisioning_not_allowed", "verification infrastructure unavailable"];
  const history = reasons.map((reason) => observation("efficient", fingerprint(), {
    verification: "FAILED", reason, failureAttribution: "verified_patch_regression",
  }));
  const operations: OperationalCall[] = reasons.map((_, index) => ({
    type: "operational_call", timestamp: "2026-01-01T00:00:00Z", runId: `operational-${index}`,
    subtaskId: "change", stage: "implement", taskBucket: taskBucket(features),
    modelRequested: "efficient", modelServed: "efficient", provider: "provider", wallClockMs: 12000,
    outcome: "error", costUsd: 0,
  }));
  const result = route(models, fingerprint(), history, operations);
  const before = prior.considered.find((candidate) => candidate.model.id === "efficient")!;
  const after = result.considered.find((candidate) => candidate.model.id === "efficient")!;
  assert.equal(after.quality, before.quality);
  assert.equal(after.uncertainty, before.uncertainty);
  assert.ok(after.operationalErrorRate > 0, "operational evidence is retained separately");
  assert.ok(after.latency > before.latency);
  assert.equal(after.evidence.filter((evidence) => evidence.source === "verified_history").length, 0);
});

test("matching verified outcomes improve task-local success estimates and confidence", () => {
  const models = [efficient(), reference()];
  const prior = route(models).considered.find((candidate) => candidate.model.id === "efficient")!;
  const history = Array.from({ length: 12 }, (_, index) => observation("efficient", fingerprint(), { runId: `success-${index}` }));
  const learned = route(models, fingerprint(), history).considered.find((candidate) => candidate.model.id === "efficient")!;
  const unrelated = history.map((row) => ({ ...row, features: { ...features, likelyWritePaths: ["other/module.ts"] } }));
  const distant = route(models, fingerprint(), unrelated).considered.find((candidate) => candidate.model.id === "efficient")!;
  assert.ok(learned.quality > prior.quality);
  assert.ok(learned.quality > distant.quality, "matched task outcomes receive more weight");
  assert.ok(learned.uncertainty < prior.uncertainty);
  assert.equal(learned.confidence, "high");
});

test("attributable coding regressions reduce estimates and cannot be bought off by a lower price", () => {
  const fp = fingerprint("weak");
  const models = [model("efficient", 0.98, 0.000001), reference()];
  const before = route(models, fp);
  assert.equal(before.selectedPlan?.models[0], "efficient");
  const history = Array.from({ length: 24 }, (_, index) => observation("efficient", fp, {
    runId: `regression-${index}`, verification: "FAILED", reason: "new test assertion failure",
    failureAttribution: "verified_patch_regression",
  }));
  const after = route(models, fp, history);
  assert.ok(after.considered.find((candidate) => candidate.model.id === "efficient")!.quality <
    before.considered.find((candidate) => candidate.model.id === "efficient")!.quality);
  assert.equal(after.selectedPlan?.models[0], "reference");
});

test("reference outcome is inferred from task-local quality rather than model name or tier", () => {
  const highAbility = model("economical-generalist", 0.99, 1);
  highAbility.model.tier = "cheap";
  const branded = model("frontier", 0.8, 20, 10000);
  branded.model.tier = "frontier";
  const result = route([branded, highAbility]);
  assert.equal(result.reference?.model.id, "economical-generalist");
  assert.deepEqual(result.referencePlan?.models, ["economical-generalist"]);
  assert.equal(result.selectedPlan?.models[0], "economical-generalist");
});

test("a finite budget neither lowers the reference outcome nor credits an unaffordable rescue", () => {
  const models = [efficient(), reference()];
  const unrestricted = route(models);
  const referenceCost = unrestricted.reference!.cost;
  const initialCost = unrestricted.considered.find((candidate) => candidate.model.id === "efficient")!.cost;
  const settings = { maxOutputTokens: 1000, routing: routingSchema.parse({}) } as Config;
  const belowReference = optimizeSpecialists(models, fingerprint(), features, [], settings,
    (initialCost + referenceCost) / 2);
  assert.equal(belowReference.reference?.model.id, unrestricted.reference!.model.id);
  assert.equal(belowReference.reference?.quality, unrestricted.reference!.quality);
  assert.equal(belowReference.selectedPlan, undefined,
    "running out of budget cannot make the materially weaker standalone model acceptable");
  assert.deepEqual(belowReference.cascade, []);

  const onlyReferenceFits = optimizeSpecialists(models, fingerprint(), features, [], settings,
    referenceCost + initialCost / 2);
  const rescue = plan(onlyReferenceFits, "efficient", "reference");
  assert.ok(rescue.expectedCompletionCost < referenceCost,
    "an affordable average cost does not guarantee sufficient funds for a required rescue");
  assert.equal(rescue.eligible, false);
  assert.match(rescue.reason, /budget/i);
  assert.deepEqual(onlyReferenceFits.selectedPlan?.models, ["reference"]);
});

test("cost and latency weights choose different winners only within the quality plateau", () => {
  const models = [model("economical-slower", 0.98, 0.01, 10000), model("costlier-fast", 0.98, 10, 100),
    model("cheap-fast-but-weaker", 0.6, 0.000001, 1)];
  const costFirst = route(models, fingerprint("weak"), [], [],
    { minimumQuality: 0.75, costWeight: 1, latencyWeight: 0 });
  const latencyFirst = route(models, fingerprint("weak"), [], [],
    { minimumQuality: 0.75, costWeight: 0, latencyWeight: 1 });
  assert.deepEqual(costFirst.selectedPlan?.models, ["economical-slower"]);
  assert.deepEqual(latencyFirst.selectedPlan?.models, ["costlier-fast"]);
  assert.equal(costFirst.selectedPlan!.expectedFinalSuccess, latencyFirst.selectedPlan!.expectedFinalSuccess);
  assert.ok(costFirst.selectedPlan!.expectedCompletionCost < latencyFirst.selectedPlan!.expectedCompletionCost);
  assert.ok(latencyFirst.selectedPlan!.expectedCompletionLatencyMs < costFirst.selectedPlan!.expectedCompletionLatencyMs);
  for (const result of [costFirst, latencyFirst]) {
    assert.ok(result.selectedPlan!.qualityGap <= result.allowedRegret);
    const weakerPlans = result.plans.filter((candidate) => candidate.models[0] === "cheap-fast-but-weaker");
    assert.ok(weakerPlans.length > 0);
    assert.ok(weakerPlans.every((candidate) => !candidate.eligible && candidate.qualityGap > result.allowedRegret));
  }
});

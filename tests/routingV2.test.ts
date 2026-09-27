import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTaskResume, profileTask, researchBudgetUsd } from "../src/router/taskProfiler.js";
import { estimateDagEconomics } from "../src/router/planEconomics.js";
import { chooseExecutionStrategy } from "../src/router/executionStrategy.js";
import { config } from "../src/config.js";
import { modelSchema } from "../src/router/pool.js";
import { PoolRouter } from "../src/router/modelRouter.js";
import { Logger } from "../src/telemetry/logger.js";
import { extractFeatures } from "../src/router/features.js";
import { taskFingerprint } from "../src/router/taskFingerprint.js";
import { requiredQualityClass } from "../src/router/controlPolicy.js";

const repository = {
  root: "/repo", commit: "abc", status: "", diff: "",
  files: ["src/math.ts", "src/api.ts", "tests/math.test.ts", "package.json"],
  topLevel: ["src", "tests", "package.json"], extensions: { ".ts": 3 },
  symbols: ["src/math.ts:1: export function add"], packageManager: "pnpm",
  scripts: { test: "node --test" }, configs: {}, verificationCommands: ["pnpm test"],
  ecosystem: { ecosystem: "javascript", languages: ["typescript"], frameworks: [],
    monorepo: false, projectRoot: ".", projectUnits: [], configFiles: [], evidence: [], ambiguities: [] },
} as any;

test("high-confidence deterministic profiling spends zero routing-model tokens", async () => {
  const task = "Fix src/math.ts and run tests/math.test.ts";
  const strategy = chooseExecutionStrategy(task, repository);
  let calls = 0;
  const resume = await buildTaskResume(task, repository, strategy,
    { globalBudgetUsd: 0.3, absoluteCapUsd: 0.002, fraction: 0.03 }, async () => {
      calls++; return undefined;
    });
  assert.equal(resume.profile.scopeConfidence, "high");
  assert.equal(calls, 0);
  assert.equal(resume.researchCalls, 0);
  assert.equal(resume.researchCostUsd, 0);
  assert.equal(resume.researchTokens, 0);
});

test("ambiguous profiling permits one bounded read-only scout and rejects invented paths", async () => {
  let calls = 0;
  const resume = await buildTaskResume("Correct the inconsistent behavior", repository,
    { execution_strategy: "stable", execution_effort: "normal", strategy_reason: "ambiguous", likelyFiles: [] },
    { globalBudgetUsd: 0.03, absoluteCapUsd: 0.002, fraction: 0.03 }, async (_profile, cap) => {
      calls++;
      assert.equal(cap, 0.0009);
      return { costUsd: 0.0004, tokens: 90, result: {
        paths: ["src/api.ts", "invented/missing.ts"], symbols: ["handle"],
        evidence: ["src/api.ts contains the handler"],
      } };
    });
  assert.equal(calls, 1);
  assert.equal(resume.microScoutUsed, true);
  assert.deepEqual(resume.scout?.paths, ["src/api.ts"]);
  // The resume is shared data; consuming it for multiple DAG nodes cannot
  // trigger the task-level scout again.
  assert.equal([resume, resume, resume].filter((item) => item.microScoutUsed).length, 3);
  assert.equal(calls, 1);
});

test("research cap skips scouting when no budget is available", async () => {
  let calls = 0;
  const resume = await buildTaskResume("Correct the inconsistent behavior", repository,
    { execution_strategy: "stable", execution_effort: "normal", strategy_reason: "ambiguous", likelyFiles: [] },
    { globalBudgetUsd: 0.01, absoluteCapUsd: 0, fraction: 0.03 }, async () => {
      calls++; return undefined;
    });
  assert.equal(researchBudgetUsd(0.3, 0.002, 0.03), 0.002);
  assert.equal(calls, 0);
  assert.equal(resume.microScoutUsed, false);
});

test("fingerprint V2 captures repository-backed risk dimensions", () => {
  const task = "Change the public API schema and synchronize concurrent callers in src/api.ts";
  const strategy = chooseExecutionStrategy(task, repository);
  const profile = profileTask(task, repository, strategy);
  assert.equal(profile.publicApiRisk, true);
  assert.equal(profile.schemaRisk, true);
  assert.equal(profile.concurrencyRisk, true);
  assert.ok(profile.evidence.some((item) => item.includes("src/api.ts")));
});

test("canonical repo profile is stable across materially different task wording", () => {
  const terse = "Fix src/math.ts; verify tests/math.test.ts";
  const verbose = "The arithmetic behavior is surprising. Please investigate the implementation in src/math.ts and prove the correction with tests/math.test.ts.";
  const strategy = chooseExecutionStrategy(terse, repository);
  const left = profileTask(terse, repository, strategy);
  const right = profileTask(verbose, repository, strategy);
  assert.equal(left.profileKey, right.profileKey);
  assert.deepEqual(left.likelyPaths, right.likelyPaths);
  assert.equal(left.localizationEntropy, "low");
  assert.equal(left.expectedBlastRadius, "package");
});

test("localized multi-file transaction evidence stays semantically bounded across paraphrases", () => {
  const repo = { ...repository,
    files: ["src/checkout.ts", "src/inventory.ts", "src/payment.ts", "tests/checkout.test.ts", "package.json"] };
  const make = (objective: string) => {
    const subtask = { id: "transaction", title: objective, objective,
      likelyReadPaths: ["src/checkout.ts", "src/inventory.ts", "src/payment.ts", "tests/checkout.test.ts"],
      likelyWritePaths: ["src/checkout.ts", "src/inventory.ts", "src/payment.ts"],
      dependsOn: [], integrationContract: "preserve public APIs",
      verificationCommands: ["node --test tests/checkout.test.ts"],
      estimatedDifficulty: "normal" as const, parallelSafe: false };
    const verification = { checks: [{ command: "node --test tests/checkout.test.ts",
      outcome: "CHECK_FAIL", kind: "test", requirement: "required" }], status: "FAILED" } as any;
    const features = extractFeatures(subtask, repo, 4096, verification, "planned");
    return taskFingerprint(subtask, repo, features, "complex", verification);
  };
  const direct = make("Fix the failed payment transaction and inventory rollback. Preserve the existing public APIs.");
  const paraphrase = make("Repair rollback behavior after the charge step fails");
  for (const fingerprint of [direct, paraphrase]) {
    assert.equal(fingerprint.scope, "multi-file");
    assert.equal(fingerprint.semanticComplexity, "low");
    assert.equal(fingerprint.architecturalCoupling, "low");
    assert.equal(fingerprint.blastRadius, "package");
    assert.equal(fingerprint.consequenceRisk, "high");
    assert.equal(fingerprint.verifierFalseAcceptRisk, "low");
    assert.equal(fingerprint.recoveryDetectability, "high");
    assert.equal(fingerprint.publicApiRisk, false,
      "preserving an interface is not evidence of changing it");
    assert.equal(fingerprint.toolExplorationNeed, "low",
      "an already inspected, localized graph needs no speculative exploration");
    assert.equal(requiredQualityClass(fingerprint), "MEDIUM");
  }
  assert.deepEqual(direct.routingTerms, paraphrase.routingTerms,
    "grounded paths and task shape dominate equivalent prose");
  assert.deepEqual(direct.difficulty, paraphrase.difficulty);
});

test("broken localized multi-file baseline freezes an economical first attempt and distinct recovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "koda-broken-flow-route-"));
  try {
    const economical = modelSchema.parse({ id: "fixture/economical-flow", tier: "cheap",
      qualityPrior: .97, latencyPriorMs: 600, strengths: ["coding", "tool_use", "debugging"] });
    const reference = modelSchema.parse({ id: "fixture/reference-flow", tier: "frontier",
      qualityPrior: .99, latencyPriorMs: 2500,
      strengths: ["coding", "tool_use", "debugging", "reasoning"] });
    const cfg = await config(undefined, { baseUrl: "http://127.0.0.1:1",
      specialistRouting: true, routing: { stateDirectory: dir },
      modelPool: { provider: "fixture", models: [economical, reference] } });
    const pool = new PoolRouter(cfg, new Logger(dir, "broken-flow", true));
    const metadata = { available: true, inputPrice: .05, outputPrice: .1,
      contextLength: 100000, supportedParameters: ["tools"] };
    (pool.capabilities as any).forTask = async () => [economical, reference].map((model) => ({
      model, metadata: model.id === economical.id ? metadata :
        { ...metadata, inputPrice: 8, outputPrice: 12 },
      vision: false, configured: true,
      evidence: [{ source: "agentic_benchmark", value: model.qualityPrior, detail: "fixture" }],
    }));
    const repo = { ...repository,
      files: ["src/checkout.ts", "src/inventory.ts", "src/payment.ts",
        "tests/checkout.test.ts", "package.json"] };
    const objective = "Fix the checkout transaction bug. A failed payment must restore inventory. Investigate checkout, inventory, and payment. Preserve the existing public APIs.";
    const subtask = { id: "flow", title: objective, objective,
      likelyReadPaths: repo.files.slice(0, 4),
      likelyWritePaths: repo.files.slice(0, 3), dependsOn: [],
      integrationContract: "Preserve existing public APIs",
      verificationCommands: ["node --test tests/checkout.test.ts"],
      estimatedDifficulty: "normal" as const, parallelSafe: false };
    const baseline = { checks: [{ command: "node --test tests/checkout.test.ts",
      outcome: "CHECK_FAIL", kind: "test", requirement: "required" }], status: "FAILED" } as any;
    const features = extractFeatures(subtask, repo, 4_800, baseline, "planned");
    const fingerprint = taskFingerprint(subtask, repo, features, "complex", baseline);
    assert.equal(fingerprint.focusedFailingReproduction, true,
      "the regression begins from the original broken baseline");
    const plan = await pool.selectExecutionPlan(fingerprint, features, subtask.id, .3);
    assert.equal(plan.qualityClass, "MEDIUM");
    assert.equal(plan.initialModel, economical.id);
    assert.equal(plan.referenceModel, reference.id);
    assert.ok(plan.approvedCandidateSet.some((candidate) =>
      candidate.model.id === reference.id && candidate.model.id !== plan.initialModel));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("parallel economics uses additive cost and DAG critical-path latency", () => {
  const result = estimateDagEconomics([
    { id: "a", dependsOn: [], expectedCostUsd: .01, expectedLatencyMs: 100 },
    { id: "b", dependsOn: [], expectedCostUsd: .02, expectedLatencyMs: 150 },
    { id: "c", dependsOn: ["a", "b"], expectedCostUsd: .03, expectedLatencyMs: 50 },
  ], .005, 10);
  assert.equal(result.expectedCostUsd, .065);
  assert.equal(result.expectedLatencyMs, 210);
});

test("selected specialist policy freezes limits and approved adaptive candidates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "koda-frozen-route-"));
  try {
    const first = modelSchema.parse({ id: "vendor/first", tier: "fast", qualityPrior: .96,
      latencyPriorMs: 500, strengths: ["coding", "tool_use"] });
    const sideways = modelSchema.parse({ id: "vendor/sideways", tier: "fast", qualityPrior: .955,
      latencyPriorMs: 600, strengths: ["coding", "tool_use"] });
    const frontier = modelSchema.parse({ id: "vendor/frontier", tier: "frontier", qualityPrior: .99,
      latencyPriorMs: 2000, strengths: ["coding", "tool_use", "reasoning"] });
    const cfg = await config(undefined, { baseUrl: "http://127.0.0.1:1",
      specialistRouting: true, routing: { stateDirectory: dir },
      modelPool: { provider: "local-compatible", models: [first, sideways, frontier] } });
    const pool = new PoolRouter(cfg, new Logger(dir, "frozen", true));
    const metadata = { available: true, inputPrice: .1, outputPrice: .2,
      contextLength: 100000, supportedParameters: ["tools"] };
    (pool.catalog as any).get = async () => new Map([first, sideways, frontier].map((model) => [model.id, metadata]));
    (pool.capabilities as any).forTask = async () => [first, sideways, frontier].map((model) => ({
      model, metadata, vision: false, configured: true,
      evidence: [{ source: "agentic_benchmark", value: model.qualityPrior, detail: "fixture" }],
    }));
    const subtask = { id: "node", title: "Fix src/math.ts", objective: "Fix src/math.ts",
      dependsOn: [], likelyReadPaths: ["src/math.ts", "tests/math.test.ts"],
      likelyWritePaths: ["src/math.ts"], integrationContract: "tests pass",
      verificationCommands: ["pnpm test"], estimatedDifficulty: "low" as const, parallelSafe: true };
    const features = extractFeatures(subtask, repository, 1000, undefined, "planned");
    const fingerprint = taskFingerprint(subtask, repository, features, "tiny");
    const plan = await pool.selectExecutionPlan(fingerprint, features, subtask.id, 1);
    assert.equal(Object.isFrozen(plan), true);
    assert.equal(Object.isFrozen(plan.approvedCandidateSet), true);
    assert.match(plan.id, /^route-/);
    assert.ok(plan.approvedCandidateSet.length > 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("routing uses cached evidence immediately and freezes a quality-safe bounded recovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "koda-cached-route-"));
  try {
    const economical = modelSchema.parse({ id: "fixture/economical", tier: "cheap",
      qualityPrior: .94, latencyPriorMs: 700, strengths: ["coding", "tool_use"] });
    const reference = modelSchema.parse({ id: "fixture/reference", tier: "frontier",
      qualityPrior: .99, latencyPriorMs: 3000, strengths: ["coding", "tool_use", "reasoning"] });
    const cfg = await config(undefined, { baseUrl: "http://127.0.0.1:1",
      specialistRouting: true, routing: { stateDirectory: dir },
      modelPool: { provider: "local-compatible", models: [economical, reference] } });
    const pool = new PoolRouter(cfg, new Logger(dir, "cached", true));
    (pool.catalog as any).get = () => new Promise(() => {});
    const metadata = { available: true, inputPrice: .1, outputPrice: .2,
      contextLength: 100000, supportedParameters: ["tools", "tool_choice"] };
    (pool.capabilities as any).forTask = async () => [economical, reference].map((model) => ({
      model, metadata, vision: false, configured: true,
      evidence: [{ source: "agentic_benchmark", value: model.qualityPrior, detail: "fixture" }],
    }));
    const repo = { ...repository,
      files: ["src/order.ts", "src/stock.ts", "src/charge.ts", "tests/order.test.ts"] };
    const subtask = { id: "order", title: "Fix rollback", objective: "Fix rollback after charge failure",
      likelyReadPaths: [...repo.files], likelyWritePaths: ["src/order.ts", "src/stock.ts", "src/charge.ts"],
      dependsOn: [], integrationContract: "preserve API",
      verificationCommands: ["node --test tests/order.test.ts"],
      estimatedDifficulty: "normal" as const, parallelSafe: false };
    const verification = { checks: [{ command: "node --test tests/order.test.ts",
      outcome: "CHECK_FAIL", kind: "test", requirement: "required" }], status: "FAILED" } as any;
    const features = extractFeatures(subtask, repo, 4096, verification, "planned");
    const fingerprint = taskFingerprint(subtask, repo, features, "normal", verification);
    const plan = await Promise.race([
      pool.selectExecutionPlan(fingerprint, features, subtask.id, 1),
      new Promise<never>((_, reject) => setTimeout(() => reject(Error("routing awaited provider refresh")), 500)),
    ]);
    assert.equal(plan.initialModel, economical.id);
    assert.deepEqual(plan.qualityCascadeModelIds, [economical.id, reference.id]);
    assert.ok(plan.expectedCostPerVerifiedSolve > 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalRoutingTask } from "../src/router/canonicalTask.js";
import {
  canonicalEvidenceDirectory,
  canonicalKnowledgeSnapshot,
  CanonicalRoutingKnowledgeStore,
  trainingEligible,
  type CanonicalQualityObservation,
} from "../src/router/knowledge/canonical.js";
import type { EvidenceSourceInput } from "../src/router/knowledge/ingest.js";
import {
  completeSolve,
  fitContextualQuality,
  predictContextualQuality,
  taskPartition,
  calibrationMetrics,
} from "../src/router/contextualQuality.js";
import {
  selectContextualPlan,
  type ContextualPlanCandidate,
} from "../src/router/contextualPlans.js";
import {
  buildContextualRoutingArtifact,
  evaluateFrozenHoldout,
} from "../src/dev/contextualRoutingEval.js";
import { contextualShadowDecision } from "../src/router/contextualShadow.js";

function source(): EvidenceSourceInput {
  const tasks = Array.from({ length: 200 }, (_, i) => ({
    taskKey: `task-${i}`,
    taskFamily: i % 2 ? "refactor" : "debugging",
    routingTerms: [],
    split: "probing",
  }));
  return {
    id: "unit-benchmark",
    type: "paired_task_model",
    version: "fixture-1",
    split: "probing",
    trainingAllowed: true,
    harness: "test-harness",
    engine: "direct-edit",
    tasks,
    records: tasks.flatMap((t, i) =>
      ["provider/coder-alpha", "provider/coder-beta"].map((m, j) => ({
        taskKey: t.taskKey,
        taskFamily: t.taskFamily,
        canonicalModelId: m,
        externalModelName: m,
        revision: m,
        identityLevel: "EXACT" as const,
        success: j === i % 2,
        benchmarkScore: j === i % 2 ? 1 : 0.5,
        reportedCostUsd: j ? 0.02 : 0.002,
        latencyMs: 10,
        inputTokens: 20,
        outputTokens: 10,
      })),
    ),
  };
}
function observations() {
  return canonicalKnowledgeSnapshot([source()], "2026-10-06").qualityEvidence!;
}

test("canonical quality namespace ignores transport and reuses RoutingKnowledgeStore", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quality-"));
  try {
    const s = canonicalKnowledgeSnapshot([source()]);
    await writeFile(join(dir, "routing-knowledge-v2.json"), JSON.stringify(s));
    assert.equal(
      new CanonicalRoutingKnowledgeStore(dir).snapshot.snapshotId,
      s.snapshotId,
    );
    assert.equal(
      canonicalEvidenceDirectory("/tmp/quality-root"),
      "/tmp/quality-root/routing-quality",
    );
    assert.equal(
      new CanonicalRoutingKnowledgeStore(dir).evidence().length,
      400,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("canonical ingestion rejects evaluation/synthetic/unknown split and mixed task split", () => {
  for (const split of ["id_test", "ood", "synthetic", undefined] as const)
    assert.throws(
      () => canonicalKnowledgeSnapshot([{ ...source(), split }]),
      /Training source rejected/,
    );
  const s = source();
  s.tasks![0]!.split = "id_test";
  assert.throws(() => canonicalKnowledgeSnapshot([s]), /split mismatch/);
});
test("all outcomes including partial scores preserve provenance and exact economics", () => {
  const rows = observations();
  assert.equal(rows.length, 400);
  const partial = rows.find((r) => r.score === 0.5)!;
  assert.equal(completeSolve(partial), 0);
  assert.equal(partial.costUsd, 0.02);
  assert.equal(partial.task.engine, "direct-edit");
  assert.equal(partial.task.harness, "test-harness");
  assert.equal(partial.provenance, "unit-benchmark:fixture-1");
});
test("duplicate task/model outcomes are rejected instead of inflating confidence", () => {
  const s = source();
  s.records.push(s.records[0]!);
  assert.throws(() => canonicalKnowledgeSnapshot([s]), /Duplicate/);
});
test("local learning requires independently verified requirement proof and attributable model failure", () => {
  const base: CanonicalQualityObservation = {
    ...observations()[0]!,
    origin: "local",
    split: "local",
    score: undefined,
    success: true,
    outcome: "VERIFIED_SUCCESS",
  };
  assert.equal(trainingEligible(base), false);
  assert.equal(
    trainingEligible({
      ...base,
      proof: { independent: true, requirementLevel: true },
    }),
    true,
  );
  assert.equal(
    trainingEligible({
      ...base,
      success: false,
      attribution: {
        primaryCause: "PROVIDER_FAILURE",
        learningDisposition: "CENSORED",
      },
    }),
    false,
  );
  assert.equal(
    trainingEligible({
      ...base,
      success: false,
      attribution: {
        primaryCause: "MODEL_FAILURE",
        learningDisposition: "NEGATIVE_MODEL_EVIDENCE",
      },
    }),
    true,
  );
  for (const split of ["id_test", "ood", "synthetic"] as const)
    assert.equal(
      trainingEligible({
        ...base,
        split,
        proof: { independent: true, requirementLevel: true },
      }),
      false,
    );
});
test("synthetic and operational outcomes cannot enter canonical local ledger", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quality-ledger-"));
  try {
    const store = new CanonicalRoutingKnowledgeStore(dir);
    const base = {
      ...observations()[0]!,
      origin: "local" as const,
      split: "local" as const,
      score: undefined,
      success: true,
      outcome: "VERIFIED_SUCCESS",
      proof: { independent: true, requirementLevel: true },
    };
    assert.equal(store.record({ ...base, origin: "synthetic" }), false);
    assert.equal(store.record(base), true);
    assert.equal(store.record(base), false);
    assert.equal(store.evidence().length, 1);
    assert.throws(
      () => store.record({ ...base, id: "another", propensity: 0 }),
      /propensity/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("grouped partition keeps all model labels of a task in one partition", () => {
  const rows = observations();
  assert.equal(new Set(rows.map((r) => taskPartition(r.taskId))).size, 3);
  for (let i = 0; i < rows.length; i += 2)
    assert.equal(
      taskPartition(rows[i]!.taskId),
      taskPartition(rows[i + 1]!.taskId),
    );
});
test("empirical cold start learns contextual ranking rather than uniform .5", () => {
  const a = fitContextualQuality(observations(), "empirical", "fixed");
  const task = observations()[0]!.task;
  assert.ok(
    predictContextualQuality(a, task, "provider/coder-alpha").mean > 0.9,
  );
  assert.ok(
    predictContextualQuality(a, task, "provider/coder-beta").mean < 0.1,
  );
  assert.ok(
    predictContextualQuality(
      a,
      { ...task, family: "refactor" },
      "provider/coder-beta",
    ).mean > 0.9,
  );
});
test("logistic contextual candidate is deterministic and distinguishes task/model interactions", () => {
  const rows = observations(),
    a = fitContextualQuality(rows, "logistic", "fixed"),
    b = fitContextualQuality(rows, "logistic", "fixed");
  assert.equal(a.digest, b.digest);
  const task = rows[0]!.task;
  assert.ok(
    predictContextualQuality(a, task, "provider/coder-alpha").mean >
      predictContextualQuality(a, task, "provider/coder-beta").mean,
  );
});
test("unknown models and engine/harness transfer retain ignorance bounds", () => {
  const a = fitContextualQuality(observations(), "empirical"),
    task = observations()[0]!.task;
  const unknown = predictContextualQuality(a, task, "unseen/new-model");
  assert.equal(unknown.lower, 0);
  assert.equal(unknown.upper, 1);
  assert.ok(unknown.support > 0);
  assert.equal(unknown.evidence?.provenanceClass, "global_prior");
  assert.equal(unknown.calibratedDomain, false);
  for (const t of [
    { ...task, engine: "aider" },
    { ...task, harness: "koda" },
  ]) {
    const p = predictContextualQuality(a, t, "provider/coder-alpha");
    assert.equal(p.calibratedDomain, false);
    assert.equal(p.lower, 0);
    assert.equal(p.upper, 1);
  }
});
test("benchmark partial score is not silently a successful solve", () => {
  const row = observations()[0]!;
  assert.equal(completeSolve({ ...row, score: 0.99, success: true }), 0);
  assert.equal(completeSolve({ ...row, score: 1 }), 1);
});
test("calibration computes Brier ECE and log loss without holdout fitting", () => {
  const m = calibrationMetrics([
    { y: 1, p: 0.8 },
    { y: 0, p: 0.2 },
  ]);
  assert.ok(Math.abs(m.brier! - 0.04) < 1e-12);
  assert.ok(Math.abs(m.ece - 0.2) < 1e-12);
  assert.ok(Math.abs(m.logLoss + Math.log(0.8)) < 1e-12);
});
function candidate(
  model: string,
  p: number,
  costUsd: number,
): ContextualPlanCandidate {
  return {
    model,
    engine: "direct-edit",
    compatible: true,
    costUsd,
    latencyMs: 20,
    p90Ms: 30,
    quality: {
      mean: p,
      lower: p - 0.002,
      upper: p + 0.002,
      support: 10000,
      level: "task_model_engine",
      identity: "EXACT",
      provenance: ["verified-test"],
      calibratedDomain: true,
    },
  };
}
test("quality gate precedes economics and cheap alone cannot compensate for bad quality", () => {
  const task = {
    ...observations()[0]!.task,
    proof: { strength: "strong", falseAcceptRisk: "low" },
    risks: {},
  };
  const result = selectContextualPlan({
    task,
    candidates: [
      candidate("cheap", 0.6, 0.001),
      candidate("credible", 0.97, 0.1),
    ],
    allowedRegret: 0.02,
    maxFalseAccept: 0.1,
    budgetUsd: 1,
  });
  assert.deepEqual(result.selected?.models, ["credible"]);
  assert.equal(
    result.plans.find((p) => p.models[0] === "cheap")!.eligible,
    false,
  );
});
test("cheap-first rescue requires paired conditional evidence and measured detection", () => {
  const task = {
    ...observations()[0]!.task,
    proof: { strength: "strong", falseAcceptRisk: "low" },
    risks: {},
  };
  const input = {
    task,
    candidates: [
      candidate("cheap", 0.94, 0.001),
      candidate("credible", 0.97, 0.1),
    ],
    allowedRegret: 0.02,
    maxFalseAccept: 0.01,
    budgetUsd: 1,
    verifier: {
      detectionLower: 0.99,
      falseAcceptUpper: 0.01,
      provenance: "audited-verifier",
      costUsd: 0.001,
      latencyMs: 2,
    },
  };
  assert.equal(selectContextualPlan(input).plans.length, 2);
  const result = selectContextualPlan({
    ...input,
    rescue: [
      {
        initial: "cheap",
        rescue: "credible",
        engine: "direct-edit",
        taskFamily: task.family,
        successes: 9999,
        failures: 1,
        provenance: "paired-recovery",
      },
    ],
  });
  assert.deepEqual(result.selected?.models, ["cheap", "credible"]);
  assert.equal(
    selectContextualPlan({ ...input, verifier: undefined }).plans.length,
    2,
  );
});
test("incompatible candidates excluded and risky tasks cannot explore", () => {
  const task = {
    ...observations()[0]!.task,
    proof: { strength: "strong", falseAcceptRisk: "low" },
    risks: { security: true },
  };
  const r = selectContextualPlan({
    task,
    candidates: [
      candidate("one", 0.99, 0.1),
      { ...candidate("bad", 1, 0), compatible: false },
    ],
    allowedRegret: 0.1,
    maxFalseAccept: 0.02,
    budgetUsd: 1,
    explorationRate: 1,
    random: 0,
  });
  assert.equal(r.plans.length, 1);
  assert.equal(r.propensity, 1);
});
test("shadow missing user artifact loads bundled evidence without provider calls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "empty-shadow-"));
  try {
    assert.equal(
      contextualShadowDecision(
        {
          models: [],
          inputTokens: 100,
          outputTokens: 100,
          budgetUsd: 1,
        } as never,
        dir,
      ).status,
      "ABSTAIN",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("frozen holdout evaluates once and cannot overwrite with a new output path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "routing-eval-"));
  try {
    const report = await buildContextualRoutingArtifact(source(), dir);
    assert.equal(report.totalObservations, 400);
    const holdout = {
      ...source(),
      split: "id_test",
      trainingAllowed: false,
      tasks: source().tasks!.map((t) => ({
        ...t,
        taskKey: `heldout-${t.taskKey}`,
        split: "id_test",
      })),
      records: source().records.map((r) => ({
        ...r,
        taskKey: `heldout-${r.taskKey}`,
      })),
    };
    const file = join(dir, "holdout.json");
    await writeFile(file, JSON.stringify(holdout));
    const a = join(dir, "contextual-quality-v1.json");
    await evaluateFrozenHoldout(a, file, join(dir, "report.json"));
    await assert.rejects(
      evaluateFrozenHoldout(a, file, join(dir, "second-report.json")),
      /EEXIST/,
    );
    const stored = JSON.parse(
      await readFile(join(dir, "routing-knowledge-v2.json"), "utf8"),
    );
    assert.ok(
      stored.qualityEvidence.every(
        (r: CanonicalQualityObservation) => r.split === "probing",
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

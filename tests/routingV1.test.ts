import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessTask } from "../src/router/taskAssessment.js";
import { buildVerificationContract } from "../src/verifier/contract.js";
import { modelSchema, routingSchema } from "../src/router/pool.js";
import {
  decideRoutingV1,
  estimateRoutingQuality,
  qualityLearningLabel,
  routingFamily,
  type RoutingEvidence,
  type RoutingFamily,
  type RoutingV1Input,
} from "../src/router/routingV1.js";
import {
  calibration,
  evaluateRoutingV1,
  routingDatasetSchema,
  type RoutingDataset,
} from "../src/router/routingV1Evaluation.js";
import { RoutingV1History } from "../src/router/routingV1History.js";
import { extractFeatures } from "../src/router/features.js";
import { optimizeSpecialists } from "../src/router/routeOptimizer.js";
import type { TaskFingerprint } from "../src/router/taskFingerprint.js";
import type { Config } from "../src/config.js";
import type { SpecialistModel } from "../src/router/capabilityRegistry.js";
import { fixture, observed, features } from "../src/dev/routingV1Fixtures.js";
test("zero local history uses observed cold-start evidence", () => {
  const d = decideRoutingV1(fixture());
  assert.equal(d.selected?.models[0], "vendor/a");
  assert.ok(d.reference);
});
test("no benchmark evidence abstains instead of inventing quality", () => {
  const x = fixture();
  x.evidence = [];
  assert.equal(decideRoutingV1(x).selected, null);
});
test("new unseen model receives hierarchical backoff", () => {
  const q = estimateRoutingQuality(
    "new/c",
    "new",
    "debugging",
    "low",
    "direct",
    observed("vendor/a"),
  );
  assert.ok(q.samples > 0);
  assert.equal(q.modelSamples, 0);
  assert.ok(q.provenance[0]!.ids.length);
});
test("sparse granular data shrink toward broader evidence without double counting", () => {
  const q = estimateRoutingQuality(
    "vendor/a",
    "vendor",
    "frontend_visual",
    "medium",
    "direct",
    [...observed("vendor/a"), ...observed("vendor/a", "frontend_visual", 1, 2)],
  );
  assert.ok(q.samples <= 26);
  assert.ok(q.mean > 0.5);
});
test("task-specific performance differs by family", () => {
  const rows = [
    ...observed("vendor/a", "frontend_visual", 50),
    ...observed("vendor/a", "backend_api", 99),
  ];
  assert.ok(
    estimateRoutingQuality(
      "vendor/a",
      "vendor",
      "backend_api",
      "low",
      "direct",
      rows,
    ).mean >
      estimateRoutingQuality(
        "vendor/a",
        "vendor",
        "frontend_visual",
        "low",
        "direct",
        rows,
      ).mean,
  );
});
test("weak UI verification rejects cheaper weak visual model", () => {
  const x = fixture();
  x.fingerprint.visualRelevant = true;
  x.contract.overallStrength = "weak";
  x.contract.overallFalseAcceptRisk = "high";
  x.evidence = [
    ...observed("vendor/a", "frontend_visual", 75),
    ...observed("vendor/b", "frontend_visual", 99),
  ];
  assert.equal(decideRoutingV1(x).selected?.models[0], "vendor/b");
});
test("strong proof permits economical first attempt with conditional rescue", () => {
  const x = fixture();
  x.evidence = [
    ...observed("vendor/a", "debugging", 80),
    ...observed("vendor/b", "debugging", 99),
  ];
  x.rescueEvidence = [
    {
      initial: "vendor/a",
      rescue: "vendor/b",
      taskFamily: "debugging",
      engine: "direct",
      successes: 99,
      failures: 1,
      provenance: "paired independent failed-initial tasks",
    },
  ];
  x.route.plans.push({
    ...x.route.plans[0]!,
    models: ["vendor/a", "vendor/b"],
    hardRejection: undefined,
  });
  const d = decideRoutingV1(x);
  assert.ok(d.plans.some((p) => p.exploration && !p.reasons.length));
});
test("security risk rejects uncertain economical exploration", () => {
  const x = fixture();
  x.assessment.riskFlags.security = true;
  x.evidence = [
    ...observed("vendor/a", "security", 60),
    ...observed("vendor/b", "security", 99),
  ];
  assert.equal(decideRoutingV1(x).selected?.models[0], "vendor/b");
});
for (const cause of [
  "PROVIDER_FAILURE",
  "SCOPE_FAILURE",
  "CONTEXT_FAILURE",
  "VERIFICATION_INFRA_FAILURE",
  "REPO_BASELINE_FAILURE",
  "KODA_INTERNAL_FAILURE",
  "UNKNOWN",
] as const)
  test(`${cause} is censored`, () =>
    assert.equal(
      qualityLearningLabel("FAILED", {
        primaryCause: cause,
        learningDisposition: "CENSORED",
      }),
      null,
    ));
test("verified success learns positive; synthetic success excluded", () => {
  assert.equal(qualityLearningLabel("VERIFIED_SUCCESS"), true);
  assert.equal(qualityLearningLabel("VERIFIED_SUCCESS", undefined, true), null);
});
test("only independently attributed model failures learn negative", () => {
  assert.equal(
    qualityLearningLabel("FAILED", {
      primaryCause: "MODEL_FAILURE",
      learningDisposition: "NEGATIVE_MODEL_EVIDENCE",
    }),
    false,
  );
  assert.equal(
    qualityLearningLabel("FAILED", {
      primaryCause: "MODEL_FAILURE",
      learningDisposition: "CENSORED",
    }),
    null,
  );
});
test("capability filtering precedes ranking", () => {
  const x = fixture();
  x.models[0]!.metadata.supportedParameters = [];
  const d = decideRoutingV1(x);
  assert.ok(d.candidates[0]!.reasons.includes("tool_protocol"));
  assert.equal(d.selected?.models[0], "vendor/b");
});
test("context and output limits filter impossible candidates", () => {
  const x = fixture();
  x.models[0]!.metadata.contextLength = 1;
  x.models[0]!.metadata.maxOutputTokens = 1;
  assert.equal(
    decideRoutingV1(x).candidates[0]!.reasons.filter((r) =>
      r.endsWith("capacity"),
    ).length,
    2,
  );
});
test("latency ranks complete plans when quality is equivalent", () => {
  const x = fixture();
  x.costWeight = 0;
  x.latencyWeight = 1;
  for (const c of x.route.considered)
    c.expectedAttemptLatencyMs = c.model.id === "vendor/b" ? 1 : 100000;
  assert.equal(decideRoutingV1(x).selected?.models[0], "vendor/b");
});
test("rescue without paired observations never assumes independent success", () => {
  const x = fixture();
  x.route.plans.push({
    ...x.route.plans[0]!,
    models: ["vendor/a", "vendor/b"],
    hardRejection: undefined,
  });
  const d = decideRoutingV1(x);
  const p = d.plans.find((p) => p.models.length === 2)!;
  assert.equal(p.conditionalRescue, null);
  assert.equal(p.finalMean, Math.max(...d.candidates.map((c) => c.mean)));
});
test("reference is strongest credible compatible model and regret is stricter without strong proof", () => {
  const x = fixture(),
    normal = decideRoutingV1(x);
  x.contract.overallStrength = "weak";
  const weak = decideRoutingV1(x);
  assert.ok(weak.allowedRegret < normal.allowedRegret);
  assert.equal(
    normal.referenceQuality,
    Math.max(...normal.candidates.map((c) => c.lower)),
  );
});
test("shadow leaves production plan byte-for-byte unchanged", () => {
  const x = fixture(),
    before = JSON.stringify(x.route);
  decideRoutingV1(x);
  assert.equal(JSON.stringify(x.route), before);
});
test("learned-history moves posterior in response to attributed observations", () => {
  const a = estimateRoutingQuality(
    "vendor/a",
    "vendor",
    "debugging",
    "low",
    "direct",
    observed("vendor/a"),
  );
  const b = estimateRoutingQuality(
    "vendor/a",
    "vendor",
    "debugging",
    "low",
    "direct",
    [
      ...observed("vendor/a"),
      ...observed("vendor/a", "debugging", 0, 30, "local"),
    ],
  );
  assert.ok(b.mean < a.mean);
});
test("unavailable models removed while evidence persists", () => {
  const x = fixture(),
    before = JSON.stringify(x.evidence);
  x.models[0]!.metadata.available = false;
  assert.equal(decideRoutingV1(x).selected?.models[0], "vendor/b");
  assert.equal(JSON.stringify(x.evidence), before);
});
test("calibration uses observed outcomes", () => {
  const c = calibration([
    { prediction: 0.8, success: true },
    { prediction: 0.2, success: false },
  ]);
  assert.ok(Math.abs(c.brier! - 0.04) < 1e-10);
  assert.ok(Math.abs(c.ece! - 0.2) < 1e-10);
  assert.equal(calibration([]).brier, null);
});
test("shadow history remains separate and validates provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "routing-shadow-"));
  try {
    const h = new RoutingV1History(root);
    h.record(observed("vendor/a")[0]!);
    assert.equal(h.read().length, 1);
    h.record(observed("vendor/a")[0]!);
    assert.equal(h.read().length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("evaluation rejects outcome leakage", () => {
  const x = fixture();
  const data: any = {
    version: 1,
    provenance: "fixture",
    models: x.models,
    priors: x.evidence,
    tasks: [
      {
        id: x.evidence[0]!.taskId,
        split: "holdout",
        assessment: x.assessment,
        contract: x.contract,
        fingerprint: x.fingerprint,
        features,
        outcomes: {
          "vendor/a": {
            verified: true,
            groundTruthPass: true,
            costUsd: 0.01,
            wallClockMs: 1,
          },
          "vendor/b": {
            verified: true,
            groundTruthPass: true,
            costUsd: 0.1,
            wallClockMs: 10,
          },
        },
      },
    ],
  };
  assert.throws(() => routingDatasetSchema.parse(data), /leaked/);
});
test("actual PoolRouter produces identical frozen route with shadow enabled/disabled", async () => {
  const { PoolRouter } = await import("../src/router/modelRouter.js"),
    { Logger } = await import("../src/telemetry/logger.js"),
    { config } = await import("../src/config.js");
  const root = await mkdtemp(join(tmpdir(), "routing-v1-production-"));
  try {
    const x = fixture();
    const outputs: any[] = [];
    for (const enabled of [true, false]) {
      const cfg = await config(undefined, {
        modelPool: {
          provider: "openrouter",
          models: x.models.map((m) => m.model),
        },
        routing: { stateDirectory: join(root, String(enabled)) },
      });
      const logger = new Logger(join(root, `log-${enabled}`), "same-run", true);
      logger.log("task_assessment", { assessment: x.assessment });
      logger.log("verification_contract", { contract: x.contract });
      if (!enabled) logger.log("routing_v1_shadow_disabled", {});
      const router = new PoolRouter(cfg, logger);
      router.capabilities.forTask = async () => [...x.models];
      router.catalog.get = async () => new Map();
      const result = await router.selectExecutionPlan(
        x.fingerprint,
        features,
        "task",
        10,
      );
      outputs.push({
        initial: result.initialModel,
        qualityCascade: result.qualityCascadeModelIds,
        operationalPeers: result.operationalRecoveryModelIds,
        reference: result.referenceModel,
        requiredQuality: result.requiredQuality,
        stopConditions: result.stopConditions,
      });
      assert.equal(
        logger.events.filter((e) => e.type === "routing_v1_shadow_decision")
          .length,
        Number(enabled),
      );
    }
    assert.deepEqual(outputs[0], outputs[1]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("unsafe unproven new model cannot bypass high-risk gate through global prior", () => {
  const x = fixture();
  x.models = [
    ...x.models,
    { ...x.models[0]!, model: { ...x.models[0]!.model, id: "future/new" } },
  ];
  x.assessment.consequenceRisk = "high";
  const d = decideRoutingV1(x);
  assert.ok(d.candidates.some((c) => c.model === "future/new"));
  assert.notEqual(d.selected?.models[0], "future/new");
});
test("recovery reservation cannot exceed total budget", () => {
  const x = fixture();
  x.route.plans.push({
    ...x.route.plans[0]!,
    models: ["vendor/a", "vendor/b"],
    hardRejection: undefined,
  });
  x.budgetUsd = 0.018;
  const d = decideRoutingV1(x);
  assert.ok(
    d.plans
      .find((p) => p.models.length === 2)
      ?.reasons.includes("recovery_budget"),
  );
});
test("matrix outcomes never influence that task's routing", () => {
  const x = fixture();
  const task = {
    id: "heldout",
    split: "holdout" as const,
    assessment: x.assessment,
    contract: x.contract,
    fingerprint: x.fingerprint,
    features,
    outcomes: {
      "vendor/a": {
        verified: true,
        groundTruthPass: true,
        costUsd: 0.01,
        wallClockMs: 1,
      },
      "vendor/b": {
        verified: true,
        groundTruthPass: true,
        costUsd: 0.1,
        wallClockMs: 10,
      },
    },
  };
  const data = routingDatasetSchema.parse({
    version: 1,
    provenance: "isolated controlled fixture",
    models: x.models,
    priors: x.evidence,
    tasks: [task],
  });
  const before = evaluateRoutingV1(data, configurationForEval()).rows.find(
    (r) => r.strategy === "routing_v1",
  )!.models;
  data.tasks[0]!.outcomes["vendor/a"]!.verified = false;
  const after = evaluateRoutingV1(data, configurationForEval()).rows.find(
    (r) => r.strategy === "routing_v1",
  )!.models;
  assert.deepEqual(before, after);
});
function configurationForEval() {
  return {
    maxOutputTokens: 1000,
    maxIterations: 3,
    maxMinutes: 10,
    maxTokens: 100000,
    budgetUsd: 10,
    routing: routingSchema.parse({ costWeight: 1, latencyWeight: 0 }),
  } as Config;
}
test("total rescue work can outweigh a low first-call price", () => {
  const x = fixture();
  const third = {
    ...x.models[1]!,
    model: { ...x.models[1]!.model, id: "vendor/c" },
  };
  x.models = [...x.models, third];
  x.evidence = [
    ...observed("vendor/a", "debugging", 40),
    ...observed("vendor/b", "debugging", 99),
    ...observed("vendor/c", "debugging", 990, 1000),
  ];
  const template = x.route.considered[1]!;
  x.route.considered.push({
    ...template,
    model: third.model,
    expectedAttemptCost: 0.06,
  });
  x.route.considered[0]!.expectedAttemptCost = 0.01;
  x.route.considered[1]!.expectedAttemptCost = 0.5;
  x.route.plans.push(
    {
      ...x.route.plans[0]!,
      models: ["vendor/a", "vendor/b"],
      hardRejection: undefined,
    },
    { ...x.route.plans[0]!, models: ["vendor/c"], hardRejection: undefined },
  );
  x.rescueEvidence = [
    {
      initial: "vendor/a",
      rescue: "vendor/b",
      taskFamily: "debugging",
      engine: "direct",
      successes: 99,
      failures: 1,
      provenance: "paired outcomes",
    },
  ];
  const d = decideRoutingV1(x);
  assert.equal(d.selected?.models[0], "vendor/c");
  assert.ok(d.plans.find((p) => p.models.length === 2)!.expectedCost > 0.06);
});
test("bounded unseen-model exploration is eligible with strong proofs and proven rescue", () => {
  const x = fixture();
  const newcomer = {
    ...x.models[0]!,
    model: { ...x.models[0]!.model, id: "future/new" },
    metadata: { ...x.models[0]!.metadata, inputPrice: 0.01, outputPrice: 0.01 },
  };
  x.models = [...x.models, newcomer];
  x.route.plans.push({
    ...x.route.plans[0]!,
    models: ["future/new", "vendor/b"],
    hardRejection: undefined,
  });
  const d = decideRoutingV1(x);
  assert.ok(
    d.plans.some(
      (p) => p.models[0] === "future/new" && !p.reasons.length && p.exploration,
    ),
  );
});
test("external benchmark evidence cannot dominate controlled task evidence", () => {
  const controlled = observed("vendor/a", "frontend_visual", 90);
  const external = observed(
    "vendor/a",
    "frontend_visual",
    0,
    10000,
    "external",
  );
  const q = estimateRoutingQuality(
    "vendor/a",
    "vendor",
    "frontend_visual",
    "low",
    "direct",
    [...controlled, ...external],
  );
  assert.ok(q.mean > 0.85);
});
test("local imported quality evidence requires canonical attribution gate", () => {
  const { source, ...base } = observed("vendor/a")[0]!;
  const bad = {
    ...base,
    source: "local",
    success: false,
    outcome: "FAILED",
    attribution: {
      primaryCause: "PROVIDER_FAILURE",
      learningDisposition: "CENSORED",
    },
  };
  const x = fixture();
  const data = {
    version: 1,
    provenance: "fixture",
    models: x.models,
    priors: [bad],
    tasks: [
      {
        id: "evaluation",
        split: "holdout",
        assessment: x.assessment,
        contract: x.contract,
        fingerprint: x.fingerprint,
        features,
        outcomes: {
          "vendor/a": {
            verified: true,
            groundTruthPass: true,
            costUsd: 0.01,
            wallClockMs: 1,
          },
          "vendor/b": {
            verified: true,
            groundTruthPass: true,
            costUsd: 0.1,
            wallClockMs: 1,
          },
        },
      },
    ],
  };
  assert.throws(() => routingDatasetSchema.parse(data), /Attribution-approved/);
});
test("false accepted candidate is never counted as a verified solve", () => {
  const x = fixture();
  const data = routingDatasetSchema.parse({
    version: 1,
    provenance: "fixture",
    models: x.models,
    priors: x.evidence,
    tasks: [
      {
        id: "false-accept",
        split: "holdout",
        assessment: x.assessment,
        contract: x.contract,
        fingerprint: x.fingerprint,
        features,
        outcomes: {
          "vendor/a": {
            verified: true,
            groundTruthPass: false,
            costUsd: 0.01,
            wallClockMs: 1,
          },
          "vendor/b": {
            verified: true,
            groundTruthPass: true,
            costUsd: 0.1,
            wallClockMs: 1,
          },
        },
      },
    ],
  });
  const metrics = evaluateRoutingV1(data, configurationForEval()).baselines
    .routing_v1!;
  assert.equal(metrics.verifiedSolves, 0);
  assert.equal(metrics.criticalFalseAccepts, 1);
});
test("joint shadow ranking charges planning prerequisites and keeps quality gating", async () => {
  const { chooseRoutingV1Joint } = await import("../src/router/routingV1.js");
  const x = fixture();
  const decision = decideRoutingV1(x);
  const result = chooseRoutingV1Joint(
    [
      {
        strategy: "planned",
        decision,
        prerequisiteCostUsd: 1,
        prerequisiteLatencyMs: 10000,
      },
      { strategy: "direct", decision },
    ],
    10,
    0.55,
    0.45,
  );
  assert.equal(result.selected?.strategy, "direct");
  assert.ok(result.plans.some((p) => p.strategy === "planned" && p.cost > 1));
});
test("collector refuses unbounded or unconfigured paid selection before dispatch", async () => {
  const { collectRoutingBenchmarks } =
    await import("../src/dev/routingV1Collect.js");
  await assert.rejects(
    () =>
      collectRoutingBenchmarks({
        config: configurationForEval(),
        models: ["unconfigured"],
        tasks: ["sum"],
        budgetUsd: 0,
        output: "/tmp/should-not-be-created",
      }),
    /positive budget/,
  );
  await assert.rejects(
    () =>
      collectRoutingBenchmarks({
        config: configurationForEval(),
        models: ["unconfigured"],
        tasks: ["sum"],
        budgetUsd: 1,
        output: "/tmp/should-not-be-created",
      }),
    /not configured/,
  );
});

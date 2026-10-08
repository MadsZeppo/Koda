/** Evaluation-only process: never imported by the production CLI. */
import { readFile } from "node:fs/promises";
import { config } from "../config.js";
import { run } from "../run.js";
import { PoolRouter } from "../router/modelRouter.js";
import { freezeExecutionPolicy } from "../router/controlPolicy.js";
import type { FrozenExecutionPlan } from "../router/modelRouter.js";
import type { Config } from "../config.js";
import type { TaskFingerprint } from "../router/taskFingerprint.js";

/** Experimental assignment, not a production quality prediction. */
export function calibrationExecutionPlan(
  cfg: Config,
  arm: string,
  fingerprint: TaskFingerprint,
  budgetUsd: number,
): FrozenExecutionPlan {
  const id = arm.slice("calibration:".length);
  const model = cfg.modelPool?.models.find((m) => m.id === id);
  const metadata = model?.fallback;
  if (
    !model ||
    cfg.modelPool?.models.length !== 1 ||
    !metadata ||
    !metadata.supportedParameters?.includes("tools") ||
    !metadata.supportedParameters?.includes("tool_choice")
  )
    throw Error("Calibration requires one frozen tool-compatible model");
  // Numerical fields satisfy the shared execution-policy shape. Zero quality
  // means unmeasured, never evidence for ranking or publication. The per-call
  // transport, not these forecasts, authorizes actual expenditure.
  const candidate: FrozenExecutionPlan["initialCandidate"] = {
    model,
    metadata,
    quality: 0,
    conservativeQuality: 0,
    evidenceLevel: "UNKNOWN",
    confidence: "low",
    evidence: [],
    observationCount: 0,
    localQualityEvidence: 0,
    expectedAttemptCost: 0,
    reservationCost: 0,
    conservativeAttemptCost: 0,
    expectedCompletionCost: 0,
    expectedAttemptLatencyMs: 0,
    expectedCompletionLatencyMs: 0,
    operationalErrorRate: 0,
    tokenEfficiency: {
      expectedInputTokens: 0,
      expectedOutputTokens: cfg.maxOutputTokens,
      expectedTotalTokens: cfg.maxTokens,
      p50TotalTokens: cfg.maxTokens,
      p75TotalTokens: cfg.maxTokens,
      p90TotalTokens: cfg.maxTokens,
      p99TotalTokens: cfg.maxTokens,
      typicalTurns: null,
      cachedTokenRatio: null,
      observedCostPerTaskUsd: null,
      evidenceUsed: [],
    },
    expectedInputTokens: 0,
    expectedOutputTokens: cfg.maxOutputTokens,
    expectedTotalTokens: cfg.maxTokens,
    callCount: 0,
    cost: 0,
    latency: 0,
    score: 0,
    p50AttemptCost: 0,
    p99AttemptCost: 0,
    knowledgeSources: [],
    evidenceFreshness: 0,
    expectedFinalSuccess: 0,
    uncertainty: 1,
    qualityGap: 0,
    qualityFloorPassed: false,
    firstAttemptQualityFloor: 0,
    latencyEwmaMs: 0,
    latencyP50Ms: null,
    latencyP90Ms: null,
    latencyP99Ms: null,
    latencyEvidenceKnown: false,
    latencySlaPassed: false,
    deadlineFeasible: true,
  };
  return freezeExecutionPolicy({
    id: `offline:${arm}`,
    type: "single",
    executionEngine: "agentic",
    taskFingerprint: fingerprint,
    qualityClass: "HIGH",
    requiredQuality: 0,
    verificationStrength: fingerprint.verificationStrength,
    approvedCandidateSet: [candidate],
    initialCandidate: candidate,
    initialModel: id,
    referenceModel: id,
    activeBoard: [],
    qualityCascadeModelIds: [],
    operationalRecoveryModelIds: [],
    orderedRecoveryModelIds: [],
    totalBudgetUsd: budgetUsd,
    latencyBudgetMs: cfg.stageMaxMinutes * 60000,
    maxCodingAttempts: 1,
    maxScoutCalls: 0,
    providerConstraints: {},
    writeScopes: [],
    verificationContract: {},
    stopConditions: ["authoritative verification required"],
    evidenceClass: "UNKNOWN",
    conservativeQuality: 0,
    expectedCostPerVerifiedSolve: 0,
    expectedLatencyMs: 0,
    evaluatedCandidates: [candidate],
    whySelected: "Frozen offline experimental assignment; quality unmeasured",
  });
}

export function configureBenchmarkRouting(cfg: Config, arm: string) {
  // forceModel bypasses selectExecutionPlan in codingExecutor. The isolated
  // single-model pool and transport enforce identity; the frozen plan must
  // remain authoritative for engine, attempt count and recovery policy.
  cfg.forceModel = undefined;
  if (arm.startsWith("calibration:")) {
    const id = arm.slice("calibration:".length);
    cfg.registry = Object.fromEntries(
      Object.keys(cfg.registry).map((role) => [role, id]),
    ) as Config["registry"];
  }
  if (arm !== "current-koda") {
    cfg.specialistRouting = true;
    cfg.adaptiveCoding = true;
  }
}

export function benchmarkPlan(
  base: FrozenExecutionPlan,
  arm: string,
  decision: any,
): FrozenExecutionPlan {
  if (arm === "current-koda") return base;
  const compatible = (base.evaluatedCandidates ?? []).filter(
    (c) => !c.hardRejection && c.metadata.available !== false,
  );
  let ids: string[];
  if (arm.startsWith("calibration:")) {
    ids = [arm.slice("calibration:".length)];
  } else if (arm === "routing-v1") {
    if (!decision?.selected)
      throw Error("Routing V1 abstained: no evidence-backed eligible plan");
    ids = decision.selected.models;
  } else {
    const ordered = [...compatible].sort((a, b) =>
      arm === "strongest"
        ? b.conservativeQuality - a.conservativeQuality ||
          b.quality - a.quality ||
          a.model.id.localeCompare(b.model.id)
        : a.expectedAttemptCost - b.expectedAttemptCost ||
          a.model.id.localeCompare(b.model.id),
    );
    ids = ordered.slice(0, 1).map((c) => c.model.id);
  }
  const candidates = ids.map((id) => compatible.find((c) => c.model.id === id));
  if (!ids.length || candidates.some((c) => !c))
    throw Error(
      "Benchmark plan cannot be executed by the frozen compatible candidate pool",
    );
  const initial = candidates[0]!;
  return freezeExecutionPolicy({
    ...base,
    id: `${base.id}:benchmark:${arm}`,
    initialModel: initial.model.id,
    initialCandidate: initial,
    approvedCandidateSet: candidates as NonNullable<
      (typeof candidates)[number]
    >[],
    type: ids.length > 1 ? "cascade" : "single",
    qualityCascadeModelIds: ids.slice(1),
    operationalRecoveryModelIds: [],
    ...(arm.startsWith("calibration:")
      ? { executionEngine: "agentic" as const, maxCodingAttempts: 1 }
      : {}),
    orderedRecoveryModelIds: [],
    referenceModel: decision?.reference ?? base.referenceModel,
    requiredQuality:
      arm === "routing-v1"
        ? decision.selected.finalLower
        : initial.conservativeQuality,
    conservativeQuality:
      arm === "routing-v1"
        ? decision.selected.finalLower
        : initial.conservativeQuality,
    whySelected: `Explicit isolated benchmark arm: ${arm}`,
  });
}

export function configureFixedBenchmarkModel(cfg:Config,model?:string) {
  if(model) {
      if(!cfg.modelPool?.models.some(m=>m.id===model))throw Error("Fixed benchmark model is not configured");
      cfg.forceModel=model;
      cfg.modelPool!.models=cfg.modelPool!.models.filter(m=>m.id===model);
      cfg.routing.authority="legacy";
      cfg.registry=Object.fromEntries(Object.keys(cfg.registry).map(role=>[role,model])) as Config["registry"];
    }
}

export async function benchmarkWorker(jobPath: string) {
  const job = JSON.parse(await readFile(jobPath, "utf8"));
  if (
    job.kind !== "koda-real-benchmark" ||
    (!job.arm.startsWith("calibration:") &&
      !["routing-v1", "current-koda", "strongest", "cheapest"].includes(
        job.arm,
      )) ||
    !(job.budgetUsd > 0)
  )
    throw Error("Invalid explicit benchmark job");
  const original = PoolRouter.prototype.selectExecutionPlan;
  // This override exists only in this dedicated child process. The installed CLI
  // and production routing never load it. All verification remains authoritative.
  PoolRouter.prototype.selectExecutionPlan = async function (...args) {
    const base = job.arm.startsWith("calibration:")
      ? calibrationExecutionPlan(this.config, job.arm, args[0], args[3])
      : await original.apply(this, args);
    const decision = this.logger.events.findLast(
      (e) => e.type === "routing_v1_shadow_decision" && e.subtaskId === args[2],
    )?.decision;
    const plan = job.arm.startsWith("calibration:")
      ? base
      : benchmarkPlan(base, job.arm, decision);
    this.logger.log("real_benchmark_route", {
      engine: plan.executionEngine,
      arm: job.arm,
      subtaskId: args[2],
      models: [plan.initialModel, ...(plan.qualityCascadeModelIds ?? [])],
      reference: plan.referenceModel,
      decision,
    });
    return plan;
  };
  try {
    const cfg = await config(job.config, {
      budgetUsd: job.budgetUsd,
      forceModel: undefined,
    });
    configureBenchmarkRouting(cfg, job.arm);
    configureFixedBenchmarkModel(cfg,job.fixedModel);
    cfg.routing.stateDirectory = job.stateDirectory;
    await run({
      repo: job.repo,
      task: job.task,
      config: cfg,
      output: job.report,
      apply: true,
      ...(job.arm.startsWith("calibration:")
        ? { offlineCalibration: true }
        : {}),
    });
  } finally {
    PoolRouter.prototype.selectExecutionPlan = original;
  }
}
if (process.argv[1]?.endsWith("realBenchmarkWorker.ts"))
  await benchmarkWorker(process.argv[2]!);

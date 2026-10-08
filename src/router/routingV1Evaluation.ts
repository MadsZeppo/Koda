import { z } from "zod";
import { taskAssessmentSchema } from "./taskAssessment.js";
import { verificationContractSchema } from "../verifier/contract.js";
import { modelSchema, metadataSchema } from "./pool.js";
import {
  optimizeRoutingV1,
  routingEvidenceSchema,
  routingFamilies,
  type RescueEvidence,
} from "./routingV1.js";
import { optimizeSpecialists } from "./routeOptimizer.js";
import type { TaskFingerprint } from "./taskFingerprint.js";
import type { Features } from "./features.js";
import type { Config } from "../config.js";
export const routingDatasetSchema = z
  .object({
    version: z.literal(1),
    provenance: z.string().min(1),
    synthetic: z.boolean().default(false),
    models: z
      .array(
        z.object({
          model: modelSchema,
          metadata: metadataSchema,
          vision: z.boolean().default(false),
          configured: z.boolean().default(true),
          evidence: z.array(z.any()).default([]),
        }),
      )
      .min(1),
    priors: z.array(routingEvidenceSchema),
    localHistory: z.array(routingEvidenceSchema).default([]),
    rescueEvidence: z
      .array(
        z.object({
          initial: z.string(),
          rescue: z.string(),
          taskFamily: z.enum(routingFamilies),
          engine: z.string(),
          successes: z.number().int().nonnegative(),
          failures: z.number().int().nonnegative(),
          provenance: z.string(),
        }),
      )
      .default([]),
    tasks: z
      .array(
        z.object({
          id: z.string().min(1),
          split: z.enum(["development", "holdout"]),
          assessment: taskAssessmentSchema,
          contract: verificationContractSchema,
          fingerprint: z.custom<TaskFingerprint>(
            (v) =>
              typeof v === "object" &&
              v !== null &&
              "executionStrategy" in v &&
              "difficulty" in v,
          ),
          features: z.custom<Features>(
            (v) =>
              typeof v === "object" &&
              v !== null &&
              "contextBytes" in v &&
              "languages" in v,
          ),
          outcomes: z.record(
            z.object({
              verified: z.boolean(),
              groundTruthPass: z.boolean(),
              costUsd: z.number().finite().nonnegative(),
              wallClockMs: z.number().finite().nonnegative(),
            }),
          ),
        }),
      )
      .min(1),
  })
  .superRefine((data, ctx) => {
    const ids = data.tasks.map((t) => t.id),
      models = data.models.map((m) => m.model.id);
    if (
      new Set(ids).size !== ids.length ||
      new Set(models).size !== models.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate task/model IDs" });
    if (
      [...data.priors, ...data.localHistory].some((r) => ids.includes(r.taskId))
    )
      ctx.addIssue({
        code: "custom",
        message: "Evaluation outcome leaked into training evidence",
      });
    for (const task of data.tasks)
      if (models.some((id) => !task.outcomes[id]))
        ctx.addIssue({
          code: "custom",
          message: `Incomplete matrix: ${task.id}`,
        });
  });
export type RoutingDataset = z.infer<typeof routingDatasetSchema>;
export function calibration(
  rows: readonly { prediction: number; success: boolean }[],
) {
  const buckets = [
    [0, 0.7],
    [0.7, 0.8],
    [0.8, 0.9],
    [0.9, 0.95],
    [0.95, 1.000001],
  ].map(([lo, hi]) => {
    const selected = rows.filter(
      (r) => r.prediction >= lo! && r.prediction < hi!,
    );
    return {
      lower: lo,
      upper: Math.min(hi!, 1),
      count: selected.length,
      predicted: selected.length
        ? selected.reduce((n, r) => n + r.prediction, 0) / selected.length
        : null,
      observed: selected.length
        ? selected.filter((r) => r.success).length / selected.length
        : null,
    };
  });
  return {
    brier: rows.length
      ? rows.reduce((n, r) => n + (r.prediction - Number(r.success)) ** 2, 0) /
        rows.length
      : null,
    ece: rows.length
      ? buckets.reduce(
          (n, b) =>
            n + b.count * Math.abs((b.predicted ?? 0) - (b.observed ?? 0)),
          0,
        ) / rows.length
      : null,
    buckets,
  };
}
const percentile = (values: number[], p: number) =>
  values.length
    ? [...values].sort((a, b) => a - b)[
        Math.min(values.length - 1, Math.ceil(values.length * p) - 1)
      ]!
    : null;
export function evaluateRoutingV1(
  dataset: RoutingDataset,
  config: Config,
  options: {
    split?: "development" | "holdout";
    learned?: boolean;
    families?: string[];
  } = {},
) {
  const data = routingDatasetSchema.parse(dataset),
    rows: any[] = [],
    overhead: number[] = [],
    predictions: { prediction: number; success: boolean }[] = [];
  const evidence = [
    ...data.priors,
    ...(options.learned ? data.localHistory : []),
  ];
  for (const task of data.tasks.filter(
    (t) => !options.split || t.split === options.split,
  )) {
    // Outcomes are not included in either optimizer or shadow inputs.
    const route = optimizeSpecialists(
      data.models,
      task.fingerprint,
      task.features,
      [],
      config,
      config.budgetUsd,
    );
    const decision = optimizeRoutingV1(
      {
        assessment: task.assessment,
        contract: task.contract,
        fingerprint: task.fingerprint,
        models: data.models,
        evidence,
        rescueEvidence: data.rescueEvidence as RescueEvidence[],
        budgetUsd: config.budgetUsd,
        inputTokens: Math.ceil(task.features.contextBytes / 4) + 256,
        outputTokens: config.maxOutputTokens,
        requiredParameters: ["tools", "tool_choice"],
        allowSynthetic: data.synthetic,
      },
      task.features,
      config,
    );
    if (options.families?.length && !options.families.includes(decision.family))
      continue;
    overhead.push(decision.overheadMs);
    const compatible = new Set(
      decision.candidates.filter((c) => !c.reasons.length).map((c) => c.model),
    );
    const cheapest = decision.candidates
      .filter((c) => compatible.has(c.model))
      .sort((a, b) => a.cost - b.cost)[0]?.model;
    // Oracle outcomes are accessed only AFTER routing decisions are frozen.
    const oracle = Object.entries(task.outcomes)
      .filter(
        ([id, o]) => compatible.has(id) && o.verified && o.groundTruthPass,
      )
      .sort(
        (a, b) =>
          a[1].costUsd - b[1].costUsd || a[1].wallClockMs - b[1].wallClockMs,
      )[0]?.[0];
    const strategies: { name: string; models: string[] }[] = [
      { name: "routing_v1", models: decision.selected?.models ?? [] },
      {
        name: "strongest",
        models: decision.reference ? [decision.reference] : [],
      },
      { name: "cheapest", models: cheapest ? [cheapest] : [] },
      {
        name: "current",
        models:
          route.selectedPlan?.models ?? route.cascade.map((c) => c.model.id),
      },
      { name: "oracle", models: oracle ? [oracle] : [] },
    ];
    for (const strategy of strategies) {
      let cost = 0,
        latency = 0,
        attempts = 0,
        verified = false,
        falseAccept = false,
        referenceCalls = 0,
        failedCheapTrials = 0;
      for (const id of strategy.models.slice(0, 2)) {
        const result = task.outcomes[id];
        if (!result) break;
        attempts++;
        cost += result.costUsd;
        latency += result.wallClockMs;
        referenceCalls += Number(id === decision.reference);
        failedCheapTrials += Number(id === cheapest && !result.verified);
        if (result.verified) {
          verified = result.groundTruthPass;
          falseAccept = !result.groundTruthPass;
          break;
        }
      }
      rows.push({
        id: task.id,
        family: decision.family,
        strategy: strategy.name,
        models: strategy.models,
        cost,
        latency,
        attempts,
        verified,
        falseAccept,
        referenceCalls,
        failedCheapTrials,
        oracleCost: oracle ? task.outcomes[oracle]!.costUsd : null,
        oracleLatency: oracle ? task.outcomes[oracle]!.wallClockMs : null,
        strongestSolved: decision.reference
          ? task.outcomes[decision.reference]!.verified &&
            task.outcomes[decision.reference]!.groundTruthPass
          : null,
      });
    }
    if (decision.selected)
      predictions.push({
        prediction: decision.selected.finalMean,
        success: rows.findLast(
          (r) => r.id === task.id && r.strategy === "routing_v1",
        )!.verified,
      });
  }
  function metrics(selected: typeof rows) {
    const solved = selected.filter((r) => r.verified).length,
      cost = selected.reduce((n, r) => n + r.cost, 0),
      latency = selected.reduce((n, r) => n + r.latency, 0);
    return {
      tasks: selected.length,
      verifiedSolves: solved,
      solveRate: selected.length ? solved / selected.length : null,
      criticalFalseAccepts: selected.filter((r) => r.falseAccept).length,
      costUsd: cost,
      costPerVerified: solved ? cost / solved : null,
      wallClockPerVerifiedMs: solved ? latency / solved : null,
      attempts: selected.reduce((n, r) => n + r.attempts, 0),
      referenceCallRate: selected.length
        ? selected.reduce((n, r) => n + r.referenceCalls, 0) / selected.length
        : null,
      qualityRegretVsStrongest: selected.length
        ? selected.reduce(
            (n, r) => n + Number(r.strongestSolved) - Number(r.verified),
            0,
          ) / selected.length
        : null,
      costRegretVsOracle: selected.reduce(
        (n, r) =>
          n +
          (!r.verified || r.oracleCost === null ? 0 : r.cost - r.oracleCost),
        0,
      ),
      latencyRegretVsOracleMs: selected.reduce(
        (n, r) =>
          n +
          (!r.verified || r.oracleLatency === null
            ? 0
            : r.latency - r.oracleLatency),
        0,
      ),
      unresolvedWithOracleAvailable: selected.filter(
        (r) => !r.verified && r.oracleCost !== null,
      ).length,
      unnecessaryReferenceCalls: selected.filter(
        (r) =>
          r.referenceCalls && r.oracleCost !== null && r.cost > r.oracleCost,
      ).length,
      failedCheapTrials: selected.reduce((n, r) => n + r.failedCheapTrials, 0),
    };
  }
  return {
    version: 1,
    provenance: data.provenance,
    synthetic: data.synthetic,
    localHistory: options.learned ? "learned" : "empty",
    split: options.split ?? "all",
    baselines: Object.fromEntries(
      ["routing_v1", "strongest", "cheapest", "current", "oracle"].map(
        (name) => [name, metrics(rows.filter((r) => r.strategy === name))],
      ),
    ),
    categories: Object.fromEntries(
      [...new Set(rows.map((r) => r.family))].map((family) => [
        family,
        metrics(
          rows.filter(
            (r) => r.family === family && r.strategy === "routing_v1",
          ),
        ),
      ]),
    ),
    calibration: calibration(predictions),
    routingOverheadMs: {
      p50: percentile(overhead, 0.5),
      p95: percentile(overhead, 0.95),
    },
    rows,
  };
}

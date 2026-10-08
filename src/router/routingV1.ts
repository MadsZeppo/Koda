import { z } from "zod";
import type { TaskAssessmentV1 } from "./taskAssessment.js";
import type { VerificationContractV1 } from "../verifier/contract.js";
import type { FailureAttributionV1 } from "../agent/failureAttribution.js";
import type { SpecialistModel } from "./capabilityRegistry.js";
import { optimizeSpecialists, type SpecialistRoute } from "./routeOptimizer.js";
import type { Config } from "../config.js";
import type { Features } from "./features.js";
import type { Attempt, OperationalCall } from "./history.js";
import type { TaskFingerprint } from "./taskFingerprint.js";
import { supportsParameters } from "./pool.js";

export const routingFamilies = [
  "small_localized",
  "debugging",
  "backend_api",
  "security",
  "frontend_functional",
  "frontend_visual",
  "refactor",
  "multi_file",
  "architecture",
  "tests_only",
  "config_tooling",
] as const;
export type RoutingFamily = (typeof routingFamilies)[number];
export const routingEvidenceSchema = z
  .object({
    id: z.string().min(1),
    taskId: z.string().min(1),
    model: z.string().min(1),
    modelFamily: z.string().min(1),
    taskFamily: z.enum(routingFamilies),
    complexity: z.enum(["trivial", "low", "medium", "high"]),
    engine: z.string().min(1),
    source: z.enum(["controlled", "external", "local", "synthetic"]),
    provenance: z.string().min(1),
    success: z.boolean(),
    costUsd: z.number().finite().nonnegative(),
    wallClockMs: z.number().finite().nonnegative(),
    outcome: z
      .enum(["VERIFIED_SUCCESS", "FAILED", "NOT_FULLY_VERIFIED"])
      .optional(),
    attribution: z
      .object({
        primaryCause: z.string(),
        learningDisposition: z.enum(["CENSORED", "NEGATIVE_MODEL_EVIDENCE"]),
      })
      .optional(),
  })
  .superRefine((row, ctx) => {
    if (row.source !== "local") return;
    if (
      row.success
        ? row.outcome !== "VERIFIED_SUCCESS"
        : row.attribution?.primaryCause !== "MODEL_FAILURE" ||
          row.attribution.learningDisposition !== "NEGATIVE_MODEL_EVIDENCE"
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Local quality evidence requires verified success or Attribution-approved model failure",
      });
  });
export type RoutingEvidence = z.infer<typeof routingEvidenceSchema>;
export interface RescueEvidence {
  initial: string;
  rescue: string;
  taskFamily: RoutingFamily;
  engine: string;
  successes: number;
  failures: number;
  provenance: string;
}
export function routingFamily(
  assessment: TaskAssessmentV1,
  fp: TaskFingerprint,
): RoutingFamily {
  if (assessment.riskFlags.security) return "security";
  if (assessment.riskFlags.architecture || fp.taskFamily === "architecture")
    return "architecture";
  if (fp.visualRelevant) return "frontend_visual";
  if (fp.taskFamily === "frontend_ui") return "frontend_functional";
  if (fp.taskFamily === "backend_api" || fp.taskFamily === "database")
    return "backend_api";
  if (fp.taskFamily === "debugging" || fp.taskFamily === "localized_bugfix")
    return "debugging";
  if (fp.taskFamily === "refactor") return "refactor";
  if (fp.taskFamily === "test_change") return "tests_only";
  if (assessment.riskFlags.config || fp.taskFamily === "devops")
    return "config_tooling";
  return assessment.scope === "tiny" || assessment.scope === "local"
    ? "small_localized"
    : "multi_file";
}
/** A separate ledger: shadow learning cannot change production History. */
export function qualityLearningLabel(
  status: string,
  attribution?: Pick<
    FailureAttributionV1,
    "primaryCause" | "learningDisposition"
  >,
  synthetic = false,
): boolean | null {
  if (synthetic) return null;
  if (status === "VERIFIED_SUCCESS") return true;
  return attribution?.primaryCause === "MODEL_FAILURE" &&
    attribution.learningDisposition === "NEGATIVE_MODEL_EVIDENCE"
    ? false
    : null;
}
const clamp = (value: number) => Math.max(0, Math.min(1, value));
function posterior(successes: number, failures: number) {
  // Uniform regularization expresses ignorance; it is not a supplied quality probability.
  const a = successes + 1,
    b = failures + 1,
    mean = a / (a + b);
  const uncertainty = Math.sqrt((a * b) / ((a + b) ** 2 * (a + b + 1)));
  return {
    mean,
    uncertainty,
    lower: clamp(mean - 1.64 * uncertainty),
    samples: successes + failures,
  };
}
export function estimateRoutingQuality(
  model: string,
  modelFamily: string,
  taskFamily: RoutingFamily,
  complexity: TaskAssessmentV1["implementationComplexity"],
  engine: string,
  evidence: readonly RoutingEvidence[],
  allowSynthetic = false,
) {
  const rows = [
    ...new Map(evidence.map((row) => [row.id, row])).values(),
  ].filter(
    (row) =>
      row.engine === engine && (allowSynthetic || row.source !== "synthetic"),
  );
  const levels = [
    { name: "global", match: (_: RoutingEvidence) => true },
    {
      name: "model_family",
      match: (r: RoutingEvidence) => r.modelFamily === modelFamily,
    },
    {
      name: "model_task",
      match: (r: RoutingEvidence) =>
        r.model === model && r.taskFamily === taskFamily,
    },
    {
      name: "model_task_complexity",
      match: (r: RoutingEvidence) =>
        r.model === model &&
        r.taskFamily === taskFamily &&
        r.complexity === complexity,
    },
    {
      name: "local",
      match: (r: RoutingEvidence) =>
        r.model === model &&
        r.taskFamily === taskFamily &&
        r.complexity === complexity &&
        r.source === "local",
    },
  ];
  let successes = 0,
    failures = 0;
  const provenance: {
    level: string;
    ids: string[];
    effectiveSamples: number;
  }[] = [];
  for (let index = 0; index < levels.length; index++) {
    const level = levels[index]!,
      next = levels[index + 1];
    // Disjoint levels avoid counting granular observations again in each ancestor.
    const selected = rows.filter(
      (row) => level.match(row) && (!next || !next.match(row)),
    );
    const total = selected.reduce(
      (n, r) => n + (r.source === "external" ? 0.1 : 1),
      0,
    );
    const cap =
      index >= levels.length - 2 ? 1 : Math.min(1, 12 / Math.max(1, total));
    const externalWeight =
      selected.filter((r) => r.source === "external").length * 0.1;
    let effectiveSamples = 0;
    for (const row of selected) {
      const weight =
        cap *
        (row.source === "external"
          ? 0.1 * Math.min(1, 1 / Math.max(1, externalWeight))
          : 1);
      effectiveSamples += weight;
      if (row.success) successes += weight;
      else failures += weight;
    }
    provenance.push({
      level: level.name,
      ids: selected.map((r) => r.id),
      effectiveSamples,
    });
  }
  return {
    ...posterior(successes, failures),
    modelSamples: rows
      .filter((r) => r.model === model && r.taskFamily === taskFamily)
      .reduce((n, r) => n + (r.source === "external" ? 0.1 : 1), 0),
    provenance,
  };
}
export interface RoutingV1Input {
  assessment: TaskAssessmentV1;
  contract: VerificationContractV1;
  fingerprint: TaskFingerprint;
  models: readonly SpecialistModel[];
  route: SpecialistRoute;
  evidence: readonly RoutingEvidence[];
  rescueEvidence?: readonly RescueEvidence[];
  budgetUsd: number;
  inputTokens: number;
  outputTokens: number;
  requiredParameters: readonly string[];
  shortlistSize?: number;
  costWeight?: number;
  latencyWeight?: number;
  allowSynthetic?: boolean;
  efficiencyHistory?: Attempt[];
  operations?: OperationalCall[];
}
export function decideRoutingV1(input: RoutingV1Input) {
  const started = performance.now(),
    family = routingFamily(input.assessment, input.fingerprint);
  const size = Math.max(5, Math.min(10, input.shortlistSize ?? 8));
  const safeExploration =
    input.contract.overallStrength === "strong" &&
    input.contract.overallFalseAcceptRisk === "low" &&
    input.contract.requirements.length > 0 &&
    input.contract.requirements.every(
      (r) =>
        r.strength === "strong" &&
        r.proofAvailability === "available" &&
        r.falseAcceptRisk === "low",
    ) &&
    input.assessment.consequenceRisk === "low" &&
    !Object.values(input.assessment.riskFlags).some(Boolean) &&
    ["tiny", "local"].includes(input.assessment.scope) &&
    input.assessment.localizationDifficulty === "easy" &&
    input.assessment.confidence.overall >= 0.8;
  const allowedRegret = safeExploration ? 0.02 : 0.005;
  const candidates = input.models.map(({ model, metadata, vision }) => {
    const reasons: string[] = [];
    if (!model.enabled || metadata.available === false)
      reasons.push("unavailable");
    if (input.fingerprint.visionRequired && !vision)
      reasons.push("vision_required");
    if (
      metadata.supportedParameters === undefined &&
      metadata.routableParameterSets === undefined
    )
      reasons.push("capability_unknown");
    else if (!supportsParameters(metadata, input.requiredParameters))
      reasons.push("tool_protocol");
    if (
      !metadata.contextLength ||
      input.inputTokens + input.outputTokens > metadata.contextLength
    )
      reasons.push("context_capacity");
    if (
      !metadata.maxOutputTokens ||
      input.outputTokens > metadata.maxOutputTokens
    )
      reasons.push("output_capacity");
    if (metadata.inputPrice === undefined || metadata.outputPrice === undefined)
      reasons.push("price_unknown");
    const cost =
      (input.inputTokens * (metadata.inputPrice ?? Infinity) +
        input.outputTokens * (metadata.outputPrice ?? Infinity)) /
      1e6;
    if (cost > input.budgetUsd) reasons.push("budget");
    const estimate = reasons.length
      ? { ...posterior(0, 0), modelSamples: 0, provenance: [] }
      : estimateRoutingQuality(
          model.id,
          input.evidence.find((r) => r.model === model.id)?.modelFamily ??
            model.id.split("/")[0]!,
          family,
          input.assessment.implementationComplexity,
          input.fingerprint.executionStrategy,
          input.evidence,
          input.allowSynthetic,
        );
    const executionEvidence = input.route.considered.find(
      (c) => c.model.id === model.id,
    );
    return {
      model: model.id,
      provider: model.id.split("/")[0],
      modelFamily:
        input.evidence.find((r) => r.model === model.id)?.modelFamily ??
        model.id.split("/")[0],
      metadata,
      operationalErrorRate: executionEvidence?.operationalErrorRate ?? null,
      latencyEvidenceKnown: executionEvidence?.latencyEvidenceKnown ?? false,
      ...estimate,
      cost,
      reasons,
    };
  });
  const compatible = candidates.filter((c) => !c.reasons.length);
  const qualityOrder = [...compatible].sort(
    (a, b) =>
      b.lower - a.lower ||
      b.mean - a.mean ||
      a.cost - b.cost ||
      a.model.localeCompare(b.model),
  );
  const reference = qualityOrder.find(
    (c) => c.modelSamples >= 3 && c.samples >= 3,
  );
  const shortlist = new Set(
    qualityOrder.slice(0, Math.ceil(size / 2)).map((c) => c.model),
  );
  if (reference) shortlist.add(reference.model);
  for (const c of [...compatible].sort(
    (a, b) => a.cost - b.cost || a.model.localeCompare(b.model),
  )) {
    if (shortlist.size >= size) break;
    shortlist.add(c.model);
  }
  const plans = input.route.plans
    .filter(
      (p) => p.models.length <= 2 && p.models.every((id) => shortlist.has(id)),
    )
    .map((p) => {
      const initial = compatible.find((c) => c.model === p.models[0])!,
        rescue = compatible.find((c) => c.model === p.models[1]);
      const paired = input.rescueEvidence?.filter(
        (r) =>
          r.initial === initial.model &&
          r.rescue === rescue?.model &&
          r.taskFamily === family &&
          r.engine === input.fingerprint.executionStrategy,
      );
      const successes = paired?.reduce((n, r) => n + r.successes, 0) ?? 0,
        failures = paired?.reduce((n, r) => n + r.failures, 0) ?? 0;
      const conditional =
        successes + failures >= 3 ? posterior(successes, failures) : null;
      // Without paired evidence use a Fréchet bound, never independent success.
      const finalMean = rescue
        ? conditional
          ? initial.mean + (1 - initial.mean) * conditional.mean
          : Math.max(initial.mean, rescue.mean)
        : initial.mean;
      const finalLower = rescue
        ? conditional
          ? initial.lower + (1 - initial.lower) * conditional.lower
          : Math.max(initial.lower, rescue.lower)
        : initial.lower;
      const reasons = p.hardRejection ? [p.hardRejection] : [];
      if (!reference) reasons.push("no_credible_reference");
      else if (finalLower < reference.lower - allowedRegret)
        reasons.push("final_quality_regret");
      const exploring =
        !!reference && initial.lower < reference.lower - allowedRegret;
      if (
        (exploring || initial.modelSamples < 3) &&
        (!safeExploration || !rescue || rescue.modelSamples < 3)
      )
        reasons.push("unsafe_exploration");
      if (rescue && initial.cost + rescue.cost > input.budgetUsd)
        reasons.push("recovery_budget");
      // Existing optimizer supplies measured full-plan latency and economics.
      const initialWork = input.route.considered.find(
        (c) => c.model.id === initial.model,
      );
      const rescueWork = input.route.considered.find(
        (c) => c.model.id === rescue?.model,
      );
      const initialCost = initialWork?.expectedAttemptCost ?? initial.cost;
      const rescueCost = rescueWork?.expectedAttemptCost ?? rescue?.cost ?? 0;
      const failureProbability = 1 - initial.mean;
      const expectedCost = initialCost + failureProbability * rescueCost;
      if (initialCost + rescueCost > input.budgetUsd)
        reasons.push("full_plan_budget");
      const expectedLatencyMs =
        (initialWork?.expectedAttemptLatencyMs ??
          p.expectedCompletionLatencyMs) +
        (rescue
          ? failureProbability *
            (rescueWork?.expectedAttemptLatencyMs ??
              p.expectedCompletionLatencyMs)
          : 0);
      return {
        models: p.models,
        finalMean,
        finalLower,
        conditionalRescue: conditional,
        conditionalProvenance: paired?.map((r) => r.provenance) ?? [],
        expectedCost,
        expectedLatencyMs,
        costPerVerified: expectedCost / Math.max(finalMean, 0.001),
        latencyPerVerified: expectedLatencyMs / Math.max(finalMean, 0.001),
        exploration: exploring,
        reasons,
      };
    });
  const referencePlanQuality = Math.max(
    reference?.lower ?? 0,
    ...plans.filter((p) => !p.reasons.length).map((p) => p.finalLower),
  );
  for (const plan of plans)
    if (
      plan.finalLower < referencePlanQuality - allowedRegret &&
      !plan.reasons.includes("final_quality_regret")
    )
      plan.reasons.push("final_quality_regret");
  const eligible = plans.filter((p) => !p.reasons.length);
  const maxCost = Math.max(...eligible.map((p) => p.costPerVerified), 0.001),
    maxLatency = Math.max(...eligible.map((p) => p.latencyPerVerified), 1);
  const scored = eligible
    .map((p) => ({
      ...p,
      score:
        ((input.costWeight ?? 0.55) * p.costPerVerified) / maxCost +
        ((input.latencyWeight ?? 0.45) * p.latencyPerVerified) / maxLatency,
    }))
    .sort(
      (a, b) =>
        a.score - b.score ||
        a.expectedLatencyMs - b.expectedLatencyMs ||
        a.models.length - b.models.length ||
        a.models.join().localeCompare(b.models.join()),
    );
  return {
    version: 1,
    mode: "shadow" as const,
    family,
    fingerprint: input.fingerprint,
    assessment: input.assessment,
    contract: input.contract,
    requiredParameters: input.requiredParameters,
    candidates,
    shortlist: [...shortlist],
    reference: reference?.model ?? null,
    referenceQuality: reference?.lower ?? null,
    referencePlanQuality,
    allowedRegret,
    safeExploration,
    stageRecommendation:
      safeExploration && input.assessment.implementationComplexity !== "high"
        ? "localized_one_attempt_targeted_verification"
        : "retain_existing_planned_strategy",
    plans,
    selected: scored[0] ?? null,
    overheadMs: performance.now() - started,
  };
}

/** Existing plan generator, with isolated canonical shadow inputs. Legacy tier
 * labels cannot exclude a model from the V1 shadow pool. No live calls/history. */
export function optimizeRoutingV1(
  input: Omit<RoutingV1Input, "route">,
  features: Features,
  config: Config,
) {
  const started = performance.now();
  const family = routingFamily(input.assessment, input.fingerprint);
  const fp: TaskFingerprint = {
    ...input.fingerprint,
    verificationStrength: input.contract.overallStrength,
    verifierFalseAcceptRisk: input.contract.overallFalseAcceptRisk,
    consequenceRisk: input.assessment.consequenceRisk,
    scope:
      input.assessment.scope === "tiny"
        ? "single"
        : input.assessment.scope === "local"
          ? "localized"
          : input.assessment.scope === "multi_file"
            ? "multi-file"
            : "cross-component",
    publicApiRisk: input.assessment.riskFlags.publicApi,
    schemaRisk: input.assessment.riskFlags.database,
    configRisk: input.assessment.riskFlags.config,
    concurrencyRisk: input.assessment.riskFlags.concurrency,
  };
  const prefilter = decideRoutingV1({
    ...input,
    fingerprint: fp,
    route: {
      cascade: [],
      considered: [],
      plans: [],
      allowedRegret: 0,
      reason: "prefilter",
    },
  });
  const shortlist = new Set(prefilter.shortlist);
  const neutralModels = input.models
    .filter((model) => shortlist.has(model.model.id))
    .map((model) => ({
      ...model,
      model: {
        ...model.model,
        tier: "strong" as const,
        qualityPrior: estimateRoutingQuality(
          model.model.id,
          input.evidence.find((r) => r.model === model.model.id)?.modelFamily ??
            model.model.id.split("/")[0]!,
          family,
          input.assessment.implementationComplexity,
          fp.executionStrategy,
          input.evidence,
          input.allowSynthetic,
        ).mean,
      },
    }));
  const route = optimizeSpecialists(
    neutralModels,
    fp,
    { ...features },
    [],
    config,
    input.budgetUsd,
    input.operations ?? [],
    new Set(),
    input.efficiencyHistory ?? [],
  );
  const decision = decideRoutingV1({ ...input, fingerprint: fp, route });
  const report = { ...decision, taskFeatures: { fingerprint: fp, features } };
  report.overheadMs = performance.now() - started;
  return report;
}

export function chooseRoutingV1Joint(
  entries: readonly {
    strategy: string;
    decision: ReturnType<typeof decideRoutingV1>;
    prerequisiteCostUsd?: number;
    prerequisiteLatencyMs?: number;
  }[],
  budgetUsd: number,
  costWeight: number,
  latencyWeight: number,
) {
  const referenceQuality = Math.max(
    0,
    ...entries.map((e) => e.decision.referencePlanQuality),
  );
  const regret = Math.min(
    0.02,
    ...entries.map((e) => e.decision.allowedRegret),
  );
  const plans = entries.flatMap((entry) =>
    entry.decision.plans
      .filter((p) => !p.reasons.length)
      .map((plan) => {
        const cost = plan.expectedCost + (entry.prerequisiteCostUsd ?? 0);
        const latency =
          plan.expectedLatencyMs + (entry.prerequisiteLatencyMs ?? 0);
        return {
          strategy: entry.strategy,
          models: plan.models,
          quality: plan.finalLower,
          cost,
          latency,
          costPerVerified: cost / Math.max(plan.finalMean, 0.001),
          latencyPerVerified: latency / Math.max(plan.finalMean, 0.001),
          eligible:
            plan.finalLower >= referenceQuality - regret && cost <= budgetUsd,
        };
      }),
  );
  const eligible = plans.filter((p) => p.eligible);
  const maxCost = Math.max(0.001, ...eligible.map((p) => p.costPerVerified)),
    maxLatency = Math.max(1, ...eligible.map((p) => p.latencyPerVerified));
  const ranked = eligible
    .map((p) => ({
      ...p,
      score:
        (costWeight * p.costPerVerified) / maxCost +
        (latencyWeight * p.latencyPerVerified) / maxLatency,
    }))
    .sort(
      (a, b) =>
        a.score - b.score ||
        a.latency - b.latency ||
        a.models.length - b.models.length,
    );
  return {
    mode: "shadow",
    referenceQuality,
    allowedRegret: regret,
    plans,
    selected: ranked[0] ?? null,
  };
}

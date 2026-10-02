import type { Config } from "../config.js";
import type { PoolRouter } from "../router/modelRouter.js";
import type { PoolModel, Metadata } from "../router/pool.js";
import type { Attempt, OperationalCall } from "../router/history.js";
import type { Features } from "../router/features.js";
import type { PlannerComplexity } from "./policy.js";
import { supportsParameters } from "../router/pool.js";
export interface PlannerCandidate {
  model: PoolModel;
  quality: number;
  latency: number;
  cost: number;
  score: number;
  estimatedCallCost: number;
  rejected?: string;
}
async function plannerRanking(
  pool: PoolRouter,
  features: Features,
  inputBound: number,
  remainingBudgetUsd: number,
  remainingTokens: number,
) {
  const catalog = await pool.catalog.get();
  const discovered = pool.capabilities?.all
    ? await pool.capabilities.all()
    : pool.config.modelPool!.models.map((model) => ({
        model,
        metadata: catalog.get(model.id) ?? model.fallback ?? {},
      }));
  const allowed = pool.config.routing.plannerCandidates;
  const configured = new Set(pool.config.modelPool!.models.map((model) => model.id));
  const specialists = discovered.filter((candidate) =>
    !allowed || allowed.includes(candidate.model.id));
  return rankPlanners(
    specialists.map(({ model }) => configured.has(model.id) ? model : {
      ...model,
      // Discovery alone is not evidence of strong planning capability.
      plannerQualityPrior: model.plannerQualityPrior ??
        Math.min(model.qualityPrior, pool.config.planner.qualityPrior),
    }),
    new Map(specialists.map((candidate) =>
      [candidate.model.id, {
        ...catalog.get(candidate.model.id),
        ...candidate.metadata,
        routableParameterSets: candidate.metadata.routableParameterSets ??
          catalog.get(candidate.model.id)?.routableParameterSets,
      }] as const)),
    pool.history.read(),
    features.complexity as PlannerComplexity,
    pool.config.planner,
    inputBound,
    Math.min(pool.config.planner.maxOutputTokens, pool.config.maxOutputTokens),
    remainingBudgetUsd,
    remainingTokens,
    pool.history.readOperations?.() ?? [],
  );
}

/** Plan-specific prerequisite used before a Planned coding trajectory competes. */
export async function bestExecutablePlanner(
  pool: PoolRouter,
  features: Features,
  inputBound: number,
  remainingBudgetUsd: number,
  remainingTokens: number,
) {
  return (await plannerRanking(
    pool,
    features,
    inputBound,
    remainingBudgetUsd,
    remainingTokens,
  )).find((candidate) => !candidate.rejected && !pool.disabled.has(candidate.model.id));
}
export function rankPlanners(
  models: PoolModel[],
  metadata: Map<string, Metadata>,
  history: Attempt[],
  complexity: PlannerComplexity,
  settings: Config["planner"],
  inputBound: number,
  outputBound: number,
  remainingBudgetUsd = Infinity,
  remainingTokens = Infinity,
  operations: OperationalCall[] = [],
): PlannerCandidate[] {
  return models
    .map((model) => {
      const md = metadata.get(model.id) ?? {};
      const rows = history.filter(
        (r) =>
          r.modelRequested === model.id &&
          r.features.taskKind === "planning" &&
          ["DAG_VALIDATED", "FAILED"].includes(r.verification) &&
          !r.operationalFailure &&
          !(r.verification === "FAILED" && operations.some((operation) =>
            operation.runId === r.runId && operation.subtaskId === r.subtaskId &&
            operation.modelRequested === r.modelRequested && operation.outcome === "error")),
      );
      const similar = rows.filter((r) => r.features.complexity === complexity);
      const n = settings.priorStrength;
      const quality =
        ((model.plannerQualityPrior ?? settings.qualityPrior) * n +
          similar.filter((r) => r.verification === "DAG_VALIDATED").length) /
        (n + similar.length);
      const latency =
        ((model.plannerLatencyPriorMs ?? model.latencyPriorMs) * n +
          rows.reduce((s, r) => s + r.wallClockMs, 0)) /
        (n + rows.length);
      const estimate =
        md.inputPrice === undefined || md.outputPrice === undefined
          ? Infinity
          : (md.inputPrice * inputBound + md.outputPrice * outputBound) / 1e6;
      const charged = rows.filter((r) => r.costUsd !== null);
      const cost =
        (estimate * n + charged.reduce((s, r) => s + r.costUsd!, 0)) /
        (n + charged.length);
      const structured = md.supportedParameters
        ? md.supportedParameters.some(
            (p) => p === "structured_outputs" || p === "response_format",
          )
        : model.strengths.includes("structured_output");
      // compileTask sends a required submit_plan function call. A model-level
      // parameter union is insufficient; one concrete endpoint must support
      // the complete protocol together.
      const planningProtocol = supportsParameters(md, ["tools", "tool_choice"]);
      const observedProtocolFailure = operations.some((operation) =>
        operation.modelRequested === model.id &&
        operation.failureKind === "tool_protocol_incompatible");
      const rejected = !model.enabled
        ? "disabled"
        : model.id.endsWith(":free") || (md.inputPrice === 0 && md.outputPrice === 0)
          ? "free models temporarily disabled"
        : model.id.endsWith(":batch")
          ? "batch endpoint unsupported for interactive planner"
        : md.available === false
          ? "unavailable"
          : !structured
            ? "structured output unsupported"
            : !planningProtocol
              ? "required planning tool protocol unsupported"
            : observedProtocolFailure
              ? "observed planning tool protocol incompatible"
            : !Number.isFinite(estimate)
              ? "unknown pricing"
              : md.contextLength && inputBound + outputBound > md.contextLength
                ? "context limit"
                : inputBound + outputBound > remainingTokens
                  ? "remaining token budget"
                  : estimate > remainingBudgetUsd
                    ? "remaining USD budget"
                    : quality < settings.minimumQuality
                      ? "below planner quality threshold"
                      : undefined;
      const score =
        (settings.costWeight * cost) / settings.costTargetUsd +
        (settings.latencyWeight * latency) / settings.latencyTargetMs;
      return {
        model,
        quality,
        latency,
        cost,
        score,
        estimatedCallCost: estimate,
        rejected,
      };
    })
    .sort((a, b) => a.score - b.score || a.model.id.localeCompare(b.model.id));
}
export async function selectPlanner(
  pool: PoolRouter,
  features: Features,
  phase: "fast" | "strong",
  excluded: string[],
  inputBound: number,
  remainingBudgetUsd = Infinity,
  remainingTokens = Infinity,
) {
  const config = pool.config,
    settings = config.planner;
  const candidates = await plannerRanking(
    pool,
    features,
    inputBound,
    remainingBudgetUsd,
    remainingTokens,
  );
  const available = candidates.filter(
    (c) => !excluded.includes(c.model.id) && !pool.disabled.has(c.model.id),
  );
  const pick = (tier: "fast" | "strong") =>
    available.find(
      (c) =>
        !c.rejected &&
        (tier === "fast"
          ? ["cheap", "fast"].includes(c.model.tier)
          : ["strong", "frontier"].includes(c.model.tier)),
    );
  // Durable failures may lower every estimate below the normal quality gate,
  // but they must not permanently prevent a fresh run from gathering evidence.
  // Recovery still honors every capability/availability/price rejection and
  // the caller's run-local exclusions keep attempts unique inside the run.
  const recoverable = available.filter(
    (candidate) =>
      candidate.rejected === "below planner quality threshold" &&
      (candidate.model.plannerQualityPrior ?? settings.qualityPrior) >=
        settings.minimumQuality,
  );
  const attainableQuality = Math.max(
    -Infinity,
    ...recoverable.map((candidate) => candidate.quality),
  );
  // When all planners have fallen below the configured absolute floor, use
  // their current evidence comparatively. Recovery remains quality-first, but
  // equivalent candidates form a small plateau where completion economics
  // decide. This prevents every fresh run from retrying a known-invalid,
  // expensive planner merely because its configured tier is "strong".
  const recoveryRegret = phase === "strong" ? 0.025 : 0.06;
  const recoverQuality = recoverable
    .filter(
      (candidate) =>
        candidate.quality + 1e-9 >= attainableQuality - recoveryRegret,
    )
    .sort(
      (a, b) =>
        a.score - b.score ||
        b.quality - a.quality ||
        a.model.id.localeCompare(b.model.id),
    )[0];
  const selected = config.forceModel
    ? available.find(
        (c) =>
          c.model.id === config.forceModel &&
          (!c.rejected || c.rejected === "below planner quality threshold"),
      )
    : (pick(phase) ??
      (phase === "fast" ? pick("strong") : pick("fast")) ??
      recoverQuality);
  pool.logger.log("planner_route", {
    subtaskId: "planner",
    planner_model: selected?.model.id ?? null,
    phase,
    estimated_quality: selected?.quality ?? null,
    routing_reason: config.forceModel
      ? "forced evaluation"
      : selected?.rejected === "below planner quality threshold"
        ? "attainable planner quality plateau; lowest completion economics"
      : phase === "strong" &&
          selected &&
          ["cheap", "fast"].includes(selected.model.tier)
        ? "no eligible strong planner; qualified fast planner fallback"
        : phase === "strong"
          ? "complex planning or stronger fallback"
          : selected && ["strong", "frontier"].includes(selected.model.tier)
            ? "no eligible fast planner"
            : "fast structured planner meets quality threshold",
    candidates: candidates.map((c) => ({
      id: c.model.id,
      quality: c.quality,
      latency_est: c.latency,
      cost_est: Number.isFinite(c.cost) ? c.cost : null,
      estimated_call_cost: Number.isFinite(c.estimatedCallCost)
        ? c.estimatedCallCost
        : null,
      score: Number.isFinite(c.score) ? c.score : null,
      rejected: c.rejected,
    })),
  });
  if (!selected)
    throw Error(
      "No untried planner meets quality, capability, availability and pricing requirements",
    );
  return selected.model;
}

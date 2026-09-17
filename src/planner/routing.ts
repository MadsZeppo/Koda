import type { Config } from "../config.js";
import type { PoolRouter } from "../router/modelRouter.js";
import type { PoolModel, Metadata } from "../router/pool.js";
import type { Attempt } from "../router/history.js";
import type { Features } from "../router/features.js";
import type { PlannerComplexity } from "./policy.js";
export interface PlannerCandidate {
  model: PoolModel;
  quality: number;
  latency: number;
  cost: number;
  score: number;
  estimatedCallCost: number;
  rejected?: string;
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
): PlannerCandidate[] {
  return models
    .map((model) => {
      const md = metadata.get(model.id) ?? {};
      const rows = history.filter(
        (r) =>
          r.modelRequested === model.id &&
          r.features.taskKind === "planning" &&
          ["DAG_VALIDATED", "FAILED"].includes(r.verification),
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
      const rejected = !model.enabled
        ? "disabled"
        : md.available === false
          ? "unavailable"
          : !structured
            ? "structured output unsupported"
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
  const candidates = rankPlanners(
    config.modelPool!.models.filter(
      (m) =>
        !config.routing.plannerCandidates ||
        config.routing.plannerCandidates.includes(m.id),
    ),
    await pool.catalog.get(),
    pool.history.read(),
    features.complexity as PlannerComplexity,
    settings,
    inputBound,
    Math.min(settings.maxOutputTokens, config.maxOutputTokens),
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
  // Durable failures may lower an estimate below the normal quality gate, but
  // they must not permanently prevent a fresh run from gathering new evidence.
  // This recovery still honors every capability/availability/price rejection;
  // the caller's run-local excluded set prevents retrying the same planner.
  const recoverQuality = (tier: "fast" | "strong") =>
    available.find(
      (c) =>
        c.rejected === "below planner quality threshold" &&
        (c.model.plannerQualityPrior ?? settings.qualityPrior) >=
          settings.minimumQuality &&
        (tier === "fast"
          ? ["cheap", "fast"].includes(c.model.tier)
          : ["strong", "frontier"].includes(c.model.tier)),
    );
  const selected = config.forceModel
    ? available.find(
        (c) =>
          c.model.id === config.forceModel &&
          (!c.rejected || c.rejected === "below planner quality threshold"),
      )
    : (pick(phase) ??
      (phase === "fast" ? pick("strong") : pick("fast")) ??
      recoverQuality(phase) ??
      (phase === "fast"
        ? recoverQuality("strong")
        : recoverQuality("fast")));
  pool.logger.log("planner_route", {
    subtaskId: "planner",
    planner_model: selected?.model.id ?? null,
    phase,
    estimated_quality: selected?.quality ?? null,
    routing_reason: config.forceModel
      ? "forced evaluation"
      : selected?.rejected === "below planner quality threshold"
        ? "fresh-run retry of planner rejected only by durable quality history"
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

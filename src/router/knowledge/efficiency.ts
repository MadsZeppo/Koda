import type { Attempt, OperationalCall } from "../history.js";
import type { TaskFingerprint } from "../taskFingerprint.js";
import { usesDirectEditEngine } from "../../agent/attemptPolicy.js";
import { normalizeRoutingTaskFamily } from "./identity.js";
import type { ModelRoutingKnowledge, RoutingKnowledgeObservation } from "./schema.js";

const quantile = (values: number[], q: number) => values.length
  ? [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * q)]! : undefined;

const relevant = (rows: RoutingKnowledgeObservation[], fp: TaskFingerprint) => {
  const family = normalizeRoutingTaskFamily(fp.taskFamily ?? fp.primary);
  const exact = rows.filter((row) =>
    (row.taskFamilies ?? []).map(normalizeRoutingTaskFamily).includes(family));
  const familyRows = exact.length ? exact : rows.filter((row) => !row.taskFamilies?.length);
  const candidates = familyRows.length ? familyRows : rows;
  const engine = usesDirectEditEngine(fp) ? "direct-edit" : "mini-swe-agent";
  const exactEngine = candidates.filter((row) => row.engine === engine);
  if (exactEngine.length) return exactEngine;
  const generic = candidates.filter((row) => !row.engine || row.engine === "unknown");
  // Public coding matrices are often dimension-labelled only. When the current
  // task has no matching public dimension, use the model-wide distribution as a
  // weak efficiency prior rather than silently falling back to no data.
  // DirectEdit and an agent loop have fundamentally different trajectories.
  // Do not silently reuse another engine's token/latency distribution.
  return generic;
};
const metric = (rows: RoutingKnowledgeObservation[], name: RoutingKnowledgeObservation["metric"]) => {
  const values = rows.filter((row) => row.metric === name && Number.isFinite(row.value));
  if (!values.length) return undefined;
  const weighted = values.reduce((acc, row) => {
    const weight = Math.max(1, Math.sqrt(row.sampleSize ?? 1));
    return { sum: acc.sum + row.value * weight, weight: acc.weight + weight };
  }, { sum: 0, weight: 0 });
  return weighted.sum / weighted.weight;
};

export interface TokenEfficiencyProfile {
  expectedInputTokens: number;
  expectedOutputTokens: number;
  expectedTotalTokens: number;
  p50TotalTokens: number;
  p75TotalTokens: number;
  p90TotalTokens: number;
  p99TotalTokens: number;
  typicalTurns: number | null;
  cachedTokenRatio: number | null;
  observedCostPerTaskUsd: number | null;
  evidenceUsed: string[];
}

/** Infer the execution scaffold for history written before it was explicit. */
export function observedExecutionEngine(row: Attempt) {
  if (row.executionEngine) return row.executionEngine;
  if (row.contextStrategy === "localized") return "direct-edit" as const;
  if (row.contextStrategy === "agentic") return "mini-swe-agent" as const;
  if (row.fingerprint)
    return usesDirectEditEngine(row.fingerprint)
      ? "direct-edit" as const
      : "mini-swe-agent" as const;
  return undefined;
}

export function estimateEfficiency(fp: TaskFingerprint, contextTokens: number, maxOutputTokens: number,
  knowledge: ModelRoutingKnowledge | undefined, attempts: Attempt[]): TokenEfficiencyProfile {
  const rows = relevant((knowledge?.observations ?? []).filter((row) => row.category === "efficiency"), fp);
  const direct = usesDirectEditEngine(fp);
  const engine = direct ? "direct-edit" : "mini-swe-agent";
  const exactAttempts = attempts.filter((row) => observedExecutionEngine(row) === engine);
  const legacyAttempts = attempts.filter((row) => observedExecutionEngine(row) === undefined);
  const comparableAttempts = exactAttempts.length ? exactAttempts : legacyAttempts;
  const localInputs = comparableAttempts.map((row) => row.inputTokens).filter((n) => n > 0);
  const localOutputs = comparableAttempts.map((row) => row.outputTokens).filter((n) => n > 0);
  const recordedTotal = metric(rows, "total_tokens");
  const observedTurns = metric(rows, "turns");
  const defaultTurns = direct ? 1 : fp.effort === "complex" || fp.scope === "cross-component"
    ? 7 : fp.scope === "multi-file" ? 5 : 4;
  const turns = Math.max(1, Math.ceil(observedTurns ?? defaultTurns));
  const perTurnOutput = direct
    ? Math.min(maxOutputTokens, fp.effort === "complex" ? 1600 : 900)
    : Math.min(maxOutputTokens, fp.effort === "complex" ? 750 : 550);
  const defaultOutput = direct ? perTurnOutput : perTurnOutput * turns;
  // Agentic conversations resend the grounded source and accumulated tool
  // transcript. Sparse evidence must price that complete trajectory, not one
  // completion. Real same-engine observations replace this prior immediately.
  const defaultInput = direct ? contextTokens + 256
    : (contextTokens + 256) * turns + perTurnOutput * turns * (turns - 1) * 0.22;
  const input = quantile(localInputs, 0.5) ?? metric(rows, "input_tokens") ??
    (recordedTotal ? Math.max(contextTokens, recordedTotal * 0.82) : defaultInput);
  const output = quantile(localOutputs, 0.5) ?? metric(rows, "output_tokens") ??
    (recordedTotal ? recordedTotal * 0.18 : defaultOutput);
  const total = Math.max(input + output, recordedTotal ?? 0);
  const sparseP75 = direct ? 1.3 : 1.35;
  const sparseP90 = direct ? 1.6 : 1.8;
  const sparseP99 = direct ? 2.2 : 2.8;
  const p50 = Math.ceil(total);
  const p75 = Math.max(p50, Math.ceil(metric(rows, "total_tokens_p75") ??
    total * (rows.length ? 1.1 : sparseP75)));
  const p90 = Math.max(p75, Math.ceil(metric(rows, "total_tokens_p90") ??
    total * (rows.length ? 1.25 : sparseP90)));
  const p99 = Math.max(p90, Math.ceil(metric(rows, "total_tokens_p99") ??
    total * (rows.length ? 1.5 : sparseP99)));
  return {
    expectedInputTokens: Math.ceil(input), expectedOutputTokens: Math.ceil(output), expectedTotalTokens: Math.ceil(total),
    p50TotalTokens: p50, p75TotalTokens: p75,
    p90TotalTokens: p90, p99TotalTokens: p99,
    typicalTurns: observedTurns ?? turns,
    cachedTokenRatio: metric(rows, "cached_token_ratio") ?? null,
    observedCostPerTaskUsd: metric(rows, "cost_per_task_usd") ?? null,
    evidenceUsed: rows.map((row) => `${row.source}:${row.id}`),
  };
}

export function estimateLatency(priorMs: number, knowledge: ModelRoutingKnowledge | undefined,
  fp: TaskFingerprint, operations: OperationalCall[]) {
  const rows = relevant((knowledge?.observations ?? []).filter((row) => row.category === "efficiency"), fp);
  const samples = operations.map((row) => row.wallClockMs).filter((n) => n >= 0);
  const directOneCall = usesDirectEditEngine(fp);
  const defaultTurns = fp.effort === "complex" || fp.scope === "cross-component"
    ? 7 : fp.scope === "multi-file" ? 5 : 4;

  // Public benchmark completion latency can include whole agent trajectories
  // (multiple turns, tools and verification). That is useful for STABLE and
  // PLANNED work, but it is not comparable to DIRECT's one structured model
  // request. For DIRECT, use real Koda request observations when we have them;
  // otherwise fall back to the model/provider request prior.
  const publicP50 = metric(rows, "completion_latency_p50_ms");
  const publicP90 = metric(rows, "completion_latency_p90_ms");
  const publicP99 = metric(rows, "completion_latency_p99_ms");
  const sparseTrajectoryP50 = priorMs * defaultTurns + 750;
  const callMultiplier = directOneCall ? 1 : defaultTurns;
  const p50 = samples.length >= 3 ? quantile(samples, 0.5)! * callMultiplier
    : directOneCall ? priorMs : publicP50 ?? sparseTrajectoryP50;
  const p90 = samples.length >= 5 ? quantile(samples, 0.9)! * callMultiplier
    : directOneCall ? p50 * 1.8 : publicP90 ?? p50 * 1.8;
  const p99 = samples.length >= 10 ? quantile(samples, 0.99)! * callMultiplier
    : directOneCall ? Math.max(p90, p50 * 2.5) : publicP99 ?? Math.max(p90, p50 * 2.5);
  return { p50, p90, p99, sampleCount: samples.length,
    confidence: samples.length >= 5 || (!directOneCall && rows.length)
      ? "medium" as const : "low" as const };
}

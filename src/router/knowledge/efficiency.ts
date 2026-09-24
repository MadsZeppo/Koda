import type { Attempt, OperationalCall } from "../history.js";
import type { TaskFingerprint } from "../taskFingerprint.js";
import type { ModelRoutingKnowledge, RoutingKnowledgeObservation } from "./schema.js";

const quantile = (values: number[], q: number) => values.length
  ? [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * q)]! : undefined;
const relevant = (rows: RoutingKnowledgeObservation[], fp: TaskFingerprint) => {
  const family = fp.taskFamily ?? fp.primary;
  const exact = rows.filter((row) => row.taskFamilies?.includes(family));
  return exact.length ? exact : rows.filter((row) => !row.taskFamilies?.length);
};
const metric = (rows: RoutingKnowledgeObservation[], name: RoutingKnowledgeObservation["metric"]) =>
  rows.find((row) => row.metric === name)?.value;

export interface TokenEfficiencyProfile {
  expectedInputTokens: number;
  expectedOutputTokens: number;
  expectedTotalTokens: number;
  p75TotalTokens: number;
  p90TotalTokens: number;
  typicalTurns: number | null;
  cachedTokenRatio: number | null;
  observedCostPerTaskUsd: number | null;
  evidenceUsed: string[];
}

export function estimateEfficiency(fp: TaskFingerprint, contextTokens: number, _maxOutputTokens: number,
  knowledge: ModelRoutingKnowledge | undefined, attempts: Attempt[]): TokenEfficiencyProfile {
  const rows = relevant((knowledge?.observations ?? []).filter((row) => row.category === "efficiency"), fp);
  const localInputs = attempts.map((row) => row.inputTokens).filter((n) => n > 0);
  const localOutputs = attempts.map((row) => row.outputTokens).filter((n) => n > 0);
  const recordedTotal = metric(rows, "total_tokens");
  const defaultOutput = fp.effort === "complex" ? 2400 : fp.scope === "single" ? 800 : 1400;
  const input = quantile(localInputs, 0.5) ?? metric(rows, "input_tokens") ??
    (recordedTotal ? Math.max(contextTokens, recordedTotal * 0.82) : contextTokens + 256);
  const output = quantile(localOutputs, 0.5) ?? metric(rows, "output_tokens") ??
    (recordedTotal ? recordedTotal * 0.18 : defaultOutput);
  const total = Math.max(input + output, recordedTotal ?? 0);
  return {
    expectedInputTokens: Math.ceil(input), expectedOutputTokens: Math.ceil(output), expectedTotalTokens: Math.ceil(total),
    p75TotalTokens: Math.ceil(metric(rows, "total_tokens_p75") ?? total * (rows.length ? 1.1 : 1.3)),
    p90TotalTokens: Math.ceil(metric(rows, "total_tokens_p90") ?? total * (rows.length ? 1.25 : 1.6)),
    typicalTurns: metric(rows, "turns") ?? null,
    cachedTokenRatio: metric(rows, "cached_token_ratio") ?? null,
    observedCostPerTaskUsd: metric(rows, "cost_per_task_usd") ?? null,
    evidenceUsed: rows.map((row) => `${row.source}:${row.id}`),
  };
}

export function estimateLatency(priorMs: number, knowledge: ModelRoutingKnowledge | undefined,
  fp: TaskFingerprint, operations: OperationalCall[]) {
  const rows = relevant((knowledge?.observations ?? []).filter((row) => row.category === "efficiency"), fp);
  const samples = operations.map((row) => row.wallClockMs).filter((n) => n >= 0);
  const p50 = samples.length >= 3 ? quantile(samples, 0.5)! : metric(rows, "completion_latency_p50_ms") ?? priorMs;
  const p90 = samples.length >= 5 ? quantile(samples, 0.9)! : metric(rows, "completion_latency_p90_ms") ?? p50 * 1.8;
  return { p50, p90, sampleCount: samples.length, confidence: samples.length >= 5 || rows.length ? "medium" as const : "low" as const };
}

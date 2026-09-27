import { createHash } from "node:crypto";
import { ROUTING_KNOWLEDGE_VERSION, type ExternalEvidenceType,
  type ModelIdentityLevel, type PairwiseRoutingEvidence,
  type RoutingKnowledgeObservation, type RoutingKnowledgeSnapshot,
  type RoutingKnowledgeSource, type RoutingExecutionEngine } from "./schema.js";

export interface ExternalEvidenceRecord {
  taskKey?: string; taskFamily?: string; languages?: string[];
  externalModelName?: string; canonicalModelId?: string; revision?: string;
  reasoningConfig?: string; identityLevel?: ModelIdentityLevel; success?: boolean;
  inputTokens?: number; outputTokens?: number; cachedTokens?: number;
  totalTokens?: number; turns?: number; latencyMs?: number;
  reportedCostUsd?: number; benchmarkScore?: number; marketShare?: number;
  engine?: RoutingExecutionEngine;
}
export interface ExternalTaskDescriptor {
  taskKey: string;
  taskFamily?: string;
  languages?: string[];
  routingTerms: string[];
}
export interface EvidenceSourceInput {
  id: string; type: ExternalEvidenceType; version?: string; date?: string;
  harness?: string; records: ExternalEvidenceRecord[]; tasks?: ExternalTaskDescriptor[];
  engine?: RoutingExecutionEngine;
  /** 0..1 source-level evidence reliability and likely non-contamination. */
  evidenceQuality?: number;
  contaminationConfidence?: number;
}
export type CurrentPricing = Record<string, {
  inputPrice: number; outputPrice: number; cachedInputPrice?: number;
}>;
export interface CatalogIdentity {
  id: string;
  name?: string;
  canonicalSlug?: string;
}

/** Exact strings may attach exactly; unique basename matches are explicit weak transfer only. */
export function resolveSourceIdentities(input: EvidenceSourceInput,
  catalog: CatalogIdentity[]): EvidenceSourceInput {
  return { ...input, records: input.records.map((row) => {
    if (row.identityLevel !== "UNKNOWN" || !row.externalModelName) return row;
    const direct = catalog.find((item) => row.externalModelName === item.id ||
      row.externalModelName === item.canonicalSlug);
    if (direct) return { ...row, canonicalModelId: direct.id, identityLevel: "EXACT" as const };
    const family = catalog.filter((item) => item.id.split("/").at(-1)?.toLowerCase() ===
      row.externalModelName!.toLowerCase());
    if (family.length === 1) return { ...row, canonicalModelId: family[0]!.id,
      identityLevel: "FAMILY_TRANSFER" as const };
    // A benchmark's versioned model label is a stable source identity, though
    // it is not proof of equivalence to a current provider endpoint. Preserve
    // it only as explicit family-transfer evidence so task-level matrices are
    // usable without fabricating an exact canonical mapping.
    return row.revision === row.externalModelName
      ? { ...row, canonicalModelId: row.externalModelName,
          identityLevel: "FAMILY_TRANSFER" as const }
      : row;
  }) };
}
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const identity = (row: ExternalEvidenceRecord) => row.identityLevel ?? "UNKNOWN";
const canonical = (row: ExternalEvidenceRecord) =>
  identity(row) === "UNKNOWN" ? undefined : row.canonicalModelId;
const quantile = (values: number[], q: number) => values.length
  ? [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * q)]! : undefined;
const oid = (source: string, model: string, metric: string, family = "all") =>
  createHash("sha256").update(`${source}\0${model}\0${metric}\0${family}`).digest("hex").slice(0, 20);

/** Same-task model comparisons; no independence assumption is introduced. */
export function pairwiseOutcomes(sourceId: string, records: ExternalEvidenceRecord[]): PairwiseRoutingEvidence[] {
  const tasks = new Map<string, ExternalEvidenceRecord[]>();
  for (const row of records) {
    if (!row.taskKey || identity(row) !== "EXACT" || !row.canonicalModelId || typeof row.success !== "boolean") continue;
    const list = tasks.get(row.taskKey) ?? []; list.push(row); tasks.set(row.taskKey, list);
  }
  const result = new Map<string, PairwiseRoutingEvidence>();
  for (const rows of tasks.values()) for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    const ordered = [rows[i]!, rows[j]!].sort((a, b) =>
      a.canonicalModelId!.localeCompare(b.canonicalModelId!));
    const candidate = ordered[0]!, reference = ordered[1]!;
    if (candidate.canonicalModelId === reference.canonicalModelId) continue;
    const family = candidate.taskFamily === reference.taskFamily ? candidate.taskFamily : undefined;
    const key = `${candidate.canonicalModelId}\0${reference.canonicalModelId}\0${family ?? ""}`;
    const pair = result.get(key) ?? { sourceId, candidateModelId: candidate.canonicalModelId!,
      referenceModelId: reference.canonicalModelId!, taskFamily: family,
      bothSucceed: 0, candidateOnly: 0, referenceOnly: 0, bothFail: 0,
      sampleSize: 0, identityLevel: "EXACT" as const };
    if (candidate.success && reference.success) pair.bothSucceed++;
    else if (candidate.success) pair.candidateOnly++;
    else if (reference.success) pair.referenceOnly++;
    else pair.bothFail++;
    pair.sampleSize++; result.set(key, pair);
  }
  return [...result.values()].sort((a, b) =>
    a.candidateModelId.localeCompare(b.candidateModelId) || a.referenceModelId.localeCompare(b.referenceModelId));
}

/** Build a compact task x model matrix without retaining benchmark prompts. */
export function taskCases(input: EvidenceSourceInput) {
  if (!input.tasks?.length) return [];
  const descriptors = new Map(input.tasks.map((task) => [task.taskKey, task]));
  const grouped = new Map<string, Array<{ modelId: string; success: boolean;
    identityLevel: "EXACT" | "FAMILY_TRANSFER" }>>();
  for (const row of input.records) {
    if (!row.taskKey || !descriptors.has(row.taskKey) || identity(row) === "UNKNOWN" ||
      !row.canonicalModelId || typeof row.success !== "boolean") continue;
    const outcomes = grouped.get(row.taskKey) ?? [];
    outcomes.push({ modelId: row.canonicalModelId, success: row.success,
      identityLevel: identity(row) as "EXACT" | "FAMILY_TRANSFER" });
    grouped.set(row.taskKey, outcomes);
  }
  return [...grouped].flatMap(([taskKey, outcomes]) => {
    const task = descriptors.get(taskKey)!;
    const unique = new Map(outcomes.map((outcome) => [outcome.modelId, outcome]));
    return unique.size < 2 ? [] : [{ sourceId: input.id, taskKey,
      taskFamily: task.taskFamily, languages: task.languages,
      harness: input.harness, engine: input.engine ?? "unknown",
      evidenceQuality: input.evidenceQuality,
      contaminationConfidence: input.contaminationConfidence,
      routingTerms: [...new Set(task.routingTerms)].slice(0, 96),
      outcomes: [...unique.values()].sort((a, b) => a.modelId.localeCompare(b.modelId)) }];
  }).sort((a, b) => a.taskKey.localeCompare(b.taskKey));
}

export function ingestEvidenceSource(input: EvidenceSourceInput, snapshotDate: string,
  pricing: CurrentPricing = {}) {
  const observations: RoutingKnowledgeObservation[] = [];
  const groups = new Map<string, ExternalEvidenceRecord[]>();
  for (const row of input.records) {
    const key = `${canonical(row) ?? row.externalModelName ?? "unknown"}\0${row.taskFamily ?? "all"}\0${identity(row)}\0${row.engine ?? input.engine ?? "unknown"}`;
    const list = groups.get(key) ?? []; list.push(row); groups.set(key, list);
  }
  for (const rows of groups.values()) {
    const first = rows[0]!, model = canonical(first), family = first.taskFamily;
    const base = { source: input.id, sourceDate: input.date ?? snapshotDate, snapshotDate,
      displayModel: first.externalModelName ?? model ?? "unknown", externalModelName: first.externalModelName,
      canonicalModelId: model, revision: first.revision, reasoningConfig: first.reasoningConfig,
      identityLevel: identity(first), evidenceType: input.type,
      taskFamilies: family ? [family] : undefined, languages: first.languages,
      harness: input.harness, engine: first.engine ?? input.engine ?? "unknown",
      evidenceQuality: input.evidenceQuality,
      contaminationConfidence: input.contaminationConfidence } as const;
    const add = (metric: RoutingKnowledgeObservation["metric"], value: number,
      unit: RoutingKnowledgeObservation["unit"], category: RoutingKnowledgeObservation["category"],
      extra: Partial<RoutingKnowledgeObservation> = {}) => observations.push({
        id: oid(input.id, model ?? base.displayModel, metric, family), ...base,
        metric, value, unit, category, ...extra,
      });
    const binary = rows.filter((row) => typeof row.success === "boolean");
    if ((input.type === "paired_task_model" || input.type === "agentic_economics") && binary.length) {
      const successes = binary.filter((row) => row.success).length;
      add("success_rate", successes / binary.length, "ratio", "agentic_swe",
        { sampleSize: binary.length, successes, failures: binary.length - successes });
    }
    const scores = rows.map((row) => row.benchmarkScore).filter(finite);
    if (scores.length && ["benchmark_prior", "paired_task_model", "agentic_economics"].includes(input.type))
      add("result_at_1", quantile(scores, .5)!, "ratio",
        input.type === "benchmark_prior" ? "coding_reasoning" : "agentic_swe",
        { sampleSize: scores.length, detail: "Comparative prior, not universal success probability" });
    const values = (key: keyof ExternalEvidenceRecord) => rows.map((row) => row[key]).filter(finite);
    for (const [key, metric, unit] of [
      ["inputTokens", "input_tokens", "tokens"], ["outputTokens", "output_tokens", "tokens"],
      ["totalTokens", "total_tokens", "tokens"], ["turns", "turns", "count"],
      ["reportedCostUsd", "historical_cost_usd", "usd"],
    ] as const) {
      const samples = values(key); if (!samples.length) continue;
      add(metric, quantile(samples, .5)!, unit, "efficiency", { sampleSize: samples.length });
      if (metric === "total_tokens") {
        add("total_tokens_p75", quantile(samples, .75)!, "tokens", "efficiency", { sampleSize: samples.length });
        add("total_tokens_p90", quantile(samples, .9)!, "tokens", "efficiency", { sampleSize: samples.length });
        add("total_tokens_p99", quantile(samples, .99)!, "tokens", "efficiency", { sampleSize: samples.length });
      }
    }
    const latency = values("latencyMs");
    if (latency.length) {
      add("completion_latency_p50_ms", quantile(latency, .5)!, "milliseconds", "efficiency", { sampleSize: latency.length });
      add("completion_latency_p90_ms", quantile(latency, .9)!, "milliseconds", "efficiency", { sampleSize: latency.length });
      add("completion_latency_p99_ms", quantile(latency, .99)!, "milliseconds", "efficiency", { sampleSize: latency.length });
    }
    const cachedRatios = rows.flatMap((row) => finite(row.cachedTokens) && finite(row.inputTokens) && row.inputTokens > 0
      ? [Math.min(1, row.cachedTokens / row.inputTokens)] : []);
    if (cachedRatios.length)
      add("cached_token_ratio", quantile(cachedRatios, .5)!, "ratio", "efficiency",
        { sampleSize: cachedRatios.length });
    if (model && identity(first) === "EXACT" && pricing[model]) {
      const repriced = rows.map((row) => repriceTokens(row, pricing[model]!)).filter(finite);
      if (repriced.length) add("current_repriced_cost_usd", quantile(repriced, .5)!, "usd",
        "efficiency", { sampleSize: repriced.length });
    }
    if (input.type === "task_distribution")
      add("task_count", rows.length, "count", "task_distribution", { canonicalModelId: undefined });
    if (input.type === "market_adoption_signal") {
      const shares = values("marketShare");
      if (shares.length) add("market_share", quantile(shares, .5)!, "ratio", "market_signal");
    }
  }
  const source: RoutingKnowledgeSource = { id: input.id, type: input.type,
    version: input.version, date: input.date, harness: input.harness,
    recordCount: input.records.length, status: "ok" };
  return { observations, pairwiseEvidence: input.type === "paired_task_model" || input.type === "agentic_economics"
    ? pairwiseOutcomes(input.id, input.records) : [], source };
}

export function buildKnowledgeSnapshot(inputs: EvidenceSourceInput[], now = new Date().toISOString(),
  pricing: CurrentPricing = {}): RoutingKnowledgeSnapshot {
  const parts = inputs.map((input) => ingestEvidenceSource(input, now.slice(0, 10), pricing));
  const body = { schemaVersion: ROUTING_KNOWLEDGE_VERSION, createdAt: now,
    observations: parts.flatMap((item) => item.observations),
    pairwiseEvidence: parts.flatMap((item) => item.pairwiseEvidence),
    taskCases: inputs.flatMap(taskCases),
    sources: parts.map((item) => item.source) };
  const digest = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16);
  return { ...body, snapshotId: `routing-knowledge-v2-${digest}` };
}

export function repriceTokens(record: Pick<ExternalEvidenceRecord,
  "identityLevel" | "inputTokens" | "outputTokens" | "cachedTokens">,
pricing: { inputPrice: number; outputPrice: number; cachedInputPrice?: number }) {
  if (record.identityLevel !== "EXACT" || !finite(record.inputTokens) || !finite(record.outputTokens)) return null;
  const cached = Math.min(record.inputTokens, record.cachedTokens ?? 0);
  return ((record.inputTokens - cached) * pricing.inputPrice +
    cached * (pricing.cachedInputPrice ?? pricing.inputPrice) + record.outputTokens * pricing.outputPrice) / 1e6;
}

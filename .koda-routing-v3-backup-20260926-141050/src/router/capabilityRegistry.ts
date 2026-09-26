import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import type { Catalog } from "../openrouter/catalog.js";
import { supportsParameters, type Metadata, type PoolModel } from "./pool.js";
import type { TaskFingerprint } from "./taskFingerprint.js";
import { RoutingKnowledgeStore } from "./knowledge/store.js";
import type { ModelRoutingKnowledge, ProviderCapabilityMetric, RoutingKnowledgeObservation } from "./knowledge/schema.js";

export interface SpecialistEvidence {
  source: "configured_prior" | "coding_benchmark" | "agentic_benchmark" | "reasoning_benchmark" | "terminal_benchmark" | "design_benchmark" | "task_market" | "verified_history";
  value: number;
  detail: string;
}
export interface NormalizedCapabilityEvidence {
  capability: string;
  quality: number;
  source: "configured" | "benchmark" | "metadata";
}
export interface SpecialistModel {
  model: PoolModel;
  metadata: Metadata;
  vision: boolean;
  evidence: SpecialistEvidence[];
  capabilityEvidence?: NormalizedCapabilityEvidence[];
  knowledge?: ModelRoutingKnowledge;
  configured: boolean;
}
export interface ModelSnapshot { models: any[]; benchmarks: any[]; classifications: any[]; retrievedAt: number; baseUrl: string }
interface ExternalPriorCache {
  benchmarks: any[];
  unmatched: string[];
  retrievedAt: number;
}
/** Discovery is independent of the OpenAI-compatible inference transport. */
export interface ModelDiscoveryAdapter { discover(): Promise<ModelSnapshot> }
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const price = (raw: any, key: "prompt" | "completion") => {
  if (raw?.pricing?.request !== undefined && Number(raw.pricing.request) !== 0) return undefined;
  const values = [raw?.pricing, ...(raw?.pricing?.overrides ?? [])].map((p: any) => p?.[key]).filter((v: unknown) => v !== undefined);
  if (!values.length || values.some((v: unknown) => !Number.isFinite(Number(v)) || Number(v) < 0 || (typeof v === "string" && !v.trim()))) return undefined;
  return Math.max(...values.map(Number)) * 1e6;
};
const endpointParameterSets = (raw: any): string[][] | undefined => {
  const endpoints = Array.isArray(raw?.endpoints) ? raw.endpoints : undefined;
  return endpoints?.map((endpoint: any) => endpoint?.supported_parameters)
    .filter((parameters: unknown): parameters is string[] =>
      Array.isArray(parameters) && parameters.every((item) => typeof item === "string"));
};
const marketPattern = (primary: TaskFingerprint["primary"]) => ({
  frontend_ui: /front|ui|design|web/, fullstack: /code|web|agent/,
  backend: /backend|api|code/, sql_database: /sql|data|database/,
  debugging: /debug|reason|agent|code/, testing: /test|code/,
  documentation: /write|general/, devops: /agent|code/,
} as Record<string, RegExp>)[primary] ?? /code|agent/;

/** Free, cached OpenRouter metadata only. Missing metadata never creates a priced candidate. */
export class CapabilityRegistry {
  private pending?: Promise<SpecialistModel[]>;
  private refreshStarted = false;
  private readonly knowledge: RoutingKnowledgeStore;
  constructor(
    readonly config: Config,
    readonly catalog: Catalog,
    readonly adapter?: ModelDiscoveryAdapter,
    knowledgeDirectory?: string,
  ) { this.knowledge = new RoutingKnowledgeStore(undefined,
    knowledgeDirectory ?? config.routing.stateDirectory); }
  all() { return this.load(); }
  forTask(fingerprint: TaskFingerprint) {
    // The raw snapshot is shared; task-specific market evidence is computed per subtask.
    return this.load().then((models) => this.withMarket(models, fingerprint));
  }
  /** Explicit metadata refresh, never called while selecting a worker model. */
  async refresh() {
    const snapshot = await this.fetchSnapshot(true);
    this.pending = this.build(snapshot);
    return this.pending;
  }
  private async cachedSnapshot(): Promise<ModelSnapshot> {
    try {
      const parsed = JSON.parse(await readFile(join(this.catalog.directory, "specialist-metadata.json"), "utf8"));
      if (parsed.baseUrl === this.config.baseUrl && Array.isArray(parsed.models) &&
          Array.isArray(parsed.benchmarks) && Array.isArray(parsed.classifications)) return parsed;
    } catch {}
    return { models: [], benchmarks: [], classifications: [], retrievedAt: 0, baseUrl: this.config.baseUrl };
  }
  private async fetchSnapshot(force = false): Promise<ModelSnapshot> {
    if (this.adapter) return this.adapter.discover();
    const file = join(this.catalog.directory, "specialist-metadata.json");
    let cached: ModelSnapshot | undefined;
    try {
      const parsed = JSON.parse(await readFile(file, "utf8"));
      if (parsed.baseUrl === this.config.baseUrl && Array.isArray(parsed.models) && Array.isArray(parsed.benchmarks) && Array.isArray(parsed.classifications)) cached = parsed;
    } catch {}
    if (!force && cached && Date.now() - cached.retrievedAt < this.config.routing.cacheTtlMs) return cached;
    const openrouter = (this.config.modelPool?.provider ?? "openrouter") === "openrouter";
    const key = openrouter ? process.env.OPENROUTER_API_KEY : process.env.KODA_MODEL_API_KEY;
    const headers = key ? { Authorization: `Bearer ${key}` } : undefined;
    const get = async (suffix: string) => {
      const response = await fetch(this.config.baseUrl.replace(/\/$/, "") + suffix, { headers, signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw Error(`metadata HTTP ${response.status}`);
      return response.json() as Promise<any>;
    };
    const modelResult = await Promise.allSettled([get("/models")]);
    const listed = modelResult[0]?.status === "fulfilled" && Array.isArray((modelResult[0] as PromiseFulfilledResult<any>).value?.data)
      ? (modelResult[0] as PromiseFulfilledResult<any>).value.data as any[] : [];
    const configuredIds = new Set(this.config.modelPool?.models.map((model) => model.id) ?? []);
    const hasNewModels = listed.some((model) => typeof model?.id === "string" && !configuredIds.has(model.id));
    const officialOpenRouter = (() => {
      try { return /(?:^|\.)openrouter\.ai$/i.test(new URL(this.config.baseUrl).hostname); }
      catch { return false; }
    })();
    const supplement = openrouter && (officialOpenRouter || hasNewModels)
      ? await Promise.allSettled([get("/classifications/task"), get("/benchmarks")]) : [];
    const settled = [modelResult[0]!, ...supplement];
    const data = (index: number) => settled[index]?.status === "fulfilled" ? (settled[index] as PromiseFulfilledResult<any>).value?.data : undefined;
    const models = Array.isArray(data(0)) ? data(0) : cached?.models ?? [];
    const classifications = Array.isArray(data(1)?.classifications) ? data(1).classifications : cached?.classifications ?? [];
    const providerBenchmarks = (Array.isArray(data(2)) ? data(2) : cached?.benchmarks ?? [])
      .filter((row: any) => row?.source !== "artificial-analysis");
    const externalBenchmarks = await this.artificialAnalysisBenchmarks(force);
    const benchmarks = [...externalBenchmarks, ...providerBenchmarks];
    const snapshot = { models, classifications, benchmarks, retrievedAt: Date.now(), baseUrl: this.config.baseUrl };
    if (settled.some((result) => result.status === "fulfilled")) {
      try {
        await mkdir(this.catalog.directory, { recursive: true });
        const temp = file + "." + randomUUID();
        await writeFile(temp, JSON.stringify(snapshot));
        await rename(temp, file);
      } catch {}
    }
    return snapshot;
  }
  private async artificialAnalysisBenchmarks(force: boolean): Promise<any[]> {
    const file = join(this.catalog.directory, "artificial-analysis.json");
    let cached: ExternalPriorCache | undefined;
    try {
      const parsed = JSON.parse(await readFile(file, "utf8"));
      if (Array.isArray(parsed.benchmarks) && Array.isArray(parsed.unmatched) &&
          typeof parsed.retrievedAt === "number") cached = parsed;
    } catch {}
    const key = process.env.ARTIFICIAL_ANALYSIS_API_KEY;
    if (!key) return cached?.benchmarks ?? [];
    if (!force && cached && Date.now() - cached.retrievedAt < this.config.routing.cacheTtlMs)
      return cached.benchmarks;
    try {
      const endpoint = process.env.KODA_ARTIFICIAL_ANALYSIS_URL ??
        "https://artificialanalysis.ai/api/v2/language/models";
      const response = await fetch(endpoint, {
        headers: { "x-api-key": key }, signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) throw Error(`Artificial Analysis metadata HTTP ${response.status}`);
      const payload = await response.json() as any;
      const rows = Array.isArray(payload?.data) ? payload.data : [];
      const benchmarks: any[] = [];
      const unmatched: string[] = [];
      for (const row of rows) {
        // Artificial Analysis documents openrouter_api_id as the explicit
        // provider mapping. Never guess from display names or mutable slugs.
        const id = row?.openrouter_api_id ?? row?.api_ids?.openrouter;
        if (typeof id !== "string" || !id.includes("/")) {
          if (typeof row?.id === "string") unmatched.push(row.id);
          continue;
        }
        const evaluations = row.evaluations ?? {};
        benchmarks.push({
          model_permaslug: id,
          coding_index: finite(evaluations.artificial_analysis_coding_index),
          reasoning_index: finite(evaluations.artificial_analysis_intelligence_index),
          intelligence_index: finite(evaluations.artificial_analysis_intelligence_index),
          throughput_tokens_per_second: finite(row.median_output_tokens_per_second),
          latency_seconds: finite(row.median_time_to_first_token_seconds),
          source: "artificial-analysis",
        });
      }
      const value: ExternalPriorCache = { benchmarks, unmatched, retrievedAt: Date.now() };
      try {
        await mkdir(this.catalog.directory, { recursive: true });
        const temp = file + "." + randomUUID();
        await writeFile(temp, JSON.stringify(value));
        await rename(temp, file);
      } catch {}
      return benchmarks;
    } catch {
      return cached?.benchmarks ?? [];
    }
  }
  private async load(): Promise<SpecialistModel[]> {
    if (!this.pending) {
      // Routing never waits for catalog research. Use the last-known-good
      // snapshot immediately and refresh it opportunistically for later tasks.
      this.pending = this.cachedSnapshot().then((snapshot) => this.build(snapshot));
      if (!this.adapter && process.env.OPENROUTER_API_KEY && !this.refreshStarted) {
        this.refreshStarted = true;
        void this.refresh().catch(() => undefined);
      }
    }
    return this.pending;
  }
  private async build(snapshot: ModelSnapshot) {
    const configured = this.config.modelPool?.models ?? [];
    const raw = new Map<string, any>(snapshot.models.filter((m) => typeof m?.id === "string").map((m) => [m.id, m]));
    const benchmarks = new Map<string, any[]>();
    for (const row of snapshot.benchmarks) {
      const id = row?.model_permaslug;
      if (typeof id !== "string") continue;
      const list = benchmarks.get(id) ?? [];
      list.push(row);
      benchmarks.set(id, list);
    }
    // Every adapter-discovered model is considered. Lack of evidence is a
    // routing rejection, not a reason to hide a model from the candidate set.
    const ids = new Set([...configured.map((m) => m.id), ...raw.keys(), ...benchmarks.keys()]);
    const catalog = this.adapter ? new Map<string, Metadata>() : await this.catalog.getCached();
    const endpointProofRequired = !this.adapter && (() => {
      try {
        return /(?:^|\.)openrouter\.ai$/i.test(new URL(this.config.baseUrl).hostname);
      } catch {
        return false;
      }
    })();
    const result: SpecialistModel[] = [];
    const dynamic: [string, Metadata][] = [];
    for (const id of ids) {
      const source = raw.get(id);
      const existing = configured.find((m) => m.id === id);
      if (!existing && !source) continue;
      const rows = benchmarks.get(id) ?? [];
      const coding = rows.map((row) => finite(row.coding_index)).find((n) => n !== undefined);
      const agentic = rows.map((row) => finite(row.agentic_index)).find((n) => n !== undefined);
      const reasoning = rows.map((row) => finite(row.reasoning_index)).find((n) => n !== undefined);
      const terminal = rows.map((row) => finite(row.terminal_index)).find((n) => n !== undefined);
      const designs = rows.filter((row) => row.source === "design-arena" && /ui|design|component|web/i.test(String(row.category ?? row.benchmark_type ?? "")));
      const design = designs.map((row) => finite(row.elo) ?? finite(row.rating) ?? finite(row.score)).find((n) => n !== undefined);
      const cachedMetadata = catalog.get(id) ?? existing?.fallback ?? {};
      const metadata: Metadata = source ? {
        inputPrice: price(source, "prompt"), outputPrice: price(source, "completion"),
        contextLength: finite(source.context_length), available: true,
        supportedParameters: Array.isArray(source.supported_parameters) ? source.supported_parameters : undefined,
        routableParameterSets: endpointParameterSets(source) ??
          cachedMetadata.routableParameterSets ?? (endpointProofRequired ? [] : undefined),
      } : cachedMetadata;
      const vision = (source?.architecture?.input_modalities ?? []).includes("image") || /image/.test(source?.architecture?.modality ?? "") || !!existing?.strengths.includes("vision");
      const evidence: SpecialistEvidence[] = [];
      const capabilityEvidence: NormalizedCapabilityEvidence[] = [
        ...(existing?.strengths ?? []).map((capability) => ({
          capability, quality: existing!.qualityPrior, source: "configured" as const,
        })),
        ...(coding === undefined ? [] : [{ capability: "coding", quality: clamp(coding / 100), source: "benchmark" as const }]),
        ...(agentic === undefined ? [] : [{ capability: "repo_reasoning", quality: clamp(agentic / 100), source: "benchmark" as const }]),
        ...(reasoning === undefined ? [] : [{ capability: "reasoning", quality: clamp(reasoning / 100), source: "benchmark" as const }]),
        ...(terminal === undefined ? [] : [{ capability: "terminal", quality: clamp(terminal / 100), source: "benchmark" as const }]),
        ...(design === undefined ? [] : [{ capability: "frontend_ui", quality: clamp((design - 1000) / 1000), source: "benchmark" as const }]),
        ...(metadata.contextLength === undefined ? [] : [{ capability: "long_context", quality: clamp(metadata.contextLength / 200000), source: "metadata" as const }]),
        ...(metadata.supportedParameters?.includes("tools") ? [{ capability: "tool_use", quality: 1, source: "metadata" as const }] : []),
      ];
      if (existing) evidence.push({ source: "configured_prior", value: existing.qualityPrior, detail: "Koda configured quality prior" });
      const external = rows.some((row) => row.source === "artificial-analysis");
      if (coding !== undefined) evidence.push({ source: "coding_benchmark", value: clamp(coding / 100), detail: external ? "Artificial Analysis coding index" : "OpenRouter coding index" });
      if (agentic !== undefined) evidence.push({ source: "agentic_benchmark", value: clamp(agentic / 100), detail: external ? "Artificial Analysis agentic index" : "OpenRouter agentic index" });
      if (reasoning !== undefined) evidence.push({ source: "reasoning_benchmark", value: clamp(reasoning / 100), detail: "Cached reasoning index" });
      if (terminal !== undefined) evidence.push({ source: "terminal_benchmark", value: clamp(terminal / 100), detail: "Cached terminal index" });
      if (design !== undefined) evidence.push({ source: "design_benchmark", value: design, detail: "OpenRouter Design Arena UI/category evidence" });
      const model: PoolModel = existing ?? {
        id, enabled: true, tier: "fast",
        strengths: [
          ...(coding !== undefined ? ["coding"] : []),
          ...(metadata.supportedParameters?.includes("tools") ? ["tool_use"] : []),
        ],
        qualityPrior: coding === undefined && agentic === undefined && reasoning === undefined && terminal === undefined ? 0.5
          : 0.78 + 0.18 * clamp((coding ?? agentic ?? reasoning ?? terminal!) / 100),
        latencyPriorMs: 5000,
      };
      const baseKnowledge = this.knowledge.forModel(id);
      const snapshotDate = new Date(snapshot.retrievedAt || 0).toISOString().slice(0, 10);
      const providerRows: RoutingKnowledgeObservation[] = [];
      const providerFact = (metric: ProviderCapabilityMetric, value: number,
        unit: RoutingKnowledgeObservation["unit"]) => providerRows.push({
        id: `provider-${id}-${metric}`, category: "provider_capability", source: "provider metadata cache",
        sourceDate: snapshotDate, snapshotDate, displayModel: id, canonicalModelId: id,
        metric, value, unit, freshnessDays: Math.ceil(this.config.routing.cacheTtlMs / 86_400_000),
      });
      if (metadata.contextLength !== undefined) providerFact("context_tokens", metadata.contextLength, "tokens");
      if (metadata.inputPrice !== undefined) providerFact("input_price_per_million", metadata.inputPrice, "usd");
      if (metadata.outputPrice !== undefined) providerFact("output_price_per_million", metadata.outputPrice, "usd");
      if (metadata.supportedParameters?.includes("tools")) providerFact("tools_supported", 1, "ratio");
      if ((metadata.supportedParameters || metadata.routableParameterSets) &&
          supportsParameters(metadata, ["tools", "tool_choice"])) providerFact("tool_choice_supported", 1, "ratio");
      providerFact("availability", metadata.available === false ? 0 : 1, "ratio");
      providerFact("text_modality", 1, "ratio");
      if (vision) providerFact("vision_modality", 1, "ratio");
      result.push({ model, metadata, vision, evidence, capabilityEvidence,
        knowledge: { snapshotId: baseKnowledge.snapshotId,
          observations: [...baseKnowledge.observations, ...providerRows],
          pairwiseEvidence: baseKnowledge.pairwiseEvidence }, configured: !!existing });
      if (source) dynamic.push([id, metadata]);
    }
    this.catalog.addDynamic(dynamic);
    this.market = snapshot.classifications;
    return result;
  }
  private market: any[] = [];
  private withMarket(models: SpecialistModel[], fingerprint: TaskFingerprint) {
    const pattern = marketPattern(fingerprint.primary);
    return models.map((model) => {
      const entries = this.market.filter((row) => pattern.test(String(row.tag ?? "")));
      const shares = entries.flatMap((row) => (row.models ?? []).filter((item: any) => item.id === model.model.id).map((item: any) => Number(item.tag_usage_share ?? 0)));
      return {
        ...model,
        evidence: shares.length ? [...model.evidence, { source: "task_market" as const, value: Math.max(...shares), detail: "OpenRouter task-classification usage share (popularity proxy, not success rate)" }] : model.evidence,
      };
    });
  }
}

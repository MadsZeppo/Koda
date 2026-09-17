import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import type { Catalog } from "../openrouter/catalog.js";
import type { Metadata, PoolModel } from "./pool.js";
import type { TaskFingerprint } from "./taskFingerprint.js";

export interface SpecialistEvidence {
  source: "configured_prior" | "coding_benchmark" | "agentic_benchmark" | "design_benchmark" | "task_market" | "verified_history";
  value: number;
  detail: string;
}
export interface SpecialistModel {
  model: PoolModel;
  metadata: Metadata;
  vision: boolean;
  evidence: SpecialistEvidence[];
  configured: boolean;
}
interface Snapshot { models: any[]; benchmarks: any[]; classifications: any[]; retrievedAt: number; baseUrl: string }
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const price = (raw: any, key: "prompt" | "completion") => {
  if (raw?.pricing?.request !== undefined && Number(raw.pricing.request) !== 0) return undefined;
  const values = [raw?.pricing, ...(raw?.pricing?.overrides ?? [])].map((p: any) => p?.[key]).filter((v: unknown) => v !== undefined);
  if (!values.length || values.some((v: unknown) => !Number.isFinite(Number(v)) || Number(v) < 0 || (typeof v === "string" && !v.trim()))) return undefined;
  return Math.max(...values.map(Number)) * 1e6;
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
  constructor(
    readonly config: Config,
    readonly catalog: Catalog,
  ) {}
  forTask(fingerprint: TaskFingerprint) {
    // The raw snapshot is shared; task-specific market evidence is computed per subtask.
    return this.load().then((models) => this.withMarket(models, fingerprint));
  }
  private async fetchSnapshot(): Promise<Snapshot> {
    const file = join(this.catalog.directory, "specialist-metadata.json");
    let cached: Snapshot | undefined;
    try {
      const parsed = JSON.parse(await readFile(file, "utf8"));
      if (parsed.baseUrl === this.config.baseUrl && Array.isArray(parsed.models) && Array.isArray(parsed.benchmarks) && Array.isArray(parsed.classifications)) cached = parsed;
    } catch {}
    if (cached && Date.now() - cached.retrievedAt < this.config.routing.cacheTtlMs) return cached;
    const key = process.env.OPENROUTER_API_KEY;
    const headers = key ? { Authorization: `Bearer ${key}` } : undefined;
    const get = async (suffix: string) => {
      const response = await fetch(this.config.baseUrl.replace(/\/$/, "") + suffix, { headers, signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw Error(`metadata HTTP ${response.status}`);
      return response.json() as Promise<any>;
    };
    const settled = await Promise.allSettled([
      get("/models"), get("/classifications/task"), get("/benchmarks"),
    ]);
    const data = (index: number) => settled[index]?.status === "fulfilled" ? (settled[index] as PromiseFulfilledResult<any>).value?.data : undefined;
    const models = Array.isArray(data(0)) ? data(0) : cached?.models ?? [];
    const classifications = Array.isArray(data(1)?.classifications) ? data(1).classifications : cached?.classifications ?? [];
    const benchmarks = Array.isArray(data(2)) ? data(2) : cached?.benchmarks ?? [];
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
  private async load(): Promise<SpecialistModel[]> {
    if (!this.pending) this.pending = this.build();
    return this.pending;
  }
  private async build() {
    const snapshot = await this.fetchSnapshot();
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
    // Configured models always participate. New models need benchmark evidence
    // and live/cached hard capability metadata before they may enter.
    const ids = new Set([...configured.map((m) => m.id), ...benchmarks.keys()]);
    const catalog = await this.catalog.get();
    const result: SpecialistModel[] = [];
    const dynamic: [string, Metadata][] = [];
    for (const id of ids) {
      const source = raw.get(id);
      const existing = configured.find((m) => m.id === id);
      if (!existing && !source) continue;
      const rows = benchmarks.get(id) ?? [];
      const coding = rows.map((row) => finite(row.coding_index)).find((n) => n !== undefined);
      const agentic = rows.map((row) => finite(row.agentic_index)).find((n) => n !== undefined);
      const designs = rows.filter((row) => row.source === "design-arena" && /ui|design|component|web/i.test(String(row.category ?? row.benchmark_type ?? "")));
      const design = designs.map((row) => finite(row.elo) ?? finite(row.rating) ?? finite(row.score)).find((n) => n !== undefined);
      if (!existing && coding === undefined && agentic === undefined && design === undefined) continue;
      const metadata: Metadata = source ? {
        inputPrice: price(source, "prompt"), outputPrice: price(source, "completion"),
        contextLength: finite(source.context_length), available: true,
        supportedParameters: Array.isArray(source.supported_parameters) ? source.supported_parameters : undefined,
      } : catalog.get(id) ?? existing?.fallback ?? {};
      const vision = (source?.architecture?.input_modalities ?? []).includes("image") || /image/.test(source?.architecture?.modality ?? "") || !!existing?.strengths.includes("vision");
      const evidence: SpecialistEvidence[] = [];
      if (existing) evidence.push({ source: "configured_prior", value: existing.qualityPrior, detail: "Koda configured quality prior" });
      if (coding !== undefined) evidence.push({ source: "coding_benchmark", value: clamp(coding / 100), detail: "OpenRouter coding index" });
      if (agentic !== undefined) evidence.push({ source: "agentic_benchmark", value: clamp(agentic / 100), detail: "OpenRouter agentic index" });
      if (design !== undefined) evidence.push({ source: "design_benchmark", value: design, detail: "OpenRouter Design Arena UI/category evidence" });
      const model: PoolModel = existing ?? {
        id, enabled: true, tier: "fast", strengths: ["coding", "tool_use"],
        qualityPrior: 0.78 + 0.18 * clamp((coding ?? agentic ?? 50) / 100),
        latencyPriorMs: 5000,
      };
      result.push({ model, metadata, vision, evidence, configured: !!existing });
      if (!existing) dynamic.push([id, metadata]);
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

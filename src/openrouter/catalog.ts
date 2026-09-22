import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  metadataSchema,
  type Metadata,
  type PoolModel,
} from "../router/pool.js";
export class Catalog {
  private pending?: Promise<Map<string, Metadata>>;
  private readonly dynamic = new Map<string, Metadata>();
  constructor(
    readonly baseUrl: string,
    readonly directory: string,
    readonly ttlMs: number,
    readonly models: PoolModel[],
  ) {}
  get() {
    if (this.models.every((model) => this.dynamic.has(model.id)))
      return Promise.resolve(new Map(this.dynamic));
    return (this.pending ??= this.load()).then(
      (configured) => new Map([...configured, ...this.dynamic]),
    );
  }
  addDynamic(models: Iterable<[string, Metadata]>) {
    for (const [id, metadata] of models) this.dynamic.set(id, metadata);
  }
  /** Read-only routing snapshot. Metadata refresh belongs outside worker selection. */
  async getCached() {
    let entries: [string, Metadata][] = [];
    try {
      const cached = JSON.parse(await readFile(join(this.directory, "catalog.json"), "utf8"));
      if (cached.baseUrl === this.baseUrl && Array.isArray(cached.entries))
        entries = cached.entries.filter((entry: unknown) => Array.isArray(entry) &&
          typeof entry[0] === "string" && metadataSchema.safeParse(entry[1]).success);
    } catch {}
    return new Map<string, Metadata>([
      ...this.models.map((model): [string, Metadata] =>
        [model.id, model.fallback ?? {}]),
      ...entries,
      ...this.dynamic,
    ]);
  }
  private async load() {
    const path = join(this.directory, "catalog.json");
    let cached:
      | { baseUrl: string; retrievedAt: number; entries: [string, Metadata][] }
      | undefined;
    try {
      const c = JSON.parse(await readFile(path, "utf8"));
      if (
        c.baseUrl === this.baseUrl &&
        Number.isFinite(c.retrievedAt) &&
        Array.isArray(c.entries)
      ) {
        c.entries.forEach((e: any) => metadataSchema.parse(e[1]));
        cached = c;
      }
    } catch {}
    const officialOpenRouter = (() => {
      try { return /(?:^|\.)openrouter\.ai$/i.test(new URL(this.baseUrl).hostname); }
      catch { return false; }
    })();
    if (
      cached &&
      this.models.every((m) => cached!.entries.some(([id]) => id === m.id)) &&
      (!officialOpenRouter || this.models.filter((model) => model.enabled &&
        model.strengths.includes("tool_use")).every((model) =>
        cached!.entries.find(([id]) => id === model.id)?.[1].routableParameterSets !== undefined)) &&
      Date.now() - cached.retrievedAt < this.ttlMs
    )
      return new Map(cached.entries);
    try {
      const res = await fetch(this.baseUrl.replace(/\/$/, "") + "/models", {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw Error(`Catalog HTTP ${res.status}`);
      const data = (await res.json()) as any;
      if (!Array.isArray(data.data) || !data.data.length)
        throw Error("Invalid catalog");
      const retrievedAt = new Date().toISOString();
      const embeddedSets = (raw: any) => {
        const endpoints = Array.isArray(raw?.endpoints) ? raw.endpoints : undefined;
        return endpoints?.map((endpoint: any) => endpoint?.supported_parameters)
          .filter((parameters: unknown): parameters is string[] =>
            Array.isArray(parameters) && parameters.every((item) => typeof item === "string"));
      };
      const endpointSets = new Map<string, string[][]>();
      if (officialOpenRouter) {
        const key = process.env.OPENROUTER_API_KEY;
        const headers = key ? { Authorization: `Bearer ${key}` } : undefined;
        for (const model of this.models.filter((item) => item.enabled &&
          item.strengths.includes("tool_use"))) endpointSets.set(model.id, []);
        await Promise.all(this.models.filter((model) => model.enabled &&
          model.strengths.includes("tool_use")).map(async (model) => {
          try {
            const response = await fetch(this.baseUrl.replace(/\/$/, "") +
              `/models/${model.id}/endpoints`, {
                headers, signal: AbortSignal.timeout(3000),
              });
            if (!response.ok) return;
            const body = await response.json() as any;
            const endpoints = body?.data?.endpoints ?? body?.endpoints ?? body?.data;
            if (!Array.isArray(endpoints)) return;
            endpointSets.set(model.id, endpoints.map((endpoint: any) =>
              endpoint?.supported_parameters).filter((parameters: unknown): parameters is string[] =>
                Array.isArray(parameters) && parameters.every((item) => typeof item === "string")));
          } catch {}
        }));
      }
      const entries: [string, Metadata][] = this.models.map((model) => {
        const raw = data.data.find((m: any) => m.id === model.id);
        if (!raw) return [model.id, { available: false, retrievedAt }];
        const price = (field: string) => {
          // A per-request surcharge cannot be bounded by prompt/completion caps.
          if (
            raw.pricing?.request !== undefined &&
            Number(raw.pricing.request) !== 0
          )
            return undefined;
          const values = [raw.pricing, ...(raw.pricing?.overrides ?? [])]
            .map((p) => p?.[field])
            .filter((v) => v !== undefined);
          if (
            !values.length ||
            values.some(
              (v) =>
                (typeof v === "string" && !v.trim()) ||
                (typeof v !== "string" && typeof v !== "number") ||
                !Number.isFinite(Number(v)) ||
                Number(v) < 0,
            )
          )
            return undefined;
          return Math.max(...values.map(Number)) * 1e6;
        };
        return [
          model.id,
          {
            inputPrice: price("prompt"),
            outputPrice: price("completion"),
            contextLength: raw.context_length,
            available: true,
            supportedParameters: raw.supported_parameters,
            routableParameterSets: embeddedSets(raw) ?? endpointSets.get(model.id),
            retrievedAt,
          },
        ];
      });
      const result = new Map(entries);
      try {
        await mkdir(this.directory, { recursive: true });
        const tmp = path + "." + randomUUID();
        await writeFile(
          tmp,
          JSON.stringify({
            baseUrl: this.baseUrl,
            retrievedAt: Date.now(),
            entries,
          }),
        );
        await rename(tmp, path);
      } catch {}
      return result;
    } catch {
      return new Map(
        this.models.map((m) => [
          m.id,
          cached?.entries.find(([id]) => id === m.id)?.[1] ?? m.fallback ?? {},
        ]),
      );
    }
  }
}

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
    return (this.pending ??= this.load()).then(
      (configured) => new Map([...configured, ...this.dynamic]),
    );
  }
  addDynamic(models: Iterable<[string, Metadata]>) {
    for (const [id, metadata] of models) this.dynamic.set(id, metadata);
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
    if (
      cached &&
      this.models.every((m) => cached!.entries.some(([id]) => id === m.id)) &&
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

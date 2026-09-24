import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { CatalogIdentity, CurrentPricing, EvidenceSourceInput, ExternalEvidenceRecord } from "./ingest.js";

export const CODEROUTER_RESULTS_URL =
  "https://huggingface.co/datasets/Lance1573/CodeRouterBench/resolve/main/id_results_long.csv";
export const CODEROUTER_MODELS_URL =
  "https://huggingface.co/datasets/Lance1573/CodeRouterBench/resolve/main/models.json";
export const SWE_REBENCH_TREE_URL =
  "https://huggingface.co/api/datasets/ibragim-bad/swe_rebench_07_2026_trajectories/tree/main?recursive=true&expand=false";
export const SWE_REBENCH_RESOLVE_ROOT =
  "https://huggingface.co/datasets/ibragim-bad/swe_rebench_07_2026_trajectories/resolve/main";

const number = (value: unknown) => {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};
const string = (...values: unknown[]) => values.find((value): value is string =>
  typeof value === "string" && value.trim().length > 0)?.trim();
const canonicalId = (value: unknown) => {
  const id = string(value);
  return id?.includes("/") ? id : undefined;
};
const at = (value: any, path: string) => path.split(".").reduce((item, key) => item?.[key], value);
const firstNumber = (value: any, paths: string[]) => {
  for (const path of paths) { const result = number(at(value, path)); if (result !== undefined) return result; }
  return undefined;
};
const firstString = (value: any, paths: string[]) =>
  string(...paths.map((path) => at(value, path)));

/** Small RFC-4180 reader for the compact CodeRouterBench long table. */
export function parseCsv(input: string) {
  const rows: string[][] = []; let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
    else cell += char;
  }
  if (cell.length || row.length) { row.push(cell.replace(/\r$/, "")); rows.push(row); }
  const header = rows.shift() ?? [];
  return rows.filter((values) => values.some(Boolean)).map((values) =>
    Object.fromEntries(header.map((key, index) => [key, values[index] ?? ""])));
}

function explicitModelMap(payload: any) {
  const result = new Map<string, string>();
  for (const item of Array.isArray(payload?.models) ? payload.models : []) {
    const name = string(item?.model, item?.name, item?.id);
    const exact = canonicalId(item?.canonical_openrouter_id ?? item?.openrouter_model_id ?? item?.openrouter_id);
    if (name && exact) result.set(name, exact);
  }
  return result;
}

export function codeRouterSource(csv: string, modelsPayload: any,
  generatedAt = new Date().toISOString()): EvidenceSourceInput {
  const exact = explicitModelMap(modelsPayload);
  const records = parseCsv(csv).map((row): ExternalEvidenceRecord => {
    const model = row.model;
    const canonicalModelId = canonicalId(model) ?? (model ? exact.get(model) : undefined);
    const score = number(row.score);
    return {
      taskKey: row.task_id, taskFamily: row.dimension || undefined,
      externalModelName: model, canonicalModelId,
      identityLevel: canonicalModelId ? "EXACT" : "UNKNOWN",
      revision: model || undefined,
      success: score === 0 || score === 1 ? score === 1 : undefined,
      benchmarkScore: score,
      inputTokens: number(row.input_tokens), outputTokens: number(row.output_tokens),
      totalTokens: number(row.total_tokens), latencyMs: number(row.latency_ms),
      reportedCostUsd: number(row.cost_usd),
    };
  });
  return { id: "coderouterbench-id", type: "paired_task_model", version: "huggingface-main",
    date: generatedAt.slice(0, 10), harness: "CodeRouterBench ID task-by-model matrix", records };
}

export function sweRebenchRecord(row: any): ExternalEvidenceRecord {
  const externalModelName = firstString(row, [
    "participant.openrouter_model_id", "participant.model.openrouter_model_id",
    "participant.model_id", "participant.model.id", "participant.model",
    "participant.name", "participant.id",
  ]);
  const explicit = firstString(row, ["participant.openrouter_model_id",
    "participant.model.openrouter_model_id", "participant.model.canonical_openrouter_id",
    "participant.model_id", "participant.model.id"]);
  const canonicalModelId = canonicalId(explicit);
  const resolved = at(row, "evaluation.resolved");
  const status = firstString(row, ["evaluation.status", "evaluation.result"]);
  const events = Array.isArray(row?.events) ? row.events : [];
  const turns = events.filter((event: any) => /assistant|model/i.test(String(event?.role ?? event?.type ?? ""))).length || events.length;
  const inputTokens = firstNumber(row, ["usage.input_tokens", "usage.prompt_tokens", "usage.inputTokens"]);
  const outputTokens = firstNumber(row, ["usage.output_tokens", "usage.completion_tokens", "usage.outputTokens"]);
  return {
    taskKey: string(row?.instance_id, row?.trajectory_id),
    taskFamily: firstString(row, ["normalization.task_family", "normalization.task_type"]),
    languages: string(row?.language) ? [row.language] : undefined,
    externalModelName, canonicalModelId,
    identityLevel: canonicalModelId ? "EXACT" : "UNKNOWN",
    revision: firstString(row, ["participant.model.revision", "participant.revision"]),
    reasoningConfig: firstString(row, ["participant.reasoning_effort", "participant.model.reasoning_effort"]),
    success: typeof resolved === "boolean" ? resolved : status ? /^(?:resolved|passed|success)$/i.test(status) : undefined,
    inputTokens, outputTokens,
    cachedTokens: firstNumber(row, ["usage.cached_tokens", "usage.cached_input_tokens"]),
    totalTokens: firstNumber(row, ["usage.total_tokens", "usage.totalTokens"]) ??
      (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined),
    turns,
    latencyMs: firstNumber(row, ["run.duration_ms", "run.elapsed_ms", "usage.wall_clock_ms"]),
    reportedCostUsd: firstNumber(row, ["usage.cost_usd", "usage.cost"]),
  };
}

export function sweRebenchSource(lines: string[], generatedAt = new Date().toISOString()): EvidenceSourceInput {
  const records = lines.filter((line) => line.trim()).map((line) => sweRebenchRecord(JSON.parse(line)));
  return { id: "swe-rebench-2026-07-trajectories", type: "agentic_economics",
    version: "2026-07", date: generatedAt.slice(0, 10),
    harness: "SWE-rebench normalized repeated-run trajectories", records };
}

async function response(fetcher: typeof fetch, url: string) {
  const result = await fetcher(url, { signal: AbortSignal.timeout(120_000) });
  if (!result.ok) throw Error(`Evidence download HTTP ${result.status}: ${url}`);
  return result;
}
async function writeAtomic(output: string, source: EvidenceSourceInput) {
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(source));
  await rename(temporary, output);
  return { output, records: source.records.length,
    sha256: createHash("sha256").update(JSON.stringify(source)).digest("hex") };
}

export async function prepareCodeRouterBench(output: string, fetcher: typeof fetch = fetch,
  now = new Date().toISOString()) {
  const [csv, models] = await Promise.all([
    response(fetcher, CODEROUTER_RESULTS_URL).then((item) => item.text()),
    response(fetcher, CODEROUTER_MODELS_URL).then((item) => item.json()),
  ]);
  return writeAtomic(output, codeRouterSource(csv, models, now));
}

async function trajectoryPaths(fetcher: typeof fetch) {
  const paths: string[] = []; let next: string | undefined = SWE_REBENCH_TREE_URL;
  while (next) {
    const current: string = next;
    const result = await response(fetcher, current);
    const entries = await result.json() as any[];
    for (const item of entries) if (typeof item?.path === "string" &&
      /^trajectories\/.+\.jsonl\.gz$/.test(item.path)) paths.push(item.path);
    const linked = result.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    next = linked ? new URL(linked, current).toString() : undefined;
  }
  return [...new Set(paths)].sort();
}

export async function prepareSWERebench(output: string, fetcher: typeof fetch = fetch,
  now = new Date().toISOString()) {
  const paths = await trajectoryPaths(fetcher);
  if (!paths.length) throw Error("SWE-rebench index contained no trajectory shards");
  const lines: string[] = [];
  for (const path of paths) {
    const url = `${SWE_REBENCH_RESOLVE_ROOT}/${path.split("/").map(encodeURIComponent).join("/")}`;
    const compressed = Buffer.from(await (await response(fetcher, url)).arrayBuffer());
    lines.push(...gunzipSync(compressed).toString("utf8").split("\n").filter(Boolean));
  }
  return writeAtomic(output, sweRebenchSource(lines, now));
}

export const evidenceInputPaths = (directory: string) => ({
  codeRouterBench: join(directory, "evidence", "coderouterbench.json"),
  sweRebench: join(directory, "evidence", "swe-rebench.json"),
});

/** Current price lookup used only while building a snapshot; provider cost is per token. */
export async function currentPricingFromState(directory: string): Promise<CurrentPricing> {
  const pricing: CurrentPricing = {};
  try {
    const snapshot = JSON.parse(await readFile(join(directory, "specialist-metadata.json"), "utf8"));
    for (const model of Array.isArray(snapshot?.models) ? snapshot.models : []) {
      const input = number(model?.pricing?.prompt), output = number(model?.pricing?.completion);
      const cached = number(model?.pricing?.input_cache_read ?? model?.pricing?.cached_input);
      if (typeof model?.id === "string" && input !== undefined && output !== undefined)
        pricing[model.id] = { inputPrice: input * 1e6, outputPrice: output * 1e6,
          ...(cached === undefined ? {} : { cachedInputPrice: cached * 1e6 }) };
    }
  } catch {}
  try {
    const catalog = JSON.parse(await readFile(join(directory, "catalog.json"), "utf8"));
    for (const [id, metadata] of Array.isArray(catalog?.entries) ? catalog.entries : [])
      if (typeof id === "string" && number(metadata?.inputPrice) !== undefined &&
          number(metadata?.outputPrice) !== undefined)
        pricing[id] = { inputPrice: metadata.inputPrice, outputPrice: metadata.outputPrice };
  } catch {}
  return pricing;
}

export async function currentIdentityCatalog(directory: string): Promise<CatalogIdentity[]> {
  try {
    const snapshot = JSON.parse(await readFile(join(directory, "specialist-metadata.json"), "utf8"));
    return (Array.isArray(snapshot?.models) ? snapshot.models : []).flatMap((model: any) =>
      typeof model?.id === "string" ? [{ id: model.id,
        name: typeof model.name === "string" ? model.name : undefined,
        canonicalSlug: typeof model.canonical_slug === "string" ? model.canonical_slug : undefined }] : []);
  } catch { return []; }
}

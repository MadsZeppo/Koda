import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { buildKnowledgeSnapshot, resolveSourceIdentities, type CatalogIdentity,
  type CurrentPricing, type EvidenceSourceInput } from "./ingest.js";
import type { RoutingKnowledgeSnapshot, RoutingKnowledgeSource } from "./schema.js";

async function loadSource(location: string, fetcher: typeof fetch): Promise<EvidenceSourceInput> {
  const raw = /^https?:\/\//.test(location)
    ? await fetcher(location).then(async (response) => {
        if (!response.ok) throw Error(`HTTP ${response.status}`);
        return response.text();
      })
    : await readFile(location, "utf8");
  const value = JSON.parse(raw);
  if (!value || typeof value.id !== "string" || typeof value.type !== "string" || !Array.isArray(value.records))
    throw Error("invalid evidence source document");
  return value;
}

/** Offline/periodic sync. A failed refresh never replaces last-known-good. */
export async function syncRoutingEvidence(locations: string[], output: string,
  fetcher: typeof fetch = fetch, now = new Date().toISOString(),
  pricing: CurrentPricing = {}, identities: CatalogIdentity[] = []): Promise<RoutingKnowledgeSnapshot> {
  const settled = await Promise.allSettled(locations.map((location) => loadSource(location, fetcher)));
  const inputs = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  if (!inputs.length) throw Error("No evidence source succeeded; last-known-good snapshot preserved");
  const snapshot = buildKnowledgeSnapshot(inputs.map((input) =>
    resolveSourceIdentities(input, identities)), now, pricing);
  const failures: RoutingKnowledgeSource[] = settled.flatMap((result, index) =>
    result.status === "rejected" ? [{ id: locations[index]!, type: "benchmark_prior" as const,
      recordCount: 0, status: "failed" as const, detail: String(result.reason) }] : []);
  snapshot.sources = [...(snapshot.sources ?? []), ...failures];
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(snapshot, null, 2));
  // Parse and minimally validate the exact bytes before atomic replacement.
  const check = JSON.parse(await readFile(temporary, "utf8"));
  if (check.schemaVersion !== 2 || !Array.isArray(check.observations))
    throw Error("Generated routing evidence snapshot failed validation");
  await rename(temporary, output);
  return snapshot;
}

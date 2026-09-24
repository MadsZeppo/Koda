import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RoutingKnowledgeSnapshot } from "./schema.js";

const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
export async function routingEvidenceReport(directory: string) {
  const snapshot = await json(join(directory, "routing-knowledge-v2.json")) as RoutingKnowledgeSnapshot;
  const specialist = await json(join(directory, "specialist-metadata.json")).catch(() => undefined);
  const catalog = await json(join(directory, "catalog.json")).catch(() => undefined);
  const identities = { EXACT: 0, FAMILY_TRANSFER: 0, UNKNOWN: 0 };
  const metrics: Record<string, number> = {};
  for (const row of snapshot.observations) {
    identities[row.identityLevel ?? "UNKNOWN"]++;
    metrics[row.metric] = (metrics[row.metric] ?? 0) + 1;
  }
  return {
    snapshotId: snapshot.snapshotId, schemaVersion: snapshot.schemaVersion,
    createdAt: snapshot.createdAt, observations: snapshot.observations.length,
    pairwiseComparisons: snapshot.pairwiseEvidence?.length ?? 0,
    identities, metrics,
    sources: snapshot.sources ?? [],
    catalog: {
      models: Array.isArray(specialist?.models) ? specialist.models.length : 0,
      benchmarks: Array.isArray(specialist?.benchmarks) ? specialist.benchmarks.length : 0,
      retrievedAt: specialist?.retrievedAt ?? catalog?.retrievedAt ?? null,
      pricedConfiguredModels: Array.isArray(catalog?.entries) ? catalog.entries.filter((entry: any) =>
        Number.isFinite(entry?.[1]?.inputPrice) && Number.isFinite(entry?.[1]?.outputPrice)).length : 0,
    },
  };
}

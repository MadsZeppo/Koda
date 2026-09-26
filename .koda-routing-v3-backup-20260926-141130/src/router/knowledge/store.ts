import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROUTING_KNOWLEDGE_V1 } from "./snapshot.js";
import type { ModelRoutingKnowledge, RoutingKnowledgeSnapshot } from "./schema.js";

const valid = (value: any): value is RoutingKnowledgeSnapshot => value &&
  Number.isInteger(value.schemaVersion) && typeof value.snapshotId === "string" &&
  typeof value.createdAt === "string" && Array.isArray(value.observations) &&
  value.observations.every((row: any) => row && typeof row.id === "string" &&
    typeof row.source === "string" && typeof row.metric === "string" && Number.isFinite(row.value));

export class RoutingKnowledgeStore {
  readonly snapshot: RoutingKnowledgeSnapshot;
  readonly path?: string;
  constructor(snapshot?: RoutingKnowledgeSnapshot, directory?: string) {
    this.path = directory ? join(directory, "routing-knowledge-v2.json") : undefined;
    let loaded = snapshot;
    if (!loaded && this.path && existsSync(this.path)) try {
      const candidate = JSON.parse(readFileSync(this.path, "utf8"));
      if (valid(candidate)) loaded = candidate;
    } catch {}
    this.snapshot = loaded ?? ROUTING_KNOWLEDGE_V1;
  }
  forModel(canonicalModelId: string): ModelRoutingKnowledge {
    return {
      snapshotId: this.snapshot.snapshotId,
      observations: this.snapshot.observations.filter((row) =>
        row.canonicalModelId === canonicalModelId && row.identityLevel !== "UNKNOWN"),
      pairwiseEvidence: (this.snapshot.pairwiseEvidence ?? []).filter((row) =>
        row.candidateModelId === canonicalModelId || row.referenceModelId === canonicalModelId),
    };
  }
  unmapped() { return this.snapshot.observations.filter((row) =>
    !row.canonicalModelId || row.identityLevel === "UNKNOWN"); }
}

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROUTING_KNOWLEDGE_V1 } from "./snapshot.js";
import { modelFamilyKey } from "./identity.js";
import type { ModelRoutingKnowledge, PairwiseRoutingEvidence, RoutingKnowledgeObservation,
  RoutingKnowledgeSnapshot, RoutingTaskCase } from "./schema.js";

const valid = (value: any): value is RoutingKnowledgeSnapshot => value &&
  Number.isInteger(value.schemaVersion) && typeof value.snapshotId === "string" &&
  typeof value.createdAt === "string" && Array.isArray(value.observations) &&
  value.observations.every((row: any) => row && typeof row.id === "string" &&
    typeof row.source === "string" && typeof row.metric === "string" && Number.isFinite(row.value));

function transferred(row: RoutingKnowledgeObservation, canonicalModelId: string,
  family: string): RoutingKnowledgeObservation | undefined {
  if (row.canonicalModelId === canonicalModelId && row.identityLevel !== "UNKNOWN") return row;
  const sourceIdentity = row.canonicalModelId ?? row.externalModelName ?? row.displayModel;
  if (modelFamilyKey(sourceIdentity) !== family) return undefined;
  return {
    ...row,
    id: `${row.id}::family:${canonicalModelId}`,
    canonicalModelId,
    identityLevel: "FAMILY_TRANSFER",
  };
}

export class RoutingKnowledgeStore {
  readonly snapshot: RoutingKnowledgeSnapshot;
  readonly path?: string;
  private readonly byFamily = new Map<string, RoutingKnowledgeObservation[]>();
  private readonly pairsByModel = new Map<string, PairwiseRoutingEvidence[]>();
  private readonly tasksByFamily = new Map<string, RoutingTaskCase[]>();
  private readonly tasksByModel = new Map<string, RoutingTaskCase[]>();
  private readonly modelCache = new Map<string, ModelRoutingKnowledge>();
  constructor(snapshot?: RoutingKnowledgeSnapshot, directory?: string) {
    this.path = directory ? join(directory, "routing-knowledge-v2.json") : undefined;
    let loaded = snapshot;
    if (!loaded && this.path && existsSync(this.path)) try {
      const candidate = JSON.parse(readFileSync(this.path, "utf8"));
      if (valid(candidate)) loaded = candidate;
    } catch {}
    this.snapshot = loaded ?? ROUTING_KNOWLEDGE_V1;
    for (const row of this.snapshot.observations) {
      const identity = row.canonicalModelId ?? row.externalModelName ?? row.displayModel;
      const family = modelFamilyKey(identity);
      if (family) this.byFamily.set(family, [...(this.byFamily.get(family) ?? []), row]);
    }
    for (const row of this.snapshot.pairwiseEvidence ?? [])
      for (const id of new Set([row.candidateModelId, row.referenceModelId]))
        this.pairsByModel.set(id, [...(this.pairsByModel.get(id) ?? []), row]);
    for (const task of this.snapshot.taskCases ?? []) {
      const ids = new Set(task.outcomes.map((outcome) => outcome.modelId));
      const families = new Set([...ids].map(modelFamilyKey).filter(Boolean) as string[]);
      for (const id of ids)
        this.tasksByModel.set(id, [...(this.tasksByModel.get(id) ?? []), task]);
      for (const family of families)
        this.tasksByFamily.set(family, [...(this.tasksByFamily.get(family) ?? []), task]);
    }
  }
  forModel(canonicalModelId: string): ModelRoutingKnowledge {
    const cached = this.modelCache.get(canonicalModelId);
    if (cached) return cached;
    const family = modelFamilyKey(canonicalModelId);
    const observations = family
      ? (this.byFamily.get(family) ?? []).flatMap((row) => {
          const item = transferred(row, canonicalModelId, family);
          return item ? [item] : [];
        })
      : this.snapshot.observations.filter((row) =>
          row.canonicalModelId === canonicalModelId && row.identityLevel !== "UNKNOWN");
    const result = {
      snapshotId: this.snapshot.snapshotId,
      observations,
      pairwiseEvidence: this.pairsByModel.get(canonicalModelId) ?? [],
      taskCases: family
        ? this.tasksByFamily.get(family) ?? []
        : this.tasksByModel.get(canonicalModelId) ?? [],
      contextualValidated: this.snapshot.validation?.passed === true,
    };
    this.modelCache.set(canonicalModelId, result);
    return result;
  }
  unmapped() { return this.snapshot.observations.filter((row) =>
    !row.canonicalModelId || row.identityLevel === "UNKNOWN"); }
}

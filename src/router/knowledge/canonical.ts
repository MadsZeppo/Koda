import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { modelFamilyKey } from "./identity.js";
import { RoutingKnowledgeStore } from "./store.js";
import { buildKnowledgeSnapshot, type EvidenceSourceInput } from "./ingest.js";
import {
  canonicalRoutingTask,
  type CanonicalRoutingTask,
} from "../canonicalTask.js";
import type { RoutingKnowledgeSnapshot, ModelIdentityLevel } from "./schema.js";
import type { EvidenceRole } from "./evidenceRegistry.js";

/** Quality identity never depends on provider transport. Operational state still may. */
export const canonicalEvidenceDirectory = (root = join(homedir(), ".koda")) =>
  join(root, "routing-quality");
export interface CanonicalQualityObservation {
  id: string;
  taskId: string;
  task: CanonicalRoutingTask;
  model: string;
  revision?: string;
  family?: string;
  provider?: string;
  identity: ModelIdentityLevel | "SOURCE_EXACT" | "VERSION_TRANSFER";
  source: string;
  population?: string;
  configuration?: string;
  split: "probing" | "development" | "id_test" | "ood" | "local" | "synthetic";
  role?: EvidenceRole;
  origin: "external" | "local" | "synthetic";
  provenance: string;
  timestamp: string;
  /** Full benchmark score retained separately from complete solve. */
  score?: number;
  success?: boolean;
  outcome?: string;
  proof?: { independent: boolean; requirementLevel: boolean };
  attribution?: { primaryCause: string; learningDisposition: string };
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  latencyMs?: number;
  propensity?: number;
  trainingAllowed: boolean;
}
export function trainingEligible(row: CanonicalQualityObservation): boolean {
  if (
    !row ||
    !row.task ||
    !row.model ||
    !row.id ||
    !row.timestamp ||
    !row.trainingAllowed ||
    !row.provenance ||
    row.origin === "synthetic" ||
    row.role === "FINAL_HOLDOUT" ||
    row.role === "SYNTHETIC" ||
    row.identity === "UNKNOWN" ||
    !["probing", "development", "local"].includes(row.split)
  )
    return false;
  if (row.origin === "local") {
    if (row.split !== "local") return false;
    return row.success === true
      ? row.outcome === "VERIFIED_SUCCESS" &&
          row.proof?.independent === true &&
          row.proof.requirementLevel === true
      : row.success === false &&
          row.attribution?.primaryCause === "MODEL_FAILURE" &&
          row.attribution.learningDisposition === "NEGATIVE_MODEL_EVIDENCE";
  }
  return (
    typeof row.success === "boolean" ||
    (typeof row.score === "number" &&
      Number.isFinite(row.score) &&
      row.score >= 0 &&
      row.score <= 1)
  );
}
/** Unknown legacy split is deliberately not inferred from a filename or source ID. */
export function normalizeCanonicalSource(
  source: EvidenceSourceInput,
  now: string,
): CanonicalQualityObservation[] {
  const snapshot = canonicalKnowledgeSnapshotBody([source], now);
  return snapshot.qualityEvidence!;
}
function canonicalKnowledgeSnapshotBody(
  inputs: EvidenceSourceInput[],
  now = new Date().toISOString(),
): RoutingKnowledgeSnapshot {
  for (const s of inputs)
    if (
      !s.split ||
      (s.trainingAllowed && !["probing", "development"].includes(s.split))
    )
      throw Error("Invalid training/source split policy");
  const snapshot = buildKnowledgeSnapshot(
    inputs.filter((s) => s.trainingAllowed),
    now,
  );
  snapshot.qualityEvidence = inputs.flatMap((source) => {
    const tasks = new Map(source.tasks?.map((t) => [t.taskKey, t]));
    const seen = new Set<string>();
    return source.records.map((row) => {
      if (!row.taskKey || !tasks.has(row.taskKey))
        throw Error("Dense evidence requires a task descriptor");
      const task = tasks.get(row.taskKey)!;
      if (task.split && task.split !== source.split)
        throw Error("Task/source split mismatch");
      const model = row.canonicalModelId ?? row.externalModelName;
      if (!model) throw Error("Missing benchmark model identity");
      const key = `${source.id}\0${row.taskKey}\0${model}\0${row.engine ?? source.engine ?? "unknown"}`;
      if (seen.has(key)) throw Error("Duplicate task/model outcome");
      seen.add(key);
      return {
        id: createHash("sha256").update(key).digest("hex"),
        taskId: row.taskKey,
        task: {
          ...canonicalRoutingTask({
            family: task.taskFamily,
            text: task.text,
            engine: row.engine ?? source.engine,
            harness: source.harness ?? "unknown",
          }),
          languages: task.languages ?? [],
        },
        model,
        family: modelFamilyKey(model),
        revision: row.revision,
        identity: row.identityLevel ?? "UNKNOWN",
        source: source.id,
        split: source.split!,
        origin: "external" as const,
        provenance: `${source.id}:${source.version ?? "unversioned"}`,
        timestamp: source.date ?? now,
        score: row.benchmarkScore,
        success: row.success,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        costUsd: row.reportedCostUsd,
        latencyMs: row.latencyMs,
        trainingAllowed: source.trainingAllowed === true,
      };
    });
  });
  snapshot.snapshotId = `canonical-${createHash("sha256").update(JSON.stringify(snapshot.qualityEvidence)).digest("hex")}`;
  return snapshot;
}
export function canonicalKnowledgeSnapshot(
  inputs: EvidenceSourceInput[],
  now = new Date().toISOString(),
): RoutingKnowledgeSnapshot {
  for (const source of inputs)
    if (
      source.trainingAllowed !== true ||
      !["probing", "development"].includes(source.split ?? "")
    )
      throw Error(
        `Training source rejected: ${source.id} (${source.split ?? "unknown"})`,
      );
  return canonicalKnowledgeSnapshotBody(inputs, now);
}
/** Extends the existing store; not a second ingestion or provider-specific ledger. */
export class CanonicalRoutingKnowledgeStore extends RoutingKnowledgeStore {
  readonly ledgerPath: string;
  constructor(
    directory = canonicalEvidenceDirectory(),
    snapshot?: RoutingKnowledgeSnapshot,
  ) {
    super(snapshot, directory);
    this.ledgerPath = join(directory, "quality-local.jsonl");
  }
  evidence(): CanonicalQualityObservation[] {
    let local: CanonicalQualityObservation[] = [];
    try {
      local = readFileSync(this.ledgerPath, "utf8")
        .split("\n")
        .flatMap((line) => {
          try {
            const row = JSON.parse(line);
            return trainingEligible(row) ? [row] : [];
          } catch {
            return [];
          }
        });
    } catch {}
    return [
      ...new Map(
        [...(this.snapshot.qualityEvidence ?? []), ...local]
          .filter(trainingEligible)
          .map((r) => [r.id, r]),
      ).values(),
    ];
  }
  record(row: CanonicalQualityObservation): boolean {
    if (!trainingEligible(row) || row.origin !== "local") return false;
    if (
      row.propensity !== undefined &&
      (!Number.isFinite(row.propensity) ||
        row.propensity <= 0 ||
        row.propensity > 1)
    )
      throw Error("Invalid selection propensity");
    if (this.evidence().some((r) => r.id === row.id)) return false;
    mkdirSync(join(this.ledgerPath, ".."), { recursive: true });
    appendFileSync(this.ledgerPath, JSON.stringify(row) + "\n", {
      mode: 0o600,
    });
    return true;
  }
}

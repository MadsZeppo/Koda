import { createHash } from "node:crypto";
import { open, readFile, writeFile } from "node:fs/promises";
export type EvidenceRole =
  | "TRAIN"
  | "DEVELOPMENT"
  | "CALIBRATION"
  | "FINAL_HOLDOUT"
  | "SYNTHETIC"
  | "LOCAL_ONLINE";
export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function taskEvidenceRole(taskId: string): EvidenceRole {
  const n =
    parseInt(
      createHash("sha256").update(taskId).digest("hex").slice(0, 8),
      16,
    ) % 100;
  return n < 70 ? "TRAIN" : n < 85 ? "CALIBRATION" : "DEVELOPMENT";
}
export interface EvidenceEnvelope<T> {
  version: 1;
  digest: string;
  sourceDigests: Record<string, string>;
  modelMappingDigest: string;
  taskVersion: number;
  splitDigest: string;
  estimatorVersion: string;
  calibrationVersion: string;
  policyDigest: string;
  timestamp: string;
  provenance: string[];
  payload: T;
}
export function freezeEvidence<T>(
  payload: T,
  metadata: Omit<EvidenceEnvelope<T>, "version" | "digest" | "payload">,
): EvidenceEnvelope<T> {
  const body = { version: 1 as const, ...metadata, payload };
  return { ...body, digest: digest(body) };
}
export function validateEvidence<T>(
  a: EvidenceEnvelope<T>,
  expected?: { policyDigest?: string; splitDigest?: string },
) {
  const { digest: actual, ...body } = a;
  if (
    a.version !== 1 ||
    actual !== digest(body) ||
    (expected?.policyDigest && expected.policyDigest !== a.policyDigest) ||
    (expected?.splitDigest && expected.splitDigest !== a.splitDigest)
  )
    throw Error("Frozen evidence mismatch");
  return a;
}
export class EvidenceSplitRegistry {
  private assignments = new Map<string, EvidenceRole>();
  assign(source: string, task: string, role: EvidenceRole) {
    const key = source + "\0" + task;
    const old = this.assignments.get(key);
    if (old && old !== role)
      throw Error("Immutable split assignment / leakage");
    for (const [other, assigned] of this.assignments)
      if (
        other.split("\0")[1] === task &&
        assigned !== role &&
        (assigned === "FINAL_HOLDOUT" || role === "FINAL_HOLDOUT")
      )
        throw Error("Holdout task cannot move across source namespaces");
    this.assignments.set(key, role);
  }
  allowsTraining(source: string, task: string) {
    return ["TRAIN", "DEVELOPMENT", "CALIBRATION", "LOCAL_ONLINE"].includes(
      this.assignments.get(source + "\0" + task) ?? "",
    );
  }
  snapshot() {
    return [...this.assignments].sort(([a], [b]) => a.localeCompare(b));
  }
}
/** Claim before reading labels; an interrupted holdout is consumed rather than available for tuning. */
export async function claimFinalEvaluation(
  path: string,
  artifactDigest: string,
) {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(
      JSON.stringify({ artifactDigest, claimedAt: new Date().toISOString() }),
    );
  } finally {
    await handle.close();
  }
}
export async function writeImmutable<T>(
  path: string,
  artifact: EvidenceEnvelope<T>,
) {
  validateEvidence(artifact);
  try {
    await writeFile(path, JSON.stringify(artifact), { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const old = validateEvidence(JSON.parse(await readFile(path, "utf8")));
    if (old.digest !== artifact.digest)
      throw Error("Immutable artifact already exists with different contents");
  }
}

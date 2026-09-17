import {
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Features } from "./features.js";
import type { TaskFingerprint } from "./taskFingerprint.js";
export interface Attempt {
  timestamp: string;
  runId: string;
  subtaskId: string;
  modelRequested: string;
  modelServed: string | null;
  features: Features;
  fingerprint?: TaskFingerprint;
  verification: string;
  wallClockMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  escalated: boolean;
  reason?: string;
}
/** One append syscall per record (O_APPEND); no read/modify/write race between workers. */
export class History {
  readonly path: string;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    this.path = join(directory, "attempts.jsonl");
  }
  read(): Attempt[] {
    try {
      const records = readFileSync(this.path, "utf8")
        .split("\n")
        .flatMap((l) => {
          try {
            const row = JSON.parse(l);
            return row && typeof row === "object" ? [row] : [];
          } catch {
            return [];
          }
        });
      const finals = new Map(
        records
          .filter((r) => r.type === "run_final")
          .map((r) => [r.runId, r.status]),
      );
      return records
        .filter(
          (r) =>
            r.features &&
            Array.isArray(r.features.languages) &&
            typeof r.modelRequested === "string" &&
            Number.isFinite(r.wallClockMs),
        )
        .map((r) =>
          r.verification === "VERIFIED_SUCCESS" &&
          finals.has(r.runId) &&
          finals.get(r.runId) !== "VERIFIED_SUCCESS"
            ? {
                ...r,
                verification: "FAILED",
                reason: "Final run verification did not succeed",
              }
            : r,
        );
    } catch {
      return [];
    }
  }
  private append(record: unknown) {
    const fd = openSync(this.path, "a", 0o600);
    try {
      writeSync(fd, "\n" + JSON.stringify(record) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  record(record: Attempt) {
    this.append(record);
  }
  finalize(runId: string, status: string) {
    this.append({
      type: "run_final",
      runId,
      status,
      timestamp: new Date().toISOString(),
    });
  }
}

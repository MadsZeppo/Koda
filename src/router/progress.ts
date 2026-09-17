import { createHash } from "node:crypto";
import type { VerificationResult } from "../types.js";
export class ProgressTracker {
  stalls = 0;
  hashes: string[] = [];
  reads = new Map<string, number>();
  previousDiffBytes = 0;
  failures = new Map<string, number>();
  evidenceProgressCycles = 0;
  seenEvidence = new Set<string>();
  static readonly maxEvidenceProgressCycles = 4;
  assess(
    before: VerificationResult,
    after: VerificationResult,
    diff: string,
    actions: string[],
    executedChecks = true,
    evidence: string[] = [],
    workspaceChanged = false,
  ) {
    const hash = createHash("sha256").update(diff).digest("hex");
    const oscillating =
      this.hashes.slice(0, -1).includes(hash) && this.hashes.at(-1) !== hash;
    this.hashes.push(hash);
    for (const a of actions)
      if (a.startsWith("read_file"))
        this.reads.set(a, (this.reads.get(a) ?? 0) + 1);
    for (const c of executedChecks ? after.checks : [])
      if (c.exitCode !== 0)
        this.failures.set(c.command, (this.failures.get(c.command) ?? 0) + 1);
    const verificationProgress =
      after.failedChecks < before.failedChecks ||
      (before.failingTests !== null &&
        after.failingTests !== null &&
        after.failingTests < before.failingTests) ||
      (before.buildErrors !== null &&
        after.buildErrors !== null &&
        after.buildErrors < before.buildErrors);
    const newEvidence = [
      ...new Set(evidence.filter((item) => !this.seenEvidence.has(item))),
    ];
    for (const item of evidence) this.seenEvidence.add(item);
    const evidenceProgress =
      !verificationProgress &&
      newEvidence.length > 0 &&
      this.evidenceProgressCycles < ProgressTracker.maxEvidenceProgressCycles;
    if (evidenceProgress) this.evidenceProgressCycles++;
    const workspaceProgress = workspaceChanged && diff.length > 0;
    const progress = verificationProgress || evidenceProgress || workspaceProgress;
    this.stalls = progress ? 0 : this.stalls + 1;
    const diffBytes = Buffer.byteLength(diff);
    const diffGrowsWithoutImprovement =
      diffBytes > this.previousDiffBytes && !progress;
    this.previousDiffBytes = diffBytes;
    return {
      reproductionFixed: before.checks.some(
        (c, i) =>
          c.exitCode !== 0 &&
          after.checks[i]?.command === c.command &&
          after.checks[i]?.exitCode === 0,
      ),
      diffGrowsWithoutImprovement,
      measurableProgress: progress,
      verificationProgress,
      evidenceProgress,
      workspaceProgress,
      evidenceProgressCycles: this.evidenceProgressCycles,
      newEvidence,
      noProgressCycles: this.stalls,
      oscillating,
      repeatedReads: [...this.reads].filter(([, n]) => n > 2),
      repeatedFailedCommands: [...this.failures].filter(([, n]) => n > 1),
      diffBytes: Buffer.byteLength(diff),
      escalate: this.stalls >= 2 || oscillating,
    };
  }
}

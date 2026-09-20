import type { EcosystemProfile, CheckKind, VerificationRequirement } from "./repo/ecosystem.js";
export type Status = "VERIFIED_SUCCESS" | "FAILED" | "NOT_FULLY_VERIFIED";
export interface CommandResult {
  command: string;
  outcome?:
    | "CHECK_PASS"
    | "CHECK_FAIL"
    | "CHECK_UNAVAILABLE"
    | "INFRA_FAILURE";
  kind?: CheckKind;
  cwd?: string;
  source?: string;
  requirement?: VerificationRequirement;
  unavailable?: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  wallClockMs: number;
  timedOut: boolean;
  infrastructureRecoveryAttempts?: number;
}
export interface VerificationResult {
  dimensions?: Partial<
    Record<CheckKind, "PASS" | "FAIL" | "NOT_RUN" | "UNAVAILABLE">
  >;
  status: Status;
  checks: CommandResult[];
  failedChecks: number;
  failingTests: number | null;
  buildErrors: number | null;
}
export interface RepoProfile {
  ecosystem?: EcosystemProfile;
  root: string;
  commit: string;
  status: string;
  diff: string;
  files: string[];
  topLevel: string[];
  extensions: Record<string, number>;
  symbols: string[];
  packageManager: string;
  scripts: Record<string, string>;
  configs: Record<string, string>;
  verificationCommands: string[];
}
export interface Usage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  raw: unknown;
}
export interface HandoffPacket {
  originalObjective: string;
  acceptanceCriteria: string[];
  relevantFiles: string[];
  currentDiff: string;
  reproduction: string;
  verificationFailures: CommandResult[];
  approachesAlreadyAttempted: string[];
  disprovenHypotheses: string[];
  remainingProblem: string;
}

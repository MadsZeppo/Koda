import type { Subtask, EvidencePacket } from "../planner/schemas.js";
import type { RepoProfile, VerificationResult } from "../types.js";
import type { Role } from "./modelRegistry.js";
export interface RoutingInput {
  originalTask: string;
  subtask: Subtask;
  profile: RepoProfile;
  evidence: EvidencePacket;
  attempts: number;
  currentDiff: string;
  verification: VerificationResult;
  spent: { tokens: number; costUsd: number; wallClockMs: number };
}
export interface ModelRouter {
  select(input: RoutingInput): Role;
  escalate(role: Role): Role | null;
}
export const router: ModelRouter = {
  select: ({ subtask, evidence, verification }) =>
    subtask.estimatedDifficulty === "high" ||
    (evidence.uncertainty === "high" && evidence.dependencies.length > 1) ||
    (evidence.relevantFiles.length > 6 && verification.failedChecks > 1) ||
    (evidence.dependencies.length > 1 &&
      new Set(
        evidence.relevantFiles.map((p) => p.split("/").slice(0, -1).join("/")),
      ).size > 1)
      ? "STRONG_MODEL"
      : "CHEAP_CODER_A",
  escalate: (role) =>
    role === "CHEAP_CODER_A" || role === "CHEAP_CODER_B"
      ? "STRONG_MODEL"
      : role === "STRONG_MODEL"
        ? "FRONTIER_MODEL"
        : null,
};

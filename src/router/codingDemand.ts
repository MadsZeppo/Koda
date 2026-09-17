import { dirname } from "node:path";
import type { Subtask } from "../planner/schemas.js";
import type { Features } from "./features.js";

export type CodingTier = "low" | "medium" | "high" | "frontier";
export interface CodingDemand {
  tier: Exclude<CodingTier, "frontier">;
  minCodingScore: number;
  reason: string;
  confidence: "high" | "medium";
}

export const PARETO_CODE_MODEL = "openrouter/pareto-code";
export const codingScore = (tier: Exclude<CodingTier, "frontier">) =>
  ({ low: 0, medium: 0.33, high: 0.66 })[tier];
export const nextCodingTier = (tier: CodingTier): CodingTier | undefined =>
  ({ low: "medium", medium: "high", high: "frontier", frontier: undefined })[
    tier
  ] as CodingTier | undefined;

/** Local policy only: no prompt-length, model-name or learned-history rules. */
export function codingDemand(
  features: Features,
  subtask: Subtask,
  effort: "tiny" | "normal" | "complex" = "normal",
): CodingDemand | undefined {
  if (subtask.readOnly || features.taskKind === "planning") return undefined;
  const paths = subtask.likelyWritePaths;
  const components = new Set(paths.map(dirname)).size;
  const coupled =
    features.requiresArchitectureReasoning ||
    features.requiresCrossModuleReasoning ||
    features.complexity === "large" ||
    components > 1 ||
    subtask.dependsOn.length > 0;
  let tier: CodingDemand["tier"];
  let reason: string;
  if (features.executionStrategy === "stable") {
    tier = "medium";
    reason = "Bounded inspect, fix and test work";
  } else if (
    features.executionStrategy === "direct" &&
    !coupled &&
    paths.length <= 1
  ) {
    tier = "low";
    reason =
      effort === "tiny"
        ? "Exact tiny local edit"
        : "Bounded direct implementation";
  } else if (coupled || subtask.estimatedDifficulty === "high") {
    tier = "high";
    reason = "Coupled, cross-component or high-difficulty implementation";
  } else {
    tier = "medium";
    reason = "Isolated planned implementation";
  }
  return {
    tier,
    minCodingScore: codingScore(tier),
    reason,
    confidence: paths.length ? "high" : "medium",
  };
}

export function qualityFailure(
  checks: readonly { outcome?: string }[],
  noProgress: boolean,
) {
  if (
    checks.some(
      (check) =>
        check.outcome === "INFRA_FAILURE" ||
        check.outcome === "CHECK_UNAVAILABLE",
    )
  )
    return false;
  return checks.some((check) => check.outcome === "CHECK_FAIL") || noProgress;
}

import { test } from "node:test";
import assert from "node:assert/strict";

import { selectQualitySafeJointPlan } from "../src/router/modelRouter.js";

const plan = (
  initialModel: string,
  conservativeQuality: number,
  optimizerScore: number,
  evaluatedPlans: Array<{
    conservativeFinalSuccess: number;
    eligible: boolean;
    hardRejection?: string;
  }>,
) => ({
  initialModel,
  conservativeQuality,
  allowedQualityRegret: 0.02,
  optimizerScore,
  expectedLatencyMs: 1_000,
  expectedLatencyP90Ms: 1_000,
  expectedCostPerVerifiedSolve: 0.01,
  evaluatedPlans,
}) as any;

test("joint routing ignores ineligible plans when deriving its quality reference", () => {
  const planned = {
    executionStrategy: "planned" as const,
    plan: plan("opus", 0.789, 2, [
      { conservativeFinalSuccess: 0.789, eligible: true },
      { conservativeFinalSuccess: 0.95, eligible: false },
    ]),
  };
  const stableFallback = {
    executionStrategy: "stable" as const,
    plan: plan("deepseek", 0.696, 1, [
      { conservativeFinalSuccess: 0.94, eligible: false },
    ]),
  };

  const selected = selectQualitySafeJointPlan([planned, stableFallback]);
  assert.equal(selected?.executionStrategy, "planned");
  assert.equal(selected?.plan.initialModel, "opus");
});

test("joint routing still has an executable bounded plan when every optimizer plan is ineligible", () => {
  const stable = {
    executionStrategy: "stable" as const,
    plan: plan("deepseek", 0.70, 1, [
      { conservativeFinalSuccess: 0.96, eligible: false },
    ]),
  };
  const direct = {
    executionStrategy: "direct" as const,
    plan: plan("gemini", 0.67, 2, [
      { conservativeFinalSuccess: 0.95, eligible: false },
    ]),
  };

  const selected = selectQualitySafeJointPlan([stable, direct]);
  assert.equal(selected?.executionStrategy, "stable");
  assert.equal(selected?.plan.initialModel, "deepseek");
});

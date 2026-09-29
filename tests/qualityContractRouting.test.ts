import { test } from "node:test";
import assert from "node:assert/strict";

import { hasSufficientQualityEvidence } from "../src/router/routeOptimizer.js";
import {
  chooseAdaptiveRecovery,
  recoveryEvidenceSufficient,
} from "../src/router/controlPolicy.js";

const fp = {
  scope: "single",
  verificationStrength: "strong",
  verifierFalseAcceptRisk: "low",
  recoveryDetectability: "high",
  consequenceRisk: "low",
  blastRadius: "single-file",
  architectureHeavy: false,
  publicApiRisk: false,
  schemaRisk: false,
  configRisk: false,
  difficulty: { changeRisk: "low" },
} as any;

const candidate = (
  id: string,
  evidenceLevel: "PROVEN" | "SUPPORTED" | "PROMISING" | "UNKNOWN",
  conservativeQuality: number,
  expectedAttemptCost: number,
  operationalErrorRate = 0,
) => ({
  model: { id, tier: "cheap" as const },
  quality: conservativeQuality + 0.02,
  conservativeQuality,
  evidenceLevel,
  observationCount: evidenceLevel === "UNKNOWN" ? 0 : 20,
  localQualityEvidence: 0,
  expectedAttemptCost,
  expectedAttemptLatencyMs: 1000,
  conservativeAttemptCost: expectedAttemptCost * 1.2,
  operationalErrorRate,
  tokenEfficiency: { p90TotalTokens: 1000 },
});

test("UNKNOWN quality evidence cannot win a production first attempt", () => {
  assert.equal(
    hasSufficientQualityEvidence(
      candidate("unknown-cheap", "UNKNOWN", 0.9, 0) as any,
      fp,
      3,
    ),
    false,
  );
});

test("PROMISING can compete when deterministic verification makes mistakes detectable", () => {
  assert.equal(
    hasSufficientQualityEvidence(
      candidate("promising", "PROMISING", 0.9, 0.001) as any,
      fp,
      3,
    ),
    true,
  );
});

test("PROMISING is rejected when verification is weak", () => {
  assert.equal(
    recoveryEvidenceSufficient(
      candidate("promising", "PROMISING", 0.9, 0.001) as any,
      { ...fp, verificationStrength: "weak", verifierFalseAcceptRisk: "high" },
      3,
    ),
    false,
  );
});

test("operational recovery chooses cheapest quality-safe candidate, not a tier jump", () => {
  const initial = candidate("free-model", "SUPPORTED", 0.91, 0);
  const cheapSafe = candidate("cheap-safe", "SUPPORTED", 0.905, 0.001, 0.02);
  const expensiveStrong = {
    ...candidate("expensive-strong", "PROVEN", 0.94, 0.05, 0.01),
    model: { id: "expensive-strong", tier: "strong" as const },
  };

  const policy = {
    maxCodingAttempts: 4,
    requiredQuality: 0.89,
    taskFingerprint: fp,
    approvedCandidateSet: [initial, cheapSafe, expensiveStrong],
    qualityCascadeModelIds: [
      initial.model.id,
      cheapSafe.model.id,
      expensiveStrong.model.id,
    ],
    operationalRecoveryModelIds: [
      cheapSafe.model.id,
      expensiveStrong.model.id,
    ],
  } as any;

  const selected = chooseAdaptiveRecovery(
    policy,
    {
      failureMode: "operational",
      failurePhase: "PROVIDER",
      previousModel: initial.model.id,
      mutationObserved: false,
    },
    new Set([initial.model.id]),
  );

  assert.equal(selected?.model.id, "cheap-safe");
});

test("recovery refuses a cheaper candidate below the frozen quality floor", () => {
  const initial = candidate("initial", "SUPPORTED", 0.91, 0.002);
  const tooWeak = candidate("too-weak", "PROVEN", 0.86, 0.0001);
  const safe = candidate("safe", "SUPPORTED", 0.90, 0.003);

  const policy = {
    maxCodingAttempts: 4,
    requiredQuality: 0.89,
    taskFingerprint: fp,
    approvedCandidateSet: [initial, tooWeak, safe],
    operationalRecoveryModelIds: [tooWeak.model.id, safe.model.id],
  } as any;

  const selected = chooseAdaptiveRecovery(
    policy,
    {
      failureMode: "operational",
      failurePhase: "PROVIDER",
      previousModel: initial.model.id,
      mutationObserved: false,
    },
    new Set([initial.model.id]),
  );

  assert.equal(selected?.model.id, "safe");
});

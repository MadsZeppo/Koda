import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateRoutingPolicies, type RoutingEvaluationCase } from
  "../src/router/evaluation.js";

const cases: RoutingEvaluationCase[] = Array.from({ length: 20 }, (_, index) => ({
  id: `task-${index}`,
  outcomes: [
    { modelId: "cheap", compatible: true, verifiedSuccess: index !== 19,
      quality: .98, costUsd: .01 + index / 10_000, latencyMs: 100,
      inputTokens: 90, outputTokens: 10, predictedTokens: 100, predictedSuccess: .95,
      predictedCostUsd: .01 + index / 10_000, predictedLatencyMs: 100 },
    { modelId: "weakest-price", compatible: true, verifiedSuccess: false,
      quality: .6, costUsd: .001, latencyMs: 50, predictedSuccess: .7 },
    { modelId: "reference", compatible: true, verifiedSuccess: true,
      quality: 1, costUsd: .5, latencyMs: 300, predictedSuccess: .99 },
    { modelId: "incompatible", compatible: false, verifiedSuccess: true,
      quality: 1, costUsd: 0, latencyMs: 1 },
  ],
  currentPlan: ["reference"],
  evidenceFirstPlan: ["cheap", "reference"],
  staticPlan: ["reference"],
  taskRegion: index % 2 ? "localized" : "cross-file",
  paraphraseGroup: `pair-${Math.floor(index / 2)}`,
}));

test("offline routing evaluation compares quality-safe economics against deterministic baselines", () => {
  const metrics = new Map(evaluateRoutingPolicies(cases).map((row) => [row.policy, row]));
  const strongest = metrics.get("strongest-executable")!;
  const cheapest = metrics.get("cheapest-compatible")!;
  const evidence = metrics.get("evidence-first")!;
  assert.equal(evidence.verifiedSuccessRate, strongest.verifiedSuccessRate);
  assert.ok(evidence.costPerVerifiedSuccess! < strongest.costPerVerifiedSuccess! / 5);
  assert.ok(evidence.costP99Usd >= evidence.costP90Usd);
  assert.equal(cheapest.unsafeCheapSelections, 20);
  assert.equal(evidence.unsafeCheapSelections, 1);
  assert.equal(evidence.recoveryRate, 1 / 20);
  assert.equal(evidence.distinctModels, 2);
  assert.equal(evidence.tokenPredictionError, 0);
  assert.equal(evidence.costPredictionErrorUsd, 0);
  assert.equal(evidence.latencyPredictionErrorMs, 0);
  assert.equal(evidence.paraphraseRouteAgreement, 1);
  assert.deepEqual(Object.keys(evidence.calibrationByTaskRegion).sort(),
    ["cross-file", "localized"]);
});

test("provider failures remain operational in offline calibration", () => {
  const [evidence] = evaluateRoutingPolicies([{
    id: "provider", currentPlan: ["cheap"], evidenceFirstPlan: ["cheap", "reference"],
    outcomes: [
      { modelId: "cheap", compatible: true, verifiedSuccess: false, quality: .98,
        costUsd: .002, latencyMs: 20, predictedSuccess: .99, providerFailure: true },
      { modelId: "reference", compatible: true, verifiedSuccess: true, quality: 1,
        costUsd: .1, latencyMs: 100, predictedSuccess: .99 },
    ],
  }]).filter((row) => row.policy === "evidence-first");
  assert.equal(evidence!.providerFailures, 1);
  assert.equal(evidence!.unsafeCheapSelections, 0);
  assert.equal(evidence!.verifiedSuccesses, 1);
  // Operational failures are excluded from semantic calibration.
  assert.ok(evidence!.calibrationBrier! < .001);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseNextProbe, modelOnboardingStage } from "../src/router/probePolicy.js";

test("new models advance through evidence-backed onboarding stages", () => {
  assert.equal(modelOnboardingStage({ metadataAvailable: false, protocolCompatible: false,
    publicSamples: 0, probeSamples: 0, verifiedProductionSamples: 0,
    productionTaskFamilies: 0 }), "UNKNOWN");
  assert.equal(modelOnboardingStage({ metadataAvailable: true, protocolCompatible: true,
    publicSamples: 0, probeSamples: 3, verifiedProductionSamples: 0,
    productionTaskFamilies: 0 }), "LIMITED_ELIGIBILITY");
  assert.equal(modelOnboardingStage({ metadataAvailable: true, protocolCompatible: true,
    publicSamples: 10, probeSamples: 3, verifiedProductionSamples: 30,
    productionTaskFamilies: 4 }), "BROADER_ELIGIBILITY");
});

test("adaptive probing chooses one affordable eligibility-changing probe and stops otherwise", () => {
  const decision = chooseNextProbe([
    { modelId: "incumbent", taskFamily: "debugging", stage: "BROADER_ELIGIBILITY",
      uncertainty: .01, expectedProbeCostUsd: .01, economicUpside: 0,
      eligibilityBoundaryDistance: 0, protocolCompatible: true },
    { modelId: "new-cheap", taskFamily: "debugging", stage: "PUBLIC_EVIDENCE_ONLY",
      uncertainty: .2, expectedProbeCostUsd: .002, economicUpside: .8,
      eligibilityBoundaryDistance: .01, protocolCompatible: true },
    { modelId: "incompatible", taskFamily: "debugging", stage: "METADATA_AVAILABLE",
      uncertainty: .5, expectedProbeCostUsd: .001, economicUpside: 1,
      eligibilityBoundaryDistance: 0, protocolCompatible: false },
  ], .003);
  assert.equal(decision.candidate?.modelId, "new-cheap");
  const stopped = chooseNextProbe([{ modelId: "far", taskFamily: "debugging",
    stage: "PROTOCOL_COMPATIBLE", uncertainty: .1, expectedProbeCostUsd: .01,
    economicUpside: 0, eligibilityBoundaryDistance: .5, protocolCompatible: true }], .02);
  assert.equal(stopped.candidate, undefined);
  assert.match(stopped.reason, /^stop:/);
});

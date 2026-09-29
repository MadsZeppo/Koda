import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assessmentFromDecisionPayload,
  semanticTaskAssessmentSchema,
} from "../src/router/taskInterpreter.js";
import { preserveCanonicalTaskEvidence } from "../src/router/taskFingerprint.js";

test("semantic assessment accepts a bounded cheap-first bugfix", () => {
  const result = semanticTaskAssessmentSchema.parse({
    semanticDifficulty: "easy",
    repoReasoning: "low",
    localizationDifficulty: "medium",
    verificationStrength: "strong",
    consequenceRisk: "low",
    expectedChangeSize: "single-file",
    startingTier: "cheap",
    frontierJustified: false,
    confidence: 0.95,
    reason: "Small deterministic bugfix with executable verification.",
  });
  assert.equal(result.startingTier, "cheap");
  assert.equal(result.frontierJustified, false);
});

test("semantic assessment cannot request frontier without justification", () => {
  assert.throws(() =>
    semanticTaskAssessmentSchema.parse({
      semanticDifficulty: "hard",
      repoReasoning: "high",
      localizationDifficulty: "high",
      verificationStrength: "weak",
      consequenceRisk: "high",
      expectedChangeSize: "multi-component",
      startingTier: "frontier",
      frontierJustified: false,
      confidence: 0.8,
      reason: "Contradictory frontier request.",
    }),
  );
});

test("canonical failing verification keeps a simple semantic task recoverable", () => {
  const fingerprint = {
    taskFamily: "localized_bugfix",
    primary: "debugging",
    secondary: ["testing"],
    languages: ["javascript"],
    frameworks: ["nodejs"],
    scope: "single",
    effort: "normal",
    executionStrategy: "stable",
    visualRelevant: false,
    browserRelevant: false,
    terminalHeavy: false,
    repoReasoningHeavy: true,
    architectureHeavy: false,
    toolsRequired: true,
    visionRequired: false,
    verificationStrength: "strong",
    focusedFailingReproduction: false,
    targetedExecutableVerification: true,
    broaderProjectVerification: true,
    crossComponent: false,
    publicApiRisk: false,
    schemaRisk: false,
    configRisk: false,
    concurrencyRisk: false,
    localizationConfidence: "medium",
    observedCheckFailures: 0,
    semanticComplexity: "medium",
    localizationUncertainty: "medium",
    blastRadius: "single-file",
    architecturalCoupling: "low",
    consequenceRisk: "low",
    verifierFalseAcceptRisk: "high",
    recoveryDetectability: "high",
    toolExplorationNeed: "high",
    executionEngineComplexity: "high",
    operationalRisk: "medium",
    difficulty: {
      technicalComplexity: "medium",
      visualComplexity: "low",
      architecturalComplexity: "low",
      interactionComplexity: "low",
      repoReasoningComplexity: "high",
      changeRisk: "low",
      contextUncertainty: "high",
    },
    confidence: "medium",
    reasons: [],
  } as any;

  const profile = {
    scopeConfidence: "medium",
    crossComponent: false,
    concurrencyRisk: false,
    publicApiRisk: false,
    schemaRisk: false,
    architectureRisk: false,
    securitySensitive: false,
    expectedBlastRadius: "single-file",
    verificationStrength: "strong",
    likelyTests: ["tests/cart.test.cjs"],
    semanticAssessment: {
      semanticDifficulty: "easy",
      repoReasoning: "low",
      localizationDifficulty: "medium",
      verificationStrength: "strong",
      consequenceRisk: "low",
      expectedChangeSize: "single-file",
      startingTier: "cheap",
      frontierJustified: false,
      confidence: 0.95,
      reason: "Bounded failing-test bugfix.",
    },
  } as any;

  const verification = {
    checks: [
      {
        command: "node --test tests/cart.test.cjs",
        outcome: "CHECK_FAIL",
      },
    ],
  } as any;

  const result = preserveCanonicalTaskEvidence(
    fingerprint,
    profile,
    verification,
  );

  assert.equal(result.startingModelTier, "cheap");
  assert.equal(result.frontierJustified, false);
  assert.equal(result.semanticComplexity, "low");
  assert.equal(result.verifierFalseAcceptRisk, "low");
  assert.equal(result.observedCheckFailures, 1);
});


test("Jev decision mapping keeps bounded bugfix cheap-first", () => {
  const assessment = assessmentFromDecisionPayload({
    answers: {
      semanticDifficulty: { type: "choice", choice: "easy", confidence: 0.97 },
      repoReasoning: { type: "choice", choice: "low", confidence: 0.94 },
      localizationDifficulty: { type: "choice", choice: "medium", confidence: 0.82 },
      verificationStrength: { type: "choice", choice: "strong", confidence: 0.98 },
      consequenceRisk: { type: "choice", choice: "low", confidence: 0.97 },
      expectedChangeSize: { type: "choice", choice: "single-file", confidence: 0.91 },
      startingTier: { type: "choice", choice: "cheap", confidence: 0.96 },
      frontierJustified: { type: "noul", noul: 0.02 },
    },
  } as any);

  assert.equal(assessment.startingTier, "cheap");
  assert.equal(assessment.frontierJustified, false);
  assert.equal(assessment.verificationStrength, "strong");
});

test("Jev cannot start frontier below the configured frontier threshold", () => {
  const assessment = assessmentFromDecisionPayload({
    answers: {
      semanticDifficulty: { type: "choice", choice: "hard", confidence: 0.8 },
      repoReasoning: { type: "choice", choice: "high", confidence: 0.8 },
      localizationDifficulty: { type: "choice", choice: "high", confidence: 0.8 },
      verificationStrength: { type: "choice", choice: "weak", confidence: 0.8 },
      consequenceRisk: { type: "choice", choice: "high", confidence: 0.8 },
      expectedChangeSize: { type: "choice", choice: "multi-component", confidence: 0.8 },
      startingTier: { type: "choice", choice: "frontier", confidence: 0.8 },
      frontierJustified: { type: "noul", noul: 0.74 },
    },
  } as any, 0.9);

  assert.equal(assessment.startingTier, "strong");
  assert.equal(assessment.frontierJustified, false);
});

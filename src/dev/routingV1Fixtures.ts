import { assessTask } from "../router/taskAssessment.js";
import { buildVerificationContract } from "../verifier/contract.js";
import { modelSchema, routingSchema } from "../router/pool.js";
import type {
  RoutingEvidence,
  RoutingFamily,
  RoutingV1Input,
} from "../router/routingV1.js";
import { extractFeatures } from "../router/features.js";
import { optimizeSpecialists } from "../router/routeOptimizer.js";
import type { TaskFingerprint } from "../router/taskFingerprint.js";
import type { Config } from "../config.js";
import type { SpecialistModel } from "../router/capabilityRegistry.js";
/** Scripted fixtures, never real-model calibration evidence. */
export const fingerprint: TaskFingerprint = {
  taskFamily: "localized_bugfix",
  primary: "debugging",
  secondary: [],
  languages: ["typescript"],
  frameworks: [],
  scope: "single",
  effort: "normal",
  executionStrategy: "direct",
  visualRelevant: false,
  browserRelevant: false,
  terminalHeavy: false,
  repoReasoningHeavy: false,
  architectureHeavy: false,
  toolsRequired: true,
  visionRequired: false,
  verificationStrength: "strong",
  targetedExecutableVerification: true,
  confidence: "high",
  reasons: [],
  difficulty: {
    technicalComplexity: "low",
    visualComplexity: "low",
    architecturalComplexity: "low",
    interactionComplexity: "low",
    repoReasoningComplexity: "low",
    changeRisk: "low",
    contextUncertainty: "low",
  },
};
export const features = extractFeatures(
  {
    id: "task",
    title: "Fix value",
    objective: "Fix value",
    likelyReadPaths: ["src/value.ts"],
    likelyWritePaths: ["src/value.ts"],
    dependsOn: [],
    integrationContract: "",
    verificationCommands: [],
    estimatedDifficulty: "normal",
    parallelSafe: true,
  },
  { files: ["src/value.ts"] } as any,
  2000,
  undefined,
  "direct",
);
export const configuration = {
  maxOutputTokens: 1000,
  maxIterations: 3,
  maxMinutes: 10,
  maxTokens: 100000,
  budgetUsd: 10,
  routing: routingSchema.parse({ costWeight: 0.6, latencyWeight: 0.4 }),
} as Config;
const model = (id: string, price = 1, latency = 1000): SpecialistModel => ({
  model: modelSchema.parse({
    id,
    tier: "strong",
    qualityPrior: 0.9,
    latencyPriorMs: latency,
  }),
  metadata: {
    available: true,
    inputPrice: price,
    outputPrice: price,
    contextLength: 100000,
    maxOutputTokens: 8000,
    supportedParameters: ["tools", "tool_choice"],
  },
  configured: true,
  vision: false,
  evidence: [],
});
export const observed = (
  id: string,
  family: RoutingFamily = "debugging",
  successes = 98,
  total = 100,
  source: RoutingEvidence["source"] = "controlled",
): RoutingEvidence[] =>
  Array.from({ length: total }, (_, i) => ({
    id: `${source}-${id}-${family}-${i}`,
    taskId: `training-${source}-${id}-${family}-${i}`,
    model: id,
    modelFamily: id.split("/")[0]!,
    taskFamily: family,
    complexity: "low",
    engine: "direct",
    source,
    outcome: i < successes ? "VERIFIED_SUCCESS" : "FAILED",
    attribution:
      i < successes
        ? undefined
        : {
            primaryCause: "MODEL_FAILURE",
            learningDisposition: "NEGATIVE_MODEL_EVIDENCE",
          },
    provenance: "independently checked fixture outcomes",
    success: i < successes,
    costUsd: 0.01,
    wallClockMs: 1000,
  }));
export function fixture(): RoutingV1Input {
  const assessment = assessTask({
    task: "Fix value",
    facts: {
      files: ["src/value.ts"],
      resolvedPaths: ["src/value.ts"],
      relatedTests: ["tests/value.test.ts"],
      components: ["core"],
      localizationConfidence: "high",
      checks: [],
    },
  });
  assessment.implementationComplexity = "low";
  assessment.scope = "local";
  assessment.localizationDifficulty = "easy";
  assessment.consequenceRisk = "low";
  assessment.confidence.overall = 0.95;
  for (const key of Object.keys(
    assessment.riskFlags,
  ) as (keyof typeof assessment.riskFlags)[])
    assessment.riskFlags[key] = false;
  const contract = buildVerificationContract({
    task: "Fix value",
    assessment,
    relatedTests: ["tests/value.test.ts"],
  });
  contract.overallStrength = "strong";
  contract.overallFalseAcceptRisk = "low";
  contract.requirements.forEach((r) => {
    r.strength = "strong";
    r.falseAcceptRisk = "low";
    r.proofAvailability = "available";
  });
  const models = [model("vendor/a", 1), model("vendor/b", 10)];
  const route = optimizeSpecialists(
    models,
    fingerprint,
    features,
    [],
    configuration,
    10,
  );
  return {
    assessment,
    contract,
    fingerprint: { ...fingerprint },
    models,
    route,
    evidence: [...observed("vendor/a"), ...observed("vendor/b")],
    budgetUsd: 10,
    inputTokens: 756,
    outputTokens: 1000,
    requiredParameters: ["tools", "tool_choice"],
    costWeight: 1,
    latencyWeight: 0,
  };
}

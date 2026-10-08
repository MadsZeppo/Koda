import { createHash } from "node:crypto";
import type { TaskAssessmentV1 } from "./taskAssessment.js";
import type { TaskFingerprint } from "./taskFingerprint.js";
import type { VerificationContractV1 } from "../verifier/contract.js";

/** Unknown facts remain unknown. Project check availability is not behavioral proof. */
export interface CanonicalRoutingTask {
  version: 1;
  family: string;
  textDigest?: string;
  text?: string;
  repo?: string;
  baseCommit?: string;
  paths?: string[];
  semantic?: { vector: number[]; encoder: string; provenance: string };
  assessment?: TaskAssessmentV1;
  contract?: VerificationContractV1;
  fingerprint?: TaskFingerprint;
  complexity?: string;
  localization?: string;
  scope?: string;
  expectedFiles?: number;
  languages: string[];
  frameworks: string[];
  repoScale?: string;
  contextTokens?: number;
  visual?: boolean;
  browser?: boolean;
  risks: Record<string, boolean | undefined>;
  crossComponent?: boolean;
  blastRadius?: string;
  proof: { strength: string; falseAcceptRisk: string; detectability?: string };
  engine: string;
  harness: string;
  missing: string[];
}
export function canonicalRoutingTask(input: {
  family?: string;
  text?: string;
  semantic?: CanonicalRoutingTask["semantic"];
  assessment?: TaskAssessmentV1;
  contract?: VerificationContractV1;
  fingerprint?: TaskFingerprint;
  engine?: string;
  harness: string;
}): CanonicalRoutingTask {
  const a = input.assessment,
    c = input.contract,
    f = input.fingerprint;
  if (
    input.semantic &&
    (!input.semantic.encoder ||
      !input.semantic.provenance ||
      !input.semantic.vector.length ||
      input.semantic.vector.length > 2048 ||
      !input.semantic.vector.every(Number.isFinite))
  )
    throw Error("Invalid semantic representation");
  return {
    version: 1,
    text: input.text,
    family: input.family ?? f?.taskFamily ?? f?.primary ?? "unknown",
    textDigest: input.text
      ? createHash("sha256").update(input.text).digest("hex")
      : undefined,
    semantic: input.semantic,
    assessment: a,
    contract: c,
    fingerprint: f,
    complexity: a?.implementationComplexity ?? f?.semanticComplexity,
    localization: a?.localizationDifficulty ?? f?.localizationUncertainty,
    scope: a?.scope ?? f?.scope,
    expectedFiles: f?.expectedFiles,
    languages: f?.languages ?? [],
    frameworks: f?.frameworks ?? [],
    repoScale: f?.repoComplexity,
    contextTokens: f?.contextRequirementTokens,
    visual: f?.visualRelevant,
    browser: f?.browserRelevant,
    risks: {
      ...a?.riskFlags,
      publicApi: a?.riskFlags.publicApi ?? f?.publicApiRisk,
      architecture: a?.riskFlags.architecture ?? f?.architectureHeavy,
      schema: a?.riskFlags.database ?? f?.schemaRisk,
      config: a?.riskFlags.config ?? f?.configRisk,
    },
    crossComponent: f?.crossComponent,
    blastRadius: f?.blastRadius,
    // Contract wins over the legacy fingerprint. Generic PASS cannot upgrade it.
    proof: {
      strength: c?.overallStrength ?? "unknown",
      falseAcceptRisk: c?.overallFalseAcceptRisk ?? "unknown",
      detectability: f?.recoveryDetectability,
    },
    engine: input.engine ?? f?.executionStrategy ?? "unknown",
    harness: input.harness,
    missing: [
      !input.semantic && "semantic",
      !a && "assessment",
      !c && "contract",
      !f && "repo_fingerprint",
    ].filter((v): v is string => typeof v === "string"),
  };
}

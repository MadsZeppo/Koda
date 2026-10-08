import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { canonicalEvidenceDirectory } from "./knowledge/canonical.js";
import { canonicalRoutingTask } from "./canonicalTask.js";
import {
  validateContextualArtifact,
  type ContextualQualityArtifact,
} from "./contextualQuality.js";
import {
  ContextualRouterVNext,
  type ContextualModelFacts,
} from "./contextualRouterVNext.js";
import type { SpecialistModel } from "./capabilityRegistry.js";
import type { TaskAssessmentV1 } from "./taskAssessment.js";
import type { VerificationContractV1 } from "../verifier/contract.js";
import type { TaskFingerprint } from "./taskFingerprint.js";
import { supportsParameters } from "./pool.js";
import { withColdStartEvidence } from "./knowledge/coldStart.js";
import { lexicalTask } from "./lexicalTask.js";

const routerCache = new WeakMap<
  ContextualQualityArtifact,
  ContextualRouterVNext
>();

let cached:
  | { path: string; mtime: number; artifact: ContextualQualityArtifact }
  | undefined;
/** Never changes dispatch, pays for discovery, or touches provider-specific quality namespaces. */
export function contextualShadowDecision(
  input: {
    text?: string;
    assessment: TaskAssessmentV1;
    contract: VerificationContractV1;
    fingerprint: TaskFingerprint;
    models: SpecialistModel[];
    inputTokens: number;
    outputTokens: number;
    budgetUsd: number;
  },
  directory = canonicalEvidenceDirectory(),
) {
  const path = join(directory, "contextual-quality-v1.json");
  let artifact: ContextualQualityArtifact;
  try {
    const mtime = statSync(path).mtimeMs;
    if (cached?.path === path && cached.mtime === mtime)
      artifact = cached.artifact;
    else {
      artifact = validateContextualArtifact(
        JSON.parse(readFileSync(path, "utf8")),
      );
      artifact = withColdStartEvidence(artifact);
      cached = { path, mtime, artifact };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      artifact = withColdStartEvidence();
    else throw error;
  }
  const task = canonicalRoutingTask({
    text: input.text,
    semantic: input.text ? lexicalTask(input.text) : undefined,
    assessment: input.assessment,
    contract: input.contract,
    fingerprint: input.fingerprint,
    harness: "koda",
  });
  const candidates = input.models.map(({ model, metadata, vision }) => {
    const compatible =
      model.enabled &&
      metadata.available !== false &&
      (!input.fingerprint.visionRequired || vision) &&
      supportsParameters(
        metadata,
        input.fingerprint.executionStrategy === "aider"
          ? []
          : ["tools", "tool_choice"],
      ) &&
      (metadata.contextLength ?? 0) >= input.inputTokens + input.outputTokens &&
      (metadata.maxOutputTokens ?? 0) >= input.outputTokens;
    const fact: ContextualModelFacts = {
      id: model.id,
      compatible,
      inputPrice: metadata.inputPrice,
      outputPrice: metadata.outputPrice,
    };
    return fact;
  });
  let router = routerCache.get(artifact);
  if (!router) {
    router = new ContextualRouterVNext(artifact);
    routerCache.set(artifact, router);
  }
  return {
    ...router.decide({
      task,
      models: candidates,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      budgetUsd: input.budgetUsd,
      allowedRegret: 0.02,
      maxFalseAccept: 0.01,
    }),
    mode: "shadow" as const,
    artifactDigest: artifact.digest,
    task: {
      family: task.family,
      engine: task.engine,
      harness: task.harness,
      scope: task.scope,
      complexity: task.complexity,
      textDigest: task.textDigest,
      textAvailable: !!task.text,
      semanticEncoder: task.semantic?.encoder,
      proof: task.proof,
      risks: task.risks,
    },
    limitations: [
      "No calibrated Koda verifier measurements; generic project checks receive no rescue credit",
      "No measured latency evidence supplied; configured latency priors are excluded",
    ],
  };
}

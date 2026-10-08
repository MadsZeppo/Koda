import type { CanonicalRoutingTask } from "./canonicalTask.js";
import {
  predictContextualQuality,
  validateContextualArtifact,
  type ContextualQualityArtifact,
} from "./contextualQuality.js";
import {
  selectContextualPlan,
  type MeasuredVerifier,
  type ConditionalRescue,
} from "./contextualPlans.js";
import { conditionalRecovery } from "./pairedEvidence.js";

/** Only raw facts enter VNext. No PoolModel, SpecialistEstimate, History or legacy quality config. */
export interface ContextualModelFacts {
  id: string;
  compatible: boolean;
  inputPrice?: number;
  outputPrice?: number;
  latencyMs?: number;
  p90Ms?: number;
}
export interface ContextualRouterInput {
  task: CanonicalRoutingTask;
  models: readonly ContextualModelFacts[];
  inputTokens: number;
  outputTokens: number;
  budgetUsd: number;
  allowedRegret: number;
  maxFalseAccept: number;
  maxRegretProbability?: number;
  verifier?: MeasuredVerifier;
  rescue?: ConditionalRescue[];
}
export class ContextualRouterVNext {
  private readonly artifact?: ContextualQualityArtifact;
  constructor(artifact?: ContextualQualityArtifact) {
    // Detach from callers: shadow cannot mutate production objects and callers cannot mutate quality truth.
    this.artifact = artifact
      ? validateContextualArtifact(structuredClone(artifact))
      : undefined;
  }
  predict(task: CanonicalRoutingTask, model: string) {
    return this.artifact
      ? predictContextualQuality(this.artifact, task, model)
      : undefined;
  }
  decide(input: ContextualRouterInput) {
    if (!this.artifact)
      return {
        router: "ContextualRouterVNext" as const,
        status: "ABSTAIN" as const,
        reason: "canonical_artifact_missing",
        abstention: true,
      };
    const candidates = input.models.map((fact) => ({
      model: fact.id,
      engine: input.task.engine,
      compatible: fact.compatible,
      quality: predictContextualQuality(this.artifact!, input.task, fact.id),
      costUsd:
        (input.inputTokens * (fact.inputPrice ?? Infinity) +
          input.outputTokens * (fact.outputPrice ?? Infinity)) /
        1e6,
      // Missing measured economics remains missing; configured priors are not imported.
      latencyMs: fact.latencyMs ?? Infinity,
      p90Ms: fact.p90Ms ?? Infinity,
    }));
    const rescue =
      input.rescue ??
      input.models
        .flatMap((a) =>
          input.models
            .filter((b) => b.id !== a.id)
            .map((b) =>
              conditionalRecovery(
                this.artifact!.paired ?? [],
                input.task,
                a.id,
                b.id,
              ),
            ),
        )
        .filter((r) => r.successes + r.failures > 0);
    const result = selectContextualPlan({
      task: structuredClone(input.task),
      candidates,
      budgetUsd: input.budgetUsd,
      allowedRegret: input.allowedRegret,
      maxFalseAccept: input.maxFalseAccept,
      maxRegretProbability: input.maxRegretProbability,
      verifier: input.verifier,
      rescue,
      paired: this.artifact.paired,
    });
    return {
      router: "ContextualRouterVNext" as const,
      status: result.abstention ? ("ABSTAIN" as const) : ("SELECTED" as const),
      ...result,
      artifactDigest: this.artifact.digest,
      candidates,
      reason: result.abstention
        ? result.plans.length
          ? "no_quality_and_false_accept_eligible_plan"
          : "no_supported_compatible_candidate"
        : "quality_constraints_passed_before_economics",
      rescue: rescue.map((r) => ({
        ...r,
        provenance:
          r.provenance.length > 512 ? r.provenance.slice(0, 512) : r.provenance,
      })),
    };
  }
}

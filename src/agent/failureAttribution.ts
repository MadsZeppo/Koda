import { verificationContractSchema } from "../verifier/contract.js";
import { z } from "zod";

export const failureCauses = [
  "MODEL_FAILURE",
  "SCOPE_FAILURE",
  "CONTEXT_FAILURE",
  "PROVIDER_FAILURE",
  "VERIFICATION_INFRA_FAILURE",
  "REPO_BASELINE_FAILURE",
  "KODA_INTERNAL_FAILURE",
  "UNKNOWN",
] as const;
export const failureStages = [
  "preflight",
  "routing",
  "context",
  "coding",
  "tool_execution",
  "verification",
  "completion_review",
  "integration",
] as const;
export const retryRecommendations = [
  "ESCALATE_MODEL",
  "RETRY_SAME_MODEL",
  "EXPAND_SCOPE",
  "REBUILD_CONTEXT",
  "RETRY_PROVIDER",
  "REPAIR_VERIFICATION",
  "FIX_REPO_ENVIRONMENT",
  "FIX_KODA",
  "STOP_UNKNOWN",
] as const;
export type FailureCauseV1 = (typeof failureCauses)[number];
export type FailureStageV1 = (typeof failureStages)[number];
const causeSchema = z.enum(failureCauses);
const baseEvent = {
  eventId: z.string().optional(),
  source: z.string().min(1),
  description: z.string().min(1),
  stage: z.enum(failureStages),
};
/** These observations are facts from their owning subsystem, never error-text guesses.
 * An opportunity audit must independently establish ALL required scope/context,
 * not merely the subset that localization happened to select. */
export const attributionEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...baseEvent,
    type: z.literal("provider_response"),
    successful: z.boolean(),
  }),
  z.object({
    ...baseEvent,
    type: z.literal("opportunity"),
    valid: z.boolean().optional(),
    scopeAvailable: z.boolean().optional(),
    contextAvailable: z.boolean().optional(),
  }),
  z.object({
    ...baseEvent,
    type: z.literal("candidate_proof"),
    valid: z.boolean(),
    candidateFailed: z.boolean(),
    baseline: z.enum(["regression", "same_failure", "unknown"]),
    strength: z.enum(["strong", "medium", "weak"]),
    proofKind: z.enum([
      "behavior",
      "compile",
      "test",
      "required_mutation",
      "output_protocol",
    ]),
    requirementId: z.string().optional(),
    checkId: z.string().optional(),
  }),
  z.object({
    ...baseEvent,
    type: z.literal("fault"),
    cause: causeSchema.exclude([
      "MODEL_FAILURE",
      "UNKNOWN",
      "SCOPE_FAILURE",
      "CONTEXT_FAILURE",
      "REPO_BASELINE_FAILURE",
    ]),
    established: z.boolean(),
    resolved: z.boolean().optional(),
  }),
  z.object({
    ...baseEvent,
    type: z.literal("scope_block"),
    required: z.boolean(),
    blockedByKoda: z.boolean(),
    path: z.string().min(1),
    userRestricted: z.boolean().optional(),
  }),
  z.object({
    ...baseEvent,
    type: z.literal("context_gap"),
    necessary: z.boolean(),
    withheldByKoda: z.boolean(),
    suppliedOrRetrievable: z.boolean(),
    fact: z.string().min(1),
  }),
  z.object({
    ...baseEvent,
    type: z.literal("unresolved"),
    missing: z.array(z.string()),
  }),
]);
export type AttributionEvent = z.infer<typeof attributionEventSchema>;
export const failureTraceSchema = z.object({
  attemptId: z.string().min(1),
  events: z.array(attributionEventSchema),
  verificationContract: verificationContractSchema.optional(),
});
export type FailureTrace = z.infer<typeof failureTraceSchema>;
export const failureAttributionSchema = z.object({
  version: z.literal(1),
  attemptId: z.string(),
  primaryCause: causeSchema,
  contributingCauses: z.array(causeSchema),
  stage: z.enum(failureStages),
  confidence: z.number().min(0).max(1),
  evidence: z.array(
    z.object({
      source: z.string(),
      eventId: z.string().optional(),
      description: z.string(),
    }),
  ),
  learningDisposition: z.enum(["NEGATIVE_MODEL_EVIDENCE", "CENSORED"]),
  retryRecommendation: z.enum(retryRecommendations),
  explanation: z.string(),
});
export type FailureAttributionV1 = z.infer<typeof failureAttributionSchema>;
const retries: Record<
  FailureCauseV1,
  FailureAttributionV1["retryRecommendation"]
> = {
  MODEL_FAILURE: "ESCALATE_MODEL",
  SCOPE_FAILURE: "EXPAND_SCOPE",
  CONTEXT_FAILURE: "REBUILD_CONTEXT",
  PROVIDER_FAILURE: "RETRY_PROVIDER",
  VERIFICATION_INFRA_FAILURE: "REPAIR_VERIFICATION",
  REPO_BASELINE_FAILURE: "FIX_REPO_ENVIRONMENT",
  KODA_INTERNAL_FAILURE: "FIX_KODA",
  UNKNOWN: "STOP_UNKNOWN",
};

export function resolveFailureAttribution(
  trace: FailureTrace,
): FailureAttributionV1 {
  const events = trace.events;
  const proven: {
    cause: FailureCauseV1;
    index: number;
    event: AttributionEvent;
  }[] = [];
  const missing = new Set<string>();
  for (const [index, event] of events.entries()) {
    if (event.type === "fault" && event.established && !event.resolved)
      proven.push({ cause: event.cause, index, event });
    if (
      event.type === "scope_block" &&
      event.required &&
      event.blockedByKoda &&
      !event.userRestricted
    )
      proven.push({ cause: "SCOPE_FAILURE", index, event });
    if (
      event.type === "context_gap" &&
      event.necessary &&
      event.withheldByKoda &&
      !event.suppliedOrRetrievable
    )
      proven.push({ cause: "CONTEXT_FAILURE", index, event });
    if (event.type === "unresolved")
      event.missing.forEach((m) => missing.add(m));
    if (event.type !== "candidate_proof" || !event.candidateFailed) continue;
    const proofKey = event.checkId ?? event.requirementId;
    if (
      proofKey &&
      events
        .slice(index + 1)
        .some(
          (e) =>
            e.type === "candidate_proof" &&
            (e.checkId ?? e.requirementId) === proofKey,
        )
    )
      continue;
    if (event.valid && event.baseline === "same_failure") {
      proven.push({ cause: "REPO_BASELINE_FAILURE", index, event });
      continue;
    }
    const prior = events.slice(0, index);
    const opportunity = prior.filter((e) => e.type === "opportunity");
    const audit = (key: "valid" | "scopeAvailable" | "contextAvailable") =>
      opportunity.some((e) => e.type === "opportunity" && e[key] === true) &&
      !opportunity.some((e) => e.type === "opportunity" && e[key] === false);
    const prerequisites = {
      successfulProviderResponse: prior.some(
        (e) => e.type === "provider_response" && e.successful,
      ),
      validOpportunity: audit("valid"),
      requiredScopeAvailable: audit("scopeAvailable"),
      necessaryContextAvailable: audit("contextAvailable"),
      validVerification: event.valid,
      baselineComparison: event.baseline === "regression",
      independentCandidateProof:
        event.strength === "strong" &&
        (!trace.verificationContract ||
          !event.requirementId ||
          trace.verificationContract.requirements.some(
            (r) =>
              r.requirementId === event.requirementId &&
              r.strength === "strong",
          )),
    };
    Object.entries(prerequisites)
      .filter(([, value]) => !value)
      .forEach(([key]) => missing.add(key));
    // A prior unresolved obstacle invalidates this opportunity. A later unrelated
    // serialization/provider failure cannot erase an independently completed proof.
    if (
      Object.values(prerequisites).every(Boolean) &&
      !proven.some(
        (p) => p.index < index && p.cause !== "REPO_BASELINE_FAILURE",
      )
    )
      proven.push({ cause: "MODEL_FAILURE", index, event });
  }
  if (
    proven.some(
      (p) => p.cause === "SCOPE_FAILURE" || p.cause === "CONTEXT_FAILURE",
    )
  ) {
    for (let i = proven.length - 1; i >= 0; i--)
      if (proven[i]!.cause === "MODEL_FAILURE") proven.splice(i, 1);
  }
  const primary = proven.find((p) => p.cause === "MODEL_FAILURE") ?? proven[0];
  const cause = primary?.cause ?? "UNKNOWN";
  if (!primary && !missing.size) missing.add("independent causal evidence");
  const contributingCauses = [
    ...new Set(proven.filter((p) => p !== primary).map((p) => p.cause)),
  ].filter((c) => c !== cause);
  return {
    version: 1,
    attemptId: trace.attemptId,
    primaryCause: cause,
    contributingCauses,
    stage: primary?.event.stage ?? events.at(-1)?.stage ?? "coding",
    confidence: primary ? 1 : 0,
    evidence: events.map(({ source, eventId, description }) => ({
      source,
      ...(eventId ? { eventId } : {}),
      description,
    })),
    learningDisposition:
      cause === "MODEL_FAILURE" ? "NEGATIVE_MODEL_EVIDENCE" : "CENSORED",
    retryRecommendation: retries[cause],
    explanation: primary
      ? `Established ${cause} at event ${primary.index}; subsequent independently established causes are contributors. Recommendations are shadow-only.`
      : `Causality unresolved. Missing or contradictory evidence: ${[...missing].join(", ")}. No model blame inferred.`,
  };
}

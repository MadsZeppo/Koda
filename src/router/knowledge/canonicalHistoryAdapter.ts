import type { Attempt } from "../history.js";
import {
  trainingEligible,
  type CanonicalQualityObservation,
} from "./canonical.js";
import type { CanonicalRoutingTask } from "../canonicalTask.js";

/** Sole normalization boundary for legacy outcomes. Never imports its posterior/ranking. */
export function adaptHistoricalQualityOutcome(
  row: Attempt,
  evidence: {
    task: CanonicalRoutingTask;
    provenance: string;
    exactRevision: string;
    proof?: CanonicalQualityObservation["proof"];
    attribution?: CanonicalQualityObservation["attribution"];
    synthetic?: boolean;
  },
): CanonicalQualityObservation | undefined {
  if (
    evidence.synthetic ||
    !evidence.exactRevision ||
    row.modelServed === null ||
    ((row.verificationVector ?? []).some((v) =>
      [
        "CHECK_FAIL",
        "INFRA_FAILURE",
        "CHECK_UNAVAILABLE",
        "CANDIDATE_NEUTRAL",
        "CANDIDATE_IMPROVEMENT",
      ].includes(v),
    ) &&
      row.verification === "VERIFIED_SUCCESS")
  )
    return;
  const observation: CanonicalQualityObservation = {
    id: `${row.runId}:${row.subtaskId}:${row.timestamp}:${row.modelServed}`,
    taskId: `${row.runId}:${row.subtaskId}`,
    task: structuredClone(evidence.task),
    model: row.modelServed,
    revision: evidence.exactRevision,
    identity: "EXACT",
    source: "koda-history",
    split: "local",
    origin: "local",
    provenance: evidence.provenance,
    timestamp: row.timestamp,
    success: row.verification === "VERIFIED_SUCCESS",
    outcome: row.verification,
    proof: evidence.proof,
    attribution: evidence.attribution,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costUsd: row.costUsd ?? undefined,
    latencyMs: row.wallClockMs,
    propensity: row.selectionPropensity,
    trainingAllowed: true,
  };
  return trainingEligible(observation) ? observation : undefined;
}

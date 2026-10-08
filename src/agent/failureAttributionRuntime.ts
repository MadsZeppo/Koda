import { performance } from "node:perf_hooks";
import {
  resolveFailureAttribution,
  type AttributionEvent,
  type FailureAttributionV1,
  type FailureTrace,
  type FailureStageV1,
} from "./failureAttribution.js";
import {
  verificationAgainstBaseline,
  verificationRegressions,
} from "../verifier/verifier.js";
import type { VerificationResult } from "../types.js";

interface RuntimeEvent {
  type: string;
  subtaskId?: string;
  [key: string]: any;
}
const stageOf = (stage?: string): FailureStageV1 =>
  stage === "completion-review"
    ? "completion_review"
    : stage === "planner" || stage === "plan"
      ? "routing"
      : stage === "repository-exploration"
        ? "context"
        : "coding";
/** Compact, authoritative baseline/candidate observations, without duplicating stdout. */
export function verificationEvidence(
  baseline: VerificationResult,
  candidate: VerificationResult,
  changedPaths?: readonly string[],
): AttributionEvent[] {
  const events: AttributionEvent[] = [];
  const base = {
    source: "authoritative_verification",
    description: "Comparable check results",
    stage: "verification" as const,
  };
  const relative = verificationAgainstBaseline(
    baseline,
    candidate,
    changedPaths,
  );
  const regressions = new Set(
    verificationRegressions(baseline, candidate, changedPaths),
  );
  for (const check of candidate.checks) {
    if (check.requirement === "advisory") continue;
    const previous = baseline.checks.find(
      (c) => c.command === check.command && c.cwd === check.cwd,
    );
    const identity = `${check.cwd ?? "."}:${check.command}`;
    if (
      check.outcome === "INFRA_FAILURE" ||
      check.outcome === "CHECK_UNAVAILABLE"
    ) {
      const known = relative.checks
        .find((c) => c.command === check.command && c.cwd === check.cwd)
        ?.source?.endsWith(":baseline_environment_unchanged");
      if (known)
        events.push({
          ...base,
          description: identity,
          stage: "verification",
          type: "candidate_proof",
          valid: true,
          candidateFailed: true,
          baseline: "same_failure",
          strength: "strong",
          proofKind: "test",
          checkId: identity,
        });
      else
        events.push({
          ...base,
          stage: "verification",
          type: "fault",
          cause: "VERIFICATION_INFRA_FAILURE",
          established: true,
        });
    } else if (
      check.outcome === "CHECK_FAIL" ||
      check.outcome === "CHECK_PASS"
    ) {
      const unchanged = relative.checks
        .find((c) => c.command === check.command && c.cwd === check.cwd)
        ?.source?.endsWith(":baseline_unchanged");
      events.push({
        ...base,
        description: identity,
        stage: "verification",
        type: "candidate_proof",
        valid: !check.unavailable,
        candidateFailed: check.outcome === "CHECK_FAIL",
        baseline: unchanged
          ? "same_failure"
          : previous && regressions.has(check)
            ? "regression"
            : "unknown",
        strength: "strong",
        checkId: identity,
        proofKind:
          check.kind === "typecheck" || check.kind === "build"
            ? "compile"
            : "test",
      });
    }
  }
  return events;
}

/** Existing typed outcome classifiers feed this adapter. Human-readable error
 * messages are evidence descriptions only, never causal predicates. */
export function normalizeAttemptEvidence(
  attemptId: string,
  raw: readonly RuntimeEvent[],
): FailureTrace {
  const events: AttributionEvent[] = [];
  for (const [index, event] of raw.entries()) {
    const base = {
      source: event.type,
      eventId: event.attributionEventId ?? `${attemptId}:${index}`,
      description:
        event.reason ?? event.error ?? event.termination_reason ?? event.type,
      stage: stageOf(event.stage),
    };
    const fault = (
      cause:
        | "PROVIDER_FAILURE"
        | "VERIFICATION_INFRA_FAILURE"
        | "KODA_INTERNAL_FAILURE",
      stage = base.stage,
    ) =>
      events.push({ ...base, stage, type: "fault", cause, established: true });
    if (event.type === "failure_evidence") {
      const observation = event.observation as AttributionEvent;
      events.push({ ...observation, eventId: base.eventId });
    } else if (
      event.type === "model_call" &&
      event.outcome !== "error" &&
      event.modelReturned
    ) {
      if (event.stage === "implement")
        events.push({ ...base, type: "provider_response", successful: true });
    } else if (
      event.type === "model_error" &&
      event.failureOrigin === "provider"
    )
      events.push({
        ...base,
        type: "fault",
        cause: "PROVIDER_FAILURE",
        established: true,
        resolved: raw
          .slice(index + 1)
          .some(
            (later) =>
              later.type === "model_call" &&
              later.outcome !== "error" &&
              later.modelReturned &&
              later.stage === event.stage &&
              later.modelRequested === event.modelRequested,
          ),
      });
    else if (event.type === "completion_review_failure")
      fault("VERIFICATION_INFRA_FAILURE", "completion_review");
    else if (event.type === "verification_infrastructure_failure")
      fault("VERIFICATION_INFRA_FAILURE", "verification");
    else if (
      event.type === "verification" &&
      (event.outcome === "INFRA_FAILURE" ||
        event.outcome === "CHECK_UNAVAILABLE")
    ) {
      // The aggregate observation records the final authoritative result after
      // retries. A transient callback must not survive a later passing retry.
      if (!raw.some((e) => e.type === "attempt_verification_evidence"))
        events.push({
          ...base,
          stage: "verification",
          type: "unresolved",
          missing: ["latest authoritative verification result"],
        });
    } else if (
      event.type === "coding_worker_stop" &&
      (event.limit_kind || event.exit_status === "infra_failure")
    ) {
      // An overall worker/attempt deadline is not necessarily a provider timeout.
      // Only the provider-dispatch observation can establish that origin.
      events.push({
        ...base,
        type: "unresolved",
        missing: ["typed origin of worker termination"],
      });
    } else if (event.type === "write_scope_violation") {
      events.push({
        ...base,
        stage: "tool_execution",
        type: "unresolved",
        missing: [
          "whether blocked path was necessary and not explicitly user-restricted",
        ],
      });
    } else if (event.type === "attempt_verification_evidence") {
      const observations: AttributionEvent[] =
        event.observations ??
        verificationEvidence(
          event.baseline,
          event.candidate,
          event.changedPaths,
        );
      for (const observation of observations)
        events.push({ ...observation, eventId: base.eventId });
    }
  }
  const verificationContract = raw.findLast(
    (e) => e.type === "verification_contract",
  )?.contract;
  return {
    attemptId,
    events,
    ...(verificationContract ? { verificationContract } : {}),
  };
}

/** Per-worker invocation, including completion/verification until the next
 * invocation for that subtask. Parallel subtasks remain distinct. This consumes
 * no learned history and writes no routing records. */
export function collectFailureAttributions(
  raw: readonly RuntimeEvent[],
  runId: string,
) {
  const collectionStarted = performance.now();
  const active = new Map<
    string,
    { id: string; events: RuntimeEvent[]; failed: boolean }
  >();
  const completed: typeof active extends Map<string, infer V> ? V[] : never =
    [];
  const standalone: FailureTrace[] = [];
  let sequence = 0;
  for (const [eventIndex, originalEvent] of raw.entries()) {
    const event: RuntimeEvent = {
      ...originalEvent,
      attributionEventId: `${runId}:event:${eventIndex}`,
    };
    const key = event.subtaskId ?? "run";
    if (event.type === "coding_worker_start") {
      const previous = active.get(key);
      if (previous) completed.push(previous);
      active.set(key, {
        id: `${runId}/${key}/${++sequence}`,
        events: [],
        failed: false,
      });
    }
    const attempt = active.get(key);
    if (attempt) {
      attempt.events.push(event);
      if (
        (event.type === "model_attempt" &&
          ["FAILED", "NOT_FULLY_VERIFIED", "OPERATIONAL_FAILURE"].includes(
            event.verification,
          )) ||
        event.type === "attempt_failed" ||
        event.type === "completion_review_failure" ||
        event.type === "completion_continuation" ||
        event.type === "verification_repair" ||
        (event.type === "aider_attempt_verification" &&
          ["FAILED", "NOT_FULLY_VERIFIED"].includes(event.outcome)) ||
        event.type === "verification_infrastructure_failure" ||
        (event.type === "failure_evidence" &&
          event.observation?.type === "fault" &&
          event.observation.established &&
          !event.observation.resolved) ||
        (event.type === "coding_worker_stop" &&
          event.exit_status !== "completed")
      )
        attempt.failed = true;
    } else if (
      event.type === "model_error" ||
      event.type === "coding_attempt_non_viable" ||
      event.type === "verification_infrastructure_failure" ||
      event.type === "failure_evidence" ||
      event.type === "attempt_failed" ||
      (event.type === "run_error" &&
        !standalone.length &&
        ![...active.values()].some((attempt) => attempt.failed))
    ) {
      standalone.push(
        normalizeAttemptEvidence(`${runId}/${key}/${++sequence}`, [event]),
      );
    }
  }
  completed.push(...active.values());
  const verificationContract = raw.findLast(
    (e) => e.type === "verification_contract",
  )?.contract;
  const traces = [
    ...standalone,
    ...completed
      .filter((a) => a.failed)
      .map((a) => normalizeAttemptEvidence(a.id, a.events)),
  ];
  if (verificationContract)
    for (const trace of traces)
      trace.verificationContract = verificationContract;
  const overheadMs: number[] = [];
  const attributions: FailureAttributionV1[] = traces.map((trace) => {
    const start = performance.now();
    const result = resolveFailureAttribution(trace);
    overheadMs.push(performance.now() - start);
    return result;
  });
  return {
    version: 1 as const,
    mode: "shadow" as const,
    attributions,
    traces,
    overheadMs,
    collectionOverheadMs: performance.now() - collectionStarted,
  };
}

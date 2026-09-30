import type { Logger } from "./logger.js";
import type { Status, VerificationResult } from "../types.js";

export function summarize(
  logger: Logger,
  status: Status,
  wallClockMs: number,
  verification: VerificationResult,
  changedFiles: string[],
  scheduledParallelPeak = 0,
) {
  const allScopeEvents = logger.events.filter(
    (event) => event.type === "worker_scope",
  );

  const workerScopeEvents = allScopeEvents.filter(
    (event) =>
      event.read_only !== true ||
      !allScopeEvents.some(
        (candidate) =>
          candidate.subtaskId === event.subtaskId &&
          candidate.read_only !== true,
      ),
  );

  /*
   * There are two different concurrency measurements:
   *
   * 1. scheduledParallelPeak
   *    The DAG scheduler's authoritative task-level parallelism.
   *
   * 2. observedCodingWorkerPeak
   *    The narrower interval during which coding workers themselves overlap.
   *
   * A scheduled pair may legitimately execute concurrently while their short
   * coding phases do not overlap because setup/context/worktree work finishes
   * at slightly different times.
   *
   * Therefore:
   *
   * - parallelPeak describes execution-plan/DAG parallelism.
   * - maxConcurrentCodingWorkers describes actual coding-worker overlap.
   *
   * Do not derive task-level parallelism solely from coding_worker_start/stop
   * telemetry; doing so makes the result timing-dependent.
   */
  const activeCodingWorkers = new Set<string>();

  let observedCodingWorkerPeak = 0;

  for (const event of logger.events) {
    const key = `${event.subtaskId}:${event.worktree}`;

    if (event.type === "coding_worker_start") {
      activeCodingWorkers.add(key);

      observedCodingWorkerPeak = Math.max(
        observedCodingWorkerPeak,
        activeCodingWorkers.size,
      );
    } else if (event.type === "coding_worker_stop") {
      activeCodingWorkers.delete(key);
    }
  }

  const parallelPeak = Math.max(
    scheduledParallelPeak,
    observedCodingWorkerPeak,
  );

  const calls = logger.events.filter((e) => e.type === "model_call");

  const routingProfile = logger.events.findLast(
    (event) => event.type === "task_profile",
  );

  const elapsed = (start: any, end: any) =>
    start && end
      ? Math.max(0, Date.parse(end.timestamp) - Date.parse(start.timestamp))
      : 0;

  const first = (type: string) =>
    logger.events.find((event) => event.type === type);

  const sumMs = (type: string) =>
    logger.events
      .filter((event) => event.type === type)
      .reduce((total, event) => total + (event.wallClockMs ?? 0), 0);

  const profilingMs = elapsed(first("profiling"), first("profile"));

  const planningMs = first("planner_summary")?.planner_latency_ms ?? 0;

  const discoveryMs = calls
    .filter((call) => ["discover", "inspect"].includes(call.stage))
    .reduce((total, call) => total + call.wallClockMs, 0);

  const scopeResolutionMs = logger.events
    .filter((event) => event.type === "stable_scope_locked")
    .reduce((total, event) => {
      const start = logger.events.find(
        (candidate) =>
          candidate.type === "task_start" &&
          candidate.subtaskId === event.subtaskId,
      );

      return total + elapsed(start, event);
    }, 0);

  const integrationMs = logger.events
    .filter((event) => event.type === "integrated")
    .reduce((total, event) => {
      const start = logger.events.findLast(
        (candidate) =>
          candidate.type === "integration_start" &&
          candidate.subtaskId === event.subtaskId,
      );

      return total + elapsed(start, event);
    }, 0);

  const frontierRescueSubtasks = new Set<string>();

  const pendingQualityFallbacks = new Set<string>();

  let frontierCalls = 0;

  for (const event of logger.events) {
    if (
      event.type === "escalation" &&
      event.to === "FRONTIER_MODEL" &&
      event.from !== "FRONTIER_MODEL"
    ) {
      frontierRescueSubtasks.add(event.subtaskId);
    }

    if (
      event.type === "coding_route_escalation" &&
      event.to_role === "FRONTIER_MODEL"
    ) {
      frontierRescueSubtasks.add(event.subtaskId);
    }

    if (event.type === "coding_quality_escalation" && event.to === "frontier") {
      frontierRescueSubtasks.add(event.subtaskId);
    }

    if (
      event.type === "model_fallback" &&
      event.verifiedQualityFailure === true
    ) {
      pendingQualityFallbacks.add(event.subtaskId);
    }

    if (event.type === "model_call") {
      if (
        event.role === "FRONTIER_MODEL" &&
        pendingQualityFallbacks.has(event.subtaskId)
      ) {
        frontierRescueSubtasks.add(event.subtaskId);
      }

      if (event.role !== "FRONTIER_MODEL") {
        pendingQualityFallbacks.delete(event.subtaskId);
      }

      if (
        event.role === "FRONTIER_MODEL" &&
        frontierRescueSubtasks.has(event.subtaskId)
      ) {
        frontierCalls++;
      }
    }
  }

  const models: Record<
    string,
    {
      costUsd: number;
      tokens: number;
      wallClockMs: number;
      calls: number;
    }
  > = {};

  for (const c of calls) {
    const m = (models[c.modelReturned] ??= {
      costUsd: 0,
      tokens: 0,
      wallClockMs: 0,
      calls: 0,
    });

    m.costUsd += c.costUsd ?? 0;

    m.tokens += c.promptTokens + c.completionTokens;

    m.wallClockMs += c.wallClockMs;

    m.calls++;
  }

  return {
    ecosystem:
      logger.events.find((e) => e.type === "repo_profile")?.ecosystem ?? null,

    verificationPlans: logger.events.filter(
      (e) =>
        e.type === "verification_plan" || e.type === "verification_selection",
    ),

    verificationDimensions: verification.dimensions,

    runId: logger.runId,

    status,

    wallClockMs,

    latencyBreakdown: {
      profiling_ms: profilingMs,

      planning_ms: planningMs,

      discovery_ms: discoveryMs,

      scope_resolution_ms: scopeResolutionMs,

      model_wait_ms: calls.reduce((total, call) => total + call.wallClockMs, 0),

      tool_ms: sumMs("tool_result"),

      verification_ms: sumMs("verification"),

      integration_ms: integrationMs,

      final_verification_ms: sumMs("final_verification"),

      wall_clock_ms: wallClockMs,
    },

    costUsd: calls.reduce((n, c) => n + (c.costUsd ?? 0), 0),

    costComplete: !calls.some((c) => c.costUsd === null),

    totalTokens: calls.reduce(
      (n, c) => n + c.promptTokens + c.completionTokens,
      0,
    ),

    cachedTokens: calls.reduce((n, c) => n + c.cachedTokens, 0),

    cacheWriteTokens: calls.reduce((n, c) => n + c.cacheWriteTokens, 0),

    models,

    /*
     * Overall execution-plan parallelism.
     *
     * This preserves scheduler truth while still covering cases where coding
     * worker overlap is greater than the supplied scheduler value.
     */
    parallelPeak,

    /*
     * Narrower metric: actual overlap of coding_worker_start/stop windows.
     */
    maxConcurrentCodingWorkers: observedCodingWorkerPeak,

    coderExecutions: logger.events.filter(
      (e) => e.type === "coding_worker_start",
    ).length,

    planning:
      logger.events.findLast((e) => e.type === "planner_summary") ?? null,

    plannerRoutes: logger.events.filter((e) => e.type === "planner_route"),

    routingDecisions: logger.events.filter((e) => e.type === "model_router"),

    modelAttempts: logger.events.filter((e) => e.type === "model_attempt"),

    executionPolicies: logger.events
      .filter((e) => e.type === "specialist_route")
      .map((event) => ({
        subtaskId: event.subtaskId,

        planId: event.selected_plan_id,

        executionEngine: event.execution_engine,

        qualityClass: event.quality_class,

        requiredQuality: event.required_quality,

        selectedModel: event.selected_model,

        evidenceClass: event.model_evidence_class,

        conservativeQuality: event.conservative_quality,

        estimatedCostPerVerifiedSolve: event.estimated_cost_per_verified_solve,

        riskAdjustedCostPerVerifiedSolve:
          event.risk_adjusted_cost_per_verified_solve,

        expectedCompletionCostP90Usd:
          event.expected_completion_cost_p90_usd,

        expectedCompletionCostP99Usd:
          event.expected_completion_cost_p99_usd,

        expectedCompletionLatencyP99Ms:
          event.expected_completion_latency_p99_ms,

        deadlineMissProbability: event.deadline_miss_probability,

        approvedRecoveryCandidates: event.approved_recovery_candidates,

        whySelected: event.why_selected,
      })),

    adaptiveRecoveries: logger.events.filter(
      (e) => e.type === "adaptive_recovery_decision",
    ),

    fallbacks: logger.events.filter(
      (e) =>
        e.type === "model_fallback" ||
        e.type === "coding_route_fallback" ||
        (e.type === "aider_fallback" && e.moved === true),
    ).length,

    plannerModels: [
      ...new Set(
        calls.filter((c) => c.stage === "plan").map((c) => c.modelRequested),
      ),
    ],

    modelCalls: calls.map((c) => ({
      subtaskId: c.subtaskId,

      modelRequested: c.modelRequested,

      modelServed: c.modelReturned,

      inputTokens: c.promptTokens,

      outputTokens: c.completionTokens,

      costUsd: c.costUsd,

      wallClockMs: c.wallClockMs,

      provider: c.provider ?? null,

      ttftMs: c.ttftMs ?? null,

      generationDurationMs: c.generationDurationMs ?? null,

      tokensPerSecond: c.tokensPerSecond ?? null,

      cachedTokens: c.cachedTokens ?? 0,

      cacheWriteTokens: c.cacheWriteTokens ?? 0,

      providerPolicy: c.providerPolicy ?? null,

      outcome: c.outcome,
    })),

    totalModelCalls: calls.length,

    routingResearchCalls: routingProfile?.routing_research_calls ?? 0,

    routingResearchCostUsd: routingProfile?.routing_research_cost_usd ?? 0,

    routingResearchTokens: routingProfile?.routing_research_tokens ?? 0,

    microScoutUsed: routingProfile?.micro_scout_used ?? false,

    deterministicProfileConfidence:
      routingProfile?.profile?.scopeConfidence ?? null,

    toolCalls: logger.events.filter((e) => e.type === "tool").length,

    verificationCalls: logger.events.filter(
      (e) => e.type === "verification" || e.type === "final_verification",
    ).length,

    contextBytes: logger.events
      .filter((e) => e.type === "worker_context")
      .reduce((sum, event) => sum + (event.context_bytes ?? 0), 0),

    contextBytesInitial: logger.events
      .filter((event) => event.type === "coding_worker_start")
      .reduce((sum, event) => sum + (event.context_bytes_initial ?? 0), 0),

    contextBytesRepeated: logger.events
      .filter((event) => event.type === "coding_worker_start")
      .reduce((sum, event) => sum + (event.context_bytes_repeated ?? 0), 0),

    plannerModelCalls: calls.filter((c) => c.stage === "plan").length,

    coderModelCalls: calls.filter((c) => c.stage === "implement").length,

    modelCallsPerRole: Object.fromEntries(
      [...new Set(calls.map((c) => c.role ?? "unknown"))].map((role) => [
        role,

        calls.filter((c) => (c.role ?? "unknown") === role).length,
      ]),
    ),

    workerScopes: workerScopeEvents.map((e) => ({
      subtaskId: e.subtaskId,

      allowed_write_paths: e.allowed_write_paths,

      context_files: e.context_files,

      attempted_write_paths: [
        ...new Set(
          logger.events
            .filter(
              (a) => a.type === "write_attempt" && a.subtaskId === e.subtaskId,
            )
            .map((a) => a.path),
        ),
      ],

      successful_write_paths: [
        ...new Set(
          logger.events
            .filter(
              (a) => a.type === "write_success" && a.subtaskId === e.subtaskId,
            )
            .map((a) => a.path),
        ),
      ],

      write_scope_violations: logger.events
        .filter(
          (a) =>
            a.type === "write_scope_violation" && a.subtaskId === e.subtaskId,
        )
        .map((a) => ({
          paths: a.attempted_write_paths,

          source: a.source,
        })),
    })),

    workerContexts: logger.events
      .filter((e) => e.type === "worker_context")
      .map((e) => ({
        subtaskId: e.subtaskId,

        context_files: e.context_files,

        context_bytes: e.context_bytes,

        context_limit_bytes: e.context_limit_bytes,
      })),

    finalVerificationStatus: verification.status,

    escalations: logger.events.filter(
      (e) =>
        e.type === "escalation" ||
        (e.type === "model_fallback" && e.verifiedQualityFailure === true),
    ).length,

    frontierCalls,

    mergeConflicts: logger.events.filter((e) => e.type === "merge_conflict")
      .length,

    verification,

    changedFiles,
  };
}

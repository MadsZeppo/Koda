import type { Logger } from "./logger.js";
import type { Status, VerificationResult } from "../types.js";
export function summarize(
  logger: Logger,
  status: Status,
  wallClockMs: number,
  verification: VerificationResult,
  changedFiles: string[],
  _legacyParallelPeak?: number,
) {
  const active = new Set<string>();
  let observedPeak = 0;
  for (const event of logger.events) {
    const key = `${event.subtaskId}:${event.worktree}`;
    if (event.type === "coding_worker_start") {
      active.add(key);
      observedPeak = Math.max(observedPeak, active.size);
    } else if (event.type === "coding_worker_stop") active.delete(key);
  }
  const calls = logger.events.filter((e) => e.type === "model_call");
  const models: Record<
    string,
    { costUsd: number; tokens: number; wallClockMs: number; calls: number }
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
    costUsd: calls.reduce((n, c) => n + (c.costUsd ?? 0), 0),
    costComplete: !calls.some((c) => c.costUsd === null),
    totalTokens: calls.reduce(
      (n, c) => n + c.promptTokens + c.completionTokens,
      0,
    ),
    cachedTokens: calls.reduce((n, c) => n + c.cachedTokens, 0),
    cacheWriteTokens: calls.reduce((n, c) => n + c.cacheWriteTokens, 0),
    models,
    parallelPeak: observedPeak,
    maxConcurrentCodingWorkers: observedPeak,
    coderExecutions: logger.events.filter(
      (e) => e.type === "coding_worker_start",
    ).length,
    planning:
      logger.events.findLast((e) => e.type === "planner_summary") ?? null,
    plannerRoutes: logger.events.filter((e) => e.type === "planner_route"),
    routingDecisions: logger.events.filter((e) => e.type === "model_router"),
    modelAttempts: logger.events.filter((e) => e.type === "model_attempt"),
    fallbacks: logger.events.filter((e) => e.type === "model_fallback" || e.type === "coding_route_fallback").length,
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
      outcome: c.outcome,
    })),
    totalModelCalls: calls.length,
    toolCalls: logger.events.filter((e) => e.type === "tool").length,
    verificationCalls: logger.events.filter(
      (e) => e.type === "verification" || e.type === "final_verification",
    ).length,
    contextBytes: logger.events
      .filter((e) => e.type === "worker_context")
      .reduce((sum, event) => sum + (event.context_bytes ?? 0), 0),
    plannerModelCalls: calls.filter((c) => c.stage === "plan").length,
    coderModelCalls: calls.filter((c) => c.stage === "implement").length,
    modelCallsPerRole: Object.fromEntries(
      [...new Set(calls.map((c) => c.role ?? "unknown"))].map((role) => [
        role,
        calls.filter((c) => (c.role ?? "unknown") === role).length,
      ]),
    ),
    workerScopes: logger.events
      .filter((e) => e.type === "worker_scope")
      .map((e) => ({
        subtaskId: e.subtaskId,
        allowed_write_paths: e.allowed_write_paths,
        context_files: e.context_files,
        attempted_write_paths: [
          ...new Set(
            logger.events
              .filter(
                (a) =>
                  a.type === "write_attempt" && a.subtaskId === e.subtaskId,
              )
              .map((a) => a.path),
          ),
        ],
        successful_write_paths: [
          ...new Set(
            logger.events
              .filter(
                (a) =>
                  a.type === "write_success" && a.subtaskId === e.subtaskId,
              )
              .map((a) => a.path),
          ),
        ],
        write_scope_violations: logger.events
          .filter(
            (a) =>
              a.type === "write_scope_violation" && a.subtaskId === e.subtaskId,
          )
          .map((a) => ({ paths: a.attempted_write_paths, source: a.source })),
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
    escalations: logger.events.filter((e) => e.type === "escalation").length,
    frontierCalls: calls.filter((c) => c.role === "FRONTIER_MODEL").length,
    mergeConflicts: logger.events.filter((e) => e.type === "merge_conflict")
      .length,
    verification,
    changedFiles,
  };
}

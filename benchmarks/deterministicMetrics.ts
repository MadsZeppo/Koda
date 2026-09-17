import type { run } from "../src/run.js";

/** Metrics from real runtime events; fixture model usage is synthetic. */
export function emitFixtureMetrics(
  name: string,
  result: Awaited<ReturnType<typeof run>>,
  events: Record<string, any>[],
) {
  if (process.env.KODA_DETERMINISTIC_BENCH !== "1") return;
  const focused = events.find(
    (event) => event.type === "stable_context_focused",
  );
  console.log(
    "KODA_BENCH " +
      JSON.stringify({
        name,
        strategy: result.execution_strategy,
        status: result.status,
        wallClockMs: result.wallClockMs,
        plannerCalls: result.plannerModelCalls,
        modelCalls: result.totalModelCalls,
        tokens: result.totalTokens,
        costUsd: result.costUsd,
        toolCalls: events.filter((event) => event.type === "tool").length,
        verificationCalls: events.filter(
          (event) =>
            event.type === "verification" ||
            event.type === "final_verification" ||
            event.type === "stable_repair_verification",
        ).length,
        fallbacks: result.fallbacks,
        parallelPeak: result.parallelPeak,
        contextBytesBefore: focused?.before_bytes,
        contextBytesAfter: focused?.after_bytes,
      }),
  );
}

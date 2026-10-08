import type { CanonicalQualityObservation } from "./knowledge/canonical.js";
import { trainingEligible } from "./knowledge/canonical.js";
import type { CanonicalRoutingTask } from "./canonicalTask.js";
export interface PairedTaskOutcome {
  family: string;
  engine: string;
  harness: string;
  source: string;
  taskId: string;
  outcomes: Record<string, number>;
  provenance: string[];
}
export function pairedTaskEvidence(
  rows: CanonicalQualityObservation[],
): PairedTaskOutcome[] {
  const groups = new Map<string, CanonicalQualityObservation[]>();
  for (const r of rows.filter(trainingEligible)) {
    if (!r.revision || !["EXACT", "SOURCE_EXACT"].includes(r.identity))
      continue;
    const key = JSON.stringify([
      r.population ?? r.source,
      r.taskId,
      r.task.engine,
      r.task.harness,
      r.task.baseCommit,
    ]);
    const group = groups.get(key) ?? [];
    group.push(r);
    groups.set(key, group);
  }
  return [...groups.values()].flatMap((group) => {
    const ids = group.map((r) => r.model);
    if (new Set(ids).size !== ids.length) return [];
    const r = group[0]!;
    return [
      {
        family: r.task.family,
        engine: r.task.engine,
        harness: r.task.harness,
        source: r.source,
        taskId: r.taskId,
        outcomes: Object.fromEntries(
          group.map((r) => [
            r.model,
            Number(r.score !== undefined ? r.score === 1 : r.success === true),
          ]),
        ),
        provenance: [...new Set(group.map((r) => r.provenance))],
      },
    ];
  });
}
export function conditionalRecovery(
  rows: PairedTaskOutcome[],
  task: CanonicalRoutingTask,
  initial: string,
  rescue: string,
) {
  if (initial === rescue) throw Error("Same-model retry is a separate process");
  const paired = rows.filter(
    (r) =>
      r.family === task.family &&
      r.engine === task.engine &&
      r.harness === task.harness &&
      r.outcomes[initial] === 0 &&
      r.outcomes[rescue] !== undefined,
  );
  return {
    initial,
    rescue,
    engine: task.engine,
    taskFamily: task.family,
    successes: paired.filter((r) => r.outcomes[rescue] === 1).length,
    failures: paired.filter((r) => r.outcomes[rescue] === 0).length,
    provenance: [...new Set(paired.flatMap((r) => r.provenance))].join("|"),
  };
}
export function sameModelRetry(
  rows: Array<{
    taskId: string;
    model: string;
    revision: string;
    harness: string;
    run: number;
    success: boolean;
  }>,
) {
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = JSON.stringify([r.taskId, r.model, r.revision, r.harness]);
    const g = groups.get(key) ?? [];
    g.push(r);
    groups.set(key, g);
  }
  let successes = 0,
    failures = 0;
  for (const g of groups.values()) {
    g.sort((a, b) => a.run - b.run);
    if (new Set(g.map((r) => r.run)).size !== g.length)
      throw Error("Duplicate repeated run");
    for (let i = 1; i < g.length; i++)
      if (!g[i - 1]!.success) {
        if (g[i]!.success) successes++;
        else failures++;
      }
  }
  return { kind: "same-model-retry" as const, successes, failures };
}
/** Bayesian bootstrap on matched task outcomes; no independent marginal or Gaussian approximation. */
export function pairedRegret(input: {
  rows: PairedTaskOutcome[];
  task: CanonicalRoutingTask;
  candidate: string[];
  reference: string[];
  detection: number;
  allowedRegret: number;
  draws?: number;
}) {
  if (JSON.stringify(input.candidate) === JSON.stringify(input.reference))
    return {
      probability: 0,
      mean: 0,
      support: Infinity,
      method: "identical-plan" as const,
    };
  const ids = [...new Set([...input.candidate, ...input.reference])];
  const rows = input.rows.filter(
    (r) =>
      r.family === input.task.family &&
      r.engine === input.task.engine &&
      r.harness === input.task.harness &&
      ids.every((id) => r.outcomes[id] !== undefined),
  );
  if (rows.length < 30)
    return {
      probability: 1,
      mean: null,
      support: rows.length,
      method: "unsupported" as const,
    };
  const value = (r: PairedTaskOutcome, plan: string[]) =>
    r.outcomes[plan[0]!]! +
    (plan.length === 2
      ? (1 - r.outcomes[plan[0]!]!) * input.detection * r.outcomes[plan[1]!]!
      : 0);
  const differences = rows.map(
    (r) => value(r, input.reference) - value(r, input.candidate),
  );
  let state = 123456789;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) + 1) / 4294967297;
  };
  let exceeds = 0;
  const draws = input.draws ?? 2048;
  // Add symmetric support at +/-1 to avoid certainty from zero discordances in a finite sample.
  const values = [...differences, -1, 1];
  for (let i = 0; i < draws; i++) {
    let sum = 0,
      weights = 0;
    for (const d of values) {
      const w = -Math.log(random());
      sum += w * d;
      weights += w;
    }
    if (sum / weights > input.allowedRegret) exceeds++;
  }
  return {
    probability: exceeds / draws,
    mean: differences.reduce((a, b) => a + b, 0) / rows.length,
    support: rows.length,
    method: "paired-bayesian-bootstrap" as const,
  };
}

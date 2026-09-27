/**
 * Deterministic, offline routing-policy evaluation.
 *
 * The harness consumes already verified task/model trajectories. It never
 * calls a provider and does not treat a benchmark aggregate as task evidence.
 */
export interface EvaluationOutcome {
  modelId: string;
  compatible: boolean;
  verifiedSuccess: boolean;
  quality: number;
  costUsd: number;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  predictedTokens?: number;
  predictedCostUsd?: number;
  predictedLatencyMs?: number;
  predictedSuccess?: number;
  providerFailure?: boolean;
  newModel?: boolean;
}

export interface RoutingEvaluationCase {
  id: string;
  outcomes: EvaluationOutcome[];
  /** Frozen plans selected by the production policies being compared. */
  currentPlan: string[];
  evidenceFirstPlan: string[];
  staticPlan?: string[];
  taskRegion?: string;
  paraphraseGroup?: string;
}

export type RoutingEvaluationPolicy =
  | "strongest-executable"
  | "cheapest-compatible"
  | "static-tier"
  | "cheap-first-cascade"
  | "current-koda"
  | "evidence-first";

export interface RoutingEvaluationMetrics {
  policy: RoutingEvaluationPolicy;
  tasks: number;
  verifiedSuccesses: number;
  verifiedSuccessRate: number;
  totalCostUsd: number;
  costPerVerifiedSuccess: number | null;
  latencyPerVerifiedSuccessMs: number | null;
  costP50Usd: number;
  costP90Usd: number;
  costP99Usd: number;
  latencyP50Ms: number;
  latencyP90Ms: number;
  qualityRegret: number;
  unnecessaryFrontierUsage: number;
  unsafeCheapSelections: number;
  recoveryRate: number;
  recoveryCostUsd: number;
  providerFailures: number;
  tokenPredictionError: number | null;
  costPredictionErrorUsd: number | null;
  latencyPredictionErrorMs: number | null;
  calibrationBrier: number | null;
  calibrationByTaskRegion: Record<string, { samples: number; brier: number }>;
  paraphraseRouteAgreement: number | null;
  newModelSelections: number;
  distinctModels: number;
}

const quantile = (values: number[], q: number) => {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor((ordered.length - 1) * q)]!;
};

const executable = (item: RoutingEvaluationCase) =>
  item.outcomes.filter((outcome) => outcome.compatible);

const strongest = (item: RoutingEvaluationCase) => [...executable(item)].sort((a, b) =>
  b.quality - a.quality || a.costUsd - b.costUsd || a.modelId.localeCompare(b.modelId))[0];

const cheapest = (item: RoutingEvaluationCase) => [...executable(item)].sort((a, b) =>
  a.costUsd - b.costUsd || a.latencyMs - b.latencyMs || a.modelId.localeCompare(b.modelId))[0];

const planFor = (policy: RoutingEvaluationPolicy, item: RoutingEvaluationCase) => {
  const reference = strongest(item);
  const low = cheapest(item);
  switch (policy) {
    case "strongest-executable": return reference ? [reference.modelId] : [];
    case "cheapest-compatible": return low ? [low.modelId] : [];
    case "static-tier": return item.staticPlan ?? (reference ? [reference.modelId] : []);
    case "cheap-first-cascade": return [low?.modelId, reference?.modelId]
      .filter((id, index, ids): id is string => !!id && ids.indexOf(id) === index);
    case "current-koda": return item.currentPlan;
    case "evidence-first": return item.evidenceFirstPlan;
  }
};

const POLICIES: RoutingEvaluationPolicy[] = [
  "strongest-executable", "cheapest-compatible", "static-tier",
  "cheap-first-cascade", "current-koda", "evidence-first",
];

export function evaluateRoutingPolicies(cases: RoutingEvaluationCase[]): RoutingEvaluationMetrics[] {
  return POLICIES.map((policy) => {
    const runs = cases.map((item) => {
      const available = new Map(executable(item).map((row) => [row.modelId, row]));
      const plan = planFor(policy, item).map((id) => available.get(id)).filter(
        (row): row is EvaluationOutcome => !!row);
      const attempted: EvaluationOutcome[] = [];
      for (const outcome of plan) {
        attempted.push(outcome);
        // Provider failures remain operational and permit the frozen fallback.
        if (outcome.verifiedSuccess) break;
      }
      const accepted = attempted.find((outcome) => outcome.verifiedSuccess);
      const reference = strongest(item);
      const selected = attempted[0];
      return {
        attempted, accepted, selected, reference,
        cost: attempted.reduce((sum, row) => sum + row.costUsd, 0),
        latency: attempted.reduce((sum, row) => sum + row.latencyMs, 0),
      };
    });
    const successes = runs.filter((run) => !!run.accepted).length;
    const costs = runs.map((run) => run.cost);
    const latencies = runs.map((run) => run.latency);
    const totalCost = costs.reduce((sum, value) => sum + value, 0);
    const successfulLatency = runs.filter((run) => !!run.accepted)
      .reduce((sum, run) => sum + run.latency, 0);
    const predictionErrors = runs.flatMap((run) => run.attempted.flatMap((row) =>
      row.predictedTokens === undefined ? [] : [
        (row.inputTokens ?? 0) + (row.outputTokens ?? 0) - row.predictedTokens,
      ]));
    const brier = runs.flatMap((run) => run.attempted.flatMap((row) =>
      row.predictedSuccess === undefined || row.providerFailure ? [] : [
        (row.predictedSuccess - Number(row.verifiedSuccess)) ** 2,
      ]));
    const costErrors = runs.flatMap((run) => run.attempted.flatMap((row) =>
      row.predictedCostUsd === undefined ? [] : [row.costUsd - row.predictedCostUsd]));
    const latencyErrors = runs.flatMap((run) => run.attempted.flatMap((row) =>
      row.predictedLatencyMs === undefined ? [] : [row.latencyMs - row.predictedLatencyMs]));
    const regionRows = new Map<string, number[]>();
    runs.forEach((run, index) => {
      const region = cases[index]!.taskRegion ?? "unknown";
      const values = run.attempted.flatMap((row) =>
        row.predictedSuccess === undefined || row.providerFailure ? [] :
          [(row.predictedSuccess - Number(row.verifiedSuccess)) ** 2]);
      regionRows.set(region, [...(regionRows.get(region) ?? []), ...values]);
    });
    const groups = new Map<string, string[]>();
    runs.forEach((run, index) => {
      const group = cases[index]!.paraphraseGroup;
      if (group && run.selected) groups.set(group,
        [...(groups.get(group) ?? []), run.selected.modelId]);
    });
    const comparableGroups = [...groups.values()].filter((ids) => ids.length > 1);
    return {
      policy, tasks: cases.length, verifiedSuccesses: successes,
      verifiedSuccessRate: cases.length ? successes / cases.length : 0,
      totalCostUsd: totalCost,
      costPerVerifiedSuccess: successes ? totalCost / successes : null,
      latencyPerVerifiedSuccessMs: successes ? successfulLatency / successes : null,
      costP50Usd: quantile(costs, .5), costP90Usd: quantile(costs, .9),
      costP99Usd: quantile(costs, .99), latencyP50Ms: quantile(latencies, .5),
      latencyP90Ms: quantile(latencies, .9),
      qualityRegret: runs.reduce((sum, run) => sum + Math.max(0,
        (run.reference?.quality ?? 0) - (run.accepted?.quality ?? 0)), 0) /
        Math.max(1, cases.length),
      unnecessaryFrontierUsage: runs.filter((run) => run.selected === run.reference &&
        executable(cases[runs.indexOf(run)]!).some((row) => row !== run.reference &&
          row.verifiedSuccess && row.quality >= (run.reference?.quality ?? 0) - .02)).length,
      unsafeCheapSelections: runs.filter((run) => run.selected && !run.selected.verifiedSuccess &&
        !run.selected.providerFailure).length,
      recoveryRate: cases.length ? runs.filter((run) => run.attempted.length > 1).length /
        cases.length : 0,
      recoveryCostUsd: runs.reduce((sum, run) => sum + run.attempted.slice(1)
        .reduce((subtotal, row) => subtotal + row.costUsd, 0), 0),
      providerFailures: runs.reduce((sum, run) => sum + run.attempted
        .filter((row) => row.providerFailure).length, 0),
      tokenPredictionError: predictionErrors.length
        ? predictionErrors.reduce((sum, value) => sum + value, 0) / predictionErrors.length : null,
      costPredictionErrorUsd: costErrors.length
        ? costErrors.reduce((sum, value) => sum + value, 0) / costErrors.length : null,
      latencyPredictionErrorMs: latencyErrors.length
        ? latencyErrors.reduce((sum, value) => sum + value, 0) / latencyErrors.length : null,
      calibrationBrier: brier.length ? brier.reduce((sum, value) => sum + value, 0) / brier.length : null,
      calibrationByTaskRegion: Object.fromEntries([...regionRows].map(([region, values]) =>
        [region, { samples: values.length,
          brier: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0 }])),
      paraphraseRouteAgreement: comparableGroups.length
        ? comparableGroups.filter((ids) => new Set(ids).size === 1).length /
          comparableGroups.length : null,
      newModelSelections: runs.filter((run) => run.selected?.newModel).length,
      distinctModels: new Set(runs.flatMap((run) => run.attempted.map((row) => row.modelId))).size,
    };
  });
}

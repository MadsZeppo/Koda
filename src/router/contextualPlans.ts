import type { CanonicalRoutingTask } from "./canonicalTask.js";
import type { QualityPrediction } from "./contextualQuality.js";
import { pairedRegret, type PairedTaskOutcome } from "./pairedEvidence.js";

export interface ContextualPlanCandidate {
  model: string;
  engine: string;
  compatible: boolean;
  quality: QualityPrediction;
  costUsd: number;
  latencyMs: number;
  p90Ms: number;
}
export interface MeasuredVerifier {
  detectionLower: number;
  detectionMean?: number;
  detectionUpper?: number;
  support?: number;
  falseAcceptUpper: number;
  provenance: string;
  costUsd: number;
  latencyMs: number;
}
export interface ConditionalRescue {
  initial: string;
  rescue: string;
  engine: string;
  taskFamily: string;
  successes: number;
  failures: number;
  provenance: string;
}
export interface ContextualPlan {
  models: string[];
  engine: string;
  firstSuccess: number;
  rescueRequired: number;
  finalLower: number;
  finalMean: number;
  regretProbability?: number;
  regretSupport?: number;
  regretMethod?: string;
  finalUpper: number;
  falseAcceptUpper: number;
  costUsd: number;
  latencyMs: number;
  p90Ms: number;
  provenance: string[];
  eligible: boolean;
  reasons: string[];
}
/** Pure shadow optimization. Verification properties must be measured, never guessed from lint/build. */
export function selectContextualPlan(input: {
  task: CanonicalRoutingTask;
  candidates: ContextualPlanCandidate[];
  verifier?: MeasuredVerifier;
  rescue?: ConditionalRescue[];
  budgetUsd: number;
  allowedRegret: number;
  maxFalseAccept: number;
  latencyWeight?: number;
  explorationRate?: number;
  random?: number;
  paired?: PairedTaskOutcome[];
  maxRegretProbability?: number;
}) {
  const started = performance.now();
  const usable = input.candidates.filter(
    (c) =>
      c.compatible &&
      c.quality.calibratedDomain &&
      c.quality.support > 0 &&
      Number.isFinite(c.costUsd) &&
      c.costUsd >= 0 &&
      [c.latencyMs, c.p90Ms].every((n) => !Number.isNaN(n) && n >= 0) &&
      (!(input.latencyWeight && input.latencyWeight > 0) ||
        [c.latencyMs, c.p90Ms].every(Number.isFinite)),
  );
  const v = input.verifier;
  if (
    v &&
    (![v.detectionLower, v.falseAcceptUpper].every(
      (p) => Number.isFinite(p) && p >= 0 && p <= 1,
    ) ||
      !v.provenance)
  )
    throw Error("Invalid verifier evidence");
  const plans: ContextualPlan[] = [];
  for (const a of usable) {
    const q = a.quality;
    const falseAccept = v ? (1 - q.lower) * v.falseAcceptUpper : 1 - q.lower;
    plans.push({
      models: [a.model],
      engine: a.engine,
      firstSuccess: q.mean,
      rescueRequired: 0,
      finalLower: q.lower,
      finalMean: q.mean,
      finalUpper: q.upper,
      falseAcceptUpper: falseAccept,
      costUsd: a.costUsd + (v?.costUsd ?? 0),
      latencyMs: a.latencyMs + (v?.latencyMs ?? 0),
      p90Ms: a.p90Ms + (v?.latencyMs ?? 0),
      provenance: q.provenance,
      eligible: false,
      reasons: [],
    });
    if (!v) continue;
    for (const b of usable.filter(
      (b) => b.model !== a.model && b.engine === a.engine,
    )) {
      const paired = input.rescue?.find(
        (r) =>
          r.initial === a.model &&
          r.rescue === b.model &&
          r.engine === a.engine &&
          r.taskFamily === input.task.family,
      );
      // No observed conditional success => no independence-based rescue uplift.
      if (
        !paired ||
        !paired.provenance ||
        !Number.isInteger(paired.successes) ||
        !Number.isInteger(paired.failures) ||
        paired.successes < 0 ||
        paired.failures < 0 ||
        paired.successes + paired.failures === 0
      )
        continue;
      const n = paired.successes + paired.failures,
        p = paired.successes / n;
      // Distribution-free lower/upper bound on paired Bernoulli recovery evidence.
      const radius = Math.sqrt(Math.log(40) / (2 * n));
      const lower = Math.max(0, p - radius),
        upper = Math.min(1, p + radius);
      const rescueRequired =
        (1 - q.mean) * (v.detectionMean ?? v.detectionUpper ?? 1);
      plans.push({
        models: [a.model, b.model],
        engine: a.engine,
        firstSuccess: q.mean,
        rescueRequired,
        finalLower: q.lower + (1 - q.lower) * v.detectionLower * lower,
        finalMean: q.mean + (1 - q.mean) * v.detectionLower * p,
        finalUpper: Math.min(1, q.upper + (1 - q.upper) * upper),
        falseAcceptUpper:
          falseAccept + (1 - q.lower) * (1 - lower) * v.falseAcceptUpper,
        costUsd:
          a.costUsd + v.costUsd + rescueRequired * (b.costUsd + v.costUsd),
        latencyMs:
          a.latencyMs +
          v.latencyMs +
          rescueRequired * (b.latencyMs + v.latencyMs),
        p90Ms: a.p90Ms + b.p90Ms + 2 * v.latencyMs,
        provenance: [...q.provenance, paired.provenance, v.provenance],
        eligible: false,
        reasons: [],
      });
    }
  }
  const reference = plans.reduce<ContextualPlan | undefined>(
    (best, p) => (!best || p.finalMean > best.finalMean ? p : best),
    undefined,
  );
  const unsafe =
    input.task.proof.falseAcceptRisk !== "low" ||
    Object.values(input.task.risks).some(Boolean);
  const regret = unsafe
    ? Math.min(input.allowedRegret, 0.005)
    : input.allowedRegret;
  for (const p of plans) {
    if (reference) {
      const direct = pairedRegret({
        rows: input.paired ?? [],
        task: input.task,
        candidate: p.models,
        reference: reference.models,
        detection: v?.detectionLower ?? 0,
        allowedRegret: regret,
      });
      // An interval can certify safety when paired support is absent, but is never the sole comparison.
      p.regretProbability =
        direct.method === "unsupported" &&
        p.finalLower >= reference.finalUpper - regret
          ? 0
          : direct.probability;
      p.regretSupport = direct.support;
      p.regretMethod = direct.method;
      if (p.regretProbability > (input.maxRegretProbability ?? 0.05))
        p.reasons.push("quality_regret_risk");
    }
    if (p.falseAcceptUpper > input.maxFalseAccept)
      p.reasons.push("false_accept");
    const maximumCost = p.models.reduce(
      (sum, id) =>
        sum +
        (usable.find((c) => c.model === id && c.engine === p.engine)?.costUsd ??
          Infinity) +
        (v?.costUsd ?? 0),
      0,
    );
    if (maximumCost > input.budgetUsd) p.reasons.push("budget");
    p.eligible = p.reasons.length === 0;
  }
  const eligible = plans
    .filter((p) => p.eligible)
    .sort(
      (a, b) =>
        a.costUsd +
        (input.latencyWeight ? input.latencyWeight * a.latencyMs : 0) -
        (b.costUsd +
          (input.latencyWeight ? input.latencyWeight * b.latencyMs : 0)),
    );
  const explorationAllowed =
    !unsafe &&
    input.task.proof.strength === "strong" &&
    !!v &&
    v.detectionLower >= 1 - input.maxFalseAccept;
  const epsilon =
    explorationAllowed && input.random !== undefined
      ? Math.max(0, Math.min(0.1, input.explorationRate ?? 0))
      : 0;
  let selected = eligible[0];
  if (eligible.length > 1 && (input.random ?? 1) < epsilon)
    selected =
      eligible[Math.floor(((input.random ?? 0) / epsilon) * eligible.length)];
  const propensity = selected
    ? (selected === eligible[0] ? 1 - epsilon : 0) + epsilon / eligible.length
    : 0;
  return {
    mode: "shadow" as const,
    selected,
    reference,
    plans,
    propensity,
    abstention: !selected,
    elapsedMs: performance.now() - started,
  };
}

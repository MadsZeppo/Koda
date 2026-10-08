import { createHash } from "node:crypto";
import type { CanonicalRoutingTask } from "./canonicalTask.js";
import {
  trainingEligible,
  type CanonicalQualityObservation,
} from "./knowledge/canonical.js";
import {
  normalizeRoutingTaskFamily,
  modelFamilyKey,
} from "./knowledge/identity.js";
import { taskEvidenceRole } from "./knowledge/evidenceRegistry.js";
import {
  pairedTaskEvidence,
  type PairedTaskOutcome,
} from "./pairedEvidence.js";

export type EstimatorKind = "empirical" | "logistic" | "tree";
interface QualityTree {
  mean: number;
  feature?: string;
  left?: QualityTree;
  right?: QualityTree;
}
export interface QualityPrediction {
  mean: number;
  lower: number;
  upper: number;
  support: number;
  level:
    | "task_model_engine"
    | "model_global"
    | "harness_transfer"
    | "version_transfer"
    | "family_transfer"
    | "ignorance";
  identity:
    | "SOURCE_EXACT"
    | "EXACT"
    | "VERSION_TRANSFER"
    | "FAMILY_TRANSFER"
    | "UNKNOWN";
  provenance: string[];
  calibratedDomain: boolean;
  /** Source-domain support is not proof of calibrated Koda transfer. */
  evidence?: {
    rawSupport: number;
    nativeSupport: number;
    publicSupport: number;
    nearestTaskCount: number;
    sourceLower: number;
    sourceUpper: number;
    provenanceClass:
      | "native_koda"
      | "public_exact_model"
      | "public_cross_harness"
      | "version_transfer"
      | "family_transfer"
      | "global_prior";
  };
}
export interface ContextualQualityArtifact {
  version: 1;
  digest: string;
  trainingDigest: string;
  frozenAt: string;
  target: "complete_benchmark_solve";
  estimator: EstimatorKind;
  vocabulary: string[];
  weights: number[];
  temperature: number;
  calibrationError: number;
  semanticExamples?: Array<{
    model: string;
    engine: string;
    harness: string;
    encoder: string;
    vector: number[];
    success: number;
    local?: boolean;
    family?: string;
    sources?: string[];
    taskId?: string;
  }>;
  paired?: PairedTaskOutcome[];
  trees?: Record<string, QualityTree>;
  versionTransfers?: Array<{ from: string; to: string; provenance: string }>;
  cells: {
    model: string;
    family: string;
    engine: string;
    harness: string;
    count: number;
    solved: number;
    local: number;
    sources: string[];
    costSum?: number;
    costSamples?: number;
    latencySum?: number;
    latencySamples?: number;
  }[];
  training: {
    observations: number;
    tasks: number;
    models: number;
    missingSemantic: number;
  };
}
export function validateContextualArtifact(
  a: ContextualQualityArtifact,
): ContextualQualityArtifact {
  if (
    a.version !== 1 ||
    a.target !== "complete_benchmark_solve" ||
    !["empirical", "logistic", "tree"].includes(a.estimator) ||
    !Array.isArray(a.cells) ||
    !Array.isArray(a.weights) ||
    !a.weights.every(Number.isFinite) ||
    a.vocabulary.length !== a.weights.length ||
    !Number.isFinite(a.temperature) ||
    a.temperature <= 0 ||
    !Number.isFinite(a.calibrationError) ||
    a.calibrationError < 0 ||
    a.cells.some(
      (c) =>
        !Number.isInteger(c.count) ||
        c.count <= 0 ||
        !Number.isInteger(c.solved) ||
        c.solved < 0 ||
        c.solved > c.count,
    )
  )
    throw Error("Invalid contextual quality artifact");
  const digest = createHash("sha256")
    .update(JSON.stringify({ ...a, digest: "" }))
    .digest("hex");
  if (a.digest !== digest) throw Error("Contextual artifact digest mismatch");
  return a;
}
export const completeSolve = (r: CanonicalQualityObservation) =>
  r.score !== undefined ? Number(r.score === 1) : Number(r.success === true);
export const taskPartition = (
  taskId: string,
): "fit" | "calibration" | "development" => {
  const role = taskEvidenceRole(taskId);
  return role === "TRAIN"
    ? "fit"
    : role === "CALIBRATION"
      ? "calibration"
      : "development";
};
const logit = (p: number) =>
  Math.log(Math.max(1e-6, p) / Math.max(1e-6, 1 - p));
const sigmoid = (z: number) =>
  1 / (1 + Math.exp(-Math.max(-35, Math.min(35, z))));
export function wilson(solved: number, count: number) {
  if (!count) return { mean: 0.5, lower: 0, upper: 1 };
  const p = solved / count,
    z = 1.96,
    d = 1 + (z * z) / count;
  const center = (p + (z * z) / (2 * count)) / d;
  const half =
    (z * Math.sqrt((p * (1 - p)) / count + (z * z) / (4 * count * count))) / d;
  return {
    mean: (solved + 1) / (count + 2),
    lower: Math.max(0, center - half),
    upper: Math.min(1, center + half),
  };
}
/** Structured semantic facts and compatible externally supplied embeddings; IDs are never task features. */
function featureKeys(
  task: CanonicalRoutingTask,
  model: string,
): Array<[string, number]> {
  const facts = [
    task.family,
    `engine:${task.engine}`,
    `harness:${task.harness}`,
    `complexity:${task.complexity ?? "unknown"}`,
    `scope:${task.scope ?? "unknown"}`,
    ...task.languages.map((l) => `language:${l}`),
    ...task.frameworks.map((f) => `framework:${f}`),
    ...Object.entries(task.risks)
      .filter(([, v]) => v)
      .map(([r]) => `risk:${r}`),
  ];
  return [
    ["bias", 1],
    [`model:${model}`, 1],
    ...facts.flatMap(
      (f) =>
        [
          [`fact:${f}`, 1],
          [`interaction:${model}:${f}`, 1],
        ] as Array<[string, number]>,
    ),
    ...(task.semantic?.vector.map(
      (v, i) =>
        [`embedding:${task.semantic!.encoder}:${i}`, v] as [string, number],
    ) ?? []),
  ];
}
const vocabularyCache = new WeakMap<object, Map<string, number>>();
function weightedLogit(
  a: Pick<ContextualQualityArtifact, "vocabulary" | "weights">,
  task: CanonicalRoutingTask,
  model: string,
  index?: Map<string, number>,
) {
  const map =
    index ??
    vocabularyCache.get(a) ??
    new Map(a.vocabulary.map((key, i) => [key, i]));
  vocabularyCache.set(a, map);
  return featureKeys(task, model).reduce(
    (s, [key, value]) => s + (a.weights[map.get(key) ?? -1] ?? 0) * value,
    0,
  );
}
export function fitContextualQuality(
  rows: CanonicalQualityObservation[],
  estimator: EstimatorKind,
  frozenAt = new Date().toISOString(),
): ContextualQualityArtifact {
  const eligible = rows.filter(trainingEligible);
  if (
    !eligible.length ||
    eligible.some((r) => !["probing", "development", "local"].includes(r.split))
  )
    throw Error("No admissible training observations");
  const fit = eligible.filter((r) => taskPartition(r.taskId) === "fit");
  const calibration = eligible.filter(
    (r) => taskPartition(r.taskId) === "calibration",
  );
  if (!fit.length || !calibration.length)
    throw Error("Need disjoint fit and calibration tasks");
  const vocabulary = [
    ...new Set(
      fit.flatMap((r) => featureKeys(r.task, r.model).map(([k]) => k)),
    ),
  ].sort();
  const index = new Map(vocabulary.map((key, i) => [key, i]));
  const weights = vocabulary.map(() => 0);
  const examples = fit.map((r) => ({
    y: completeSolve(r),
    x: featureKeys(r.task, r.model).flatMap(([key, value]) => {
      const i = index.get(key);
      return i === undefined ? [] : [[i, value] as [number, number]];
    }),
  }));
  if (estimator === "logistic") {
    // Deterministic full-batch regularized logistic regression. Hyperparameters are fixed before DEV.
    for (let epoch = 0; epoch < 160; epoch++) {
      const gradient = weights.map(() => 0);
      for (const ex of examples) {
        const residual =
          sigmoid(ex.x.reduce((s, [i, v]) => s + weights[i]! * v, 0)) - ex.y;
        for (const [i, v] of ex.x) gradient[i]! += residual * v;
      }
      for (let i = 0; i < weights.length; i++)
        weights[i]! -=
          0.7 * (gradient[i]! / examples.length + 0.0005 * weights[i]!);
    }
  }
  const cells = new Map<string, ContextualQualityArtifact["cells"][number]>();
  for (const r of fit) {
    const key = JSON.stringify([
      r.model,
      r.task.family,
      r.task.engine,
      r.task.harness,
      r.origin,
    ]);
    const c = cells.get(key) ?? {
      model: r.model,
      family: r.task.family,
      engine: r.task.engine,
      harness: r.task.harness,
      count: 0,
      solved: 0,
      local: 0,
      sources: [],
    };
    c.count++;
    c.solved += completeSolve(r);
    c.local += Number(r.origin === "local");
    if (r.costUsd !== undefined) {
      c.costSum = (c.costSum ?? 0) + r.costUsd;
      c.costSamples = (c.costSamples ?? 0) + 1;
    }
    if (r.latencyMs !== undefined) {
      c.latencySum = (c.latencySum ?? 0) + r.latencyMs;
      c.latencySamples = (c.latencySamples ?? 0) + 1;
    }
    if (!c.sources.includes(r.provenance)) c.sources.push(r.provenance);
    cells.set(key, c);
  }
  const a: ContextualQualityArtifact = {
    version: 1,
    digest: "",
    trainingDigest: createHash("sha256")
      .update(JSON.stringify(eligible))
      .digest("hex"),
    frozenAt,
    target: "complete_benchmark_solve",
    estimator,
    vocabulary,
    weights,
    temperature: 1,
    calibrationError: 0,
    semanticExamples: fit
      .filter((r) => r.task.text && r.task.semantic)
      .map((r) => ({
        model: r.model,
        engine: r.task.engine,
        harness: r.task.harness,
        encoder: r.task.semantic!.encoder,
        vector: r.task.semantic!.vector,
        success: completeSolve(r),
        local: r.origin === "local",
        family: r.task.family,
        sources: [r.provenance],
        taskId: r.taskId,
      })),
    paired: pairedTaskEvidence(fit),
    trees:
      estimator === "tree"
        ? Object.fromEntries(
            [...new Set(fit.map((r) => r.model))].map((model) => [
              model,
              buildTree(fit.filter((r) => r.model === model)),
            ]),
          )
        : undefined,
    cells: [...cells.values()],
    training: {
      observations: fit.length,
      tasks: new Set(fit.map((r) => r.taskId)).size,
      models: new Set(fit.map((r) => r.model)).size,
      missingSemantic: fit.filter((r) => !r.task.semantic).length,
    },
  };
  // Select temperature on calibration only, never DEV/holdout.
  a.temperature = [0.5, 0.75, 1, 1.25, 1.5, 2, 3]
    .map((t) => ({
      t,
      loss: calibrationMetrics(
        calibration.map((r) => {
          const raw = rawPrediction(a, r.task, r.model).mean;
          return { y: completeSolve(r), p: sigmoid(logit(raw) / t) };
        }),
      ).logLoss,
    }))
    .sort((x, y) => x.loss - y.loss)[0]!.t;
  const calibrationGroups = new Map<string, Array<{ y: number; p: number }>>();
  for (const r of calibration) {
    const key = JSON.stringify([
      r.model,
      r.task.family,
      r.task.engine,
      r.task.harness,
    ]);
    const group = calibrationGroups.get(key) ?? [];
    group.push({
      y: completeSolve(r),
      p: predictContextualQuality(a, r.task, r.model).mean,
    });
    calibrationGroups.set(key, group);
  }
  // Empirical calibration drift with a simultaneous group bound, not ECE masquerading as confidence.
  a.calibrationError = Math.max(
    ...[...calibrationGroups.values()].map(
      (g) =>
        Math.abs(g.reduce((s, r) => s + r.y - r.p, 0) / g.length) +
        Math.sqrt(Math.log(40 * calibrationGroups.size) / (2 * g.length)),
    ),
  );
  a.digest = createHash("sha256").update(JSON.stringify(a)).digest("hex");
  return a;
}
function rawPrediction(
  a: ContextualQualityArtifact,
  task: CanonicalRoutingTask,
  model: string,
): QualityPrediction {
  const relevantFamily = (family: string) =>
    normalizeRoutingTaskFamily(family) ===
    normalizeRoutingTaskFamily(task.family);
  const exact = a.cells.filter(
    (c) =>
      c.model === model &&
      c.engine === task.engine &&
      c.harness === task.harness,
  );
  const contextual = exact.filter((c) => relevantFamily(c.family));
  const native = contextual.filter((c) => c.local === c.count);
  let selected = native.length
    ? native
    : contextual.length
      ? contextual
      : exact;
  let level: QualityPrediction["level"] = contextual.length
    ? "task_model_engine"
    : "model_global";
  let identity: QualityPrediction["identity"] = selected.every(
    (c) => c.local === c.count,
  )
    ? "EXACT"
    : "SOURCE_EXACT";
  let calibratedDomain = selected.length > 0;
  if (!selected.length) {
    const other = a.cells.filter((c) => c.model === model);
    const versions =
      a.versionTransfers
        ?.filter((v) => v.to === model && v.provenance)
        .map((v) => v.from) ?? [];
    const versionCells = a.cells.filter((c) => versions.includes(c.model));
    const familyCells = a.cells.filter(
      (c) =>
        modelFamilyKey(c.model) !== undefined &&
        modelFamilyKey(c.model) === modelFamilyKey(model),
    );
    selected = other.length
      ? other
      : versionCells.length
        ? versionCells
        : familyCells.length
          ? familyCells
          : a.cells;
    // A task-feature bucket takes precedence over unrelated aggregate outcomes.
    const relevant = selected.filter((c) => relevantFamily(c.family));
    if (relevant.length) selected = relevant;
    level = other.length
      ? "harness_transfer"
      : versionCells.length
        ? "version_transfer"
        : familyCells.length
          ? "family_transfer"
          : "ignorance";
    identity = other.length
      ? "SOURCE_EXACT"
      : versionCells.length
        ? "VERSION_TRANSFER"
        : familyCells.length
          ? "FAMILY_TRANSFER"
          : "UNKNOWN";
    calibratedDomain = false;
  }
  const rawSupport = selected.reduce((s, c) => s + c.count, 0);
  let count = rawSupport,
    solved = selected.reduce((s, c) => s + c.solved, 0);
  if (!calibratedDomain && new Set(selected.map((c) => c.model)).size > 1) {
    const perModel = new Map<string, number>();
    for (const c of selected)
      perModel.set(c.model, (perModel.get(c.model) ?? 0) + c.count);
    // Aggregate cells lack task IDs: conservatively assume maximal overlap between models.
    count = Math.max(...perModel.values(), 0);
    solved = rawSupport ? (solved * count) / rawSupport : 0;
  }
  let nativeSupport = selected.reduce((s, c) => s + c.local, 0);
  let publicSupport = rawSupport - nativeSupport;
  let nearestTaskCount = 0;
  let provenance = [...new Set(selected.flatMap((c) => c.sources))];
  if (a.estimator === "empirical" && task.text && task.semantic) {
    const q = task.semantic;
    const modelIds = new Set(selected.map((c) => c.model));
    const matching = (a.semanticExamples ?? [])
      .filter(
        (e) =>
          modelIds.has(e.model) &&
          (!calibratedDomain ||
            (e.engine === task.engine && e.harness === task.harness)) &&
          (!e.family || relevantFamily(e.family)) &&
          e.encoder === q.encoder &&
          e.vector.length === q.vector.length,
      )
      .map((e) => ({
        e,
        similarity: e.vector.reduce((s, v, i) => s + v * q.vector[i]!, 0),
      }))
      .filter((e) => e.similarity > 0.1);
    // Paired outcomes on one public task are correlated, not independent samples.
    const byTask = new Map<string, typeof matching>();
    for (const n of matching) {
      const key = n.e.taskId ?? n.e.vector.join(",");
      const group = byTask.get(key) ?? [];
      group.push(n);
      byTask.set(key, group);
    }
    const distinct = [...byTask.values()].map((group) => ({
      similarity: group[0]!.similarity,
      e: {
        ...group[0]!.e,
        success: group.reduce((sum, n) => sum + n.e.success, 0) / group.length,
        local: group.every((n) => n.e.local),
        sources: [...new Set(group.flatMap((n) => n.e.sources ?? []))],
      },
    }));
    const local = distinct.filter((n) => n.e.local);
    const neighbors = (local.length >= 20 ? local : distinct)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 32);
    nearestTaskCount = neighbors.length;
    if (neighbors.length >= 20) {
      const sum = neighbors.reduce((s, n) => s + n.similarity ** 2, 0);
      count = sum ** 2 / neighbors.reduce((s, n) => s + n.similarity ** 4, 0);
      solved =
        (count *
          neighbors.reduce((s, n) => s + n.e.success * n.similarity ** 2, 0)) /
        sum;
      nativeSupport = neighbors.filter((n) => n.e.local).length;
      publicSupport = neighbors.length - nativeSupport;
      const sources = [...new Set(neighbors.flatMap((n) => n.e.sources ?? []))];
      if (sources.length) provenance = sources;
    }
  }
  const evidence: NonNullable<QualityPrediction["evidence"]> = {
    rawSupport,
    sourceLower: wilson(solved, count).lower,
    sourceUpper: wilson(solved, count).upper,
    nativeSupport,
    publicSupport,
    nearestTaskCount,
    provenanceClass:
      level === "family_transfer"
        ? "family_transfer"
        : level === "version_transfer"
          ? "version_transfer"
          : level === "ignorance"
            ? "global_prior"
            : !calibratedDomain
              ? "public_cross_harness"
              : publicSupport === 0
                ? "native_koda"
                : "public_exact_model",
  };
  if (!calibratedDomain)
    return {
      mean: count ? (solved + 1) / (count + 2) : 0.5,
      lower: 0,
      upper: 1,
      support: count,
      level,
      identity,
      provenance,
      calibratedDomain: false,
      evidence,
    };
  const b = wilson(solved, count);
  const mean =
    a.estimator === "logistic"
      ? sigmoid(weightedLogit(a, task, model))
      : a.estimator === "tree" && a.trees?.[model]
        ? treePrediction(a.trees[model]!, task, model)
        : b.mean;
  return {
    mean,
    lower: Math.max(0, mean - (b.mean - b.lower) - a.calibrationError),
    upper: Math.min(1, mean + (b.upper - b.mean) + a.calibrationError),
    support: count,
    level,
    identity: selected.every((c) => c.local === c.count)
      ? "EXACT"
      : "SOURCE_EXACT",
    provenance,
    calibratedDomain: true,
    evidence,
  };
}
export function predictContextualQuality(
  a: ContextualQualityArtifact,
  task: CanonicalRoutingTask,
  model: string,
): QualityPrediction {
  const raw = rawPrediction(a, task, model);
  if (!raw.calibratedDomain) return raw;
  return {
    ...raw,
    mean: sigmoid(logit(raw.mean) / a.temperature),
    lower: sigmoid(logit(raw.lower) / a.temperature),
    upper: sigmoid(logit(raw.upper) / a.temperature),
  };
}
export function calibrationMetrics(rows: Array<{ y: number; p: number }>) {
  if (!rows.length) return { n: 0, brier: null, logLoss: Infinity, ece: 1 };
  let brier = 0,
    logLoss = 0,
    ece = 0;
  const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 }));
  for (const { y, p } of rows) {
    brier += (p - y) ** 2;
    const safe = Math.max(1e-9, Math.min(1 - 1e-9, p));
    logLoss -= y * Math.log(safe) + (1 - y) * Math.log(1 - safe);
    const b = bins[Math.min(9, Math.floor(p * 10))]!;
    b.n++;
    b.p += p;
    b.y += y;
  }
  for (const b of bins)
    if (b.n) ece += (b.n / rows.length) * Math.abs(b.p / b.n - b.y / b.n);
  return {
    n: rows.length,
    brier: brier / rows.length,
    logLoss: logLoss / rows.length,
    ece,
  };
}

function buildTree(
  rows: CanonicalQualityObservation[],
  depth = 0,
): QualityTree {
  const mean =
    (rows.reduce((s, r) => s + completeSolve(r), 0) + 1) / (rows.length + 2);
  if (depth >= 4 || rows.length < 40) return { mean };
  const keys = [
    ...new Set(
      rows.flatMap((r) =>
        featureKeys(r.task, r.model)
          .filter(([k, v]) => v > 0 && !k.startsWith("model:") && k !== "bias")
          .map(([k]) => k),
      ),
    ),
  ];
  const present = (r: CanonicalQualityObservation, key: string) =>
    featureKeys(r.task, r.model).some(([k, v]) => k === key && v > 0);
  const impurity = (rs: CanonicalQualityObservation[]) => {
    if (!rs.length) return 0;
    const p = rs.reduce((s, r) => s + completeSolve(r), 0) / rs.length;
    return rs.length * p * (1 - p);
  };
  let best:
    | {
        key: string;
        left: CanonicalQualityObservation[];
        right: CanonicalQualityObservation[];
        loss: number;
      }
    | undefined;
  for (const key of keys) {
    const left = rows.filter((r) => !present(r, key)),
      right = rows.filter((r) => present(r, key));
    if (Math.min(left.length, right.length) < 20) continue;
    const loss = impurity(left) + impurity(right);
    if (!best || loss < best.loss) best = { key, left, right, loss };
  }
  return best && best.loss < impurity(rows)
    ? {
        mean,
        feature: best.key,
        left: buildTree(best.left, depth + 1),
        right: buildTree(best.right, depth + 1),
      }
    : { mean };
}
function treePrediction(
  tree: QualityTree,
  task: CanonicalRoutingTask,
  model: string,
): number {
  if (!tree.feature) return tree.mean;
  const present = featureKeys(task, model).some(
    ([k, v]) => k === tree.feature && v > 0,
  );
  const next = present ? tree.right : tree.left;
  return next ? treePrediction(next, task, model) : tree.mean;
}

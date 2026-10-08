import { readFile, writeFile, mkdir, open } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  canonicalKnowledgeSnapshot,
  normalizeCanonicalSource,
  trainingEligible,
  type CanonicalQualityObservation,
} from "../router/knowledge/canonical.js";
import {
  resolveSourceIdentities,
  type EvidenceSourceInput,
} from "../router/knowledge/ingest.js";
import {
  fitContextualQuality,
  predictContextualQuality,
  completeSolve,
  taskPartition,
  calibrationMetrics,
  validateContextualArtifact,
  type ContextualQualityArtifact,
} from "../router/contextualQuality.js";

export function evaluatePredictions(
  rows: CanonicalQualityObservation[],
  artifact: ContextualQualityArtifact,
) {
  const predictions = rows.map((r) => ({
    row: r,
    y: completeSolve(r),
    p: predictContextualQuality(artifact, r.task, r.model),
  }));
  const groups = (key: (r: CanonicalQualityObservation) => string) =>
    Object.fromEntries(
      [...new Set(rows.map(key))]
        .sort()
        .map((k) => [
          k,
          calibrationMetrics(
            predictions
              .filter((p) => key(p.row) === k)
              .map((p) => ({ y: p.y, p: p.p.mean })),
          ),
        ]),
    );
  const economics = (row: CanonicalQualityObservation) => {
    const cells = artifact.cells.filter(
      (c) =>
        c.model === row.model &&
        c.family === row.task.family &&
        c.engine === row.task.engine,
    );
    const n = cells.reduce((s, c) => s + (c.costSamples ?? 0), 0);
    return n ? cells.reduce((s, c) => s + (c.costSum ?? 0), 0) / n : Infinity;
  };
  const tasks = new Map<string, typeof predictions>();
  for (const p of predictions) {
    const t = tasks.get(p.row.taskId) ?? [];
    t.push(p);
    tasks.set(p.row.taskId, t);
  }
  const chosen: Array<(typeof predictions)[number] | undefined> = [],
    strongest: Array<(typeof predictions)[number] | undefined> = [],
    cheapest: Array<(typeof predictions)[number] | undefined> = [],
    oracle: Array<(typeof predictions)[number] | undefined> = [];
  for (const entries of tasks.values()) {
    // Source-domain score-only selector; NOT a claim about VERIFIED Koda execution plans.
    const best = [...entries].sort((a, b) => b.p.mean - a.p.mean)[0]!;
    const eligible = entries.filter((e) => e.p.lower >= best.p.upper - 0.02);
    const selected = eligible.sort(
      (a, b) => economics(a.row) - economics(b.row),
    )[0];
    chosen.push(selected);
    const globalModel = [...artifact.cells].reduce((s, c) => {
      const old = s.get(c.model) ?? { n: 0, y: 0 };
      old.n += c.count;
      old.y += c.solved;
      s.set(c.model, old);
      return s;
    }, new Map<string, { n: number; y: number }>());
    strongest.push(
      [...entries].sort(
        (a, b) =>
          globalModel.get(b.row.model)!.y / globalModel.get(b.row.model)!.n -
          globalModel.get(a.row.model)!.y / globalModel.get(a.row.model)!.n,
      )[0],
    );
    cheapest.push(
      [...entries].sort((a, b) => economics(a.row) - economics(b.row))[0],
    );
    oracle.push(
      [...entries].sort(
        (a, b) =>
          b.y - a.y ||
          (a.row.costUsd ?? Infinity) - (b.row.costUsd ?? Infinity),
      )[0],
    );
  }
  const summarize = (values: typeof chosen) => {
    const available = values.filter(
        (p): p is (typeof predictions)[number] => !!p,
      ),
      solved = available.reduce((s, p) => s + p.y, 0);
    const costs = available.map((p) => p.row.costUsd),
      times = available.map((p) => p.row.latencyMs);
    return {
      tasks: values.length,
      selected: available.length,
      abstentions: values.length - available.length,
      solveRate: available.length ? solved / available.length : null,
      costPerTask:
        costs.every((c) => c !== undefined) && available.length
          ? costs.reduce((s, c) => s + c!, 0) / available.length
          : null,
      costPerSolved:
        costs.every((c) => c !== undefined) && solved
          ? costs.reduce((s, c) => s + c!, 0) / solved
          : null,
      latencyPerTaskMs:
        times.every((t) => t !== undefined) && available.length
          ? times.reduce((s, t) => s + t!, 0) / available.length
          : null,
    };
  };
  return {
    calibration: calibrationMetrics(
      predictions.map((p) => ({ y: p.y, p: p.p.mean })),
    ),
    byCategory: groups((r) => r.task.family),
    byModel: groups((r) => r.model),
    byEngine: groups((r) => r.task.engine),
    coverage: {
      predicted: predictions.length,
      supported: predictions.filter((p) => p.p.calibratedDomain).length,

      meanWidth: predictions.length
        ? predictions.reduce((s, p) => s + p.p.upper - p.p.lower, 0) /
          predictions.length
        : null,
    },
    routers: {
      contextual: summarize(chosen),
      strongest: summarize(strongest),
      cheapest: summarize(cheapest),
      oracle: summarize(oracle),
    },
    regretOnSelected: chosen.some(Boolean)
      ? {
          vsOracle:
            chosen.reduce((s, p, i) => s + (p ? oracle[i]!.y - p.y : 0), 0) /
            chosen.filter(Boolean).length,
          vsStrongest:
            chosen.reduce((s, p, i) => s + (p ? strongest[i]!.y - p.y : 0), 0) /
            chosen.filter(Boolean).length,
        }
      : null,
    criticalFalseAccepts: null,
    frontierCallRate: null,
    reason:
      "Source benchmark has no Koda verifier outcomes; abstentions are not verified solves",
  };
}
export async function buildContextualRoutingArtifact(
  source: EvidenceSourceInput,
  output: string,
) {
  const snapshot = canonicalKnowledgeSnapshot([
    resolveSourceIdentities(source, []),
  ]);
  const rows = snapshot.qualityEvidence!.filter(trainingEligible);
  const dev = rows.filter((r) => taskPartition(r.taskId) === "development");
  const candidates = (["empirical", "logistic"] as const).map((kind) => {
    const artifact = fitContextualQuality(rows, kind);
    const report = evaluatePredictions(dev, artifact);
    return { artifact, report };
  });
  // Architecture selection is frozen using DEV only. Holdout labels have never been read here.
  candidates.sort(
    (a, b) =>
      (a.report.calibration.brier ?? Infinity) -
      (b.report.calibration.brier ?? Infinity),
  );
  const selected = candidates[0]!;
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, "routing-knowledge-v2.json"),
    JSON.stringify(snapshot),
  );
  await writeFile(
    join(output, "contextual-quality-v1.json"),
    JSON.stringify(selected.artifact),
  );
  const report = {
    policyFrozen: true,
    policyDigest: selected.artifact.digest,
    status: "SHADOW_ONLY_NOT_VALIDATED_FOR_KODA",
    sourceDigest: createHash("sha256")
      .update(JSON.stringify(source))
      .digest("hex"),
    source: source.id,
    split: source.split,
    totalObservations: rows.length,
    models: new Set(rows.map((r) => r.model)).size,
    tasks: new Set(rows.map((r) => r.taskId)).size,
    splitTasks: Object.fromEntries(
      ["fit", "calibration", "development"].map((p) => [
        p,
        new Set(
          rows
            .filter((r) => taskPartition(r.taskId) === p)
            .map((r) => r.taskId),
        ).size,
      ]),
    ),
    missingText: source.tasks?.filter((t) => !t.text).length,
    missingSemantic: rows.filter((r) => !r.task.semantic).length,
    scoreTarget:
      "Complete benchmark solve: score == 1; partial scores retained but not full solves",
    selected: selected.artifact.estimator,
    candidates: candidates.map((c) => ({
      estimator: c.artifact.estimator,
      ...c.report,
    })),
    limitations: [
      "No Koda-verifier calibration or real conditional rescue evidence",
      "Semantic task descriptors absent from this probing source",
      "Production/V1 router replay not measured by this estimator comparison",
    ],
  };
  await writeFile(
    join(output, "development-report.json"),
    JSON.stringify(report, null, 2),
  );
  return report;
}
/** The exclusive marker binds one evaluation to frozen artifact and source bytes. No overwrite/resume-tuning. */
export async function evaluateFrozenHoldout(
  artifactPath: string,
  sourcePath: string,
  output: string,
) {
  const artifact = validateContextualArtifact(
    JSON.parse(await readFile(artifactPath, "utf8")),
  );
  const source: EvidenceSourceInput = JSON.parse(
    await readFile(sourcePath, "utf8"),
  );
  if (
    !["id_test", "ood"].includes(source.split ?? "") ||
    source.trainingAllowed !== false
  )
    throw Error("Holdout must be explicitly evaluation-only");
  const sourceDigest = createHash("sha256")
    .update(JSON.stringify(source))
    .digest("hex");
  await mkdir(dirname(output), { recursive: true });
  const marker = await open(`${artifactPath}.${source.split}.once`, "wx");
  await marker.writeFile(
    JSON.stringify({ artifactDigest: artifact.digest, sourceDigest }),
  );
  await marker.close();
  // Normalization only: never passed to fitContextualQuality or persisted as runtime priors.
  const rows = normalizeCanonicalSource(
    resolveSourceIdentities(source, []),
    new Date().toISOString(),
  );
  const report = {
    artifactDigest: artifact.digest,
    sourceDigest,
    split: source.split,
    ...evaluatePredictions(rows, artifact),
  };
  await writeFile(output, JSON.stringify(report, null, 2));
  return report;
}
async function main() {
  const argv = process.argv.slice(2),
    get = (key: string) => argv[argv.indexOf(key) + 1];
  if (argv.includes("--holdout")) {
    if (!argv.includes("--artifact") || !argv.includes("--output"))
      throw Error("--holdout FILE --artifact FILE --output FILE required");
    console.log(
      JSON.stringify(
        await evaluateFrozenHoldout(
          get("--artifact")!,
          get("--holdout")!,
          get("--output")!,
        ),
      ),
    );
    return;
  }
  if (!argv.includes("--source") || !argv.includes("--output"))
    throw Error("--source FILE --output DIR required; no provider calls");
  const source = JSON.parse(await readFile(get("--source")!, "utf8"));
  console.log(
    JSON.stringify(
      await buildContextualRoutingArtifact(source, get("--output")!),
    ),
  );
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  await main();

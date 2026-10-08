import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import { freezeColdStartArtifact } from "../router/knowledge/coldStart.js";
import { pathToFileURL } from "node:url";
import {
  validateEvidence,
  digest,
  freezeEvidence,
  writeImmutable,
} from "../router/knowledge/evidenceRegistry.js";
import {
  fitContextualQuality,
  taskPartition,
  predictContextualQuality,
  completeSolve,
  type EstimatorKind,
} from "../router/contextualQuality.js";
import { evaluatePredictions } from "./contextualRoutingEval.js";
import { pairedRegret, conditionalRecovery } from "../router/pairedEvidence.js";
import type { CanonicalQualityObservation } from "../router/knowledge/canonical.js";
import { trainingEligible } from "../router/knowledge/canonical.js";
export async function evaluateMilestone(
  publicPath: string,
  coarsePath: string | undefined,
  output: string,
  nativeLedger?: string,
  coldStartOutput?: string,
) {
  const publicArtifact = validateEvidence<any>(
    JSON.parse(await readFile(publicPath, "utf8")),
  );
  const rows: CanonicalQualityObservation[] = [...publicArtifact.payload.rows];
  if (nativeLedger) {
    const local = (await readFile(nativeLedger, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CanonicalQualityObservation);
    if (local.some((r) => r.origin !== "local" || !trainingEligible(r)))
      throw Error("Native ledger contains unproven or censored outcomes");
    const ids = new Set(rows.map((r) => r.id));
    for (const row of local) {
      if (ids.has(row.id)) throw Error("Duplicate native quality observation");
      ids.add(row.id);
      rows.push(row);
    }
  }
  if (coarsePath) {
    const coarse = JSON.parse(await readFile(coarsePath, "utf8"));
    rows.push(...(coarse.qualityEvidence ?? []));
  }
  if (rows.some((r) => !trainingEligible(r)))
    throw Error(
      "Evaluation input contains inadmissible holdout/synthetic/censored quality evidence",
    );
  const dev = rows.filter((r) => taskPartition(r.taskId) === "development");
  const kinds: EstimatorKind[] = ["empirical", "logistic", "tree"];
  const candidates = kinds.map((kind) => {
    const artifact = fitContextualQuality(
      rows,
      kind,
      "frozen-public-development-v2",
    );
    const metrics = evaluatePredictions(dev, artifact);
    return { kind, artifact, metrics };
  });
  const selected = [...candidates].sort(
    (a, b) =>
      (a.metrics.calibration.brier ?? Infinity) -
      (b.metrics.calibration.brier ?? Infinity),
  )[0]!;
  const tasks = new Map<string, CanonicalQualityObservation[]>();
  for (const r of dev) {
    const key = JSON.stringify([r.taskId, r.task.engine, r.task.harness]);
    const g = tasks.get(key) ?? [];
    g.push(r);
    tasks.set(key, g);
  }
  let oldSelected = 0,
    newSelected = 0,
    pairs = 0,
    rankingCorrect = 0;
  const regretCache = new Map<string, ReturnType<typeof pairedRegret>>();
  for (const group of tasks.values()) {
    const predictions = group.map((r) => ({
      r,
      q: predictContextualQuality(selected.artifact, r.task, r.model),
    }));
    const ref = [...predictions].sort((a, b) => b.q.mean - a.q.mean)[0]!;
    if (predictions.some((p) => p.q.lower >= ref.q.upper - 0.02)) oldSelected++;
    let allowed = false;
    for (const p of predictions) {
      const key = JSON.stringify([
        p.r.task.family,
        p.r.task.engine,
        p.r.task.harness,
        p.r.model,
        ref.r.model,
      ]);
      let comparison = regretCache.get(key);
      if (!comparison) {
        comparison = pairedRegret({
          rows: selected.artifact.paired ?? [],
          task: p.r.task,
          candidate: [p.r.model],
          reference: [ref.r.model],
          allowedRegret: 0.02,
          detection: 0,
        });
        regretCache.set(key, comparison);
      }
      if (comparison.probability <= 0.05) allowed = true;
      for (const other of predictions)
        if (
          other.r.model !== p.r.model &&
          completeSolve(other.r) !== completeSolve(p.r)
        ) {
          pairs++;
          rankingCorrect += Number(
            (other.q.mean - p.q.mean) *
              (completeSolve(other.r) - completeSolve(p.r)) >
              0,
          );
        }
    }
    if (allowed) newSelected++;
  }
  const recoveries: Array<
    ReturnType<typeof conditionalRecovery> & {
      key: string;
      provenanceDigest: string;
    }
  > = [];
  for (const group of tasks.values()) {
    const first = group[0]!;
    const ids = group.map((r) => r.model);
    for (const a of ids)
      for (const b of ids)
        if (a !== b) {
          const key = JSON.stringify([
            first.task.family,
            first.task.engine,
            first.task.harness,
            a,
            b,
          ]);
          if (recoveries.some((r: any) => r.key === key)) continue;
          const recovery = conditionalRecovery(
            selected.artifact.paired ?? [],
            first.task,
            a,
            b,
          );
          if (recovery.successes + recovery.failures)
            recoveries.push({
              key,
              ...recovery,
              provenanceDigest: digest(recovery.provenance),
              provenance: recovery.provenance,
            });
        }
  }
  const report = {
    sourceDigest: publicArtifact.digest,
    totalRows: rows.length,
    richTasks: publicArtifact.payload.tasks.length,
    developmentRows: dev.length,
    candidates: candidates.map((c) => ({
      estimator: c.kind,
      ...c.metrics.calibration,
    })),
    selected: selected.kind,
    metrics: selected.metrics,
    pairwiseRankingAccuracy: pairs ? rankingCorrect / pairs : null,
    qualityComparison: {
      tasks: tasks.size,
      allowedRegret: 0.02,
      maxRegretProbability: 0.05,
      oldCoverage: oldSelected / tasks.size,
      newSourceDomainCoverage: newSelected / tasks.size,
      KodaVerifiedCoverage: null,
      notes:
        "Identical reference is eligible for relative regret; independent false-accept and transferable harness gates still apply. This is not a Koda verified solve rate.",
    },
    recovery: recoveries.map((r) => ({
      ...r,
      conditionalMean: r.successes / (r.successes + r.failures),
    })),
    regretCalibration: null,
    limitations: [
      "No measured public-to-Koda harness transfer",
      "No pristine final holdout evaluation",
      "No paid native calibration",
      "Source domain model versions are not automatically current provider aliases",
    ],
  };
  await mkdir(resolve(output), { recursive: true });
  await writeFile(
    join(output, "development-report.json"),
    JSON.stringify(report, null, 2),
  );
  const envelope = freezeEvidence(selected.artifact, {
    sourceDigests: {
      public: publicArtifact.digest,
      coarse: coarsePath ? digest(await readFile(coarsePath, "utf8")) : "none",
      native: nativeLedger
        ? digest(await readFile(nativeLedger, "utf8"))
        : "none",
    },
    modelMappingDigest: publicArtifact.modelMappingDigest,
    taskVersion: 1,
    splitDigest: digest(dev.map((r) => r.taskId)),
    estimatorVersion: "vnext-2",
    calibrationVersion: "source-domain-v2",
    policyDigest: digest({ regret: 0.02, risk: 0.05 }),
    timestamp: "content-frozen-v2",
    provenance: [publicPath],
  });
  await writeImmutable(
    join(output, `quality-${envelope.digest}.json`),
    envelope,
  );
  await writeFile(
    join(output, "contextual-quality-v1.json"),
    JSON.stringify(selected.artifact),
  );
  if (coldStartOutput) {
    await writeFile(
      resolve(coldStartOutput),
      gzipSync(
        JSON.stringify(freezeColdStartArtifact(selected.artifact, rows)),
      ),
    );
  }
  return {
    ...report,
    artifactPath: join(output, "contextual-quality-v1.json"),
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values: v } = parseArgs({
    options: {
      public: { type: "string" },
      coarse: { type: "string" },
      output: { type: "string" },
      "native-ledger": { type: "string" },
      "cold-start-output": { type: "string" },
    },
  });
  if (!v.public || !v.output) throw Error("--public --output required");
  console.log(
    JSON.stringify(
      await evaluateMilestone(
        v.public,
        v.coarse,
        v.output,
        v["native-ledger"],
        v["cold-start-output"],
      ),
      null,
      2,
    ),
  );
}

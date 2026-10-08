import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import {
  validateContextualArtifact,
  completeSolve,
  taskPartition,
  type ContextualQualityArtifact,
} from "../contextualQuality.js";
import {
  trainingEligible,
  type CanonicalQualityObservation,
} from "./canonical.js";

import {
  pairedTaskEvidence,
  type PairedTaskOutcome,
} from "../pairedEvidence.js";
function mergePairs(base: PairedTaskOutcome[], extra: PairedTaskOutcome[]) {
  const key = (r: PairedTaskOutcome) =>
    JSON.stringify([r.source, r.taskId, r.engine, r.harness]);
  return [...new Map([...base, ...extra].map((r) => [key(r), r])).values()];
}

export const coldStartArtifactPath = new URL(
  "./data/contextual-cold-start-v1.json.gz",
  import.meta.url,
);
let bundled: ContextualQualityArtifact | undefined;
export function bundledColdStartArtifact() {
  return (bundled ??= validateContextualArtifact(
    JSON.parse(
      gunzipSync(readFileSync(coldStartArtifactPath)).toString("utf8"),
    ),
  ));
}
function freeze(a: ContextualQualityArtifact) {
  a.digest = "";
  a.digest = createHash("sha256").update(JSON.stringify(a)).digest("hex");
  return validateContextualArtifact(a);
}
/** Offline only. Enrich an already frozen fit with outcome-blind retrieval metadata.
 * Never include final holdout, DEV/calibration task partitions, synthetic or censored rows.
 */
export function freezeColdStartArtifact(
  base: ContextualQualityArtifact,
  rows: CanonicalQualityObservation[],
) {
  validateContextualArtifact(base);
  const fit = rows.filter(
    (r) => trainingEligible(r) && taskPartition(r.taskId) === "fit",
  );
  const a = structuredClone(base);
  const byExample = new Map(
    fit
      .filter((r) => r.task.semantic)
      .map((r) => [
        JSON.stringify([
          r.model,
          r.task.engine,
          r.task.harness,
          r.task.semantic!.vector,
        ]),
        r,
      ]),
  );
  for (const e of a.semanticExamples ?? []) {
    const r = byExample.get(
      JSON.stringify([e.model, e.engine, e.harness, e.vector]),
    );
    if (r) {
      e.family = r.task.family;
      e.sources = [r.provenance];
      e.taskId = r.taskId;
    }
  }
  // Native receipts may have arrived since the public artifact was frozen.
  // Aggregate only independently admissible native FIT outcomes, not raw benchmark claims.
  const native = fit.filter((r) => r.origin === "local");
  const groups = new Map<string, (typeof a.cells)[number]>();
  for (const r of native) {
    const key = JSON.stringify([
      r.model,
      r.task.family,
      r.task.engine,
      r.task.harness,
    ]);
    const c = groups.get(key) ?? {
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
    c.local++;
    c.solved += completeSolve(r);
    if (!c.sources.includes(r.provenance)) c.sources.push(r.provenance);
    groups.set(key, c);
  }
  for (const c of groups.values()) {
    const i = a.cells.findIndex(
      (old) =>
        old.local === old.count &&
        JSON.stringify([old.model, old.family, old.engine, old.harness]) ===
          JSON.stringify([c.model, c.family, c.engine, c.harness]),
    );
    if (i >= 0) a.cells[i] = c;
    else a.cells.push(c);
  }
  const nativeModels = new Set(native.map((r) => r.model));
  a.semanticExamples = [
    ...(a.semanticExamples ?? []).filter(
      (e) => !e.local || !nativeModels.has(e.model),
    ),
    ...native
      .filter((r) => r.task.semantic)
      .map((r) => ({
        model: r.model,
        engine: r.task.engine,
        harness: r.task.harness,
        encoder: r.task.semantic!.encoder,
        vector: r.task.semantic!.vector,
        success: completeSolve(r),
        local: true,
        family: r.task.family,
        sources: [r.provenance],
        taskId: r.taskId,
      })),
  ];
  a.paired = mergePairs(a.paired ?? [], pairedTaskEvidence(native));
  a.frozenAt = "frozen-cold-start-v1";
  a.trainingDigest = createHash("sha256")
    .update(
      JSON.stringify([
        base.trainingDigest,
        fit.map((r) => [r.id, r.provenance]),
      ]),
    )
    .digest("hex");
  return freeze(a);
}
/** Local native evidence stays authoritative where present; public data is available without a user ledger. */
export function withColdStartEvidence(local?: ContextualQualityArtifact) {
  const publicArtifact = bundledColdStartArtifact();
  if (!local) return publicArtifact;
  validateContextualArtifact(local);
  if (
    (local.semanticExamples?.length ?? 0) > 0 &&
    local.training.observations >= publicArtifact.training.observations
  )
    return local;
  // Use the complete frozen public estimator, replacing only matching native cells.
  const a = structuredClone(publicArtifact);
  for (const c of local.cells.filter((c) => c.local === c.count)) {
    const i = a.cells.findIndex(
      (old) =>
        old.local === old.count &&
        old.model === c.model &&
        old.family === c.family &&
        old.engine === c.engine &&
        old.harness === c.harness,
    );
    if (i >= 0) a.cells[i] = c;
    else a.cells.push(c);
  }
  const localExamples = (local.semanticExamples ?? []).filter((e) => e.local);
  const localModels = new Set(localExamples.map((e) => e.model));
  a.semanticExamples = [
    ...(a.semanticExamples ?? []).filter(
      (e) => !e.local || !localModels.has(e.model),
    ),
    ...localExamples,
  ];
  a.paired = mergePairs(a.paired ?? [], local.paired ?? []);
  return freeze(a);
}

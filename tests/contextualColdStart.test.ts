import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalRoutingTask } from "../src/router/canonicalTask.js";
import { lexicalTask } from "../src/router/lexicalTask.js";
import {
  fitContextualQuality,
  predictContextualQuality,
  taskPartition,
} from "../src/router/contextualQuality.js";
import {
  bundledColdStartArtifact,
  freezeColdStartArtifact,
  withColdStartEvidence,
} from "../src/router/knowledge/coldStart.js";
import type { CanonicalQualityObservation } from "../src/router/knowledge/canonical.js";
import { contextualShadowDecision } from "../src/router/contextualShadow.js";
const text = "Repair arithmetic interval handling in a utility function";
const task = canonicalRoutingTask({
  family: "debugging",
  engine: "direct",
  harness: "koda",
  text,
  semantic: lexicalTask(text),
});
function rows(): CanonicalQualityObservation[] {
  return Array.from({ length: 250 }, (_, i) => ({
    id: `e-${i}`,
    taskId: `e-${i}`,
    model: "vendor/coder-v1",
    revision: "vendor/coder-v1",
    identity: "SOURCE_EXACT",
    task: { ...task, harness: "public-agent" },
    source: "public",
    origin: "external",
    split: "development",
    provenance: "public:v1",
    timestamp: "2026-10-06",
    success: i % 4 !== 0,
    trainingAllowed: true,
  }));
}
test("zero user history loads compact public evidence without a raw source or provider", async () => {
  const directory = await mkdtemp(join(tmpdir(), "koda-empty-quality-"));
  try {
    const a = bundledColdStartArtifact();
    assert.ok(a.training.observations > 0);
    assert.ok((a.semanticExamples?.length ?? 0) > 0);
    assert.ok((a.paired?.length ?? 0) > 0);
    const model = a.cells[0]!.model;
    const decision = contextualShadowDecision(
      {
        text,
        assessment: undefined,
        contract: undefined,
        fingerprint: { taskFamily: "debugging", executionStrategy: "direct" },
        models: [
          {
            model: { id: model, enabled: true },
            metadata: {
              available: true,
              inputPrice: 1,
              outputPrice: 1,
              contextLength: 10000,
              maxOutputTokens: 1000,
              supportedParameters: ["tools", "tool_choice"],
            },
          },
        ],
        inputTokens: 100,
        outputTokens: 100,
        budgetUsd: 1,
      } as never,
      directory,
    );
    assert.equal(decision.mode, "shadow");
    assert.ok("candidates" in decision);
    assert.ok(decision.candidates[0]!.quality.support > 0);
    assert.equal(decision.candidates[0]!.quality.calibratedDomain, false);
    assert.equal(decision.status, "ABSTAIN");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("public exact-model cross-harness evidence has support without fabricated transfer confidence", () => {
  const a = fitContextualQuality(rows(), "empirical", "fixed");
  const p = predictContextualQuality(a, task, "vendor/coder-v1");
  assert.ok(p.support > 0);
  assert.ok(p.evidence!.nearestTaskCount > 0);
  assert.ok(p.evidence!.publicSupport > 0);
  assert.equal(p.evidence!.nativeSupport, 0);
  assert.equal(p.level, "harness_transfer");
  assert.equal(p.evidence!.provenanceClass, "public_cross_harness");
  assert.equal(p.lower, 0);
  assert.equal(p.upper, 1);
  assert.equal(p.calibratedDomain, false);
});
test("relevant native evidence outranks public aggregate and source provenance stays separate", () => {
  const native = rows().map((r) => ({
    ...r,
    id: `n-${r.id}`,
    taskId: `n-${r.taskId}`,
    task,
    origin: "local" as const,
    split: "local" as const,
    source: "native",
    provenance: "native:receipts",
    identity: "EXACT" as const,
    success: true,
    outcome: "VERIFIED_SUCCESS",
    proof: { independent: true, requirementLevel: true },
  }));
  const a = fitContextualQuality([...rows(), ...native], "empirical", "fixed");
  const p = predictContextualQuality(a, task, "vendor/coder-v1");
  assert.ok(p.mean > 0.95);
  assert.ok(p.evidence!.nativeSupport > 0);
  assert.equal(p.evidence!.publicSupport, 0);
  assert.equal(p.evidence!.provenanceClass, "native_koda");
  assert.deepEqual(p.provenance, ["native:receipts"]);
  const loaded = withColdStartEvidence(a);
  const nativePrediction = predictContextualQuality(
    loaded,
    task,
    "vendor/coder-v1",
  );
  assert.ok(nativePrediction.evidence!.nativeSupport > 0);
  assert.equal(nativePrediction.evidence!.publicSupport, 0);
  assert.ok(
    loaded.paired!.some(
      (pair) => pair.harness === "koda" && pair.source === "native",
    ),
  );
});
test("cold-start freeze excludes holdout, synthetic and calibration task retrieval evidence", () => {
  const admissible = rows(),
    a = fitContextualQuality(admissible, "empirical", "fixed");
  const frozen = freezeColdStartArtifact(a, [
    ...admissible,
    ...admissible.map((r) => ({
      ...r,
      id: `held-${r.id}`,
      taskId: `held-${r.taskId}`,
      split: "id_test" as const,
      role: "FINAL_HOLDOUT" as const,
    })),
    ...admissible.map((r) => ({
      ...r,
      id: `fake-${r.id}`,
      origin: "synthetic" as const,
    })),
  ]);
  assert.ok(
    frozen.semanticExamples!.every(
      (e) =>
        e.taskId &&
        taskPartition(e.taskId) === "fit" &&
        !e.taskId.startsWith("held-"),
    ),
  );
  assert.deepEqual(frozen.cells, a.cells);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";
import { canonicalRoutingTask } from "../src/router/canonicalTask.js";
import { lexicalTask } from "../src/router/lexicalTask.js";
import { normalizePublicSubmission } from "../src/dev/publicRoutingEvidence.js";
import {
  pairedRegret,
  pairedTaskEvidence,
  conditionalRecovery,
  sameModelRetry,
} from "../src/router/pairedEvidence.js";
import {
  EvidenceSplitRegistry,
  freezeEvidence,
  validateEvidence,
  digest,
  claimFinalEvaluation,
} from "../src/router/knowledge/evidenceRegistry.js";
import {
  selectCalibrationModels,
  runNativeCalibration,
  type CalibrationModel,
} from "../src/dev/nativeCalibration.js";
import {
  runtimeCandidate,
  verifierStageA,
  verifierStageB,
  verifierStatistics,
} from "../src/dev/verifierCalibration.js";
import {
  fitContextualQuality,
  predictContextualQuality,
} from "../src/router/contextualQuality.js";
import { selectContextualPlan } from "../src/router/contextualPlans.js";
const task = canonicalRoutingTask({
  family: "debugging",
  engine: "source-agent",
  harness: "agent",
});
const publicRows = () =>
  normalizePublicSubmission(
    Array.from({ length: 150 }, (_, i) => ({
      id: "issue-" + i,
      text: "Repair incorrect arithmetic rounding",
      repo: "owner/repo",
      baseCommit: "a".repeat(40),
    })),
    {
      id: "submission",
      model: "vendor/model-v1",
      revision: "v1",
      harness: "agent",
      engine: "source-agent",
      resolved: Array.from({ length: 135 }, (_, i) => "issue-" + i),
      unavailable: [],
      provenance: "public-source",
      timestamp: "2026-01-01",
    },
  );
const pairs = (count: number, discordant = 0) =>
  Array.from({ length: count }, (_, i) => ({
    family: task.family,
    engine: task.engine,
    harness: task.harness,
    source: "public",
    taskId: "task-" + i,
    outcomes: { cheap: i < discordant ? 0 : 1, strong: 1 },
    provenance: ["public-paired"],
  }));
test("rich original problem text is retained; labels cannot become lexical features", () => {
  const a = publicRows();
  assert.equal(a[0]!.task.text, "Repair incorrect arithmetic rounding");
  assert.ok(a[0]!.task.semantic);
  const other = { ...a[0]!, success: !a[0]!.success };
  assert.deepEqual(a[0]!.task, other.task);
  assert.deepEqual(lexicalTask("same text"), lexicalTask("same text"));
  assert.equal(canonicalRoutingTask({ harness: "coarse" }).semantic, undefined);
});
test("unknown identity and excluded runs cannot acquire invented outcomes", () => {
  assert.throws(() =>
    normalizePublicSubmission([], {
      id: "a",
      model: "",
      revision: "",
      harness: "agent",
      engine: "a",
      resolved: [],
      unavailable: [],
      provenance: "a",
      timestamp: "a",
    }),
  );
  const rows = normalizePublicSubmission(
    [{ id: "x", text: "x", repo: "r", baseCommit: "a" }],
    {
      id: "a",
      model: "m",
      revision: "v",
      harness: "agent",
      engine: "a",
      resolved: [],
      unavailable: ["x"],
      provenance: "a",
      timestamp: "a",
    },
  );
  assert.equal(rows.length, 0);
});
test("paired recovery requires same actual tasks and preserves harness isolation", () => {
  const p = pairedTaskEvidence(publicRows());
  assert.equal(
    conditionalRecovery(p, task, "vendor/model-v1", "missing").successes,
    0,
  );
  assert.equal(
    conditionalRecovery(
      p,
      { ...task, harness: "koda" },
      "vendor/model-v1",
      "missing",
    ).failures,
    0,
  );
  assert.throws(() => conditionalRecovery(p, task, "a", "a"));
});
test("same-model retries are ordered repeated runs, not cross-model rescue", () => {
  assert.deepEqual(
    sameModelRetry([
      {
        taskId: "x",
        model: "a",
        revision: "1",
        harness: "h",
        run: 1,
        success: false,
      },
      {
        taskId: "x",
        model: "a",
        revision: "1",
        harness: "h",
        run: 2,
        success: true,
      },
      {
        taskId: "x",
        model: "b",
        revision: "1",
        harness: "h",
        run: 3,
        success: true,
      },
    ]),
    { kind: "same-model-retry", successes: 1, failures: 0 },
  );
});
test("paired regret accepts equivalent supported models without changing regret", () => {
  const d = pairedRegret({
    rows: pairs(1000),
    task,
    candidate: ["cheap"],
    reference: ["strong"],
    detection: 0,
    allowedRegret: 0.02,
  });
  assert.ok(d.probability < 0.05);
  assert.equal(d.support, 1000);
});
test("paired regret rejects large observed loss regardless of price", () => {
  const d = pairedRegret({
    rows: pairs(1000, 200),
    task,
    candidate: ["cheap"],
    reference: ["strong"],
    detection: 0,
    allowedRegret: 0.02,
  });
  assert.ok(d.probability > 0.95);
});
test("sparse or mismatched paired evidence cannot substitute independent marginals", () => {
  for (const rows of [
    pairs(10),
    pairs(100).map((r) => ({ ...r, harness: "other" })),
  ])
    assert.equal(
      pairedRegret({
        rows,
        task,
        candidate: ["cheap"],
        reference: ["strong"],
        detection: 1,
        allowedRegret: 0.02,
      }).probability,
      1,
    );
});
test("same reference has exactly zero relative regret even with marginal uncertainty", () => {
  assert.equal(
    pairedRegret({
      rows: [],
      task,
      candidate: ["a"],
      reference: ["a"],
      detection: 0,
      allowedRegret: 0.02,
    }).probability,
    0,
  );
});
test("measured rescue probability credits only observed matched rescue successes", () => {
  const d = pairedRegret({
    rows: pairs(1000, 200),
    task,
    candidate: ["cheap", "strong"],
    reference: ["strong"],
    detection: 0.99,
    allowedRegret: 0.02,
  });
  assert.ok(d.probability < 0.05);
});
test("false acceptance remains an independent gate after direct regret passes", () => {
  const p = selectContextualPlan({
    task,
    candidates: [
      {
        model: "a",
        engine: task.engine,
        compatible: true,
        costUsd: 0,
        latencyMs: 1,
        p90Ms: 1,
        quality: {
          mean: 0.8,
          lower: 0.5,
          upper: 1,
          support: 500,
          level: "model_global",
          identity: "EXACT",
          provenance: ["public"],
          calibratedDomain: true,
        },
      },
    ],
    budgetUsd: 1,
    allowedRegret: 0.02,
    maxFalseAccept: 0.01,
  });
  assert.equal(p.abstention, true);
  assert.ok(p.plans[0]!.reasons.includes("false_accept"));
  assert.equal(p.plans[0]!.regretProbability, 0);
});
test("immutable registry blocks holdout reassignment and synthetic training", () => {
  const r = new EvidenceSplitRegistry();
  r.assign("s", "t", "FINAL_HOLDOUT");
  assert.equal(r.allowsTraining("s", "t"), false);
  assert.throws(() => r.assign("s", "t", "TRAIN"));
  r.assign("s", "s", "SYNTHETIC");
  assert.equal(r.allowsTraining("s", "s"), false);
});
test("artifact provenance, policy and data mutations are rejected", () => {
  const a = freezeEvidence(
    { x: 1 },
    {
      sourceDigests: { s: "hash" },
      modelMappingDigest: "m",
      taskVersion: 1,
      splitDigest: "split",
      estimatorVersion: "v",
      calibrationVersion: "v",
      policyDigest: "p",
      timestamp: "now",
      provenance: ["s"],
    },
  );
  assert.equal(validateEvidence(a).digest, a.digest);
  assert.throws(() => validateEvidence({ ...a, payload: { x: 2 } }));
  assert.throws(() => validateEvidence(a, { policyDigest: "other" }));
});
test("final evaluation claim is consumed before labels and cannot run twice", async () => {
  const root = await mkdtemp(join(tmpdir(), "holdout-"));
  try {
    await claimFinalEvaluation(join(root, "claim"), "artifact");
    await assert.rejects(claimFinalEvaluation(join(root, "claim"), "another"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("three estimator candidates fit only admissible source rows", () => {
  for (const kind of ["empirical", "logistic", "tree"] as const) {
    const a = fitContextualQuality(publicRows(), kind, "fixed");
    assert.ok(predictContextualQuality(a, task, "vendor/model-v1").mean > 0.5);
    assert.equal(
      predictContextualQuality(
        a,
        { ...task, harness: "koda" },
        "vendor/model-v1",
      ).calibratedDomain,
      false,
    );
    assert.equal(predictContextualQuality(a, task, "unknown/model").upper, 1);
  }
});
const models: CalibrationModel[] = Array.from({ length: 40 }, (_, i) => ({
  id: "vendor" + (i % 8) + "/model-" + i,
  provider: "vendor" + (i % 8),
  family: "family-" + i,
  inputPrice: i + 1,
  outputPrice: i + 1,
  context: 32000,
  output: 4000,
  parameters: ["tools", "tool_choice"],
}));
test("dynamic calibration selects 30 models across vendors without model-name ranking", () => {
  const selected = selectCalibrationModels(models, 30);
  assert.equal(selected.length, 30);
  assert.equal(new Set(selected.map((m) => m.provider)).size, 8);
  assert.equal(new Set(selected.map((m) => m.id)).size, 30);
  assert.equal(
    selectCalibrationModels(
      models.map((m) => ({ ...m, parameters: [] })),
      30,
    ).length,
    0,
  );
});
test("Stage A allowlist cannot receive labels, gold patches or hidden tests", () => {
  const a = runtimeCandidate({
    id: "a",
    repo: "r",
    commit: "c",
    patch: "candidate",
    task: "task",
    checks: [],
    proofClass: "generic",
    taskFamily: "debugging",
    correct: true,
    goldPatch: "secret",
    hiddenTests: "secret",
  });
  assert.ok(!("correct" in a));
  assert.ok(!("goldPatch" in a));
  assert.ok(!("hiddenTests" in a));
});
test("verifier rates count false accepts, false rejects and unresolved separately", () => {
  const r = verifierStatistics([
    { correct: false, decision: "accept" },
    { correct: false, decision: "reject" },
    { correct: true, decision: "reject" },
    { correct: true, decision: "unresolved" },
  ]);
  assert.equal(r.falseAccept.events, 1);
  assert.equal(r.detection.events, 1);
  assert.equal(r.falseReject.events, 1);
  assert.equal(r.unresolved, 1);
  assert.ok(r.falseAccept.upper > r.falseAccept.lower);
});
async function calibrationFiles(root: string) {
  await writeFile(join(root, "catalog.json"), JSON.stringify(models));
  await writeFile(join(root, "config.json"), "{}");
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({
      version: 1,
      tasks: [
        {
          id: "task",
          category: "debugging",
          split: "development",
          repo: "repo",
          commit: "a".repeat(40),
          task: "Repair task",
          writeScope: ["src"],
          oracleDirectory: "oracle",
          acceptance: { argv: ["node", "oracle.cjs"] },
          verification: [{ argv: ["node", "test.cjs"] }],
        },
      ],
    }),
  );
  return {
    manifest: join(root, "manifest.json"),
    config: join(root, "config.json"),
    catalog: join(root, "catalog.json"),
    output: join(root, "out"),
    models: "auto",
    maxModels: 30,
    tasks: 1,
    budgetUsd: 3,
    perAttemptBudgetUsd: 0.1,
    parallel: 2,
  };
}
test("calibration dry-run cannot call execution/provider even when a callback exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "calibration-"));
  try {
    const o = await calibrationFiles(root);
    const result = await runNativeCalibration(o, async () => {
      throw Error("Provider dispatch forbidden");
    });
    assert.equal(result.mode, "dry-run");
    assert.equal(result.runs, 30);
    assert.equal(result.maximumUsd, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("calibration rejects a matrix beyond the declared budget before dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "calibration-"));
  try {
    const o = await calibrationFiles(root);
    await assert.rejects(
      runNativeCalibration({ ...o, budgetUsd: 0.1 }),
      /exceeds/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("explicit calibration resumes without duplicate rows or dispatch and incremental probe touches one model", async () => {
  const root = await mkdtemp(join(tmpdir(), "calibration-"));
  try {
    const o = {
      ...(await calibrationFiles(root)),
      execute: true,
      maxModels: 2,
    };
    let calls = 0;
    const execute = async () => {
      calls++;
    };
    const paidAck = process.env.KODA_ALLOW_PAID_CALIBRATION;
    process.env.KODA_ALLOW_PAID_CALIBRATION = "1";
    await runNativeCalibration(o, execute);
    await runNativeCalibration({ ...o, resume: true }, execute);
    if (paidAck === undefined) delete process.env.KODA_ALLOW_PAID_CALIBRATION;
    else process.env.KODA_ALLOW_PAID_CALIBRATION = paidAck;
    assert.equal(calls, 2);
    assert.equal(
      (await readFile(join(o.output, "results.jsonl"), "utf8"))
        .trim()
        .split("\n").length,
      2,
    );
    const probe = await runNativeCalibration({
      ...o,
      execute: false,
      maxModels: 30,
      probe: models[0]!.id,
    });
    assert.equal(probe.runs, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("real verifier subprocess freezes Stage A before reading external label", async () => {
  const root = await mkdtemp(join(tmpdir(), "verifier-cal-"));
  try {
    const repo = join(root, "base");
    await mkdir(repo);
    await execa("git", ["init"], { cwd: repo });
    await execa("git", ["config", "user.email", "test@example.test"], {
      cwd: repo,
    });
    await execa("git", ["config", "user.name", "Test"], { cwd: repo });
    await writeFile(join(repo, "value.cjs"), "module.exports=1;\n");
    await writeFile(
      join(repo, "test.cjs"),
      "require('node:assert/strict').equal(require('./value.cjs'),2);\n",
    );
    await execa("git", ["add", "."], { cwd: repo });
    await execa("git", ["commit", "-m", "baseline"], { cwd: repo });
    const commit = (await execa("git", ["rev-parse", "HEAD"], { cwd: repo }))
      .stdout;
    await writeFile(join(repo, "value.cjs"), "module.exports=2;\n");
    const patch = (await execa("git", ["diff"], { cwd: repo })).stdout;
    const output = join(root, "cal");
    const result = await verifierStageA(
      {
        id: "candidate",
        repo,
        commit,
        patch,
        task: "value must be two",
        checks: ["node test.cjs"],
        proofChecks: ["node test.cjs"],
        proofClass: "runtime-requirement-test",
        taskFamily: "debugging",
      },
      output,
    );
    assert.equal(result.decision, "accept");
    const label = join(root, "label.json");
    await writeFile(label, JSON.stringify({ id: "candidate", correct: false }));
    const b = await verifierStageB(
      join(output, "candidate.stage-a.json"),
      label,
    );
    assert.equal(b.correct, false);
    assert.equal(verifierStatistics([b]).falseAccept.events, 1);
    assert.equal(b.stageADigest, result.digest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing verifier executable module is operational, not a failed candidate check", async () => {
  const { runtimeInfrastructureFailure } =
    await import("../src/verifier/verifier.js");
  assert.equal(
    runtimeInfrastructureFailure({
      command: "python3 -m pytest -q",
      exitCode: 1,
      stdout: "",
      stderr: "python3: No module named pytest",
      wallClockMs: 1,
      timedOut: false,
    }),
    "verification_tool_unavailable",
  );
  assert.equal(
    runtimeInfrastructureFailure({
      command: "python3 -m pytest -q",
      exitCode: 1,
      stdout: "AssertionError: wrong result",
      stderr: "",
      wallClockMs: 1,
      timedOut: false,
    }),
    undefined,
  );
});
test("native calibration accepts only revision-proven independently verified mutations and censors operational failure", async () => {
  const { nativeCalibrationObservation } =
    await import("../src/router/knowledge/nativeCalibrationAdapter.js");
  const row = {
    taskId: "t",
    models: ["a"],
    mutation: true,
    verified: true,
    groundTruthSolve: true,
    falseAccept: false,
    costComplete: true,
    costUsd: 0.01,
    wallClockMs: 10,
  } as any;
  const input = {
    task: { ...task, harness: "koda" },
    model: "a",
    servedRevision: "a-v1",
    provenance: "external-oracle",
    planDigest: "p",
  };
  assert.equal(
    nativeCalibrationObservation(row, input)?.proof?.independent,
    true,
  );
  assert.equal(
    nativeCalibrationObservation(row, { ...input, servedRevision: undefined }),
    undefined,
  );
  assert.equal(
    nativeCalibrationObservation({ ...row, verified: false }, input),
    undefined,
  );
  assert.equal(
    nativeCalibrationObservation(
      {
        ...row,
        verified: false,
        groundTruthSolve: false,
        failureAttribution: {
          primaryCause: "PROVIDER_FAILURE",
          learningDisposition: "CENSORED",
        },
      },
      input,
    ),
    undefined,
  );
});
test("sufficient same-harness Koda-native evidence overrides conflicting public evidence", () => {
  const source = publicRows().map((r) => ({
    ...r,
    model: "a",
    task: { ...r.task, harness: "koda" },
    success: true,
  }));
  const local = Array.from({ length: 1500 }, (_, i) => ({
    ...source[0]!,
    id: "native-" + i,
    taskId: "native-task-" + i,
    origin: "local" as const,
    split: "local" as const,
    success: false,
    outcome: "FAILED",
    identity: "EXACT" as const,
    attribution: {
      primaryCause: "MODEL_FAILURE",
      learningDisposition: "NEGATIVE_MODEL_EVIDENCE",
    },
  }));
  const a = fitContextualQuality([...source, ...local], "empirical", "frozen");
  assert.ok(
    predictContextualQuality(a, { ...task, harness: "koda" }, "a").mean < 0.2,
  );
});
test("explicit version relationship is weaker than exact identity and stronger provenance than family guessing", () => {
  const a = fitContextualQuality(publicRows(), "empirical", "fixed");
  const exact = predictContextualQuality(a, task, "vendor/model-v1");
  const transferred = predictContextualQuality(
    {
      ...a,
      versionTransfers: [
        {
          from: "vendor/model-v1",
          to: "vendor/model-v2",
          provenance: "publisher-release-mapping",
        },
      ],
    },
    task,
    "vendor/model-v2",
  );
  assert.ok(exact.support > 0);
  assert.equal(transferred.level, "version_transfer");
  assert.equal(transferred.upper, 1);
  assert.equal(transferred.lower, 0);
  assert.ok(transferred.support > 0);
  assert.equal(transferred.calibratedDomain, false);
});

test("a very long public issue is preserved rather than silently truncated by runtime TaskSpec bounds", () => {
  const text = "Repair this issue: `" + "a".repeat(15000) + "`";
  const rows = normalizePublicSubmission(
    [
      {
        id: "long-issue",
        text,
        repo: "owner/repo",
        baseCommit: "a".repeat(40),
      },
    ],
    {
      id: "source",
      model: "vendor/model",
      revision: "v1",
      harness: "agent",
      engine: "source-agent",
      resolved: [],
      unavailable: [],
      provenance: "public",
      timestamp: "2026-01-01",
    },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.task.text, text);
  assert.equal(rows[0]!.task.contract, undefined);
  assert.equal(rows[0]!.task.proof.strength, "unknown");
});
test("a final holdout cannot be reintroduced under another source name", () => {
  const registry = new EvidenceSplitRegistry();
  registry.assign("original", "same-task", "FINAL_HOLDOUT");
  assert.throws(() => registry.assign("renamed-source", "same-task", "TRAIN"));
});
test("unknown cost-only latency remains missing rather than a fabricated model quality prior", () => {
  const result = selectContextualPlan({
    task: {
      ...task,
      risks: {},
      proof: { strength: "strong", falseAcceptRisk: "low" },
    },
    candidates: [
      {
        model: "supported",
        engine: task.engine,
        compatible: true,
        costUsd: 0.01,
        latencyMs: Infinity,
        p90Ms: Infinity,
        quality: {
          mean: 0.99,
          lower: 0.98,
          upper: 1,
          support: 1000,
          level: "model_global",
          identity: "EXACT",
          provenance: ["measured"],
          calibratedDomain: true,
        },
      },
    ],
    budgetUsd: 1,
    allowedRegret: 0.02,
    maxFalseAccept: 0.01,
    verifier: {
      detectionLower: 0.99,
      detectionMean: 0.995,
      falseAcceptUpper: 0.001,
      provenance: "actual-calibration",
      costUsd: 0,
      latencyMs: 1,
    },
  });
  assert.deepEqual(result.selected?.models, ["supported"]);
  assert.equal(result.selected?.latencyMs, Infinity);
});

test("VNext actually selects a supported cheap-first plan with measured verification and real paired fixture outcomes", async () => {
  const { ContextualRouterVNext } =
    await import("../src/router/contextualRouterVNext.js");
  const base = publicRows()[0]!;
  const rows = Array.from({ length: 1000 }, (_, i) =>
    ["low-cost", "reference"].map((model) => ({
      ...base,
      id: model + ":" + i,
      taskId: "paired-task-" + i,
      model,
      revision: model,
      task,
      success: model === "low-cost" ? i % 20 !== 0 : i % 25 !== 0,
    })),
  ).flat();
  const router = new ContextualRouterVNext(
    fitContextualQuality(rows, "empirical", "frozen"),
  );
  const result = router.decide({
    task: {
      ...task,
      risks: {},
      proof: { strength: "strong", falseAcceptRisk: "low" },
    },
    models: [
      {
        id: "low-cost",
        compatible: true,
        inputPrice: 1,
        outputPrice: 1,
        latencyMs: 1,
        p90Ms: 2,
      },
      {
        id: "reference",
        compatible: true,
        inputPrice: 100,
        outputPrice: 100,
        latencyMs: 10,
        p90Ms: 20,
      },
    ],
    inputTokens: 100,
    outputTokens: 100,
    budgetUsd: 1,
    allowedRegret: 0.02,
    maxFalseAccept: 0.01,
    verifier: {
      detectionLower: 0.99,
      detectionMean: 0.995,
      detectionUpper: 1,
      falseAcceptUpper: 0.001,
      support: 10000,
      provenance: "fixture-measured-verification",
      costUsd: 0,
      latencyMs: 1,
    },
  });
  assert.equal(result.status, "SELECTED");
  assert.equal(result.selected?.models[0], "low-cost");
  assert.ok((result.selected?.regretProbability ?? 1) <= 0.05);
});

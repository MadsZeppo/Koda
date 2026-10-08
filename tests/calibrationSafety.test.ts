import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import { execa } from "execa";
import { CalibrationBudget } from "../src/dev/calibrationBudget.js";
import { calibrationTransport } from "../src/dev/calibrationTransport.js";
import {
  diverseModels,
  stratifiedTasks,
  makeCalibrationPlan,
} from "../src/dev/calibrationPlan.js";
import {
  runNativeCalibration,
  type CalibrationModel,
} from "../src/dev/nativeCalibration.js";
import {
  runtimeCandidate,
  verifierStageA,
  verifierStageB,
  verifierStatistics,
} from "../src/dev/verifierCalibration.js";
import { sampleCandidates, verifierPilot } from "../src/dev/verifierPilot.js";
import {
  resolveVerificationRuntime,
  verificationPreflight,
} from "../src/dev/verificationRuntime.js";
const model = (i: number): CalibrationModel => ({
  id: `author${i % 8}/model-${i}`,
  provider: `author${i % 8}`,
  family: `family${i % 12}`,
  inputPrice: i + 1,
  outputPrice: 2 * (i + 1),
  context: 65536,
  output: 4096,
  parameters: ["tools", "tool_choice", ...(i % 2 ? ["reasoning"] : [])],
});
const pool = Array.from({ length: 60 }, (_, i) => model(i));
const task = (i: number) => ({
  id: `task-${i}`,
  category: i % 2 ? "debugging" : "backend",
  split: "development",
  repo: "repo",
  commit: "a".repeat(40),
  task: `Repair existing behavior ${i}`,
  writeScope: ["src"],
  oracleDirectory: "oracle",
  acceptance: { argv: ["node", "oracle.cjs"] },
  verification: [{ argv: ["node", "--test"] }],
  language: i % 2 ? "python" : "javascript",
  complexity: i % 3 ? "medium" : "high",
  risk: i % 2 ? "low" : "high",
});
async function files(root: string) {
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({
      version: 1,
      tasks: Array.from({ length: 60 }, (_, i) => task(i)),
    }),
  );
  await writeFile(join(root, "catalog.json"), JSON.stringify(pool));
  await writeFile(join(root, "config.json"), "{}");
  return {
    manifest: join(root, "manifest.json"),
    config: join(root, "config.json"),
    catalog: join(root, "catalog.json"),
    output: join(root, "out"),
    models: "auto",
    maxModels: 24,
    tasks: 60,
    denseCoreTasks: 20,
    sparseModelsPerTask: 8,
    budgetUsd: 80,
    perAttemptBudgetUsd: 0.1,
    parallel: 4,
    seed: "fixed",
  };
}
async function fixture(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "koda-safe-calibration-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test("dynamic diverse pool covers 24 exact models, providers and price strata deterministically", () => {
  const a = diverseModels(pool, 24, "fixed"),
    b = diverseModels([...pool].reverse(), 24, "fixed");
  assert.equal(a.selected.length, 24);
  assert.deepEqual(a.selected, b.selected);
  assert.equal(new Set(a.selected.map((m) => m.provider)).size, 8);
  assert.ok(a.selected.some((m) => m.id === pool.at(-1)!.id));
  assert.ok(Object.values(a.reasons).every((r) => r.length));
});
for (const [reason, bad] of Object.entries({
  tools: { parameters: [] },
  context: { context: 100 },
  prices: { inputPrice: NaN },
  expired: { deprecated: true },
  endpoint: { endpointMode: "batch" },
  output: { outputModalities: ["image"] },
  unavailable: { available: false },
}))
  test(`eligibility filters ${reason} before experiment`, () =>
    assert.equal(diverseModels([{ ...model(0), ...bad }], 24).eligible, 0));
test("task strata are deterministic and final holdout cannot enter experiment", () => {
  const rows = Array.from({ length: 60 }, (_, i) => task(i));
  rows.push({ ...task(100), split: "holdout" });
  const a = stratifiedTasks(rows, 20, "seed"),
    b = stratifiedTasks([...rows].reverse(), 20, "seed");
  assert.deepEqual(a, b);
  assert.equal(a.length, 20);
  assert.ok(a.every((t) => t.split === "development"));
  assert.equal(new Set(a.map((t) => t.category)).size, 2);
  assert.throws(() => stratifiedTasks([...rows, rows[0]], 20, "seed"));
});
test("dense core creates paired overlap; sparse expansion yields 800 frozen cells and independent cost figures", async () =>
  fixture(async (root) => {
    const o = await files(root);
    const p = await makeCalibrationPlan(o, pool, "fixture", "digest");
    assert.equal(p.denseCoreCells, 480);
    assert.equal(p.sparseCells, 320);
    assert.equal(p.runs, 800);
    assert.equal(p.maximumUsd, 80);
    assert.notEqual(p.expectedUsd, p.maximumUsd);
    assert.equal(p.cells.filter((c) => c.taskId === p.tasks[0]!.id).length, 24);
    assert.ok(p.cells.every((c) => c.retries === 0 && c.attempts === 1));
    assert.equal(p.estimatedRuntimeMs, null);
    assert.equal(p.tasks.length, 60);
  }));
test("dry run freezes plan/snapshots and never invokes throwing provider", async () =>
  fixture(async (root) => {
    const o = await files(root);
    const p = await runNativeCalibration(o, async () => {
      throw Error("PAID CALL FORBIDDEN");
    });
    assert.equal(p.mode, "dry-run");
    for (const name of [
      "experiment.json",
      "model-snapshot.json",
      "task-snapshot.json",
      "plan.jsonl",
      "summary.json",
      "report.md",
    ])
      assert.ok((await readFile(join(o.output, name), "utf8")).length);
    assert.equal(p.paidCalls, 0);
  }));
test("execute without second opt-in fails before callback", async () =>
  fixture(async (root) => {
    const o = await files(root);
    const old = process.env.KODA_ALLOW_PAID_CALIBRATION;
    delete process.env.KODA_ALLOW_PAID_CALIBRATION;
    try {
      let calls = 0;
      await assert.rejects(
        runNativeCalibration({ ...o, execute: true }, async () => {
          calls++;
        }),
        /acknowledgement|KODA_ALLOW_PAID/,
      );
      assert.equal(calls, 0);
    } finally {
      if (old !== undefined) process.env.KODA_ALLOW_PAID_CALIBRATION = old;
    }
  }));
test("concurrent reservations cannot cross global cap, settlements reconcile, resume retains unknown spend", async () =>
  fixture(async (root) => {
    const path = join(root, "ledger");
    const b = await CalibrationBudget.load(path, 1, 1);
    const r = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        b.reserve(String(i), "cell" + i, 0.1),
      ),
    );
    assert.equal(r.filter((r) => r.status === "fulfilled").length, 10);
    assert.equal(b.snapshot().remainingUsd, 0);
    await b.settle("0", 0.01);
    assert.equal(b.snapshot().remainingUsd, 0.09);
    await assert.rejects(b.reserve("0", "cell0", 0.01), /already reserved/);
    const recovered = await CalibrationBudget.load(path, 1, 1);
    assert.equal(recovered.snapshot().exposureUsd, 0.91);
    assert.equal(recovered.snapshot().unresolved.length, 9);
    await assert.rejects(recovered.reserve("21", "next", 0.1), /BUDGET/);
  }));
test("per-cell cap includes multiple requests/retries; oversized actual charge cannot corrupt ledger", async () =>
  fixture(async (root) => {
    const path = join(root, "ledger");
    const b = await CalibrationBudget.load(path, 10, 0.1);
    await b.reserve("one", "cell", 0.07);
    await b.settle("one", 0.06);
    await assert.rejects(b.reserve("retry", "cell", 0.05), /BUDGET/);
    await b.reserve("two", "cell", 0.04);
    await assert.rejects(b.settle("two", 0.5), /exceeded/);
    const read = await CalibrationBudget.load(path, 10, 0.1);
    assert.equal(read.snapshot().exposureUsd, 0.1);
  }));
test("budget ledger rejects truncated/tampered crash records", async () =>
  fixture(async (root) => {
    const path = join(root, "ledger");
    await writeFile(path, '{"sequence":0}');
    await assert.rejects(CalibrationBudget.load(path, 1, 1), /Truncated/);
    await writeFile(path, '{"sequence":0}\n');
    await assert.rejects(CalibrationBudget.load(path, 1, 1), /integrity/);
  }));
test("bounded transport makes pre-call reservation, records provider, and censors cross-model fallback", async () =>
  fixture(async (root) => {
    let hits = 0;
    let served = "author0/model-0";
    const upstream = createServer(async (req, res) => {
      hits++;
      for await (const _ of req) {
      }
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          model: served,
          provider: "same-model-endpoint",
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.00001 },
        }),
      );
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const port = (upstream.address() as { port: number }).port;
    const ledger = await CalibrationBudget.load(join(root, "ledger"), 0.1, 0.1);
    const p = await calibrationTransport({
      model: model(0),
      cell: "cell",
      ledger,
      upstream: `http://127.0.0.1:${port}`,
    });
    try {
      const request = (m = "author0/model-0") =>
        fetch(p.url + "/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: m,
            messages: [{ role: "user", content: "task" }],
            max_tokens: 100,
          }),
        });
      assert.equal((await request()).status, 200);
      assert.equal(hits, 1);
      served = "different/model";
      assert.equal((await request()).status, 502);
      assert.equal(p.receipts.filter((r) => r.servedModel).length, 2);
      assert.equal((await request("wrong/model")).status, 502);
      assert.equal(hits, 2);
      assert.ok(ledger.snapshot().exposureUsd <= 0.1);
    } finally {
      await p.close();
      upstream.close();
    }
  }));
test("transport refuses request before upstream when budget cannot fit", async () =>
  fixture(async (root) => {
    const b = await CalibrationBudget.load(
      join(root, "ledger"),
      0.000000001,
      0.000000001,
    );
    const p = await calibrationTransport({
      model: model(0),
      cell: "cell",
      ledger: b,
      upstream: "http://127.0.0.1:1",
    });
    try {
      const r = await fetch(p.url + "/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: model(0).id,
          messages: [{ role: "user", content: "task" }],
          max_tokens: 100,
        }),
      });
      assert.equal(r.status, 502);
      assert.equal(b.snapshot().calls, 0);
    } finally {
      await p.close();
    }
  }));
test("runtime selection uses repo virtualenv or explicit container, never pytest default", async () =>
  fixture(async (root) => {
    await mkdir(join(root, ".venv/bin"), { recursive: true });
    await writeFile(join(root, ".venv/bin/python"), "fixture");
    assert.equal((await resolveVerificationRuntime(root)).kind, "repository");
    const selected = await resolveVerificationRuntime(root, {
      kind: "container",
      image: "missing/task:image",
    });
    assert.equal(selected.kind, "container");
    const p = await verificationPreflight({
      repo: root,
      commit: "a".repeat(40),
      runtime: selected,
    });
    assert.equal(p.usable, false);
    assert.ok(
      p.items.some(
        (i) => i.name === "task environment/image" && i.status === "BLOCKED",
      ),
    );
  }));
test("infra/unknown unresolved rows never enter verifier rate denominators", () => {
  const s = verifierStatistics([
    { correct: false, decision: "unresolved" },
    { correct: true, decision: "unresolved" },
    { correct: false, decision: "accept" },
    { correct: false, decision: "reject" },
    { correct: true, decision: "accept" },
    { correct: true, decision: "reject" },
  ]);
  assert.equal(s.candidates, 6);
  assert.equal(s.evaluable, 4);
  assert.equal(s.wrong, 2);
  assert.equal(s.correct, 2);
  assert.equal(s.falseAccept.events, 1);
  assert.equal(s.falseReject.events, 1);
  assert.equal(s.infraUnresolved, 2);
});
test("sampling is deterministic, diverse and excludes final holdout", () => {
  const entries = Array.from({ length: 10 }, (_, i) => ({
    id: String(i),
    role: (i === 9 ? "FINAL_HOLDOUT" : "CALIBRATION") as
      "FINAL_HOLDOUT" | "CALIBRATION",
    runtime: "r",
    truth: "t",
    family: i % 2 ? "backend" : "debugging",
  }));
  assert.deepEqual(
    sampleCandidates(entries, 6, "seed"),
    sampleCandidates([...entries].reverse(), 6, "seed"),
  );
  assert.ok(
    sampleCandidates(entries, 6, "seed").every(
      (e) => e.role !== "FINAL_HOLDOUT",
    ),
  );
});
test("Stage A rejects hidden fields and patch-specific cache collision, freezes before external label, pilot resumes", async () =>
  fixture(async (root) => {
    const repo = join(root, "repo");
    await mkdir(repo);
    await writeFile(join(repo, "value.cjs"), "module.exports = 1;\n");
    await writeFile(
      join(repo, "check.cjs"),
      "if(require('./value.cjs')!==2) process.exit(1);\n",
    );
    await execa("git", ["init"], { cwd: repo });
    await execa("git", ["add", "."], { cwd: repo });
    await execa(
      "git",
      [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@localhost",
        "commit",
        "-m",
        "base",
      ],
      { cwd: repo },
    );
    const commit = (await execa("git", ["rev-parse", "HEAD"], { cwd: repo }))
      .stdout;
    const c = runtimeCandidate({
      id: "candidate",
      repo,
      commit,
      task: "Set value to two",
      patch:
        "diff --git a/value.cjs b/value.cjs\n--- a/value.cjs\n+++ b/value.cjs\n@@ -1 +1 @@\n-module.exports = 1;\n+module.exports = 2;\n",
      checks: ["node check.cjs"],
      proofChecks: ["node check.cjs"],
      proofClass: "behavior",
      taskFamily: "small-edit",
      goldPatch: "SECRET",
      correct: false,
    });
    assert.ok(!("goldPatch" in c));
    const out = join(root, "output");
    const a = await verifierStageA(c, out);
    assert.equal(a.decision, "accept");
    await assert.rejects(
      verifierStageA({ ...c, patch: c.patch.replace("= 2", "= 3") }, out),
      /mismatch/,
    );
    await writeFile(
      join(root, "label.json"),
      JSON.stringify({ id: c.id, correct: false }),
    );
    const b = await verifierStageB(
      join(out, "candidate.stage-a.json"),
      join(root, "label.json"),
    );
    assert.equal(b.correct, false);
    assert.equal(verifierStatistics([b]).falseAccept.events, 1);
    await writeFile(join(root, "runtime.json"), JSON.stringify(c));
    await writeFile(
      join(root, "source.json"),
      JSON.stringify({
        candidates: [
          {
            id: c.id,
            role: "CALIBRATION",
            runtime: "runtime.json",
            truth: "label.json",
            family: "small-edit",
          },
        ],
      }),
    );
    const p = {
      source: join(root, "source.json"),
      output: join(root, "pilot"),
      maxCandidates: 1,
      seed: "seed",
    };
    await verifierPilot(p);
    assert.deepEqual(
      ((await verifierPilot({ ...p, resume: true })) as any).statistics
        .evaluable,
      1,
    );
  }));

test("unknown prices and composite model identities are excluded without inventing costs", () => {
  for (const patch of [
    { inputPrice: undefined },
    { outputPrice: Infinity },
    { identityKind: "composite" },
    { id: "~vendor/router" },
  ])
    assert.equal(
      diverseModels([{ ...model(0), ...patch } as CalibrationModel], 24)
        .eligible,
      0,
    );
});
test("a calibration cell cannot contain a cross-model rescue or second coding attempt", async () => {
  const { benchmarkPlan, configureBenchmarkRouting, calibrationExecutionPlan } =
    await import("../src/dev/realBenchmarkWorker.js");
  const cfg: any = {
    forceModel: model(0).id,
    specialistRouting: false,
    adaptiveCoding: false,
    registry: { SCOUT_MODEL: "other", CHEAP_CODER_A: "other" },
    maxTokens: 10000,
    maxOutputTokens: 2000,
    stageMaxMinutes: 1,
    modelPool: {
      models: [
        {
          id: model(0).id,
          tier: "strong",
          qualityPrior: 0.99,
          fallback: { supportedParameters: ["tools", "tool_choice"] },
        },
      ],
    },
  };
  configureBenchmarkRouting(cfg, "calibration:" + model(0).id);
  assert.equal(
    cfg.forceModel,
    undefined,
    "forced-model bypass must not suppress the frozen plan selector",
  );
  assert.equal(cfg.specialistRouting, true);
  assert.equal(cfg.adaptiveCoding, true);
  assert.deepEqual(Object.values(cfg.registry), [model(0).id, model(0).id]);
  const assigned = calibrationExecutionPlan(
    cfg,
    "calibration:" + model(0).id,
    {} as any,
    0.1,
  );
  cfg.modelPool.models[0].qualityPrior = 0.01;
  assert.deepEqual(
    calibrationExecutionPlan(cfg, "calibration:" + model(0).id, {} as any, 0.1),
    assigned,
  );
  assert.equal(assigned.evidenceClass, "UNKNOWN");
  assert.equal(assigned.executionEngine, "agentic");
  assert.equal(assigned.maxCodingAttempts, 1);
  const candidate: any = {
    model: { id: model(0).id, tier: "strong" },
    metadata: { available: true },
    conservativeQuality: 0.5,
    quality: 0.5,
  };
  const base: any = {
    id: "base",
    taskFingerprint: {},
    qualityClass: "HIGH",
    requiredQuality: 0.9,
    verificationStrength: "strong",
    approvedCandidateSet: [candidate],
    activeBoard: [],
    referenceModel: "other",
    initialModel: "other",
    totalBudgetUsd: 1,
    latencyBudgetMs: 10000,
    maxCodingAttempts: 3,
    maxScoutCalls: 2,
    providerConstraints: {},
    writeScopes: ["."],
    verificationContract: {},
    stopConditions: [],
    evaluatedCandidates: [candidate],
    qualityCascadeModelIds: ["other"],
    operationalRecoveryModelIds: ["other"],
  };
  const plan = benchmarkPlan(base, "calibration:" + candidate.model.id, null);
  assert.equal(plan.initialModel, candidate.model.id);
  assert.equal(plan.executionEngine, "agentic");
  assert.equal(plan.maxCodingAttempts, 1);
  assert.deepEqual(plan.qualityCascadeModelIds, []);
  assert.deepEqual(plan.operationalRecoveryModelIds, []);
});
test("provider 429 and 5xx are operational receipts, never model-quality outcomes", async () =>
  fixture(async (root) => {
    for (const status of [429, 500]) {
      const server = createServer(async (req, res) => {
        for await (const _ of req) {
        }
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "provider unavailable" } }));
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const b = await CalibrationBudget.load(
        join(root, `ledger-${status}`),
        1,
        1,
      );
      const p = await calibrationTransport({
        model: model(0),
        cell: "cell",
        ledger: b,
        upstream: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      });
      try {
        const r = await fetch(p.url + "/v1/chat/completions", {
          method: "POST",
          body: JSON.stringify({
            model: model(0).id,
            max_tokens: 100,
            messages: [{ role: "user", content: "task" }],
          }),
        });
        assert.equal(r.status, status);
        assert.ok(p.receipts[0]!.operational);
        assert.ok(b.snapshot().exposureUsd > 0);
      } finally {
        await p.close();
        server.close();
      }
    }
  }));
test("completed calibration cells resume once, crash reservations remain interrupted and unbilled twice", async () =>
  fixture(async (root) => {
    const old = process.env.KODA_ALLOW_PAID_CALIBRATION;
    process.env.KODA_ALLOW_PAID_CALIBRATION = "1";
    try {
      const o = {
        ...(await files(root)),
        tasks: 1,
        maxModels: 1,
        execute: true,
      };
      let calls = 0;
      await runNativeCalibration(o, async () => {
        calls++;
      });
      await runNativeCalibration({ ...o, resume: true }, async () => {
        calls++;
      });
      assert.equal(calls, 1);
      const state = JSON.parse(
        await readFile(join(o.output, "state.json"), "utf8"),
      );
      state.completed = [];
      state.statuses[state.reserved[0]] = "RUNNING";
      await writeFile(join(o.output, "state.json"), JSON.stringify(state));
      const resumed = await runNativeCalibration(
        { ...o, resume: true },
        async () => {
          throw Error("Duplicate provider dispatch");
        },
      );
      assert.equal(resumed.mode, "executed");
      assert.equal(calls, 1);
      assert.ok(
        (await readFile(join(o.output, "results.jsonl"), "utf8"))
          .split("\n")
          .filter(Boolean).length === 1,
      );
    } finally {
      if (old === undefined) delete process.env.KODA_ALLOW_PAID_CALIBRATION;
      else process.env.KODA_ALLOW_PAID_CALIBRATION = old;
    }
  }));
test("relocated calibration config loads its frozen inline pool without a source modelsFile", async () =>
  fixture(async (root) => {
    const old = process.env.KODA_ALLOW_PAID_CALIBRATION;
    process.env.KODA_ALLOW_PAID_CALIBRATION = "1";
    try {
      const o = {
        ...(await files(root)),
        tasks: 1,
        maxModels: 1,
        execute: true,
      };
      await writeFile(
        o.config,
        JSON.stringify({ modelsFile: "missing-source-pool.json" }),
      );
      const { config } = await import("../src/config.js");
      let checked = false;
      await runNativeCalibration(o, async (options) => {
        const raw = JSON.parse(await readFile(options.config, "utf8"));
        assert.equal(raw.modelsFile, undefined);
        const loaded = await config(options.config);
        assert.equal(loaded.modelPool?.models.length, 1);
        assert.equal(
          loaded.modelPool?.models[0]?.id,
          raw.modelPool.models[0].id,
        );
        checked = true;
      });
      assert.equal(checked, true);
    } finally {
      if (old === undefined) delete process.env.KODA_ALLOW_PAID_CALIBRATION;
      else process.env.KODA_ALLOW_PAID_CALIBRATION = old;
    }
  }));
test("history/gold/oracle artifacts are absent from the actual isolated calibration worker checkout", async () =>
  fixture(async (root) => {
    const { runRealBenchmark } = await import("../src/dev/realBenchmark.js");
    const repo = join(root, "source"),
      oracle = join(root, "oracle");
    await mkdir(repo);
    await mkdir(oracle);
    await writeFile(join(repo, "value.cjs"), "module.exports = 1;\n");
    await execa("git", ["init"], { cwd: repo });
    await execa("git", ["add", "."], { cwd: repo });
    await execa(
      "git",
      [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@localhost",
        "commit",
        "-m",
        "base",
      ],
      { cwd: repo },
    );
    const commit = (await execa("git", ["rev-parse", "HEAD"], { cwd: repo }))
      .stdout;
    await writeFile(join(repo, "gold.txt"), "SECRET GOLD");
    await execa("git", ["add", "."], { cwd: repo });
    await execa(
      "git",
      [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@localhost",
        "commit",
        "-m",
        "gold answer",
      ],
      { cwd: repo },
    );
    await writeFile(
      join(oracle, "check.cjs"),
      "const fs=require('node:fs');process.exit(fs.readFileSync(process.argv[2]+'/value.cjs','utf8').includes('= 2')?0:1);\n",
    );
    const manifest = {
      version: 1,
      tasks: [
        {
          ...task(0),
          repo,
          commit,
          writeScope: ["value.cjs"],
          oracleDirectory: oracle,
          acceptance: { argv: ["node", "check.cjs"] },
          verification: [{ argv: ["node", "-e", "process.exit(0)"] }],
        },
      ],
    };
    await writeFile(join(root, "manifest"), JSON.stringify(manifest));
    await writeFile(join(root, "config"), "{}");
    await writeFile(join(root, "priors"), '{"priors":[]}');
    let calls = 0;
    await runRealBenchmark({
      manifest: join(root, "manifest"),
      config: join(root, "config"),
      priors: join(root, "priors"),
      budgetUsd: 1,
      split: "development",
      selectedArms: ["calibration:" + model(0).id],
      output: join(root, "benchmark"),
      execute: async (job) => {
        calls++;
        await assert.rejects(readFile(join(job.repo, "gold.txt")));
        assert.equal(
          (
            await execa("git", ["rev-list", "--all", "--count"], {
              cwd: job.repo,
            })
          ).stdout,
          "1",
        );
        await assert.rejects(readFile(join(job.repo, "oracle", "check.cjs")));
        await writeFile(join(job.repo, "value.cjs"), "module.exports = 2;\n");
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    assert.equal(calls, 1);
  }));

test("multiple completions, ambiguous output limits and unpriced plugins never dispatch", async () =>
  fixture(async (root) => {
    const b = await CalibrationBudget.load(join(root, "ledger"), 1, 1);
    const p = await calibrationTransport({
      model: model(0),
      cell: "cell",
      ledger: b,
      upstream: "http://127.0.0.1:1",
    });
    try {
      for (const extra of [
        { n: 2 },
        { max_completion_tokens: 1000 },
        { plugins: [{ id: "web" }] },
        { tools: [{ type: "web_search" }] },
        {
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: { url: "https://example.com/image" },
                },
              ],
            },
          ],
        },
      ]) {
        const r = await fetch(p.url + "/v1/chat/completions", {
          method: "POST",
          body: JSON.stringify({
            model: model(0).id,
            max_tokens: 100,
            messages: [{ role: "user", content: "task" }],
            ...extra,
          }),
        });
        assert.equal(r.status, 502);
      }
      assert.equal(b.snapshot().calls, 0);
    } finally {
      await p.close();
    }
  }));

test("integration fixture counts cannot become empirical verifier calibration even at large support", async () => {
  const { measuredVerifier } =
    await import("../src/dev/verifierCalibration.js");
  const rows = Array.from({ length: 80 }, (_, i) => ({
    correct: i % 2 === 0,
    decision: (i % 2 === 0 ? "accept" : "reject") as "accept" | "reject",
    taskFamily: "debugging",
    proofClass: "behavior",
    stageADigest: String(i),
    latencyMs: 10,
    origin: "integration_fixture",
  }));
  assert.equal(measuredVerifier(rows, "debugging", "behavior", 0), undefined);
});

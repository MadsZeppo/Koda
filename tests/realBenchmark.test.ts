import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import {
  realBenchmarkSchema,
  comparisonReport,
  runRealBenchmark,
  benchmarkChangedPaths,
  benchmarkTsxLoader,
  type BenchmarkRow,
} from "../src/dev/realBenchmark.js";
import { benchmarkPlan, configureFixedBenchmarkModel } from "../src/dev/realBenchmarkWorker.js";
test("benchmark TS runtime loads from Koda in a target repo without node_modules", async () => {
  const repo = await mkdtemp(join(tmpdir(), "koda-runtime-loader-"));
  try {
    assert.ok(benchmarkTsxLoader.startsWith("file:"));
    const result = await execa(
      process.execPath,
      [
        "--import",
        benchmarkTsxLoader,
        "--input-type=module",
        "-e",
        "console.log('runtime-loaded')",
      ],
      { cwd: repo },
    );
    assert.equal(result.stdout, "runtime-loaded");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
const task = {
  id: "issue-1",
  category: "debugging",
  split: "development",
  repo: "/real/repo",
  commit: "a".repeat(40),
  task: "Fix bug",
  writeScope: ["src"],
  oracleDirectory: "/external/oracle",
  acceptance: { argv: ["node", "check.mjs"] },
  verification: [{ argv: ["npm", "test"] }],
};
test("requires pinned real repository and independent executable checks", () => {
  assert.ok(
    realBenchmarkSchema.safeParse({ version: 1, tasks: [task] }).success,
  );
  for (const changes of [
    { commit: "main" },
    { verification: [] },
    { acceptance: {} },
    { writeScope: ["../user"] },
  ])
    assert.equal(
      realBenchmarkSchema.safeParse({
        version: 1,
        tasks: [{ ...task, ...changes }],
      }).success,
      false,
    );
});
test("evaluation and holdout cannot reuse a task ID", () =>
  assert.equal(
    realBenchmarkSchema.safeParse({
      version: 1,
      tasks: [task, { ...task, split: "holdout" }],
    }).success,
    false,
  ));
test("supports 40 real tasks across all categories with separate holdout", () => {
  const categories = [
    "small-edit",
    "debugging",
    "backend",
    "frontend-ui",
    "refactor",
    "security",
    "architecture",
  ];
  assert.ok(
    realBenchmarkSchema.safeParse({
      version: 1,
      tasks: Array.from({ length: 40 }, (_, i) => ({
        ...task,
        id: `issue-${i}`,
        category: categories[i % 7],
        split: i < 30 ? "development" : "holdout",
      })),
    }).success,
  );
});
function row(arm: string, changes: Partial<BenchmarkRow> = {}): BenchmarkRow {
  return {
    taskId: "issue-1",
    category: "debugging",
    arm,
    status: "VERIFIED_SUCCESS",
    verified: true,
    oraclePass: true,
    falseAccept: false,
    mutation: true,
    models: [],
    attempts: [],
    costUsd: 1,
    costComplete: true,
    costBasis: "provider",
    tokens: 1,
    wallClockMs: 100,
    failureAttribution: null,
    referenceCalls: 1,
    reservationUsd: 1,
    ...changes,
  };
}
test("false verified successes are excluded from solve rate", () => {
  const report = comparisonReport(
    [row("routing-v1", { falseAccept: true, oraclePass: false })],
    4,
  );
  assert.equal(report.arms["routing-v1"]!.verifiedSolves, 0);
  assert.equal(report.arms["routing-v1"]!.criticalFalseAccepts, 1);
  assert.equal(report.complete, false);
});
test("unknown costs and oracle checks remain unknown rather than zero", () => {
  const report = comparisonReport(
    [row("codex", { costUsd: null, costComplete: false, oraclePass: null })],
    4,
  );
  assert.equal(report.arms.codex!.costPerVerifiedSolve, null);
  assert.equal(report.arms.codex!.unknownAcceptance, 1);
});
test("paired regret requires all four arms and actual accepted results", () => {
  assert.equal(comparisonReport([row("routing-v1")], 4).pairedRegret.length, 0);
  const report = comparisonReport(
    [
      row("routing-v1", { costUsd: 3 }),
      row("strongest", { costUsd: 4 }),
      row("cheapest", { costUsd: 1, oraclePass: false }),
      row("codex", { costUsd: 2 }),
    ],
    4,
  );
  assert.equal(report.pairedRegret[0]!.costRegretVsOracleUsd, 1);
});
test("paid runs cannot begin without explicit budget", async () => {
  await assert.rejects(
    runRealBenchmark({
      manifest: "missing",
      priors: "missing",
      output: "missing",
      config: "missing",
      split: "development",
      budgetUsd: 0,
    }),
    /budget/,
  );
});
test("Routing V1 abstention never silently runs production routing", () => {
  assert.throws(
    () =>
      benchmarkPlan({ evaluatedCandidates: [] } as any, "routing-v1", {
        selected: null,
      }),
    /abstained/,
  );
});
test("benchmark plan freezes only selected compatible models", () => {
  const candidate = (
    id: string,
    cost: number,
    quality: number,
    hardRejection?: string,
  ) => ({
    model: { id },
    metadata: {},
    expectedAttemptCost: cost,
    conservativeQuality: quality,
    quality,
    hardRejection,
  });
  const base: any = {
    id: "route",
    initialModel: "old",
    approvedCandidateSet: [],
    qualityCascadeModelIds: [],
    activeBoard: [],
    writeScopes: [],
    stopConditions: [],
    evaluatedCandidates: [
      candidate("cheap", 1, 0.7),
      candidate("strong", 3, 0.95),
      candidate("broken", 0.1, 1, "protocol"),
    ],
  };
  assert.equal(benchmarkPlan(base, "cheapest", null).initialModel, "cheap");
  assert.equal(benchmarkPlan(base, "strongest", null).initialModel, "strong");
  const selected = benchmarkPlan(base, "routing-v1", {
    reference: "strong",
    selected: { models: ["cheap", "strong"], finalLower: 0.9 },
  });
  assert.deepEqual(selected.qualityCascadeModelIds, ["strong"]);
  assert.equal(base.initialModel, "old");
  assert.ok(Object.isFrozen(selected));
});

test('fixed-model control is isolated to explicit benchmark config and pins every role',()=>{
 const cfg:any={modelPool:{models:[{id:'cheap'},{id:'strong'}]},routing:{authority:'openrouter-auto'},registry:{CODER:'cheap',REVIEWER:'cheap'}};
 const original=structuredClone(cfg);configureFixedBenchmarkModel(cfg);assert.deepEqual(cfg,original);
 configureFixedBenchmarkModel(cfg,'strong');assert.equal(cfg.forceModel,'strong');assert.deepEqual(cfg.modelPool.models,[{id:'strong'}]);assert.ok(Object.values(cfg.registry).every(m=>m==='strong'));
 assert.throws(()=>configureFixedBenchmarkModel(original,'missing'),/not configured/);
});

test("benchmark mutation detection works from snapshots when a container temporarily hides Git",()=>{
 const before:any={files:{"src/a.py":{hash:"old",mode:0o644,size:3},"src/gone.py":{hash:"gone",mode:0o644,size:4}},fileCount:2,totalBytes:7};
 const after:any={files:{"src/a.py":{hash:"new",mode:0o644,size:3},"src/new.py":{hash:"new",mode:0o644,size:3}},fileCount:2,totalBytes:6};
 assert.deepEqual(benchmarkChangedPaths(before,after),["src/a.py","src/gone.py","src/new.py"]);
});

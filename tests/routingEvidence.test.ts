import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { buildKnowledgeSnapshot, ingestEvidenceSource, pairwiseOutcomes,
  repriceTokens, resolveSourceIdentities, type EvidenceSourceInput } from "../src/router/knowledge/ingest.js";
import { RoutingKnowledgeStore } from "../src/router/knowledge/store.js";
import { syncRoutingEvidence } from "../src/router/knowledge/sync.js";
import { CODEROUTER_MODELS_URL, CODEROUTER_RESULTS_URL, SWE_REBENCH_TREE_URL,
  codeRouterSource, currentPricingFromState, prepareCodeRouterBench, prepareSWERebench,
  sweRebenchRecord } from "../src/router/knowledge/bootstrap.js";
import { routingEvidenceReport } from "../src/router/knowledge/report.js";

const paired: EvidenceSourceInput = { id: "coderouter-fixture", type: "paired_task_model",
  version: "fixture-1", harness: "same deterministic harness", records: [
    { taskKey: "t1", taskFamily: "localized_bugfix", externalModelName: "Candidate exact",
      canonicalModelId: "vendor/candidate", identityLevel: "EXACT", success: false,
      inputTokens: 100, outputTokens: 20 },
    { taskKey: "t1", taskFamily: "localized_bugfix", externalModelName: "Reference exact",
      canonicalModelId: "vendor/reference", identityLevel: "EXACT", success: true,
      inputTokens: 200, outputTokens: 30 },
    { taskKey: "t2", taskFamily: "localized_bugfix", externalModelName: "Candidate exact",
      canonicalModelId: "vendor/candidate", identityLevel: "EXACT", success: true },
    { taskKey: "t2", taskFamily: "localized_bugfix", externalModelName: "Reference exact",
      canonicalModelId: "vendor/reference", identityLevel: "EXACT", success: true },
    { taskKey: "t3", taskFamily: "localized_bugfix", externalModelName: "Candidate exact",
      canonicalModelId: "vendor/candidate", identityLevel: "EXACT", success: false },
    { taskKey: "t3", taskFamily: "localized_bugfix", externalModelName: "Reference exact",
      canonicalModelId: "vendor/reference", identityLevel: "EXACT", success: false },
  ] };

test("source types cannot smuggle task-distribution or adoption data into quality evidence", () => {
  const distribution = ingestEvidenceSource({ id: "tasks", type: "task_distribution",
    records: [{ taskFamily: "debugging", canonicalModelId: "vendor/model",
      identityLevel: "EXACT", success: true }] }, "2026-09-24");
  const market = ingestEvidenceSource({ id: "market", type: "market_adoption_signal",
    records: [{ canonicalModelId: "vendor/model", identityLevel: "EXACT", marketShare: .8,
      benchmarkScore: .99, success: true }] }, "2026-09-24");
  assert.deepEqual(distribution.observations.map((row) => row.category), ["task_distribution"]);
  assert.deepEqual(market.observations.map((row) => row.category), ["market_signal"]);
  assert.equal([...distribution.observations, ...market.observations]
    .some((row) => ["result_at_1", "success_rate"].includes(row.metric)), false);
});

test("exact identity attaches, family transfer remains explicit, and unknown does not attach", () => {
  const snapshot = buildKnowledgeSnapshot([{ id: "identity", type: "benchmark_prior", records: [
    { externalModelName: "Exact", canonicalModelId: "vendor/exact", identityLevel: "EXACT", benchmarkScore: .8 },
    { externalModelName: "Family", canonicalModelId: "vendor/family", identityLevel: "FAMILY_TRANSFER", benchmarkScore: .8 },
    { externalModelName: "Unknown latest", canonicalModelId: "vendor/wrong", identityLevel: "UNKNOWN", benchmarkScore: .99 },
  ] }], "2026-09-24T00:00:00Z");
  const store = new RoutingKnowledgeStore(snapshot);
  assert.equal(store.forModel("vendor/exact").observations[0]?.identityLevel, "EXACT");
  assert.equal(store.forModel("vendor/family").observations[0]?.identityLevel, "FAMILY_TRANSFER");
  assert.equal(store.forModel("vendor/wrong").observations.length, 0);
  assert.equal(store.unmapped().some((row) => row.displayModel === "Unknown latest"), true);
});

test("catalog reconciliation never promotes basename-only evidence to exact identity", () => {
  const resolved = resolveSourceIdentities({ id: "source", type: "benchmark_prior", records: [
    { externalModelName: "vendor/model-a", identityLevel: "UNKNOWN", benchmarkScore: .8 },
    { externalModelName: "model-b", identityLevel: "UNKNOWN", benchmarkScore: .7 },
    { externalModelName: "ambiguous", identityLevel: "UNKNOWN", benchmarkScore: .6 },
  ] }, [{ id: "vendor/model-a" }, { id: "vendor/model-b" },
    { id: "one/ambiguous" }, { id: "two/ambiguous" }]);
  assert.equal(resolved.records[0]?.identityLevel, "EXACT");
  assert.equal(resolved.records[1]?.identityLevel, "FAMILY_TRANSFER");
  assert.equal(resolved.records[2]?.identityLevel, "UNKNOWN");
});

test("paired same-task outcomes retain overlap and conditional-recovery counts", () => {
  const [pair] = pairwiseOutcomes(paired.id, paired.records);
  assert.deepEqual(pair, { sourceId: paired.id, candidateModelId: "vendor/candidate",
    referenceModelId: "vendor/reference", taskFamily: "localized_bugfix",
    bothSucceed: 1, candidateOnly: 0, referenceOnly: 1, bothFail: 1,
    sampleSize: 3, identityLevel: "EXACT" });
});

test("current repricing requires exact identity and preserves cached-input economics", () => {
  assert.equal(repriceTokens({ identityLevel: "EXACT", inputTokens: 1000,
    cachedTokens: 800, outputTokens: 100 },
  { inputPrice: 2, cachedInputPrice: .5, outputPrice: 10 }), .0018);
  assert.equal(repriceTokens({ identityLevel: "FAMILY_TRANSFER", inputTokens: 1000,
    outputTokens: 100 }, { inputPrice: 2, outputPrice: 10 }), null);
});

test("offline sync is atomic, accepts partial sources, and preserves last-known-good on total failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "koda-evidence-sync-"));
  const good = join(dir, "good.json"), missing = join(dir, "missing.json"),
    output = join(dir, "routing-knowledge-v2.json");
  try {
    await writeFile(good, JSON.stringify(paired));
    const snapshot = await syncRoutingEvidence([good, missing], output, fetch,
      "2026-09-24T00:00:00Z");
    assert.equal(snapshot.sources?.some((source) => source.status === "failed"), true);
    const before = await readFile(output, "utf8");
    await assert.rejects(syncRoutingEvidence([missing], output, fetch,
      "2026-09-25T00:00:00Z"), /last-known-good snapshot preserved/);
    assert.equal(await readFile(output, "utf8"), before);
    const store = new RoutingKnowledgeStore(undefined, dir);
    assert.equal(store.snapshot.snapshotId, snapshot.snapshotId);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("CodeRouterBench preparation uses explicit canonical identity and never guesses display names", () => {
  const csv = [
    "task_id,dimension,model,score,cost_usd,input_tokens,output_tokens,total_tokens,latency_ms",
    "t1,bug_fix,model-a,1,0.01,100,20,120,500",
    "t1,bug_fix,unmapped-latest,0,0.02,110,30,140,600",
  ].join("\n");
  const source = codeRouterSource(csv, { models: [
    { model: "model-a", canonical_openrouter_id: "vendor/model-a" },
    { model: "unmapped-latest", provider: "Vendor" },
  ] }, "2026-09-24T00:00:00Z");
  assert.equal(source.records[0]?.canonicalModelId, "vendor/model-a");
  assert.equal(source.records[0]?.identityLevel, "EXACT");
  assert.equal(source.records[1]?.canonicalModelId, undefined);
  assert.equal(source.records[1]?.identityLevel, "UNKNOWN");
  assert.deepEqual(source.records.map((row) => row.success), [true, false]);
  assert.equal(sweRebenchRecord({ participant: { name: "display/name" } }).identityLevel,
    "UNKNOWN", "a slash in a display name is not authoritative identity");
});

test("CodeRouterBench downloader uses the official compact artifacts and writes atomically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "koda-coderouter-evidence-"));
  const output = join(dir, "coderouterbench.json");
  const requested: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input); requested.push(url);
    if (url === CODEROUTER_RESULTS_URL) return new Response(
      "task_id,dimension,model,score\nt1,bug_fix,vendor/model-a,1\n", { status: 200 });
    if (url === CODEROUTER_MODELS_URL) return new Response(JSON.stringify({ models: [] }), { status: 200 });
    throw Error(`unexpected fixture URL ${url}`);
  }) as typeof fetch;
  try {
    const result = await prepareCodeRouterBench(output, fetcher, "2026-09-24T00:00:00Z");
    assert.equal(result.records, 1);
    assert.deepEqual(requested.sort(), [CODEROUTER_MODELS_URL, CODEROUTER_RESULTS_URL].sort());
    assert.equal(JSON.parse(await readFile(output, "utf8")).records[0].identityLevel, "EXACT");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("SWE-rebench preparation reads official gzip shards with mocked network and preserves exact IDs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "koda-swe-evidence-"));
  const output = join(dir, "swe-rebench.json");
  const trajectory = { instance_id: "task-1", language: "python",
    participant: { openrouter_model_id: "vendor/model-a", reasoning_effort: "high" },
    evaluation: { resolved: true }, usage: { input_tokens: 1000, output_tokens: 200,
      cached_tokens: 400, cost_usd: .01 }, run: { duration_ms: 1200 },
    events: [{ role: "assistant" }, { role: "tool" }, { role: "assistant" }] };
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === SWE_REBENCH_TREE_URL) return new Response(JSON.stringify([
      { path: "trajectories/vendor/run_0.jsonl.gz" }, { path: "README.md" },
    ]), { status: 200 });
    if (url.endsWith("trajectories/vendor/run_0.jsonl.gz"))
      return new Response(gzipSync(JSON.stringify(trajectory) + "\n"), { status: 200 });
    throw Error(`unexpected fixture URL ${url}`);
  }) as typeof fetch;
  try {
    const prepared = await prepareSWERebench(output, fetcher, "2026-09-24T00:00:00Z");
    assert.equal(prepared.records, 1);
    const source = JSON.parse(await readFile(output, "utf8"));
    assert.equal(source.records[0].canonicalModelId, "vendor/model-a");
    assert.equal(source.records[0].identityLevel, "EXACT");
    assert.equal(source.records[0].totalTokens, 1200);
    assert.equal(source.records[0].turns, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("real bootstrap artifacts build a repriced snapshot and a local evidence report", async () => {
  const dir = await mkdtemp(join(tmpdir(), "koda-bootstrap-report-"));
  const code = join(dir, "code.json"), swe = join(dir, "swe.json");
  const output = join(dir, "routing-knowledge-v2.json");
  const csv = ["task_id,dimension,model,score,input_tokens,output_tokens",
    "t1,bug_fix,vendor/model-a,1,1000,100",
    "t1,bug_fix,vendor/model-b,0,900,90"].join("\n");
  try {
    await writeFile(code, JSON.stringify(codeRouterSource(csv, {}, "2026-09-24T00:00:00Z")));
    await writeFile(swe, JSON.stringify({ id: "swe", type: "agentic_economics",
      records: [sweRebenchRecord({ instance_id: "s1", participant: {
        openrouter_model_id: "vendor/model-a" }, evaluation: { resolved: true },
      usage: { input_tokens: 500, output_tokens: 50 } })] }));
    await writeFile(join(dir, "specialist-metadata.json"), JSON.stringify({
      retrievedAt: 123, models: [{ id: "vendor/model-a",
        pricing: { prompt: "0.000002", completion: "0.000010" } }], benchmarks: [] }));
    await writeFile(join(dir, "catalog.json"), JSON.stringify({ retrievedAt: 123,
      entries: [["vendor/model-a", { inputPrice: 2, outputPrice: 10 }]] }));
    const pricing = await currentPricingFromState(dir);
    const snapshot = await syncRoutingEvidence([code, swe], output, fetch,
      "2026-09-24T00:00:00Z", pricing);
    assert.equal(snapshot.sources?.length, 2);
    assert.equal(snapshot.pairwiseEvidence?.[0]?.referenceOnly, 0);
    assert.ok(snapshot.observations.some((row) => row.metric === "current_repriced_cost_usd"));
    const report = await routingEvidenceReport(dir);
    assert.equal(report.snapshotId, snapshot.snapshotId);
    assert.equal(report.catalog.pricedConfiguredModels, 1);
    assert.ok(report.identities.EXACT > 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

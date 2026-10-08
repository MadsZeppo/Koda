import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { runFakeSmoke } from "../src/dev/fakeSmoke.js";
import { fakeSmokeFixtures } from "../src/dev/fakeSmokeFixtures.js";
import { startFakeProvider } from "../src/dev/fakeProvider.js";

for (const [name, fixture] of Object.entries(fakeSmokeFixtures)) {
  test(`real CLI with local fake provider: ${name}`, async (t) => {
    const result = await runFakeSmoke(name);
    t.after(() => rm(result.parent, { recursive: true, force: true }));
    assert.equal(result.summary.status === "VERIFIED_SUCCESS", fixture.success, JSON.stringify(result.summary));
    assert.equal(result.child.exitCode === 0, fixture.success, result.child.stderr);
    assert.equal(result.summary.synthetic, true);
    assert.equal(result.transcript.externalCalls, 0);
    assert.ok(result.transcript.requests.length > 0);
    assert.ok(result.events.every((event) => event.synthetic === true));
    assert.ok(result.transcript.requests.every((request: any) => request.payload.model === "koda-test/scripted"));
    assert.equal(result.events.some((event) => event.type === "specialist_outcome" || event.type === "efficiency_observation"), false);
    await assert.rejects(access(join(result.output, "synthetic-routing")), "No model history/catalog should be created");
    for (const [path, original] of Object.entries(fixture.files))
      assert.equal(await readFile(join(result.repo, path), "utf8"), original, "Smoke candidates must not auto-apply");
    if (fixture.success) {
      assert.ok(result.summary.candidateProduced, "Success requires actual mutation");
      assert.ok(result.events.some((event) => event.type === "coding_worker_start"));
      assert.ok(result.events.some((event) => event.type === "completion_review" && event.passed));
      assert.ok(result.events.some((event) => event.type === "final_verification" && event.kind === "test" && event.outcome === "CHECK_PASS"));
      assert.ok(result.events.some((event) => event.type === "final_verification" && event.kind === "typecheck" && event.outcome === "CHECK_PASS"));
    }
    if (name === "create") await assert.rejects(access(join(result.repo, "src/value.cjs")));
    if (name === "multi") {
      assert.ok(result.events.some((event) => event.type === "tool" && event.name === "read_file" && event.path === "tests/value.test.cjs"));
      assert.ok(result.events.some((event) => event.type === "tool_result" && String(event.result).includes("placeholder")));
      assert.ok(result.events.some((event) => event.type === "coding_handoff"));
      assert.equal(await readFile(join(result.summary.integration.path, "src/value.cjs"), "utf8"), "exports.value=2;\n");
      assert.match(await readFile(join(result.summary.integration.path, "tests/value.test.cjs"), "utf8"), /a.equal/);
    }
    if (name === "progressive") {
      const actions = result.events.filter((event) => event.type === "tool").map((event) => event.name);
      for (const action of ["search_code", "list_files", "read_file", "edit_file"]) assert.ok(actions.includes(action), `Missing ${action}`);
    }
    if (name === "repair") {
      assert.ok(result.events.some((event) => event.type === "completion_continuation"));
      assert.equal(result.events.filter((event) => event.type === "completion_review").length, 2);
      assert.equal(await readFile(join(result.summary.integration.path, "src/value.cjs"), "utf8"), "exports.value=3;\n");
    }
    if (name === "review-failure") {
      assert.equal(result.events.some((event) => event.type === "final_verification" || event.type === "verification_repair"), false);
      assert.equal(result.events.some((event) => event.type === "completion_review_failure"), true);
    }
    if (name === "malformed-review" || name === "review-failure" || name === "review-tool-failure") {
      const reviews = result.transcript.requests.filter((request: any) => request.stage === "review");
      assert.equal(reviews.length, 2);
      assert.equal(reviews[0].payload.tool_choice, "required");
      assert.equal(reviews[1].payload.tool_choice, undefined,
        "structured retry must avoid the tool protocol that can fail upstream");
      assert.equal(reviews[1].payload.tools, undefined);
      assert.equal(result.events.some((event) => event.type === "completion_continuation" || event.type === "completion_repair_scope_expanded"), false);
      assert.ok(result.events.some((event) => event.type === "completion_review_protocol_retry"));
    }
    if (name === "provider-failure" || name === "token-preflight") {
      assert.ok(result.events.some((event) => event.type === "model_attempt" && event.verification === "OPERATIONAL_FAILURE"));
      assert.equal(result.summary.candidateProduced, false);
    }
    if (name === "regression") {
      assert.equal(result.summary.status, "FAILED");
      assert.ok(result.summary.candidateProduced, "Rejected changes must remain inspectable");
      assert.ok(result.events.some((event) => (event.type === "verification" || event.type === "final_verification") && event.outcome === "CHECK_FAIL"));
    }
  });
}

test("dev provider is rejected before any work in production or unset mode", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "koda-fake-guard-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  for (const mode of ["production", ""]) {
    const output = join(parent, `report-${mode || "unset"}`);
    const child = await execa(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "dev-run",
      "--repo", parent, "--task", "Create a file", "--script", join(parent, "missing.json"), "--output", output],
    { env: { NODE_ENV: mode, OPENROUTER_API_KEY: "" }, reject: false });
    assert.equal(child.exitCode, 1);
    assert.match(child.stderr, /requires NODE_ENV=test or NODE_ENV=development/);
    await assert.rejects(access(output));
  }
});

test("fake transport serves scripted JSON, output limits and fails closed on unscripted calls", async () => {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  const provider = await startFakeProvider({ steps: [
    { stage: "worker", json: { example: true } },
    { stage: "worker", failure: "output_limit", content: "partial" },
  ] });
  try {
    const call = () => fetch(`${provider.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "koda-test/scripted", messages: [{ role: "system", content: "Coding worker" }], max_tokens: 128 }) });
    const first = await (await call()).json() as any;
    assert.equal(first.choices[0].message.content, '{"example":true}');
    const limited = await (await call()).json() as any;
    assert.equal(limited.choices[0].finish_reason, "length");
    assert.equal(limited.usage.completion_tokens, 128);
    assert.equal((await call()).status, 400);
    assert.deepEqual(provider.unusedSteps(), []);
  } finally { await provider.close(); if (original === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = original; }
});

test("implicit homepage text task runs real CLI with zero agentic exploration and verified apply", async (t) => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "koda-tiny-home-"));
  t.after(() => rm(root, {recursive:true,force:true}));
  await mkdir(join(root,"src/app"), {recursive:true});
  await mkdir(join(root,"tests"));
  await writeFile(join(root,"package.json"), JSON.stringify({type:"module",scripts:{test:"node --test tests/*.test.js",typecheck:"node --check src/app/page.js"}}));
  await writeFile(join(root,"src/app/page.js"), "export const page='<button data-href=\"/start\">Old label</button>';\n");
  await writeFile(join(root,"tests/page.test.js"), "import {test} from 'node:test';import a from 'node:assert/strict';import {page} from '../src/app/page.js';test('primary button',()=>{a.match(page,/>New label</);a.match(page,/data-href=\"\\/start\"/)});\n");
  const script = join(root,"script.json");
  await writeFile(script, JSON.stringify({steps:[
    {stage:"worker",toolCalls:[{name:"read_file",arguments:{path:"src/app/page.js"}}]},
    {stage:"worker",toolCalls:[{name:"edit_file",arguments:{path:"src/app/page.js",oldText:"Old label",newText:"New label"}}]},
    {stage:"worker",content:"Implementation complete"},
    {stage:"review",review:{passed:true,evidence:"Changed label; actual focused button assertion and syntax check pass; link preserved"}},
  ]}));
  const cli=fileURLToPath(new URL("../src/cli.ts",import.meta.url));
  const child=await execa(process.execPath,["--import","tsx",cli,"dev-run","--repo",root,
    "--task","On the homepage change the primary button text to 'New label'. Preserve its link and design.",
    "--script",script,"--output",join(root,"report"),"--apply"],
    {env:{NODE_ENV:"test",OPENROUTER_API_KEY:""},reject:false,timeout:60000});
  const summary=JSON.parse(await readFile(join(root,"report/summary.json"),"utf8"));
  assert.equal(child.exitCode,0,child.stderr+child.stdout);
  assert.equal(summary.status,"VERIFIED_SUCCESS");
  assert.equal(summary.applyResult,"applied");
  assert.match(await readFile(join(root,"src/app/page.js"),"utf8"),/>New label</);
  const events=(await readFile(join(root,"report/events.jsonl"),"utf8")).trim().split("\n").map(line=>JSON.parse(line));
  assert.equal(events.some(event=>event.type==="repo_exploration_start"),false);
  assert.ok(events.some(event=>event.type==="repo_exploration_finish" && event.model_calls===0));
  assert.ok(events.some(event=>event.type==="execution_strategy" && event.execution_effort==="tiny"));
  assert.equal(events.some(event=>event.type==="verification_repair"),false);
  assert.ok(events.some(event=>event.type==="final_verification" && event.kind==="test" && event.outcome==="CHECK_PASS"));
});

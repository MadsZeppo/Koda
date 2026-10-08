import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundedMap, runCodingSuite } from "../src/dev/codingSuite.js";
import {
  codingScenarios,
  scenarioFixture,
} from "../src/dev/codingSuiteFixtures.js";
import { expertCodingScenarios } from "../src/dev/expertCodingSuiteFixtures.js";
import { hardCodingScenarios } from "../src/dev/hardCodingSuiteFixtures.js";
import { runInNewContext } from "node:vm";

test("hard suite has thirty explicit contracts and correct independent reference cases", () => {
  assert.equal(hardCodingScenarios.length, 30);
  assert.equal(new Set(hardCodingScenarios.map(s => s.id)).size, 30);
  for (const s of hardCodingScenarios) {
    assert.match(s.requirement, /^fn\(/);
    assert.equal(s.addTests, true);
    const fixture = scenarioFixture(s);
    assert.ok(!fixture.task.includes(s.implementation));
    runInNewContext(fixture.acceptance, {
      require: (name: string) => name === "node:assert/strict" ? {
        deepEqual: (a: unknown, b: unknown) => assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b))),
      } : runInNewContext(`(${s.implementation})`, { URLSearchParams }),
      process: { argv: ["", "candidate"] }, structuredClone,
    });
  }
});

test("hard suite exercises thirty CLI mutations with verified apply and independent acceptance", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "koda-hard-suite-test-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const result = await runCodingSuite({ mode: "fake", suite: "hard", output: join(parent, "suite"), concurrency: 4 });
  assert.equal(result.failed, 0, JSON.stringify(result.results.filter(r => !r.passed)));
  assert.equal(result.passed, 30);
  assert.equal(result.costUsd, 0);
});

test("suite schedules bounded parallel work and retains input ordering", async () => {
  let active = 0,
    peak = 0;
  const results = await boundedMap([1, 2, 3, 4, 5], 2, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return n * 2;
  });
  assert.equal(peak, 2);
  assert.deepEqual(results, [2, 4, 6, 8, 10]);
  await assert.rejects(
    boundedMap([1], 0, async (n) => n),
    /parallel/,
  );
});
test("suite contains thirty unique independent behavior oracles", () => {
  assert.equal(codingScenarios.length, 30);
  assert.equal(new Set(codingScenarios.map((s) => s.id)).size, 30);
  for (const s of codingScenarios) {
    const fixture = scenarioFixture(s);
    assert.ok(fixture.acceptance.includes("deepEqual"));
    assert.ok(
      !Object.keys(fixture.files).some((path) => path.includes("acceptance")),
    );
  }
});
test("live suite rejects missing spending budget before creating fixtures or dispatching", async () => {
  await assert.rejects(
    runCodingSuite({
      mode: "live",
      output: "/tmp/koda-live-must-not-start",
      concurrency: 4,
    }),
    /budget-usd/,
  );
});
test("thirty fake tasks use actual CLI, verified apply, independent acceptance and isolated repos", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "koda-suite-test-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const output = join(parent, "suite");
  const result = await runCodingSuite({ mode: "fake", output, concurrency: 4 });
  assert.equal(
    result.failed,
    0,
    JSON.stringify(result.results.filter((r) => !r.passed)),
  );
  assert.equal(result.passed, 30);
  assert.equal(result.costUsd, 0);
  assert.ok(result.results.every((r) => r.apply === "applied"));
  const report = JSON.parse(
    await readFile(join(output, "suite-summary.json"), "utf8"),
  );
  assert.equal(report.scenarioCount, 30);
});

 test("expert suite has thirty new contracts with independently checked reference behavior", () => {
  assert.equal(expertCodingScenarios.length, 30);
  assert.equal(new Set(expertCodingScenarios.map(s => s.id)).size, 30);
  for (const s of expertCodingScenarios) {
    assert.ok(![...codingScenarios,...hardCodingScenarios].some(old => old.id === s.id));
    assert.equal(s.addTests, true);
    const fixture = scenarioFixture(s);
    assert.ok(!fixture.task.includes(s.implementation));
    runInNewContext(fixture.acceptance, {
      require: (name: string) => name === "node:assert/strict" ? {
        deepEqual: (a: unknown, b: unknown) => assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), s.id),
      } : runInNewContext(`(${s.implementation})`, { structuredClone }),
      process: { argv: ["", "candidate"] }, structuredClone,
    });
  }
});
 test("expert suite runs thirty isolated CLI tasks with verified apply", async t => {
  const parent=await mkdtemp(join(tmpdir(),"koda-expert-suite-test-"));
  t.after(()=>rm(parent,{recursive:true,force:true}));
  const result=await runCodingSuite({mode:"fake",suite:"expert",output:join(parent,"suite"),concurrency:4});
  assert.equal(result.failed,0,JSON.stringify(result.results.filter(r=>!r.passed)));
  assert.equal(result.passed,30);
  assert.equal(result.costUsd,0);
  assert.ok(result.results.every(r=>r.apply==="applied"));
});

test('public fixture contract rejects wrong return shape without exposing value oracle',()=>{
 const fixture=scenarioFixture({id:'public-contract',requirement:'Return the total value.',implementation:'xs=>xs.reduce((n,x)=>n+x,0)',cases:[[[[2,5]],7]],create:true});
 assert.match(fixture.task,/Return type: number/);
 assert.ok(!fixture.task.includes('reduce'));
 const contract=fixture.files['tests/public-contract.test.cjs']!;
 assert.ok(!contract.includes('deepEqual'));
 const evaluate=(implementation:string)=>runInNewContext(contract,{
  require:(name:string)=>name==='node:test'?{test:(_name:string,fn:()=>void)=>fn()}:name==='node:assert/strict'?assert:runInNewContext(`(${implementation})`),
 });
 assert.throws(()=>evaluate('xs=>xs'),/unexpected return shape: array/);
 evaluate('xs=>xs.reduce((n,x)=>n+x,0)');
});

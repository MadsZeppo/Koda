import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stressCodingScenarios } from "../src/dev/stressCodingSuiteFixtures.js";
import { scenarioFixture } from "../src/dev/codingSuiteFixtures.js";
import { runCodingSuite } from "../src/dev/codingSuite.js";

test("stress suite has thirty integrated contracts with independent behavior and invalid-operation oracles", () => {
  assert.equal(stressCodingScenarios.length, 30);
  assert.equal(new Set(stressCodingScenarios.map(s => s.id)).size, 30);
  for (const s of stressCodingScenarios) {
    assert.ok(s.cases.length >= 10, s.id);
    assert.ok(s.requirement.length > 2000, s.id);
    const fixture = scenarioFixture(s);
    assert.ok(!fixture.task.includes(s.implementation));
    assert.ok(!Object.keys(fixture.files).some(p => p.includes("acceptance")));
    const fn = runInNewContext(`(${s.implementation})`, { structuredClone, RangeError });
    const normalize = (x: unknown) => JSON.parse(JSON.stringify(x));
    runInNewContext(fixture.acceptance, {
      require: (name: string) => name === "node:assert/strict" ? {
        deepEqual: (a: unknown, b: unknown) => assert.deepEqual(normalize(a), normalize(b), s.id),
        throws: (f: () => unknown) => assert.throws(f, RangeError),
      } : fn,
      process: { argv: ["", "candidate"] }, structuredClone, RangeError,
    });
    // Mutations in a correct function must never leak between invocations.
    const [args, expected] = s.cases[1]!;
    assert.deepEqual(normalize(fn(...structuredClone(args))), expected, s.id);
    assert.deepEqual(normalize(fn(...structuredClone(args))), expected, s.id);
  }
});

test("thirty stress workflows pass real CLI verification, apply and independent acceptance without credits", async t => {
  const root = await mkdtemp(join(tmpdir(), "koda-stress-suite-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await runCodingSuite({ mode: "fake", suite: "stress", output: join(root, "suite"), concurrency: 4 });
  assert.equal(result.failed, 0, JSON.stringify(result.results.filter(r => !r.passed)));
  assert.equal(result.passed, 30);
  assert.equal(result.costUsd, 0);
  assert.ok(result.results.every(r => r.status === "VERIFIED_SUCCESS" && r.apply === "applied"));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { routingBaselinePreflight, stableNoChangePreflight } from "../src/agent/stableNoChangePreflight.js";
import { profileRepo } from "../src/repo/profiler.js";

for (const hasRunner of [true, false]) {
  test(`a passing structural baseline cannot prove test-only completion (${hasRunner ? "failing test" : "missing runner"})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "koda-proof-baseline-"));
    try {
      await mkdir(join(root, "tests"));
      await writeFile(join(root, "tests/route.test.cjs"),
        "const {test}=require('node:test');const assert=require('node:assert/strict');" +
        "const route=()=>({selected_model:'cheap',expected_completion_cost_usd:0.2});" +
        "test('route telemetry',()=>{const event=route();assert.equal(event.selected_model,'expensive');assert.equal(event.expected_completion_cost_usd,0.2);});\n");
      await writeFile(join(root, "package.json"), JSON.stringify({ scripts: {
        typecheck: 'node -e "process.exit(0)"',
        ...(hasRunner ? { test: "node --test tests/route.test.cjs" } : {}),
      } }));
      const profile = await profileRepo(root);
      const baseline = await routingBaselinePreflight(root, profile, [], () => 5_000);
      assert.equal(baseline.status, "VERIFIED_SUCCESS");
      assert.equal(baseline.checks[0]?.kind, "typecheck");
      const proof = await stableNoChangePreflight(root,
        "Add a deterministic unit test that verifies route telemetry includes the selected model and expected completion cost.",
        profile, () => 5_000, undefined, baseline, ["tests/route.test.cjs"]);
      assert.equal(proof.satisfied, false);
      if (hasRunner) assert.ok(proof.verification.checks.some((check) =>
        check.kind === "test" && check.outcome === "CHECK_FAIL"));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("routing preflight skips a full suite without a focused test target", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-routing-preflight-"));
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "tests"));
    await writeFile(join(root, "src/value.cjs"), "module.exports = 1;\n");
    await writeFile(join(root, "tests/value.test.cjs"),
      "const { test } = require('node:test'); test('value', () => {});\n");
    await writeFile(join(root, "package.json"), JSON.stringify({
      scripts: {
        test: "node --test tests/*.test.cjs",
        typecheck: "node --check src/value.cjs",
      },
    }));
    const profile = await profileRepo(root);

    assert.equal(
      profile.verificationCommands.some((command) =>
        /(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\s*$/.test(command.trim()),
      ),
      false,
      "aggregate package test suites must not be copied into planning/pre-coding commands",
    );
    assert.ok(
      profile.verificationCommands.some((command) =>
        command.includes("typecheck"),
      ),
      "non-test repository checks stay available before coding",
    );
    assert.ok(
      profile.ecosystem?.projectUnits.some((unit) =>
        unit.verification.some((candidate) =>
          candidate.kind === "test" &&
          /(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\s*$/.test(candidate.command.trim()),
        ),
      ),
      "aggregate test suite remains available to post-mutation/final verification",
    );

    const broad = await routingBaselinePreflight(
      root,
      profile,
      [],
      () => 5_000,
    );
    assert.equal(broad.checks.length, 1);
    assert.match(broad.checks[0]!.command, /typecheck/);

    const focused = await routingBaselinePreflight(
      root,
      profile,
      ["tests/value.test.cjs"],
      () => 5_000,
    );
    assert.equal(focused.checks.length, 1);
    assert.match(focused.checks[0]!.command, /tests\/value\.test\.cjs/);

    const attempted: string[] = [];
    const missing = await routingBaselinePreflight(
      root,
      profile,
      ["tests/new.test.cjs"],
      () => 5_000,
      (check) => attempted.push(check.command),
    );
    assert.equal(missing.checks.length, 1);
    assert.match(missing.checks[0]!.command, /typecheck/);
    assert.equal(attempted.some((command) => /new\.test\.cjs/.test(command)), false,
      "a candidate-only test path must not execute against the baseline");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

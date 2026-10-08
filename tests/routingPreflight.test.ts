import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { canDeferRoutingBaseline, routingBaselinePreflight, stableNoChangePreflight } from "../src/agent/stableNoChangePreflight.js";
import type { RepositoryExploration } from "../src/agent/openHandsExplorer.js";
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

test("high-confidence bounded mutations defer redundant structural baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-deferred-preflight-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/theme.css"), "body { color: black }\n");
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: {
      typecheck: 'node -e "process.exit(0)"',
    } }));
    const profile = await profileRepo(root);
    const localized: RepositoryExploration = {
      confidence: "high",
      editableCandidates: [{ path: "src/theme.css", reason: "proved local target" }],
      readonlyFiles: [], relatedTests: [], dependencies: [], evidence: [], unresolvedQuestions: [],
    };
    assert.equal(canDeferRoutingBaseline("Make all pages on the site black", profile, localized, {
      execution_strategy: "direct", execution_effort: "normal", strategy_reason: "localized",
      likelyFiles: ["src/theme.css"], preciseTarget: "src/theme.css",
    }), true);
    assert.equal(canDeferRoutingBaseline("Add a unit test", profile, {
      ...localized, relatedTests: ["tests/theme.test.ts"],
    }, {
      execution_strategy: "direct", execution_effort: "normal", strategy_reason: "localized",
      likelyFiles: ["src/theme.css"], preciseTarget: "src/theme.css",
    }), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Auto can defer a bounded new-source baseline without accepting unknown/test scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-auto-preflight-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({scripts:{typecheck:'node -e "process.exit(0)"'}}));
    const profile = await profileRepo(root);
    const exploration: RepositoryExploration = {confidence:"high",editableCandidates:[{path:"src/new.ts",reason:"explicit new source"}],readonlyFiles:[],relatedTests:[],dependencies:[],evidence:[],unresolvedQuestions:[]};
    const strategy = {execution_strategy:"direct" as const,execution_effort:"normal" as const,strategy_reason:"explicit local target",likelyFiles:["src/new.ts"]};
    assert.equal(canDeferRoutingBaseline("Implement src/new.ts",profile,exploration,strategy),false);
    assert.equal(canDeferRoutingBaseline("Implement src/new.ts",profile,exploration,strategy,true),true);
    assert.equal(canDeferRoutingBaseline("Implement src/new.ts",profile,{...exploration,confidence:"low"},strategy,true),false);
    assert.equal(canDeferRoutingBaseline("Add a unit test",profile,exploration,strategy,true),false);
    assert.equal(canDeferRoutingBaseline("Implement",profile,{...exploration,editableCandidates:[{path:".",reason:"unknown"}]},strategy,true),false);
  } finally {await rm(root,{recursive:true,force:true});}
});

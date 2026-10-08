import { test } from "node:test";
import assert from "node:assert/strict";
import { comparisonScenarios, codexArguments, reportedModel } from "../src/dev/codexComparison.js";
import { stressCodingScenarios } from "../src/dev/stressCodingSuiteFixtures.js";
import { codexCost } from "../src/dev/codexCost.js";
test("comparison uses identical ten stress contracts and scoped noninteractive Codex execution", () => {
  assert.deepEqual(comparisonScenarios, stressCodingScenarios.slice(0, 10));
  assert.equal(comparisonScenarios.length, 10);
  const args = codexArguments("/tmp/project with spaces");
  assert.ok(args.includes("workspace-write"));
  assert.equal(args[args.indexOf("--cd") + 1], "/tmp/project with spaces");
  assert.equal(args.at(-1), "-");
  assert.ok(!args.some(a => a.includes("bypass")));
});
test("Codex estimate discounts cached input and does not double count reasoning or cache writes", () => {
  const line = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 400, cache_write_input_tokens: 100, output_tokens: 200, reasoning_output_tokens: 150 } });
  const result = codexCost(line, "gpt-6.1-sol");
  assert.equal(result.costUsd, .00329);
  assert.equal(result.tokens.output, 200);
  assert.equal(result.costComplete, true);
  assert.equal(result.actualSubscriptionChargeUsd, null);
  assert.deepEqual(codexArguments("/tmp/repo", "gpt-6.1-sol").slice(0,3), ["exec", "--model", "gpt-6.1-sol"]);
});
test("Codex estimates aggregate all completed turns including failed candidates", () => {
  const line = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 } });
  const result = codexCost(`${line}\n${line}`, "gpt-6.1-sol");
  assert.equal(result.turns, 2);
  assert.equal(result.tokens.input, 200);
  assert.equal(result.costUsd, .0008);
});
test("unknown or interrupted Codex usage never masquerades as zero complete cost", () => {
  assert.equal(codexCost("", "gpt-6.1-sol").costUsd, null);
  assert.equal(codexCost("garbage", "gpt-6.1-sol").costComplete, false);
  const line = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 } });
  assert.equal(codexCost(line, "unknown-model").costUsd, null);
  assert.equal(codexCost(line, "gpt-6.1-sol", false).costComplete, false);
  assert.equal(codexCost(line + '\n{"type":"turn.failed"}', "gpt-6.1-sol").costComplete, false);
});
test("invalid usage is rejected rather than clamped to a plausible cost", () => {
  for (const usage of [{input_tokens:10,cached_input_tokens:11,output_tokens:2}, {input_tokens:-1,cached_input_tokens:0,output_tokens:2}]) {
    const r = codexCost(JSON.stringify({type:"turn.completed",usage}), "gpt-6.1-sol");
    assert.equal(r.costUsd, null);
    assert.equal(r.costComplete, false);
  }
});

test("default Codex selection is preserved and missing model metadata is never guessed", () => {
  assert.ok(!codexArguments("/tmp/repo").includes("--model"));
  assert.equal(reportedModel('{"type":"turn.completed","usage":{}}'), "unknown-default");
  assert.equal(reportedModel('{"type":"turn.started","model":"gpt-6-luna"}'), "gpt-6-luna");
  assert.equal(reportedModel('{"type":"turn.started","model":"a"}\n{"type":"turn.started","model":"b"}'), "unknown-default");
});

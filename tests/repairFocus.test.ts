import { test } from "node:test";
import assert from "node:assert/strict";
import { focusedRepairCommand, newFailureIds, prepareRepairChecks } from "../src/verifier/repairFocus.js";
import { repairSourceContext } from "../src/agent/repairSourceContext.js";
import type { CommandResult } from "../src/types.js";
const check = (stdout: string, command = "pytest -p no:cacheprovider"): CommandResult => ({
  command, stdout, stderr: "", outcome: "CHECK_FAIL", exitCode: 1, wallClockMs: 1, timedOut: false,
});
test("repair selects only new pytest failures and replaces broad collection paths", () => {
  const baseline = check("FAILED tests/checks.py::test_old - network\n");
  const candidate = check(baseline.stdout + "FAILED tests/checks.py::test_new - assertion\n");
  assert.deepEqual(newFailureIds(candidate, [baseline]), ["tests/checks.py::test_new"]);
  assert.equal(focusedRepairCommand(candidate, [baseline]),
    "pytest -p no:cacheprovider -q 'tests/checks.py::test_new'");
  const broad = check(candidate.stdout, "python3 -B -m pytest .");
  assert.equal(focusedRepairCommand(broad, [{ ...baseline, command: broad.command }]),
    "python3 -B -m pytest -p no:cacheprovider -q 'tests/checks.py::test_new'");
  assert.equal(focusedRepairCommand(baseline, [baseline]), undefined);
});
test("repair selector rejects untrusted shell and traversal identities", () => {
  for (const identity of ["../escape.py::test_x", "/escape.py::test_x", "tests/x.py::test_x;evil"])
    assert.equal(focusedRepairCommand(check(`FAILED ${identity} - fail`), []), undefined);
  assert.equal(focusedRepairCommand(check("FAILED tests/x.py::test_x - fail", "pytest; evil"), []), undefined);
});
test("repair refreshes bounded current source around the changed region, not the prefix", () => {
  const source = Array.from({ length: 700 }, (_, i) => `line_${i}`).join("\n");
  const context = repairSourceContext(source, "src/logic.py",
    "--- baseline/src/logic.py\n+++ candidate/src/logic.py\n@@ -390 +390 @@\n", [], 2000);
  assert.match(context, /line_400/);
  assert.doesNotMatch(context, /line_0\n/);
  assert.ok(Buffer.byteLength(context) <= 2000);
  assert.match(repairSourceContext(source, "src/logic.py", "", [check("src/logic.py:500: AssertionError")], 2000), /line_500/);
});

test("repair executes its focused check and hands off fresh diagnostics, never relabelled broad output", async () => {
  const baseline = check("FAILED tests/checks.py::test_old - network\n");
  const candidate = check(baseline.stdout + "FAILED tests/checks.py::test_new - assertion\n");
  let calls = 0;
  const [result] = await prepareRepairChecks([candidate], [baseline], async (command) => {
    calls++;
    assert.equal(command, "pytest -p no:cacheprovider -q 'tests/checks.py::test_new'");
    return check("fresh isolated assertion diagnostic", command);
  });
  assert.equal(calls, 1);
  assert.equal(result!.stdout, "fresh isolated assertion diagnostic");
  assert.doesNotMatch(result!.stdout, /network/);
  assert.deepEqual(await prepareRepairChecks([candidate], [baseline], async (command) =>
    ({ ...check("passed", command), outcome: "CHECK_PASS" })), [candidate]);
  await assert.rejects(prepareRepairChecks([candidate], [baseline], async (command) =>
    ({ ...check("sandbox failed", command), outcome: "INFRA_FAILURE" })), /infrastructure/);
});

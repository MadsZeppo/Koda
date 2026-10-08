import type { FakeScript } from "./fakeProvider.js";
const tools = (...calls: [string, Record<string, unknown>][]): FakeScript["steps"][number] => ({ stage: "worker", toolCalls: calls.map(([name, args]) => ({ name, arguments: args })) });
const read = tools(["read_file", { path: "src/value.cjs" }]);
const edit = (before: number, after: number) => tools(["edit_file", { path: "src/value.cjs", oldText: `value=${before}`, newText: `value=${after}` }]);
const pass = { stage: "review", review: { passed: true, evidence: "Scripted semantic review: requested export and real focused checks prove completion" } } as const;
const finish = { stage: "worker", content: "Implementation complete; return to deterministic verification" } as const;
const test = "const {test}=require('node:test');const a=require('node:assert/strict');test('value',()=>a.equal(require('../src/value.cjs').value,2));\n";
const base = { "package.json": JSON.stringify({ scripts: { test: "node --test tests/*.test.cjs", typecheck: "node --check src/value.cjs" } }),
  "src/value.cjs": "exports.value=1;\n", "tests/value.test.cjs": test };
export interface FakeSmokeFixture { task: string; files: Record<string, string>; script: FakeScript; success: boolean; }
export const fakeSmokeFixtures: Record<string, FakeSmokeFixture> = {
  create: { task: "Create src/value.cjs exporting value=2. Preserve existing tests.",
    files: { "package.json": base["package.json"], "tests/value.test.cjs": test }, success: true,
    script: { steps: [tools(["list_files", {}]), tools(["write_file", { path: "src/value.cjs", content: "exports.value=2;\n" }]), finish, pass] } },
  edit: { task: "Modify src/value.cjs to export value=2. Preserve existing tests.", files: base, success: true,
    script: { steps: [read, edit(1, 2), finish, pass] } },
  multi: { task: "Modify src/value.cjs and write tests/value.test.cjs to export and verify value=2.",
    files: { ...base, "tests/value.test.cjs": "const {test}=require('node:test');test('placeholder',()=>{});\n" }, success: true,
    script: { steps: [{ stage: "planner", json: { taskSummary: "Coupled source and test change", acceptanceCriteria: ["Export value=2 and add a focused regression test"],
      subtasks: [{ id: "implementation", title: "Source and regression test", objective: "Modify src/value.cjs to export value=2 and write tests/value.test.cjs asserting value=2",
        dependsOn: [], likelyReadPaths: ["src/value.cjs", "tests/value.test.cjs"], likelyWritePaths: ["src/value.cjs", "tests/value.test.cjs"],
        integrationContract: "Export and test value=2", verificationCommands: [], estimatedDifficulty: "normal", parallelSafe: false }] } },
      tools(["read_file", { path: "src/value.cjs" }], ["read_file", { path: "tests/value.test.cjs" }]),
      tools(["edit_file", { path: "src/value.cjs", oldText: "value=1", newText: "value=2" }], ["write_file", { path: "tests/value.test.cjs", content: test }]), finish, pass] } },
  progressive: { task: "Find the implementation of value and modify it so the existing tests pass.", files: base, success: true,
    script: { steps: [tools(["list_files", {}], ["search_code", { query: "exports.value" }]), read, edit(1, 2), finish, pass] } },
  repair: { task: "Modify src/value.cjs to export value=3. Preserve existing tests.",
    files: { ...base, "tests/value.test.cjs": "const {test}=require('node:test');const a=require('node:assert/strict');test('positive value',()=>a.ok(require('../src/value.cjs').value>0));\n" }, success: true,
    script: { steps: [read, edit(1, 2),
      { stage: "review", review: { passed: false, missingIds: ["R1"], evidence: "src/value.cjs exports 2; the requested exact value 3 is missing" } },
      edit(2, 3), finish, pass] } },
  "provider-failure": { task: "Modify src/value.cjs to export value=2.", files: base, success: false,
    script: { steps: Array.from({ length: 8 }, () => ({ stage: "worker", error: { status: 503, message: "Scripted provider unavailable" } })) } },
  "malformed-review": { task: "Modify src/value.cjs to export value=2.", files: base, success: true,
    script: { steps: [read, edit(1, 2), { stage: "review", content: "Looks good to me." }, pass] } },
  "review-tool-failure": { task: "Modify src/value.cjs to export value=2.", files: base, success: true,
    script: { steps: [read, edit(1, 2),
      { stage: "review", error: { status: 502, message: "OpenRouter returned a malformed response (invalid_tool_arguments)" } },
      pass] } },
  "review-failure": { task: "Modify src/value.cjs to export value=2.", files: base, success: false,
    script: { steps: [read, edit(1, 2), { stage: "review", content: "Looks good." }, { stage: "review", content: "Still no structured assessment." }] } },
  "token-preflight": { task: "Modify src/value.cjs to export value=2.", files: base, success: false,
    script: { steps: [{ stage: "worker", failure: "token_preflight" }, read, edit(1, 2), pass] } },
  regression: { task: "Modify src/value.cjs to export value=2.", files: base, success: false,
    script: { steps: [read, edit(1, 99), finish, pass] } },
};

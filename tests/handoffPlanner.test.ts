import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  planCodingHandoff,
} from "../src/agent/handoffPlanner.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "koda-handoff-"));
  await mkdir(join(root, "src"), { recursive: true });
  return root;
}

const base = {
  task: "Make the smallest correct change.",
  attemptTokenCapacity: 30_000,
  modelContextTokens: 128_000,
  maxOutputTokens: 4_096,
  costCapacityUsd: 1,
  promptPricePerMillion: 1,
  completionPricePerMillion: 4,
  directEditEligible: false,
};

test("localized concrete scope is handed directly to Aider and oversized secondary context is dropped", async () => {
  const root = await fixture();
  await writeFile(join(root, "src/a.ts"), "export const a = 1;\n");
  await writeFile(join(root, "src/b.ts"), "export const b = 2;\n");
  await writeFile(join(root, "src/huge.ts"), "x".repeat(400_000));

  const plan = await planCodingHandoff({
    ...base,
    repoPath: root,
    writeScope: ["src/a.ts", "src/b.ts"],
    context: {
      relevantFiles: ["src/huge.ts"],
      sourceFiles: [{ path: "src/huge.ts", snippet: "x" }],
    },
  });

  assert.equal(plan.mode, "aider");
  assert.deepEqual(plan.aiderFiles?.editable, ["src/a.ts", "src/b.ts"]);
  assert.equal(plan.aiderFiles?.readOnly.includes("src/huge.ts"), false);
});

test("oversized editable packets use bounded reads despite a large model context", async () => {
  const root = await fixture();
  await writeFile(join(root, "src/a.ts"), "a".repeat(100_000));
  await writeFile(join(root, "src/b.ts"), "b".repeat(100_000));

  const plan = await planCodingHandoff({
    ...base,
    repoPath: root,
    attemptTokenCapacity: 10_000,
    modelContextTokens: 128_000,
    writeScope: ["src/a.ts", "src/b.ts"],
  });

  assert.equal(plan.mode, "agentic");
  assert.match(plan.reason, /bounded repository reads/);
});

test("provider context overflow uses bounded reads instead of an impossible Aider preflight", async () => {
  const root = await fixture();
  await writeFile(join(root, "src/a.ts"), "a".repeat(100_000));
  await writeFile(join(root, "src/b.ts"), "b".repeat(100_000));

  const plan = await planCodingHandoff({
    ...base,
    repoPath: root,
    modelContextTokens: 16_000,
    writeScope: ["src/a.ts", "src/b.ts"],
  });

  assert.equal(plan.mode, "agentic");
  assert.match(plan.reason, /bounded repository reads/i);
});

test("large single-file packets use bounded reads even when provider context is large", async () => {
  const root = await fixture();
  await writeFile(join(root, "src/a.ts"), "a".repeat(200_000));

  const plan = await planCodingHandoff({
    ...base,
    repoPath: root,
    attemptTokenCapacity: 8_000,
    modelContextTokens: 128_000,
    directEditEligible: true,
    writeScope: ["src/a.ts"],
  });

  assert.equal(plan.mode, "agentic");
  assert.match(plan.reason, /bounded repository reads/);
});

test("concrete missing files remain editable Aider creation targets", async () => {
  const root = await fixture();
  await writeFile(join(root, "src/existing.ts"), "export const value = 1;\n");

  const plan = await planCodingHandoff({
    ...base,
    repoPath: root,
    writeScope: ["src/existing.ts", "src/newModule.ts"],
  });

  assert.equal(plan.mode, "aider");
  assert.deepEqual(plan.aiderFiles?.editable, ["src/existing.ts", "src/newModule.ts"]);
  assert.match(plan.reason, /creation targets/i);
});

test("only unresolved root scope keeps the emergency progressive fallback", async () => {
  const root = await fixture();
  const plan = await planCodingHandoff({
    ...base,
    repoPath: root,
    writeScope: ["."],
  });

  assert.equal(plan.mode, "agentic");
  assert.match(plan.reason, /localization must finish/i);
});

 test("whole-run token overflow uses bounded reads without dropping authorized files", async () => {
  const root = await fixture();
  await writeFile(join(root, "src/a.ts"), "a".repeat(100_000));
  await writeFile(join(root, "src/b.ts"), "b".repeat(100_000));
  const input = { ...base, repoPath: root, attemptTokenCapacity: 10_000,
    modelContextTokens: 1_000_000, writeScope: ["src/a.ts", "src/b.ts"] };
  const roomy = await planCodingHandoff({ ...input, remainingRunTokens: 100_000 });
  assert.equal(roomy.mode, "agentic", "a large run budget must not admit an oversized provider packet");
  const bounded = await planCodingHandoff({ ...input, remainingRunTokens: 55_000 });
  assert.equal(bounded.mode, "agentic");
  assert.match(bounded.reason, /remaining run tokens/);
  assert.ok(bounded.estimatedPromptBytes / 4 + 9216 < 55_000);
  assert.deepEqual(input.writeScope, ["src/a.ts", "src/b.ts"]);
});

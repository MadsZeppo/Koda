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
  const root =
    await mkdtemp(
      join(
        tmpdir(),
        "koda-handoff-",
      ),
    );

  await mkdir(
    join(root, "src"),
    { recursive: true },
  );

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

test(
  "Aider admission keeps complete editable files and drops oversized secondary context",
  async () => {
    const root = await fixture();

    await writeFile(
      join(root, "src/a.ts"),
      "export const a = 1;\n",
    );

    await writeFile(
      join(root, "src/b.ts"),
      "export const b = 2;\n",
    );

    await writeFile(
      join(root, "src/huge.ts"),
      "x".repeat(400_000),
    );

    const plan =
      await planCodingHandoff({
        ...base,
        repoPath: root,
        writeScope: [
          "src/a.ts",
          "src/b.ts",
        ],
        context: {
          relevantFiles: [
            "src/huge.ts",
          ],
          sourceFiles: [
            {
              path: "src/huge.ts",
              snippet: "x",
            },
          ],
        },
      });

    assert.equal(plan.mode, "aider");
    assert.deepEqual(plan.aiderFiles?.editable, ["src/a.ts", "src/b.ts"]);
    assert.equal(plan.aiderFiles?.readOnly.includes("src/huge.ts"), false);
  },
);

test(
  "oversized multi-file editable scope becomes progressive instead of failing preflight",
  async () => {
    const root = await fixture();

    await writeFile(join(root, "src/a.ts"), "a".repeat(100_000));
    await writeFile(join(root, "src/b.ts"), "b".repeat(100_000));

    const plan = await planCodingHandoff({
      ...base,
      repoPath: root,
      attemptTokenCapacity: 10_000,
      writeScope: ["src/a.ts", "src/b.ts"],
    });

    assert.equal(plan.mode, "agentic");
  },
);

test(
  "known source files fitting the real Aider attempt are handed to Aider",
  async () => {
    const root = await fixture();

    await writeFile(join(root, "src/planner.ts"), "p".repeat(10_000));
    await writeFile(join(root, "src/executor.ts"), "e".repeat(66_000));

    const plan = await planCodingHandoff({
      ...base,
      repoPath: root,
      attemptTokenCapacity: 30_000,
      writeScope: ["src/planner.ts", "src/executor.ts"],
    });

    assert.equal(plan.mode, "aider");
    assert.deepEqual(plan.aiderFiles?.editable, [
      "src/planner.ts",
      "src/executor.ts",
    ]);
  },
);

test(
  "focused mixed scope at the 30k framing boundary becomes progressive before provider preflight",
  async () => {
    const root = await fixture();
    await writeFile(join(root, "src/worker.ts"), "w".repeat(3_100));
    await writeFile(join(root, "src/executor.ts"), "e".repeat(67_000));
    await writeFile(join(root, "src/summary.ts"), "s".repeat(12_800));

    const plan = await planCodingHandoff({
      ...base,
      repoPath: root,
      attemptTokenCapacity: 30_000,
      writeScope: [
        "src/worker.ts",
        "src/executor.ts",
        "src/summary.ts",
        "src/executionOutcome.ts",
      ],
    });

    assert.equal(plan.mode, "agentic");
    assert.match(plan.reason, /exceeds the authoritative one-turn Aider budget/i);
  },
);

test(
  "one localized oversized file can use bounded DirectEdit",
  async () => {
    const root = await fixture();

    await writeFile(join(root, "src/a.ts"), "a".repeat(200_000));

    const plan = await planCodingHandoff({
      ...base,
      repoPath: root,
      attemptTokenCapacity: 8_000,
      directEditEligible: true,
      writeScope: ["src/a.ts"],
    });

    assert.equal(plan.mode, "direct");
  },
);

test(
  "concrete missing files remain editable Aider creation targets",
  async () => {
    const root = await fixture();
    await writeFile(join(root, "src/existing.ts"), "export const value = 1;\n");

    const plan = await planCodingHandoff({
      ...base,
      repoPath: root,
      writeScope: ["src/existing.ts", "src/newModule.ts"],
    });

    assert.equal(plan.mode, "aider");
    assert.deepEqual(plan.aiderFiles?.editable, [
      "src/existing.ts",
      "src/newModule.ts",
    ]);
  },
);

test(
  "broad scope and empty repos choose create-capable progressive execution",
  async () => {
    const root = await fixture();

    const plan = await planCodingHandoff({
      ...base,
      repoPath: root,
      writeScope: ["."],
    });

    assert.equal(plan.mode, "agentic");
  },
);

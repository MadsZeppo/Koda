import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { compileContext } from "../src/context/compiler.js";
import { focusedVerificationCheck } from "../src/verifier/selection.js";

const task =
  "Add a normalizeTaskLabel helper in src/planner/taskCompiler.ts that trims surrounding whitespace and collapses repeated internal whitespace to a single space. Add deterministic tests for it in tests/planner.test.ts.";

const profile = {
  files: [
    "src/planner/taskCompiler.ts",
    "tests/planner.test.ts",
  ],
  packageManager: "pnpm",
  scripts: {
    test: "tsx --test tests/*.test.ts",
  },
  verificationCommands: ["pnpm run test"],
  ecosystem: undefined,
} as any;

const subtask = {
  id: "direct",
  title: task,
  objective: task,
  dependsOn: [],
  likelyReadPaths: [],
  likelyWritePaths: [
    "src/planner/taskCompiler.ts",
    "tests/planner.test.ts",
  ],
  integrationContract: "Preserve existing public interfaces",
  verificationCommands: [],
  estimatedDifficulty: "normal",
  parallelSafe: false,
} as any;

test("bounded source + test write targets both survive focused context compilation", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-focused-context-"));

  try {
    await mkdir(join(root, "src/planner"), { recursive: true });
    await mkdir(join(root, "tests"), { recursive: true });

    await writeFile(
      join(root, "src/planner/taskCompiler.ts"),
      [
        "export function compileTask() { return true; }",
        ...Array.from({ length: 300 }, (_, index) =>
          `export const filler${index} = ${index};`),
      ].join("\n"),
    );

    await writeFile(
      join(root, "tests/planner.test.ts"),
      [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { compileTask } from '../src/planner/taskCompiler.js';",
        "test('compile task', () => assert.equal(compileTask(), true));",
      ].join("\n"),
    );

    const context = await compileContext(
      root,
      task,
      subtask.likelyWritePaths,
      profile,
      {
        scanFiles: 32,
        readBytes: 16_000,
        fileBytes: 1_500,
        maxFiles: 8,
        maxBytes: 4_500,
      } as any,
      true,
    );

    const paths = context.files.map((file) => file.path);
    assert.ok(paths.includes("src/planner/taskCompiler.ts"));
    assert.ok(paths.includes("tests/planner.test.ts"));

    assert.equal(
      focusedVerificationCheck(subtask, profile, context),
      "pnpm exec tsx --test 'tests/planner.test.ts'",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a not-yet-created explicit test target is not executed as baseline", () => {
  const missingProfile = {
    ...profile,
    files: ["src/planner/taskCompiler.ts"],
  } as any;

  const missingSubtask = {
    ...subtask,
    likelyWritePaths: [
      "src/planner/taskCompiler.ts",
      "tests/newPlanner.test.ts",
    ],
  } as any;

  const context = {
    files: [
      {
        path: "src/planner/taskCompiler.ts",
        snippet: "export function compileTask() { return true; }",
      },
    ],
    repoMap: ["src/planner/taskCompiler.ts"],
    localDependencies: [],
  } as any;

  assert.equal(
    focusedVerificationCheck(missingSubtask, missingProfile, context),
    undefined,
  );
});

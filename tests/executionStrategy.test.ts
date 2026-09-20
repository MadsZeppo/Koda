import { test } from "node:test";
import assert from "node:assert/strict";
import { extname } from "node:path";
import {
  chooseExecutionStrategy,
  directWritePaths,
} from "../src/router/executionStrategy.js";
import type { RepoProfile } from "../src/types.js";
function profile(
  files = ["calculator.cjs", "tests/calculator.test.cjs", "package.json"],
): RepoProfile {
  return {
    root: "/fixture",
    commit: "base",
    status: "",
    diff: "",
    files,
    topLevel: [],
    extensions: files.reduce<Record<string, number>>((counts, file) => {
      const extension = extname(file);
      counts[extension] = (counts[extension] ?? 0) + 1;
      return counts;
    }, {}),
    symbols: [],
    packageManager: "npm",
    scripts: { test: "node --test" },
    configs: {},
    verificationCommands: ["npm run test"],
  };
}
test("execution strategy: an explicit tiny calculator correction is direct", () => {
  for (const task of [
    "Fix the calculator bug with negative inputs.",
    "Correct calculator.cjs so addition returns the sum.",
  ]) {
    const result = chooseExecutionStrategy(task, profile());
    assert.equal(result.execution_strategy, "direct");
    assert.deepEqual(result.likelyFiles, ["calculator.cjs"]);
    assert.ok(result.strategy_reason.length > 0);
  }
  assert.deepEqual(directWritePaths(["calculator.cjs"], profile()), [
    "calculator.cjs",
  ]);
  assert.deepEqual(directWritePaths(["calculator.cjs"], profile(), "Fix calculator and add a regression test"), [
    "calculator.cjs", "tests/calculator.test.cjs",
  ]);
});
test("a localized bug report with reproduction steps remains one worker", () => {
  const repository = profile(["src/codec.py", "tests/test_codec.py", "setup.py"]);
  const task = "Bug: encoding a value fails. Reproduce: call encode('x') and observe a wrong result. Expected: return the original value. Fix this localized behavior in src/codec.py; use the existing test for verification.";
  assert.ok(["direct", "stable"].includes(chooseExecutionStrategy(task, repository).execution_strategy));
});
test("execution strategy: one explicit documentation or configuration path is direct", () => {
  const repository = profile([
    "README.md",
    "benchmarks/README.md",
    "setup.md",
    "docs/setup.md",
    "vite.config.ts",
    "src/run.ts",
    "src/workspace/backend.ts",
    "package.json",
  ]);
  for (const [task, path] of [
    [
      "In README.md, add one Workspace safety bullet. Make no other changes.",
      "README.md",
    ],
    ["Fix the typo in docs/setup.md.", "docs/setup.md"],
    ["Update this config value in vite.config.ts.", "vite.config.ts"],
  ] as const) {
    const result = chooseExecutionStrategy(task, repository);
    assert.equal(result.execution_strategy, "direct", task);
    assert.equal(result.strategy_reason, "One explicit localized file target");
    assert.equal(result.preciseTarget, path);
    assert.deepEqual(result.likelyFiles, [path]);
  }
});
test("execution strategy: precise source target stays narrow while vague inference may expand", () => {
  const repository = profile([
    "src/foo.ts",
    "src/helper.ts",
    "tests/foo.test.ts",
    "package.json",
  ]);
  const precise = chooseExecutionStrategy(
    "In src/foo.ts, correct the return value.",
    repository,
  );
  assert.equal(precise.execution_strategy, "direct");
  assert.equal(precise.preciseTarget, "src/foo.ts");
  assert.deepEqual(precise.likelyFiles, ["src/foo.ts"]);
  const vague = chooseExecutionStrategy("Fix the foo bug.", repository);
  assert.equal(vague.preciseTarget, undefined);
  assert.deepEqual(directWritePaths(vague.likelyFiles, repository, "Fix the foo bug."), ["src/foo.ts"]);
});
test("execution strategy: monorepo complexity does not override one explicit target", () => {
  const monorepo = profile([
    "README.md",
    "apps/web/src/session.ts",
    "apps/api/src/auth.ts",
    "packages/config/vite.config.ts",
    ...Array.from(
      { length: 80 },
      (_, index) => `packages/p${index}/src/index.ts`,
    ),
  ]);
  monorepo.ecosystem = {
    ecosystem: "javascript",
    languages: ["typescript"],
    frameworks: ["nodejs"],
    monorepo: true,
    projectUnits: [],
    configFiles: [],
    ambiguities: [],
  } as any;
  assert.equal(
    chooseExecutionStrategy(
      "In README.md, add one Workspace safety bullet. Make no other changes.",
      monorepo,
    ).execution_strategy,
    "direct",
  );
});
test("execution strategy: architecture coupling overrides localized lexical matches", () => {
  const repository = profile([
    "README.md",
    "src/auth.ts",
    "api/auth.ts",
    "middleware/auth.ts",
    "frontend/session.ts",
  ]);
  for (const task of [
    "Refactor authentication across API, middleware and frontend session handling.",
    "Refactor authentication in src/auth.ts.",
    "Update README.md and regenerate API documentation.",
  ])
    assert.equal(
      chooseExecutionStrategy(task, repository).execution_strategy,
      "planned",
      task,
    );
});
test("execution strategy: explicit independent parts are planned", () => {
  for (const task of [
    "Fix calculator.cjs and independently fix the formatter.",
    "Fix calculator.cjs and implement a formatter.",
    "Fix calculator.cjs; correct formatting.",
    "Fix calculator.cjs. Implement a formatter.",
  ])
    assert.equal(
      chooseExecutionStrategy(task, profile()).execution_strategy,
      "planned",
    );
});
test("execution strategy: three separately named source repairs use PLANNED", () => {
  const repository = profile([
    "src/math.js", "src/slug.js", "src/display-name.js",
    "test/math.test.js", "test/slug.test.js", "test/display-name.test.js",
  ]);
  assert.equal(chooseExecutionStrategy(
    "Fix math, slug and display-name; preserve existing behavior.", repository,
  ).execution_strategy, "planned");
});
test("execution strategy: bounded inspect, fix and regression test uses stable mode", () => {
  const repository = profile([
    "src/repo/commands.ts",
    "src/repo/dependencies.ts",
    "tests/core.test.ts",
    "package.json",
  ]);
  const result = chooseExecutionStrategy(
    "Inspect the filesystem verification flow in src/repo/commands.ts and src/repo/dependencies.ts. Find one small real robustness issue that is not already covered by tests, fix it with the smallest possible change, and add a focused regression test. Do not change dependencies, do not weaken existing tests, and do not perform unrelated refactors. Verify the result with the relevant tests and typecheck.",
    repository,
  );
  assert.equal(result.execution_strategy, "stable");
  assert.equal(result.execution_effort, "normal");
  assert.deepEqual(result.likelyFiles, [
    "src/repo/commands.ts",
    "src/repo/dependencies.ts",
  ]);
});
test("a bounded feature and its acceptance tests remain one Stable workstream", () => {
  const repository = profile([
    "src/cli.ts", "src/run.ts", "src/router/modelRouter.ts",
    "tests/cli.test.ts", "tests/run.test.ts", "README.md", "package.json",
  ]);
  for (const task of [
    "Add a CLI flag --explain-routing. Add focused tests. Preserve existing behavior.",
    "Implement one routing option in src/cli.ts and add a regression test; preserve existing behavior.",
  ]) {
    const result = chooseExecutionStrategy(task, repository);
    assert.equal(result.execution_strategy, "stable", task);
    assert.equal(result.execution_effort, "normal");
  }
  assert.equal(chooseExecutionStrategy(
    "Implement a CLI flag and independently redesign the database migration.", repository,
  ).execution_strategy, "planned");
});
test("single conceptual runtime fixes do not become PLANNED from lexical repo matches", () => {
  const repository = profile([
    "src/run.ts",
    "src/verifier/plan.ts",
    "src/verifier/selection.ts",
    "src/planner/policy.ts",
    "src/router/executionStrategy.ts",
    "tests/stableMutation.test.ts",
    "package.json",
    ...Array.from({ length: 12 }, (_, index) => `src/extra${index}.ts`),
  ]);
  for (const task of [
    "Modify only the final verification planning logic. Preserve build, typecheck, and the root test as authoritative checks. Do not change coding or routing behavior.",
    "Fix the targeted verification repair flow so a no-op repair preserves the existing failure. Add one focused regression test and preserve successful-repair behavior.",
  ]) {
    const result = chooseExecutionStrategy(task, repository);
    assert.equal(result.execution_strategy, "stable", task);
  }
});

test("execution effort uses scope rather than prompt length", () => {
  const repository = profile([
    "README.md",
    "src/auth.ts",
    "api/auth.ts",
    "package.json",
  ]);
  const longExplicit =
    "In README.md, add one Workspace safety bullet. " +
    "Keep the heading intact. Preserve the existing wording and formatting. ".repeat(
      30,
    );
  const tiny = chooseExecutionStrategy(longExplicit, repository);
  assert.equal(tiny.execution_strategy, "direct");
  assert.equal(tiny.execution_effort, "tiny");
  assert.equal(tiny.preciseTarget, "README.md");
  const complex = chooseExecutionStrategy(
    "Refactor auth for multi-tenant organizations.",
    repository,
  );
  assert.notEqual(complex.execution_effort, "tiny");
  assert.equal(complex.execution_strategy, "planned");
});
test("execution strategy: cross-module requirements are planned", () => {
  assert.equal(
    chooseExecutionStrategy(
      "Fix calculator behavior across the API and database.",
      profile(),
    ).execution_strategy,
    "planned",
  );
  assert.equal(
    chooseExecutionStrategy(
      "Fix calculator.cjs and formatter.cjs output.",
      profile(["math/calculator.cjs", "format/formatter.cjs"]),
    ).execution_strategy,
    "planned",
  );
});
test("execution strategy: explicit system boundaries or configuration edits are planned", () => {
  assert.equal(
    chooseExecutionStrategy(
      "Fix client.cjs and server.cjs protocol handling.",
      profile(["client.cjs", "server.cjs"]),
    ).execution_strategy,
    "planned",
  );
  assert.equal(
    chooseExecutionStrategy("Fix calculator.cjs and package.json.", profile())
      .execution_strategy,
    "planned",
  );
});
test("execution strategy: single uncertain requests default direct without inventing parallel work", () => {
  for (const task of [
    "Make it work.",
    "Fix the bug.",
    "Improve calculator performance.",
    "Fix missing.cjs.",
    "Fix everything in calculator.cjs.",
  ])
    assert.equal(
      chooseExecutionStrategy(task, profile()).execution_strategy,
      task.includes("everything") ? "planned" : "direct",
    );
});
test("execution strategy: repo size alone does not force planning for one known target", () => {
  const large = profile();
  large.extensions[".md"] = 50;
  assert.equal(
    chooseExecutionStrategy("Fix calculator.cjs", large).execution_strategy,
    "direct",
  );
  for (const files of [
    ["calculator.cjs", ...Array.from({ length: 8 }, (_, i) => `file${i}.cjs`)],
    ["packages/math/calculator.cjs"],
    ["calculator.cjs", "package.json", "other/package.json"],
  ])
    assert.equal(
      chooseExecutionStrategy("Fix calculator.cjs", profile(files))
        .execution_strategy,
      "direct",
    );
});

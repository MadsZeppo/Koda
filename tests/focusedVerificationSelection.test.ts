import { test } from "node:test";
import assert from "node:assert/strict";

import type { Subtask } from "../src/planner/schemas.js";
import type { RepoProfile } from "../src/types.js";
import type { VerificationCandidate } from "../src/repo/ecosystem.js";
import type { WorkerContext } from "../src/context/compiler.js";

import {
  focusedVerificationCheck,
  impactAwareVerificationSelection,
  verificationImpactRelationships,
  discoveredTestGlobs,
} from "../src/verifier/selection.js";

test("discovered test glob handles a bounded native TypeScript runner", () => {
  assert.deepEqual(discoveredTestGlobs(
    "node --experimental-strip-types --test tests/*.test.ts"),
  ["tests/*.test.ts"]);
  assert.deepEqual(discoveredTestGlobs("node --import arbitrary --test tests/*.test.ts"), []);
});


const aggregateTest: VerificationCandidate = {
  kind: "test",
  command: "pnpm test",
  cwd: ".",
  source: "package.json:scripts.test",
  confidence: 1,
  available: true,
  mutatesSource: false,
  requiresInstalledDependencies: true,
};


const typecheck: VerificationCandidate = {
  kind: "typecheck",
  command: "pnpm typecheck",
  cwd: ".",
  source: "package.json:scripts.typecheck",
  confidence: 1,
  available: true,
  mutatesSource: false,
  requiresInstalledDependencies: true,
};


const profile = {
  scripts: {
    test: "tsx --test tests/*.test.ts",
    typecheck: "tsc --noEmit",
  },

  packageManager: "pnpm",

  verificationCommands: [
    "pnpm test",
    "pnpm typecheck",
  ],

  ecosystem: {
    projectUnits: [
      {
        root: ".",

        scripts: {
          test: "tsx --test tests/*.test.ts",
          typecheck: "tsc --noEmit",
        },

        verification: [
          aggregateTest,
          typecheck,
        ],
      },
    ],
  },
} as unknown as RepoProfile;


const makeSubtask = (
  paths: string[],
): Subtask =>
  ({
    id: "verification-test",
    title: "change source",
    objective: "change source",

    dependsOn: [],

    likelyReadPaths: [],
    likelyWritePaths: paths,

    integrationContract: "preserve behavior",
    verificationCommands: [],

    estimatedDifficulty: "normal",
    parallelSafe: false,
  }) as Subtask;


const makeContext = (
  testSource: string,
): WorkerContext => ({
  files: [
    {
      path: "src/foo.ts",
      snippet: "export const foo = () => 1;",
    },

    {
      path: "tests/foo.test.ts",
      snippet: testSource,
    },
  ],

  repoMap: [
    "src/foo.ts",
    "tests/foo.test.ts",
  ],

  localDependencies: [],
});


test(
  "source import relationship selects only the impacted root tsx test",
  () => {
    const workerContext = makeContext(
      'import { foo } from "../src/foo.js";\nvoid foo();',
    );

    const subtask = makeSubtask([
      "src/foo.ts",
    ]);

    const command = focusedVerificationCheck(
      subtask,
      profile,
      workerContext,
    );

    assert.equal(
      command,
      "pnpm exec tsx --test 'tests/foo.test.ts'",
    );

    const relationships =
      verificationImpactRelationships(
        subtask.likelyWritePaths,
        workerContext,
      );

    assert.deepEqual(
      relationships,
      [
        {
          source: "src/foo.ts",
          tests: ["tests/foo.test.ts"],
          basis: "import",
        },
      ],
    );

    const selected =
      impactAwareVerificationSelection({
        changedPaths: [
          "src/foo.ts",
        ],

        candidates: [
          aggregateTest,
          typecheck,
        ],

        focusedCommands: [
          command!,
        ],

        relationships,
      });

    assert.equal(
      selected.whyFullSuite,
      false,
    );

    assert.deepEqual(
      selected.impactedTests,
      ["tests/foo.test.ts"],
    );

    assert.deepEqual(
      selected.candidates.map(
        (candidate) => candidate.command,
      ),
      [
        "pnpm typecheck",
      ],
    );
  },
);


test(
  "unknown source to test relationship keeps aggregate suite",
  () => {
    const workerContext = makeContext(
      'import { other } from "../src/other.js";\nvoid other;',
    );

    const subtask = makeSubtask([
      "src/foo.ts",
    ]);

    assert.equal(
      focusedVerificationCheck(
        subtask,
        profile,
        workerContext,
      ),
      undefined,
    );

    const selected =
      impactAwareVerificationSelection({
        changedPaths: [
          "src/foo.ts",
        ],

        candidates: [
          aggregateTest,
          typecheck,
        ],

        focusedCommands: [],

        relationships:
          verificationImpactRelationships(
            subtask.likelyWritePaths,
            workerContext,
          ),
      });

    assert.equal(
      selected.whyFullSuite,
      true,
    );

    assert.deepEqual(
      selected.candidates.map(
        (candidate) => candidate.command,
      ),
      [
        "pnpm test",
        "pnpm typecheck",
      ],
    );
  },
);


test(
  "exact changed tsx test can be run directly",
  () => {
    const workerContext = makeContext(
      'import { foo } from "../src/foo.js";\nvoid foo();',
    );

    assert.equal(
      focusedVerificationCheck(
        makeSubtask([
          "tests/foo.test.ts",
        ]),
        profile,
        workerContext,
      ),
      "pnpm exec tsx --test 'tests/foo.test.ts'",
    );
  },
);


test(
  "risky repository contract changes still require broad verification",
  () => {
    const selected =
      impactAwareVerificationSelection({
        changedPaths: [
          "package.json",
        ],

        candidates: [
          aggregateTest,
          typecheck,
        ],

        focusedCommands: [],
        relationships: [],
      });

    assert.equal(
      selected.whyFullSuite,
      true,
    );

    assert.deepEqual(
      selected.candidates.map(
        (candidate) => candidate.command,
      ),
      [
        "pnpm test",
        "pnpm typecheck",
      ],
    );
  },
);


test("direct runner globs reject nested and unexecuted tests", () => {
  for (const path of ["src/foo.test.ts", "tests/nested/foo.test.ts", "tests/.hidden.test.ts"]) {
    assert.equal(focusedVerificationCheck(makeSubtask([path]), profile, makeContext("")), undefined);
  }
});

test("a source relationship cannot hide an uncovered changed test", () => {
  const selected = impactAwareVerificationSelection({
    changedPaths: ["src/foo.ts", "tests/other.test.ts"], candidates: [aggregateTest, typecheck],
    focusedCommands: ["pnpm exec tsx --test 'tests/foo.test.ts'"],
    relationships: [{ source: "src/foo.ts", tests: ["tests/foo.test.ts"], basis: "import" }],
  });
  assert.equal(selected.whyFullSuite, true);
  assert.ok(selected.candidates.includes(aggregateTest));
});

test("post-mutation recovery uses actual paths once and regressions still block success", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { recoverPostMutationChecks } = await import("../src/verifier/recovery.js");
  const { verify, verificationAgainstBaseline } = await import("../src/verifier/verifier.js");
  const root = await mkdtemp(join(tmpdir(), "koda-recovery-impact-"));
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "tests"));
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: {
      test: "node --test tests/*.test.cjs", typecheck: "node --check src/value.cjs",
    } }));
    await writeFile(join(root, "src/value.cjs"), "module.exports = 1;\n");
    await writeFile(join(root, "tests/value.test.cjs"),
      "const {test}=require('node:test');const assert=require('node:assert/strict');const value=require('../src/value.cjs');test('value',()=>assert.equal(value,1));\n");
    // If the aggregate suite is run redundantly, this unrelated failure exposes it.
    await writeFile(join(root, "tests/unrelated.test.cjs"),
      "const {test}=require('node:test');test('unrelated baseline failure',()=>{throw Error('existing');});\n");
    const checks = await recoverPostMutationChecks(root, "Correct value", ["src/value.cjs"]);
    assert.deepEqual(checks.map((check) => check.kind), ["test", "typecheck"]);
    assert.equal(checks[0]!.command, "node --test 'tests/value.test.cjs'");
    assert.ok(checks.every((check) => !/^(?:npm|pnpm) (?:run )?test$/.test(check.command)));
    const baseline = await verify(root, checks.map((check) => check.command), () => 5000, undefined, undefined, checks);
    assert.equal(baseline.status, "VERIFIED_SUCCESS");
    await writeFile(join(root, "src/value.cjs"), "module.exports = 2;\n");
    const candidate = await verify(root, checks.map((check) => check.command), () => 5000, undefined, undefined, checks);
    assert.equal(verificationAgainstBaseline(baseline, candidate, ["src/value.cjs"]).status, "FAILED");
    const exactTest = await recoverPostMutationChecks(root, "Update test", ["tests/value.test.cjs"]);
    assert.equal(exactTest[0]!.command, "node --test 'tests/value.test.cjs'");
    assert.ok(exactTest.some((check) => check.kind === "typecheck"));
    const risky = await recoverPostMutationChecks(root, "Correct concurrent state", ["src/value.cjs"], {
      fingerprint: { concurrencyRisk: true } as any,
    });
    assert.ok(risky.some((check) => /^(?:npm|pnpm) (?:run )?test$/.test(check.command)),
      "task risk keeps broad verification even when test relationships are proven");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an exact missing test target receives the real implementation context before coding", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { implement } = await import("../src/agent/codingExecutor.js");
  const { profileRepo } = await import("../src/repo/profiler.js");
  const { config } = await import("../src/config.js");
  const { Logger } = await import("../src/telemetry/logger.js");
  const { Budget } = await import("../src/openrouter/usage.js");
  const { git } = await import("../src/repo/commands.js");
  const root = await mkdtemp(join(tmpdir(), "koda-new-test-context-"));
  const logs = await mkdtemp(join(tmpdir(), "koda-new-test-context-logs-"));
  try {
    await mkdir(join(root, "src", "verifier"), { recursive: true });
    await mkdir(join(root, "tests"));
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: {
      test: "node --test tests/*.test.cjs",
      typecheck: "node --check src/verifier/selection.cjs",
    } }));
    await writeFile(join(root, "src", "verifier", "selection.cjs"),
      "exports.focusedVerificationCheck=(path)=>path==='tests/new.test.cjs'?`node --test '${path}'`:undefined;\n");
    await writeFile(join(root, "tests", "existing.test.cjs"),
      "const {test}=require('node:test');test('existing',()=>{});\n");
    await git(root, "init", "-q");
    await git(root, "config", "user.name", "Test");
    await git(root, "config", "user.email", "test@example.test");
    await git(root, "add", ".");
    await git(root, "commit", "-qm", "baseline");
    const repo = await profileRepo(root);
    const settings = await config(undefined, { maxIterations: 1 });
    const logger = new Logger(join(logs, "events"), "new-test-context", true);
    const result = await implement(
      { config: settings, logger, budget: new Budget(1, 100000, 60000) } as any,
      root,
      "Create tests/new.test.cjs using the existing verification-selection implementation and prove an in-pattern changed test path produces a focused command",
      { ...makeSubtask(["tests/new.test.cjs"]), id: "direct", title: "Add focused selection test",
        objective: "Create tests/new.test.cjs using src/verifier/selection.cjs",
        integrationContract: "The focused command names the exact changed test", estimatedDifficulty: "low" },
      { acceptanceCriteria: ["The exact changed test produces its focused command"] },
      repo,
      { codingWorker: { engine: "agentic", async run(input) {
        assert.deepEqual(input.writeScope, ["tests/new.test.cjs"],
          "the explicit missing path must reach the worker as exact scope");
        assert.ok(input.context?.sourceFiles?.some((file) =>
          file.path === "src/verifier/selection.cjs" && file.snippet.includes("focusedVerificationCheck")),
        "new test creation must be grounded in the implementation under test");
        await writeFile(join(root, "tests", "new.test.cjs"),
          "const {test}=require('node:test');const assert=require('node:assert/strict');const {focusedVerificationCheck}=require('../src/verifier/selection.cjs');test('focused changed test',()=>assert.equal(focusedVerificationCheck('tests/new.test.cjs'),\"node --test 'tests/new.test.cjs'\"));\n");
        return { exitStatus: "completed", model: input.model, engine: "agentic", engineVersion: "test",
          changedPaths: ["tests/new.test.cjs"], wallClockMs: 1, terminationReason: "candidate_ready_for_verification" };
      } } },
    );
    assert.equal(result.verification.status, "VERIFIED_SUCCESS");
    assert.equal(logger.events.filter((event) => event.type === "verification" &&
      String(event.command).includes("tests/new.test.cjs")).length, 1,
      "the candidate-only test runs on the candidate and never on baseline");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(logs, { recursive: true, force: true });
  }
});

test("a focused candidate regression gets one same-scope repair and can verify", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { implement } = await import("../src/agent/codingExecutor.js");
  const { profileRepo } = await import("../src/repo/profiler.js");
  const { config } = await import("../src/config.js");
  const { Logger } = await import("../src/telemetry/logger.js");
  const { Budget } = await import("../src/openrouter/usage.js");
  const { git } = await import("../src/repo/commands.js");
  const root = await mkdtemp(join(tmpdir(), "koda-verification-repair-"));
  const logs = await mkdtemp(join(tmpdir(), "koda-verification-repair-logs-"));
  const target = "tests/new.test.cjs";
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "tests"));
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: {
      test: "node --test tests/*.test.cjs",
      typecheck: "node --check src/value.cjs",
    } }));
    await writeFile(join(root, "src/value.cjs"), "module.exports = 2;\n");
    await writeFile(join(root, "tests/existing.test.cjs"),
      "const {test}=require('node:test');test('existing',()=>{});\n");
    await git(root, "init", "-q");
    await git(root, "config", "user.name", "Test");
    await git(root, "config", "user.email", "test@example.test");
    await git(root, "add", ".");
    await git(root, "commit", "-qm", "baseline");
    const repo = await profileRepo(root);
    const settings = await config(undefined, { maxIterations: 1 });
    const logger = new Logger(join(logs, "events"), "verification-repair", true);
    let calls = 0;
    const result = await implement(
      { config: settings, logger, budget: new Budget(1, 100000, 60000) } as any,
      root,
      `Create ${target} with a deterministic passing assertion`,
      { ...makeSubtask([target]), id: "direct", objective: `Create ${target}`,
        integrationContract: "The new focused test passes", estimatedDifficulty: "low" },
      { acceptanceCriteria: ["The new focused test passes"] },
      repo,
      { codingWorker: { engine: "agentic", async run(input) {
        calls++;
        assert.deepEqual(input.writeScope, [target]);
        if (calls === 1) {
          await writeFile(join(root, target),
            "const {test}=require('node:test');const assert=require('node:assert/strict');test('value',()=>assert.equal(1,2));\n");
        } else {
          assert.ok(input.context?.completionRepair);
          assert.match(input.context?.diagnostics ?? "", /Failing command:.*new\.test\.cjs/s);
          await writeFile(join(root, target),
            "const {test}=require('node:test');const assert=require('node:assert/strict');test('value',()=>assert.equal(2,2));\n");
        }
        return { exitStatus: "completed", model: input.model, engine: "agentic", engineVersion: "test",
          changedPaths: [target], wallClockMs: 1, terminationReason: "candidate_ready_for_verification" };
      } } },
    );
    assert.equal(calls, 2);
    assert.equal(result.verification.status, "VERIFIED_SUCCESS");
    assert.equal(logger.events.filter((event) => event.type === "verification_repair").length, 1);
    assert.equal(logger.events.filter((event) => event.type === "attempt_rollback").length, 0);
    const broad = logger.events.filter((event) => event.type === "verification" &&
      ["npm test", "pnpm test"].includes(String(event.command)));
    assert.equal(broad.length, 0);
    assert.ok(logger.events.some((event) => event.type === "verification" &&
      event.kind === "typecheck"), "targeted verification retains a structural check");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(logs, { recursive: true, force: true });
  }
});

for (const [taskPrefix, errorStream, repairSucceeds] of [
  ["Create", "stdout", true],
  ["Find the existing fixture. Add", "stderr", true],
  ["Write", "stdout", false],
] as const) {
  test(`structural repair preserves both output streams (${taskPrefix}, ${errorStream}, ${repairSucceeds})`, async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { implement } = await import("../src/agent/codingExecutor.js");
    const { profileRepo } = await import("../src/repo/profiler.js");
    const { config } = await import("../src/config.js");
    const { Logger } = await import("../src/telemetry/logger.js");
    const { Budget } = await import("../src/openrouter/usage.js");
    const { git } = await import("../src/repo/commands.js");
    const root = await mkdtemp(join(tmpdir(), "koda-structural-repair-"));
    const logs = await mkdtemp(join(tmpdir(), "koda-structural-repair-log-"));
    const target = "tests/fixture.test.cjs";
    try {
      await mkdir(join(root, "src"));
      await mkdir(join(root, "tests"));
      await writeFile(join(root, "src/shape.cjs"), "exports.label='value';\n");
      await writeFile(join(root, "package.json"), JSON.stringify({ scripts: {
        test: "node --test tests/*.test.cjs", typecheck: "node check.cjs",
      } }));
      // An authoritative structural check enforces the fixture contract independently
      // of its runtime test, which intentionally exercises just the label behavior.
      await writeFile(join(root, "check.cjs"),
        `const fs=require('node:fs');const path=${JSON.stringify(target)};` +
        `if(fs.existsSync(path)&&!fs.readFileSync(path,'utf8').includes('count: 2')){` +
        `process.${errorStream}.write(path+': required fixture field count is missing\\n');` +
        `process.${errorStream === "stdout" ? "stderr" : "stdout"}.write('Running structural checker\\n');process.exit(1);}`);
      await writeFile(join(root, "tests/existing.test.cjs"),
        "const {test}=require('node:test');test('existing',()=>{});\n");
      await git(root, "init", "-q");
      await git(root, "config", "user.name", "Test");
      await git(root, "config", "user.email", "test@example.test");
      await git(root, "add", ".");
      await git(root, "commit", "-qm", "baseline");
      const profile = await profileRepo(root);
      const logger = new Logger(logs, "structural-repair", true);
      let calls = 0;
      const result = await implement(
        { config: await config(undefined, { maxIterations: 1 }), logger,
          budget: new Budget(1, 100000, 60000) } as any,
        root, `${taskPrefix} ${target} with a deterministic fixture test`,
        { ...makeSubtask([target]), id: "direct", objective: `${taskPrefix} ${target}` },
        { acceptanceCriteria: ["The fixture test and required structural check pass"] }, profile,
        { codingWorker: { engine: "aider", async run(input) {
          calls++;
          assert.deepEqual(input.writeScope, [target]);
          if (calls === 2) {
            assert.match(input.context?.diagnostics ?? "", /required fixture field count is missing/);
            assert.match(input.context?.diagnostics ?? "", /Running structural checker/);
            assert.match(input.context?.diagnostics ?? "", /Failing command:.*typecheck/);
            assert.ok(input.context?.sourceFiles?.some((file) => file.path === target &&
              file.snippet.includes("const fixture")), "repair reads the newly created candidate");
            assert.ok(input.context?.sourceFiles?.some((file) => file.path === "src/shape.cjs" &&
              file.snippet.includes("exports.label")), "candidate imports supply grounded repair contracts");
          }
          await writeFile(join(root, target),
            "const {test}=require('node:test');const assert=require('node:assert/strict');" +
            `const {label}=require('../src/shape.cjs');const fixture={label${calls === 2 && repairSucceeds ? ", count: 2" : ""}};` +
            "test('fixture label',()=>assert.equal(fixture.label,'value'));\n");
          return { exitStatus: "completed", model: input.model, engine: "aider", engineVersion: "test",
            changedPaths: [target], wallClockMs: 1, terminationReason: "candidate_ready_for_verification" };
        } } },
      );
      assert.equal(calls, 2);
      assert.equal(result.verification.status, repairSucceeds ? "VERIFIED_SUCCESS" : "FAILED");
      assert.ok(result.verification.checks.some((check) => check.kind === "test" && check.outcome === "CHECK_PASS"));
      assert.ok(result.verification.checks.some((check) => check.kind === "typecheck" &&
        check.outcome === (repairSucceeds ? "CHECK_PASS" : "CHECK_FAIL")));
      assert.equal(logger.events.filter((event) => event.type === "verification_repair").length, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(logs, { recursive: true, force: true });
    }
  });
}

test("a no-op verification repair stops after one repair and remains failed", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { implement } = await import("../src/agent/codingExecutor.js");
  const { profileRepo } = await import("../src/repo/profiler.js");
  const { config } = await import("../src/config.js");
  const { Logger } = await import("../src/telemetry/logger.js");
  const { Budget } = await import("../src/openrouter/usage.js");
  const { git } = await import("../src/repo/commands.js");
  const root = await mkdtemp(join(tmpdir(), "koda-verification-noop-"));
  const logs = await mkdtemp(join(tmpdir(), "koda-verification-noop-logs-"));
  const target = "tests/new.test.cjs";
  try {
    await mkdir(join(root, "tests"));
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: {
      test: "node --test tests/*.test.cjs",
    } }));
    await writeFile(join(root, "tests/existing.test.cjs"),
      "const {test}=require('node:test');test('existing',()=>{});\n");
    await git(root, "init", "-q");
    await git(root, "config", "user.name", "Test");
    await git(root, "config", "user.email", "test@example.test");
    await git(root, "add", ".");
    await git(root, "commit", "-qm", "baseline");
    const repo = await profileRepo(root);
    const settings = await config(undefined, { maxIterations: 1 });
    const logger = new Logger(join(logs, "events"), "verification-noop", true);
    let calls = 0;
    const result = await implement(
      { config: settings, logger, budget: new Budget(1, 100000, 60000) } as any,
      root, `Create ${target}`, { ...makeSubtask([target]), id: "direct",
        objective: `Create ${target}`, integrationContract: "The test passes", estimatedDifficulty: "low" },
      { acceptanceCriteria: ["The test passes"] }, repo,
      { codingWorker: { engine: "agentic", async run(input) {
        calls++;
        if (calls === 1) await writeFile(join(root, target),
          "const {test}=require('node:test');test('still failing',()=>{throw Error('candidate regression')});\n");
        return { exitStatus: "completed", model: input.model, engine: "agentic", engineVersion: "test",
          changedPaths: calls === 1 ? [target] : [], wallClockMs: 1 };
      } } },
    );
    assert.equal(calls, 2);
    assert.equal(result.verification.status, "FAILED");
    assert.equal(logger.events.filter((event) => event.type === "verification_repair").length, 1);
    assert.ok(logger.events.some((event) => event.type === "verification_repair_exhausted" &&
      event.reason === "repair_produced_no_mutation"));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(logs, { recursive: true, force: true });
  }
});

test("executor enables root handoff and verifies actual changed paths without rerunning the suite", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { implement } = await import("../src/agent/codingExecutor.js");
  const { profileRepo } = await import("../src/repo/profiler.js");
  const { config } = await import("../src/config.js");
  const { Logger } = await import("../src/telemetry/logger.js");
  const { Budget } = await import("../src/openrouter/usage.js");
  const root = await mkdtemp(join(tmpdir(), "koda-executor-root-"));
  const logs = await mkdtemp(join(tmpdir(), "koda-executor-root-logs-"));
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "tests"));
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: {
      test: "node --test tests/*.test.cjs", typecheck: "node --check src/value.cjs",
    } }));
    await writeFile(join(root, "src/value.cjs"), "module.exports = 1;\n");
    await writeFile(join(root, "tests/value.test.cjs"),
      "const {test}=require('node:test');const assert=require('node:assert/strict');const value=require('../src/value.cjs');test('value',()=>assert.equal(value,2));\n");
    await writeFile(join(root, "tests/unrelated.test.cjs"),
      "const {test}=require('node:test');test('existing unrelated failure',()=>{throw Error('existing');});\n");
    const { git } = await import("../src/repo/commands.js");
    await git(root, "init", "-q");
    await git(root, "config", "user.name", "Test");
    await git(root, "config", "user.email", "test@example.test");
    await git(root, "add", ".");
    await git(root, "commit", "-qm", "baseline");
    const repo = await profileRepo(root);
    const settings = await config(undefined, { maxIterations: 1 });
    const logger = new Logger(join(logs, "events"), "root-focused", true);
    let mutations = 0;
    const result = await implement({ config: settings, logger, budget: new Budget(1, 100000, 60000) } as any,
      root, "Correct the internal value in one file", { ...makeSubtask(["."]), id: "stable",
        title: "Correct internal value", objective: "Correct the internal value in src/value.cjs to 2",
        integrationContract: "value equals 2", estimatedDifficulty: "low" },
      { acceptanceCriteria: ["value equals 2"] }, repo, {
        codingWorker: { engine: "agentic", async run(input) {
          assert.equal(input.returnOnMutation, true);
          assert.deepEqual(input.writeScope, ["."]);
          mutations++;
          await writeFile(join(root, "src/value.cjs"), "module.exports = 2;\n");
          return { exitStatus: "completed", model: input.model, engine: "agentic", engineVersion: "test",
            changedPaths: ["src/value.cjs"], wallClockMs: 1, terminationReason: "candidate_ready_for_verification" };
        } },
      });
    assert.equal(mutations, 1);
    assert.equal(result.verification.status, "VERIFIED_SUCCESS");
    const checks = logger.events.filter((event) => event.type === "verification");
    assert.ok(checks.length > 0);
    assert.ok(checks.every((check) => check.command !== "npm test" && check.command !== "pnpm test"));
    assert.equal(checks.filter((check) => check.command === "node --test 'tests/value.test.cjs'").length, 1,
      "a passing authoritative candidate check does not need a redundant baseline rerun");
    assert.ok(result.verification.checks.some((check) => check.kind === "typecheck"));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(logs, { recursive: true, force: true });
  }
});

test("a provider failure after mutation hands the candidate to deterministic verification", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { implement } = await import("../src/agent/codingExecutor.js");
  const { profileRepo } = await import("../src/repo/profiler.js");
  const { config } = await import("../src/config.js");
  const { Logger } = await import("../src/telemetry/logger.js");
  const { Budget } = await import("../src/openrouter/usage.js");
  const { git } = await import("../src/repo/commands.js");
  const root = await mkdtemp(join(tmpdir(), "koda-provider-after-mutation-"));
  const logs = await mkdtemp(join(tmpdir(), "koda-provider-after-mutation-logs-"));
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "tests"));
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: {
      test: "node --test tests/*.test.cjs", typecheck: "node --check src/value.cjs",
    } }));
    await writeFile(join(root, "src/value.cjs"), "module.exports = 1;\n");
    await writeFile(join(root, "tests/value.test.cjs"),
      "const {test}=require('node:test');const assert=require('node:assert/strict');const value=require('../src/value.cjs');test('value',()=>assert.equal(value,2));\n");
    await git(root, "init", "-q");
    await git(root, "config", "user.name", "Test");
    await git(root, "config", "user.email", "test@example.test");
    await git(root, "add", ".");
    await git(root, "commit", "-qm", "baseline");
    const repo = await profileRepo(root);
    const logger = new Logger(logs, "provider-after-mutation", true);
    const result = await implement(
      { config: await config(undefined, { maxIterations: 1 }), logger,
        budget: new Budget(1, 100000, 60000) } as any,
      root,
      "Change the internal value to 2",
      { ...makeSubtask(["src/value.cjs"]), id: "direct", title: "Change value",
        objective: "Change src/value.cjs to export 2", estimatedDifficulty: "low" },
      { acceptanceCriteria: ["src/value.cjs exports 2"] },
      repo,
      {
        codingWorker: { engine: "agentic", async run(input) {
          await writeFile(join(root, "src/value.cjs"), "module.exports = 2;\n");
          return { exitStatus: "infra_failure", model: input.model, engine: "agentic",
            engineVersion: "test", changedPaths: ["src/value.cjs"], wallClockMs: 1,
            terminationReason: "agentic_provider_error", progressPhase: "MUTATION_OBSERVED",
            fatalError: "HTTP 402 after mutation" };
        } },
        completionReviewer: async (input) => ({
          passed: true,
          requirements: input.requirements.map(({ id }) =>
            ({ id, satisfied: true, evidence: "export is 2" })),
          summary: "All requirements are present",
        }),
      },
    );
    assert.equal(result.verification.status, "VERIFIED_SUCCESS");
    assert.equal(await import("node:fs/promises").then(({ readFile }) =>
      readFile(join(root, "src/value.cjs"), "utf8")), "module.exports = 2;\n");
    assert.ok(logger.events.some((event) => event.type === "candidate_verification_handoff"));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(logs, { recursive: true, force: true });
  }
});

test("unresolved root context retrieves relevant source and test setup beyond the file prefix", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { rootCodingContext } = await import("../src/agent/codingExecutor.js");
  const { profileRepo } = await import("../src/repo/profiler.js");
  const { config } = await import("../src/config.js");
  const root = await mkdtemp(join(tmpdir(), "koda-root-context-"));
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "checks"));
    await writeFile(join(root, "src/dispatch.ts"), "// unrelated prefix\n".repeat(1000) +
      "export function deliveryMetadata() { return { chosen_engine: 'local', estimated_spend: 0.25 }; }\n");
    await writeFile(join(root, "checks/dispatch.spec.ts"),
      "import { deliveryMetadata } from '../src/dispatch.js';\n// Existing deliveryMetadata test setup\n");
    await writeFile(join(root, "src/unrelated.ts"), "export const greeting = 'hello';\n");
    const repo = await profileRepo(root);
    const limits = (await config()).context;
    const context = await rootCodingContext(root,
      "Add a test for deliveryMetadata chosen_engine and estimated_spend", repo, limits);
    assert.ok(context.files.some((file) => file.path === "src/dispatch.ts" &&
      file.snippet.includes("chosen_engine") && file.snippet.includes("estimated_spend")));
    assert.ok(context.files.some((file) => file.path === "checks/dispatch.spec.ts"));
    assert.ok(context.files.every((file) => file.path !== "src/unrelated.ts"));
    assert.ok(Buffer.byteLength(JSON.stringify(context)) <= limits.maxBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unresolved root context gives repository path terms enough weight to locate the named subsystem", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { rootCodingContext } = await import("../src/agent/codingExecutor.js");
  const { profileRepo } = await import("../src/repo/profiler.js");
  const { config } = await import("../src/config.js");
  const root = await mkdtemp(join(tmpdir(), "koda-root-path-context-"));
  try {
    await mkdir(join(root, "src", "verifier"), { recursive: true });
    await mkdir(join(root, "src", "router"), { recursive: true });
    await writeFile(join(root, "src", "verifier", "selection.ts"),
      "export function focusedVerificationCheck() { return 'targeted'; }\n");
    await writeFile(join(root, "src", "router", "features.ts"),
      "export const implementation = 'verification command changed path focused';\n");
    await writeFile(join(root, "src", "router", "taskFingerprint.ts"),
      "export const coverage = 'verification command changed path focused implementation';\n");
    const repo = await profileRepo(root);
    const limits = (await config()).context;
    const context = await rootCodingContext(root,
      "Use the existing verification-selection implementation to produce a focused verification command",
      repo, { ...limits, maxFiles: 1 });
    assert.equal(context.files[0]?.path, "src/verifier/selection.ts");
    assert.match(context.files[0]?.snippet ?? "", /focusedVerificationCheck/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

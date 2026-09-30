import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { config } from "../src/config.js";
import { git } from "../src/repo/commands.js";
import { profileRepo } from "../src/repo/profiler.js";
import {
  planningPolicy,
  reconcilePlannedPaths,
  validatePlanningCandidate,
} from "../src/planner/policy.js";
import { compileTask } from "../src/planner/taskCompiler.js";
import { rankPlanners, selectPlanner } from "../src/planner/routing.js";
import { normalizePlan } from "../src/orchestrator/coalesce.js";
import { schedule } from "../src/orchestrator/scheduler.js";
import { Gateway } from "../src/openrouter/client.js";
import { Budget } from "../src/openrouter/usage.js";
import { Logger } from "../src/telemetry/logger.js";
import { run } from "./helpers/run.js";
import { extractFeatures } from "../src/router/features.js";
import { rankCandidates } from "../src/router/modelRouter.js";
import type { Attempt } from "../src/router/history.js";
import { planSchema } from "../src/planner/schemas.js";
import { AgentTools } from "../src/agent/tools.js";
import { implement } from "../src/agent/loop.js";

const task =
  "Fix src/a.ts, src/b.ts and src/c.ts so all tests pass. These are independent bugs.";
const pool = {
  provider: "openrouter",
  models: [
    {
      id: "fast",
      tier: "fast",
      qualityPrior: 0.94,
      latencyPriorMs: 1000,
      strengths: ["coding", "tool_use", "structured_output"],
      fallback: {
        inputPrice: 0.1,
        outputPrice: 0.2,
        supportedParameters: [
          "tools",
          "tool_choice",
          "structured_outputs",
          "response_format",
        ],
      },
    },
    {
      id: "strong",
      tier: "strong",
      qualityPrior: 0.99,
      latencyPriorMs: 6000,
      strengths: [
        "coding",
        "tool_use",
        "structured_output",
        "repo_scale",
        "reasoning",
      ],
      fallback: {
        inputPrice: 1,
        outputPrice: 2,
        supportedParameters: [
          "tools",
          "tool_choice",
          "structured_outputs",
          "response_format",
        ],
      },
    },
  ],
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "koda-planner-"));
  const repo = join(root, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "test"));
  await writeFile(
    join(repo, "package.json"),
    JSON.stringify({
      type: "module",
      scripts: { test: "node --test test/*.test.ts" },
    }),
  );
  for (const id of ["a", "b", "c"]) {
    await writeFile(
      join(repo, `src/${id}.ts`),
      `export function ${id}(){return 0}\n`,
    );
    await writeFile(
      join(repo, `test/${id}.test.ts`),
      `import {test} from 'node:test'; import assert from 'node:assert/strict'; import {${id}} from '../src/${id}.ts'; test('${id}',()=>assert.equal(${id}(),1));\n`,
    );
  }
  await git(repo, "init", "-q");
  await git(repo, "config", "user.email", "test@koda.local");
  await git(repo, "config", "user.name", "Koda Test");
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "broken");
  return {
    root,
    repo,
    async cleanup() {
      for (const line of (
        await git(repo, "worktree", "list", "--porcelain")
      ).split("\n"))
        if (line.startsWith("worktree ") && !line.endsWith("/repo"))
          await git(repo, "worktree", "remove", "--force", line.slice(9));
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("model-planned missing paths reconcile to unique real files and optional test edits disappear", async () => {
  const f = await fixture();
  try {
    const profile = await profileRepo(f.repo);
    const candidate = validatePlanningCandidate({
      taskSummary: "repair",
      acceptanceCriteria: ["tests pass"],
      subtasks: [
        {
          id: "fix",
          title: "Fix imagined/a.ts",
          objective: "Fix imagined/a.ts",
          dependsOn: [],
          likelyReadPaths: ["imagined/a.ts", "imagined/a.test.ts"],
          likelyWritePaths: ["imagined/a.ts"],
          integrationContract: "Preserve exports",
          verificationCommands: [],
          estimatedDifficulty: "normal",
          parallelSafe: false,
        },
        {
          id: "test",
          title: "Add a test",
          objective: "Add a test for the fix",
          dependsOn: ["fix"],
          likelyReadPaths: ["test/nonexistent.test.ts"],
          likelyWritePaths: ["test/nonexistent.test.ts"],
          integrationContract: "Check behavior",
          verificationCommands: [],
          estimatedDifficulty: "low",
          parallelSafe: false,
        },
      ],
    });
    const reconciled = await reconcilePlannedPaths(
      candidate,
      "Fix the bug in src/a.ts so tests pass. Do not modify tests.",
      profile,
    );
    assert.equal(reconciled.subtasks.length, 1);
    assert.deepEqual(reconciled.subtasks[0]!.likelyWritePaths, ["src/a.ts"]);
    assert.ok(
      reconciled.subtasks[0]!.likelyReadPaths.includes("test/a.test.ts"),
    );
    assert.ok(!reconciled.subtasks[0]!.objective.includes("imagined/a.ts"));
  } finally {
    await f.cleanup();
  }
});

test("model plan cannot omit an evidence-backed implementation target", async () => {
  const f = await fixture();
  try {
    const profile = await profileRepo(f.repo);
    const incomplete = validatePlanningCandidate({
      taskSummary: "repair a and b",
      acceptanceCriteria: ["tests pass"],
      subtasks: [
        {
          id: "fix-a",
          title: "Fix a",
          objective: "Fix src/a.ts",
          dependsOn: [],
          likelyReadPaths: ["src/a.ts", "test/a.test.ts"],
          likelyWritePaths: ["src/a.ts"],
          integrationContract: "Preserve exports",
          verificationCommands: ["node --test test/a.test.ts"],
          estimatedDifficulty: "normal",
          parallelSafe: true,
        },
      ],
    });
    await assert.rejects(
      reconcilePlannedPaths(incomplete, task, profile, [
        "src/a.ts",
        "src/b.ts",
      ]),
      /omitted evidence-backed mutation targets: src\/b\.ts/,
    );
  } finally {
    await f.cleanup();
  }
});

test("explicit test creation keeps its scoped new path; unresolved source ownership fails boundedly", async () => {
  const f = await fixture();
  try {
    const profile = await profileRepo(f.repo);
    const planned = (path: string) =>
      validatePlanningCandidate({
        taskSummary: "task",
        acceptanceCriteria: ["repo checks pass"],
        subtasks: [
          {
            id: "work",
            title: "Work",
            objective: "Work",
            dependsOn: [],
            likelyReadPaths: [],
            likelyWritePaths: [path],
            integrationContract: "Preserve behavior",
            verificationCommands: [],
            estimatedDifficulty: "normal",
            parallelSafe: false,
          },
        ],
      });
    const tests = await reconcilePlannedPaths(
      planned("test/new.test.ts"),
      "Add a regression test for the source behavior",
      profile,
    );
    assert.deepEqual(tests.subtasks[0]!.likelyWritePaths, ["test/new.test.ts"]);
    await assert.rejects(
      reconcilePlannedPaths(
        planned("src/nonexistent.ts"),
        "Fix the source bug",
        profile,
      ),
      /does not exist/,
    );
  } finally {
    await f.cleanup();
  }
});

test("missing read tool navigates to actual source once and bounds repeated misses", async () => {
  const f = await fixture();
  try {
    const logger = new Logger(
      join(f.root, "navigation-log"),
      "navigation",
      true,
    );
    const tools = new AgentTools(f.repo, false, 1000, logger, "navigation");
    const result = await tools.execute("read_file", { path: "imagined/a.ts" });
    assert.match(String(result), /src\/a\.ts/);
    assert.match(String(result), /export function a/);
    assert.equal(
      logger.events.filter((event) => event.type === "missing_path_navigation")
        .length,
      1,
    );
    await tools.execute("read_file", { path: "imagined/a.ts" });
    assert.equal(tools.missingReadAttempts.get("imagined/a.ts"), 2);
    const before = tools.progressEvidence.length;
    const unknown = JSON.parse(
      String(
        await tools.execute("read_file", {
          path: "imagined/definitely_absent_zzz.ts",
        }),
      ),
    );
    assert.equal(unknown.source, undefined);
    assert.equal(
      tools.progressEvidence.length,
      before,
      "an unresolved path must not count as inspection progress",
    );
    assert.equal(await git(f.repo, "status", "--porcelain"), "");
  } finally {
    await f.cleanup();
  }
});

for (const outcome of [
  "passing",
  "failing",
  "infrastructure",
  "unrecoverable",
] as const)
  test(`PLANNED worker recovers verification after write: ${outcome}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "koda-post-write-"));
    const repo = join(root, "repo");
    await mkdir(repo);
    await writeFile(join(repo, "module.py"), "# implementation pending\n");
    await git(repo, "init", "-q");
    await git(repo, "config", "user.email", "test@koda.local");
    await git(repo, "config", "user.name", "Koda Test");
    await git(repo, "add", ".");
    await git(repo, "commit", "-qm", "baseline");
    const mockServer = await mock(() => ({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "write",
          type: "function",
          function: {
            name: "write_file",
            arguments: JSON.stringify({
              path: "module.py",
              content:
                outcome === "passing"
                  ? "def add(a, b):\n    return a + b\n"
                  : outcome === "infrastructure"
                    ? "def add(a, b):\n    raise PermissionError('/outside/environment/pyvenv.cfg: Operation not permitted')\n"
                    : "def add(a, b):\n    return a - b\n",
            }),
          },
        },
      ],
    }));
    try {
      const task =
        outcome === "unrecoverable"
          ? "Repair module.py"
          : "Repair module.py: add(2, 3) == 5";
      const subtask = {
        id: "planned-fix",
        title: task,
        objective: task,
        dependsOn: [],
        likelyReadPaths: ["module.py"],
        likelyWritePaths: ["module.py"],
        integrationContract: "Preserve behavior",
        verificationCommands: [],
        estimatedDifficulty: "normal" as const,
        parallelSafe: false,
      };
      const logger = new Logger(join(root, "report"), "planned-recovery", true);
      const gateway = new Gateway(
        await config(undefined, {
          modelPool: pool,
          baseUrl: mockServer.url,
          maxIterations: 3,
        }),
        logger,
        new Budget(0.1, 200000, 60000),
      );
      const execute = () =>
        implement(
          gateway,
          repo,
          task,
          subtask,
          { acceptanceCriteria: [task], subtasks: [subtask] },
          awaitProfile,
          {},
        );
      const awaitProfile = await profileRepo(repo);
      if (outcome === "failing" || outcome === "infrastructure") {
        await assert.rejects(execute());
        assert.ok(
          !logger.events.some((event) => event.type === "verified_completion"),
        );
        assert.ok(
          logger.events.some(
            (event) =>
              event.type === "verification" &&
              event.outcome ===
                (outcome === "failing" ? "CHECK_FAIL" : "INFRA_FAILURE"),
          ),
        );
        if (outcome === "infrastructure") {
          assert.equal(
            logger.events.filter((event) => event.type === "escalation").length,
            0,
          );
          assert.equal(
            logger.events.find((event) => event.type === "verification")
              ?.infrastructureRecoveryAttempts,
            1,
          );
        }
      } else {
        const result = await execute();
        assert.equal(
          result.verification.status,
          outcome === "passing" ? "VERIFIED_SUCCESS" : "NOT_FULLY_VERIFIED",
        );
      }
      assert.equal(
        logger.events.filter(
          (event) => event.type === "verification_recovery_attempt",
        ).length,
        1,
      );
      assert.ok(
        logger.events.some(
          (event) =>
            event.type ===
            (outcome === "unrecoverable"
              ? "verification_recovery_exhausted"
              : "verification_recovery"),
        ),
      );
      assert.equal(
        await git(repo, "status", "--porcelain"),
        outcome === "failing" ? "" : " M module.py",
      );
    } finally {
      await mockServer.close();
      await rm(root, { recursive: true, force: true });
    }
  });
for (const mutate of [false, true])
  test(`a pre-existing failing check does not escalate after ${mutate ? "an unrelated edit" : "a zero-diff final response"}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "koda-baseline-fail-"));
    const repo = join(root, "repo");
    await mkdir(join(repo, "tests"), { recursive: true });
    await writeFile(
      join(repo, "package.json"),
      JSON.stringify({
        type: "module",
        scripts: { test: "node --test tests/*.test.mjs" },
      }),
    );
    await writeFile(join(repo, "src.mjs"), "export const value = 0;\n");
    await writeFile(
      join(repo, "tests/preexisting.test.mjs"),
      "import {test} from 'node:test'; import assert from 'node:assert/strict'; test('preexisting',()=>assert.equal(0,1));\n",
    );
    await git(repo, "init", "-q");
    await git(repo, "config", "user.email", "test@koda.local");
    await git(repo, "config", "user.name", "Koda Test");
    await git(repo, "add", ".");
    await git(repo, "commit", "-qm", "baseline");
    const mockServer = await mock(() =>
      mutate
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "write",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({
                    path: "src.mjs",
                    content: "export const value = 1;\n",
                  }),
                },
              },
            ],
          }
        : {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "verify",
                type: "function",
                function: {
                  name: "run_command",
                  arguments: JSON.stringify({ command: "npm run test" }),
                },
              },
            ],
          },
    );
    try {
      const objective = "Fix src.mjs while preserving existing test behavior";
      const subtask = {
        id: "fix",
        title: objective,
        objective,
        dependsOn: [],
        likelyReadPaths: ["src.mjs"],
        likelyWritePaths: ["src.mjs"],
        integrationContract: "Run tests",
        verificationCommands: ["npm run test"],
        estimatedDifficulty: "normal" as const,
        parallelSafe: false,
      };
      const logger = new Logger(join(root, "report"), "baseline-fail", true);
      const gateway = new Gateway(
        await config(undefined, {
          modelPool: pool,
          baseUrl: mockServer.url,
          maxIterations: 3,
        }),
        logger,
        new Budget(0.1, 200000, 60000),
      );
      const result = await implement(
        gateway,
        repo,
        objective,
        subtask,
        { acceptanceCriteria: [objective], subtasks: [subtask] },
        await profileRepo(repo),
        {},
      ).catch((error) => {
        throw Error(
          `${String(error)}; checks=${JSON.stringify(logger.events.filter((event) => event.type === "verification"))}`,
        );
      });
      assert.equal(
        result.verification.status,
        mutate ? "CANDIDATE_NEUTRAL" : "NOT_FULLY_VERIFIED",
      );
      assert.ok(
        logger.events.some(
          (event) => event.type === "verification_baseline_unchanged",
        ),
      );
      assert.equal(
        logger.events.filter((event) => event.type === "escalation").length,
        0,
      );
      assert.equal(
        await readFile(join(repo, "src.mjs"), "utf8"),
        mutate ? "export const value = 1;\n" : "export const value = 0;\n",
      );
      if (!mutate)
        assert.equal(
          logger.events.filter((event) => event.type === "model_call").length,
          1,
        );
    } finally {
      await mockServer.close();
      await rm(root, { recursive: true, force: true });
    }
  });
test("coding worker honors an evidence-backed multi-file scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-sibling-fix-"));
  const repo = join(root, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "tests"));
  await writeFile(
    join(repo, "package.json"),
    JSON.stringify({
      type: "module",
      scripts: { test: "node --test tests/*.test.mjs" },
    }),
  );
  await writeFile(
    join(repo, "src/a.mjs"),
    'import {value} from "./b.mjs"; export const result = value;\n',
  );
  await writeFile(join(repo, "src/b.mjs"), "export const value = 0;\n");
  await writeFile(
    join(repo, "tests/feature.test.mjs"),
    "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {result} from '../src/a.mjs'; test('feature',()=>assert.equal(result,1));\n",
  );
  await git(repo, "init", "-q");
  await git(repo, "config", "user.email", "test@koda.local");
  await git(repo, "config", "user.name", "Koda Test");
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "baseline");
  const mockServer = await mock(() => ({
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "write",
        type: "function",
        function: {
          name: "write_file",
          arguments: JSON.stringify({
            path: "src/b.mjs",
            content: "export const value = 1;\n",
          }),
        },
      },
    ],
  }));
  try {
    const objective =
      "Fix src/b.mjs used by src/a.mjs so the feature test passes";
    const subtask = {
      id: "fix",
      title: objective,
      objective,
      dependsOn: [],
      likelyReadPaths: ["src/a.mjs", "src/b.mjs"],
      likelyWritePaths: ["src/a.mjs", "src/b.mjs"],
      integrationContract: "Feature test passes",
      verificationCommands: ["npm run test"],
      estimatedDifficulty: "normal" as const,
      parallelSafe: false,
    };
    const logger = new Logger(join(root, "report"), "sibling-fix", true);
    const gateway = new Gateway(
      await config(undefined, {
        modelPool: pool,
        baseUrl: mockServer.url,
        maxIterations: 4,
      }),
      logger,
      new Budget(0.1, 200000, 60000),
    );
    const result = await implement(
      gateway,
      repo,
      objective,
      subtask,
      { acceptanceCriteria: [objective], subtasks: [subtask] },
      await profileRepo(repo),
      {},
    );
    assert.equal(result.verification.status, "VERIFIED_SUCCESS");
    assert.deepEqual(subtask.likelyWritePaths, ["src/a.mjs", "src/b.mjs"]);
    assert.equal(
      logger.events.filter((event) => event.type === "write_scope_expanded")
        .length,
      0,
    );
    assert.equal(
      await readFile(join(repo, "src/b.mjs"), "utf8"),
      "export const value = 1;\n",
    );
  } finally {
    await mockServer.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("worker attempts are transactional: regressed patch rolls back before stronger model succeeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-transactional-"));
  const repo = join(root, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "tests"));
  await writeFile(
    join(repo, "package.json"),
    JSON.stringify({
      type: "module",
      scripts: { test: "node --test tests/*.test.mjs" },
    }),
  );
  await writeFile(join(repo, "src/value.mjs"), "export const value = 0;\n");
  await writeFile(
    join(repo, "tests/value.test.mjs"),
    `import {test} from 'node:test';
import assert from 'node:assert/strict';
import {value} from '../src/value.mjs';
test('first',()=>assert.equal(value,1));
test('second',()=>assert.equal(value,1));
test('no negative regression',()=>assert.notEqual(value,-1));
`,
  );
  await git(repo, "init", "-q");
  await git(repo, "config", "user.email", "test@koda.local");
  await git(repo, "config", "user.name", "Koda Test");
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "baseline");
  const served: string[] = [];
  let cleanBeforeStrong = false;
  let handoffHadFailure = false;
  const mockServer = await mock((body) => {
    served.push(body.model);
    if (body.model === "strong") {
      cleanBeforeStrong =
        readFileSync(join(repo, "src/value.mjs"), "utf8") ===
        "export const value = 0;\n";
      handoffHadFailure =
        JSON.stringify(body.messages).includes("REJECTED ATTEMPT DIFF") &&
        JSON.stringify(body.messages).includes("value = -1");
    }
    return {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: `write-${served.length}`,
          type: "function",
          function: {
            name: "write_file",
            arguments: JSON.stringify({
              path: "src/value.mjs",
              content:
                body.model === "strong"
                  ? "export const value = 1;\n"
                  : "export const value = -1;\n",
            }),
          },
        },
      ],
    };
  });
  try {
    const objective = "Fix src/value.mjs so all tests pass";
    const subtask = {
      id: "fix",
      title: objective,
      objective,
      dependsOn: [],
      likelyReadPaths: ["src/value.mjs", "tests/value.test.mjs"],
      likelyWritePaths: ["src/value.mjs"],
      integrationContract: "Tests pass",
      verificationCommands: ["npm run test"],
      estimatedDifficulty: "normal" as const,
      parallelSafe: false,
    };
    const logger = new Logger(join(root, "report"), "transactional", true);
    const gateway = new Gateway(
      await config(undefined, {
        modelPool: pool,
        baseUrl: mockServer.url,
        adaptiveCoding: false,
        specialistRouting: false,
        maxIterations: 6,
        routing: { stateDirectory: join(root, "history") },
      }),
      logger,
      new Budget(0.1, 200000, 60000),
    );
    const result = await implement(
      gateway,
      repo,
      objective,
      subtask,
      { acceptanceCriteria: [objective], subtasks: [subtask] },
      await profileRepo(repo),
      {},
    ).catch((error) => {
      throw Error(
        `${String(error)}; attempts=${JSON.stringify(
          logger.events.filter((event) =>
            [
              "attempt_evaluation",
              "attempt_rollback",
              "coding_route_escalation",
              "verification",
            ].includes(event.type),
          ),
        )}`,
      );
    });
    assert.equal(result.verification.status, "VERIFIED_SUCCESS");
    assert.deepEqual(served, ["fast", "strong"]);
    assert.equal(cleanBeforeStrong, true);
    assert.equal(handoffHadFailure, true);
    assert.equal(
      await readFile(join(repo, "src/value.mjs"), "utf8"),
      "export const value = 1;\n",
    );
    assert.equal(
      logger.events.filter((event) => event.type === "attempt_rollback").length,
      1,
    );
    assert.equal(
      logger.events.filter(
        (event) => event.type === "attempt_checkpoint_promoted",
      ).length,
      1,
    );
  } finally {
    await mockServer.close();
    await rm(root, { recursive: true, force: true });
  }
});
async function mock(
  handler: (body: any) => any | Promise<any>,
  catalogModels: any[] = pool.models,
) {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith("/models")) {
      res.end(
        JSON.stringify({
          data: catalogModels.map((m) => ({
            id: m.id,
            context_length: 100000,
            pricing: {
              prompt: m.unknownPricing
                ? undefined
                : String((m.inputPrice ?? 0.1) / 1e6),
              completion: m.unknownPricing
                ? undefined
                : String((m.outputPrice ?? 0.2) / 1e6),
            },
            supported_parameters: ["tools", "tool_choice", "structured_outputs"],
          })),
        }),
      );
      return;
    }
    try {
      let raw = "";
      for await (const c of req) raw += c;
      const body = JSON.parse(raw);
      requests.push(body);
      const message = await handler(body);
      res.end(
        JSON.stringify({
          id: "mock",
          model: body.model,
          choices: [
            {
              index: 0,
              message,
              finish_reason: message.tool_calls ? "tool_calls" : "stop",
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.00001 },
        }),
      );
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(e) }));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    requests,
    url: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
const response = (content: unknown) => ({
  role: "assistant",
  content: typeof content === "string" ? content : JSON.stringify(content),
});
for (const finalFailure of [false, true])
  test(`deterministic planner executes three generic isolated repairs; final failure=${finalFailure}`, async () => {
    const f = await fixture();
    const m = await mock(async (body) => {
      assert.ok(
        !body.messages[0].content.startsWith("Compile"),
        "no planner HTTP request",
      );

      // Keep otherwise-instant mock coding calls alive briefly so this test
      // deterministically observes the scheduler's real parallel worker
      // overlap. The assertion below remains strict: Koda must actually run
      // independent workers concurrently.
      await new Promise((resolve) => setTimeout(resolve, 75));

      const input = JSON.parse(body.messages[1].content);
      const path = input.subtask.likelyWritePaths[0],
        id = path.match(/([abc])\.ts$/)[1];
      assert.deepEqual(input.allowed_write_paths, [path]);
      return {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "edit",
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({
                path,
                content: `export function ${id}(){return 1}\n`,
              }),
            },
          },
        ],
      };
    });
    try {
      const c = await config(undefined, {
        modelPool: pool,
        baseUrl: m.url,
        routing: { stateDirectory: join(f.root, "history") },
        maxParallel: 3,
        budgetUsd: 0.1,
      });
      const result = await run({
        repo: f.repo,
        task,
        config: c,
        quiet: true,
        output: join(f.root, "report"),
        verify: finalFailure
          ? [
              "node -e \"import('./src/a.ts').then(({a})=>process.exit(Number(a()===1)))\"",
            ]
          : undefined,
      });
      assert.equal(result.execution_strategy, "planned");
      assert.equal(
        result.status,
        finalFailure ? "FAILED" : "VERIFIED_SUCCESS",
        result.error,
      );
      assert.equal(result.planning.planner_strategy, "deterministic");
      assert.equal(result.planning.planner_complexity, "trivial");
      assert.equal(result.planning.planner_cost, 0);
      assert.equal(result.planning.planning_tokens, 0);
      assert.equal(result.plannerModelCalls, 0);
      assert.equal(result.planning.planner_model, null);
      assert.equal(result.planning.planner_fallback_count, 0);
      assert.equal(result.coderExecutions, 3);
      assert.equal(m.requests.length, 3);
      assert.ok(result.maxConcurrentCodingWorkers >= 2);
      assert.equal(
        new Set(result.workerScopes.flatMap((s) => s.allowed_write_paths)).size,
        3,
      );
      assert.equal(result.escalations, 0);
      const events = (
        await readFile(join(f.root, "report/events.jsonl"), "utf8")
      )
        .trim()
        .split("\n")
        .map((s) => JSON.parse(s));
      assert.equal(events.filter((e) => e.type === "integrated").length, 3);
      assert.ok(events.some((e) => e.type === "final_verification"));
      assert.equal(await git(f.repo, "status", "--porcelain"), "");
    } finally {
      await m.close();
      await f.cleanup();
    }
  });

test("explicit dependent source targets plan locally, run independent roots in parallel, and start with the economical quality-peer", async () => {
  const f = await fixture();
  await writeFile(
    join(f.repo, "src/c.ts"),
    "import {a} from './a.ts'; import {b} from './b.ts'; export function c(){return a()+b()}\n",
  );
  await git(f.repo, "add", ".");
  await git(f.repo, "commit", "-qm", "dependent broken sources");
  const solutions: Record<string, string> = {
    "src/a.ts": "export function a(){return 1}\n",
    "src/b.ts": "export function b(){return 1}\n",
    "src/c.ts":
      "import {a} from './a.ts'; import {b} from './b.ts'; export function c(){return a()+b()-1}\n",
  };
  const economicalPool = {
    provider: "openrouter",
    models: [
      {
        ...pool.models[0],
        id: "economical-quality-peer",
        tier: "cheap",
        qualityPrior: 0.985,
        latencyPriorMs: 500,
        fallback: {
          ...pool.models[0]!.fallback,
          inputPrice: 0.05,
          outputPrice: 0.1,
        },
      },
      {
        ...pool.models[1],
        id: "frontier-reference",
        tier: "frontier",
        qualityPrior: 0.99,
        latencyPriorMs: 5000,
        fallback: {
          ...pool.models[1]!.fallback,
          inputPrice: 5,
          outputPrice: 20,
        },
      },
    ],
  };
  const m = await mock(async (body) => {
    assert.ok(
      !body.messages[0].content.startsWith("Compile"),
      "repository-backed dependency planning must not call a planner model",
    );
    await new Promise((resolve) => setTimeout(resolve, 75));
    const input = JSON.parse(body.messages[1].content);
    const path = input.allowed_write_paths[0];
    assert.deepEqual(input.allowed_write_paths, [path]);
    assert.ok(solutions[path], `unexpected write target: ${path}`);
    return {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: `edit-${path}`,
          type: "function",
          function: {
            name: "write_file",
            arguments: JSON.stringify({ path, content: solutions[path] }),
          },
        },
      ],
    };
  }, economicalPool.models);
  try {
    const result = await run({
      repo: f.repo,
      task: "Fix src/a.ts, src/b.ts and src/c.ts so their focused tests pass.",
      config: await config(undefined, {
        modelPool: economicalPool,
        baseUrl: m.url,
        routing: { stateDirectory: join(f.root, "economic-history") },
        maxParallel: 3,
        budgetUsd: 0.1,
      }),
      quiet: true,
      output: join(f.root, "economic-report"),
    });
    assert.equal(result.status, "VERIFIED_SUCCESS", result.error);
    assert.equal(result.execution_strategy, "planned");
    assert.equal(result.planning.planner_strategy, "deterministic");
    assert.equal(result.plannerModelCalls, 0);
    assert.equal(result.coderExecutions, 3);
    assert.ok(result.maxConcurrentCodingWorkers >= 2);
    assert.equal(m.requests.length, 3);
    assert.ok(
      m.requests.every((request) =>
        request.model === "economical-quality-peer"),
      JSON.stringify(m.requests.map((request) => request.model)),
    );
    const plan = JSON.parse(
      await readFile(join(f.root, "economic-report/plan.json"), "utf8"),
    );
    const byPath = new Map<string, any>(
      plan.subtasks.map((subtask: any) => [
        subtask.likelyWritePaths[0],
        subtask,
      ]),
    );
    assert.deepEqual(byPath.get("src/a.ts")!.dependsOn, []);
    assert.deepEqual(byPath.get("src/b.ts")!.dependsOn, []);
    assert.deepEqual(new Set(byPath.get("src/c.ts")!.dependsOn), new Set([
      byPath.get("src/a.ts")!.id,
      byPath.get("src/b.ts")!.id,
    ]));
  } finally {
    await m.close();
    await f.cleanup();
  }
});

test("two explicitly independent concrete repairs skip planner and scout calls and overlap", async () => {
  const f = await fixture();
  try {
    const task =
      "Fix both independent bugs in src/a.ts and src/b.ts. They are independent repairs.";
    const profile = await profileRepo(f.repo);
    const c = await config(undefined, { models: {} });
    const policy = await planningPolicy(task, profile, c.planner);
    assert.equal(policy.strategy, "deterministic");
    assert.deepEqual(
      policy.candidate?.subtasks.map((subtask) => subtask.likelyWritePaths),
      [["src/a.ts"], ["src/b.ts"]],
    );
    assert.ok(
      policy.candidate?.subtasks.every(
        (subtask) => !subtask.readOnly && subtask.dependsOn.length === 0,
      ),
    );
    const gateway = new Gateway(
      c,
      new Logger(join(f.root, "local-plan"), "local-plan", true),
      new Budget(1, 100000, 60000),
    );
    (gateway as any).call = async () => {
      throw Error("planner/scout model call forbidden");
    };
    const plan = await compileTask(gateway, task, profile);
    assert.equal(
      gateway.logger.events.filter((event) => event.type === "model_call")
        .length,
      0,
    );
    let active = 0;
    const result = await schedule(plan.subtasks, 2, async () => {
      active++;
      await new Promise((resolve) => setTimeout(resolve, 15));
      active--;
    });
    assert.equal(active, 0);
    assert.equal(result.peak, 2);
  } finally {
    await f.cleanup();
  }
});

test("a bounded connected transaction flow is planned locally as one coding work unit", async () => {
  const f = await fixture();
  const transactionTask =
    "Fix the checkout transaction bug. A failed payment must leave inventory exactly as it was before checkout and must not create a successful payment record, while out-of-stock requests must never charge the customer and successful checkouts must reserve inventory exactly once. Unrelated checkout requests must remain independent. Investigate the relationships between checkout, inventory, and payment rather than assuming this is a single-file repair. Preserve the existing public APIs and do not modify tests.";
  try {
    await writeFile(join(f.repo, "package.json"), JSON.stringify({
      type: "module", scripts: { test: "node --test test/checkout.test.js" },
    }));
    await writeFile(join(f.repo, "src/inventory.js"),
      "export function reserve(stock,items){for(const [sku,n] of Object.entries(items))if((stock[sku]??0)<n)return false;for(const [sku,n] of Object.entries(items))stock[sku]-=n;return true}\nexport function release(stock,items){for(const [sku,n] of Object.entries(items))stock[sku]=(stock[sku]??0)+n}\n");
    await writeFile(join(f.repo, "src/payment.js"),
      "export async function charge(gateway,id,amount){return gateway.charge(id,amount)}\n");
    await writeFile(join(f.repo, "src/checkout.js"),
      "import {reserve} from './inventory.js'; import {charge} from './payment.js'; export async function checkout(x){if(!reserve(x.stock,x.items))return {ok:false,reason:'OUT_OF_STOCK'};await charge(x.gateway,x.customerId,x.amount);return {ok:true}}\n");
    await writeFile(join(f.repo, "test/checkout.test.js"),
      "import test from 'node:test'; import assert from 'node:assert/strict'; import {checkout} from '../src/checkout.js'; test('rollback',async()=>{const stock={a:1};await assert.rejects(checkout({stock,items:{a:1},gateway:{charge:async()=>{throw Error('declined')}},customerId:'c',amount:1}));assert.deepEqual(stock,{a:1})})\n");
    await git(f.repo, "add", ".");
    await git(f.repo, "commit", "-qm", "transaction fixture");
    // A previous run may have written its report below a non-git repository.
    // Its before/after source copies must not create false scope ambiguity.
    const report = join(f.repo, "previous-agent-output");
    await mkdir(join(report, "workspace/before/src"), { recursive: true });
    await writeFile(join(report, "events.jsonl"), "{}\n");
    await writeFile(join(report, "summary.json"), "{}\n");
    await writeFile(join(report, "workspace.json"), "{}\n");
    await writeFile(join(report, "candidate.patch"), "");
    await writeFile(
      join(report, "workspace/before/src/payment.js"),
      "export async function charge(){ throw Error('stale copy') }\n",
    );
    const profile = await profileRepo(f.repo);
    assert.ok(!profile.files.some((path) => path.startsWith("previous-agent-output/")));
    const c = await config(undefined, { models: {} });
    const policy = await planningPolicy(transactionTask, profile, c.planner);
    assert.equal(policy.strategy, "deterministic");
    assert.equal(policy.complexity, "trivial");
    assert.equal(policy.candidate?.subtasks.length, 1);
    assert.deepEqual(policy.candidate?.subtasks[0]?.likelyWritePaths,
      ["src/checkout.js", "src/inventory.js", "src/payment.js"]);
    assert.ok(policy.candidate?.subtasks[0]?.likelyReadPaths.includes(
      "test/checkout.test.js"));
    assert.equal(policy.candidate?.subtasks[0]?.parallelSafe, false);
    const gateway = new Gateway(c,
      new Logger(join(f.root, "transaction-plan"), "transaction-plan", true),
      new Budget(.1, 100000, 60000));
    (gateway as any).call = async () => {
      throw Error("connected local evidence must not invoke a planner model");
    };
    const plan = await compileTask(gateway, transactionTask, profile);
    assert.equal(plan.subtasks.length, 1);
    assert.equal(gateway.logger.events.filter((event) =>
      event.type === "model_call").length, 0);
  } finally {
    await f.cleanup();
  }
});

test("planner routing excludes endpoints that cannot enforce submit_plan", async () => {
  const c = await config(undefined, { modelPool: pool });
  const models = c.modelPool!.models;
  const metadata = new Map(models.map((model) => [model.id, {
    inputPrice: .1, outputPrice: .2, contextLength: 100000, available: true,
    routableParameterSets: model.id === "fast"
      ? [["tools"], ["tool_choice"]]
      : [["tools", "tool_choice"]],
    supportedParameters: ["tools", "tool_choice", "structured_outputs"],
  }]));
  const ranked = rankPlanners(models, metadata, [], "complex",
    c.planner, 1000, 1000);
  assert.equal(ranked.find((row) => row.model.id === "fast")?.rejected,
    "required planning tool protocol unsupported");
  assert.notEqual(ranked.find((row) => row.model.id === "strong")?.rejected,
    "required planning tool protocol unsupported");
});

test("deterministic gate maps bounded imports and refuses missing tests, ambiguous aliases, and extra requirements", async () => {
  const f = await fixture();
  try {
    const c = await config(undefined, { models: {} });
    const profile = await profileRepo(f.repo);
    assert.equal(
      (await planningPolicy(task, profile, c.planner)).strategy,
      "deterministic",
    );
    assert.equal(
      (
        await planningPolicy(
          "Repair the independent defects in src/a.ts and src/b.ts using their existing focused tests.",
          profile,
          c.planner,
        )
      ).strategy,
      "deterministic",
      "ordinary task wording must not force a paid planner or scouts when ownership is proven",
    );
    assert.equal(
      (
        await planningPolicy(
          "Fix both independent bugs in src/a.ts and src/b.ts. They are independent repairs. Make the smallest correct changes and verify all tests.",
          profile,
          c.planner,
        )
      ).strategy,
      "deterministic",
    );
    for (const text of [
      task + " Also change error handling.",
      "Refactor authentication and update the dependent API behavior.",
      "Fix src/a.ts and src/b.ts.",
      task.replace("independent", "not independent"),
    ])
      assert.equal(
        (await planningPolicy(text, profile, c.planner)).strategy,
        "model",
        text,
      );
    assert.equal(
      (
        await planningPolicy(
          task,
          {
            ...profile,
            files: profile.files.filter((p) => p !== "test/b.test.ts"),
          },
          c.planner,
        )
      ).strategy,
      "model",
    );
    const ambiguous = { ...profile, files: [...profile.files, "other/a.ts"] };
    assert.equal(
      (
        await planningPolicy(
          "Fix a.ts and b.ts. They are independent bugs.",
          ambiguous,
          c.planner,
        )
      ).strategy,
      "model",
    );
    await writeFile(
      join(f.repo, "src/a.ts"),
      "import {b} from './b.ts'; export function a(){return b()}",
    );
    const coupled = await planningPolicy(
      "Fix src/a.ts, src/b.ts and src/c.ts so their focused tests pass.",
      profile,
      c.planner,
    );
    assert.equal(coupled.strategy, "deterministic");
    assert.equal(coupled.complexity, "trivial");
    const byPath = new Map(
      coupled.candidate!.subtasks.map((subtask) => [
        subtask.likelyWritePaths[0],
        subtask,
      ]),
    );
    assert.deepEqual(byPath.get("src/a.ts")!.dependsOn, [
      byPath.get("src/b.ts")!.id,
    ]);
    assert.deepEqual(byPath.get("src/b.ts")!.dependsOn, []);
    assert.equal(
      coupled.candidate!.subtasks.length,
      3,
      "one source/test task per concrete target; no redundant model-planned task",
    );
    const gateway = new Gateway(
      c,
      new Logger(join(f.root, "dependent-local-plan"), "dependent-plan", true),
      new Budget(1, 100000, 60000),
    );
    (gateway as any).call = async () => {
      throw Error("bounded dependency graph must not call a model planner");
    };
    const compiled = await compileTask(
      gateway,
      "Fix src/a.ts, src/b.ts and src/c.ts so their focused tests pass.",
      profile,
    );
    assert.equal(compiled.subtasks.length, 3);
    assert.equal(
      gateway.logger.events.filter((event) => event.type === "model_call")
        .length,
      0,
    );
    const bounded = await planningPolicy(
      task,
      { ...profile, verificationCommands: Array(50).fill("x".repeat(2000)) },
      { ...c.planner, contextBytes: 1024 },
    );
    assert.ok(Buffer.byteLength(JSON.stringify(bounded.context)) <= 1024);
  } finally {
    await f.cleanup();
  }
});

for (const invalid of [
  "valid",
  "malformed",
  "dependency",
  "cycle",
  "ownership",
  "complex",
] as const)
  test(`model planner routes and validates: ${invalid}`, async () => {
    const f = await fixture();
    let good: any;
    const m = await mock((body) => {
      assert.ok(body.messages[0].content.startsWith("Compile"));
      assert.equal(body.max_tokens, 1800);
      assert.equal(body.tool_choice, "required");
      assert.deepEqual(
        body.tools.map((tool: any) => tool.function.name),
        ["submit_plan"],
      );
      const input = JSON.parse(body.messages[1].content);
      assert.ok(
        Buffer.byteLength(JSON.stringify(input.planningContext)) <= 6000,
      );
      if (invalid !== "complex")
        assert.ok(
          !body.messages[1].content.includes("return 0"),
          "no source dump for standard planner",
        );
      if (body.model === "fast" && invalid !== "valid") {
        if (invalid === "malformed")
          return response("invalid " + "X".repeat(5000));
        const bad = structuredClone(good);
        if (invalid === "dependency") bad.subtasks[0].dependsOn = ["missing"];
        if (invalid === "cycle") {
          bad.subtasks[0].dependsOn = [bad.subtasks[1].id];
          bad.subtasks[1].dependsOn = [bad.subtasks[0].id];
        }
        if (invalid === "ownership")
          bad.subtasks[0].likelyWritePaths = ["../escape.ts"];
        return response(bad);
      }
      if (body.messages.length === 3) {
        assert.ok(body.messages[2].content.length < 1100);
        assert.ok(!JSON.stringify(body.messages).includes("X".repeat(1000)));
        assert.equal(
          body.messages.filter((x: any) => x.role === "assistant").length,
          0,
        );
      }
      return invalid === "valid"
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "plan-control",
                type: "function",
                function: {
                  name: "submit_plan",
                  arguments: JSON.stringify(good),
                },
              },
            ],
          }
        : response(good);
    });
    try {
      const c = await config(undefined, {
        modelPool: pool,
        baseUrl: m.url,
        routing: { stateDirectory: join(f.root, "history") },
        budgetUsd: 0.1,
      });
      const profile = await profileRepo(f.repo);
      good = (await planningPolicy(task, profile, c.planner)).candidate!;
      const logger = new Logger(join(f.root, "log"), "planner", true);
      const gateway = new Gateway(c, logger, new Budget(0.1, 200000, 60000));
      const output = await compileTask(
        gateway,
        invalid === "complex"
          ? "Refactor authentication and update the dependent API behavior."
          : "Fix src/a.ts and src/b.ts; preserve behavior.",
        profile,
      );
      assert.equal(output.subtasks.length, 3);
      assert.deepEqual(
        m.requests.map((r) => r.model),
        invalid === "valid"
          ? ["fast"]
          : invalid === "complex"
            ? ["strong"]
            : ["fast", "strong"],
      );
      const summary = logger.events.find((e) => e.type === "planner_summary");
      assert.equal(summary.dag_valid, true);
      assert.equal(
        summary.planner_fallback_count,
        invalid === "valid" || invalid === "complex" ? 0 : 1,
      );
      const history = gateway.modelRouter!.history.read();
      assert.equal(history.at(-1)!.verification, "DAG_VALIDATED");
      assert.ok(history.every((r) => r.features.taskKind === "planning"));
      if (history.length === 2)
        assert.equal(history[0]!.verification, "FAILED");
    } finally {
      await m.close();
      await f.cleanup();
    }
  });

test("planner fallback re-ranks remaining qualified candidates within budget", async () => {
  const f = await fixture();
  const fallbackPool = {
    provider: "openrouter" as const,
    models: [
      {
        id: "malformed-fast",
        tier: "fast" as const,
        qualityPrior: 0.96,
        plannerQualityPrior: 0.96,
        latencyPriorMs: 100,
        strengths: ["coding", "tool_use", "structured_output"],
        inputPrice: 0.01,
        outputPrice: 0.01,
      },
      {
        id: "qualified-fast",
        tier: "fast" as const,
        qualityPrior: 0.95,
        plannerQualityPrior: 0.95,
        latencyPriorMs: 800,
        strengths: ["coding", "tool_use", "structured_output"],
        inputPrice: 0.1,
        outputPrice: 0.2,
      },
      {
        id: "over-budget-strong",
        tier: "strong" as const,
        qualityPrior: 0.99,
        plannerQualityPrior: 0.99,
        latencyPriorMs: 100,
        strengths: ["coding", "tool_use", "structured_output", "reasoning"],
        inputPrice: 20,
        outputPrice: 30,
      },
    ],
  };
  let validPlan: any;
  const m = await mock(
    (body) =>
      response(
        body.model === "malformed-fast"
          ? "Planner response contained prose but no structured result"
          : validPlan,
      ),
    fallbackPool.models,
  );
  try {
    const c = await config(undefined, {
      modelPool: fallbackPool,
      baseUrl: m.url,
      routing: { stateDirectory: join(f.root, "fallback-history") },
      budgetUsd: 0.04,
    });
    const repoProfile = await profileRepo(f.repo);
    validPlan = (await planningPolicy(task, repoProfile, c.planner)).candidate;
    const logger = new Logger(join(f.root, "fallback-log"), "fallback", true);
    const gateway = new Gateway(c, logger, new Budget(0.04, 200000, 60000));
    const result = await compileTask(
      gateway,
      "Fix src/a.ts and src/b.ts; preserve behavior.",
      repoProfile,
    );
    assert.equal(result.subtasks.length, 3);
    assert.deepEqual(
      m.requests.map((request) => request.model),
      ["malformed-fast", "qualified-fast"],
    );
    const routes = logger.events.filter(
      (event) => event.type === "planner_route",
    );
    assert.equal(routes.length, 2);
    assert.equal(routes[1]!.planner_model, "qualified-fast");
    assert.equal(
      routes[1]!.candidates.find(
        (candidate: any) => candidate.id === "over-budget-strong",
      ).rejected,
      "remaining USD budget",
    );
    const history = gateway.modelRouter!.history.read();
    assert.equal(history[0]!.verification, "FAILED");
    assert.equal(history[0]!.features.taskKind, "planning");
    assert.match(history[0]!.reason!, /no JSON object/);
    assert.equal(history[1]!.verification, "DAG_VALIDATED");
  } finally {
    await m.close();
    await f.cleanup();
  }
});

test("deterministic candidates use authoritative validation and overlap coalescing", async () => {
  const f = await fixture();
  try {
    const c = await config(undefined, { models: {} });
    const plan = (
      await planningPolicy(task, await profileRepo(f.repo), c.planner)
    ).candidate!;
    for (const mutate of [
      (p: any) => p.subtasks[0].dependsOn.push("missing"),
      (p: any) => (p.subtasks[0].likelyWritePaths = ["../escape"]),
      (p: any) => (p.subtasks[0].likelyWritePaths = ["src/*"]),
    ]) {
      const bad = structuredClone(plan);
      mutate(bad);
      assert.throws(() => validatePlanningCandidate(bad));
    }
    plan.subtasks[1]!.likelyWritePaths = plan.subtasks[0]!.likelyWritePaths;
    assert.equal(normalizePlan(validatePlanningCandidate(plan)).after, 2);
  } finally {
    await f.cleanup();
  }
});

test("planner permits explicit read-only discovery but retains mutation ownership", () => {
  const discovery = {
    id: "inspect-flow",
    title: "Inspect verification flow",
    objective: "Inspect the two verification modules and identify the issue",
    dependsOn: [],
    likelyReadPaths: ["src/repo/commands.ts", "src/repo/dependencies.ts"],
    likelyWritePaths: [],
    readOnly: true,
    integrationContract: "Return evidence for the implementation task",
    verificationCommands: [],
    estimatedDifficulty: "low" as const,
    parallelSafe: false,
  };
  const mutation = {
    ...discovery,
    id: "fix-flow",
    title: "Fix verification flow",
    objective: "Apply the discovered fix and add its regression test",
    dependsOn: [discovery.id],
    likelyWritePaths: ["src/repo/commands.ts", "tests/core.test.ts"],
    readOnly: false,
    integrationContract: "The focused regression test passes",
    verificationCommands: ["pnpm test"],
  };
  const candidate = {
    taskSummary: "Inspect, then fix filesystem verification",
    acceptanceCriteria: ["The regression test and typecheck pass"],
    subtasks: [discovery, mutation],
  };
  assert.equal(
    validatePlanningCandidate(candidate).subtasks[0]!.readOnly,
    true,
  );
  assert.deepEqual(
    validatePlanningCandidate(candidate).subtasks[0]!.likelyWritePaths,
    [],
  );
  assert.throws(
    () =>
      planSchema.parse({
        ...candidate,
        subtasks: [{ ...mutation, likelyWritePaths: [] }],
      }),
    /Mutation subtasks require at least one writable path/,
  );
  assert.throws(
    () =>
      planSchema.parse({
        ...candidate,
        subtasks: [
          { ...discovery, likelyWritePaths: ["src/repo/commands.ts"] },
        ],
      }),
    /Read-only discovery cannot declare writable paths/,
  );
});

for (const malformed of [false])
  test(
    malformed
      ? "malformed discovery finalization preserves context and continues to dependent coding"
      : "planned discovery is read-only and its evidence reaches the dependent coder",
    async () => {
      const f = await fixture();
      const liveTask =
        "Across src/repo/commands.ts and src/repo/dependencies.ts, use a separate read-only discovery step before the dependent mutation step. Find one small real robustness issue that is not already covered by tests, fix it with the smallest possible change, and add a focused regression test. Do not change dependencies, do not weaken existing tests, and do not perform unrelated refactors. Verify the result with the relevant tests and typecheck.";
      await writeFile(
        join(f.repo, "src/b.ts"),
        "export function b(){return 1}\n",
      );
      await writeFile(
        join(f.repo, "src/c.ts"),
        "export function c(){return 1}\n",
      );
      await git(f.repo, "add", ".");
      await git(f.repo, "commit", "-qm", "leave one focused failure");
      const planned = {
        taskSummary: liveTask,
        acceptanceCriteria: ["The focused fix and repository checks pass"],
        subtasks: [
          {
            id: "inspect-verification",
            title: "Inspect verification flow",
            objective:
              "Inspect src/a.ts and src/b.ts to identify the focused issue",
            dependsOn: [],
            likelyReadPaths: ["src/a.ts", "src/b.ts"],
            likelyWritePaths: [],
            readOnly: true,
            integrationContract: "Return concrete evidence to fix-verification",
            verificationCommands: [],
            estimatedDifficulty: "low",
            parallelSafe: false,
          },
          {
            id: "fix-verification",
            title: "Fix verification flow",
            objective: "Fix the discovered defect in src/a.ts",
            dependsOn: ["inspect-verification"],
            likelyReadPaths: ["src/a.ts", "src/b.ts", "test/a.test.ts"],
            likelyWritePaths: ["src/a.ts"],
            readOnly: false,
            integrationContract: "test/a.test.ts passes",
            verificationCommands: ["node --test test/a.test.ts"],
            estimatedDifficulty: "normal",
            parallelSafe: false,
          },
        ],
      };
      const m = await mock((body) => {
        const system = body.messages[0].content as string;
        if (system.startsWith("Compile")) {
          assert.match(system, /readOnly:true and likelyWritePaths:\[\]/);
          return response(planned);
        }
        const input = JSON.parse(body.messages[1].content);
        if (system.includes("read-only repository scout")) {
          assert.deepEqual(input.allowed_write_paths, []);
          if (body.messages.length === 2)
            return {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "inspect-source",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: JSON.stringify({ path: "src/a.ts" }),
                  },
                },
              ],
            };
          return malformed
            ? response("Unable to produce JSON")
            : response({
                relevantFiles: ["src/a.ts", "src/b.ts"],
                symbols: ["a", "b"],
                reproduction: "test/a.test.ts expects a() to return 1",
                failingTests: ["test/a.test.ts"],
                likelyRootCause: "a returns 0",
                dependencies: [],
                uncertainty: "low",
                suggestedApproach: "Change a to return 1",
                evidence: ["src/a.ts contains return 0"],
              });
        }
        assert.equal(input.subtask.id, "fix-verification");
        assert.ok(input.evidence.relevantFiles.includes("src/a.ts"));
        assert.deepEqual(input.allowed_write_paths, ["src/a.ts"]);
        return {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "focused-fix",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({
                  path: "src/a.ts",
                  content: "export function a(){return 1}\n",
                }),
              },
            },
          ],
        };
      });
      try {
        const c = await config(undefined, {
          modelPool: pool,
          baseUrl: m.url,
          models: { SCOUT_MODEL: "fast", CHEAP_CODER_A: "fast" },
          routing: { stateDirectory: join(f.root, "discovery-history") },
          budgetUsd: 0.1,
        });
        const result = await run({
          repo: f.repo,
          task: liveTask,
          config: c,
          quiet: true,
          output: join(f.root, "discovery-report"),
        });
        assert.equal(result.execution_strategy, "planned");
        assert.equal(result.status, "VERIFIED_SUCCESS", result.error);
        const events = (
          await readFile(join(f.root, "discovery-report/events.jsonl"), "utf8")
        )
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const discoveryScope = events.find(
          (event) =>
            event.type === "worker_scope" &&
            event.subtaskId === "inspect-verification",
        );
        assert.equal(discoveryScope, undefined,
          "OpenHands exploration replaces planner-created discovery workers");
        assert.equal(
          events.filter(
            (event) =>
              event.type === "write_attempt" &&
              event.subtaskId === "inspect-verification",
          ).length,
          0,
        );
        assert.equal(
          m.requests.filter((request) =>
            request.messages[0].content.includes("read-only repository scout"),
          ).length,
          0,
        );
        assert.equal(await git(f.repo, "status", "--porcelain"), "");
        assert.match(
          await readFile(join(f.repo, "src/a.ts"), "utf8"),
          /return 0/,
        );
      } finally {
        await m.close();
        await f.cleanup();
      }
    },
  );

test("planner quality, latency and cost history are independent of coder history", async () => {
  const c = await config(undefined, { modelPool: pool });
  const models = c.modelPool!.models;
  const metadata = new Map(
    models.map((m) => [
      m.id,
      {
        inputPrice: 0.1,
        outputPrice: 0.2,
        supportedParameters: ["tools", "tool_choice", "structured_outputs"],
      },
    ]),
  );
  const features = extractFeatures(
    {
      id: "a",
      title: "Fix",
      objective: "Fix a",
      dependsOn: [],
      likelyReadPaths: [],
      likelyWritePaths: ["a.ts"],
      integrationContract: "Preserve",
      verificationCommands: [],
      estimatedDifficulty: "normal",
      parallelSafe: true,
    },
    { files: ["a.ts"] } as any,
    100,
  );
  const row: Attempt = {
    timestamp: "",
    runId: "r",
    subtaskId: "a",
    modelRequested: "fast",
    modelServed: "fast",
    features,
    verification: "VERIFIED_SUCCESS",
    wallClockMs: 50000,
    inputTokens: 10,
    outputTokens: 10,
    costUsd: 0.05,
    escalated: false,
  };
  const rank = (history: Attempt[]) =>
    rankPlanners(models, metadata, history, "standard", c.planner, 1000, 1800);
  const coding = Array(30).fill(row);
  assert.deepEqual(rank(coding), rank([]));
  const planning = Array(30).fill({
    ...row,
    features: { ...features, taskKind: "planning", complexity: "standard" },
    verification: "DAG_VALIDATED",
  });
  assert.equal(
    rank(planning)[0]!.model.id,
    "strong",
    "slow expensive planner history changes preference",
  );
  const coder = (history: Attempt[]) =>
    rankCandidates(models, metadata, history, features, c.routing, 1000, 1800);
  assert.deepEqual(coder(planning), coder([]));
  const failures = planning.map((r) => ({ ...r, verification: "FAILED" }));
  assert.equal(
    rank(failures).find((r) => r.model.id === "fast")!.rejected,
    "below planner quality threshold",
  );
  assert.equal(
    rank([...failures, ...coding]).find((r) => r.model.id === "fast")!.rejected,
    "below planner quality threshold",
  );
});

test("complex planning falls back to a qualified fast planner when strong history is below threshold", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-planner-tier-fallback-"));
  try {
    const c = await config(undefined, {
      modelPool: pool,
      routing: { stateDirectory: root },
    });
    const logger = new Logger(join(root, "log"), "tier-fallback", true);
    const features = extractFeatures(
      {
        id: "planner",
        title: "Refactor authentication",
        objective: "Refactor authentication across modules",
        dependsOn: [],
        likelyReadPaths: [],
        likelyWritePaths: ["src/a.ts", "src/b.ts"],
        integrationContract: "Preserve behavior",
        verificationCommands: [],
        estimatedDifficulty: "high",
        parallelSafe: false,
      },
      { files: ["src/a.ts", "src/b.ts"] } as any,
      100,
    );
    features.taskKind = "planning";
    features.complexity = "complex";
    const failedStrong = Array.from({ length: 2 }, (_, i): Attempt => ({
      timestamp: String(i),
      runId: "previous",
      subtaskId: "planner",
      modelRequested: "strong",
      modelServed: "strong",
      features,
      verification: "FAILED",
      wallClockMs: 1000,
      inputTokens: 100,
      outputTokens: 10,
      costUsd: 0.001,
      escalated: true,
    }));
    const metadata = new Map(
      pool.models.map((model) => [
        model.id,
        {
          inputPrice: 0.1,
          outputPrice: 0.2,
          contextLength: 100000,
          available: true,
          supportedParameters: ["tools", "tool_choice", "structured_outputs"],
        },
      ]),
    );
    const selected = await selectPlanner(
      {
        config: c,
        catalog: { get: async () => metadata },
        history: { read: () => failedStrong },
        disabled: new Set<string>(),
        logger,
      } as any,
      features,
      "strong",
      [],
      1000,
    );
    assert.equal(selected.id, "fast");
    assert.match(
      logger.events.at(-1)!.routing_reason,
      /qualified fast planner fallback/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("planner recovery uses the attainable quality plateau instead of retrying a worse expensive tier", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-planner-plateau-"));
  try {
    const c = await config(undefined, {
      modelPool: pool,
      routing: { stateDirectory: root },
    });
    const logger = new Logger(join(root, "log"), "planner-plateau", true);
    const features = extractFeatures(
      {
        id: "planner",
        title: "Plan bounded dependent fixes",
        objective: "Plan bounded dependent fixes",
        dependsOn: [],
        likelyReadPaths: [],
        likelyWritePaths: ["src/a.ts", "src/b.ts"],
        integrationContract: "Preserve behavior",
        verificationCommands: [],
        estimatedDifficulty: "high",
        parallelSafe: false,
      },
      { files: ["src/a.ts", "src/b.ts"] } as any,
      100,
    );
    features.taskKind = "planning";
    features.complexity = "complex";
    const failure = (model: string, index: number): Attempt => ({
      timestamp: String(index),
      runId: `previous-${model}`,
      subtaskId: "planner",
      modelRequested: model,
      modelServed: model,
      features,
      verification: "FAILED",
      wallClockMs: model === "strong" ? 8000 : 3000,
      inputTokens: 100,
      outputTokens: 20,
      costUsd: model === "strong" ? 0.01 : 0.0001,
      escalated: true,
    });
    const history = [failure("fast", 0), failure("strong", 0), failure("strong", 1)];
    const metadata = new Map(
      pool.models.map((model) => [
        model.id,
        {
          inputPrice: model.id === "strong" ? 2 : 0.1,
          outputPrice: model.id === "strong" ? 8 : 0.2,
          contextLength: 100000,
          available: true,
          supportedParameters: ["tools", "tool_choice", "structured_outputs"],
        },
      ]),
    );
    const selected = await selectPlanner(
      {
        config: c,
        catalog: { get: async () => metadata },
        history: { read: () => history },
        disabled: new Set<string>(),
        logger,
      } as any,
      features,
      "strong",
      [],
      1000,
    );
    assert.equal(selected.id, "fast");
    assert.match(
      logger.events.at(-1)!.routing_reason,
      /attainable planner quality plateau/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid planners exhaust distinct candidates and fail without a fabricated DAG", async () => {
  const f = await fixture();
  const m = await mock(() => response({ subtasks: [] }));
  try {
    const c = await config(undefined, {
      modelPool: pool,
      baseUrl: m.url,
      routing: { stateDirectory: join(f.root, "history") },
      budgetUsd: 0.1,
    });
    const logger = new Logger(join(f.root, "log"), "exhausted", true);
    const gateway = new Gateway(c, logger, new Budget(0.1, 200000, 60000));
    await assert.rejects(
      compileTask(
        gateway,
        "Fix src/a.ts and src/b.ts; preserve behavior.",
        await profileRepo(f.repo),
      ),
      /No untried planner/,
    );
    assert.deepEqual(
      m.requests.map((r) => r.model),
      ["fast", "strong"],
    );
    assert.equal(
      logger.events.find((e) => e.type === "planner_summary").dag_valid,
      false,
    );
    assert.ok(
      gateway
        .modelRouter!.history.read()
        .every((r) => r.verification === "FAILED"),
    );
  } finally {
    await m.close();
    await f.cleanup();
  }
});

test("planner attempts reset between runs while remaining unique within each run", async () => {
  const f = await fixture();
  const m = await mock(() => response({ subtasks: [] }));
  const stateDirectory = join(f.root, "shared-planner-history");
  try {
    const c = await config(undefined, {
      modelPool: pool,
      baseUrl: m.url,
      routing: { stateDirectory },
      budgetUsd: 0.1,
    });
    const profile = await profileRepo(f.repo);
    const execute = async (runId: string) => {
      const logger = new Logger(join(f.root, `${runId}-log`), runId, true);
      const gateway = new Gateway(c, logger, new Budget(0.1, 200000, 60000));
      const before = m.requests.length;
      await assert.rejects(
        compileTask(
          gateway,
          "Fix src/a.ts and src/b.ts; preserve behavior.",
          profile,
        ),
        /No untried planner/,
      );
      return {
        models: m.requests.slice(before).map((request) => request.model),
        logger,
      };
    };

    const first = await execute("planner-run-1");
    assert.deepEqual(first.models, ["fast", "strong"]);
    assert.equal(new Set(first.models).size, first.models.length);

    const second = await execute("planner-run-2");
    assert.deepEqual(second.models, ["fast", "strong"]);
    assert.equal(new Set(second.models).size, second.models.length);
    assert.ok(
      second.logger.events.some(
        (event) =>
          event.type === "planner_route" &&
          /attainable planner quality plateau/.test(event.routing_reason),
      ),
    );
  } finally {
    await m.close();
    await f.cleanup();
  }
});

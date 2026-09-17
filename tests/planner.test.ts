import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { config } from "../src/config.js";
import { git } from "../src/repo/commands.js";
import { profileRepo } from "../src/repo/profiler.js";
import {
  planningPolicy,
  validatePlanningCandidate,
} from "../src/planner/policy.js";
import { compileTask } from "../src/planner/taskCompiler.js";
import { rankPlanners, selectPlanner } from "../src/planner/routing.js";
import { normalizePlan } from "../src/orchestrator/coalesce.js";
import { Gateway } from "../src/openrouter/client.js";
import { Budget } from "../src/openrouter/usage.js";
import { Logger } from "../src/telemetry/logger.js";
import { run } from "../src/run.js";
import { extractFeatures } from "../src/router/features.js";
import { rankCandidates } from "../src/router/modelRouter.js";
import type { Attempt } from "../src/router/history.js";
import { planSchema } from "../src/planner/schemas.js";
import { discover } from "../src/agent/discovery.js";

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
async function mock(
  handler: (body: any) => any,
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
            supported_parameters: ["tools", "structured_outputs"],
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
      const message = handler(body);
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
    const m = await mock((body) => {
      assert.ok(
        !body.messages[0].content.startsWith("Compile"),
        "no planner HTTP request",
      );
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
        verify: finalFailure ? ['node -e "process.exit(1)"'] : undefined,
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

test("deterministic gate refuses missing tests, ambiguous aliases, extra requirements and coupled imports; context is bounded", async () => {
  const f = await fixture();
  try {
    const c = await config(undefined, { models: {} });
    const profile = await profileRepo(f.repo);
    assert.equal(
      (await planningPolicy(task, profile, c.planner)).strategy,
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
    const coupled = await planningPolicy(task, profile, c.planner);
    assert.equal(coupled.strategy, "model");
    assert.equal(coupled.complexity, "complex");
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
      assert.deepEqual(body.tools.map((tool: any) => tool.function.name), ["submit_plan"]);
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
        ? { role: "assistant", content: null, tool_calls: [{ id: "plan-control", type: "function",
            function: { name: "submit_plan", arguments: JSON.stringify(good) } }] }
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

test("planned discovery is read-only and its evidence reaches the dependent coder", async () => {
  const f = await fixture();
  const liveTask =
    "Across src/repo/commands.ts and src/repo/dependencies.ts, use a separate read-only discovery step before the dependent mutation step. Find one small real robustness issue that is not already covered by tests, fix it with the smallest possible change, and add a focused regression test. Do not change dependencies, do not weaken existing tests, and do not perform unrelated refactors. Verify the result with the relevant tests and typecheck.";
  await writeFile(join(f.repo, "src/b.ts"), "export function b(){return 1}\n");
  await writeFile(join(f.repo, "src/c.ts"), "export function c(){return 1}\n");
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
      return response({
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
    assert.equal(input.evidence.likelyRootCause, "a returns 0");
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
    assert.deepEqual(discoveryScope.allowed_write_paths, []);
    assert.equal(discoveryScope.read_only, true);
    assert.equal(events.filter((event) => event.type === "write_attempt" &&
      event.subtaskId === "inspect-verification").length, 0);
    assert.ok(
      events.some(
        (event) =>
          event.type === "discovery_complete" &&
          event.subtaskId === "inspect-verification",
      ),
    );
    assert.equal(m.requests.filter((request) =>
      request.messages[0].content.includes("read-only repository scout")).length, 2);
    assert.equal(await git(f.repo, "status", "--porcelain"), "");
    assert.match(await readFile(join(f.repo, "src/a.ts"), "utf8"), /return 0/);
  } finally {
    await m.close();
    await f.cleanup();
  }
});

test("discovery routing skips an otherwise eligible unknown-priced model", async () => {
  const f = await fixture();
  const discoveryPool = {
    provider: "openrouter" as const,
    models: [
      {
        id: "unknown-scout",
        tier: "fast" as const,
        qualityPrior: 0.99,
        latencyPriorMs: 1,
        strengths: ["coding", "tool_use", "reasoning"],
        unknownPricing: true,
      },
      {
        id: "known-scout",
        tier: "fast" as const,
        qualityPrior: 0.95,
        latencyPriorMs: 1000,
        strengths: ["coding", "tool_use", "reasoning"],
        inputPrice: 0.1,
        outputPrice: 0.2,
      },
    ],
  };
  const m = await mock((body) => {
    assert.equal(body.model, "known-scout");
    if (body.tools)
      return {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "inspect",
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({
                path:
                  body.messages.length === 2
                    ? "src/a.ts"
                    : body.messages.length === 4
                      ? "src/b.ts"
                      : "test/a.test.ts",
              }),
            },
          },
        ],
      };
    assert.equal(body.tools, undefined);
    assert.match(
      body.messages.at(-1).content,
      /Tools are unavailable on this finalization turn/,
    );
    return response({
      relevantFiles: ["src/a.ts"],
      symbols: ["a"],
      reproduction: "Inspected src/a.ts",
      failingTests: [],
      likelyRootCause: "a returns 0",
      dependencies: [],
      uncertainty: "low",
      suggestedApproach: "Update a",
      evidence: ["src/a.ts contains return 0"],
    });
  }, discoveryPool.models);
  try {
    const c = await config(undefined, {
      modelPool: discoveryPool,
      baseUrl: m.url,
      models: { SCOUT_MODEL: "unknown-scout" },
      routing: { stateDirectory: join(f.root, "discovery-price-history") },
      budgetUsd: 0.1,
    });
    const logger = new Logger(
      join(f.root, "discovery-price-log"),
      "discovery-price",
      true,
    );
    const gateway = new Gateway(c, logger, new Budget(0.1, 200000, 60000));
    const subtask = {
      id: "inspect-priced",
      title: "Inspect source",
      objective: "Inspect src/a.ts for the defect",
      dependsOn: [],
      likelyReadPaths: ["src/a.ts"],
      likelyWritePaths: [],
      readOnly: true as const,
      integrationContract: "Return evidence",
      verificationCommands: [],
      estimatedDifficulty: "low" as const,
      parallelSafe: false,
    };
    await discover(
      gateway,
      f.repo,
      subtask.objective,
      subtask,
      { subtasks: [subtask] },
      await profileRepo(f.repo),
    );
    assert.deepEqual(
      m.requests.map((request) => request.model),
      ["known-scout", "known-scout"],
    );
    const routed = logger.events.find(
      (event) => event.type === "model_router",
    );
    assert.equal(routed.selected_model, "known-scout");
    assert.equal(
      routed.candidates.find((candidate: any) => candidate.id === "unknown-scout")
        .rejected,
      "unknown pricing",
    );
  } finally {
    await m.close();
    await f.cleanup();
  }
});

test("discovery reports exhaustion only after an unusable tool-free finalization", async () => {
  const f = await fixture();
  const knownPool = {
    provider: "openrouter" as const,
    models: [
      {
        id: "known-scout",
        tier: "fast" as const,
        qualityPrior: 0.95,
        latencyPriorMs: 1000,
        strengths: ["coding", "tool_use", "reasoning"],
      },
    ],
  };
  const m = await mock((body) => {
    if (body.tools)
      return {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `inspect-${body.messages.length}`,
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: "src/a.ts" }),
            },
          },
        ],
      };
    assert.equal(body.tools, undefined);
    return response("Unable to summarize");
  }, knownPool.models);
  try {
    const c = await config(undefined, {
      modelPool: knownPool,
      baseUrl: m.url,
      routing: { stateDirectory: join(f.root, "discovery-final-history") },
      budgetUsd: 0.1,
    });
    const gateway = new Gateway(
      c,
      new Logger(
        join(f.root, "discovery-final-log"),
        "discovery-final",
        true,
      ),
      new Budget(0.1, 200000, 60000),
    );
    const subtask = {
      id: "inspect-final",
      title: "Inspect source",
      objective: "Inspect src/a.ts for the defect",
      dependsOn: [],
      likelyReadPaths: ["src/a.ts"],
      likelyWritePaths: [],
      readOnly: true as const,
      integrationContract: "Return evidence",
      verificationCommands: [],
      estimatedDifficulty: "low" as const,
      parallelSafe: false,
    };
    await assert.rejects(
      discover(
        gateway,
        f.repo,
        subtask.objective,
        subtask,
        { subtasks: [subtask] },
        await profileRepo(f.repo),
      ),
      /Discovery iteration budget exhausted: finalization produced no usable result/,
    );
    assert.equal(m.requests.length, 2);
  } finally {
    await m.close();
    await f.cleanup();
  }
});

test("planner quality, latency and cost history are independent of coder history", async () => {
  const c = await config(undefined, { modelPool: pool });
  const models = c.modelPool!.models;
  const metadata = new Map(
    models.map((m) => [
      m.id,
      {
        inputPrice: 0.1,
        outputPrice: 0.2,
        supportedParameters: ["tools", "structured_outputs"],
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
          supportedParameters: ["structured_outputs"],
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
          /fresh-run retry/.test(event.routing_reason),
      ),
    );
  } finally {
    await m.close();
    await f.cleanup();
  }
});

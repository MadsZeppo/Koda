import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { git } from "../src/repo/commands.js";
import { run } from "../src/run.js";
import { config } from "../src/config.js";
import { benchmark } from "../src/benchmark.js";
import type { Plan, Subtask } from "../src/planner/schemas.js";
import { emitFixtureMetrics } from "../benchmarks/deterministicMetrics.js";
const makeTask = (id: string, dependsOn: string[] = []): Subtask => ({
  id,
  title: `Fix ${id}`,
  objective: `Implement ${id}`,
  dependsOn,
  likelyReadPaths: [`${id}.cjs`],
  likelyWritePaths: [`${id}.cjs`],
  integrationContract: "Export a function accepting two numeric arguments",
  verificationCommands: [`node --test tests/${id}.test.cjs`],
  estimatedDifficulty: "normal",
  parallelSafe: true,
});
const plan: Plan = {
  taskSummary: "Fix arithmetic and compose a report",
  acceptanceCriteria: [
    "Signed arithmetic and composition pass executable tests",
  ],
  subtasks: [
    makeTask("add"),
    makeTask("multiply"),
    makeTask("report", ["add", "multiply"]),
  ],
};
const solutions: Record<string, string> = {
  add: "module.exports = (a,b) => a + b;\n",
  multiply: "module.exports = (a,b) => a * b;\n",
  report:
    "const add = require('./add.cjs'); const multiply = require('./multiply.cjs'); module.exports = (a,b) => ({sum:add(a,b),product:multiply(a,b)});\n",
};
async function setup() {
  const repo = await mkdtemp(join(tmpdir(), "koda-e2e-"));
  await cp(resolve("tests/fixtures/math"), repo, { recursive: true });
  await git(repo, "init");
  await git(repo, "config", "user.name", "Fixture");
  await git(repo, "config", "user.email", "fixture@localhost");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "broken fixture");
  return repo;
}
async function mock(
  stall = false,
  race = false,
  fail = false,
  scenario: {
    plan: Plan;
    solutions: Record<string, string>;
    inspectOnly?: string[];
    directFile?: string;
    searchFirst?: boolean;
    extraWritePath?: string;
  } = { plan, solutions },
) {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      requests.push(body);
      if (fail) {
        res.writeHead(402, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "mock billing failure" } }));
        return;
      }
      const system = body.messages[0].content;
      const input = JSON.parse(body.messages[1].content);
      let message: any;
      const final = (content: unknown) => ({
        role: "assistant",
        content:
          typeof content === "string" ? content : JSON.stringify(content),
      });
      if (system.startsWith("Compile"))
        message = final(
          race
            ? {
                ...scenario.plan,
                subtasks: scenario.plan.subtasks.map((t) => ({
                  ...t,
                  estimatedDifficulty: "high",
                })),
              }
            : scenario.plan,
        );
      else if (system.includes("read-only repository scout")) {
        if (body.messages.length === 2)
          message = {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "read",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({
                    path: input.subtask.likelyReadPaths[0],
                  }),
                },
              },
            ],
          };
        else
          message = final({
            relevantFiles: input.subtask.likelyReadPaths,
            symbols: ["module.exports"],
            reproduction: "not run",
            failingTests: [],
            likelyRootCause: "Incorrect arithmetic",
            dependencies: input.subtask.dependsOn,
            uncertainty: "low",
            suggestedApproach: "Correct the arithmetic implementation",
            evidence: ["Inspected source"],
          });
      } else {
        await new Promise((r) => setTimeout(r, 30));
        let id = scenario.directFile
          ? "direct"
          : (
              input.subtask?.id ??
              input.handoff.originalObjective.replace(/^Implement /, "")
            ).replace(/-[ab]$/, "");
        const sourceId = input.subtask?.likelyWritePaths?.[0]?.replace(/\.cjs$/, "");
        if (!scenario.solutions[id] && sourceId && scenario.solutions[sourceId]) id = sourceId;
        if (scenario.searchFirst && !body.messages.some((entry: any) =>
          entry.role === "tool" && typeof entry.content === "string" &&
          entry.content.includes("add.cjs:1:")))
          message = { role: "assistant", content: null, tool_calls: [{
            id: "search", type: "function", function: { name: "search_code",
              arguments: JSON.stringify({ query: "module.exports" }) },
          }] };
        else if (scenario.inspectOnly?.includes(id))
          message = {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "inspect",
                type: "function",
                function: { name: "git_diff", arguments: "{}" },
              },
            ],
          };
        else if (stall && body.model === "cheap-a")
          message = final("Still investigating");
        else if (
          body.messages.some(
            (m: any) => m.role === "tool" && m.content === "written",
          )
        )
          message = final("Implemented; runtime must verify.");
        else
          message = {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "write",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({
                    path: scenario.directFile ?? `${id}.cjs`,
                    content: scenario.solutions[id],
                  }),
                },
              },
            ],
          };
      }
      if (
        scenario.extraWritePath &&
        message.tool_calls?.some((c: any) => c.function.name === "write_file")
      )
        message.tool_calls.push({
          id: "extra-write",
          type: "function",
          function: {
            name: "write_file",
            arguments: JSON.stringify({
              path: scenario.extraWritePath,
              content: "unexpected change",
            }),
          },
        });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `mock-${requests.length}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: body.model + "-served",
          provider: "mock-provider",
          choices: [
            {
              index: 0,
              message,
              finish_reason: message.tool_calls ? "tool_calls" : "stop",
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            cost: 0.0001,
            prompt_tokens_details: { cached_tokens: 10, cache_write_tokens: 2 },
            completion_tokens_details: { reasoning_tokens: 3 },
          },
        }),
      );
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address() as { port: number };
  return {
    requests,
    url: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))),
  };
}
async function cleanup(repo: string) {
  const worktrees = (await git(repo, "worktree", "list", "--porcelain"))
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice(9));
  for (const path of worktrees)
    if (
      path !== repo &&
      path !== (await import("node:fs/promises").then((f) => f.realpath(repo)))
    )
      await git(repo, "worktree", "remove", "--force", path);
  await rm(repo, { recursive: true, force: true });
}
test("complete mocked OpenRouter run: concurrent workers, dependent integration, actual final tests, exact telemetry", async () => {
  const repo = await setup(),
    api = await mock();
  const output = await mkdtemp(join(tmpdir(), "koda-report-"));
  try {
    const base = await git(repo, "rev-parse", "HEAD");
    const c = await config(undefined, {
      baseUrl: api.url,
      models: { SCOUT_MODEL: "scout", CHEAP_CODER_A: "cheap-a" },
    });
    const result = await run({
      repo,
      task: plan.taskSummary,
      config: c,
      output,
      quiet: true,
    });
    assert.equal(result.status, "VERIFIED_SUCCESS", JSON.stringify(result));
    assert.equal(result.execution_strategy, "planned");
    assert.equal(result.parallelPeak, 2);
    assert.equal(await git(repo, "rev-parse", "HEAD"), base);
    assert.equal(await git(repo, "status", "--porcelain"), "");
    assert.equal(
      await readFile(join(repo, "add.cjs"), "utf8"),
      "module.exports = (a, b) => a - b;\n",
    );
    assert.ok(result.verification.checks.every((c) => c.exitCode === 0));
    assert.ok(Math.abs(result.costUsd - api.requests.length * 0.0001) < 1e-10);
    assert.ok(Object.keys(result.models).every((m) => m.endsWith("-served")));
    assert.equal(result.cachedTokens, api.requests.length * 10);
    const events = (await readFile(join(output, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    emitFixtureMetrics("planned-parallel-dependencies", result, events);
    const firstComplete = events.findIndex((e) => e.type === "task_complete");
    assert.equal(
      events.slice(0, firstComplete).filter((e) => e.type === "task_start")
        .length,
      2,
    );
    const reportStart = events.findIndex(
      (e) => e.type === "task_start" && e.subtaskId === "report",
    );
    assert.equal(
      events.slice(0, reportStart).filter((e) => e.type === "integrated")
        .length,
      2,
    );
    assert.ok(
      api.requests.every((r) => r.session_id && r.provider.require_parameters),
    );
  } finally {
    await api.close();
    await cleanup(repo);
    await rm(output, { recursive: true, force: true });
  }
});
test("stalled cheap agents escalate with compact handoffs and still pass", async () => {
  const repo = await setup(),
    api = await mock(true),
    output = await mkdtemp(join(tmpdir(), "koda-stall-"));
  try {
    const c = await config(undefined, {
      baseUrl: api.url,
      models: {
        SCOUT_MODEL: "scout",
        CHEAP_CODER_A: "cheap-a",
        STRONG_MODEL: "strong",
      },
    });
    const result = await run({
      repo,
      task: plan.taskSummary,
      config: c,
      output,
      quiet: true,
    });
    assert.equal(result.status, "VERIFIED_SUCCESS", JSON.stringify(result));
    assert.equal(result.escalations, 3);
    const strong = api.requests.filter((r) => r.model === "strong");
    assert.ok(strong.length);
    assert.ok(JSON.parse(strong[0].messages[1].content).handoff);
    assert.equal(strong[0].messages.length, 2);
  } finally {
    await api.close();
    await cleanup(repo);
    await rm(output, { recursive: true, force: true });
  }
});
test("benchmark hidden failure cannot be overridden by model success and base checkout stays intact", async () => {
  const repo = await setup(),
    api = await mock(),
    output = await mkdtemp(join(tmpdir(), "koda-bench-"));
  try {
    const base = await git(repo, "rev-parse", "HEAD");
    await writeFile(join(repo, "dirty.txt"), "user work");
    const manifest = join(output, "manifest.json");
    await writeFile(
      manifest,
      JSON.stringify([
        {
          name: "hidden fail",
          repo,
          baseCommit: base,
          task: plan.taskSummary,
          verify: ["node -e \"process.exit(Number(require('./add.cjs')(2,3)===5))\""],
        },
      ]),
    );
    const c = await config(undefined, {
      baseUrl: api.url,
      models: { SCOUT_MODEL: "scout", CHEAP_CODER_A: "cheap-a" },
    });
    const results = await benchmark(manifest, c, join(output, "results"));
    assert.equal(results[0]!.status, "FAILED");
    assert.ok(results[0]!.verification.checks.length >= 4);
    assert.equal(results[0]!.verification.checks.at(-1)!.exitCode, 1);
    assert.equal(await git(repo, "rev-parse", "HEAD"), base);
    assert.equal(await readFile(join(repo, "dirty.txt"), "utf8"), "user work");
    assert.ok(await readFile(join(output, "results", "summary.md"), "utf8"));
  } finally {
    await api.close();
    await cleanup(repo);
    await rm(output, { recursive: true, force: true });
  }
});

test("explicit race uses distinct sessions and bounded isolated workers", async () => {
  const repo = await setup(),
    api = await mock(false, true),
    output = await mkdtemp(join(tmpdir(), "koda-race-"));
  try {
    const c = await config(undefined, {
      baseUrl: api.url,
      race: true,
      maxParallel: 3,
      models: {
        SCOUT_MODEL: "scout",
        CHEAP_CODER_A: "cheap-a",
        CHEAP_CODER_B: "cheap-b",
      },
    });
    const result = await run({
      repo,
      task: plan.taskSummary,
      config: c,
      output,
      quiet: true,
    });
    assert.equal(result.status, "VERIFIED_SUCCESS", JSON.stringify(result));
    assert.equal(result.execution_strategy, "planned");
    assert.equal(result.parallelPeak, 2);
    assert.ok(api.requests.some((r) => r.model === "cheap-b"));
    const sessions = new Set(api.requests.map((r) => r.session_id));
    assert.ok([...sessions].some((s) => s.endsWith("/add-a")));
    assert.ok([...sessions].some((s) => s.endsWith("/add-b")));
    const wts = await git(repo, "worktree", "list");
    assert.equal(wts.trim().split("\n").length, 2);
  } finally {
    await api.close();
    await cleanup(repo);
    await rm(output, { recursive: true, force: true });
  }
});

test("insufficient run budget prevents even the first HTTP request", async () => {
  const repo = await setup(),
    api = await mock(),
    output = await mkdtemp(join(tmpdir(), "koda-budget-"));
  try {
    const c = await config(undefined, {
      models: {},
      baseUrl: api.url,
      budgetUsd: 0.000001,
    });
    const result = await run({
      repo,
      task: plan.taskSummary,
      config: c,
      output,
      quiet: true,
    });
    assert.equal(result.status, "FAILED");
    assert.equal(api.requests.length, 0);
    assert.equal(result.costUsd, 0);
    assert.match(result.error ?? "", /budget/);
  } finally {
    await api.close();
    await cleanup(repo);
    await rm(output, { recursive: true, force: true });
  }
});

test("provider errors retain an unknown-cost model call and stop new spending", async () => {
  const repo = await setup(),
    api = await mock(false, false, true),
    output = await mkdtemp(join(tmpdir(), "koda-api-error-"));
  try {
    const c = await config(undefined, { models: {}, baseUrl: api.url });
    const result = await run({
      repo,
      task: plan.taskSummary,
      config: c,
      output,
      quiet: true,
    });
    assert.equal(result.status, "FAILED");
    assert.equal(result.costComplete, false);
    assert.equal(api.requests.length, 1);
    const events = (await readFile(join(output, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const calls = events.filter((e) => e.type === "model_call");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].costUsd, null);
    assert.equal(calls[0].outcome, "error");
    assert.ok(calls[0].timestampEnd);
  } finally {
    await api.close();
    await cleanup(repo);
    await rm(output, { recursive: true, force: true });
  }
});

test("dependent task already satisfied by integration completes as a verified no-op", async () => {
  const repo = await setup();
  // Both objectives concern the same allowed file. A fixes both functions.
  await writeFile(
    join(repo, "add.cjs"),
    "module.exports = (a,b) => a-b; module.exports.multiply = (a,b) => a+b;\n",
  );
  await writeFile(
    join(repo, "multiply.cjs"),
    "module.exports = require('./add.cjs').multiply;\n",
  );
  await writeFile(join(repo, "report.cjs"), solutions.report!);
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "shared arithmetic implementation");
  const base = await git(repo, "rev-parse", "HEAD");
  const dependentPlan: Plan = {
    ...plan,
    subtasks: [
      makeTask("add"),
      {
        ...makeTask("multiply", ["add"]),
        likelyReadPaths: ["add.cjs"],
        likelyWritePaths: ["add.cjs"],
      },
    ],
  };
  const api = await mock(false, false, false, {
    plan: dependentPlan,
    solutions: {
      add: "module.exports = (a,b) => a+b; module.exports.multiply = (a,b) => a*b;\n",
    },
    inspectOnly: ["multiply"],
  });
  const output = await mkdtemp(join(tmpdir(), "koda-noop-"));
  try {
    const result = await run({
      repo,
      task: dependentPlan.taskSummary,
      config: await config(undefined, {
        baseUrl: api.url,
        models: { SCOUT_MODEL: "scout", CHEAP_CODER_A: "cheap-a" },
      }),
      output,
      quiet: true,
    });
    assert.equal(result.status, "VERIFIED_SUCCESS", JSON.stringify(result));
    assert.equal(
      result.subtaskVerification.multiply?.status,
      "VERIFIED_SUCCESS",
    );
    assert.equal(result.verification.status, "VERIFIED_SUCCESS");
    assert.ok(
      result.verification.checks.some(
        (c) => c.command === "npm run test" && c.exitCode === 0,
      ),
    );
    assert.equal(result.escalations, 0);
    const events = (await readFile(join(output, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const integratedA = events.findIndex(
      (e) => e.type === "integrated" && e.subtaskId === "add",
    );
    const startedB = events.findIndex(
      (e) => e.type === "task_start" && e.subtaskId === "multiply",
    );
    assert.ok(integratedA >= 0 && startedB > integratedA);
    const noop = events.find(
      (e) => e.type === "no_changes_required" && e.subtaskId === "multiply",
    );
    assert.equal(noop?.status, "VERIFIED_SUCCESS");
    assert.equal(noop?.diffBytes, 0);
    assert.equal(
      events.filter(
        (e) => e.type === "model_call" && e.subtaskId === "multiply",
      ).length,
      0,
    );
    assert.deepEqual(noop?.verificationCommands, [
      "node --test tests/multiply.test.cjs",
    ]);
    assert.ok(
      events.some(
        (e) =>
          e.type === "task_complete" &&
          e.subtaskId === "multiply" &&
          e.verification === "VERIFIED_SUCCESS",
      ),
    );
    assert.equal(
      events.filter(
        (e) =>
          e.type === "model_call" &&
          e.stage === "implement" &&
          e.subtaskId === "multiply",
      ).length,
      0,
    );
    assert.equal(events.filter((e) => e.type === "integrated").length, 1);
    assert.equal(
      await git(
        result.integration!.path,
        "rev-list",
        "--count",
        `${base}..HEAD`,
      ),
      "1",
    );
    assert.equal(await git(repo, "rev-parse", "HEAD"), base);
  } finally {
    await api.close();
    await cleanup(repo);
    await rm(output, { recursive: true, force: true });
  }
});

for (const mode of [
  "success",
  "stalled",
  "final-failure",
  "no-checks",
  "trivial-check",
  "scope-violation",
] as const) {
  test(`direct execution: ${mode}`, async () => {
    const repo = await setup();
    await writeFile(join(repo, "multiply.cjs"), solutions.multiply!);
    await writeFile(join(repo, "report.cjs"), solutions.report!);
    if (mode === "no-checks")
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({ name: "fixture", private: true }),
      );
    if (mode === "trivial-check")
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({ name: "fixture", scripts: { test: "echo passed" } }),
      );
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "localize defect to addition");
    const base = await git(repo, "rev-parse", "HEAD");
    const api = await mock(mode === "stalled", false, false, {
      plan,
      solutions: { direct: solutions.add! },
      directFile: "add.cjs",
      extraWritePath: mode === "scope-violation" ? "unrelated.cjs" : undefined,
    });
    const output = await mkdtemp(join(tmpdir(), "koda-direct-"));
    const task = "Fix add.cjs so signed addition returns the sum.";
    try {
      const result = await run({
        repo,
        task,
        config: await config(undefined, {
          baseUrl: api.url,
          race: true,
          models: {
            SCOUT_MODEL: "scout",
            CHEAP_CODER_A: "cheap-a",
            STRONG_MODEL: "strong",
          },
          maxIterations: 8,
        }),
        output,
        quiet: true,
        verify:
          mode === "final-failure" ? ["node -e \"process.exit(Number(require('./add.cjs')(2,3)===5))\""] : undefined,
      });
      assert.equal(result.execution_strategy, "direct");
      assert.equal(result.plannerModelCalls, 0);
      assert.equal(result.coderExecutions, 1);
      assert.ok(result.strategy_reason);
      assert.equal(await git(repo, "rev-parse", "HEAD"), base);
      assert.equal(await git(repo, "status", "--porcelain"), "");
      const events = (await readFile(join(output, "events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      if (mode === "success")
        emitFixtureMetrics("direct-local-fix", result, events);
      assert.equal(events.filter((e) => e.type === "worktree").length, 1);
      assert.equal(
        events.filter((e) => e.type === "dag" || e.type === "race_winner")
          .length,
        0,
      );
      assert.equal(
        events.filter((e) => e.type === "model_call" && e.stage !== "implement")
          .length,
        0,
      );
      assert.equal(
        events.filter((e) => e.type === "execution_strategy")[0]
          ?.execution_strategy,
        "direct",
      );
      await assert.rejects(readFile(join(output, "plan.json")), {
        code: "ENOENT",
      });
      assert.ok(
        api.requests.every(
          (r) =>
            !r.messages[0].content.startsWith("Compile") &&
            !r.messages[0].content.includes("read-only repository scout"),
        ),
      );
      assert.equal(JSON.parse(api.requests[0].messages[1].content).task, task);
      if (["success", "stalled", "final-failure"].includes(mode)) {
        assert.ok(events.some((e) => e.type === "integrated"));
        const finalIndex = events.findIndex(
          (e) => e.type === "final_verification",
        );
        assert.ok(
          finalIndex > events.findIndex((e) => e.type === "integrated"),
        );
        assert.equal(
          result.status,
          mode === "final-failure" ? "FAILED" : "VERIFIED_SUCCESS",
          JSON.stringify(result),
        );
        assert.equal(result.escalations, mode === "stalled" ? 1 : 0);
        assert.equal(result.coderModelCalls, mode === "stalled" ? 3 : 1);
        assert.equal(result.parallelPeak, 1);
        assert.equal(
          await git(
            result.integration!.path,
            "rev-list",
            "--count",
            `${base}..HEAD`,
          ),
          "1",
        );
        if (mode === "final-failure")
          assert.equal(result.verification.checks.at(-1)?.exitCode, 1);
        else assert.equal(result.verification.status, "VERIFIED_SUCCESS");
      } else if (mode === "scope-violation") {
        assert.equal(result.status, "VERIFIED_SUCCESS");
        assert.ok(events.some((e) => e.type === "write_scope_violation"));
        await assert.rejects(
          readFile(join(result.integration!.path, "unrelated.cjs")),
          { code: "ENOENT" },
        );
        assert.deepEqual(result.changedFiles, ["add.cjs"]);
      } else {
        assert.equal(
          result.status,
          "NOT_FULLY_VERIFIED",
          JSON.stringify(result),
        );
        assert.equal(
          events.some((e) => e.type === "integrated"),
          false,
        );
      }
      assert.equal(
        (await git(repo, "worktree", "list")).trim().split("\n").length,
        2,
      );
    } finally {
      await api.close();
      await cleanup(repo);
      await rm(output, { recursive: true, force: true });
    }
  });
}

test("same-layer writes to one file coalesce into one verified coding execution", async () => {
  const repo = await setup();
  await writeFile(
    join(repo, "add.cjs"),
    "module.exports = (a,b) => a-b; module.exports.multiply = (a,b) => a+b;\n",
  );
  await writeFile(
    join(repo, "multiply.cjs"),
    "module.exports = require('./add.cjs').multiply;\n",
  );
  await writeFile(join(repo, "report.cjs"), solutions.report!);
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "coalescing baseline");
  const combined: Plan = {
    ...plan,
    subtasks: [
      { ...makeTask("add"), likelyWritePaths: ["./add.cjs"] },
      { ...makeTask("multiply"), likelyWritePaths: ["add.cjs"] },
    ],
  };
  const api = await mock(false, false, false, {
    plan: combined,
    solutions: {
      add: "module.exports = (a,b) => a+b; module.exports.multiply = (a,b) => a*b;\n",
    },
  });
  const output = await mkdtemp(join(tmpdir(), "koda-coalesce-"));
  try {
    const result = await run({
      repo,
      task: "Fix the independent addition and multiplication bugs in add.cjs and multiply.cjs.",
      config: await config(undefined, {
        models: {},
        baseUrl: api.url,
        race: true,
      }),
      output,
      quiet: true,
    });
    assert.equal(result.status, "VERIFIED_SUCCESS", JSON.stringify(result));
    assert.equal(result.execution_strategy, "planned");
    assert.equal(result.plannedSubtasks, 2);
    assert.equal(result.coalescedSubtasks, 1);
    assert.equal(result.coderExecutions, 1);
    assert.equal(result.coderModelCalls, 1);
    assert.equal(result.maxConcurrentCodingWorkers, 1);
    const saved = JSON.parse(await readFile(join(output, "plan.json"), "utf8"));
    assert.equal(saved.subtasks.length, 1);
    assert.deepEqual(saved.subtasks[0].likelyWritePaths, ["add.cjs"]);
    assert.equal(saved.subtasks[0].verificationCommands.length, 2);
    assert.equal(result.finalVerificationStatus, "VERIFIED_SUCCESS");
  } finally {
    await api.close();
    await cleanup(repo);
    await rm(output, { recursive: true, force: true });
  }
});

test("three independent repairs genuinely overlap in isolated worktrees even with race enabled", async () => {
  const repo = await setup();
  const independent: Plan = {
    ...plan,
    subtasks: [makeTask("add"), makeTask("multiply"), makeTask("report")],
  };
  const api = await mock(false, false, false, {
    plan: independent,
    solutions: {
      ...solutions,
      report: "module.exports = (a,b) => ({sum:a+b,product:a*b});\n",
    },
  });
  const output = await mkdtemp(join(tmpdir(), "koda-parallel-"));
  try {
    const base = await git(repo, "rev-parse", "HEAD");
    const result = await run({
      repo,
      task: "Fix the three independent helpers in add.cjs, multiply.cjs and report.cjs.",
      config: await config(undefined, {
        models: {},
        baseUrl: api.url,
        maxParallel: 3,
        race: true,
      }),
      output,
      quiet: true,
    });
    assert.equal(result.status, "VERIFIED_SUCCESS", JSON.stringify(result));
    assert.equal(result.plannedSubtasks, 3);
    assert.equal(result.coalescedSubtasks, 3);
    assert.equal(result.coderExecutions, 3);
    assert.equal(result.coderModelCalls, 3);
    assert.ok(result.maxConcurrentCodingWorkers >= 2);
    assert.ok(result.maxConcurrentCodingWorkers <= 3);
    assert.equal(result.parallelPeak, result.maxConcurrentCodingWorkers);
    const events = (await readFile(join(output, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const active = new Set<string>();
    let peak = 0;
    for (const e of events) {
      if (e.type === "coding_worker_start") {
        assert.equal(active.has(e.worktree), false);
        active.add(e.worktree);
        peak = Math.max(peak, active.size);
      }
      if (e.type === "coding_worker_stop") active.delete(e.worktree);
    }
    assert.equal(active.size, 0);
    assert.equal(peak, result.maxConcurrentCodingWorkers);
    assert.equal(
      new Set(
        events
          .filter((e) => e.type === "coding_worker_start")
          .map((e) => e.worktree),
      ).size,
      3,
    );
    assert.equal(await git(repo, "rev-parse", "HEAD"), base);
    assert.equal(await git(repo, "status", "--porcelain"), "");
    assert.equal(result.finalVerificationStatus, "VERIFIED_SUCCESS");
  } finally {
    await api.close();
    await cleanup(repo);
    await rm(output, { recursive: true, force: true });
  }
});

test("worker context excludes unrelated large content and respects configured bounds in actual requests", async () => {
  const repo = await setup();
  await writeFile(join(repo, "multiply.cjs"), solutions.multiply!);
  await writeFile(join(repo, "report.cjs"), solutions.report!);
  await writeFile(
    join(repo, "unrelated.js"),
    "UNRELATED_SENTINEL ".repeat(100000),
  );
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "large unrelated file");
  const api = await mock(false, false, false, {
    plan,
    solutions: { direct: solutions.add! },
    directFile: "add.cjs",
  });
  const output = await mkdtemp(join(tmpdir(), "koda-context-"));
  try {
    const result = await run({
      repo,
      task: "Fix add.cjs so it returns the sum.",
      config: await config(undefined, {
        models: {},
        baseUrl: api.url,
        context: {
          maxBytes: 4096,
          fileBytes: 700,
          maxFiles: 5,
          toolResultBytes: 500,
          maxPromptBytes: 12000,
        },
      }),
      output,
      quiet: true,
    });
    assert.equal(result.status, "VERIFIED_SUCCESS", JSON.stringify(result));
    assert.equal(result.coderModelCalls, 1);
    assert.equal(result.plannerModelCalls, 0);
    const payload = JSON.parse(api.requests[0].messages[1].content);
    assert.ok(payload.context.files.some((f: any) => f.path === "add.cjs"));
    assert.ok(
      payload.context.files.some((f: any) => f.path === "tests/add.test.cjs"),
    );
    assert.ok(
      !payload.context.files.some((f: any) => f.path === "unrelated.js"),
    );
    assert.equal(
      JSON.stringify(api.requests).includes("UNRELATED_SENTINEL"),
      false,
    );
    assert.ok(Buffer.byteLength(JSON.stringify(payload.context)) <= 4096);
    assert.ok(
      payload.context.files.every(
        (f: any) => Buffer.byteLength(f.snippet) <= 700,
      ),
    );
    assert.ok(
      api.requests.every(
        (r) => Buffer.byteLength(JSON.stringify(r.messages)) <= 12000,
      ),
    );
    assert.equal(
      result.workerContexts[0]!.context_bytes,
      Buffer.byteLength(JSON.stringify(payload.context)),
    );
    assert.ok(
      result.workerContexts[0]!.context_files.includes("tests/add.test.cjs"),
    );
  } finally {
    await api.close();
    await cleanup(repo);
    await rm(output, { recursive: true, force: true });
  }
});
test("localized bug uses one worker to search, mutate and verify without planner or scout", async () => {
  const repo = await setup();
  await writeFile(join(repo, "multiply.cjs"), solutions.multiply!);
  await writeFile(join(repo, "report.cjs"), solutions.report!);
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "isolate addition bug");
  const api = await mock(false, false, false, {
    plan, solutions: { direct: solutions.add! }, directFile: "add.cjs", searchFirst: true,
  });
  const output = await mkdtemp(join(tmpdir(), "koda-search-direct-"));
  try {
    const result = await run({ repo, output, quiet: true,
      task: "Bug: add returns a subtraction. Reproduce by calling add(2, 3). Fix add.cjs so it returns the sum.",
      config: await config(undefined, { baseUrl: api.url, models: { CHEAP_CODER_A: "cheap-a" } }),
    });
    assert.equal(result.execution_strategy, "direct");
    assert.equal(result.status, "VERIFIED_SUCCESS", JSON.stringify(result));
    assert.equal(result.plannerModelCalls, 0);
    assert.ok(api.requests.some((request: any) => request.messages.some((entry: any) =>
      entry.role === "tool" && typeof entry.content === "string" &&
      entry.content.includes("add.cjs:1:"))));
  } finally { await api.close(); await cleanup(repo); await rm(output, { recursive: true, force: true }); }
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareTask,
  copyComparisonSnapshot,
  subscriptionEnv,
  subscriptionArguments,
  kodaUsage,
  type Invocation,
} from "../src/dev/benchmarkCompare.js";

test("both agents start identically, use the same task/check, and check outcomes override claims", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-compare-test-")),
    repo = join(root, "source");
  try {
    await mkdir(join(repo, "node_modules"), { recursive: true });
    await writeFile(join(repo, "value.cjs"), "module.exports = 0;\n");
    await writeFile(join(repo, "untracked.txt"), "dirty local state");
    await writeFile(
      join(repo, "node_modules", "local.txt"),
      "dependency snapshot",
    );
    const task = "Return 42 from value.cjs",
      check =
        "node -e \"require('node:assert/strict').equal(require('./value.cjs'),42)\"";
    const commands: Invocation[] = [];
    let checkCount = 0;
    const result = await compareTask(
      { repo, task, check, output: join(root, "out") },
      async (c) => {
        commands.push(c);
        if (c.argv[0] === "login")
          return { stdout: "", stderr: "Logged in using ChatGPT", exitCode: 0 };
        if (c.command === "/bin/sh") {
          assert.equal(
            commands.filter(
              (p) => p.command !== "/bin/sh" && p.argv[0] !== "login",
            ).length,
            2,
            "both arms must finish first",
          );
          assert.deepEqual(c.argv, ["-c", check]);
          checkCount++;
          return { stdout: "", stderr: "", exitCode: checkCount === 1 ? 1 : 0 };
        }
        assert.equal(
          await readFile(join(c.cwd, "value.cjs"), "utf8"),
          "module.exports = 0;\n",
        );
        assert.equal(
          await readFile(join(c.cwd, "untracked.txt"), "utf8"),
          "dirty local state",
        );
        assert.equal(
          await readFile(join(c.cwd, "node_modules", "local.txt"), "utf8"),
          "dependency snapshot",
        );
        await writeFile(
          join(c.cwd, "node_modules", "local.txt"),
          "private arm mutation",
        );
        if (c.command === "codex") {
          assert.equal(c.input, task);
          assert.equal(c.env.OPENAI_API_KEY, undefined);
          assert.equal(c.env.CODEX_API_KEY, undefined);
          return {
            stdout: JSON.stringify({
              type: "turn.completed",
              model: "reported-model",
              usage: { input_tokens: 20, output_tokens: 10 },
            }),
            stderr: "",
            exitCode: 0,
          };
        }
        assert.equal(c.argv[c.argv.indexOf("--task") + 1], task);
        assert.ok(c.argv.includes("--apply"));
        assert.equal(c.argv.includes("--force-model"), false);
        const report = c.argv[c.argv.indexOf("--output") + 1]!;
        await mkdir(report);
        await writeFile(
          join(report, "summary.json"),
          JSON.stringify({ costUsd: 999, costComplete: true }),
        );
        await writeFile(
          join(report, "events.jsonl"),
          JSON.stringify({
            type: "model_call",
            modelRequested: "routed-model",
            modelReturned: "routed-model",
            raw: { cost: 0.004 },
            costUsd: 999,
          }) + "\n",
        );
        return { stdout: "FAILED", stderr: "", exitCode: 1 };
      },
    );
    assert.equal(checkCount, 2);
    assert.equal(result.results.codex.passed, false);
    assert.equal(result.results.koda.passed, true);
    assert.equal(result.results.codex.cost, "subscription");
    assert.equal(result.results.codex.model, "reported-model");
    assert.equal(result.results.koda.costUsd, 0.004);
    assert.equal(
      await readFile(join(repo, "node_modules", "local.txt"), "utf8"),
      "dependency snapshot",
    );
    assert.equal(
      await readFile(join(repo, "value.cjs"), "utf8"),
      "module.exports = 0;\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("subscription invocation strips API credentials and forbids API login/custom provider", () => {
  const env = subscriptionEnv({
    OPENAI_API_KEY: "private",
    CODEX_API_KEY: "private",
    OPENAI_BASE_URL: "custom",
    HOME: "/home/user",
    CODEX_HOME: "/login",
  });
  assert.deepEqual(env, { HOME: "/home/user", CODEX_HOME: "/login" });
  const argv = subscriptionArguments("/repo");
  assert.ok(argv.includes('forced_login_method="chatgpt"'));
  assert.ok(argv.includes('model_provider="openai"'));
  assert.ok(argv.includes("--ignore-user-config"));
  assert.equal(argv.includes("--model"), false);
});
test("API-key login is rejected before Koda dispatch or copying", async () => {
  const repo = await mkdtemp(join(tmpdir(), "koda-api-login-"));
  try {
    let calls = 0;
    await assert.rejects(
      compareTask(
        { repo, task: "Fix", check: "true", output: repo + "-out" },
        async () => {
          calls++;
          return {
            stdout: "Logged in using an API key",
            stderr: "",
            exitCode: 0,
          };
        },
      ),
      /ChatGPT/,
    );
    assert.equal(calls, 1);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
test("cost is settled usage only; forecasts, token estimates and missing receipts stay unknown", () => {
  assert.equal(
    kodaUsage([], { costUsd: 100, costComplete: true }).costUsd,
    null,
  );
  assert.equal(
    kodaUsage([{ type: "provider_payload_bound", costUsd: 100 }], {
      costUsd: 100,
      costComplete: false,
    }).costUsd,
    null,
  );
  assert.equal(
    kodaUsage(
      [
        {
          type: "model_call",
          costUsd: 0.1,
          costSource: "estimated_from_tokens",
        },
      ],
      { costComplete: true },
    ).costUsd,
    null,
  );
  assert.equal(
    kodaUsage(
      [
        { type: "model_call", providerReportedCostUsd: 0.01 },
        { type: "model_call", providerReportedCostUsd: 0.02 },
      ],
      { costComplete: true },
    ).costUsd,
    0.03,
  );
  assert.equal(
    kodaUsage([{ type: "model_call", raw: { cost: 0.1 } }], {
      costComplete: true,
      synthetic: true,
    }).costUsd,
    null,
  );
});

test("snapshot preserves dependency executable links and isolates external linked dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-compare-links-"));
  try {
    const source = join(root, "source"),
      target = join(root, "copy"),
      external = join(root, "external");
    await mkdir(join(source, "node_modules/pkg/bin"), { recursive: true });
    await mkdir(join(source, "node_modules/pkg/lib"), { recursive: true });
    await mkdir(join(source, "node_modules/.bin"));
    await mkdir(external);
    await writeFile(
      join(source, "node_modules/pkg/lib/value.cjs"),
      "module.exports = 42",
    );
    await writeFile(
      join(source, "node_modules/pkg/bin/tool.cjs"),
      "console.log(require('../lib/value.cjs'))",
    );
    await symlink(
      "../pkg/bin/tool.cjs",
      join(source, "node_modules/.bin/tool"),
    );
    await writeFile(join(external, "value.txt"), "original");
    await symlink(external, join(source, "node_modules/external"));
    await copyComparisonSnapshot(source, target);
    const { execa } = await import("execa");
    const result = await execa(process.execPath, [
      join(target, "node_modules/.bin/tool"),
    ]);
    assert.equal(result.stdout, "42");
    assert.equal(
      await realpath(join(target, "node_modules/.bin/tool")),
      await realpath(join(target, "node_modules/pkg/bin/tool.cjs")),
    );
    await writeFile(join(target, "node_modules/external/value.txt"), "private");
    assert.equal(
      await readFile(join(external, "value.txt"), "utf8"),
      "original",
    );
    assert.equal(
      await readFile(join(source, "node_modules/pkg/lib/value.cjs"), "utf8"),
      "module.exports = 42",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy Agentic provider costs require reconciliation and estimates remain excluded', () => {
  const call = { type: 'model_call', stage: 'implement', subtaskId: 'task', costUsd: .001, promptTokens: 100, completionTokens: 10 };
  const stop = { type: 'coding_worker_stop', worker_engine: 'agentic', worker_version: '1', subtaskId: 'task', cost_usd: .001, input_tokens: 100, output_tokens: 10 };
  assert.equal(kodaUsage([call, stop], { costComplete: true }).costUsd, .001);
  assert.equal(kodaUsage([call], { costComplete: true }).costUsd, null);
  assert.equal(kodaUsage([call, { ...stop, cost_usd: .002 }], { costComplete: true }).costUsd, null);
  assert.equal(kodaUsage([{ ...call, costSource: 'estimated_from_tokens' }, stop], { costComplete: true }).costUsd, null);
});

test('Claude API arm uses default model, isolated copies, same check and reported dollar cost', async () => {
  const root = await mkdtemp(join(tmpdir(), 'koda-claude-compare-'));
  const repo = join(root, 'source');
  const oldKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-only-key';
  try {
    await mkdir(repo); await writeFile(join(repo, 'value.cjs'), 'module.exports=0;');
    let checks = 0;
    const result = await compareTask({ baseline: 'claude', claudeBudgetUsd: .2, budgetUsd: .5, repo, task: 'Return 1', check: 'independent-check', output: join(root, 'out') }, async c => {
      if (c.command === '/bin/sh') { assert.deepEqual(c.argv, ['-c', 'independent-check']); checks++; return { stdout: '', stderr: '', exitCode: 0 }; }
      assert.equal(await readFile(join(c.cwd, 'value.cjs'), 'utf8'), 'module.exports=0;');
      if (c.command === 'claude') {
        assert.equal(c.env.ANTHROPIC_API_KEY, 'test-only-key');
        assert.ok(c.argv.includes('--bare')); assert.equal(c.argv.includes('--model'), false);
        assert.equal(c.argv[c.argv.indexOf('--max-budget-usd') + 1], '0.2');
        assert.equal(c.input, 'Return 1');
        return { stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: .012, modelUsage: { 'reported-model': {} }, usage: { input_tokens: 10 } }), stderr: '', exitCode: 0 };
      }
      assert.equal(c.env.ANTHROPIC_API_KEY, undefined);
      return { stdout: '', stderr: '', exitCode: 1 };
    });
    assert.equal(checks, 2); assert.equal(result.results.claude.costUsd, .012);
    assert.equal(result.results.claude.model, 'reported-model');
    assert.ok(result.table.includes('Claude Code'));
  } finally {
    if (oldKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = oldKey;
    await rm(root, { recursive: true, force: true });
  }
});

test("incomplete receipts preserve known costs and identify the missing call without inventing total cost",()=>{
 const result=kodaUsage([{type:"model_call",stage:"implement",modelReturned:"model/a",raw:{cost:.01}},
 {type:"model_call",stage:"completion-review",modelRequested:"model/b",outcome:"error",error:"Request aborted",costUsd:null}],{costComplete:false});
 assert.equal(result.costUsd,null);
 assert.equal(result.knownReceiptCostUsd,.01);
 assert.deepEqual(result.missingReceipts,[{stage:"completion-review",model:"model/b",responseId:null,outcome:"error",error:"Request aborted"}]);
});

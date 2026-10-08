import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import {
  claudeArguments,
  parseClaudeOutput,
  benchmarkArms,
} from "../src/dev/claudeBenchmark.js";
import {
  runRealBenchmark,
  comparisonReport,
  type BenchmarkRow,
} from "../src/dev/realBenchmark.js";
import { benchmarkPlan } from "../src/dev/realBenchmarkWorker.js";
test("Claude invocation uses installed supported print, model, streaming and budget flags", () => {
  const args = claudeArguments("arbitrary-model-id", 0.25);
  for (const flag of [
    "-p",
    "--model",
    "--max-budget-usd",
    "--no-session-persistence",
    "--safe-mode",
  ])
    assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf("--model") + 1], "arbitrary-model-id");
  assert.equal(args[args.indexOf("--max-budget-usd") + 1], "0.25");
  assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
  assert.ok(!args.includes("--bare")); // installed keychain/API-billing auth is preserved
  assert.throws(() => claudeArguments("opus", 0), /budget/);
});
test("aliases are arbitrary; optional fable and opusplan remain separate arms", () => {
  assert.deepEqual(
    benchmarkArms(["opus", "sonnet", "haiku", "fable", "opusplan", "my-model"]),
    [
      "routing-v1",
      "current-koda",
      "claude:opus",
      "claude:sonnet",
      "claude:haiku",
      "claude:fable",
      "claude:opusplan",
      "claude:my-model",
    ],
  );
  assert.throws(() => benchmarkArms(["opus", "opus"]), /duplicate/);
});
test("actual served models, usage and API cost are parsed without double counting", () => {
  const parsed = parseClaudeOutput(
    [
      {
        type: "assistant",
        message: {
          model: "actual-opus",
          usage: { input_tokens: 10 },
          content: [{ type: "tool_use", id: "t", name: "Edit" }],
        },
      },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t" }] },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        total_cost_usd: 0.12,
        modelUsage: {
          "actual-opus": { costUSD: 0.1 },
          "actual-haiku": { costUSD: 0.02 },
        },
        usage: { input_tokens: 20, output_tokens: 30 },
      },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n"),
  );
  assert.equal(parsed.costUsd, 0.12);
  assert.ok(parsed.costComplete);
  assert.equal(parsed.tokens.output_tokens, 30);
  assert.deepEqual(parsed.models, ["actual-opus", "actual-haiku"]);
  assert.equal(parsed.attempts[0]!.tools[0].name, "Edit");
  assert.equal(parsed.toolResults.length, 1);
});
test("malformed and missing usage never become zero-cost success", () => {
  const parsed = parseClaudeOutput(
    'not json\n{"type":"assistant","message":{"model":"x"}}',
  );
  assert.equal(parsed.costUsd, null);
  assert.equal(parsed.costComplete, false);
  assert.equal(parsed.claimedSuccess, false);
  assert.equal(
    parseClaudeOutput(
      '{"type":"result","subtype":"error_max_budget_usd","is_error":true,"total_cost_usd":0.2}',
    ).claimedSuccess,
    false,
  );
});
test("current Koda policy stays unchanged", () => {
  const base = {} as any;
  assert.equal(benchmarkPlan(base, "current-koda", null), base);
});
test("five arms use identical tasks in clean real clones; independent oracle detects false accepts; resume does not dispatch again", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-claude-harness-"));
  try {
    const source = join(root, "source"),
      oracle = join(root, "oracle"),
      output = join(root, "output");
    await mkdir(source);
    await mkdir(oracle);
    await writeFile(join(source, "value.js"), "module.exports = 0;\n");
    await execa("git", ["init", "-q"], { cwd: source });
    await execa("git", ["add", "."], { cwd: source });
    await execa(
      "git",
      [
        "-c",
        "user.name=Harness",
        "-c",
        "user.email=harness@example.invalid",
        "commit",
        "-qm",
        "baseline",
      ],
      { cwd: source },
    );
    const commit = (await execa("git", ["rev-parse", "HEAD"], { cwd: source }))
      .stdout;
    await writeFile(
      join(oracle, "check.cjs"),
      "const assert=require('node:assert/strict'); const path=require('node:path'); assert.equal(require(path.join(process.argv[2], 'value.js')),42);\n",
    );
    const manifest = join(root, "tasks.json"),
      config = join(root, "config.json"),
      priors = join(root, "priors.json");
    await writeFile(config, "{}");
    await writeFile(priors, '{"priors":[],"rescueEvidence":[]}');
    await writeFile(
      manifest,
      JSON.stringify({
        version: 1,
        tasks: [
          {
            id: "real-issue",
            category: "debugging",
            split: "development",
            repo: source,
            commit,
            task: "Return 42 from value.js",
            writeScope: ["value.js"],
            oracleDirectory: oracle,
            acceptance: { argv: [process.execPath, "check.cjs"] },
            verification: [{ argv: [process.execPath, "--check", "value.js"] }],
          },
        ],
      }),
    );
    const prompts: string[] = [],
      repos: string[] = [];
    const options = {
      manifest,
      config,
      priors,
      output,
      split: "development",
      budgetUsd: 1,
      claudeModels: ["opus", "sonnet", "haiku"],
      execute: async (job: {
        arm: string;
        repo: string;
        report: string;
        prompt: string;
        budgetUsd: number;
        argv: string[];
      }) => {
        prompts.push(job.prompt);
        repos.push(job.repo);
        assert.equal(
          await readFile(join(job.repo, "value.js"), "utf8"),
          "module.exports = 0;\n",
        );
        assert.equal(job.budgetUsd, 0.2);
        await writeFile(
          join(job.repo, "value.js"),
          job.arm === "claude:haiku"
            ? "module.exports = 7;\n"
            : "module.exports = 42;\n",
        );
        if (job.arm.startsWith("claude:"))
          return {
            stdout: JSON.stringify({
              type: "result",
              subtype: "success",
              is_error: false,
              total_cost_usd: 0.01,
              usage: { input_tokens: 10, output_tokens: 10 },
              modelUsage: { served: { costUSD: 0.01 } },
            }),
            stderr: "",
            exitCode: 0,
          };
        await mkdir(job.report, { recursive: true });
        await writeFile(
          join(job.report, "summary.json"),
          JSON.stringify({
            status: "VERIFIED_SUCCESS",
            applyResult: "applied",
            costUsd: 0.01,
            costComplete: true,
          }),
        );
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    await runRealBenchmark(options);
    assert.equal(prompts.length, 5);
    assert.equal(new Set(prompts).size, 1);
    assert.equal(new Set(repos).size, 5);
    assert.equal(
      await readFile(join(source, "value.js"), "utf8"),
      "module.exports = 0;\n",
    );
    const state = JSON.parse(
      await readFile(join(output, "state.json"), "utf8"),
    );
    assert.equal(
      state.rows.find((r: any) => r.arm === "claude:haiku").falseAccept,
      true,
    );
    const report = JSON.parse(
      await readFile(join(output, "comparison.json"), "utf8"),
    );
    assert.equal(report.arms["claude:haiku"].verifiedSolves, 0);
    assert.equal(report.arms["claude:opus"].costPerVerifiedSolve, 0.01);
    assert.match(
      await readFile(join(output, "comparison.md"), "utf8"),
      /claude:sonnet/,
    );
    await runRealBenchmark({ ...options, resume: true });
    assert.equal(prompts.length, 5);
    await assert.rejects(
      runRealBenchmark({ ...options, resume: true, budgetUsd: 2 }),
      /identical/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ground-truth solve is independent of an agent success claim", () => {
  const row: BenchmarkRow = {
    taskId: "issue",
    category: "debugging",
    arm: "claude:opus",
    status: "NOT_FULLY_VERIFIED",
    verified: false,
    groundTruthSolve: true,
    falseAccept: false,
    oraclePass: true,
    mutation: true,
    models: [],
    attempts: [],
    costUsd: 0.1,
    costComplete: true,
    costBasis: "reported",
    tokens: null,
    wallClockMs: 100,
    failureAttribution: null,
    referenceCalls: null,
    reservationUsd: 1,
  };
  const report = comparisonReport([row], 1, ["claude:opus"]);
  assert.equal(report.arms["claude:opus"]!.groundTruthSolves, 1);
  assert.equal(report.arms["claude:opus"]!.verifiedSolves, 0);
});

import { Worktrees } from "../src/worktrees/manager.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { config } from "../src/config.js";
import { run } from "./helpers/run.js";
import { git } from "../src/repo/commands.js";

type Case = "compiler" | "assertion" | "mismatch" | "progress" | "stuck" | "fallback" | "provider" | "no-progress-fallback" | "infrastructure";
const source = "exports.add=(a,b)=>a+b;\n";
const baseTest =
  "const {test}=require('node:test');const assert=require('node:assert/strict');const {add}=require('../src/calc.cjs');test('positive',()=>assert.equal(add(2,3),5));";
const goodTest = `${baseTest}test('negative',()=>assert.equal(add(-2,3),1));\n`;
const badAssertion = `${baseTest}test('negative',()=>assert.equal(add(-2,3),2));\n`;
const differentBadAssertion = `${baseTest}test('negative',()=>assert.equal(add(-2,3),3));\n`;
const duplicateImport = `const assert=require('node:assert/strict');${goodTest}`;

async function fixture(mode: Case) {
  const root = await mkdtemp(join(tmpdir(), "koda-final-repair-"));
  const repo = join(root, "repo");
  const output = join(root, "output");
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "tests"));
  await writeFile(
    join(repo, "package.json"),
    JSON.stringify({
      type: "commonjs",
      scripts: {
        typecheck: "node --check tests/calc.test.cjs",
        test: mode === "infrastructure" ? "node tests/infra.cjs" : "node tests/run.cjs",
      },
    }),
  );
  await writeFile(join(repo, "src/calc.cjs"), "exports.add=(a,b)=>a-b;\n");
  await writeFile(join(repo, "src/unrelated.cjs"), "UNRELATED_SENTINEL\n");
  await writeFile(join(repo, "tests/calc.test.cjs"), `${baseTest}\n`);
  await writeFile(join(repo, "tests/run.cjs"), "require('./calc.test.cjs');\n");
  if (mode === "infrastructure")
    await writeFile(join(repo, "tests/infra.cjs"),
      "console.error('ENOENT: invalid .git/worktrees/copied-candidate path');process.exit(1);\n");
  await git(repo, "init", "-q");
  await git(repo, "config", "user.name", "Stable Repair Test");
  await git(repo, "config", "user.email", "stable-repair@test.local");
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "baseline");

  const requests: any[] = [];
  let repairCalls = 0;
  const response = (model: string, message: any) =>
    JSON.stringify({
      id: `mock-${requests.length}`,
      model,
      choices: [{ index: 0, message }],
      usage: { prompt_tokens: 20, completion_tokens: 20, cost: 0 },
    });
  const tool = (id: string, name: string, args: object) => ({
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  });
  const server = createServer(async (request, reply) => {
    reply.setHeader("content-type", "application/json");
    if (request.url?.endsWith("/models")) {
      reply.end(
        JSON.stringify({
          data: [
            {
              id: "cheap",
              context_length: 100000,
              pricing: { prompt: "0.0000001", completion: "0.0000002" },
              supported_parameters: ["tools", "tool_choice", "structured_outputs"],
            },
            { id: "strong", context_length: 100000,
              pricing: { prompt: "0.000001", completion: "0.000002" },
              supported_parameters: ["tools", "tool_choice", "structured_outputs"] },
          ],
        }),
      );
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const prompt = body.messages[0].content as string;
    let message: any;
    if (prompt.includes("read-only inspection phase") ||
        body.tools?.some((entry: any) => entry.function?.name === "lock_write_scope")) {
      message =
        body.tools?.some((entry: any) => entry.function?.name === "read_file")
          ? {
              role: "assistant",
              content: null,
              tool_calls: [
                tool("read-source", "read_file", { path: "src/calc.cjs" }),
                tool("read-test", "read_file", { path: "tests/calc.test.cjs" }),
              ],
            }
          : {
              role: "assistant",
              content: null,
              tool_calls: [
                tool("lock", "lock_write_scope", {
                  paths: ["src/calc.cjs", "tests/calc.test.cjs"],
                  reason: "Fix addition and cover negative inputs",
                }),
              ],
            };
    } else if (
      prompt.includes("repairing one failed Stable final verification")
    ) {
      repairCalls++;
      if (mode === "provider" && body.model === "cheap") {
        reply.statusCode = 520;
        reply.end(JSON.stringify({ error: { message: "Transient provider failure" } }));
        return;
      }
      message =
        mode === "fallback" && body.model === "cheap"
          ? { role: "assistant", content: null, tool_calls: [{ id: "malformed",
              type: "function", function: { name: "write_file", arguments: "{" } }] }
          :
        mode === "stuck" || mode === "no-progress-fallback" && body.model === "cheap"
          ? { role: "assistant", content: "I am done." }
          : mode === "mismatch" && repairCalls === 1
            ? {
                role: "assistant",
                content: null,
                tool_calls: [
                  tool("failed-exact-replace", "edit_file", {
                    path: "tests/calc.test.cjs", oldText: "missing exact text", newText: "fixed",
                  }),
                ],
              }
            : {
                role: "assistant",
                content: null,
                tool_calls: [
                  ...(mode === "assertion" ? [tool("fix-test", "edit_file", {
                    path: "tests/calc.test.cjs", oldText: badAssertion, newText: goodTest,
                  })] : [tool("fix-test", "write_file", {
                    path: "tests/calc.test.cjs",
                    content:
                      mode === "progress" && repairCalls === 1
                        ? differentBadAssertion
                        : goodTest,
                  })]),
                ],
              };
    } else {
      message = {
        role: "assistant",
        content: null,
        tool_calls: [
          tool("fix-source", "write_file", {
            path: "src/calc.cjs",
            content: source,
          }),
          tool("write-regression", "write_file", {
            path: "tests/calc.test.cjs",
            content: mode === "compiler" || mode === "infrastructure" ? duplicateImport : badAssertion,
          }),
        ],
      };
    }
    reply.end(response(body.model, message));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    root,
    repo,
    output,
    requests,
    server,
    get repairCalls() {
      return repairCalls;
    },
  };
}

for (const mode of [
  "compiler",
  "assertion",
  "mismatch",
  "progress",
  "stuck",
  "fallback",
  "provider",
  "no-progress-fallback",
  "infrastructure",
] as const) {
  test.skip(`legacy native-loop final repair protocol: ${mode}`, async () => {
    const f = await fixture(mode);
    try {
      const result = await run({
        repo: f.repo,
        task: "Inspect src/calc.cjs and tests/calc.test.cjs, fix one small issue and add a regression test. Do not change dependencies or unrelated files.",
        config: await config(undefined, {
          modelPool: {
            provider: "openrouter",
            models: [
              {
                id: "cheap",
                tier: "fast",
                qualityPrior: 0.95,
                latencyPriorMs: 100,
                strengths: ["coding", "tool_use", "structured_output"],
              },
              ...(["fallback", "provider", "progress", "no-progress-fallback"].includes(mode) ? [{ id: "strong", tier: "strong" as const,
                qualityPrior: 0.96, latencyPriorMs: 100,
                strengths: ["coding", "tool_use", "structured_output"] }] : []),
            ],
          },
          baseUrl: `http://127.0.0.1:${(f.server.address() as any).port}/v1`,
          routing: { stateDirectory: join(f.root, "routing") },
          budgetUsd: 0.1,
        }),
        output: f.output,
        quiet: true,
        apply: mode === "infrastructure",
      });
      const events = (await readFile(join(f.output, "events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(result.execution_strategy, "stable");
      assert.equal(
        events.filter((event) => event.type === "stable_scope_locked").length,
        1,
      );
      assert.equal(
        events.filter((event) => event.type === "stable_worker_start").length,
        1,
      );
      const repairRequests = f.requests.filter((request) =>
        request.messages[0].content.includes(
          "repairing one failed Stable final verification",
        ),
      );
      assert.equal(repairRequests.length, f.repairCalls);
      assert.ok(repairRequests.length <= 4);
      for (const request of repairRequests) {
        const prompt = JSON.stringify(request.messages);
        assert.ok(!prompt.includes("UNRELATED_SENTINEL"));
        assert.ok(!prompt.includes("repoMap"));
        assert.ok(!prompt.includes("localDependencies"));
        assert.deepEqual(
          request.tools.map((item: any) => item.function.name),
          ["write_file", "edit_file", "apply_patch"],
        );
        const input = JSON.parse(request.messages[1].content);
        assert.deepEqual(input.lockedWritePaths, [
          "src/calc.cjs",
          "tests/calc.test.cjs",
        ]);
        assert.equal(input.changedFiles, undefined);
        assert.match(input.currentDiff, /calc\.test\.cjs/);
        assert.ok(input.failedChecks.some((check: any) => check.exitCode !== 0));
        assert.equal(input.implicatedFiles, undefined);
        assert.ok(
          input.currentLockedFiles.some(
            (file: any) => file.path === "tests/calc.test.cjs",
          ),
        );
      }
      const initialFailure = events.find(
        (event) =>
          event.type === "final_verification" && event.outcome === "CHECK_FAIL",
      );
      assert.ok(initialFailure);
      if (mode === "compiler") {
        assert.match(
          initialFailure.stdout + initialFailure.stderr,
          /Identifier 'assert' has already been declared/,
        );
        assert.ok(
          repairRequests.some((request) =>
            JSON.stringify(request.messages).includes(
              "Identifier 'assert' has already been declared",
            ),
          ),
        );
      }
      if (mode === "infrastructure") {
        assert.equal(result.status, "NOT_FULLY_VERIFIED");
        assert.equal(f.repairCalls, 1);
        assert.equal(result.applyResult, "not_verified");
        assert.equal(result.candidateProduced, true);
        assert.ok(result.candidatePatchPath);
        assert.match(await readFile(result.candidatePatchPath!, "utf8"), /negative/);
        assert.ok(events.some((event) =>
          event.type === "stable_final_repair_operational_failure"));
        assert.ok(events.some((event) =>
          event.type === "final_verification" &&
          event.outcome === "INFRA_FAILURE" &&
          event.unavailable === "verification_git_worktree_environment"));
        const history = await readFile(join(f.root, "routing", "attempts.jsonl"), "utf8");
        assert.ok(!history.includes('"failureAttribution":"verified_patch_regression"'));
      } else if (mode === "stuck") {
        assert.equal(result.status, "FAILED");
        assert.equal(f.repairCalls, 2);
        assert.ok(
          events.some(
            (event) => event.type === "stable_final_repair_exhausted",
          ),
        );
      } else {
        assert.equal(result.status, "VERIFIED_SUCCESS", result.error);
        assert.equal(
          f.repairCalls,
          mode === "no-progress-fallback" ? 3 :
            mode === "mismatch" || mode === "progress" || mode === "fallback" || mode === "provider" ? 2 : 1,
        );
        if (mode === "mismatch") {
          const secondInput = JSON.parse(repairRequests[1].messages[1].content);
          assert.match(
            secondInput.previousToolError,
            /oldText|not found|match/,
          );
        }
        if (mode === "progress") {
          assert.equal(
            events.filter((event) => event.type === "stable_final_repair_start")
              .length,
            1,
          );
          assert.equal(
            events.filter((event) => event.type === "stable_final_repair_check")
              .length,
            1,
          );
          assert.ok(events.some((event) => event.type === "stable_final_repair_model_exhausted" &&
            event.outcome === "VERIFIED_REGRESSION"));
        }
        if (mode === "fallback" || mode === "provider" || mode === "no-progress-fallback") {
          assert.deepEqual(repairRequests.map((request) => request.model),
            mode === "no-progress-fallback" ? ["cheap", "cheap", "strong"] : ["cheap", "strong"]);
          assert.ok(events.some((event) => event.type === "stable_final_repair_model_exhausted" &&
            event.outcome === (mode === "no-progress-fallback" ? "NO_PROGRESS" : "OPERATIONAL_FAILURE")));
          if (mode === "fallback") {
            assert.ok(!JSON.stringify(repairRequests[1].messages).includes(differentBadAssertion));
          }
          const history = await readFile(join(f.root, "routing", "attempts.jsonl"), "utf8");
          assert.ok(!history.includes('"failureAttribution":"verified_patch_regression"'));
          assert.equal(await readFile(join(result.integration!.path, "tests/calc.test.cjs"), "utf8"), goodTest);
          assert.ok(result.verification.checks.every((check: any) => check.outcome === "CHECK_PASS"));
        }
        assert.ok(
          events.some((event) => event.type === "stable_final_repair_success"),
        );
        assert.ok(
          events.some(
            (event) =>
              event.type === "stable_final_repair_check" &&
              event.status === "VERIFIED_SUCCESS",
          ),
        );
        assert.ok(
          events.filter(
            (event) =>
              event.type === "final_verification" &&
              event.outcome === "CHECK_PASS",
          ).length >= 2,
        );
      }
      assert.equal(
        await readFile(join(f.repo, "src/calc.cjs"), "utf8"),
        "exports.add=(a,b)=>a-b;\n",
      );
    } finally {
      await new Promise<void>((resolve) => f.server.close(() => resolve()));
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

for (const outcome of ["accepted", "lost-at-promotion", "baseline-return"] as const) {
test.skip(`legacy native-loop repair promotion protocol: ${outcome}`, async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-stable-repair-chain-"));
  const repo = join(root, "repo"), output = join(root, "output");
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "tests"));
  const baselineSource = "exports.add=(a,b)=>a-b;exports.safe=()=>true;\n";
  const candidateSource = "exports.add=(a,b)=>a+b;exports.safe=()=>false;\n";
  const rejectedRepair = "exports.add=(a,b)=>a+b;exports.safe=()=>false;// rejected repair\n";
  const verifiedRepair = "exports.add=(a,b)=>a+b;exports.safe=()=>true;// verified repair\n";
  await writeFile(join(repo, "src/calc.cjs"), baselineSource);
  await writeFile(join(repo, "tests/focused.test.cjs"),
    "const{test}=require('node:test');const assert=require('node:assert/strict');const{add}=require('../src/calc.cjs');test('addition',()=>assert.equal(add(2,3),5));\n");
  await writeFile(join(repo, "tests/all.cjs"),
    "const{safe}=require('../src/calc.cjs');console.error('FAIL baseline-A\\nFAIL baseline-B'+(safe()?'':'\\nFAIL regression-C'));process.exit(1);\n");
  await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: {
    test: "node tests/all.cjs",
  } }));
  await git(repo, "init", "-q"); await git(repo, "config", "user.name", "Repair Chain");
  await git(repo, "config", "user.email", "repair-chain@test.local");
  await git(repo, "add", "."); await git(repo, "commit", "-qm", "baseline");
  const baseCommit = await git(repo, "rev-parse", "HEAD");
  const originalCommit = Worktrees.prototype.commit;
  if (outcome === "lost-at-promotion") Worktrees.prototype.commit = async function(path, message) {
    const result = await originalCommit.call(this, path, message);
    if (message.startsWith("agent: stable final repair")) await git(path, "reset", "--hard", baseCommit);
    return result;
  };
  const requests: any[] = [];
  const repairModels: string[] = [];
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.endsWith("/models")) {
      response.end(JSON.stringify({ data: ["model-a", "model-b", "model-c", "model-d"].map((id, index) => ({
        id, context_length: 100000,
        pricing: { prompt: String((index + 1) / 10_000_000), completion: String((index + 1) / 5_000_000) },
        supported_parameters: ["tools", "tool_choice", "structured_outputs"],
      })) })); return;
    }
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    const repairing = body.messages[0].content.includes("repairing one failed Stable final verification");
    const tool = (content: string) => ({ role: "assistant", content: null, tool_calls: [{
      id: `write-${requests.length}`, type: "function", function: { name: "write_file",
        arguments: JSON.stringify({ path: "src/calc.cjs", content }) },
    }] });
    let message: any;
    if (repairing) {
      if (!repairModels.includes(body.model)) repairModels.push(body.model);
      message = repairModels.indexOf(body.model) === 0 ? tool(rejectedRepair) : tool(outcome === "baseline-return" ? baselineSource : verifiedRepair);
    } else if (body.model === "model-a") {
      message = { role: "assistant", content: "No mutation yet." };
    } else message = tool(candidateSource);
    response.end(JSON.stringify({ id: `mock-${requests.length}`, model: body.model,
      choices: [{ index: 0, message }], usage: { prompt_tokens: 20, completion_tokens: 20, cost: 0 } }));
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const result = await run({ repo, output, quiet: true, apply: true,
      task: "Inspect src/calc.cjs, fix addition using the existing focused test, and preserve existing behavior.",
      config: await config(undefined, { baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
        modelPool: { provider: "openrouter", models: ["model-a", "model-b", "model-c", "model-d"].map((id, index) => ({
          id, tier: index < 2 ? "fast" as const : index === 2 ? "strong" as const : "frontier" as const,
          qualityPrior: 0.96, latencyPriorMs: 100 + index,
          strengths: ["coding", "tool_use", "structured_output"],
        })) }, routing: { stateDirectory: join(root, "routing") }, budgetUsd: 0.1 }) });
    assert.equal(result.execution_strategy, "stable");
    if (outcome !== "accepted") {
      assert.equal(result.status, "FAILED");
      assert.notEqual(result.applyResult, "applied");
      assert.match(result.error ?? "", /repair.*(?:removed|disappeared|changed)/i);
      assert.equal(await readFile(join(repo, "src/calc.cjs"), "utf8"), baselineSource);
      return;
    }
    assert.equal(result.status, "VERIFIED_SUCCESS", result.error);
    assert.equal(result.applyResult, "applied");
    assert.equal(await readFile(join(repo, "src/calc.cjs"), "utf8"), verifiedRepair);
    assert.match(await git(repo, "diff", baseCommit), /verified repair/);
    assert.match(await git(result.integration!.path, "diff", baseCommit), /verified repair/);
    assert.ok(result.changeset.some((change) => change.path === "src/calc.cjs"));
    assert.ok(repairModels.length >= 2, JSON.stringify(repairModels));
    const events = (await readFile(join(output, "events.jsonl"), "utf8")).trim()
      .split("\n").map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.type === "stable_final_repair_model_exhausted" &&
      event.outcome === "NO_PROGRESS"));
    assert.ok(events.some((event) => event.type === "attempt_rollback" ||
      event.type === "stable_final_repair_model_exhausted" && event.changedPaths?.includes("src/calc.cjs")));
    assert.ok(events.some((event) => event.type === "stable_final_verification_relative_to_baseline" &&
      event.status === "VERIFIED_SUCCESS"));
    assert.equal(await readFile(join(result.integration!.path, "src/calc.cjs"), "utf8"), verifiedRepair);
    assert.ok(!await readFile(join(result.integration!.path, "src/calc.cjs"), "utf8").then((text) => text.includes("rejected repair")));
    const secondRepair = requests.find((request) => request.model === repairModels[1] &&
      request.messages[0].content.includes("repairing one failed Stable final verification"));
    assert.match(JSON.stringify(secondRepair.messages), /regression-C/);
    assert.match(JSON.stringify(secondRepair.messages), /rejected repair/);
  } finally {
    Worktrees.prototype.commit = originalCommit;
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

}

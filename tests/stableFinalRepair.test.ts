import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { config } from "../src/config.js";
import { run } from "../src/run.js";
import { git } from "../src/repo/commands.js";

type Case = "compiler" | "assertion" | "mismatch" | "progress" | "stuck";
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
        test: "node tests/run.cjs",
      },
    }),
  );
  await writeFile(join(repo, "src/calc.cjs"), "exports.add=(a,b)=>a-b;\n");
  await writeFile(join(repo, "src/unrelated.cjs"), "UNRELATED_SENTINEL\n");
  await writeFile(join(repo, "tests/calc.test.cjs"), `${baseTest}\n`);
  await writeFile(join(repo, "tests/run.cjs"), "require('./calc.test.cjs');\n");
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
      message =
        mode === "stuck"
          ? { role: "assistant", content: "I am done." }
          : mode === "mismatch" && repairCalls === 1
            ? {
                role: "assistant",
                content: null,
                tool_calls: [
                  tool("failed-exact-replace", "run_command", {
                    command:
                      "node -e \"const fs=require('fs');const p='tests/calc.test.cjs';const s=fs.readFileSync(p,'utf8');if(!s.includes('missing exact text'))process.exit(1);fs.writeFileSync(p,s.replace('missing exact text','fixed'))\"",
                  }),
                ],
              }
            : {
                role: "assistant",
                content: null,
                tool_calls: [
                  tool("fix-test", "write_file", {
                    path: "tests/calc.test.cjs",
                    content:
                      mode === "progress" && repairCalls === 1
                        ? differentBadAssertion
                        : goodTest,
                  }),
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
            content: mode === "compiler" ? duplicateImport : badAssertion,
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
] as const) {
  test(`Stable final repair is focused and bounded: ${mode}`, async () => {
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
            ],
          },
          baseUrl: `http://127.0.0.1:${(f.server.address() as any).port}/v1`,
          routing: { stateDirectory: join(f.root, "routing") },
          budgetUsd: 0.1,
        }),
        output: f.output,
        quiet: true,
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
          ["write_file", "run_command"],
        );
        const input = JSON.parse(request.messages[1].content);
        assert.deepEqual(input.lockedWritePaths, [
          "src/calc.cjs",
          "tests/calc.test.cjs",
        ]);
        assert.deepEqual(input.changedFiles, [
          "src/calc.cjs",
          "tests/calc.test.cjs",
        ]);
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
      if (mode === "stuck") {
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
          mode === "mismatch" || mode === "progress" ? 2 : 1,
        );
        if (mode === "mismatch") {
          const secondInput = JSON.parse(repairRequests[1].messages[1].content);
          assert.match(
            secondInput.previousToolError,
            /exitCode|exit code|Command failed|process\.exit/,
          );
        }
        if (mode === "progress") {
          assert.equal(
            events.filter((event) => event.type === "stable_final_repair_start")
              .length,
            2,
          );
          assert.equal(
            events.filter((event) => event.type === "stable_final_repair_check")
              .length,
            2,
          );
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

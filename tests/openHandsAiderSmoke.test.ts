import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AiderExecutor } from "../src/agent/aiderExecutor.js";
import { OpenHandsExplorer } from "../src/agent/openHandsExplorer.js";
import { config } from "../src/config.js";
import { git } from "../src/repo/commands.js";
import { run } from "../src/run.js";

const enabled = process.env.KODA_REAL_OPENHANDS_SMOKE === "1";

test("real no-path OpenHands exploration scopes Aider and Koda verifies the edit", {
  skip: !enabled,
}, async () => {
  const base = await mkdtemp(join(tmpdir(), "koda-openhands-aider-smoke-"));
  const repo = join(base, "repo");
  const output = join(base, "output");
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "tests"));
  await writeFile(join(repo, "src/value.cjs"), "module.exports = 1;\n");
  await writeFile(join(repo, "tests/value.test.cjs"),
    "const {test}=require('node:test');const assert=require('node:assert/strict');const value=require('../src/value.cjs');test('value',()=>assert.equal(value,2));\n");
  await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: {
    test: "node --test tests/value.test.cjs",
  } }));
  await git(repo, "init", "-q");
  await git(repo, "config", "user.name", "Koda Smoke");
  await git(repo, "config", "user.email", "smoke@koda.local");
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "baseline");

  let modelCalls = 0;
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const names = new Set((body.tools ?? []).map((tool: any) => tool.function.name));
    assert.equal([...names].some((name) => /write|edit|terminal/.test(String(name))), false);
    modelCalls++;
    const call = modelCalls === 1
      ? { name: "koda_search_repository", arguments: { query: "module.exports", glob: "**/*.cjs", limit: 20 } }
      : modelCalls === 2
        ? { name: "koda_read_repository_file", arguments: { path: "src/value.cjs", start_line: 1, end_line: 40 } }
        : modelCalls === 3
          ? { name: "koda_read_repository_file", arguments: { path: "tests/value.test.cjs", start_line: 1, end_line: 40 } }
          : modelCalls === 4
            ? { name: "koda_submit_repository_exploration", arguments: {
                confidence: "high",
                editable_candidates: [{ path: "src/value.cjs", reason: "Defines the failing exported value" }],
                readonly_files: [],
                related_tests: ["tests/value.test.cjs"],
                dependencies: [],
                evidence: [{ path: "src/value.cjs", detail: "The implementation exports 1 while its focused test requires 2" }],
                unresolved_questions: [],
              } }
            : { name: "finish", arguments: { message: "Exploration submitted." } };
    const payload = JSON.stringify({
      id: `smoke-${modelCalls}`,
      object: "chat.completion",
      created: 1,
      model: "mock/explorer",
      choices: [{ index: 0, finish_reason: "tool_calls", message: {
        role: "assistant", content: null, tool_calls: [{ id: `call-${modelCalls}`,
          type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }],
      } }],
      usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
    });
    response.writeHead(200, { "content-type": "application/json",
      "content-length": Buffer.byteLength(payload) });
    response.end(payload);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "local-smoke-key";
  try {
    const settings = await config(undefined, {
      models: { SCOUT_MODEL: "mock/explorer", CHEAP_CODER_A: "mock/explorer",
        CHEAP_CODER_B: "mock/explorer", STRONG_CODER: "mock/explorer",
        FRONTIER_MODEL: "mock/explorer" },
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      budgetUsd: 1,
      maxTokens: 50_000,
      stageMaxTokens: 20_000,
      routing: { stateDirectory: join(base, "routing") },
    });
    const result = await run({
      repo,
      task: "Fix the exported value so its focused behavior check passes.",
      config: settings,
      output,
      quiet: true,
      repositoryExplorerFactory: (gateway) => new OpenHandsExplorer(gateway),
      codingWorkerFactory: (gateway) => new AiderExecutor(gateway.budget, gateway.logger, {
        ensureRuntime: async () => "mock-python",
        runner: async (cwd, invocation) => {
          await writeFile(join(cwd, "src/value.cjs"), "module.exports = 2;\n");
          await writeFile(invocation.reportPath, JSON.stringify({ format: "diff", version: "smoke" }));
          await writeFile(invocation.ledgerPath, JSON.stringify({
            costUsd: 0, tokens: 20, inputTokens: 10, outputTokens: 10, steps: 1,
          }));
          return { command: "mock aider", cwd: ".", exitCode: 0, stdout: "done",
            stderr: "", timedOut: false, wallClockMs: 1 };
        },
      }),
    });
    assert.equal(result.status, "VERIFIED_SUCCESS", result.error);
    assert.ok(modelCalls >= 4, "OpenHands must search and read before submitting scope");
    const events = (await readFile(join(output, "events.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(events.find((event) => event.type === "repo_scope_selected")?.editable_files,
      ["src/value.cjs"]);
    assert.deepEqual(events.find((event) => event.type === "aider_file_handoff")?.editable_files,
      ["src/value.cjs"]);
    assert.ok(events.some((event) => event.type === "final_verification" &&
      event.outcome === "CHECK_PASS"));
    assert.equal(await readFile(join(repo, "src/value.cjs"), "utf8"), "module.exports = 1;\n");
    assert.equal(await readFile(join(result.integration!.path, "src/value.cjs"), "utf8"),
      "module.exports = 2;\n");
  } finally {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(base, { recursive: true, force: true });
  }
});

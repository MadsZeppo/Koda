import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";
import { config } from "../src/config.js";
import { run } from "./helpers/run.js";
import { git } from "../src/repo/commands.js";
const pool = {
  provider: "openrouter",
  models: [
    {
      id: "cheap",
      tier: "cheap",
      qualityPrior: 0.94,
      latencyPriorMs: 1000,
      strengths: ["coding", "tool_use"],
    },
    {
      id: "strong",
      tier: "frontier",
      qualityPrior: 0.99,
      latencyPriorMs: 3000,
      strengths: [
        "coding",
        "tool_use",
        "reasoning",
        "repo_scale",
        "structured_output",
      ],
    },
  ],
};
for (const scenario of [
  "direct",
  "429",
  "forced",
  "budget",
  "final-failure",
  "planned",
  "planned-final-failure",
  "stall",
  "already-satisfied",
  "unknown-price",
  "protocol",
  "permanent-failure",
  "forced-stall",
] as const)
  test(`pool runtime: ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "koda-pool-e2e-"));
    const requests: any[] = [];
    let catalogCalls = 0;
    const parallel = scenario.startsWith("planned");
    const fixes: Record<string, string> = {
      "src/calculator.js": "export function add(a,b){return a+b}",
      "src/math.js": "export function multiply(a,b){return a*b}",
      "src/slug.js":
        "export function slug(t){return t.trim().toLowerCase().replace(/\\s+/g,'-')}",
      "src/display-name.js": "export function displayName(a,b){return a+' '+b}",
    };
    const server = createServer(async (req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/models")) {
        catalogCalls++;
        res.end(
          JSON.stringify({
            data: pool.models.map((m) => ({
              id: m.id,
              context_length: 100000,
              pricing:
                scenario === "unknown-price"
                  ? {}
                  : {
                      prompt: m.id === "cheap" ? "0.0000001" : "0.000001",
                      completion: m.id === "cheap" ? "0.0000002" : "0.000002",
                    },
              supported_parameters: ["tools", "structured_outputs"],
            })),
          }),
        );
        return;
      }
      let raw = "";
      for await (const c of req) raw += c;
      const body = JSON.parse(raw);
      requests.push(body);
      if (scenario === "permanent-failure") {
        res.writeHead(402);
        res.end(
          JSON.stringify({ error: { message: "billing failure" } }),
        );
        return;
      }
      if (scenario === "429" && body.model === "cheap") {
        res.writeHead(429);
        res.end(JSON.stringify({ error: { message: "rate limited" } }));
        return;
      }
      let message: any;
      const planner = body.messages[0].content.startsWith("Compile");
      if (planner)
        message = {
          role: "assistant",
          content: JSON.stringify({
            taskSummary: "Independent repairs",
            acceptanceCriteria: ["tests pass"],
            subtasks: ["math", "slug", "display-name"].map((id, i) => ({
              id,
              title: `Fix ${id}`,
              objective: `Fix ${id}`,
              dependsOn: [],
              likelyReadPaths: [`src/${id}.js`],
              likelyWritePaths: [`src/${id}.js`],
              verificationCommands: [`node --test test/${id}.test.js`],
              integrationContract: "Preserve exports",
              estimatedDifficulty: i === 1 ? "high" : "normal",
              parallelSafe: true,
            })),
          }),
        };
      else {
        const input = JSON.parse(body.messages[1].content);
        const target = parallel
          ? input.subtask?.likelyWritePaths?.[0] ?? input.allowed_write_paths?.[0]
          : "src/calculator.js";
        if (!target)
          throw new Error("Planned coder request omitted its owned write path");
        message =
          (scenario === "stall" && body.model === "cheap") ||
          scenario === "forced-stall"
            ? { role: "assistant", content: "done" }
            : {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "edit",
                    type: "function",
                    function: {
                      name: "write_file",
                      arguments: JSON.stringify({
                        path: target,
                        content: fixes[target],
                      }),
                    },
                  },
                ],
              };
        if (scenario === "protocol" && body.model === "cheap")
          message.tool_calls[0].function.arguments = "{invalid";
      }
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
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const repo = join(root, parallel ? "parallel" : "direct");
    try {
      await execa(process.execPath, [
        resolve("scripts/create-routing-fixtures.mjs"),
        root,
      ]);
      if (scenario === "already-satisfied") {
        await writeFile(
          join(repo, "src/calculator.js"),
          fixes["src/calculator.js"]!,
        );
        await git(repo, "add", ".");
        await git(repo, "commit", "-m", "already fixed");
      }
      const c = await config(undefined, {
        modelPool: pool,
        baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
        routing: { stateDirectory: join(root, "state") },
        forceModel: ["forced", "forced-stall"].includes(scenario)
          ? "strong"
          : undefined,
        budgetUsd: scenario === "budget" ? 0.000000001 : 0.1,
      });
      const result = await run({
        repo,
        task: parallel
          ? "Fix math, slug and display-name; preserve existing behavior."
          : "Fix the add function so all tests pass.",
        config: c,
        quiet: true,
        output: join(root, "report"),
        verify: ["final-failure", "planned-final-failure"].includes(scenario)
          ? [parallel
            ? "node -e \"import('./src/math.js').then(({multiply})=>process.exit(Number(multiply(3,4)===12)))\""
            : "node -e \"import('./src/calculator.js').then(({add})=>process.exit(Number(add(2,3)===5)))\""]
          : undefined,
      });
      if (
        [
          "budget",
          "final-failure",
          "planned-final-failure",
          "unknown-price",
          "permanent-failure",
          "forced-stall",
        ].includes(scenario)
      )
        assert.equal(result.status, ["permanent-failure", "forced-stall"].includes(scenario)
          ? "NOT_FULLY_VERIFIED" : "FAILED");
      else assert.equal(result.status, "VERIFIED_SUCCESS", result.error);
      if (["budget", "unknown-price"].includes(scenario))
        assert.equal(requests.length, 0);
      if (scenario === "already-satisfied") {
        assert.equal(requests.length, 0);
        assert.equal(catalogCalls, 0);
      }
      if (scenario === "final-failure") {
        const { History } = await import("../src/router/history.js");
        assert.ok(
          new History(join(root, "state"))
            .read()
            .every((r) => r.verification !== "VERIFIED_SUCCESS"),
        );
      }
      if (scenario === "direct") {
        assert.equal(result.plannerModelCalls, 0);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].model, "cheap");
        assert.equal(result.routingDecisions[0].selected_model, "cheap");
      }
      if (scenario === "permanent-failure") {
        assert.deepEqual(requests.map((request) => request.model), ["cheap", "strong"],
          "bounded operational failures consume their reservations but still allow routed fallback");
        assert.equal(result.costComplete, false);
        assert.equal(result.fallbacks, 1);
      }
      if (scenario === "forced-stall") {
        assert.ok(requests.every((r) => r.model === "strong"));
        assert.equal(result.fallbacks, 0);
        assert.ok(requests.length <= 3, "frontier no-progress is bounded");
      }
      if (scenario === "forced") {
        assert.equal(requests.length, 1);
        assert.equal(requests[0].model, "strong");
      }
      if (["429", "protocol", "stall"].includes(scenario)) {
        assert.equal(requests[0].model, "cheap");
        assert.equal(requests.at(-1).model, "strong");
        assert.ok(!result.modelAttempts.some((r: any) =>
          r.modelRequested === "cheap" && r.verification === "FAILED"),
        "no-mutation and provider failures are not coding-quality failures");
        if (scenario === "stall") {
          const events = (await readFile(join(root, "report", "events.jsonl"), "utf8"))
            .trim().split("\n").map((line) => JSON.parse(line));
          assert.match(events.find((event) => event.type === "escalation")?.reason ?? "",
            /without a candidate diff/);
        }
        assert.ok(
          scenario === "stall" ? result.escalations > 0 : result.fallbacks > 0,
        );
      }
      if (parallel) {
        for (const r of requests.filter(
          (r) => !r.messages[0].content.startsWith("Compile"),
        )) {
          const input = JSON.parse(r.messages[1].content);
          assert.match(input.task, new RegExp(input.subtask.objective.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
          const ownedPath = input.subtask.likelyWritePaths[0];
          assert.deepEqual(input.allowed_write_paths, [ownedPath]);
          for (const otherPath of [
            "src/math.js",
            "src/slug.js",
            "src/display-name.js",
          ].filter((path) => path !== ownedPath)) {
            const otherId = otherPath.slice(4, -3);
            assert.ok(
              !input.context.relevantFiles.includes(otherPath) &&
                !input.context.relevantFiles.includes(`test/${otherId}.test.js`),
            );
          }
        }
        for (const scope of result.workerScopes)
          assert.ok(
            scope.successful_write_paths.every((p: any) =>
              scope.allowed_write_paths.includes(p),
            ),
          );
      }
      if (parallel) {
        assert.equal(result.plannerModelCalls, 1);
        assert.ok(
          result.routingDecisions.some(
            (r: any) => r.subtaskId === "math" && r.selected_model === "cheap",
          ),
        );
        assert.ok(
          result.routingDecisions.some(
            (r: any) => r.subtaskId === "slug" && r.selected_model === "strong",
          ),
        );
        assert.ok(result.maxConcurrentCodingWorkers >= 1);
      }
      assert.equal(await git(repo, "status", "--porcelain"), "");
      if (scenario !== "already-satisfied")
        assert.match(
          await readFile(
            join(repo, parallel ? "src/math.js" : "src/calculator.js"),
            "utf8",
          ),
          parallel ? /a \+ b/ : /a - b/,
        );
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      try {
        for (const line of (
          await git(repo, "worktree", "list", "--porcelain")
        ).split("\n"))
          if (
            line.startsWith("worktree ") &&
            !line.endsWith("/direct") &&
            !line.endsWith("/parallel")
          )
            await git(repo, "worktree", "remove", "--force", line.slice(9));
      } catch {}
      await rm(root, { recursive: true, force: true });
    }
  });

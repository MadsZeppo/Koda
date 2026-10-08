import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import OpenAI from "openai";
import { startKodaBackend } from "../src/backend/proxy.js";
import {
  providerTransport,
  BACKEND_CLIENT_CREDENTIAL,
} from "../src/provider/transport.js";
import { config } from "../src/config.js";
import { Gateway, isTransientProviderError } from "../src/openrouter/client.js";
import { Budget } from "../src/openrouter/usage.js";
import { Logger } from "../src/telemetry/logger.js";
import { AgenticCodingWorker } from "../src/agent/agenticCodingWorker.js";
import { Catalog } from "../src/openrouter/catalog.js";

const SERVER_KEY = "server-only-sentinel-not-a-real-key";
const completion = {
  id: "mock-response",
  model: "mock/model",
  choices: [
    {
      index: 0,
      finish_reason: "stop",
      message: { role: "assistant", content: "Done" },
    },
  ],
  usage: { prompt_tokens: 20, completion_tokens: 10, cost: 0 },
};

async function upstream(
  t: any,
  handler: (req: IncomingMessage, res: ServerResponse, body: any) => void,
) {
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    res.setHeader("content-type", "application/json");
    handler(req, res, raw ? JSON.parse(raw) : undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as any).port}/v1`;
}
async function proxy(
  t: any,
  handler: Parameters<typeof upstream>[1],
  timeoutMs?: number,
) {
  const url = await upstream(t, handler);
  const backend = await startKodaBackend({
    key: SERVER_KEY,
    upstream: url,
    timeoutMs,
  });
  t.after(backend.close);
  return backend;
}
function environment(t: any, values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    const old = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    t.after(() => {
      if (old === undefined) delete process.env[key];
      else process.env[key] = old;
    });
  }
}
const send = (url: string, body: unknown) =>
  fetch(url + "/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer untrusted-client-value",
    },
    body: JSON.stringify(body),
  });

test("backend preserves the selected model, tools, parameters and preferences and adds server authorization", async (t) => {
  const body = {
    model: "any/model",
    messages: [{ role: "user", content: "Implement" }],
    tools: [
      {
        type: "function",
        function: { name: "read_file", parameters: { type: "object" } },
      },
    ],
    tool_choice: "required",
    parallel_tool_calls: false,
    max_tokens: 128,
    temperature: 0,
    provider: {
      order: ["any-endpoint"],
      require_parameters: true,
      max_price: { prompt: 1 },
    },
    reasoning: { effort: "high" },
    session_id: "session/task",
  };
  let calls = 0;
  const backend = await proxy(t, (req, res, actual) => {
    calls++;
    assert.equal(req.headers.authorization, `Bearer ${SERVER_KEY}`);
    assert.deepEqual(actual, body);
    res.end(JSON.stringify(completion));
  });
  assert.deepEqual(await (await send(backend.url, body)).json(), completion);
  assert.equal(calls, 1);
});

test("backend never returns its key in response bodies, errors or forwarded headers", async (t) => {
  const backend = await proxy(t, (_req, res) => {
    res.setHeader("authorization", `Bearer ${SERVER_KEY}`);
    res.setHeader("content-type", `application/json; echoed=${SERVER_KEY}`);
    res.setHeader("x-request-id", SERVER_KEY);
    res.writeHead(403);
    res.end(
      JSON.stringify({ error: { message: `Rejected Bearer ${SERVER_KEY}` } }),
    );
  });
  const response = await send(backend.url, {
    model: "mock/model",
    messages: [],
  });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("authorization"), null);
  assert.equal(
    [...response.headers.values()].join().includes(SERVER_KEY),
    false,
  );
  assert.equal((await response.text()).includes(SERVER_KEY), false);
});

for (const status of [400, 401, 404, 429, 500, 503])
  test(`backend preserves provider HTTP ${status}`, async (t) => {
    const backend = await proxy(t, (_req, res) => {
      res.setHeader("retry-after", "2");
      res.writeHead(status);
      res.end(
        '{"error":{"message":"Provider unavailable","code":' + status + "}}",
      );
    });
    const response = await send(backend.url, {
      model: "mock/model",
      messages: [],
    });
    assert.equal(response.status, status);
    assert.equal(response.headers.get("retry-after"), "2");
    assert.equal(((await response.json()) as any).error.code, status);
  });

test("backend timeout is an operational HTTP 504", async (t) => {
  const backend = await proxy(t, () => {}, 30);
  const response = await send(backend.url, {
    model: "mock/model",
    messages: [],
  });
  assert.equal(response.status, 504);
  assert.match(await response.text(), /provider_operational_error/);
});

for (const body of [
  "not JSON",
  '{"choices":[]}',
  '{"choices":[{"message":{}}]}',
])
  test(`malformed upstream response is operational: ${body}`, async (t) => {
    const backend = await proxy(t, (_req, res) => res.end(body));
    const response = await send(backend.url, {
      model: "mock/model",
      messages: [],
    });
    assert.equal(response.status, 502);
    assert.match(await response.text(), /provider_protocol_error/);
  });

test("metadata and semantic decisions use the same server credential", async (t) => {
  const paths: string[] = [];
  const backend = await proxy(t, (req, res, body) => {
    assert.equal(req.headers.authorization, `Bearer ${SERVER_KEY}`);
    paths.push(req.url!);
    if (req.url === "/api/alpha/decisions")
      assert.deepEqual(body, {
        model: "any/decision",
        state: { task: "test" },
        questions: [],
      });
    res.end('{"data":[]}');
  });
  for (const path of [
    "/v1/models",
    "/v1/models/any/model/endpoints",
    "/v1/classifications/task",
    "/v1/benchmarks",
  ])
    assert.equal((await fetch(backend.url + path)).status, 200);
  assert.equal(
    (
      await fetch(backend.url + "/api/alpha/decisions", {
        method: "POST",
        body: JSON.stringify({
          model: "any/decision",
          state: { task: "test" },
          questions: [],
        }),
      })
    ).status,
    200,
  );
  assert.deepEqual(paths, [
    "/v1/models",
    "/v1/models/any/model/endpoints",
    "/v1/classifications/task",
    "/v1/benchmarks",
    "/api/alpha/decisions",
  ]);
  assert.equal((await fetch(backend.url + "/v1/arbitrary")).status, 404);
});

test("backend redacts JSON-escaped credentials before the client decodes them", async (t) => {
  const escaped = [...SERVER_KEY]
    .map(
      (character) =>
        `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    )
    .join("");
  const backend = await proxy(t, (_req, res) => {
    res.writeHead(429);
    res.end(`{"error":{"message":"${escaped}"}}`);
  });
  const response = await send(backend.url, {
    model: "any/model",
    messages: [],
  });
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: { message: "[REDACTED]" } });
});

test("streaming responses remain SSE and redact keys split across upstream chunks", async (t) => {
  const backend = await proxy(t, (_req, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.write('data: {"content":"' + SERVER_KEY.slice(0, 13));
    setTimeout(
      () => res.end(SERVER_KEY.slice(13) + '"}\n\ndata: [DONE]\n\n'),
      10,
    );
  });
  const response = await send(backend.url, {
    model: "any/model",
    stream: true,
    messages: [],
  });
  assert.match(response.headers.get("content-type")!, /text\/event-stream/);
  const text = await response.text();
  assert.equal(text, 'data: {"content":"[REDACTED]"}\n\ndata: [DONE]\n\n');
});

test("streaming redacts JSON-escaped credentials in multiline events", async (t) => {
  const escaped = [...SERVER_KEY]
    .map(
      (character) =>
        `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    )
    .join("");
  const backend = await proxy(t, (_req, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.end(
      `event: message\ndata: {\ndata: "content":"${escaped}"}\n\ndata: [DONE]\n\n`,
    );
  });
  const response = await send(backend.url, {
    model: "any/model",
    stream: true,
    messages: [],
  });
  assert.equal(
    await response.text(),
    'event: message\ndata: {"content":"[REDACTED]"}\n\ndata: [DONE]\n\n',
  );
});

test("default transport ignores local OpenRouter credentials and direct dev mode requires explicit opt-in", async (t) => {
  environment(t, {
    KODA_PROVIDER_MODE: undefined,
    KODA_API_URL: "http://localhost:8787",
    OPENROUTER_API_KEY: "local-secret",
  });
  assert.deepEqual(providerTransport(), {
    mode: "backend",
    baseUrl: "http://localhost:8787/v1",
    apiKey: BACKEND_CLIENT_CREDENTIAL,
  });
  assert.equal(
    (await config(undefined, { models: {} })).baseUrl,
    "http://localhost:8787/v1",
  );
  process.env.KODA_PROVIDER_MODE = "direct-openrouter";
  assert.equal(providerTransport().apiKey, "local-secret");
  assert.equal(providerTransport().baseUrl, "https://openrouter.ai/api/v1");
  delete process.env.OPENROUTER_API_KEY;
  assert.throws(() => providerTransport(), /missing in direct-openrouter mode/);
});

test("explicit direct-openrouter dev mode calls the compatible endpoint with the local key", async (t) => {
  let calls = 0;
  const url = await upstream(t, (req, res) => {
    calls++;
    assert.equal(req.headers.authorization, "Bearer local-dev-test-key");
    res.end(JSON.stringify(completion));
  });
  environment(t, {
    KODA_PROVIDER_MODE: "direct-openrouter",
    OPENROUTER_API_KEY: "local-dev-test-key",
  });
  const transport = providerTransport(url);
  const sdk = new OpenAI({
    apiKey: transport.apiKey,
    baseURL: transport.baseUrl,
    maxRetries: 0,
  });
  assert.equal(
    (
      await sdk.chat.completions.create({
        model: "mock/model",
        messages: [{ role: "user", content: "Test" }],
      })
    ).model,
    "mock/model",
  );
  assert.equal(calls, 1);
});

for (const status of [429, 503, 502])
  test(`worker and gateway retain operational classification through proxy: ${status}`, async (t) => {
    const backend = await proxy(t, (_req, res) => {
      res.writeHead(status);
      res.end('{"error":{"message":"Provider failure"}}');
    });
    environment(t, {
      KODA_PROVIDER_MODE: "backend",
      KODA_API_URL: backend.url,
      OPENROUTER_API_KEY: undefined,
    });
    const root = await mkdtemp(join(tmpdir(), "koda-proxy-worker-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, "value.cjs"), "exports.value=1;\n");
    const logger = new Logger(join(root, ".koda/logs"), "test", true);
    const budget = new Budget(10, 100_000, 60_000);
    const cfg = await config(undefined, { models: {}, budgetUsd: 10 });
    const gateway = new Gateway(cfg, logger, budget);
    await assert.rejects(
      gateway.call(
        "mock/model",
        [{ role: "user", content: "Test" }],
        "test",
        "implement",
        0,
      ),
      (error: any) =>
        error.status === status && isTransientProviderError(error),
    );
    const result = await new AgenticCodingWorker(budget, logger).run({
      repoPath: root,
      attemptId: "test",
      task: "Modify value.cjs to export 2",
      model: "mock/model",
      budgetUsd: 1,
      maxTokens: 10_000,
      maxSteps: 3,
      timeoutMs: 10_000,
      requestTimeoutMs: 5000,
      commandTimeoutMs: 5000,
      maxOutputTokens: 512,
      baseUrl: cfg.baseUrl,
      writeScope: ["value.cjs"],
    });
    assert.equal(result.exitStatus, "infra_failure");
    assert.deepEqual(result.changedPaths, []);
    assert.equal(
      (JSON.stringify(logger.events) + JSON.stringify(result)).includes(
        SERVER_KEY,
      ),
      false,
    );
  });

test("normal linked CLI uses backend without a local key and produces verified real changes", async (t) => {
  let calls = 0;
  let workerCalls = 0;
  const backend = await proxy(t, (req, res, body) => {
    calls++;
    assert.equal(req.headers.authorization, `Bearer ${SERVER_KEY}`);
    const review = String(body.messages?.[0]?.content).includes(
      "Independently review task completion",
    );
    const direct = body.tools?.some(
      (tool: any) => tool.function?.name === "submit_direct_edit",
    );
    const reading = workerCalls++ === 0;
    const message = review
      ? {
          role: "assistant",
          content: JSON.stringify({
            passed: true,
            requirements: JSON.parse(
              body.messages.find((m: any) => m.role === "user").content,
            ).requirements.map((r: any) => ({
              id: r.id,
              satisfied: true,
              evidence:
                "README contains the requested replacement; focused verification passed",
            })),
            summary: "Requirement complete",
          }),
        }
      : {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "write-1",
              type: "function",
              function: {
                name: direct
                  ? "submit_direct_edit"
                  : reading
                    ? "read_file"
                    : "edit_file",
                arguments: JSON.stringify(
                  direct
                    ? {
                        path: "README.md",
                        edits: [
                          { oldText: "Old heading", newText: "New heading" },
                        ],
                      }
                    : reading
                      ? { path: "README.md" }
                      : {
                          path: "README.md",
                          oldText: "Old heading",
                          newText: "New heading",
                        },
                ),
              },
            },
          ],
        };
    res.end(
      JSON.stringify({
        ...completion,
        model: body.model,
        choices: [
          { index: 0, finish_reason: review ? "stop" : "tool_calls", message },
        ],
      }),
    );
  });
  const root = await mkdtemp(join(tmpdir(), "koda-proxy-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo"),
    output = join(root, "report"),
    cfg = join(root, "config.json");
  // A full-file packet cannot fit: exercise the existing bounded native worker
  // path instead of requiring an installed third-party Aider/Python runtime.
  const untouched = "Existing project documentation.\n".repeat(3000);
  await mkdir(repo);
  await writeFile(join(repo, "README.md"), "# Old heading\n" + untouched);
  await writeFile(
    cfg,
    JSON.stringify({
      models: Object.fromEntries(
        [
          "SCOUT_MODEL",
          "CHEAP_CODER_A",
          "CHEAP_CODER_B",
          "STRONG_MODEL",
          "FRONTIER_MODEL",
        ].map((role) => [role, "mock/model"]),
      ),
      budgetUsd: 10,
    }),
  );
  const child = await execa(
    process.execPath,
    [
      fileURLToPath(new URL("../bin/koda.mjs", import.meta.url)),
      "agent",
      "run",
      "--repo",
      ".",
      "--task",
      "Only modify README.md to replace Old heading with New heading.",
      "--config",
      cfg,
      "--output",
      output,
      "--apply",
    ],
    {
      cwd: repo,
      env: {
        KODA_PROVIDER_MODE: "backend",
        KODA_API_URL: backend.url,
        OPENROUTER_API_KEY: "",
      },
      reject: false,
      timeout: 60_000,
    },
  );
  const summary = JSON.parse(
    await readFile(join(output, "summary.json"), "utf8"),
  );
  assert.equal(child.exitCode, 0, child.stderr + JSON.stringify(summary));
  assert.equal(summary.status, "VERIFIED_SUCCESS");
  assert.equal(summary.applyResult, "applied");
  assert.equal(
    await readFile(join(repo, "README.md"), "utf8"),
    "# New heading\n" + untouched,
  );
  assert.ok(calls >= 2);
  const report = await readFile(join(output, "events.jsonl"), "utf8");
  assert.equal(
    (report + child.stdout + child.stderr).includes(SERVER_KEY),
    false,
  );
});

test("backend catalog retrieves endpoint capabilities without a client OpenRouter key", async (t) => {
  const backend = await proxy(t, (req, res) => {
    const data = req.url!.endsWith("/endpoints")
      ? {
          data: {
            endpoints: [{ supported_parameters: ["tools", "tool_choice"] }],
          },
        }
      : {
          data: [
            {
              id: "any/model",
              pricing: { prompt: "0.000001", completion: "0.000002" },
              context_length: 32000,
            },
          ],
        };
    res.end(JSON.stringify(data));
  });
  environment(t, {
    KODA_PROVIDER_MODE: "backend",
    KODA_API_URL: backend.url,
    OPENROUTER_API_KEY: undefined,
  });
  const dir = await mkdtemp(join(tmpdir(), "koda-proxy-catalog-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const model = {
    id: "any/model",
    enabled: true,
    strengths: ["tool_use"],
  } as any;
  const metadata = (
    await new Catalog(backend.url + "/v1", dir, 10000, [model]).get()
  ).get("any/model");
  assert.deepEqual(metadata?.routableParameterSets, [["tools", "tool_choice"]]);
});

test("backend reads its upstream key from the server environment and rejects missing keys", async (t) => {
  environment(t, { OPENROUTER_API_KEY: undefined });
  await assert.rejects(startKodaBackend(), /server-side OPENROUTER_API_KEY/);
  process.env.OPENROUTER_API_KEY = SERVER_KEY;
  const url = await upstream(t, (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${SERVER_KEY}`);
    res.end(JSON.stringify(completion));
  });
  const backend = await startKodaBackend({ upstream: url });
  t.after(backend.close);
  // The CLI process does not inherit or need the captured server credential.
  delete process.env.OPENROUTER_API_KEY;
  assert.equal(
    (await send(backend.url, { model: "mock/model", messages: [] })).status,
    200,
  );
});

test("Agentic reads and mutates real source through the backend without a local key", async (t) => {
  let calls = 0;
  const backend = await proxy(t, (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${SERVER_KEY}`);
    const name = calls++ === 0 ? "read_file" : "edit_file";
    const args =
      name === "read_file"
        ? { path: "value.cjs" }
        : { path: "value.cjs", oldText: "value=1", newText: "value=2" };
    res.end(
      JSON.stringify({
        ...completion,
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `call-${calls}`,
                  type: "function",
                  function: { name, arguments: JSON.stringify(args) },
                },
              ],
            },
          },
        ],
      }),
    );
  });
  environment(t, {
    KODA_PROVIDER_MODE: "backend",
    KODA_API_URL: backend.url,
    OPENROUTER_API_KEY: undefined,
  });
  const root = await mkdtemp(join(tmpdir(), "koda-proxy-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "value.cjs"), "exports.value=1;\n");
  const logger = new Logger(join(root, ".koda/logs"), "test", true);
  const result = await new AgenticCodingWorker(
    new Budget(10, 100_000, 60_000),
    logger,
  ).run({
    repoPath: root,
    attemptId: "test",
    task: "Modify value.cjs to export value=2",
    model: "mock/model",
    budgetUsd: 1,
    maxTokens: 20_000,
    maxSteps: 4,
    timeoutMs: 10_000,
    requestTimeoutMs: 5000,
    commandTimeoutMs: 5000,
    maxOutputTokens: 512,
    baseUrl: "https://obsolete-provider.invalid/v1",
    writeScope: ["value.cjs"],
    returnOnMutation: true,
  });
  assert.equal(result.exitStatus, "completed", result.fatalError);
  assert.deepEqual(result.changedPaths, ["value.cjs"]);
  assert.equal(calls, 2);
  assert.equal(
    await readFile(join(root, "value.cjs"), "utf8"),
    "exports.value=2;\n",
  );
});

test("backend entrypoint starts with a server environment key and never prints it", async (t) => {
  const upstreamUrl = await upstream(t, (req, res) => {
    assert.equal(req.url, "/v1/auth/key");
    assert.equal(req.headers.authorization, `Bearer ${SERVER_KEY}`);
    res.end(JSON.stringify({ data: {} }));
  });
  const child = execa(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      fileURLToPath(new URL("../src/backend/server.ts", import.meta.url)),
    ],
    {
      env: {
        OPENROUTER_API_KEY: SERVER_KEY,
        PORT: "0",
        KODA_BACKEND_HOST: "127.0.0.1",
        KODA_OPENROUTER_URL: upstreamUrl,
      },
      reject: false,
    },
  );
  t.after(() => {
    child.kill("SIGTERM");
  });
  let output = "",
    port = "";
  for await (const chunk of child.stdout!) {
    output += chunk;
    const match = output.match(/listening on port (\d+)/);
    if (match) {
      port = match[1]!;
      break;
    }
  }
  assert.ok(port, output);
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  assert.deepEqual(await response.json(), { ok: true });
  child.kill("SIGTERM");
  const result = await child;
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal((output + result.stderr).includes(SERVER_KEY), false);
});

test("backend transport overrides every legacy provider endpoint and credential", (t) => {
  environment(t, {
    KODA_PROVIDER_MODE: "backend",
    KODA_API_URL: "http://localhost:8787",
    OPENROUTER_API_KEY: undefined,
    KODA_MODEL_API_KEY: "must-not-be-used",
  });
  for (const provider of ["openrouter", "openai", "anthropic"]) {
    for (const url of [
      "https://openrouter.ai/api/v1",
      "https://legacy.invalid/v1",
      "http://127.0.0.1:1/v1",
    ]) {
      assert.deepEqual(providerTransport(url, provider), {
        mode: "backend",
        baseUrl: "http://localhost:8787/v1",
        apiKey: BACKEND_CLIENT_CREDENTIAL,
      });
    }
  }
});

test("real OpenHands exploration uses only the backend with no local OpenRouter key", async (t) => {
  const { OpenHandsExplorer } =
    await import("../src/agent/openHandsExplorer.js");
  const { ensureOpenHandsRuntime } =
    await import("../src/agent/openHandsRuntime.js");
  const { profileRepo } = await import("../src/repo/profiler.js");
  const python = await ensureOpenHandsRuntime();
  let calls = 0;
  const backend = await proxy(t, (req, res, body) => {
    assert.equal(req.headers.authorization, `Bearer ${SERVER_KEY}`);
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(body.model, "openai/mock-explorer");
    const index = calls++;
    const names = [
      "koda_search_repository",
      "koda_read_repository_file",
      "koda_submit_repository_exploration",
      "finish",
    ];
    const args = [
      { query: "tokenLimit", glob: "**/*.cjs", limit: 20 },
      { path: "src/quota.cjs", start_line: 1, end_line: 80 },
      {
        confidence: "high",
        editable_candidates: [
          { path: "src/quota.cjs", reason: "Defines tokenLimit" },
        ],
        readonly_files: [],
        related_tests: [],
        dependencies: [],
        evidence: [
          { path: "src/quota.cjs", detail: "Read tokenLimit implementation" },
        ],
        unresolved_questions: [],
      },
      { message: "Exploration submitted" },
    ];
    const name = names[index];
    assert.ok(
      name && body.tools.some((tool: any) => tool.function.name === name),
    );
    res.end(
      JSON.stringify({
        ...completion,
        model: body.model,
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `call-${calls}`,
                  type: "function",
                  function: { name, arguments: JSON.stringify(args[index]) },
                },
              ],
            },
          },
        ],
      }),
    );
  });
  backend.server.on("request", (req) => {
    assert.equal(
      req.headers.authorization,
      `Bearer ${BACKEND_CLIENT_CREDENTIAL}`,
    );
  });
  const root = await mkdtemp(join(tmpdir(), "koda-exploration-backend-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/quota.cjs"), "exports.tokenLimit=8192;\n");
  await blockPythonExternalConnections(root, true);
  environment(t, {
    KODA_PROVIDER_MODE: "backend",
    KODA_API_URL: backend.url,
    OPENROUTER_API_KEY: undefined,
    PYTHONPATH: root,
  });
  const cfg = await config(undefined, {
    models: { SCOUT_MODEL: "openai/mock-explorer" },
    baseUrl: "https://obsolete-provider.invalid/v1",
    budgetUsd: 10,
    maxTokens: 100_000,
  });
  const logger = new Logger(join(root, ".koda/logs"), "exploration", true);
  const gateway = new Gateway(cfg, logger, new Budget(10, 100_000, 60_000));
  const result = await new OpenHandsExplorer(gateway, {
    ensureRuntime: async () => python,
  }).explore({
    repoPath: root,
    task: "Locate the token quota implementation before changing it",
    profile: await profileRepo(root),
  });
  assert.equal(result.confidence, "high");
  assert.deepEqual(
    result.editableCandidates.map((file) => file.path),
    ["src/quota.cjs"],
  );
  assert.equal(calls, 4);
  assert.equal(
    await readFile(join(root, "src/quota.cjs"), "utf8"),
    "exports.tokenLimit=8192;\n",
  );
});

async function blockPythonExternalConnections(
  root: string,
  rejectOpenRouterReads = false,
) {
  // Loaded before SDK imports: a provider-prefix bypass fails locally, never calls a paid endpoint.
  await writeFile(
    join(root, "sitecustomize.py"),
    `import socket
_original_connect = socket.socket.connect
def _connect(sock, address):
    if isinstance(address, tuple) and address[0] not in ('127.0.0.1', 'localhost', '::1'):
        raise RuntimeError('External provider connection forbidden in regression test')
    return _original_connect(sock, address)
socket.socket.connect = _connect
${
  rejectOpenRouterReads
    ? `import os
_original_getitem = os._Environ.__getitem__
def _getitem(env, key):
    if key == "OPENROUTER_API_KEY":
        raise RuntimeError("Backend subprocess read OpenRouter credential")
    return _original_getitem(env, key)
os._Environ.__getitem__ = _getitem
`
    : ""
}`,
  );
}

test("real Aider CallGuard/LiteLLM dispatches through backend and keeps the selected model", async (t) => {
  const { ensureOpenHandsRuntime } =
    await import("../src/agent/openHandsRuntime.js");
  const python = await ensureOpenHandsRuntime();
  let calls = 0;
  const backend = await proxy(t, (req, res, body) => {
    calls++;
    assert.equal(req.headers.authorization, `Bearer ${SERVER_KEY}`);
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(body.model, "vendor/selected-model");
    assert.equal(body.max_tokens, 128);
    res.end(JSON.stringify({ ...completion, model: body.model }));
  });
  environment(t, {
    KODA_PROVIDER_MODE: "backend",
    KODA_API_URL: backend.url,
    OPENROUTER_API_KEY: undefined,
  });
  const root = await mkdtemp(join(tmpdir(), "koda-aider-backend-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await blockPythonExternalConnections(root);
  const bridge = fileURLToPath(new URL("../workers/aider", import.meta.url));
  const child = await execa(
    python,
    [
      "-c",
      `import os,time,litellm
from bridge import CallGuard
assert 'OPENROUTER_API_KEY' not in os.environ
request=dict(model='openrouter/vendor/selected-model',providerMode='backend',baseUrl=os.environ['KODA_TEST_BACKEND_URL'],maxSteps=2,deadline=time.time()*1000+10000,maxTokens=10000,maxOutputTokens=128,budgetUsd=1,requestTimeoutMs=5000,promptPricePerMillion=0,completionPricePerMillion=0)
ledger=dict(steps=0,tokens=0,costUsd=0,inputTokens=0,outputTokens=0)
guard=CallGuard(request,ledger,lambda:None,litellm.completion,lambda **kwargs:20)
response=guard(model=request['model'],custom_llm_provider='openrouter',messages=[dict(role='user',content='Test selected model')])
assert response.choices[0].message.content == 'Done'
assert ledger['steps'] == 1
`,
    ],
    {
      timeout: 20_000,
      env: {
        OPENROUTER_API_KEY: undefined,
        KODA_PROVIDER_API_KEY: BACKEND_CLIENT_CREDENTIAL,
        KODA_TEST_BACKEND_URL: providerTransport("https://legacy.invalid/v1")
          .baseUrl,
        LITELLM_LOCAL_MODEL_COST_MAP: "True",
        PYTHONPATH: `${root}:${bridge}`,
        PYTHONDONTWRITEBYTECODE: "1",
      },
    },
  );
  assert.equal(child.exitCode, 0, child.stderr);
  assert.equal(calls, 1);
});

test("completion review and completion repair keep backend transport after real mutations", async (t) => {
  const { startFakeProvider } = await import("../src/dev/fakeProvider.js");
  const { fakeSmokeFixtures } = await import("../src/dev/fakeSmokeFixtures.js");
  const { run } = await import("../src/run.js");
  const { deterministicRepositoryExploration } =
    await import("../src/agent/openHandsExplorer.js");
  environment(t, {
    NODE_ENV: "test",
    KODA_PROVIDER_MODE: "backend",
    OPENROUTER_API_KEY: undefined,
  });
  const fixture = fakeSmokeFixtures.repair!;
  const scripted = await startFakeProvider(fixture.script);
  t.after(scripted.close);
  let calls = 0;
  const backend = await proxy(t, async (req, res, body) => {
    calls++;
    assert.equal(req.headers.authorization, `Bearer ${SERVER_KEY}`);
    const response = await fetch(scripted.baseUrl + "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    res.writeHead(response.status);
    const data = await response.json() as any;
    if (body.tools?.some((tool: any) => tool.function?.name === "submit_completion_review")) {
      assert.equal(body.tool_choice, "required");
      assert.equal(body.tools[0].function.strict, true);
      assert.deepEqual(body.tools[0].function.parameters.required, ["passed", "requirements", "summary"]);
      data.choices[0].finish_reason = "tool_calls";
      data.choices[0].message = { role: "assistant", content: null, tool_calls: [{
        id: "review", type: "function", function: {
          name: "submit_completion_review", arguments: data.choices[0].message.content,
        },
      }] };
    }
    res.end(JSON.stringify(data));
  });
  environment(t, { KODA_API_URL: backend.url });
  const root = await mkdtemp(join(tmpdir(), "koda-repair-backend-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  await mkdir(repo);
  for (const [path, content] of Object.entries(fixture.files)) {
    const { dirname } = await import("node:path");
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  }
  const cfg = await config(undefined, {
    baseUrl: "https://obsolete-provider.invalid/v1",
    models: Object.fromEntries(
      [
        "SCOUT_MODEL",
        "CHEAP_CODER_A",
        "CHEAP_CODER_B",
        "STRONG_MODEL",
        "FRONTIER_MODEL",
      ].map((role) => [role, "koda-test/scripted"]),
    ),
    budgetUsd: 10,
    maxTokens: 300_000,
    maxIterations: 3,
  });
  const result = await run({
    repo,
    task: fixture.task,
    config: cfg,
    output: join(root, "report"),
    quiet: true,
    syntheticTelemetry: true,
    codingWorkerFactory: (gateway) =>
      new AgenticCodingWorker(gateway.budget, gateway.logger),
    repositoryExplorerFactory: () => ({
      explore: ({ repoPath, task, profile }) =>
        deterministicRepositoryExploration(repoPath, task, profile),
    }),
  });
  assert.equal(result.status, "VERIFIED_SUCCESS");
  assert.equal(
    await readFile(join(result.integration!.path, "src/value.cjs"), "utf8"),
    "exports.value=3;\n",
  );
  assert.equal(
    scripted.requests.filter((request) => request.stage === "review").length,
    2,
  );
  assert.equal(calls, scripted.requests.length);
  const events = await readFile(join(root, "report/events.jsonl"), "utf8");
  assert.match(events, /completion_continuation/);
  assert.equal(events.includes(SERVER_KEY), false);
});

test("actual Aider subprocess edits through backend without OpenRouter onboarding or local auth", async (t) => {
  const { AiderExecutor } = await import("../src/agent/aiderExecutor.js");
  const { ensureAiderRuntime } = await import("../src/agent/aiderRuntime.js");
  environment(t, {
    KODA_PROVIDER_MODE: "backend",
    OPENROUTER_API_KEY: undefined,
  });
  const python = await ensureAiderRuntime();
  let calls = 0;
  const backend = await proxy(t, (req, res, body) => {
    calls++;
    assert.equal(req.headers.authorization, `Bearer ${SERVER_KEY}`);
    assert.equal(body.model, "openai/selected-model");
    assert.equal(req.url, "/v1/chat/completions");
    const content =
      "src/value.cjs\n```javascript\n<<<<<<< SEARCH\nmodule.exports = 1;\n=======\nmodule.exports = 3;\n>>>>>>> REPLACE\n```";
    res.end(
      JSON.stringify({
        ...completion,
        model: body.model,
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content },
          },
        ],
      }),
    );
  });
  environment(t, { KODA_API_URL: backend.url });
  const root = await mkdtemp(join(tmpdir(), "koda-real-aider-backend-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/value.cjs"), "module.exports = 1;\n");
  await execa("git", ["init", "-q"], { cwd: root });
  await execa("git", ["add", "."], { cwd: root });
  await execa(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@localhost",
      "commit",
      "-qm",
      "baseline",
    ],
    { cwd: root },
  );
  await blockPythonExternalConnections(root, true);
  // This also catches implicit metadata requests during actual Aider startup.
  environment(t, { PYTHONPATH: root });
  const logger = new Logger(join(root, ".koda/logs"), "aider-backend", true);
  const result = await new AiderExecutor(
    new Budget(10, 100_000, 60_000),
    logger,
    {
      ensureRuntime: async () => python,
      runner: async (cwd, invocation, timeout) => {
        const started = Date.now();
        const child = await execa(invocation.binary, invocation.args, {
          cwd,
          env: {
            ...invocation.env,
            PYTHONPATH: root,
            OPENAI_API_KEY: undefined,
            OPENAI_API_BASE: undefined,
            KODA_PROVIDER_MODE: undefined,
            LITELLM_LOCAL_MODEL_COST_MAP: undefined,
          },
          timeout,
          reject: false,
        });
        return {
          command: "actual Aider bridge",
          cwd: ".",
          exitCode: child.exitCode ?? 1,
          stdout: child.stdout,
          stderr: child.stderr,
          timedOut: child.timedOut,
          wallClockMs: Date.now() - started,
        };
      },
    },
  ).run({
    repoPath: root,
    attemptId: "aider-backend",
    task: "Change src/value.cjs to export 3 instead of 1.",
    model: "openai/selected-model",
    budgetUsd: 1,
    maxTokens: 20_000,
    contextWindowTokens: 32_000,
    maxSteps: 2,
    timeoutMs: 30_000,
    requestTimeoutMs: 10_000,
    commandTimeoutMs: 5000,
    maxOutputTokens: 512,
    promptPricePerMillion: 0,
    completionPricePerMillion: 0,
    baseUrl: "https://openrouter.ai/api/v1",
    writeScope: ["src/value.cjs"],
    aiderEditFormat: "diff",
    context: {
      relevantFiles: ["src/value.cjs"],
      completePaths: ["src/value.cjs"],
    },
  });
  assert.equal(result.exitStatus, "completed", JSON.stringify(result));
  assert.equal(
    await readFile(join(root, "src/value.cjs"), "utf8"),
    "module.exports = 3;\n",
  );
  assert.ok(calls >= 1);
  assert.doesNotMatch(
    (result.stdout ?? "") + (result.stderr ?? ""),
    /requires an OpenRouter API key|localhost:8484|auth\/keys|OAuth flow|Backend mode prohibits/,
  );
});

test("actual shared provider client sends a placeholder to backend and server authorization upstream", async (t) => {
  let upstreamCalls = 0,
    clientCalls = 0;
  const backend = await proxy(t, (req, res, body) => {
    upstreamCalls++;
    assert.equal(req.headers.authorization, `Bearer ${SERVER_KEY}`);
    assert.equal(body.model, "mock/planner");
    res.end(JSON.stringify({ ...completion, model: body.model }));
  });
  backend.server.on("request", (req) => {
    clientCalls++;
    assert.equal(
      req.headers.authorization,
      `Bearer ${BACKEND_CLIENT_CREDENTIAL}`,
    );
  });
  environment(t, {
    KODA_PROVIDER_MODE: "backend",
    KODA_API_URL: backend.url,
    OPENROUTER_API_KEY: undefined,
  });
  const root = await mkdtemp(join(tmpdir(), "koda-hop-client-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cfg = await config(undefined, {
    models: { SCOUT_MODEL: "mock/planner" },
    baseUrl: "https://openrouter.ai/api/v1",
  });
  const gateway = new Gateway(
    cfg,
    new Logger(root, "hop", true),
    new Budget(10, 100_000, 60_000),
  );
  const result = await gateway.call(
    "mock/planner",
    [{ role: "user", content: "Respond deterministically" }],
    "planner",
    "plan",
    0,
  );
  assert.equal(result.content, "Done");
  assert.equal(clientCalls, 1);
  assert.equal(upstreamCalls, 1);
  assert.equal(process.env.OPENROUTER_API_KEY, undefined);
});

test("actual Planner compiles through backend with distinct client and server credentials", async (t) => {
  const { compileTask } = await import("../src/planner/taskCompiler.js");
  const { profileRepo } = await import("../src/repo/profiler.js");
  let calls = 0,
    clientCalls = 0;
  const plan = {
    taskSummary: "Refactor quota API",
    acceptanceCriteria: ["Preserve quota export"],
    subtasks: [
      {
        id: "quota",
        title: "Quota implementation",
        objective: "Refactor quota API and preserve quota export",
        dependsOn: [],
        likelyReadPaths: ["src/quota.cjs"],
        likelyWritePaths: ["src/quota.cjs"],
        integrationContract: "Preserve quota export",
        verificationCommands: [],
        estimatedDifficulty: "normal",
        parallelSafe: false,
      },
    ],
  };
  const backend = await proxy(t, (req, res, body) => {
    calls++;
    assert.equal(req.headers.authorization, `Bearer ${SERVER_KEY}`);
    assert.equal(body.model, "mock/planner");
    assert.ok(
      body.tools.some((tool: any) => tool.function.name === "submit_plan"),
    );
    res.end(
      JSON.stringify({
        ...completion,
        model: body.model,
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "plan",
                  type: "function",
                  function: {
                    name: "submit_plan",
                    arguments: JSON.stringify(plan),
                  },
                },
              ],
            },
          },
        ],
      }),
    );
  });
  backend.server.on("request", (req) => {
    clientCalls++;
    assert.equal(
      req.headers.authorization,
      `Bearer ${BACKEND_CLIENT_CREDENTIAL}`,
    );
  });
  environment(t, {
    KODA_PROVIDER_MODE: "backend",
    KODA_API_URL: backend.url,
    OPENROUTER_API_KEY: undefined,
  });
  const root = await mkdtemp(join(tmpdir(), "koda-hop-planner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/quota.cjs"), "exports.quota=1;\n");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ scripts: { typecheck: "node --check src/quota.cjs" } }),
  );
  const cfg = await config(undefined, {
    models: { SCOUT_MODEL: "mock/planner", STRONG_MODEL: "mock/planner" },
  });
  const logger = new Logger(join(root, ".koda/logs"), "plan", true);
  const gateway = new Gateway(cfg, logger, new Budget(10, 100_000, 60_000));
  const result = await compileTask(
    gateway,
    "Refactor quota behavior across the public API and preserve its exported interface.",
    await profileRepo(root),
  );
  assert.equal(result.subtasks[0]?.id, "quota");
  assert.equal(calls, 1);
  assert.equal(clientCalls, 1);
  assert.equal(
    logger.events.find((event) => event.type === "planner_policy")
      ?.planner_strategy,
    "model",
  );
});

test("upstream 401 is marked and stays operational; backend does not generate it", async (t) => {
  const { providerErrorOrigin } = await import("../src/provider/transport.js");
  const backend = await proxy(t, (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${SERVER_KEY}`);
    res.writeHead(401);
    res.end(
      JSON.stringify({
        error: { message: "Missing Authentication header", code: 401 },
      }),
    );
  });
  environment(t, {
    KODA_PROVIDER_MODE: "backend",
    KODA_API_URL: backend.url,
    OPENROUTER_API_KEY: undefined,
  });
  const root = await mkdtemp(join(tmpdir(), "koda-hop-401-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logger = new Logger(root, "401", true);
  const gateway = new Gateway(
    await config(undefined, { models: { SCOUT_MODEL: "mock/planner" } }),
    logger,
    new Budget(10, 100_000, 60_000),
  );
  await assert.rejects(
    gateway.call(
      "mock/planner",
      [{ role: "user", content: "Test" }],
      "planner",
      "plan",
      0,
    ),
    (error) => {
      assert.equal(providerErrorOrigin(error), "upstream");
      assert.equal((error as any).status, 401);
      return true;
    },
  );
  assert.equal(
    logger.events.find((event) => event.type === "model_error")?.errorOrigin,
    "upstream",
  );
  assert.equal(
    logger.events.find((event) => event.type === "model_error")?.classification,
    "OPERATIONAL_FAILURE",
  );
  const missing = await fetch(backend.url + "/unknown");
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("x-koda-error-origin"), "backend");
});

for (const status of [200, 401])
  test(`backend startup validates server credential without a model call: HTTP ${status}`, async (t) => {
    let calls = 0;
    const url = await upstream(t, (req, res) => {
      calls++;
      assert.equal(req.url, "/v1/auth/key");
      assert.equal(req.method, "GET");
      assert.equal(req.headers.authorization, `Bearer ${SERVER_KEY}`);
      res.writeHead(status);
      res.end(JSON.stringify({ data: {} }));
    });
    if (status === 401)
      await assert.rejects(
        startKodaBackend({
          key: SERVER_KEY,
          upstream: url,
          validateAuth: true,
        }),
        /BACKEND_AUTH_FAILURE: upstream returned HTTP 401/,
      );
    else {
      const backend = await startKodaBackend({
        key: ` ${SERVER_KEY} `,
        upstream: url,
        validateAuth: true,
      });
      t.after(backend.close);
      assert.deepEqual(await (await fetch(backend.url + "/health")).json(), {
        ok: true,
      });
    }
    assert.equal(calls, 1);
  });

for (const toolCalls of [false, true]) {
  test(`backend preserves output-limit response and usage (${toolCalls ? "partial tool arguments" : "reasoning-only"})`, async (t) => {
    const truncated = {
      ...completion,
      choices: [{ index: 0, finish_reason: "length", message: {
        role: "assistant", content: null, reasoning: "Still thinking",
        ...(toolCalls ? { tool_calls: [{ id: "edit", type: "function",
          function: { name: "write_file", arguments: '{"path":' } }] } : {}),
      } }],
      usage: { prompt_tokens: 120, completion_tokens: 64, cost: 0.01 },
    };
    const backend = await proxy(t, (_req, res) => res.end(JSON.stringify(truncated)));
    const response = await send(backend.url, { model: "mock/model", messages: [] });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), truncated);
  });
}

test("backend diagnoses malformed tool arguments without leaking response content", async (t) => {
  const backend = await proxy(t, (_req, res) => res.end(JSON.stringify({ ...completion,
    choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
      tool_calls: [{ id: "edit", type: "function", function: { name: "write_file", arguments: "private-invalid-content" } }],
    } }],
  })));
  const response = await send(backend.url, { model: "mock/model", messages: [] });
  assert.equal(response.status, 502);
  const body = await response.text();
  assert.match(body, /invalid_tool_arguments/);
  assert.doesNotMatch(body, /private-invalid-content/);
});

test("structured reviewer omits unsupported reasoning assumptions and settles authoritative tool usage through backend", async (t) => {
  const {completionReviewTool,completionReviewPayload,parseCompletionReview}=await import('../src/agent/completionReview.js');
  const requirements=[{id:'R1',text:'Required change exists'}];
  const assessment={passed:true,requirements:[{id:'R1',satisfied:true,evidence:'Concrete changed path and focused assertion'}],summary:'complete'};
  let requests=0;
  const backend=await proxy(t,(req,res,body)=>{
    requests++;
    assert.equal(req.headers.authorization,`Bearer ${SERVER_KEY}`);
    assert.equal(body.tool_choice,'required');
    assert.equal(body.tools[0].function.strict,true);
    assert.equal(body.reasoning,undefined);
    res.end(JSON.stringify({...completion,choices:[{index:0,finish_reason:'tool_calls',message:{role:'assistant',content:null,
      tool_calls:[{id:'review',type:'function',function:{name:'submit_completion_review',arguments:JSON.stringify(assessment)}}]}}]}));
  });
  environment(t,{KODA_PROVIDER_MODE:'backend',KODA_API_URL:backend.url,OPENROUTER_API_KEY:undefined});
  const root=await mkdtemp(join(tmpdir(),'koda-review-schema-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const cfg=await config(undefined,{models:{},maxInputPrice:1,maxOutputPrice:1});
  const budget=new Budget(1,100000,60000);
  const gateway=new Gateway(cfg,new Logger(root,'schema-review',true),budget);
  (gateway as any).modelRouter={history:{recordOperation(){}},catalog:{get:async()=>new Map([['mock/reviewer',{
    inputPrice:1,outputPrice:1,available:true,contextLength:32000,supportedParameters:['tools','tool_choice','reasoning'],
  }]])}};
  const message=await gateway.call('mock/reviewer',[{role:'user',content:'Assess the actual change'}],'task','completion-review',0,
    [completionReviewTool(requirements)],{requireTool:true,maxOutputTokens:1000});
  assert.equal(parseCompletionReview(completionReviewPayload(message),requirements).passed,true);
  assert.equal(requests,1);
  assert.equal(budget.tokens,30);
  assert.equal(budget.reservedTokens,0);
});

for (const advertised of [false, true]) test(`reasoning-mandatory endpoint preserves protocol and skips known rejected overrides (${advertised})`, async (t) => {
  const {completionReviewTool,completionReviewPayload,parseCompletionReview}=await import('../src/agent/completionReview.js');
  const requirements=[{id:'R1',text:'Required change exists'}];
  const assessment={passed:true,requirements:[{id:'R1',satisfied:true,evidence:'Focused verification and the changed path prove the requirement'}],summary:'complete'};
  const received:any[]=[];
  const backend=await proxy(t,(_req,res,body)=>{
    received.push(body);
    if(body.reasoning?.enabled===false){
      res.writeHead(400,{"content-type":"application/json"});
      res.end(JSON.stringify({error:{message:'Reasoning is mandatory for this endpoint and cannot be disabled.',code:400}}));
      return;
    }
    res.end(JSON.stringify({...completion,usage:{prompt_tokens:20,completion_tokens:10,cost:0},choices:[{index:0,finish_reason:'tool_calls',message:{role:'assistant',content:null,
      tool_calls:[{id:'review',type:'function',function:{name:'submit_completion_review',arguments:JSON.stringify(assessment)}}]}}]}));
  });
  environment(t,{KODA_PROVIDER_MODE:'backend',KODA_API_URL:backend.url,OPENROUTER_API_KEY:undefined});
  const root=await mkdtemp(join(tmpdir(),'koda-review-reasoning-required-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const cfg=await config(undefined,{models:{},maxInputPrice:1,maxOutputPrice:1});
  const budget=new Budget(1,100000,60000);
  const gateway=new Gateway(cfg,new Logger(root,'reasoning-required-review',true),budget);
  (gateway as any).modelRouter={history:{recordOperation(){}},catalog:{get:async()=>new Map([['mock/reviewer',{
    inputPrice:1,outputPrice:1,available:true,contextLength:32000,supportedParameters:['tools','tool_choice','reasoning'], reasoning: advertised ? {mandatory:true,supported_efforts:['low','medium']} : undefined,
  }]])}};
  const message=await gateway.call('mock/reviewer',[{role:'user',content:'Assess the actual change'}],'task','completion-review',0,
    [completionReviewTool(requirements)],{requireTool:true,disableReasoning:true,maxOutputTokens:1000});
  assert.equal(parseCompletionReview(completionReviewPayload(message),requirements).passed,true);
  assert.equal(received.length,advertised ? 1 : 2);
  if (!advertised) assert.deepEqual(received[0].reasoning,{enabled:false});
  assert.deepEqual(received.at(-1).reasoning,{effort:'low'});
  assert.equal(received.at(-1).model,received[0].model);
  assert.equal(received.at(-1).tool_choice,'required');
  assert.equal(budget.tokens,30);
  assert.equal(budget.reservedTokens,0);
  const count=received.length;
  await gateway.call('mock/reviewer',[{role:'user',content:'Review the next batch'}],'task','completion-review',0,
    [completionReviewTool(requirements)],{requireTool:true,disableReasoning:true,maxOutputTokens:1000});
  assert.equal(received.length,count+1);
  assert.deepEqual(received.at(-1).reasoning,{effort:'low'});
  assert.equal(budget.tokens,60);
  assert.equal(budget.reservedTokens,0);
});

for (const supported of [true, false]) {
  test(`completion review JSON retry uses provider schema only with advertised support (${supported})`, async t => {
    const { completionReviewResponseFormat, completionReviewPayload, parseCompletionReview } = await import('../src/agent/completionReview.js');
    const requirements = [{ id: 'R1', text: 'Required source exists' }, { id: 'R2', text: 'Required tests exist' }];
    const assessment = { passed: true, requirements: requirements.map(r => ({ id: r.id, satisfied: true, evidence: 'Source and passing regression test establish behavior' })), summary: 'complete' };
    const received: any[] = [];
    const backend = await proxy(t, (_req, res, body) => {
      received.push(body);
      res.end(JSON.stringify({ ...completion, usage: { prompt_tokens: 30, completion_tokens: 20, cost: 0 },
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(assessment) } }] }));
    });
    environment(t, { KODA_PROVIDER_MODE: 'backend', KODA_API_URL: backend.url, OPENROUTER_API_KEY: undefined });
    const root = await mkdtemp(join(tmpdir(), 'koda-schema-review-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const cfg = await config(undefined, { models: {}, maxInputPrice: 1, maxOutputPrice: 1 });
    const logger = new Logger(root, 'schema-review', true);
    const gateway = new Gateway(cfg, logger, new Budget(1, 100000, 60000));
    (gateway as any).modelRouter = { history: { recordOperation() {} }, catalog: { get: async () => new Map([['mock/reviewer', {
      inputPrice: 1, outputPrice: 1, available: true, contextLength: 32000,
      supportedParameters: supported ? ['response_format', 'structured_outputs'] : [],
    }]]) } };
    const format = completionReviewResponseFormat(requirements);
    const message = await gateway.call('mock/reviewer', [{ role: 'user', content: 'Assess required behavior' }], 'task', 'completion-review', 0, undefined,
      { maxOutputTokens: 1000, responseFormat: format });
    assert.equal(parseCompletionReview(completionReviewPayload(message), requirements).passed, true);
    assert.deepEqual(received[0].response_format, supported ? format : undefined);
    assert.equal((format.json_schema.schema.properties as any).requirements.minItems, 2);
    assert.equal((format.json_schema.schema.properties as any).requirements.maxItems, 2);
    assert.equal(received[0].provider.require_parameters, true);
    assert.ok(logger.events.some(e => e.type === 'provider_payload_bound'));
  });
}

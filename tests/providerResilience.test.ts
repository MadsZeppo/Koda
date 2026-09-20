import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { config } from "../src/config.js";
import { Gateway, canFallback } from "../src/openrouter/client.js";
import { Budget } from "../src/openrouter/usage.js";
import { Logger } from "../src/telemetry/logger.js";

const response = (model: string, cost: number) => ({
  id: `response-${model}`, model,
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "done" } }],
  usage: { prompt_tokens: 4, completion_tokens: 2, cost },
});

test("omitted model timeout uses the central stage deadline, aborts, and permits operational fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "koda-provider-timeout-"));
  let slowClosed = false;
  const server = createServer(async (request, reply) => {
    reply.setHeader("content-type", "application/json");
    if (request.method === "GET") {
      reply.end(JSON.stringify({ data: ["slow", "fast"].map((id) => ({
        id, context_length: 100000, supported_parameters: ["tools"],
        pricing: { prompt: "0.0000001", completion: "0.0000002" },
      })) }));
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    if (body.model === "slow") {
      request.once("close", () => { slowClosed = true; });
      reply.once("close", () => { slowClosed = true; });
      return;
    }
    reply.end(JSON.stringify(response(body.model, 0.00001)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const cfg = await config(undefined, {
      baseUrl: `http://127.0.0.1:${address.port}`,
      modelPool: { provider: "local-compatible", models: ["slow", "fast"].map((id) => ({
        id, enabled: true, tier: "fast", qualityPrior: 0.95, latencyPriorMs: 100,
        strengths: ["coding", "tool_use"], fallback: { inputPrice: 0.1, outputPrice: 0.2 },
      })) },
      routing: { stateDirectory: directory }, maxOutputTokens: 20,
      modelTimeoutMs: { inspection: 80, planning: 120, implementation: 200, finalization: 60 },
      phaseBudget: { discoveryMaxFraction: 0.25, planningMaxFraction: 0.25,
        implementationReserveFraction: 0.5, verificationReserveMs: 10 },
    });
    const logger = new Logger(directory, "timeout", true);
    const gateway = new Gateway(cfg, logger, new Budget(1, 10000, 5000));
    const started = Date.now();
    let failure: unknown;
    try {
      await gateway.call("slow", [{ role: "user", content: "inspect" }], "scope", "inspect", 0);
    } catch (error) { failure = error; }
    assert.ok(failure);
    assert.ok(Date.now() - started < 1000, "central inspection timeout must replace the old 120s default");
    assert.equal(canFallback(failure, gateway), true);
    const recovered = await gateway.call("fast", [{ role: "user", content: "implement" }],
      "scope", "implement", 1, undefined, { maxOutputTokens: 20 });
    assert.equal(recovered.content, "done");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(slowClosed, true, "the timed-out HTTP request is cancelled");
    const failed = logger.events.find((event) => event.type === "model_call" && event.outcome === "error");
    assert.equal(failed?.classification, "OPERATIONAL_FAILURE");
    assert.equal(gateway.budget.unknown, false);
    assert.equal(gateway.modelRouter!.history.read().length, 0,
      "provider timeout is not coding-quality history");
    assert.equal(gateway.modelRouter!.history.readOperations().findLast((call) => call.outcome === "error")?.classification,
      "OPERATIONAL_FAILURE");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("discovery spend cannot consume the protected implementation reserve", async () => {
  const directory = await mkdtemp(join(tmpdir(), "koda-phase-budget-"));
  const server = createServer(async (request, reply) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    reply.setHeader("content-type", "application/json");
    reply.end(JSON.stringify(response(body.model, body.model === "scout" ? 0.025 : 0.04)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const cfg = await config(undefined, {
      baseUrl: `http://127.0.0.1:${address.port}`, models: {}, budgetUsd: 0.1,
      maxInputPrice: 1, maxOutputPrice: 1, maxOutputTokens: 100,
      phaseBudget: { discoveryMaxFraction: 0.25, planningMaxFraction: 0.25,
        implementationReserveFraction: 0.5, verificationReserveMs: 10 },
    });
    const gateway = new Gateway(cfg, new Logger(directory, "phase", true),
      new Budget(0.1, 10000, 5000));
    await gateway.call("scout", [{ role: "user", content: "inspect" }], "scope", "inspect", 0,
      undefined, { maxOutputTokens: 100 });
    await assert.rejects(gateway.call("scout", [{ role: "user", content: "inspect more" }],
      "scope", "inspect", 1, undefined, { maxOutputTokens: 100 }), /phase budget exhausted/);
    const implementation = await gateway.call("coder", [{ role: "user", content: "implement" }],
      "code", "implement", 0, undefined, { maxOutputTokens: 100 });
    assert.equal(implementation.content, "done");
    assert.equal(gateway.budget.spent, 0.065);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

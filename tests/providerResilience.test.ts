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

const response = (model: string, cost?: number) => ({
  id: `response-${model}`, model,
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "done" } }],
  usage: { prompt_tokens: 4, completion_tokens: 2,
    ...(cost === undefined ? {} : { cost }) },
});

const usageGateway = async (
  usage: Record<string, unknown>,
  budgetUsd = 1,
  prices = { prompt: 2, completion: 4 },
) => {
  const directory = await mkdtemp(join(tmpdir(), "koda-provider-cost-"));
  let requests = 0;
  const server = createServer(async (request, reply) => {
    reply.setHeader("content-type", "application/json");
    if (request.method === "GET") {
      reply.end(JSON.stringify({ data: [{
        id: "coder", context_length: 100000, supported_parameters: ["tools"],
        pricing: {
          prompt: String(prices.prompt / 1e6),
          completion: String(prices.completion / 1e6),
        },
      }] }));
      return;
    }
    for await (const _chunk of request) { /* consume request */ }
    requests++;
    reply.end(JSON.stringify({ id: "cost-response", model: "coder",
      choices: [{ index: 0, finish_reason: "stop",
        message: { role: "assistant", content: "done" } }], usage }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const cfg = await config(undefined, {
    baseUrl: `http://127.0.0.1:${address.port}`,
    modelPool: { provider: "local-compatible", models: [{
      id: "coder", enabled: true, tier: "fast", qualityPrior: 0.95,
      latencyPriorMs: 100, strengths: ["coding", "tool_use"],
      fallback: { inputPrice: prices.prompt, outputPrice: prices.completion },
    }] },
    routing: { stateDirectory: directory }, maxOutputTokens: 20,
  });
  const logger = new Logger(directory, "cost", true);
  const budget = new Budget(budgetUsd, 10000, 60000);
  const gateway = new Gateway(cfg, logger, budget);
  return { directory, server, logger, budget, gateway,
    requests: () => requests,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    } };
};

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

test("provider-reported model cost remains authoritative", async () => {
  const fixture = await usageGateway({
    prompt_tokens: 4, completion_tokens: 2, cost: 0.000001,
  });
  try {
    const message = await fixture.gateway.call("coder", [{ role: "user", content: "code" }],
      "cost", "implement", 0, undefined, { maxOutputTokens: 20 });
    assert.equal(message.content, "done");
    assert.equal(fixture.budget.spent, 0.000001);
    const call = fixture.logger.events.find((event) => event.type === "model_call");
    assert.equal(call?.costUsd, 0.000001);
    assert.equal(call?.costSource, "provider_reported");
    assert.equal(call?.providerReportedCostUsd, 0.000001);
  } finally { await fixture.close(); }
});

test("missing charged cost settles once from known token prices without becoming operational failure", async () => {
  const fixture = await usageGateway({ prompt_tokens: 4, completion_tokens: 2 });
  let releases = 0;
  const reserve = fixture.budget.reserve.bind(fixture.budget);
  (fixture.budget as any).reserve = (cost: number, tokens: number) => {
    const release = reserve(cost, tokens);
    return (usage: unknown) => { releases++; release(usage as any); };
  };
  try {
    const message = await fixture.gateway.call("coder", [{ role: "user", content: "code" }],
      "cost", "implement", 0, undefined, { maxOutputTokens: 20 });
    const expected = (4 * 2 + 2 * 4) / 1e6;
    assert.equal(message.content, "done");
    assert.equal(fixture.budget.spent, expected);
    assert.equal(fixture.budget.tokens, 6);
    assert.equal(fixture.budget.unknown, false);
    assert.equal(releases, 1, "the reservation is settled exactly once");
    const call = fixture.logger.events.find((event) => event.type === "model_call");
    assert.equal(call?.costUsd, expected);
    assert.equal(call?.providerReportedCostUsd, null);
    assert.equal(call?.costSource, "estimated_from_tokens");
    assert.equal(fixture.logger.events.some((event) => event.type === "model_error"), false);
    const operation = fixture.gateway.modelRouter!.history.readOperations().at(-1);
    assert.equal(operation?.outcome, "response");
    assert.equal(operation?.costUsd, expected);
    assert.equal(operation?.costSource, "estimated_from_tokens");
    assert.equal(operation?.classification, undefined);
  } finally { await fixture.close(); }
});

test("missing cost without complete token usage fails closed", async () => {
  const fixture = await usageGateway({ prompt_tokens: 4 });
  try {
    await assert.rejects(fixture.gateway.call("coder", [{ role: "user", content: "code" }],
      "cost", "implement", 0, undefined, { maxOutputTokens: 20 }),
    /omitted charged cost and usable token counts/);
    assert.equal(fixture.budget.spent, 0);
    assert.equal(fixture.budget.unknown, true);
    const call = fixture.logger.events.find((event) => event.type === "model_call");
    assert.equal(call?.outcome, "error");
    assert.equal(call?.costUsd, null);
    assert.ok(fixture.logger.events.some((event) =>
      event.type === "model_error" && event.classification === "OPERATIONAL_FAILURE"));
  } finally { await fixture.close(); }
});

test("estimated settlement consumes the real remaining USD budget", async () => {
  const fixture = await usageGateway(
    { prompt_tokens: 4000, completion_tokens: 0 }, 0.00042,
    { prompt: 0.1, completion: 0.2 });
  try {
    const message = await fixture.gateway.call("coder", [{ role: "user", content: "code" }],
      "cost", "implement", 0, undefined, { maxOutputTokens: 20 });
    assert.equal(message.content, "done");
    assert.equal(fixture.budget.spent, 0.0004);
    assert.equal(fixture.budget.unknown, false);
    await assert.rejects(fixture.gateway.call("coder", [{ role: "user", content: "more" }],
      "cost", "implement", 1, undefined, { maxOutputTokens: 20 }), /budget exhausted/);
    assert.equal(fixture.requests(), 1, "the next request is rejected before provider spend");
  } finally { await fixture.close(); }
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

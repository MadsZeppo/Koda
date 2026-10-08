import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { CalibrationBudget } from "./calibrationBudget.js";
import type { CalibrationModel } from "./nativeCalibration.js";
/** Offline-only gateway. Every billable TS/Python request shares the same persistent pre-call ledger. */
export async function calibrationTransport(input: {
  model: CalibrationModel;
  cell: string;
  ledger: CalibrationBudget;
  upstream: string;
  timeoutMs?: number;
}) {
  const receipts: Array<Record<string, unknown>> = [];
  let breach = false;
  const server = createServer(async (req, res) => {
    const fail = (status: number, message: string) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message, type: "calibration_operational_failure" },
        }),
      );
    };
    if (
      req.method === "GET" &&
      /^\/v1\/models(?:\/.*\/endpoints)?$/.test(req.url ?? "")
    ) {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          data: [
            {
              id: input.model.id,
              context_length: input.model.context,
              supported_parameters: input.model.parameters,
              pricing: {
                prompt: String(input.model.inputPrice / 1e6),
                completion: String(input.model.outputPrice / 1e6),
              },
              top_provider: { max_completion_tokens: input.model.output },
            },
          ],
        }),
      );
      return;
    }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      fail(404, "Only frozen model chat calls are allowed");
      return;
    }
    let id: string | undefined;
    const start = Date.now();
    try {
      if (breach)
        throw Error("Provider breached accounting; experiment halted");
      let raw = "";
      for await (const part of req) {
        raw += part;
        if (Buffer.byteLength(raw) > 256 * 1024)
          throw Error("Oversized calibration payload");
      }
      const body = JSON.parse(raw);
      if (
        body.model !== input.model.id ||
        body.models ||
        body.route ||
        body.stream === true
      )
        throw Error("Cross-model/stream fallback forbidden in calibration");
      const allowed = new Set([
        "model",
        "messages",
        "tools",
        "tool_choice",
        "max_tokens",
        "max_completion_tokens",
        "stream",
        "reasoning",
        "reasoning_effort",
        "temperature",
        "top_p",
        "top_k",
        "seed",
        "stop",
        "response_format",
        "provider",
        "usage",
        "frequency_penalty",
        "presence_penalty",
        "parallel_tool_calls",
        "user",
        "session_id",
        "n",
      ]);
      if (
        Object.keys(body).some((key) => !allowed.has(key)) ||
        (body.n !== undefined && body.n !== 1) ||
        (body.max_tokens !== undefined &&
          body.max_completion_tokens !== undefined &&
          body.max_tokens !== body.max_completion_tokens)
      )
        throw Error(
          "Unbounded/ambiguous provider feature rejected before dispatch",
        );
      if (
        !Array.isArray(body.messages) ||
        body.messages.some(
          (m: any) =>
            Array.isArray(m.content) &&
            m.content.some((part: any) => part.type !== "text"),
        )
      )
        throw Error("Only text calibration payloads are priced");
      if (body.tools?.some((tool: any) => tool.type !== "function"))
        throw Error("Unpriced native provider tools forbidden");
      const output = body.max_tokens ?? body.max_completion_tokens;
      if (
        !Number.isSafeInteger(output) ||
        output <= 0 ||
        output > input.model.output
      )
        throw Error("Missing/bad output bound");
      // One token per UTF-8 byte plus framing is a deliberately conservative safety upper bound, not the expected estimator.
      const promptUpper = Buffer.byteLength(raw) + 1024;
      if (promptUpper + output > input.model.context)
        throw Error("Provider context preflight failed");
      const maximum =
        (promptUpper * input.model.inputPrice +
          output * input.model.outputPrice) /
        1e6;
      id = `${input.cell}:${randomUUID()}`;
      await input.ledger.reserve(id, input.cell, maximum);
      body.provider = {
        ...(body.provider ?? {}),
        require_parameters: true,
        allow_fallbacks: false,
        max_price: {
          prompt: input.model.inputPrice,
          completion: input.model.outputPrice,
        },
      };
      body.stream = false;
      const dispatched = Date.now();
      const upstream = await fetch(
        input.upstream.replace(/\/$/, "") + "/chat/completions",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: "Bearer koda-backend-client",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(input.timeoutMs ?? 120000),
          redirect: "error",
        },
      );
      const responseHeadersMs = Date.now() - dispatched;
      const response = await upstream.text();
      let parsed: any;
      try {
        parsed = JSON.parse(response);
      } catch {}
      const served = parsed?.model;
      const usage = parsed?.usage;
      const tokenValid =
        Number.isSafeInteger(usage?.prompt_tokens) &&
        Number.isSafeInteger(usage?.completion_tokens) &&
        usage.prompt_tokens >= 0 &&
        usage.completion_tokens >= 0;
      const fallback = tokenValid
        ? (usage.prompt_tokens * input.model.inputPrice +
            usage.completion_tokens * input.model.outputPrice) /
          1e6
        : undefined;
      const cost =
        typeof usage?.cost === "number" &&
        Number.isFinite(usage.cost) &&
        usage.cost >= 0
          ? usage.cost
          : fallback;
      if (
        (cost !== undefined && cost > maximum + 1e-9) ||
        (tokenValid &&
          (usage.prompt_tokens > promptUpper ||
            usage.completion_tokens > output))
      ) {
        breach = true;
        throw Error(
          "Provider exceeded the requested bounded maximum; halt and reconcile",
        );
      }
      await input.ledger.settle(id, cost);
      receipts.push({
        id,
        requestedModel: input.model.id,
        servedModel: served,
        servedProvider: parsed?.provider ?? null,
        providerPolicy: body.provider,
        costUsd: cost ?? null,
        responseHeadersMs,
        reservationMs: dispatched - start,
        modelWallMs: Date.now() - dispatched,
        operational: !upstream.ok,
      });
      if (upstream.ok && served !== input.model.id) {
        fail(502, "Served model mismatch; cell censored");
        return;
      }
      res.writeHead(upstream.status, { "content-type": "application/json" });
      res.end(response);
    } catch (e) {
      if (id) await input.ledger.settle(id).catch(() => {});
      receipts.push({ id, error: String(e), operational: true });
      fail(502, String(e));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}`,
    receipts,
    get breached() {
      return breach;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}

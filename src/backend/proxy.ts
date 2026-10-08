import { createServer } from "node:http";
import { once } from "node:events";
import {
  OPENROUTER_URL,
  BACKEND_CLIENT_CREDENTIAL,
} from "../provider/transport.js";

/** Fixed upstream, no client-supplied destination or credential is forwarded. */
export async function startKodaBackend(
  options: {
    key?: string;
    upstream?: string;
    host?: string;
    port?: number;
    timeoutMs?: number;
    validateAuth?: boolean;
  } = {},
) {
  const key = (options.key ?? process.env.OPENROUTER_API_KEY)?.trim();
  if (!key?.trim() || /[\r\n]/.test(key))
    throw Error("Backend requires a valid server-side OPENROUTER_API_KEY");
  if (key === BACKEND_CLIENT_CREDENTIAL)
    throw Error(
      "Backend requires a server-side key, not the public client placeholder",
    );
  const upstream = new URL(
    (
      options.upstream ??
      process.env.KODA_OPENROUTER_URL ??
      OPENROUTER_URL
    ).replace(/\/$/, "") + "/",
  );
  if (!["http:", "https:"].includes(upstream.protocol))
    throw Error("Backend upstream requires HTTP or HTTPS");
  if (options.validateAuth) {
    // Read-only provider authentication check; never invokes a model or spends credits.
    let response: Response;
    try {
      response = await fetch(new URL("auth/key", upstream), {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(Math.min(options.timeoutMs ?? 5000, 5000)),
        redirect: "error",
      });
    } catch {
      throw Error(
        "BACKEND_AUTH_FAILURE: upstream authentication check unavailable; no model request was sent",
      );
    }
    await response.arrayBuffer();
    if (!response.ok)
      throw Error(
        `BACKEND_AUTH_FAILURE: upstream returned HTTP ${response.status}; check the backend OPENROUTER_API_KEY; no model request was sent`,
      );
  }
  const redact = (value: string) => value.replaceAll(key, "[REDACTED]");
  const server = createServer(async (req, res) => {
    res.setHeader("x-koda-provider-transport", "backend");
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (req.method === "GET" && path === "/health") {
      res.setHeader("content-type", "application/json");
      res.end('{"ok":true}');
      return;
    }
    const chat = req.method === "POST" && path === "/v1/chat/completions";
    const decision = req.method === "POST" && path === "/api/alpha/decisions";
    const metadata =
      req.method === "GET" &&
      /^\/v1\/(?:models(?:\/[^?#]+\/endpoints)?|classifications\/task|benchmarks)$/.test(
        path,
      );
    const fail = (status: number, message: string, type: string) => {
      res.setHeader("x-koda-error-origin", "backend");
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message, type } }));
    };
    if (!chat && !decision && !metadata) {
      fail(404, "Unknown Koda provider endpoint", "invalid_request");
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? 120_000,
    );
    req.on("aborted", () => controller.abort());
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 2 * 1024 * 1024) {
          fail(413, "Provider payload too large", "invalid_request");
          return;
        }
      }
      let payload: any;
      if (!metadata) {
        try {
          payload = JSON.parse(body);
        } catch {
          fail(400, "Invalid request JSON", "invalid_request");
          return;
        }
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          fail(400, "Invalid request object", "invalid_request");
          return;
        }
      }
      const target = decision
        ? new URL("/api/alpha/decisions", upstream)
        : new URL(path.slice("/v1/".length) + url.search, upstream);
      const response = await fetch(target, {
        method: req.method,
        headers: {
          Authorization: `Bearer ${key}`,
          "content-type": "application/json",
          ...(req.headers["http-referer"]
            ? { "HTTP-Referer": String(req.headers["http-referer"]) }
            : {}),
          ...(req.headers["x-title"]
            ? { "X-Title": String(req.headers["x-title"]) }
            : {}),
        },
        ...(metadata ? {} : { body }),
        signal: controller.signal,
        redirect: "error",
      });
      res.setHeader("x-koda-error-origin", "upstream");
      for (const header of ["retry-after", "x-request-id"]) {
        const value = response.headers.get(header);
        if (value) res.setHeader(header, redact(value));
      }
      const contentType = redact(
        response.headers.get("content-type") ?? "application/json",
      );
      if (
        response.ok &&
        payload?.stream === true &&
        contentType.includes("text/event-stream") &&
        response.body
      ) {
        res.writeHead(response.status, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        const decoder = new TextDecoder();
        let pending = "";
        const sanitizeEvent = (event: string) => {
          const data = [...event.matchAll(/^data: ?([^\r\n]*)/gm)]
            .map((match) => match[1])
            .join("\n");
          try {
            const sanitized = redact(JSON.stringify(JSON.parse(data)));
            let first = true;
            return redact(
              event.replace(/^data: ?[^\r\n]*\r?\n/gm, () => {
                if (!first) return "";
                first = false;
                return `data: ${sanitized}\n`;
              }),
            );
          } catch {
            return redact(event);
          }
        };
        for await (const chunk of response.body) {
          pending += decoder.decode(chunk, { stream: true });
          // SDKs consume complete SSE events. Buffer one event, not the stream,
          // so escaped JSON credentials and network chunk boundaries are safe.
          let separator: RegExpExecArray | null;
          while ((separator = /\r?\n\r?\n/.exec(pending))) {
            const boundary = separator.index + separator[0].length;
            if (!res.write(sanitizeEvent(pending.slice(0, boundary))))
              await once(res, "drain");
            pending = pending.slice(boundary);
          }
        }
        res.end(sanitizeEvent(pending + decoder.decode()));
        return;
      }
      const rawText = await response.text();
      // Decode JSON escapes before redaction, just as the receiving SDK does.
      let text: string;
      try {
        text = redact(JSON.stringify(JSON.parse(rawText)));
      } catch {
        text = redact(rawText);
      }
      if (response.ok) {
        let protocolFailure = "invalid_json";
        try {
          const data = JSON.parse(text);
          if (chat) {
            protocolFailure = "missing_assistant_content";
            const truncated = data?.choices?.[0]?.finish_reason === "length";
            const message = data?.choices?.[0]?.message;
            const tools = message?.tool_calls;
            if (
              !Array.isArray(data?.choices) ||
              message?.role !== "assistant" ||
              !(
                typeof message.content === "string" ||
                (Array.isArray(tools) && tools.length) ||
                // A valid truncated response can contain only reasoning, with
                // null content. Preserve finish_reason and usage so the worker
                // handles output-limit recovery and settles its reservation.
                (truncated && message.content === null) ||
                typeof message.refusal === "string"
              )
            )
              throw Error("Malformed completion");
            protocolFailure = "invalid_tool_envelope";
            if (
              tools !== undefined &&
              (!Array.isArray(tools) ||
                tools.some(
                  (tool: any) =>
                    typeof tool?.id !== "string" ||
                    tool.type !== "function" ||
                    typeof tool.function?.name !== "string" ||
                    typeof tool.function?.arguments !== "string",
                ))
            )
              throw Error("Malformed tool protocol");
            protocolFailure = "invalid_tool_arguments";
            // Truncated arguments are never executable, but must reach the
            // worker as an output limit rather than lose usage in a proxy 502.
            if (!truncated)
              for (const tool of tools ?? []) JSON.parse(tool.function.arguments);
          }
        } catch {
          fail(
            502,
            `OpenRouter returned a malformed response (${protocolFailure})`,
            "provider_protocol_error",
          );
          return;
        }
      }
      res.writeHead(response.status, { "content-type": contentType });
      res.end(text);
    } catch {
      if (res.headersSent) res.destroy();
      else
        fail(
          controller.signal.aborted ? 504 : 502,
          controller.signal.aborted
            ? "OpenRouter request timed out"
            : "OpenRouter transport failed",
          "provider_operational_error",
        );
    } finally {
      clearTimeout(timer);
    }
  });
  server.listen(options.port ?? 0, options.host ?? "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

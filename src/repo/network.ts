import {
  Agent,
  createServer,
  request,
  type OutgoingHttpHeaders,
} from "node:http";
import { connect, isIP, type Socket } from "node:net";
import { lookup } from "node:dns/promises";

export const DEFAULT_BUILD_DOMAINS = [
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "github.com",
  "codeload.github.com",
  "raw.githubusercontent.com",
  "nodejs.org",
  "static.rust-lang.org",
  "static.crates.io",
  "crates.io",
];

export function sandboxNetworkPolicy(env = process.env) {
  const mode = env.KODA_SANDBOX_NETWORK ?? "restricted";
  if (!["restricted", "off"].includes(mode))
    throw Error("KODA_SANDBOX_NETWORK must be restricted or off");
  const domains = [
    ...new Set([
      ...DEFAULT_BUILD_DOMAINS,
      ...(env.KODA_SANDBOX_NETWORK_DOMAINS ?? "")
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ]),
  ];
  if (
    domains.some(
      (domain) =>
        !/^(?:\*\.)?[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/.test(domain),
    )
  )
    throw Error(
      "Invalid sandbox network domain; use hostnames, not URLs or a global wildcard",
    );
  return { mode, domains };
}

export function domainAllowed(host: string, domains: readonly string[]) {
  host = host.toLowerCase().replace(/\.$/, "");
  return (
    !isIP(host) &&
    domains.some((domain) =>
      domain.startsWith("*.")
        ? host.endsWith(domain.slice(1)) && host !== domain.slice(2)
        : host === domain,
    )
  );
}

export function publicAddress(address: string) {
  if (address.startsWith("::ffff:")) return publicAddress(address.slice(7));
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a! >= 224 ||
      (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0)
    );
  }
  return (
    isIP(address) === 6 &&
    /^[23]/.test(address) &&
    !address.toLowerCase().startsWith("2001:db8:")
  );
}

/** Host-owned forward proxy. The OS still denies direct external connections.
 * DNS is checked and the upstream socket is pinned to its checked public IP. */
export async function startSandboxNetworkProxy(options: {
  domains: readonly string[];
  timeoutMs?: number;
  resolveHost?: (host: string) => Promise<string[]>;
  connectHost?: (address: string, port: number) => Socket;
}) {
  const sockets = new Set<Socket>();
  const timeout = Math.min(options.timeoutMs ?? 60_000, 60_000);
  const destination = async (host: string, port: number) => {
    if (![80, 443].includes(port) || !domainAllowed(host, options.domains))
      throw Error("blocked");
    const addresses = await (options.resolveHost
      ? options.resolveHost(host)
      : lookup(host, { all: true }).then((rows) =>
          rows.map((row) => row.address),
        ));
    if (
      !addresses.length ||
      addresses.some((address) => !publicAddress(address))
    )
      throw Error("blocked");
    return addresses[0]!;
  };
  const socketTo = (address: string, port: number) => {
    const socket = options.connectHost
      ? options.connectHost(address, port)
      : connect({ host: address, port });
    sockets.add(socket);
    socket.setTimeout(timeout, () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
    return socket;
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "");
      if (
        url.protocol !== "http:" ||
        url.username ||
        url.password ||
        !["GET", "HEAD"].includes(req.method ?? "")
      )
        throw Error("blocked");
      const port = Number(url.port || 80);
      const address = await destination(url.hostname, port);
      const headers: OutgoingHttpHeaders = { ...req.headers, host: url.host };
      for (const key of [
        "authorization",
        "cookie",
        "proxy-authorization",
        "proxy-connection",
        "connection",
        "transfer-encoding",
        "content-length",
      ])
        delete headers[key];
      const agent = new Agent();
      agent.createConnection = () => socketTo(address, port);
      const upstream = request(
        {
          hostname: url.hostname,
          port,
          path: url.pathname + url.search,
          method: req.method,
          headers,
          agent,
        },
        (response) => {
          res.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(res);
        },
      );
      upstream.setTimeout(timeout, () => upstream.destroy());
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end("Sandbox network upstream unavailable");
      });
      req.on("aborted", () => upstream.destroy());
      upstream.end();
    } catch {
      res.writeHead(403);
      res.end(
        "KODA_NETWORK_BLOCKED: destination is not an approved public build resource",
      );
    }
  });
  server.on("connect", async (req, client, head) => {
    try {
      const url = new URL(`https://${req.url}`);
      if (url.username || url.password || url.pathname !== "/")
        throw Error("blocked");
      const port = Number(url.port || 443);
      if (port !== 443) throw Error("blocked");
      const address = await destination(url.hostname, port);
      const upstream = socketTo(address, port);
      client.on("error", () => upstream.destroy());
      client.on("close", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
    } catch {
      client.end(
        "HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\nKODA_NETWORK_BLOCKED",
      );
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    url,
    environment: {
      HTTP_PROXY: url,
      HTTPS_PROXY: url,
      http_proxy: url,
      https_proxy: url,
      NO_PROXY: "localhost,127.0.0.1,::1",
      no_proxy: "localhost,127.0.0.1,::1",
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

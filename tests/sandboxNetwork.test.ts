import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sandboxNetworkPolicy,
  domainAllowed,
  publicAddress,
  startSandboxNetworkProxy,
} from "../src/repo/network.js";
import { command } from "../src/repo/commands.js";

test("build policy permits development resources and explicit scoped additions", () => {
  const policy = sandboxNetworkPolicy({
    KODA_SANDBOX_NETWORK_DOMAINS: "assets.example.test,*.packages.example.test",
  });
  assert.equal(policy.mode, "restricted");
  assert.equal(domainAllowed("fonts.googleapis.com", policy.domains), true);
  assert.equal(domainAllowed("fonts.gstatic.com", policy.domains), true);
  assert.equal(
    domainAllowed("fonts.googleapis.com.evil.test", policy.domains),
    false,
  );
  assert.equal(domainAllowed("assets.example.test", policy.domains), true);
  assert.equal(domainAllowed("a.packages.example.test", policy.domains), true);
  assert.equal(domainAllowed("packages.example.test", policy.domains), false);
  assert.equal(
    sandboxNetworkPolicy({ KODA_SANDBOX_NETWORK: "off" }).mode,
    "off",
  );
  assert.throws(() => sandboxNetworkPolicy({ KODA_SANDBOX_NETWORK: "all" }));
  assert.throws(() =>
    sandboxNetworkPolicy({ KODA_SANDBOX_NETWORK_DOMAINS: "*" }),
  );
  assert.throws(() =>
    sandboxNetworkPolicy({
      KODA_SANDBOX_NETWORK_DOMAINS: "https://example.test",
    }),
  );
});

test("proxy rejects loopback, private, link-local and mapped private addresses", () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "not-an-ip",
  ])
    assert.equal(publicAddress(ip), false, ip);
  for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111"])
    assert.equal(publicAddress(ip), true, ip);
});

const through = (proxy: string, target: string, headers = {}) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const url = new URL(proxy);
    const req = request(
      { hostname: url.hostname, port: url.port, path: target, headers },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });

test("real HTTP proxy forwards allowed downloads with pinned DNS and removes credentials", async (t) => {
  let calls = 0;
  const upstream = createServer((req, res) => {
    calls++;
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers["proxy-authorization"], undefined);
    assert.equal(req.headers.host, "assets.example.test");
    res.end("real asset bytes");
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  t.after(
    () => new Promise<void>((resolve) => upstream.close(() => resolve())),
  );
  const proxy = await startSandboxNetworkProxy({
    domains: ["assets.example.test"],
    resolveHost: async () => ["93.184.216.34"],
    connectHost: (address, port) => {
      assert.equal(address, "93.184.216.34");
      assert.equal(port, 80);
      return connect(
        (upstream.address() as { port: number }).port,
        "127.0.0.1",
      );
    },
  });
  t.after(() => proxy.close());
  assert.deepEqual(
    await through(proxy.url, "http://assets.example.test/font.css", {
      authorization: "Bearer test-secret",
      cookie: "session=test",
      "proxy-authorization": "secret",
    }),
    { status: 200, body: "real asset bytes" },
  );
  assert.equal(
    (await through(proxy.url, "http://denied.example.test/font.css")).status,
    403,
  );
  assert.equal(calls, 1);
});

test("approved hostname resolving to a private IP is blocked before connecting", async (t) => {
  let connected = false;
  const proxy = await startSandboxNetworkProxy({
    domains: ["assets.example.test"],
    resolveHost: async () => ["127.0.0.1"],
    connectHost: () => {
      connected = true;
      throw Error("must not connect");
    },
  });
  t.after(() => proxy.close());
  assert.equal(
    (await through(proxy.url, "http://assets.example.test/font.css")).status,
    403,
  );
  assert.equal(connected, false);
});

test("HTTPS CONNECT enforces domains, public DNS and port bounds", async (t) => {
  let calls = 0;
  const upstream = createServer();
  upstream.on("connection", (socket) =>
    socket.on("data", (chunk) => socket.write(chunk)),
  );
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  t.after(() => {
    upstream.closeAllConnections();
    return new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
  const proxy = await startSandboxNetworkProxy({
    domains: ["assets.example.test"],
    resolveHost: async () => ["93.184.216.34"],
    connectHost: (_, port) => {
      calls++;
      assert.equal(port, 443);
      return connect(
        (upstream.address() as { port: number }).port,
        "127.0.0.1",
      );
    },
  });
  t.after(() => proxy.close());
  const tunnel = (target: string) =>
    new Promise<number>((resolve, reject) => {
      const req = request(proxy.url, { method: "CONNECT", path: target });
      req.on("connect", (res, socket) => {
        socket.destroy();
        resolve(res.statusCode!);
      });
      req.on("error", reject);
      req.end();
    });
  assert.equal(await tunnel("assets.example.test:443"), 200);
  assert.equal(await tunnel("denied.example.test:443"), 403);
  assert.equal(await tunnel("assets.example.test:22"), 403);
  assert.equal(calls, 1);
});

test(
  "actual sandbox supplies one proxy policy to builds and still denies unapproved requests",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "koda-network-sandbox-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(
      join(root, "check.cjs"),
      `const a=require('node:assert/strict'),http=require('node:http');
a.equal(process.env.HTTP_PROXY,process.env.HTTPS_PROXY);
const u=new URL(process.env.HTTP_PROXY);http.get({hostname:u.hostname,port:u.port,path:'http://not-approved.example.test/resource'},r=>{a.equal(r.statusCode,403);r.resume()});\n`,
    );
    const result = await command(root, "node check.cjs");
    assert.equal(result.exitCode, 0, result.stderr);
  },
);

test(
  "sandbox broker refuses a child's attempt to enable unrestricted bootstrap networking",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "koda-network-broker-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(
      join(root, "check.cjs"),
      `const a=require('node:assert/strict'),net=require('node:net');
const s=net.createConnection(process.env.KODA_SANDBOX_BROKER);let data='';
s.on('connect',()=>s.write(JSON.stringify({token:process.env.KODA_SANDBOX_BROKER_TOKEN,cwd:process.cwd(),cmd:'echo unsafe',timeoutMs:1000,dependencyBootstrap:true})+'\\n'));
s.on('data',chunk=>data+=chunk);s.on('end',()=>a.match(JSON.parse(data).error,/cannot expand/));\n`,
    );
    const result = await command(root, "node check.cjs");
    assert.equal(result.exitCode, 0, result.stderr);
  },
);

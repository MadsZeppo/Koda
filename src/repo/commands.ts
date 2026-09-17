import { scopedCommand, type WriteScope } from "./writeScope.js";
import { execa } from "execa";
import { realpath, mkdtemp, rm, mkdir, lstat, symlink } from "node:fs/promises";
import { join, dirname, relative, isAbsolute, posix } from "node:path";
import { createConnection, createServer } from "node:net";
import { randomBytes } from "node:crypto";
import type { CommandResult } from "../types.js";
import {
  dependenciesForWorkspace,
  type DependencyBridge,
} from "./dependencies.js";

const within = (root: string, path: string) => {
  const rel = relative(root, path);
  return (
    rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"))
  );
};

async function brokeredCommand(
  cwd: string,
  cmd: string,
  timeoutMs: number,
  readOnly: boolean,
  scope: WriteScope | undefined,
  dependencyBridges: DependencyBridge[],
) {
  const socket = process.env.KODA_SANDBOX_BROKER;
  const token = process.env.KODA_SANDBOX_BROKER_TOKEN;
  if (!socket || !token || process.platform !== "darwin") return undefined;
  return new Promise<CommandResult>((resolve, reject) => {
    const client = createConnection(socket);
    let response = "";
    const timer = setTimeout(() => {
      client.destroy();
      reject(Error("Sandbox broker timed out"));
    }, timeoutMs + 1000);
    client.setEncoding("utf8");
    client.on("connect", () =>
      client.write(
        JSON.stringify({
          token,
          cwd,
          cmd,
          timeoutMs,
          readOnly,
          scope,
          dependencyBridges,
        }) + "\n",
      ),
    );
    client.on("data", (chunk) => (response += chunk));
    client.on("error", reject);
    client.on("close", () => {
      clearTimeout(timer);
      try {
        const message = JSON.parse(response);
        if (message.error) reject(Error(message.error));
        else resolve(message.result);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function sandboxBroker(
  socket: string,
  token: string,
  roots: string[],
  allowedBridges: DependencyBridge[],
  deadline: number,
) {
  const server = createServer((client) => {
    client.setEncoding("utf8");
    let request = "";
    let handled = false;
    client.on("data", async (chunk) => {
      request += chunk;
      if (request.length > 1024 * 1024) client.destroy();
      if (handled || !request.includes("\n")) return;
      handled = true;
      try {
        const message = JSON.parse(request);
        if (message.token !== token)
          throw Error("Invalid sandbox broker token");
        const cwd = await realpath(message.cwd);
        if (!roots.some((root) => within(root, cwd)))
          throw Error(
            "Sandbox broker cwd is outside the verification workspace",
          );
        const bridges: DependencyBridge[] = [];
        for (const bridge of message.dependencyBridges ?? []) {
          const relativePath = posix.normalize(String(bridge.relativePath));
          if (
            relativePath.startsWith("/") ||
            relativePath === ".." ||
            relativePath.startsWith("../") ||
            relativePath.split("/").some((part) => part === ".git") ||
            !relativePath.endsWith("node_modules")
          )
            throw Error("Invalid sandbox broker dependency target");
          const sourcePath = await realpath(bridge.sourcePath);
          if (
            !roots.some((root) => within(root, sourcePath)) &&
            !allowedBridges.some((allowed) =>
              within(allowed.sourcePath, sourcePath),
            )
          )
            throw Error("Sandbox broker dependency is outside allowed roots");
          bridges.push({ relativePath, sourcePath });
        }
        const remaining = Math.min(
          Number(message.timeoutMs) || 0,
          deadline - Date.now(),
        );
        if (remaining <= 0) throw Error("Sandbox broker budget exhausted");
        const result = await command(
          cwd,
          String(message.cmd),
          remaining,
          !!message.readOnly,
          message.scope,
          bridges,
        );
        client.end(JSON.stringify({ result }));
      } catch (error) {
        client.end(JSON.stringify({ error: String(error) }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  return () => new Promise<void>((resolve) => server.close(() => resolve()));
}

export async function git(cwd: string, ...args: string[]) {
  return (
    await execa("git", args, {
      cwd,
      env: { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    })
  ).stdout;
}
export async function command(
  cwd: string,
  cmd: string,
  timeoutMs = 120000,
  readOnly = false,
  scope?: WriteScope,
  inheritedBridges?: DependencyBridge[],
): Promise<CommandResult> {
  const dependencyBridges =
    inheritedBridges ?? (await dependenciesForWorkspace(cwd));
  if (scope && !readOnly)
    return scopedCommand(
      cwd,
      scope,
      (copy, remaining) =>
        command(copy, cmd, remaining, readOnly, undefined, dependencyBridges),
      timeoutMs,
    );
  const brokered = await brokeredCommand(
    cwd,
    cmd,
    timeoutMs,
    readOnly,
    undefined,
    dependencyBridges,
  );
  if (brokered) return brokered;
  const start = Date.now();
  cwd = await realpath(cwd);
  let scratchPrefix = "/tmp/k-";
  if (process.platform === "darwin" && process.env.KODA_SANDBOX_TMP_ROOT) {
    const inherited = await realpath(process.env.KODA_SANDBOX_TMP_ROOT);
    if (
      (inherited.startsWith("/private/tmp/k-") ||
        inherited.startsWith("/tmp/k-")) &&
      inherited.length < 48
    )
      scratchPrefix = join(inherited, "n-");
  }
  const hostScratch =
    process.platform === "darwin"
      ? await realpath(await mkdtemp(scratchPrefix))
      : undefined;
  const scratch = hostScratch ?? "/tmp/k";
  const brokerSocket = hostScratch ? join(scratch, "b.sock") : undefined;
  const brokerToken = brokerSocket
    ? randomBytes(24).toString("hex")
    : undefined;
  const mounted: string[] = [];
  const activeBridges: (DependencyBridge & { targetPath: string })[] = [];
  try {
    for (const bridge of dependencyBridges) {
      const targetPath = join(cwd, bridge.relativePath);
      try {
        const stat = await lstat(targetPath);
        if (
          stat.isSymbolicLink() &&
          (await realpath(targetPath)) === bridge.sourcePath
        )
          activeBridges.push({ ...bridge, targetPath });
        continue;
      } catch (error: any) {
        if (error.code !== "ENOENT") throw error;
      }
      await mkdir(dirname(targetPath), { recursive: true });
      if (process.platform === "darwin")
        await symlink(bridge.sourcePath, targetPath, "dir");
      else await mkdir(targetPath, { recursive: true });
      mounted.push(targetPath);
      activeBridges.push({ ...bridge, targetPath });
    }
  } catch (error) {
    if (hostScratch) await rm(hostScratch, { recursive: true, force: true });
    throw error;
  }
  const env = {
    PATH: process.env.PATH!,
    HOME: scratch,
    npm_config_cache: join(scratch, "npm-cache"),
    TMPDIR: scratch,
    TMP: scratch,
    TEMP: scratch,
    KODA_SANDBOX_TMP_ROOT: scratch,
    ...(brokerSocket
      ? {
          KODA_SANDBOX_BROKER: brokerSocket,
          KODA_SANDBOX_BROKER_TOKEN: brokerToken!,
        }
      : {}),
    KODA_SANDBOX_DEPENDENCIES: JSON.stringify(
      activeBridges.map(({ relativePath, sourcePath }) => ({
        relativePath,
        sourcePath,
      })),
    ),
    CI: "1",
    COREPACK_ENABLE_NETWORK: "0",
    npm_config_offline: "true",
    npm_config_yes: "false",
    // pnpm 11 otherwise runs an implicit install when a read-only dependency
    // tree was created for the original path rather than this source snapshot.
    pnpm_config_verify_deps_before_run: "false",
    PIP_NO_INDEX: "1",
    UV_OFFLINE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    MYPY_CACHE_DIR: join(scratch, "mypy-cache"),
    GIT_TERMINAL_PROMPT: "0",
  };
  let bin: string, args: string[];
  if (process.platform === "darwin") {
    const q = (s: string) => JSON.stringify(s);
    const ancestors: string[] = [];
    for (let p = dirname(cwd); p !== dirname(p); p = dirname(p))
      ancestors.push(`(literal ${q(p)})`);
    const dependencyReads = activeBridges
      .map((bridge) => `(subpath ${q(bridge.sourcePath)})`)
      .join(" ");
    const dependencyWriteDenials = activeBridges
      .map((bridge) => `(deny file-write* (subpath ${q(bridge.sourcePath)}))`)
      .join("");
    const readable = `(require-any ${ancestors.join(" ")} (literal "/") (subpath "/System") (subpath "/Library") (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/opt") (subpath "/private/etc") (subpath "/private/var/db") (subpath "/dev") (subpath ${q(cwd)}) (subpath ${q(scratch)}) ${dependencyReads})`;
    const writable = `(require-any (literal "/dev/null") (subpath ${q(scratch)}) ${readOnly ? "" : `(subpath ${q(cwd)})`})`;
    const localNetwork = `(require-any (prefix ${q(scratch + "/")}) (local ip "localhost:*"))`;
    const localOutbound = `(require-any (prefix ${q(scratch + "/")}) (remote ip "localhost:*"))`;
    const profile = `(version 1)(allow default)(deny file-read-data (require-not ${readable}))(deny file-write* (require-not ${writable}))${dependencyWriteDenials}(deny file-write* (subpath ${q(join(cwd, ".git"))}))(deny network-outbound (require-not ${localOutbound}))(deny network-inbound (require-not ${localNetwork}))(deny network-bind (require-not ${localNetwork}))`;
    bin = "/usr/bin/sandbox-exec";
    args = ["-p", profile, "/bin/sh", "-c", cmd];
  } else if (process.platform === "linux") {
    bin = "bwrap";
    args = [
      "--die-with-parent",
      "--unshare-all",
      "--new-session",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--dir",
      scratch,
      "--remount-ro",
      "/tmp",
      "--tmpfs",
      scratch,
    ];
    for (const p of ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/opt"])
      args.push("--ro-bind-try", p, p);
    args.push(
      readOnly ? "--ro-bind" : "--bind",
      cwd,
      cwd,
      "--ro-bind",
      join(cwd, ".git"),
      join(cwd, ".git"),
    );
    // Mount children after the workspace parent so the read-only dependency
    // mounts cannot be hidden by the writable workspace bind.
    for (const bridge of activeBridges)
      args.push("--ro-bind", bridge.sourcePath, bridge.targetPath);
    args.push("--chdir", cwd, "/bin/sh", "-c", cmd);
  } else
    throw Error(
      "Shell isolation requires macOS sandbox-exec or Linux bubblewrap",
    );
  let childPid: number | undefined;
  let closeBroker: (() => Promise<void>) | undefined;
  try {
    if (brokerSocket)
      closeBroker = await sandboxBroker(
        brokerSocket,
        brokerToken!,
        [cwd, scratch],
        activeBridges,
        start + timeoutMs,
      );
    const child = execa(bin, args, {
      cwd,
      detached: true,
      env,
      extendEnv: false,
      reject: false,
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      killSignal: "SIGKILL",
    });
    childPid = child.pid;
    const r = await child;
    return {
      command: cmd,
      exitCode: r.exitCode ?? 1,
      stdout: r.stdout.slice(-16000),
      stderr: (
        r.stderr + (r.signal ? "\nTerminated by " + r.signal : "")
      ).slice(-8000),
      wallClockMs: Date.now() - start,
      timedOut: r.timedOut ?? false,
    };
  } catch (e) {
    return {
      command: cmd,
      exitCode: 1,
      stdout: "",
      stderr: String(e).slice(0, 2000),
      wallClockMs: Date.now() - start,
      timedOut: Date.now() - start >= timeoutMs,
    };
  } finally {
    if (childPid) {
      try {
        process.kill(-childPid, "SIGKILL");
      } catch {}
    }
    if (closeBroker) await closeBroker();
    if (hostScratch) await rm(hostScratch, { recursive: true, force: true });
    for (const path of mounted.reverse())
      await rm(path, { recursive: true, force: true });
  }
}

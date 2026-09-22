import { scopedCommand, type WriteScope } from "./writeScope.js";
import { execa } from "execa";
import { realpath, mkdtemp, rm, mkdir, lstat, symlink, readFile, readdir, access } from "node:fs/promises";
import { join, dirname, relative, isAbsolute, posix, resolve, delimiter } from "node:path";
import { createConnection, createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import type { CommandResult } from "../types.js";
import {
  dependenciesForWorkspace,
  nodeEnvironmentForWorkspace,
  pythonEnvironmentForWorkspace,
  type DependencyBridge,
} from "./dependencies.js";

const within = (root: string, path: string) => {
  const rel = relative(root, path);
  return (
    rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"))
  );
};

/** Bubblewrap needs these mountpoints before /tmp becomes read-only. */
export function linuxTemporaryMountPoints(cwd: string, scratch: string, readRoots: string[] = []): string[] {
  const points = new Set<string>();
  for (const target of [cwd, scratch, ...readRoots]) {
    if (!within("/tmp", target) || target === "/tmp") continue;
    let parent = "/tmp";
    for (const component of relative("/tmp", target).split("/").filter(Boolean)) {
      parent = join(parent, component);
      points.add(parent);
    }
  }
  return [...points].sort((a, b) => a.length - b.length || a.localeCompare(b));
}
export function linuxTemporaryMountArguments(cwd: string, scratch: string, readRoots: string[] = []): string[] {
  return ["--tmpfs", "/tmp",
    ...linuxTemporaryMountPoints(cwd, scratch, readRoots).flatMap((point) => ["--dir", point]),
    "--remount-ro", "/tmp", "--tmpfs", scratch];
}

/** Reuse existing environments only when their interpreter and import paths can
 * be made available read-only without importing the original candidate source. */
export async function pythonSandboxEnvironment(
  root: string, inherited: NodeJS.ProcessEnv = process.env, strict = false,
  sourceRoot?: string,
) {
  const workspace = await realpath(root);
  const original = sourceRoot ? await realpath(sourceRoot) : undefined;
  const systemPath = (path: string) =>
    ["/usr", "/bin", "/sbin", "/opt", "/System", "/Library"].some((base) => within(base, path));
  const remap = (path: string) => original && within(original, path)
    ? join(workspace, relative(original, path)) : path;
  const local = async (path: string | undefined) => {
    if (!path || !isAbsolute(path)) return undefined;
    try {
      const resolved = await realpath(remap(await realpath(path)));
      return within(workspace, resolved) ? resolved : undefined;
    } catch { return undefined; }
  };
  const readRoots = new Set<string>();
  let unsafeSelectedEnvironment = false;
  const usableEnvironment = async (path: string, external: boolean) => {
    try {
      const envRoot = await realpath(path);
      const config = await readFile(join(envRoot, "pyvenv.cfg"), "utf8");
      const home = config.match(/^home\s*=\s*(.+)$/m)?.[1]?.trim();
      if (!home || !isAbsolute(home)) return undefined;
      const homePath = await realpath(home);
      const baseRoot = /(?:^|\/)(?:bin|Scripts)$/.test(homePath)
        ? dirname(homePath)
        : homePath;
      if (/^include-system-site-packages\s*=\s*true/im.test(config)) {
        unsafeSelectedEnvironment = true;
        return undefined;
      }
      let interpreter: string | undefined;
      let resolvedInterpreter: string | undefined;
      for (const name of ["python3", "python"]) {
        const candidate = join(envRoot, "bin", name);
        try {
          await access(candidate, constants.X_OK);
          resolvedInterpreter = await realpath(candidate);
          interpreter = candidate;
          break;
        } catch {}
      }
      if (!interpreter || !resolvedInterpreter) return undefined;
      // A real venv points back to the interpreter distribution named by
      // pyvenv.cfg. Reject environment-local replacements while allowing the
      // ordinary symlink layouts used by system and package-manager Python.
      if (!systemPath(resolvedInterpreter) && !within(baseRoot, resolvedInterpreter)) return undefined;
      // Executable .pth files and editable installs can redirect imports to the
      // original checkout. Do not guess whether arbitrary startup code is safe.
      for (const version of await readdir(join(envRoot, "lib")).catch(() => [])) {
        if (!/^python\d/.test(version)) continue;
        const site = join(envRoot, "lib", version, "site-packages");
        for (const file of await readdir(site).catch(() => [])) {
          if (file.endsWith(".egg-link") || /editable/i.test(file)) {
            unsafeSelectedEnvironment = true;
            return undefined;
          }
          if (!file.endsWith(".pth")) continue;
          const lines = (await readFile(join(site, file), "utf8")).split(/\r?\n/);
          for (const line of lines.map((line) => line.trim()).filter((line) => line && !line.startsWith("#"))) {
            if (/^import[ \t]/.test(line)) {
              if (/sys\.path|addsitedir|\bchdir\s*\(|\b(?:exec|eval)\s*\(/.test(line) ||
                  (original && line.includes(original))) {
                unsafeSelectedEnvironment = true;
                return undefined;
              }
              continue;
            }
            const target = await realpath(resolve(site, line));
            if (!within(envRoot, target)) {
              unsafeSelectedEnvironment = true;
              return undefined;
            }
          }
        }
      }
      if (external) {
        readRoots.add(envRoot);
        readRoots.add(baseRoot);
      }
      return { environmentRoot: envRoot, interpreter };
    } catch { return undefined; }
  };
  let selected: { environmentRoot?: string; interpreter: string } | undefined;
  // Repository evidence wins over an activated shell environment.
  for (const name of [".venv", "venv"]) {
    selected = await usableEnvironment(join(workspace, name), false);
    if (selected) break;
  }
  const inheritedLocal = await local(inherited.VIRTUAL_ENV);
  if (!selected && inheritedLocal)
    selected = await usableEnvironment(inheritedLocal, false);

  const pathParts: string[] = [];
  for (const part of (inherited.PATH ?? "").split(delimiter).filter(Boolean)) {
    if (!isAbsolute(part)) continue;
    const mapped = remap(await realpath(part).catch(() => resolve(part)));
    const absolute = await realpath(mapped).catch(() => resolve(mapped));
    const parent = dirname(absolute);
    const venvRoot = /(?:^|\/)(?:bin|Scripts)$/.test(absolute) ? parent : undefined;
    if (venvRoot) {
      const isVenv = await lstat(join(venvRoot, "pyvenv.cfg")).then(() => true).catch(() => false);
      if (isVenv && selected?.environmentRoot !== venvRoot) continue;
    }
    if (strict && !within(workspace, absolute) && !systemPath(absolute) &&
        ![...readRoots].some((root) => within(root, absolute))) continue;
    pathParts.push(absolute);
  }
  const probeSystemPython = async () => {
    if (unsafeSelectedEnvironment) return;
    for (const directory of pathParts) {
      for (const name of ["python3", "python"]) {
        try {
          const candidate = await realpath(join(directory, name));
          await access(candidate, constants.X_OK);
          if (systemPath(candidate)) {
            selected = { interpreter: candidate, environmentRoot: undefined };
            return;
          }
        } catch {}
      }
    }
  };
  if (!selected && inherited.VIRTUAL_ENV && !inheritedLocal) {
    selected = await usableEnvironment(inherited.VIRTUAL_ENV, true);
    if (!selected && unsafeSelectedEnvironment) unsafeSelectedEnvironment = false;
  }
  if (!selected) await probeSystemPython();
  const virtualEnv = selected?.environmentRoot;
  const selectedBin = virtualEnv ? join(virtualEnv, "bin") : undefined;
  const executablePath = [selectedBin, ...pathParts,
    "/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew/bin"].filter(
      (part): part is string => !!part,
    );
  return { PATH: [...new Set(executablePath)].join(delimiter),
    // Relative entries follow project-unit `cd` commands.
    PYTHONPATH: [".", "src", workspace, join(workspace, "src")].join(delimiter),
    interpreter: selected?.interpreter,
    unavailable: selected ? undefined : "python_environment_inaccessible",
    readRoots: [...readRoots],
    ...(virtualEnv ? { VIRTUAL_ENV: virtualEnv } : {}),
  };
}

async function brokeredCommand(
  cwd: string,
  cmd: string,
  timeoutMs: number,
  readOnly: boolean,
  scope: WriteScope | undefined,
  dependencyBridges: DependencyBridge[],
  strictPythonEnvironment: boolean,
  pythonSourceRoot?: string,
  inheritedPythonEnvironment: NodeJS.ProcessEnv = process.env,
  dependencyBootstrap = false,
  nodeProjectRoot = ".",
  additionalEnvironment: NodeJS.ProcessEnv = {},
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
          strictPythonEnvironment,
          pythonSourceRoot,
          pythonEnvironment: {
            PATH: inheritedPythonEnvironment.PATH,
            VIRTUAL_ENV: inheritedPythonEnvironment.VIRTUAL_ENV,
          },
          dependencyBootstrap,
          nodeProjectRoot,
          additionalEnvironment: {
            OPENROUTER_API_KEY: additionalEnvironment.OPENROUTER_API_KEY,
          },
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
        const pythonEnvironment: NodeJS.ProcessEnv = {
          PATH: typeof message.pythonEnvironment?.PATH === "string"
            ? message.pythonEnvironment.PATH : "",
        };
        const virtualEnv = message.pythonEnvironment?.VIRTUAL_ENV;
        if (typeof virtualEnv === "string" && virtualEnv) {
          const resolved = await realpath(virtualEnv);
          if (!roots.some((root) => within(root, resolved)))
            throw Error("Sandbox broker VIRTUAL_ENV is outside allowed roots");
          pythonEnvironment.VIRTUAL_ENV = resolved;
        }
        let pythonSourceRoot: string | undefined;
        if (message.pythonSourceRoot) {
          pythonSourceRoot = await realpath(String(message.pythonSourceRoot));
          if (!roots.some((root) => within(root, pythonSourceRoot!)))
            throw Error("Sandbox broker Python source root is outside allowed roots");
        }
        const result = await command(
          cwd,
          String(message.cmd),
          remaining,
          !!message.readOnly,
          message.scope,
          bridges,
          !!message.strictPythonEnvironment,
          pythonSourceRoot,
          pythonEnvironment,
          !!message.dependencyBootstrap,
          typeof message.nodeProjectRoot === "string" ? message.nodeProjectRoot : ".",
          typeof message.additionalEnvironment?.OPENROUTER_API_KEY === "string"
            ? { OPENROUTER_API_KEY: message.additionalEnvironment.OPENROUTER_API_KEY } : {},
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
  strictPythonEnvironment = false,
  pythonSourceRoot?: string,
  inheritedPythonEnvironment: NodeJS.ProcessEnv = process.env,
  dependencyBootstrap = false,
  nodeProjectRoot = ".",
  additionalEnvironment: NodeJS.ProcessEnv = {},
): Promise<CommandResult> {
  const dependencyBridges =
    inheritedBridges ?? (await dependenciesForWorkspace(cwd));
  const registeredNode = await nodeEnvironmentForWorkspace(cwd, nodeProjectRoot);
  const registeredPython = await pythonEnvironmentForWorkspace(cwd);
  const runtimeEnvironment = registeredNode
    ? { ...inheritedPythonEnvironment,
        PATH: `${registeredNode.binPath}${delimiter}${inheritedPythonEnvironment.PATH ?? ""}` }
    : inheritedPythonEnvironment;
  const effectivePythonEnvironment = registeredPython
    ? { ...runtimeEnvironment, VIRTUAL_ENV: registeredPython,
        PATH: `${join(registeredPython, "bin")}${delimiter}${runtimeEnvironment.PATH ?? ""}` }
    : runtimeEnvironment;
  if (scope && !readOnly)
    return scopedCommand(
      cwd,
      scope,
      (copy, remaining) =>
        command(copy, cmd, remaining, readOnly, undefined, dependencyBridges,
          strictPythonEnvironment, pythonSourceRoot, effectivePythonEnvironment,
          dependencyBootstrap, nodeProjectRoot, additionalEnvironment),
      timeoutMs,
    );
  const brokered = await brokeredCommand(
    cwd,
    cmd,
    timeoutMs,
    readOnly,
    undefined,
    dependencyBridges,
    strictPythonEnvironment,
    pythonSourceRoot,
    effectivePythonEnvironment,
    dependencyBootstrap,
    nodeProjectRoot,
    additionalEnvironment,
  );
  if (brokered) return brokered;
  const start = Date.now();
  cwd = await realpath(cwd);
  const { unavailable: pythonUnavailable, readRoots: pythonReadRoots,
    interpreter: pythonInterpreter, ...pythonEnvironment } =
    await pythonSandboxEnvironment(cwd, effectivePythonEnvironment,
      strictPythonEnvironment, pythonSourceRoot);
  // Koda may itself run under a user-managed Node installation (nvm/fnm/asdf).
  // Package-manager shims in that runtime's bin directory resolve into its
  // sibling lib directory, so the complete immutable runtime must be readable
  // even when this workspace did not need dependency bootstrap registration.
  const hostNodeRoot = dirname(dirname(await realpath(process.execPath)));
  const runtimeReadRoots = [...new Set([
    ...pythonReadRoots,
    hostNodeRoot,
    ...(registeredNode ? [registeredNode.root] : []),
    ...(registeredNode?.buildPython ? [registeredNode.buildPython.root] : []),
  ])];
  if (pythonUnavailable && /\b(?:python(?:\d+(?:\.\d+)?)?|pytest|tox)\b/i.test(cmd))
    return {
      command: cmd, exitCode: 1, stdout: "",
      stderr: "The selected external Python environment cannot be safely reused in the verification sandbox",
      unavailable: pythonUnavailable, outcome: "INFRA_FAILURE",
      wallClockMs: Date.now() - start, timedOut: false,
    };
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
    ...pythonEnvironment,
    ...(registeredNode?.buildPython ? {
      PYTHON: registeredNode.buildPython.executable,
      npm_config_python: registeredNode.buildPython.executable,
    } : {}),
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
    COREPACK_ENABLE_NETWORK: dependencyBootstrap ? "1" : "0",
    npm_config_offline: dependencyBootstrap ? "false" : "true",
    npm_config_yes: "false",
    // pnpm 11 otherwise runs an implicit install when a read-only dependency
    // tree was created for the original path rather than this source snapshot.
    pnpm_config_verify_deps_before_run: "false",
    PIP_NO_INDEX: dependencyBootstrap ? "0" : "1",
    UV_OFFLINE: dependencyBootstrap ? "0" : "1",
    POETRY_VIRTUALENVS_IN_PROJECT: "true",
    PIPENV_VENV_IN_PROJECT: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    MYPY_CACHE_DIR: join(scratch, "mypy-cache"),
    GIT_TERMINAL_PROMPT: "0",
    ...additionalEnvironment,
  };
  const pythonBin = join(scratch, "python-bin");
  const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  const usesPython = /\b(?:python(?:\d+(?:\.\d+)?)?|pytest|tox)\b/i.test(cmd);
  const pythonWrapper = pythonInterpreter
    ? `#!/bin/sh\nexec ${shellQuote(pythonInterpreter)} "$@"\n`
    : "";
  const resolvedCommand = pythonInterpreter && usesPython
    ? `mkdir -p ${shellQuote(pythonBin)} && ` +
      `printf %s ${shellQuote(pythonWrapper)} > ${shellQuote(join(pythonBin, "python"))} && ` +
      `chmod 700 ${shellQuote(join(pythonBin, "python"))} && ` +
      `ln -sf python ${shellQuote(join(pythonBin, "python3"))} && ` +
      `PATH=${shellQuote(`${pythonBin}${delimiter}${env.PATH}`)}; export PATH; ${cmd}`
    : cmd;
  let bin: string, args: string[];
  if (process.platform === "darwin") {
    const q = (s: string) => JSON.stringify(s);
    const ancestors: string[] = [];
    for (let p = dirname(cwd); p !== dirname(p); p = dirname(p))
      ancestors.push(`(literal ${q(p)})`);
    const dependencyReads = [...activeBridges.map((bridge) => bridge.sourcePath), ...runtimeReadRoots]
      .map((path) => `(subpath ${q(path)})`)
      .join(" ");
    const dependencyWriteDenials = activeBridges
      .map((bridge) => `(deny file-write* (subpath ${q(bridge.sourcePath)}))`)
      .join("");
    const readable = `(require-any ${ancestors.join(" ")} (literal "/") (subpath "/System") (subpath "/Library") (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/opt") (subpath "/private/etc") (subpath "/private/var/db") (subpath "/dev") (subpath ${q(cwd)}) (subpath ${q(scratch)}) ${dependencyReads})`;
    const writable = `(require-any (literal "/dev/null") (subpath ${q(scratch)}) ${readOnly ? "" : `(subpath ${q(cwd)})`})`;
    const localNetwork = `(require-any (prefix ${q(scratch + "/")}) (local ip "localhost:*"))`;
    const localOutbound = `(require-any (prefix ${q(scratch + "/")}) (remote ip "localhost:*"))`;
    const networkPolicy = dependencyBootstrap ? "" :
      `(deny network-outbound (require-not ${localOutbound}))(deny network-inbound (require-not ${localNetwork}))(deny network-bind (require-not ${localNetwork}))`;
    const profile = `(version 1)(allow default)(deny file-read-data (require-not ${readable}))(deny file-write* (require-not ${writable}))${dependencyWriteDenials}(deny file-write* (subpath ${q(join(cwd, ".git"))}))${networkPolicy}`;
    bin = "/usr/bin/sandbox-exec";
    args = ["-p", profile, "/bin/sh", "-c", resolvedCommand];
  } else if (process.platform === "linux") {
    bin = "bwrap";
    args = [
      "--die-with-parent",
      ...(dependencyBootstrap
        ? ["--unshare-user", "--unshare-ipc", "--unshare-pid", "--unshare-uts", "--unshare-cgroup"]
        : ["--unshare-all"]),
      "--new-session",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      ...linuxTemporaryMountArguments(cwd, scratch, runtimeReadRoots),
    ];
    for (const p of ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/opt"])
      args.push("--ro-bind-try", p, p);
    args.push(readOnly ? "--ro-bind" : "--bind", cwd, cwd);
    // Verification snapshots intentionally omit Git metadata. Bubblewrap
    // treats a missing --ro-bind source as a fatal sandbox setup error, so
    // only add the extra immutable Git mount for real worktrees/checkouts.
    const gitMetadata = join(cwd, ".git");
    try {
      await lstat(gitMetadata);
      args.push("--ro-bind", gitMetadata, gitMetadata);
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
    // Mount children after the workspace parent so the read-only dependency
    // mounts cannot be hidden by the writable workspace bind.
    for (const bridge of activeBridges)
      args.push("--ro-bind", bridge.sourcePath, bridge.targetPath);
    for (const root of runtimeReadRoots) args.push("--ro-bind", root, root);
    args.push("--chdir", cwd, "/bin/sh", "-c", resolvedCommand);
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
        [cwd, scratch, ...runtimeReadRoots],
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

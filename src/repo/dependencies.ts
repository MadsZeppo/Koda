import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { access, cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { arch, homedir, platform } from "node:os";
import { basename, delimiter, dirname, join, posix, relative, resolve } from "node:path";
import { execa } from "execa";
import type { EcosystemProfile } from "./ecosystem.js";
import type { Logger } from "../telemetry/logger.js";

export interface DependencyBridge {
  relativePath: string;
  sourcePath: string;
}

const registered = new Map<string, DependencyBridge[]>();
const registeredPython = new Map<string, string>();
export interface NodeRuntimeEnvironment {
  executable: string;
  binPath: string;
  root: string;
  version: string;
  buildPython?: { executable: string; root: string; version: string };
}
const registeredNode = new Map<string, NodeRuntimeEnvironment>();
const key = async (path: string) => realpath(resolve(path));
const inheritedBridges = () => {
  try {
    const value = JSON.parse(process.env.KODA_SANDBOX_DEPENDENCIES ?? "[]");
    return Array.isArray(value) ? (value as DependencyBridge[]) : [];
  } catch {
    return [];
  }
};

/** Register existing JavaScript dependencies for read-only sandbox mounting.
 * Nothing is copied or linked into the source workspace. */
export async function bridgeDependencies(
  source: string,
  target: string,
  profile?: EcosystemProfile,
) {
  const found: DependencyBridge[] = [];
  for (const unit of profile?.projectUnits ?? [
    { root: ".", ecosystem: "javascript" },
  ]) {
    if (unit.ecosystem !== "javascript") continue;
    const relativePath = posix.join(unit.root, "node_modules");
    const sourcePath = join(source, relativePath);
    try {
      const stat = await lstat(sourcePath);
      const resolved = await realpath(sourcePath);
      const inherited = inheritedBridges().some(
        (bridge) =>
          bridge.relativePath === relativePath &&
          resolve(bridge.sourcePath) === resolved,
      );
      if ((!stat.isDirectory() || stat.isSymbolicLink()) && !inherited)
        throw Error(`${relativePath} must be a real dependency directory`);
      found.push({ relativePath, sourcePath: resolved });
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  registered.set(await key(target), found);
  return found.length > 0;
}

/**
 * Return the dependency mounts registered for a workspace.
 *
 * The workspace backend creates `baseline` and `integration` as sibling
 * directories. Runtime setup registers JavaScript dependency bridges on the
 * integration workspace because that is where candidate verification runs.
 * Final differential verification may later execute the exact same commands
 * against the immutable baseline snapshot. The baseline intentionally omits
 * node_modules, so it must reuse the integration workspace's read-only bridge
 * rather than falling back to a host PATH entry outside the sandbox.
 */
export async function dependenciesForWorkspace(path: string) {
  const workspace = await key(path);
  const known = registered.get(workspace);
  if (known) return known;

  if (basename(workspace) === "baseline") {
    try {
      const integration = await key(join(dirname(workspace), "integration"));
      const sibling = registered.get(integration);
      if (sibling) return sibling;
    } catch {
      // The sibling may not exist yet. Fall through to inherited sandbox
      // bridges instead of treating that as a dependency failure.
    }
  }

  const inherited: DependencyBridge[] = [];
  for (const bridge of inheritedBridges())
    try {
      if (
        (await realpath(join(path, bridge.relativePath))) ===
        (await realpath(bridge.sourcePath))
      )
        inherited.push({
          relativePath: bridge.relativePath,
          sourcePath: await realpath(bridge.sourcePath),
        });
    } catch {}
  return inherited;
}

export async function pythonEnvironmentForWorkspace(path: string) {
  const workspace = await key(path);
  const known = registeredPython.get(workspace);
  if (known) return known;
  if (basename(workspace) === "baseline") {
    try {
      return registeredPython.get(await key(join(dirname(workspace), "integration")));
    } catch {}
  }
  return undefined;
}

export async function nodeEnvironmentForWorkspace(path: string, projectRoot = ".") {
  const workspace = await key(path);
  const location = await realpath(join(workspace, projectRoot)).catch(() =>
    resolve(workspace, projectRoot));
  const lookup = (candidate: string) => [...registeredNode.entries()]
    .filter(([root]) => {
      const suffix = relative(root, candidate);
      return suffix === "" || (suffix !== ".." && !suffix.startsWith("../"));
    })
    .sort(([left], [right]) => right.length - left.length)[0]?.[1];
  const known = lookup(location);
  if (known) return known;
  const components = workspace.split("/");
  const baseline = components.lastIndexOf("baseline");
  if (baseline >= 0) {
    try {
      const sibling = [...components.slice(0, baseline), "integration",
        ...components.slice(baseline + 1)].join("/") || "/";
      return lookup(resolve(sibling, projectRoot));
    } catch {}
  }
  return undefined;
}

/** Propagate one resolved environment to an isolated worker without exposing
 * mutable dependencies inside the worker checkout. */
export async function inheritDependencyEnvironment(source: string, target: string) {
  const sourceKey = await key(source);
  const targetKey = await key(target);
  registered.set(targetKey, [...(registered.get(sourceKey) ?? [])]);
  const python = registeredPython.get(sourceKey);
  if (python) registeredPython.set(targetKey, python);
  for (const [root, node] of [...registeredNode.entries()]) {
    const suffix = relative(sourceKey, root);
    if (suffix === "" || (suffix !== ".." && !suffix.startsWith("../")))
      registeredNode.set(resolve(targetKey, suffix), node);
  }
}

export async function dependencyPathAvailable(root: string, path: string) {
  const normalized = posix.normalize(path);
  for (const bridge of await dependenciesForWorkspace(root)) {
    if (
      normalized !== bridge.relativePath &&
      !normalized.startsWith(bridge.relativePath + "/")
    )
      continue;
    const suffix = relative(bridge.relativePath, normalized);
    if (suffix.startsWith("..")) continue;
    try {
      await access(join(bridge.sourcePath, suffix));
      return true;
    } catch {}
  }
  return false;
}

const dependencyFiles = (profile: EcosystemProfile) => profile.projectUnits.flatMap((unit) => {
  const root = unit.root === "." ? "" : unit.root + "/";
  return ["package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml",
    "yarn.lock", "bun.lock", "bun.lockb", ".yarnrc.yml", ".npmrc", "pyproject.toml",
    "requirements.txt", "requirements-dev.txt", "uv.lock", "poetry.lock", "pdm.lock",
    "Pipfile", "Pipfile.lock", "setup.cfg", "setup.py"].map((file) => root + file);
});
const safeBootstrapCopy = (source: string, path: string) => {
  const rel = relative(source, path).split("\\").join("/");
  if (!rel) return true;
  if (/(?:^|\/)(?:\.git|node_modules|\.venv|venv|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache)(?:\/|$)/.test(rel))
    return false;
  const name = posix.basename(rel).toLowerCase();
  return name !== ".env" && !name.startsWith(".env.") &&
    !/(?:credentials|secrets?)\.(?:json|ya?ml|toml)$/.test(name) &&
    !/\.(?:pem|key|p12|pfx)$/.test(name);
};
const toolVersion = async (tool: string, env: NodeJS.ProcessEnv = process.env) => {
  const result = await execa(tool, ["--version"], { reject: false, timeout: 10000,
    env: { ...env, COREPACK_ENABLE_NETWORK: "0" } }).catch(() => undefined);
  return result?.exitCode === 0 ? result.stdout.trim() : undefined;
};
const major = (version: string | undefined) => Number(version?.match(/\d+/)?.[0]);
const parsedVersion = (value: string) => {
  const match = value.match(/v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] as const : undefined;
};
const compareVersions = (left: readonly number[], right: readonly number[]) => {
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
};
export type RuntimeRequirement = { value: string; source: string };
const authoritativeNodeRequirement = async (root: string): Promise<RuntimeRequirement | undefined> => {
  for (const file of [".nvmrc", ".node-version"]) {
    const value = await readFile(join(root, file), "utf8").catch(() => "");
    if (value.trim()) return { value: value.trim(), source: file };
  }
  const toolVersions = await readFile(join(root, ".tool-versions"), "utf8").catch(() => "");
  const asdfNode = toolVersions.match(/^nodejs\s+([^\s#]+)/m)?.[1];
  if (asdfNode) return { value: asdfNode, source: ".tool-versions:nodejs" };
  const mise = await readFile(join(root, ".mise.toml"), "utf8").catch(() => "");
  const miseNode = mise.match(/^node\s*=\s*["']([^"']+)["']/m)?.[1];
  if (miseNode) return { value: miseNode, source: ".mise.toml:node" };
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8").catch(() => "{}"));
  const developmentRuntime = pkg.devEngines?.runtime;
  const developmentNode = developmentRuntime?.name === "node"
    ? developmentRuntime.version : undefined;
  const value = pkg.volta?.node ?? developmentNode ?? pkg.engines?.node;
  if (typeof value === "string" && value.trim()) return { value: value.trim(),
    source: pkg.volta?.node ? "package.json:volta.node"
      : developmentNode ? "package.json:devEngines.runtime" : "package.json:engines.node" };
  return undefined;
};
const ciNodeRequirement = async (root: string): Promise<RuntimeRequirement | undefined> => {
  const evidence: Array<{ value: string; source: string }> = [];
  const workflowRoot = join(root, ".github", "workflows");
  for (const entry of (await readdir(workflowRoot, { withFileTypes: true }).catch(() => []))
    .filter((candidate) => candidate.isFile() && /\.ya?ml$/i.test(candidate.name))) {
    const content = await readFile(join(workflowRoot, entry.name), "utf8");
    for (const match of content.matchAll(/\bnode-version\s*:\s*["']?v?(\d+(?:\.\d+){0,2})(?:\.x)?/gi))
      evidence.push({ value: match[1]!, source: `.github/workflows/${entry.name}:node-version` });
    for (const match of content.matchAll(/\bnode-version\s*:\s*\[([^\]]+)\]/gi))
      for (const version of match[1]!.match(/\d+(?:\.\d+){0,2}/g) ?? [])
        evidence.push({ value: version, source: `.github/workflows/${entry.name}:node-version` });
  }
  const travis = await readFile(join(root, ".travis.yml"), "utf8").catch(() => "");
  const travisBlock = travis.match(/^node_js\s*:\s*((?:\n[ \t]+-[^\n]*)*)/m)?.[1] ?? "";
  for (const version of travisBlock.match(/\d+(?:\.\d+){0,2}/g) ?? [])
    evidence.push({ value: version, source: ".travis.yml:node_js" });
  const circle = await readFile(join(root, ".circleci", "config.yml"), "utf8").catch(() => "");
  for (const match of circle.matchAll(/(?:cimg\/node|circleci\/node|node)\s*:\s*v?(\d+(?:\.\d+){0,2})/gi))
    evidence.push({ value: match[1]!, source: ".circleci/config.yml:node-image" });
  const dockerfile = await readFile(join(root, "Dockerfile"), "utf8").catch(() => "");
  for (const match of dockerfile.matchAll(/^FROM\s+node:v?(\d+(?:\.\d+){0,2})(?:[-\s]|$)/gim))
    evidence.push({ value: match[1]!, source: "Dockerfile:node-image" });
  return evidence.sort((left, right) =>
    compareVersions(parsedVersion(right.value)!, parsedVersion(left.value)!))[0];
};
const nodeRequirement = async (root: string, repositoryRoot = root) =>
  await authoritativeNodeRequirement(root) ??
  (resolve(root) !== resolve(repositoryRoot)
    ? await authoritativeNodeRequirement(repositoryRoot) ?? await ciNodeRequirement(repositoryRoot)
    : await ciNodeRequirement(root));
const nodeCompatible = (requirement: string, version: string) => {
  const current = parsedVersion(version);
  if (!current) return false;
  return requirement.split("||").some((alternative) => {
    const comparators = [...alternative.matchAll(
      /(?:^|\s)(>=|<=|>|<|\^|~)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-[\w.-]+)?/g,
    )];
    if (!comparators.length) return false;
    return comparators.every((match) => {
      const wanted = [Number(match[2]), Number(match[3] ?? 0), Number(match[4] ?? 0)];
      const comparison = compareVersions(current, wanted);
      switch (match[1]) {
        case ">=": return comparison >= 0;
        case ">": return comparison > 0;
        case "<=": return comparison <= 0;
        case "<": return comparison < 0;
        case "^": return current[0] === wanted[0] && comparison >= 0;
        case "~": return current[0] === wanted[0] && current[1] === wanted[1] && comparison >= 0;
        default:
          return current[0] === wanted[0] &&
            (match[3] === undefined || current[1] === wanted[1]) &&
            (match[4] === undefined || current[2] === wanted[2]);
      }
    });
  });
};
const packageManagerDeclaration = async (root: string) => {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8").catch(() => "{}"));
  return typeof pkg.packageManager === "string" ? pkg.packageManager : undefined;
};
const childDirectories = async (root: string) => (await readdir(root, { withFileTypes: true })
  .catch(() => [])).filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
const pythonExecutables = async (runtimeCache: string, extra: string[] = []) => {
  const candidates = new Set<string>(extra);
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean))
    for (const name of ["python3.10", "python3.9", "python3"])
      candidates.add(join(directory, name));
  for (const path of ["/usr/bin/python3", "/opt/homebrew/bin/python3.10",
    "/usr/local/bin/python3.10"]) candidates.add(path);
  for (const root of [join(homedir(), ".pyenv", "versions"),
    join(process.env.ASDF_DATA_DIR ?? join(homedir(), ".asdf"), "installs", "python"),
    join(homedir(), ".local", "share", "mise", "installs", "python"),
    join(runtimeCache, "python")])
    for (const version of await childDirectories(root))
      for (const name of ["python3.10", "python3.9", "python3"])
        candidates.add(join(version, "bin", name));
  return [...candidates];
};
const resolveBuildPython = async (runtime: NodeRuntimeEnvironment, runtimeCache: string,
  allowProvisioning: boolean, extraCandidates: string[] = []) => {
  const compatible: Array<{ executable: string; root: string; version: string }> = [];
  for (const candidate of await pythonExecutables(runtimeCache, extraCandidates)) {
    try {
      const executable = await realpath(candidate);
      const result = await execa(executable, ["--version"], { reject: false, timeout: 5000 });
      const version = parsedVersion(`${result.stdout} ${result.stderr}`);
      if (result.exitCode !== 0 || !version || version[0] !== 3 || version[1] > 10) continue;
      compatible.push({ executable, root: dirname(dirname(executable)),
        version: version.join(".") });
    } catch {}
  }
  const selected = compatible.sort((left, right) =>
    compareVersions(parsedVersion(right.version)!, parsedVersion(left.version)!))[0];
  if (selected) return { ...runtime, buildPython: selected };
  if (major(runtime.version) > 16) return runtime;
  if (!allowProvisioning)
    throw Error("compatible Python build runtime unavailable for native Node dependencies");
  const installRoot = join(runtimeCache, "python");
  await mkdir(installRoot, { recursive: true });
  const installed = await execa("uv", ["python", "install", "3.10", "--install-dir", installRoot],
    { reject: false, timeout: 120000, env: { ...process.env, UV_PYTHON_INSTALL_DIR: installRoot } })
    .catch(() => undefined);
  if (!installed || installed.exitCode !== 0)
    throw Error(`compatible Python build runtime unavailable: ${installed?.stderr ?? "uv unavailable"}`);
  return resolveBuildPython(runtime, runtimeCache, false, extraCandidates);
};
const installedNodeCandidates = async (extra: string[] = [], runtimeCache?: string) => {
  const candidates = new Set<string>([process.execPath, ...extra]);
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean))
    candidates.add(join(directory, "node"));
  for (const path of ["/usr/bin/node", "/usr/local/bin/node", "/opt/homebrew/bin/node",
    join(process.env.VOLTA_HOME ?? join(homedir(), ".volta"), "bin", "node")])
    candidates.add(path);

  const versionedRoots = [
    join(process.env.NVM_DIR ?? join(homedir(), ".nvm"), "versions", "node"),
    join(process.env.ASDF_DATA_DIR ?? join(homedir(), ".asdf"), "installs", "nodejs"),
    join(homedir(), ".nodenv", "versions"),
    join(homedir(), ".local", "share", "mise", "installs", "node"),
  ];
  for (const root of versionedRoots)
    for (const version of await childDirectories(root)) candidates.add(join(version, "bin", "node"));

  const fnmRoot = join(process.env.FNM_DIR ?? join(homedir(), ".local", "share", "fnm"),
    "node-versions");
  for (const version of await childDirectories(fnmRoot))
    candidates.add(join(version, "installation", "bin", "node"));
  for (const root of ["/opt/homebrew/opt", "/usr/local/opt"])
    for (const formula of await childDirectories(root))
      if (/^node(?:@\d+)?$/.test(basename(formula))) candidates.add(join(formula, "bin", "node"));
  if (runtimeCache)
    for (const version of await childDirectories(join(runtimeCache, "node")))
      candidates.add(join(version, "bin", "node"));
  return [...candidates];
};
const nodeResolutionCache = new Map<string, Promise<NodeRuntimeEnvironment | undefined>>();
const bootstrapInfrastructureError = (error: unknown) => {
  const reason = error instanceof Error ? error.message : String(error);
  return Error(reason.startsWith("compatible Node runtime unavailable")
    ? `INFRA_FAILURE: ${reason}`
    : `INFRA_FAILURE: dependency bootstrap failed: ${reason}`);
};
const provisionNodeRuntime = async (requirement: RuntimeRequirement, runtimeCache: string) => {
  const system = platform() === "darwin" ? "darwin" : platform() === "linux" ? "linux" : undefined;
  const cpu = arch() === "arm64" ? "arm64" : arch() === "x64" ? "x64" : undefined;
  if (!system || !cpu) throw Error(`Node runtime provisioning unsupported on ${platform()}-${arch()}`);
  const request = async (url: string) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw Error(`Node runtime download failed: HTTP ${response.status}`);
    return response;
  };
  const releases = await (await request("https://nodejs.org/dist/index.json")).json() as
    Array<{ version?: string; files?: string[] }>;
  const releaseFile = system === "darwin" ? `osx-${cpu}-tar` : `${system}-${cpu}`;
  const release = releases.filter((candidate) => candidate.version &&
      nodeCompatible(requirement.value, candidate.version) &&
      candidate.files?.includes(releaseFile))
    .sort((left, right) => compareVersions(parsedVersion(right.version!)!,
      parsedVersion(left.version!)!))[0];
  if (!release?.version)
    throw Error(`compatible Node runtime unavailable: required ${requirement.value} (${requirement.source})`);
  const version = release.version.replace(/^v/, "");
  const destination = join(runtimeCache, "node", `${version}-${system}-${cpu}`);
  const executable = join(destination, "bin", "node");
  if (await access(executable).then(() => true).catch(() => false))
    return { executable: await realpath(executable), binPath: await realpath(join(destination, "bin")),
      root: await realpath(destination), version };
  const temporary = destination + "." + randomUUID();
  await mkdir(temporary, { recursive: true });
  try {
    const archiveName = `node-v${version}-${system}-${cpu}.tar.gz`;
    const base = `https://nodejs.org/dist/v${version}`;
    const [archive, sums] = await Promise.all([
      request(`${base}/${archiveName}`).then((response) => response.arrayBuffer()),
      request(`${base}/SHASUMS256.txt`).then((response) => response.text()),
    ]);
    const expected = sums.split(/\r?\n/).find((line) => line.endsWith(`  ${archiveName}`))?.split(/\s+/)[0];
    const content = Buffer.from(archive);
    const actual = createHash("sha256").update(content).digest("hex");
    if (!expected || expected !== actual) throw Error("Node runtime download checksum mismatch");
    const archivePath = join(temporary, archiveName);
    await writeFile(archivePath, content);
    const extracted = join(temporary, "runtime");
    await mkdir(extracted);
    const unpack = await execa("tar", ["-xzf", archivePath, "--strip-components=1", "-C", extracted],
      { reject: false, timeout: 60000 });
    if (unpack.exitCode !== 0) throw Error(`Node runtime extraction failed: ${unpack.stderr}`);
    await mkdir(dirname(destination), { recursive: true });
    await rename(extracted, destination).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
    });
    const resolved = await realpath(executable);
    return { executable: resolved, binPath: dirname(resolved),
      root: await realpath(destination), version };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
};
type NodeRuntimeResolverOptions = {
  extraCandidates?: string[];
  runtimeCache: string;
  allowProvisioning: boolean;
  provisioner?: (requirement: RuntimeRequirement, runtimeCache: string) =>
    Promise<NodeRuntimeEnvironment | undefined>;
};
const resolveNodeRuntime = async (requirement: RuntimeRequirement | undefined,
  options: NodeRuntimeResolverOptions) => {
  const cacheKey = JSON.stringify([requirement?.value ?? "*", process.env.PATH ?? "",
    process.env.NVM_DIR, process.env.FNM_DIR, process.env.ASDF_DATA_DIR,
    process.env.VOLTA_HOME, options.extraCandidates, options.runtimeCache,
    options.allowProvisioning, !!options.provisioner]);
  let resolution = nodeResolutionCache.get(cacheKey);
  if (!resolution) {
    resolution = (async () => {
      const found = new Map<string, NodeRuntimeEnvironment>();
      for (const candidate of await installedNodeCandidates(options.extraCandidates,
        options.runtimeCache)) {
        try {
          const executable = await realpath(candidate);
          if (found.has(executable)) continue;
          const result = await execa(executable, ["--version"], { reject: false, timeout: 5000,
            env: { ...process.env, PATH: `${dirname(executable)}${delimiter}${process.env.PATH ?? ""}` } });
          if (result.exitCode !== 0 || !parsedVersion(result.stdout)) continue;
          const version = result.stdout.trim().replace(/^v/, "");
          if (requirement && !nodeCompatible(requirement.value, version)) continue;
          found.set(executable, { executable, binPath: dirname(executable),
            root: dirname(dirname(executable)), version });
        } catch {}
      }
      const runtimes = [...found.values()];
      if (!requirement) {
        const current = await realpath(process.execPath).catch(() => process.execPath);
        const currentRuntime = runtimes.find((runtime) => runtime.executable === current);
        if (currentRuntime) return currentRuntime;
      }
      const installed = runtimes.sort((left, right) =>
        compareVersions(parsedVersion(right.version)!, parsedVersion(left.version)!))[0];
      if (installed || !requirement || !options.allowProvisioning) return installed;
      return (options.provisioner ?? provisionNodeRuntime)(requirement, options.runtimeCache);
    })();
    nodeResolutionCache.set(cacheKey, resolution);
  }
  return resolution;
};
type VersionResolver = (tool: string) => Promise<string | undefined>;
const javascriptInstall = async (root: string, manager: string, versionFor: VersionResolver,
  runtime: NodeRuntimeEnvironment) => {
  const declaration = await packageManagerDeclaration(root);
  const declaredVersion = declaration?.match(new RegExp(`^${manager}@(\\d+)`))?.[1];
  let installed = await versionFor(manager);
  let executable = manager;
  if (!installed && ["pnpm", "yarn"].includes(manager) && declaredVersion &&
      await versionFor("corepack")) {
    installed = declaration!.slice(manager.length + 1);
    executable = `corepack ${manager}`;
  }
  if (!installed) throw Error(`package_manager_unavailable: ${manager}`);
  if (declaredVersion && major(installed) !== Number(declaredVersion))
    throw Error(`package_manager_version_unavailable: requires ${declaration}, found ${manager}@${installed}`);
  if (manager === "npm") {
    const locked = await access(join(root, "package-lock.json")).then(() => true).catch(() =>
      access(join(root, "npm-shrinkwrap.json")).then(() => true).catch(() => false));
    return { command: locked ? "npm ci --no-audit --no-fund" : "npm install --no-audit --no-fund",
      runtime: `node@${runtime.version}`, manager: `npm@${installed}` };
  }
  if (manager === "pnpm") return { command: `${executable} install --frozen-lockfile`,
    runtime: `node@${runtime.version}`, manager: `pnpm@${installed}` };
  if (manager === "yarn") {
    const berry = major(declaredVersion ?? installed) >= 2 ||
      await access(join(root, ".yarnrc.yml")).then(() => true).catch(() => false);
    return { command: berry ? `${executable} install --immutable` : `${executable} install --frozen-lockfile`,
      runtime: `node@${runtime.version}`, manager: `yarn@${installed}` };
  }
  if (manager === "bun") return { command: "bun install --frozen-lockfile",
    runtime: `bun@${installed}`, manager: `bun@${installed}` };
  throw Error(`package_manager_unsupported: ${manager}`);
};
const pythonInstall = async (root: string, manager: string, versionFor: VersionResolver) => {
  if (manager === "uv") {
    const version = await versionFor("uv");
    if (!version) throw Error("package_manager_unavailable: uv");
    return { command: "uv sync --frozen --no-install-project", runtime: `python@${await versionFor("python3")}`,
      manager: `uv@${version}`, environment: ".venv" };
  }
  if (manager === "poetry") {
    const version = await versionFor("poetry");
    if (!version) throw Error("package_manager_unavailable: poetry");
    return { command: "poetry install --sync --no-interaction --no-root",
      runtime: `python@${await versionFor("python3")}`, manager: `poetry@${version}`, environment: ".venv" };
  }
  if (manager === "pdm") {
    const version = await versionFor("pdm");
    if (!version) throw Error("package_manager_unavailable: pdm");
    return { command: "pdm sync --frozen-lockfile --no-self",
      runtime: `python@${await versionFor("python3")}`, manager: `pdm@${version}`, environment: ".venv" };
  }
  if (manager === "pipenv") {
    const version = await versionFor("pipenv");
    if (!version) throw Error("package_manager_unavailable: pipenv");
    return { command: "pipenv sync --dev", runtime: `python@${await versionFor("python3")}`,
      manager: `pipenv@${version}`, environment: ".venv" };
  }
  const requirements = ["requirements.txt", "requirements-dev.txt"].filter((file) =>
    existsSync(join(root, file)));
  const python = await versionFor("python3");
  if (!python) throw Error("python_runtime_unavailable");
  if (!requirements.length) throw Error("python_locked_dependencies_unavailable");
  return { command: "python3 -m venv .venv && .venv/bin/python -m pip install " +
      requirements.map((file) => `--requirement '${file}'`).join(" "),
    runtime: `python@${python}`, manager: "pip", environment: ".venv" };
};

export interface DependencyBootstrapOptions {
  timeoutMs?: number;
  cacheBase?: string;
  toolVersions?: Record<string, string>;
  /** Additional concrete Node executables to inspect. Primarily useful for
   * embedders with runtimes outside the standard manager locations. */
  nodeRuntimeCandidates?: string[];
  buildPythonCandidates?: string[];
  runtimeCacheBase?: string;
  allowRuntimeProvisioning?: boolean;
  nodeRuntimeProvisioner?: (requirement: RuntimeRequirement, runtimeCache: string) =>
    Promise<NodeRuntimeEnvironment | undefined>;
  runner?: (cwd: string, command: string, timeoutMs: number, env: NodeJS.ProcessEnv) => Promise<{
    exitCode: number; stdout: string; stderr: string;
  }>;
}

export async function bootstrapDependencies(
  source: string,
  target: string,
  profile: EcosystemProfile,
  logger: Logger,
  options: DependencyBootstrapOptions = {},
) {
  const timeoutMs = options.timeoutMs ?? 300000;
  const runtimeCache = resolve(options.runtimeCacheBase ?? process.env.KODA_RUNTIME_CACHE ??
    join(homedir(), ".koda", "runtimes"));
  const nodeResolverOptions: NodeRuntimeResolverOptions = {
    extraCandidates: options.nodeRuntimeCandidates,
    runtimeCache,
    allowProvisioning: options.allowRuntimeProvisioning ?? true,
    provisioner: options.nodeRuntimeProvisioner,
  };
  const versionFor: VersionResolver = async (tool) =>
    options.toolVersions?.[tool] ?? toolVersion(tool);
  const missing = profile.projectUnits.filter((unit) => unit.verification.some((candidate) =>
    candidate.requiresInstalledDependencies && !candidate.available &&
    candidate.reason === "dependencies_not_available"));
  if (!missing.length) {
    for (const unit of profile.projectUnits.filter((candidate) =>
      candidate.ecosystem === "javascript" && candidate.verification.some((check) =>
        check.requiresInstalledDependencies))) {
      const requirement = await nodeRequirement(join(source, unit.root), source);
      const runtime = await resolveNodeRuntime(requirement, nodeResolverOptions);
      if (!runtime) {
        const reason = `compatible Node runtime unavailable${requirement
          ? `: required ${requirement.value} (${requirement.source})` : ""}`;
        logger.log("dependency_bootstrap_failed", { classification: "INFRA_FAILURE", reason });
        throw Error(`INFRA_FAILURE: ${reason}`);
      }
      registeredNode.set(await key(join(target, unit.root)), runtime);
    }
    logger.log("dependency_environment_reused", { reason: "verification_dependencies_ready" });
    return false;
  }
  const roots: typeof missing = [];
  for (const [index, unit] of missing.entries()) {
    if (missing.findIndex((candidate) => candidate.root === unit.root &&
        candidate.ecosystem === unit.ecosystem) !== index) continue;
    const parentOwnsInstall = unit.root !== "." && missing.some((candidate) =>
      candidate.root === "." && candidate.ecosystem === unit.ecosystem);
    const lockfiles = unit.ecosystem === "javascript"
      ? ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"]
      : ["uv.lock", "poetry.lock", "pdm.lock", "Pipfile.lock"];
    const ownsLockedEnvironment = (await Promise.all(lockfiles.map((file) =>
      access(join(source, unit.root, file)).then(() => true).catch(() => false)))).some(Boolean);
    const hasRequiredCheck = unit.verification.some((candidate) =>
      candidate.requiresInstalledDependencies && !candidate.available &&
      candidate.reason === "dependencies_not_available" && candidate.requirement === "required");
    if (!parentOwnsInstall || (ownsLockedEnvironment && hasRequiredCheck)) roots.push(unit);
  }
  const plans: Array<{ root: string; ecosystem: string; command: string; runtime: string;
    manager: string; environment?: string; nodeRuntime?: NodeRuntimeEnvironment }> = [];
  try {
    for (const unit of roots) {
      const unitRoot = join(source, unit.root);
      if (unit.ecosystem === "javascript") {
        const requirement = await nodeRequirement(unitRoot, source);
        const resolvedNodeRuntime = await resolveNodeRuntime(requirement, nodeResolverOptions);
        if (!resolvedNodeRuntime)
          throw Error(`compatible Node runtime unavailable${requirement
            ? `: required ${requirement.value} (${requirement.source})` : ""}`);
        const nodeRuntime = await resolveBuildPython(resolvedNodeRuntime, runtimeCache,
          options.allowRuntimeProvisioning ?? true, options.buildPythonCandidates);
        const runtimeEnvironment = { ...process.env,
          PATH: `${nodeRuntime.binPath}${delimiter}${process.env.PATH ?? ""}`,
          ...(nodeRuntime.buildPython ? { PYTHON: nodeRuntime.buildPython.executable,
            npm_config_python: nodeRuntime.buildPython.executable } : {}),
        };
        const runtimeVersionFor: VersionResolver = async (tool) =>
          options.toolVersions?.[tool] ?? (tool === "node" ? nodeRuntime.version
            : toolVersion(tool, runtimeEnvironment));
        plans.push({ root: unit.root, ecosystem: unit.ecosystem,
          ...await javascriptInstall(unitRoot, unit.packageManager?.name ?? "", runtimeVersionFor,
            nodeRuntime), nodeRuntime });
      } else if (unit.ecosystem === "python") {
        plans.push({ root: unit.root, ecosystem: unit.ecosystem,
          ...await pythonInstall(unitRoot, unit.environmentManager?.name ?? "pip", versionFor) });
      }
    }
  } catch (error) {
    logger.log("dependency_bootstrap_failed", { classification: "INFRA_FAILURE",
      reason: String(error) });
    throw bootstrapInfrastructureError(error);
  }
  if (!plans.length) return false;
  const hash = createHash("sha256");
  hash.update(JSON.stringify(plans));
  for (const file of [...new Set(dependencyFiles(profile))].sort()) {
    const content = await readFile(join(source, file)).catch(() => undefined);
    if (content) hash.update(file).update(content);
  }
  const cacheBase = resolve(options.cacheBase ?? process.env.KODA_DEPENDENCY_CACHE ??
    join(homedir(), ".koda", "dependencies"));
  const cache = join(cacheBase, hash.digest("hex"));
  const marker = join(cache, ".koda-bootstrap.json");
  logger.log("dependency_environment_detected", { environments: plans.map((plan) => ({
    ecosystem: plan.ecosystem, packageManager: plan.manager, runtime: plan.runtime,
    root: plan.root, readiness: "missing", command: plan.command,
  })) });
  let reused = await access(marker).then(() => true).catch(() => false);
  if (!reused) {
    const temporary = cache + "." + randomUUID();
    await mkdir(cacheBase, { recursive: true });
    try {
      await cp(source, temporary, { recursive: true, verbatimSymlinks: true,
        filter: (path) => safeBootstrapCopy(source, path) });
      const beforeLocks = new Map<string, Buffer>();
      for (const file of [...new Set(dependencyFiles(profile))]) {
        const content = await readFile(join(temporary, file)).catch(() => undefined);
        if (content && /(?:lock|shrinkwrap)/i.test(posix.basename(file))) beforeLocks.set(file, content);
      }
      const execute = options.runner ?? (async (cwd: string, bootstrapCommand: string, limit: number,
        environment: NodeJS.ProcessEnv) => {
        const { command } = await import("./commands.js");
        return command(cwd, bootstrapCommand, limit, false, undefined, [], false,
          undefined, environment, true);
      });
      for (const plan of plans) {
        const started = Date.now();
        logger.log("dependency_bootstrap_start", { ecosystem: plan.ecosystem,
          packageManager: plan.manager, runtime: plan.runtime, root: plan.root,
          command: plan.command });
        const planCwd = join(temporary, plan.root);
        if (plan.nodeRuntime) registeredNode.set(await key(planCwd), plan.nodeRuntime);
        const runtimeEnvironment = plan.nodeRuntime
          ? { ...process.env, PATH: `${plan.nodeRuntime.binPath}${delimiter}${process.env.PATH ?? ""}`,
              ...(plan.nodeRuntime.buildPython ? {
                PYTHON: plan.nodeRuntime.buildPython.executable,
                npm_config_python: plan.nodeRuntime.buildPython.executable,
              } : {}) }
          : process.env;
        const result = await execute(planCwd, plan.command, timeoutMs, runtimeEnvironment);
        if (result.exitCode !== 0)
          throw Error(`dependency_bootstrap_command_failed: ${result.stderr || result.stdout}`);
        logger.log("dependency_bootstrap_complete", { ecosystem: plan.ecosystem,
          packageManager: plan.manager, root: plan.root, command: plan.command,
          durationMs: Date.now() - started, reused: false });
      }
      for (const [file, before] of beforeLocks) {
        const after = await readFile(join(temporary, file));
        if (!before.equals(after)) throw Error(`dependency_bootstrap_modified_lockfile: ${file}`);
      }
      await writeFile(join(temporary, ".koda-bootstrap.json"), JSON.stringify({ plans }));
      await rename(temporary, cache).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
        await rm(temporary, { recursive: true, force: true });
      });
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      logger.log("dependency_bootstrap_failed", { classification: "INFRA_FAILURE",
        reason: String(error) });
      throw bootstrapInfrastructureError(error);
    }
  }
  await bridgeDependencies(cache, target, profile);
  for (const plan of plans)
    if (plan.nodeRuntime) registeredNode.set(await key(join(target, plan.root)), plan.nodeRuntime);
  const python = plans.find((plan) => plan.environment);
  if (python) {
    const environment = join(cache, python.root, python.environment!);
    await access(environment);
    registeredPython.set(await key(target), await realpath(environment));
  }
  if (reused) logger.log("dependency_environment_reused", { cache,
    environments: plans.map((plan) => ({ ecosystem: plan.ecosystem,
      packageManager: plan.manager, runtime: plan.runtime, root: plan.root })) });
  return true;
}

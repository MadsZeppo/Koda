import assert from "node:assert/strict";
import test from "node:test";
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Logger } from "../src/telemetry/logger.js";
import { execa } from "execa";
import { profileRepo } from "../src/repo/profiler.js";
import {
  bootstrapDependencies,
  bridgeDependencies,
  inheritDependencyEnvironment,
  nodeEnvironmentForWorkspace,
  pythonEnvironmentForWorkspace,
} from "../src/repo/dependencies.js";
import { command } from "../src/repo/commands.js";
import { verify } from "../src/verifier/verifier.js";

const createJavaScriptRepo = async (
  root: string,
  manager: "npm" | "pnpm" | "yarn" = "npm",
  yarnBerry = false,
) => {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({
    ...(manager === "npm" ? {} : { packageManager: `${manager}@${manager === "pnpm" ? "11.7.0" : yarnBerry ? "3.8.7" : "1.22.22"}` }),
    scripts: { test: "fixture-test" },
    devDependencies: { "fixture-test": "1.0.0" },
  }));
  const lock = manager === "npm" ? "package-lock.json"
    : manager === "pnpm" ? "pnpm-lock.yaml" : "yarn.lock";
  await writeFile(join(root, lock), manager === "npm"
    ? JSON.stringify({ name: "fixture", lockfileVersion: 3, packages: {} })
    : `${manager} deterministic lock\n`);
  if (yarnBerry) await writeFile(join(root, ".yarnrc.yml"), "nodeLinker: node-modules\n");
  return lock;
};

const fakeInstall = (commands: string[], mutateLock?: string) =>
  async (cwd: string, command: string) => {
    commands.push(command);
    await mkdir(join(cwd, "node_modules", ".bin"), { recursive: true });
    await writeFile(join(cwd, "node_modules", ".bin", "fixture-test"),
      "#!/bin/sh\necho BOOTSTRAPPED_TEST_RAN\n");
    await chmod(join(cwd, "node_modules", ".bin", "fixture-test"), 0o755);
    if (mutateLock) await writeFile(join(cwd, mutateLock), "unexpected rewrite\n");
    return { exitCode: 0, stdout: "installed", stderr: "" };
  };

const fakeNodeRuntime = async (path: string, version: string, probe?: string) => {
  await mkdir(join(path, "bin"), { recursive: true });
  await writeFile(join(path, "bin", "node"), "#!/bin/sh\n" +
    (probe ? `echo probe >> '${probe}'\n` : "") + `echo v${version}\n`);
  await chmod(join(path, "bin", "node"), 0o755);
  return join(path, "bin", "node");
};
const fakePythonRuntime = async (path: string, version = "3.10.99") => {
  await mkdir(join(path, "bin"), { recursive: true });
  await writeFile(join(path, "bin", "python3"), `#!/bin/sh\necho Python ${version}\n`);
  await chmod(join(path, "bin", "python3"), 0o755);
  return join(path, "bin", "python3");
};

const fixture = async (manager: "npm" | "pnpm" | "yarn" = "npm", yarnBerry = false) => {
  const root = await mkdtemp(join(tmpdir(), "koda-bootstrap-"));
  const source = join(root, "source");
  const target = join(root, "integration");
  const cache = join(root, "cache");
  await createJavaScriptRepo(source, manager, yarnBerry);
  await cp(source, target, { recursive: true });
  const logger = new Logger(join(root, "logs"), "bootstrap", true);
  const versions = { node: "22.14.0", npm: "10.9.0", pnpm: "11.7.0", yarn: yarnBerry ? "3.8.7" : "1.22.22" };
  return { root, source, target, cache, logger, versions,
    close: () => rm(root, { recursive: true, force: true }) };
};

test("fresh npm dependencies bootstrap deterministically and verification executes", async () => {
  const f = await fixture("npm");
  const commands: string[] = [];
  try {
    const before = await profileRepo(f.target);
    assert.ok(before.ecosystem?.projectUnits[0]?.verification.some((check) =>
      check.reason === "dependencies_not_available"));
    await bootstrapDependencies(f.source, f.target, before.ecosystem!, f.logger, {
      cacheBase: f.cache, toolVersions: f.versions, runner: fakeInstall(commands),
    });
    assert.deepEqual(commands, ["npm ci --no-audit --no-fund"]);
    const after = await profileRepo(f.target);
    const candidate = after.ecosystem!.projectUnits[0]!.verification.find((check) =>
      check.command === "npm run test");
    assert.equal(candidate?.available, true);
    const result = await verify(f.target, ["npm run test"], 15000, undefined,
      undefined, [candidate!]);
    assert.equal(result.status, "VERIFIED_SUCCESS", JSON.stringify(result.checks));
    assert.match(result.checks[0]!.stdout, /BOOTSTRAPPED_TEST_RAN/);
    assert.ok(f.logger.events.some((event) => event.type === "dependency_bootstrap_complete"));
  } finally { await f.close(); }
});

test("the production bootstrap sandbox can run npm ci for a fresh local-lock repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-real-npm-bootstrap-"));
  const source = join(root, "source"), integration = join(root, "integration");
  const logger = new Logger(join(root, "logs"), "real-bootstrap", true);
  try {
    await mkdir(join(source, "packages", "fixture-test"), { recursive: true });
    await writeFile(join(source, "packages", "fixture-test", "package.json"), JSON.stringify({
      name: "fixture-test", version: "1.0.0", bin: { "fixture-test": "test.js" },
    }));
    await writeFile(join(source, "packages", "fixture-test", "test.js"),
      "#!/usr/bin/env node\nconsole.log('REAL_NPM_BOOTSTRAP_OK')\n");
    await execa("npm", ["pack", "./packages/fixture-test", "--pack-destination", "."],
      { cwd: source });
    await writeFile(join(source, "package.json"), JSON.stringify({
      scripts: { test: "fixture-test" },
      devDependencies: { "fixture-test": "file:fixture-test-1.0.0.tgz" },
    }));
    await execa("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: source });
    await rm(join(source, "node_modules"), { recursive: true, force: true });
    await cp(source, integration, { recursive: true });
    const profile = await profileRepo(integration);
    await bootstrapDependencies(source, integration, profile.ecosystem!, logger, {
      cacheBase: join(root, "cache"), timeoutMs: 30000,
    });
    const ready = await profileRepo(integration);
    const candidate = ready.ecosystem!.projectUnits[0]!.verification.find((check) =>
      check.command === "npm run test")!;
    assert.equal(candidate.available, true);
    const result = await verify(integration, [candidate.command], 15000, undefined,
      undefined, [candidate]);
    assert.equal(result.status, "VERIFIED_SUCCESS", JSON.stringify(result.checks));
    assert.match(result.checks[0]!.stdout, /REAL_NPM_BOOTSTRAP_OK/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an existing usable dependency tree is reused without installation", async () => {
  const f = await fixture("npm");
  let installs = 0;
  try {
    await mkdir(join(f.source, "node_modules", ".bin"), { recursive: true });
    await writeFile(join(f.source, "node_modules", ".bin", "fixture-test"), "#!/bin/sh\nexit 0\n");
    await chmod(join(f.source, "node_modules", ".bin", "fixture-test"), 0o755);
    await bridgeDependencies(f.source, f.target, (await profileRepo(f.target)).ecosystem);
    const ready = await profileRepo(f.target);
    const changed = await bootstrapDependencies(f.source, f.target, ready.ecosystem!, f.logger, {
      cacheBase: f.cache, toolVersions: f.versions,
      runner: async () => { installs++; return { exitCode: 0, stdout: "", stderr: "" }; },
    });
    assert.equal(changed, false);
    assert.equal(installs, 0);
    assert.ok(f.logger.events.some((event) => event.type === "dependency_environment_reused"));
  } finally { await f.close(); }
});

test("pnpm and both Yarn generations use their deterministic install modes", async () => {
  for (const [manager, berry, expected] of [
    ["pnpm", false, "pnpm install --frozen-lockfile"],
    ["yarn", false, "yarn install --frozen-lockfile"],
    ["yarn", true, "yarn install --immutable"],
  ] as const) {
    const f = await fixture(manager, berry);
    const commands: string[] = [];
    try {
      const profile = await profileRepo(f.target);
      await bootstrapDependencies(f.source, f.target, profile.ecosystem!, f.logger, {
        cacheBase: f.cache, toolVersions: f.versions, runner: fakeInstall(commands),
      });
      assert.deepEqual(commands, [expected]);
      assert.equal(commands.some((command) => command.startsWith("npm ")), false);
    } finally { await f.close(); }
  }
});

test("bootstrapped dependencies propagate to worker and isolated verification", async () => {
  const f = await fixture("npm");
  const worker = join(f.root, "worker");
  try {
    const profile = await profileRepo(f.target);
    await bootstrapDependencies(f.source, f.target, profile.ecosystem!, f.logger, {
      cacheBase: f.cache, toolVersions: f.versions, runner: fakeInstall([]),
    });
    await cp(f.target, worker, { recursive: true });
    await inheritDependencyEnvironment(f.target, worker);
    const workerProfile = await profileRepo(worker);
    const candidate = workerProfile.ecosystem!.projectUnits[0]!.verification.find((check) =>
      check.command === "npm run test")!;
    assert.equal(candidate.available, true);
    assert.equal((await verify(worker, [candidate.command], 15000, undefined,
      undefined, [candidate])).status, "VERIFIED_SUCCESS");
  } finally { await f.close(); }
});

test("bootstrap failures are infrastructure failures and never claim verification", async () => {
  const f = await fixture("npm");
  try {
    const profile = await profileRepo(f.target);
    await assert.rejects(bootstrapDependencies(f.source, f.target, profile.ecosystem!, f.logger, {
      cacheBase: f.cache, toolVersions: f.versions,
      allowRuntimeProvisioning: false,
      runner: async () => ({ exitCode: 1, stdout: "", stderr: "registry unreachable" }),
    }), /INFRA_FAILURE.*registry unreachable/);
    assert.ok(f.logger.events.some((event) => event.type === "dependency_bootstrap_failed" &&
      event.classification === "INFRA_FAILURE"));
    assert.equal(f.logger.events.some((event) => event.type === "model_attempt"), false);
  } finally { await f.close(); }
});

test("bootstrap enforces repository Node runtime evidence before installation", async () => {
  const f = await fixture("npm");
  let installs = 0;
  try {
    await writeFile(join(f.source, ".nvmrc"), "98.21.3\n");
    await writeFile(join(f.target, ".nvmrc"), "98.21.3\n");
    const profile = await profileRepo(f.target);
    await assert.rejects(bootstrapDependencies(f.source, f.target, profile.ecosystem!, f.logger, {
      cacheBase: f.cache, toolVersions: f.versions,
      allowRuntimeProvisioning: false,
      runner: async () => { installs++; return { exitCode: 0, stdout: "", stderr: "" }; },
    }), /INFRA_FAILURE.*compatible Node runtime unavailable.*98\.21\.3/);
    assert.equal(installs, 0);
  } finally { await f.close(); }
});

test("old repositories select an installed Node 14 runtime instead of Koda's newer runtime", async () => {
  const f = await fixture("npm");
  try {
    await mkdir(join(f.source, ".github", "workflows"), { recursive: true });
    await writeFile(join(f.source, ".github", "workflows", "ci.yml"),
      "jobs:\n  test:\n    strategy:\n      matrix:\n        os: [ubuntu-latest, macos-latest]\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: '14.x'\n");
    const kodaNode = await fakeNodeRuntime(join(f.root, "koda-node-26"), "26.0.0");
    const oldNode = await fakeNodeRuntime(join(f.root, "homebrew", "opt", "node@14"), "14.21.99");
    let bootstrapPath = "";
    const profile = await profileRepo(f.target);
    await bootstrapDependencies(f.source, f.target, profile.ecosystem!, f.logger, {
      cacheBase: f.cache, toolVersions: { npm: "10.9.0" },
      nodeRuntimeCandidates: [kodaNode, oldNode],
      runner: async (cwd, bootstrapCommand, _timeout, env) => {
        bootstrapPath = env.PATH ?? "";
        return fakeInstall([])(cwd, bootstrapCommand);
      },
    });
    const selected = await nodeEnvironmentForWorkspace(f.target);
    assert.equal(selected?.version, "14.21.99");
    assert.equal(selected?.executable, await realpath(oldNode));
    assert.equal(bootstrapPath.split(":")[0], await realpath(join(f.root, "homebrew", "opt", "node@14", "bin")));
  } finally { await f.close(); }
});

test("a compatible runtime installed under an nvm tree is reused automatically", async () => {
  const f = await fixture("npm");
  try {
    await writeFile(join(f.source, ".nvmrc"), "14.21.3\n");
    const node = await fakeNodeRuntime(join(f.root, ".nvm", "versions", "node", "v14.21.3"),
      "14.21.3");
    const python = await fakePythonRuntime(join(f.root, "python-3.10"));
    let buildPython = "";
    await bootstrapDependencies(f.source, f.target, (await profileRepo(f.target)).ecosystem!, f.logger, {
      cacheBase: f.cache, runtimeCacheBase: join(f.root, "runtimes"),
      toolVersions: { npm: "6.14.18" }, nodeRuntimeCandidates: [node],
      buildPythonCandidates: [python],
      runner: async (cwd, command, _timeout, env) => {
        buildPython = env.npm_config_python ?? "";
        return fakeInstall([])(cwd, command);
      },
    });
    assert.equal((await nodeEnvironmentForWorkspace(f.target))?.executable, await realpath(node));
    assert.equal(buildPython, await realpath(python));
  } finally { await f.close(); }
});

test("a missing compatible Node runtime is provisioned once into Koda's runtime cache", async () => {
  const f = await fixture("npm");
  let provisions = 0;
  try {
    await writeFile(join(f.source, ".node-version"), "12.22.91\n");
    const runtimeCache = join(f.root, "runtime-cache");
    const provisioner = async () => {
      provisions++;
      const executable = await fakeNodeRuntime(join(runtimeCache, "node", "12.22.91-test"),
        "12.22.91");
      const resolved = await realpath(executable);
      return { executable: resolved, binPath: join(dirname(resolved)),
        root: await realpath(join(runtimeCache, "node", "12.22.91-test")), version: "12.22.91" };
    };
    await bootstrapDependencies(f.source, f.target, (await profileRepo(f.target)).ecosystem!, f.logger, {
      cacheBase: f.cache, runtimeCacheBase: runtimeCache, toolVersions: { npm: "6.14.18" },
      nodeRuntimeProvisioner: provisioner, runner: fakeInstall([]),
    });
    const second = join(f.root, "second-provisioned");
    await cp(f.source, second, { recursive: true });
    await bootstrapDependencies(f.source, second, (await profileRepo(second)).ecosystem!, f.logger, {
      cacheBase: f.cache, runtimeCacheBase: runtimeCache, toolVersions: { npm: "6.14.18" },
      nodeRuntimeProvisioner: provisioner,
      runner: async () => { throw Error("dependency and runtime caches should be reused"); },
    });
    assert.equal(provisions, 1);
    assert.equal((await nodeEnvironmentForWorkspace(second))?.version, "12.22.91");
  } finally { await f.close(); }
});

test("authoritative package runtime metadata wins over older CI fallback evidence", async () => {
  const f = await fixture("npm");
  try {
    const pkg = JSON.parse(await readFile(join(f.source, "package.json"), "utf8"));
    pkg.engines = { node: "18.19.91" };
    await writeFile(join(f.source, "package.json"), JSON.stringify(pkg));
    await mkdir(join(f.source, ".github", "workflows"), { recursive: true });
    await writeFile(join(f.source, ".github", "workflows", "ci.yml"),
      "steps:\n  - uses: actions/setup-node@v4\n    with:\n      node-version: '14.x'\n");
    const oldNode = await fakeNodeRuntime(join(f.root, "node-14"), "14.21.3");
    const requiredNode = await fakeNodeRuntime(join(f.root, "node-18"), "18.19.91");
    await bootstrapDependencies(f.source, f.target, (await profileRepo(f.target)).ecosystem!, f.logger, {
      cacheBase: f.cache, toolVersions: { npm: "10.2.0" },
      nodeRuntimeCandidates: [oldNode, requiredNode], runner: fakeInstall([]),
    });
    assert.equal((await nodeEnvironmentForWorkspace(f.target))?.version, "18.19.91");
  } finally { await f.close(); }
});

test("monorepo project units keep distinct compatible Node runtimes without conflict", async () => {
  const f = await fixture("npm");
  try {
    const childSource = join(f.source, "packages", "modern");
    await createJavaScriptRepo(childSource, "npm");
    await writeFile(join(f.source, ".nvmrc"), "14.21.71\n");
    await writeFile(join(childSource, ".node-version"), "18.19.71\n");
    await cp(f.source, f.target, { recursive: true, force: true });
    const oldNode = await fakeNodeRuntime(join(f.root, "runtimes", "node14"), "14.21.71");
    const modernNode = await fakeNodeRuntime(join(f.root, "runtimes", "node18"), "18.19.71");
    const observed = new Set<string>();
    await bootstrapDependencies(f.source, f.target, (await profileRepo(f.target)).ecosystem!, f.logger, {
      cacheBase: f.cache, toolVersions: { npm: "10.2.0" },
      nodeRuntimeCandidates: [oldNode, modernNode],
      runner: async (cwd, bootstrapCommand, _timeout, env) => {
        observed.add((await execa("node", ["--version"], { env })).stdout);
        return fakeInstall([])(cwd, bootstrapCommand);
      },
    });
    assert.deepEqual([...observed].sort(), ["v14.21.71", "v18.19.71"]);
    assert.equal((await nodeEnvironmentForWorkspace(f.target))?.version, "14.21.71");
    assert.equal((await nodeEnvironmentForWorkspace(f.target, "packages/modern"))?.version, "18.19.71");
  } finally { await f.close(); }
});

test("nested advisory checks inherit the required parent environment without a second install", async () => {
  const f = await fixture("npm");
  try {
    const child = join(f.source, "examples", "site");
    await mkdir(child, { recursive: true });
    await writeFile(join(child, "package.json"), JSON.stringify({ devDependencies: { typescript: "1.0.0" } }));
    await writeFile(join(child, "package-lock.json"), JSON.stringify({
      name: "site", lockfileVersion: 3, packages: {},
    }));
    await writeFile(join(child, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));
    await mkdir(join(child, "src"));
    await writeFile(join(child, "src", "index.ts"), "export const value = 1;\n");
    await mkdir(join(f.source, ".github", "workflows"), { recursive: true });
    await writeFile(join(f.source, ".github", "workflows", "ci.yml"),
      "steps:\n  - uses: actions/setup-node@v4\n    with:\n      node-version: '14.x'\n");
    await cp(f.source, f.target, { recursive: true, force: true });
    const node = await fakeNodeRuntime(join(f.root, "node14"), "14.21.81");
    const commands: string[] = [];
    await bootstrapDependencies(f.source, f.target, (await profileRepo(f.target)).ecosystem!, f.logger, {
      cacheBase: f.cache, toolVersions: { npm: "6.14.18" }, nodeRuntimeCandidates: [node],
      runner: fakeInstall(commands),
    });
    assert.deepEqual(commands, ["npm ci --no-audit --no-fund"]);
    assert.equal((await nodeEnvironmentForWorkspace(f.target, "examples/site"))?.version, "14.21.81");
  } finally { await f.close(); }
});

test("runtime discovery accepts a compatible Node installation outside NVM and caches it", async () => {
  const f = await fixture("npm");
  const probe = join(f.root, "runtime-probes");
  try {
    await writeFile(join(f.source, ".node-version"), "16.20.77\n");
    const node = await fakeNodeRuntime(join(f.root, "custom-runtime-manager", "16.20.77"),
      "16.20.77", probe);
    const firstProfile = await profileRepo(f.target);
    await bootstrapDependencies(f.source, f.target, firstProfile.ecosystem!, f.logger, {
      cacheBase: f.cache, toolVersions: { npm: "9.9.9" }, nodeRuntimeCandidates: [node],
      runner: fakeInstall([]),
    });
    const second = join(f.root, "second-integration");
    await cp(f.source, second, { recursive: true });
    await bootstrapDependencies(f.source, second, (await profileRepo(second)).ecosystem!, f.logger, {
      cacheBase: f.cache, toolVersions: { npm: "9.9.9" }, nodeRuntimeCandidates: [node],
      runner: async () => { throw Error("cached dependencies must not reinstall"); },
    });
    assert.equal((await readFile(probe, "utf8")).trim().split("\n").length, 1);
    assert.equal((await nodeEnvironmentForWorkspace(second))?.executable, await realpath(node));
  } finally { await f.close(); }
});

test("bootstrap fails closed when no compatible Node runtime is installed", async () => {
  const f = await fixture("npm");
  try {
    await writeFile(join(f.source, ".nvmrc"), "97.4.3\n");
    const incompatible = await fakeNodeRuntime(join(f.root, "only-node"), "26.0.0");
    await assert.rejects(bootstrapDependencies(f.source, f.target,
      (await profileRepo(f.target)).ecosystem!, f.logger, {
        cacheBase: f.cache, toolVersions: { npm: "10.9.0" },
        nodeRuntimeCandidates: [incompatible], allowRuntimeProvisioning: false,
        runner: fakeInstall([]),
      }), /INFRA_FAILURE.*compatible Node runtime unavailable.*97\.4\.3/);
    assert.ok(f.logger.events.some((event) => event.type === "dependency_bootstrap_failed" &&
      event.classification === "INFRA_FAILURE"));
  } finally { await f.close(); }
});

test("resolved Node runtime is reused by candidate and baseline verification commands", async () => {
  const f = await fixture("npm");
  const baseline = join(f.root, "baseline");
  try {
    await writeFile(join(f.source, "package.json"), JSON.stringify({
      engines: { node: "18.19.88" }, scripts: { test: "fixture-test" },
      devDependencies: { "fixture-test": "1.0.0" },
    }));
    await cp(f.source, baseline, { recursive: true });
    const node = await fakeNodeRuntime(join(f.root, "asdf", "installs", "nodejs", "18.19.88"),
      "18.19.88");
    await bootstrapDependencies(f.source, f.target, (await profileRepo(f.target)).ecosystem!, f.logger, {
      cacheBase: f.cache, toolVersions: { npm: "10.2.0" }, nodeRuntimeCandidates: [node],
      runner: fakeInstall([]),
    });
    const candidateResult = await command(f.target, "node --version", 10000, true);
    const baselineResult = await command(baseline, "node --version", 10000, true);
    assert.equal(candidateResult.exitCode, 0, candidateResult.stderr);
    assert.equal(baselineResult.exitCode, 0, baselineResult.stderr);
    assert.equal(candidateResult.stdout.trim(), "v18.19.88");
    assert.equal(baselineResult.stdout.trim(), "v18.19.88");
  } finally { await f.close(); }
});

test("bootstrap rejects lockfile rewrites and leaves repository state untouched", async () => {
  const f = await fixture("npm");
  try {
    const original = await readFile(join(f.source, "package-lock.json"), "utf8");
    const profile = await profileRepo(f.target);
    await assert.rejects(bootstrapDependencies(f.source, f.target, profile.ecosystem!, f.logger, {
      cacheBase: f.cache, toolVersions: f.versions,
      runner: fakeInstall([], "package-lock.json"),
    }), /modified_lockfile/);
    assert.equal(await readFile(join(f.source, "package-lock.json"), "utf8"), original);
    assert.equal(await readFile(join(f.target, "package-lock.json"), "utf8"), original);
  } finally { await f.close(); }
});

test("unchanged dependency state reuses its cache and lock changes create a new environment", async () => {
  const f = await fixture("npm");
  let installs = 0;
  const runner = async (cwd: string, command: string) => {
    installs++;
    return fakeInstall([])(cwd, command);
  };
  try {
    const firstProfile = await profileRepo(f.target);
    await bootstrapDependencies(f.source, f.target, firstProfile.ecosystem!, f.logger, {
      cacheBase: f.cache, toolVersions: f.versions, runner,
    });
    const second = join(f.root, "second");
    await cp(f.source, second, { recursive: true });
    await bootstrapDependencies(f.source, second, (await profileRepo(second)).ecosystem!, f.logger, {
      cacheBase: f.cache, toolVersions: f.versions, runner,
    });
    assert.equal(installs, 1);
    await writeFile(join(f.source, "package-lock.json"),
      JSON.stringify({ name: "fixture", lockfileVersion: 3, packages: { changed: {} } }));
    const third = join(f.root, "third");
    await cp(f.source, third, { recursive: true });
    await bootstrapDependencies(f.source, third, (await profileRepo(third)).ecosystem!, f.logger, {
      cacheBase: f.cache, toolVersions: f.versions, runner,
    });
    assert.equal(installs, 2);
  } finally { await f.close(); }
});

test("Python bootstrap registers one isolated environment for candidate and baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-python-bootstrap-"));
  const source = join(root, "source"), integration = join(root, "integration");
  const baseline = join(root, "baseline"), cache = join(root, "cache");
  const logger = new Logger(join(root, "logs"), "python-bootstrap", true);
  try {
    await mkdir(source); await mkdir(baseline);
    await writeFile(join(source, "requirements-dev.txt"), "pytest==9.0.0\n");
    await writeFile(join(source, "pytest.ini"), "[pytest]\n");
    await writeFile(join(source, "candidate_module.py"), "value = 42\n");
    await writeFile(join(source, "test_candidate.py"), "def test_value(): assert True\n");
    await cp(source, integration, { recursive: true });
    await cp(source, baseline, { recursive: true });
    const profile = await profileRepo(integration);
    await bootstrapDependencies(source, integration, profile.ecosystem!, logger, {
      cacheBase: cache, toolVersions: { python3: "3.14.6" },
      runner: async (cwd) => {
        await execa("python3", ["-m", "venv", "--without-pip", ".venv"], { cwd });
        const python = join(cwd, ".venv", "bin", "python");
        const site = (await execa(python, ["-c",
          "import site; print(site.getsitepackages()[0])"])).stdout;
        await mkdir(join(site, "pytest"), { recursive: true });
        await writeFile(join(site, "pytest", "__init__.py"), "");
        await writeFile(join(site, "pytest", "__main__.py"),
          "import candidate_module; assert candidate_module.value == 42; print('PYTHON_BOOTSTRAP_OK')\n");
        return { exitCode: 0, stdout: "installed", stderr: "" };
      },
    });
    const environment = await pythonEnvironmentForWorkspace(integration);
    assert.ok(environment?.includes(cache));
    assert.equal(await pythonEnvironmentForWorkspace(baseline), environment);
    const after = await profileRepo(integration);
    const candidate = after.ecosystem!.projectUnits[0]!.verification.find((check) =>
      check.kind === "test")!;
    assert.equal(candidate.available, true);
    const result = await verify(integration, [candidate.command], 15000, undefined,
      undefined, [candidate]);
    assert.equal(result.status, "VERIFIED_SUCCESS", JSON.stringify(result.checks));
    assert.match(result.checks[0]!.stdout, /PYTHON_BOOTSTRAP_OK/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("repositories without dependency-driven checks do not bootstrap", async () => {
  const f = await fixture("npm");
  let installs = 0;
  try {
    await writeFile(join(f.source, "package.json"), JSON.stringify({ scripts: {} }));
    await cp(f.source, f.target, { recursive: true, force: true });
    const profile = await profileRepo(f.target);
    assert.equal(await bootstrapDependencies(f.source, f.target, profile.ecosystem!, f.logger, {
      cacheBase: f.cache, toolVersions: f.versions,
      runner: async () => { installs++; return { exitCode: 0, stdout: "", stderr: "" }; },
    }), false);
    assert.equal(installs, 0);
  } finally { await f.close(); }
});

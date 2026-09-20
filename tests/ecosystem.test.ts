import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  chmod,
  realpath,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";
import { profileRepo } from "../src/repo/profiler.js";
import { git, pythonSandboxEnvironment } from "../src/repo/commands.js";
import { projectFor } from "../src/repo/ecosystem.js";
import { verificationPlan } from "../src/verifier/plan.js";
import { verify } from "../src/verifier/verifier.js";
import { focusedLocalReproduction, optionalUnavailableCheck } from "../src/verifier/recovery.js";
import { verificationAgainstBaseline, verificationResult, verificationRegressed, runtimeInfrastructureFailure } from "../src/verifier/verifier.js";
import { compileContext } from "../src/context/compiler.js";
import { extractFeatures, featureKey } from "../src/router/features.js";
import { config } from "../src/config.js";
import { bridgeDependencies } from "../src/repo/dependencies.js";
const pkg = (scripts: Record<string, string> = {}, extra: object = {}) =>
  JSON.stringify({ scripts, ...extra });
async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "koda-ecosystem-"));
  for (const [p, s] of Object.entries(files)) {
    await mkdir(dirname(join(root, p)), { recursive: true });
    await writeFile(join(root, p), s);
  }
  await git(root, "init", "-q");
  await git(root, "config", "user.email", "test@koda.local");
  await git(root, "config", "user.name", "test");
  await git(root, "add", "-f", ".");
  await git(root, "commit", "-qm", "fixture");
  return {
    root,
    profile: () => profileRepo(root),
    close: () => rm(root, { recursive: true, force: true }),
  };
}
test("baseline-aware verification distinguishes unchanged failures, regressions, and infrastructure", () => {
  const check = (command: string, stderr: string) => ({
    command, exitCode: 1, stdout: "", stderr, wallClockMs: 1, timedOut: false,
  });
  const baseline = verificationResult([check("python3 -m pytest", "FAILED existing assertion\n1 failed in 1.2s")]);
  const unchanged = verificationResult([check("python3 -m pytest", "FAILED existing assertion\n1 failed in 2.3s")]);
  const changed = verificationResult([check("python3 -m pytest", "FAILED new assertion\n1 failed in 2.3s")]);
  assert.equal(verificationRegressed(baseline, unchanged), false);
  assert.equal(verificationRegressed(baseline, changed), true);
  const assertionBase = verificationResult([check("node --test", "AssertionError\n  actual: 0\n  expected: 1")]);
  const assertionChanged = verificationResult([check("node --test", "AssertionError\n  actual: 2\n  expected: 1")]);
  assert.equal(verificationRegressed(assertionBase, assertionChanged), true);
  assert.equal(verificationRegressed(baseline, verificationResult([check("python3 -m pytest", "FAILED existing assertion"), check("python3 -m compileall .", "SyntaxError")])), true);
  assert.equal(runtimeInfrastructureFailure(check("python3 -m pytest", "socket.gaierror: Temporary failure in name resolution")), "verification_network_environment");
  assert.equal(runtimeInfrastructureFailure(check("python3 -m pytest", "AssertionError: expected Network is unreachable")), undefined);
});

test("baseline comparison uses stable pytest test identities instead of volatile traces", () => {
  const check = (command: string, stdout: string) => ({
    command, exitCode: 1, stdout, stderr: "", wallClockMs: 1, timedOut: false,
  });
  const result = (output: string) => verificationResult([check("pytest -q", output)]);
  const baseline = result([
    "E ConnectionError: object at 0x111111 Network is unreachable",
    "FAILED tests/test_api.py::test_timeout - ConnectionError at /tmp/koda-verify-old/repo",
    "ERROR tests/test_api.py::test_server",
    "1 failed, 1 error in 0.41s",
  ].join("\n"));
  const sameFailures = result([
    "E ConnectionError: object at 0x999999 Network is unreachable",
    "FAILED tests/test_api.py::test_timeout - ConnectionError at /tmp/koda-verify-new/repo",
    "ERROR tests/test_api.py::test_server",
    "1 failed, 1 error in 0.73s",
  ].join("\n"));
  const regression = result([
    sameFailures.checks[0]!.stdout,
    "FAILED tests/test_api.py::test_new_regression - AssertionError",
  ].join("\n"));
  assert.equal(verificationRegressed(baseline, sameFailures), false);
  assert.equal(verificationAgainstBaseline(baseline, sameFailures).status,
    "VERIFIED_SUCCESS");
  assert.equal(verificationRegressed(baseline, regression), true);
});
for (const scenario of [
  {
    name: "pnpm Next TypeScript",
    files: {
      "package.json": pkg(
        {
          test: "vitest run",
          typecheck: "tsc --noEmit",
          lint: "eslint .",
          build: "next build",
        },
        {
          dependencies: { next: "1", react: "1" },
          devDependencies: { typescript: "1", vitest: "1" },
        },
      ),
      "pnpm-lock.yaml": "",
      "tsconfig.json": "{}",
      "next.config.ts": "export default {}",
      "app/page.tsx": "export default function Page(){}",
    },
    manager: "pnpm",
    frameworks: ["nextjs", "react"],
  },
  {
    name: "npm Vite React",
    files: {
      "package.json": pkg(
        { test: "vitest run", "check:types": "tsc --noEmit" },
        {
          dependencies: { vite: "1", react: "1" },
          devDependencies: { typescript: "1" },
        },
      ),
      "package-lock.json": "{}",
      "vite.config.ts": "export default {}",
      "tsconfig.json": "{}",
    },
    manager: "npm",
    frameworks: ["vite", "react"],
  },
  {
    name: "Bun",
    files: { "package.json": pkg({ test: "bun test" }), "bun.lock": "" },
    manager: "bun",
    frameworks: ["nodejs"],
  },
  {
    name: "Yarn",
    files: { "package.json": pkg({ test: "jest" }), "yarn.lock": "" },
    manager: "yarn",
    frameworks: ["nodejs"],
  },
] as const)
  test(`profile ${scenario.name} without dependencies or network`, async () => {
    const f = await fixture(
      scenario.files as unknown as Record<string, string>,
    );
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      throw Error("Unexpected network");
    };
    try {
      const p = await f.profile(),
        e = p.ecosystem!;
      assert.equal(e.ecosystem, "javascript");
      assert.equal(e.packageManager?.name, scenario.manager);
      for (const framework of scenario.frameworks)
        assert.ok(e.frameworks.includes(framework));
      if (
        scenario.name.includes("TypeScript") ||
        scenario.name.includes("Vite")
      )
        assert.ok(e.languages.includes("typescript"));
      assert.ok(e.projectUnits[0]!.verification.length);
      if (scenario.name !== "Bun")
        assert.ok(e.projectUnits[0]!.verification.every((c) => !c.available));
      assert.equal(await git(f.root, "status", "--porcelain"), "");
    } finally {
      globalThis.fetch = original;
      await f.close();
    }
  });
for (const explicit of [false, true])
  test(`conflicting lockfiles preserve uncertainty; explicit=${explicit}`, async () => {
    const f = await fixture({
      "package.json": pkg(
        { test: "node --test" },
        explicit ? { packageManager: "pnpm@10.0.0" } : {},
      ),
      "pnpm-lock.yaml": "",
      "yarn.lock": "",
    });
    try {
      const p = await f.profile();
      assert.equal(
        p.ecosystem!.packageManager?.name,
        explicit ? "pnpm" : undefined,
      );
      assert.ok(p.ecosystem!.ambiguities.length);
      if (!explicit)
        assert.equal(
          p.ecosystem!.projectUnits[0]!.verification[0]!.reason,
          "package_manager_ambiguous",
        );
    } finally {
      await f.close();
    }
  });
test("workspace commands use project cwd; root dimensions remain final authority; config and router features are scoped", async () => {
  const f = await fixture({
    "package.json": pkg(
      { build: "turbo build" },
      { packageManager: "pnpm@10", workspaces: ["apps/*", "packages/*"] },
    ),
    "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n  - 'packages/*'\n",
    "apps/web/package.json": pkg(
      { test: "node --test", typecheck: "tsc --noEmit" },
      { dependencies: { next: "1", react: "1" } },
    ),
    "apps/web/tsconfig.json": "{}",
    "apps/web/next.config.ts": "export default {}",
    "apps/web/app/login/page.tsx": "export function login(){}",
    "packages/ui/package.json": pkg({ test: "node --test" }),
    "packages/ui/src/index.ts": "export const ui=1;",
  });
  try {
    const p = await f.profile();
    assert.equal(p.ecosystem!.monorepo, true);
    assert.equal(
      projectFor(p.ecosystem, "apps/web/app/login/page.tsx")!.root,
      "apps/web",
    );
    const targeted = verificationPlan(p, ["apps/web/app/login/page.tsx"]);
    assert.ok(targeted.every((c) => c.cwd === "apps/web"));
    assert.ok(
      targeted.every((c) => c.command.startsWith("cd 'apps/web' && pnpm")),
    );
    const final = verificationPlan(p, ["apps/web/app/login/page.tsx"], true);
    assert.ok(final.some((c) => c.cwd === "." && c.kind === "build"));
    assert.ok(final.some((c) => c.cwd === "apps/web" && c.kind === "test"));
    const c = await config(undefined, { models: {} });
    const context = await compileContext(
      f.root,
      "Fix login",
      ["apps/web/app/login/page.tsx"],
      p,
      c.context,
      true,
    );
    assert.ok(context.files.some((f) => f.path === "apps/web/next.config.ts"));
    assert.ok(
      !context.files.some((f) => f.path === "packages/ui/package.json"),
    );
    assert.ok(Buffer.byteLength(JSON.stringify(context)) <= c.context.maxBytes);
    const features = extractFeatures(
      {
        id: "fix",
        title: "Fix login",
        objective: "Fix login",
        dependsOn: [],
        likelyReadPaths: [],
        likelyWritePaths: ["apps/web/app/login/page.tsx"],
        integrationContract: "preserve",
        verificationCommands: [],
        estimatedDifficulty: "normal",
        parallelSafe: false,
      },
      p,
      100,
    );
    assert.equal(features.ecosystem, "javascript");
    assert.deepEqual(features.taskScope, ["apps/web"]);
    assert.ok(features.frameworks.includes("nextjs"));
    assert.notEqual(
      featureKey(features),
      featureKey({ ...features, frameworks: ["fastapi"], ecosystem: "python" }),
    );
  } finally {
    await f.close();
  }
});
for (const manager of ["uv", "poetry", "pdm"])
  test(`Python ${manager} with proper TOML and separate backend`, async () => {
    const f = await fixture({
      "pyproject.toml": `[project]\nname = "api"\ndependencies = [\n "fastapi>=0.100",\n "pytest", "ruff", "mypy",\n]\n[build-system]\nbuild-backend = "hatchling.build"\n[tool.ruff]\nline-length = 88\n[tool.mypy]\nfiles = ["app"]\n`,
      [`${manager}.lock`]: "",
      "app/main.py": "from fastapi import FastAPI\n",
      "tests/test_main.py": "def test_main(): pass",
    });
    try {
      const p = await f.profile(),
        u = p.ecosystem!.projectUnits[0]!;
      assert.equal(u.ecosystem, "python");
      assert.equal(u.packageManager?.name, manager);
      assert.equal(u.buildBackend, "hatchling.build");
      assert.ok(u.frameworks.includes("fastapi"));
      assert.ok(u.testRunners.includes("pytest"));
      assert.deepEqual(
        u.verification.map((c) => c.kind),
        ["test", "lint", "typecheck"],
      );
      assert.ok(
        u.verification.every(
          (c) => !c.available && c.reason === "dependencies_not_available",
        ),
      );
      assert.ok(
        u.verification.every(
          (c) => !c.command.match(/install|sync|--fix|ruff format/),
        ),
      );
      const result = await verify(
        f.root,
        u.verification.map((c) => c.command),
        10000,
        undefined,
        undefined,
        u.verification,
      );
      assert.equal(result.status, "NOT_FULLY_VERIFIED");
      assert.equal(result.dimensions!.test, "UNAVAILABLE");
      assert.equal(result.dimensions!.build, "NOT_RUN");
      assert.equal(await git(f.root, "status", "--porcelain"), "");
    } finally {
      await f.close();
    }
  });
for (const pytest of [false, true])
  test(`Django respects pytest precedence: ${pytest}`, async () => {
    const f = await fixture({
      "pyproject.toml": `[project]\ndependencies=["Django"${pytest ? ', "pytest-django"' : ""}]\n`,
      "manage.py": "",
      "project/settings.py": "",
    });
    try {
      const u = (await f.profile()).ecosystem!.projectUnits[0]!;
      assert.ok(u.frameworks.includes("django"));
      assert.ok(
        u.verification
          .find((c) => c.kind === "test")!
          .command.includes(pytest ? "-m pytest" : "manage.py test"),
      );
    } finally {
      await f.close();
    }
  });
for (const [file, body] of [
  ["pytest.ini", "[pytest]\n"],
  ["pytest.toml", "[pytest]\n"],
  ["pyproject.toml", "[tool.pytest.ini_options]\ntestpaths=['tests']"],
  ["setup.cfg", "[tool:pytest]\n"],
  ["tox.ini", "[testenv]\ncommands=pytest"],
])
  test(`pytest configuration: ${file}`, async () => {
    const f = await fixture({ [file!]: body!, "app.py": "" });
    try {
      assert.ok(
        (await f.profile()).ecosystem!.projectUnits[0]!.testRunners.includes(
          "pytest",
        ),
      );
    } finally {
      await f.close();
    }
  });
test("dedicated Ruff/mypy configuration, generated directories and generic fallback", async () => {
  for (const files of [
    { "app.py": "", "ruff.toml": "", "mypy.ini": "[mypy]" },
    {
      "go.mod": "module test",
      "main.go": "package main",
      "vendor/tool.js": "",
      "node_modules/pkg/package.json": pkg(),
    },
    { "Cargo.toml": "[package]\nname='sample'", "src/main.rs": "fn main() {}" },
  ]) {
    const f = await fixture(files as unknown as Record<string, string>);
    try {
      const p = await f.profile();
      assert.ok(!p.files.some((f) => /vendor|node_modules/.test(f)));
      assert.equal(
        p.ecosystem!.ecosystem,
        "app.py" in files ? "python" : "generic",
      );
      if ("app.py" in files)
        assert.deepEqual(
          p.ecosystem!.projectUnits[0]!.verification.map((c) => c.kind),
          ["lint", "typecheck"],
        );
    } finally {
      await f.close();
    }
  }
});
test("unsafe intents, hooks and script indirection are never executed automatically", async () => {
  const f = await fixture({
    "package.json": pkg({
      dev: "next dev",
      start: "node server.js",
      serve: "vite",
      deploy: "touch DEPLOYED",
      publish: "touch PUBLISHED",
      release: "touch RELEASED",
      "migrate:prod": "touch DB",
      "seed:prod": "touch DB",
      test: "npm run deploy",
      lint: "ruff check --fix .",
      typecheck: "tsc --noEmit",
      pretypecheck: "npm install",
      build: "node build.js && rm -rf src",
    }),
    "src/a.js": "",
  });
  try {
    const p = await f.profile(),
      candidates = p.ecosystem!.projectUnits[0]!.verification;
    assert.equal(candidates.length, 4);
    assert.ok(
      candidates.every(
        (c) => !c.available && c.reason === "unsafe_verification_command",
      ),
    );
    assert.equal(
      (
        await verify(
          f.root,
          candidates.map((c) => c.command),
          10000,
          undefined,
          undefined,
          candidates,
        )
      ).status,
      "NOT_FULLY_VERIFIED",
    );
    assert.equal(await git(f.root, "status", "--porcelain"), "");
  } finally {
    await f.close();
  }
});
test("declared package tests accept safe focused test-file arguments", async () => {
  const f = await fixture({
    "package.json": pkg({ test: "node --test tests/*.test.cjs" }),
    "package-lock.json": "{}",
    "tests/focused.test.cjs":
      "const {test}=require('node:test');test('focused',()=>{});",
  });
  try {
    const p = await f.profile();
    const candidates = p.ecosystem!.projectUnits[0]!.verification;
    const result = await verify(
      f.root,
      ["npm test -- tests/focused.test.cjs"],
      10000,
      undefined,
      undefined,
      candidates,
    );
    assert.equal(result.status, "VERIFIED_SUCCESS", JSON.stringify(result));
    assert.equal(result.checks[0]!.outcome, "CHECK_PASS");
    assert.match(result.checks[0]!.source!, /targeted-arguments$/);
    const unsafe = await verify(
      f.root,
      ["npm test -- tests/focused.test.cjs; touch escaped"],
      10000,
      undefined,
      undefined,
      candidates,
    );
    assert.equal(unsafe.checks[0]!.outcome, "CHECK_UNAVAILABLE");
  } finally {
    await f.close();
  }
});
test("automatic project-local checks execute in cwd; source mutations are rejected; build does not imply tests", async () => {
  const f = await fixture({
    "package.json": pkg({}, { workspaces: ["packages/*"] }),
    "packages/a/package.json": pkg({ build: "node build.cjs" }),
    "packages/a/build.cjs":
      "require('node:assert').equal(require('node:fs').readFileSync('value.txt','utf8'),'correct');",
    "packages/a/value.txt": "correct",
  });
  try {
    const p = await f.profile(),
      checks = verificationPlan(p, ["packages/a/value.txt"], true);
    const result = await verify(
      f.root,
      checks.map((c) => c.command),
      10000,
      undefined,
      undefined,
      checks,
    );
    assert.equal(result.status, "VERIFIED_SUCCESS", JSON.stringify(result));
    assert.equal(result.dimensions!.build, "PASS");
    assert.equal(result.dimensions!.test, "NOT_RUN");
    await writeFile(
      join(f.root, "packages/a/build.cjs"),
      "require('node:fs').writeFileSync('value.txt','modified')",
    );
    const bad = await verify(
      f.root,
      checks.map((c) => c.command),
      10000,
      undefined,
      undefined,
      checks,
    );
    assert.equal(bad.status, "FAILED");
    assert.match(bad.checks[0]!.stderr, /modified repository source/);
    assert.equal(
      await readFile(join(f.root, "packages/a/value.txt"), "utf8"),
      "correct",
    );
  } finally {
    await f.close();
  }
});
test("unavailable external Python environment is infrastructure, never a fallback coding failure", async () => {
  const f = await fixture({ "module.py": "value = 1\n" });
  const external = await mkdtemp(join(tmpdir(), "koda-external-python-"));
  await mkdir(join(external, "bin"));
  await writeFile(join(external, "pyvenv.cfg"), "home = /usr/bin\n");
  await writeFile(join(external, "bin/python3"), "#!/bin/sh\necho wrong-interpreter >&2\nexit 7\n");
  await chmod(join(external, "bin/python3"), 0o755);
  const previous = { PATH: process.env.PATH, VIRTUAL_ENV: process.env.VIRTUAL_ENV,
    PYTHONHOME: process.env.PYTHONHOME };
  try {
    process.env.PATH = `${join(external, "bin")}:${previous.PATH ?? ""}`;
    process.env.VIRTUAL_ENV = external;
    process.env.PYTHONHOME = external;
    const sanitized = await pythonSandboxEnvironment(f.root);
    assert.ok(!sanitized.PATH.includes(join(external, "bin")));
    assert.equal(sanitized.VIRTUAL_ENV, undefined);
    assert.equal(sanitized.PYTHONHOME, undefined);
    const candidate = { kind: "test" as const, command: "python3 -B -c 'print(42)'",
      cwd: ".", source: "test:python-environment", confidence: 1, available: true,
      mutatesSource: false as const, requiresInstalledDependencies: false };
    const result = await verify(f.root, [candidate.command], 10000,
      undefined, undefined, [candidate]);
    assert.equal(result.status, "NOT_FULLY_VERIFIED", JSON.stringify(result));
    assert.equal(result.checks[0]!.outcome, "INFRA_FAILURE");
    assert.equal(result.failedChecks, 0);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await f.close();
    await rm(external, { recursive: true, force: true });
  }
});

test("an unrelated unsafe virtualenv later in PATH does not poison system Python", async () => {
  const f = await fixture({ "module.py": "value = 1\n" });
  const external = await mkdtemp(join(tmpdir(), "koda-unselected-python-"));
  try {
    await mkdir(join(external, "bin"));
    await writeFile(join(external, "pyvenv.cfg"), "home = /missing/python\n");
    await writeFile(join(external, "bin", "python"), "not a Python interpreter\n");
    const sanitized = await pythonSandboxEnvironment(f.root, {
      PATH: `/usr/bin:/bin:${join(external, "bin")}`,
    });
    assert.equal(sanitized.unavailable, undefined);
    assert.ok(!sanitized.PATH.includes(join(external, "bin")));
    assert.match(sanitized.PATH, /\/usr\/bin/);
  } finally {
    await f.close();
    await rm(external, { recursive: true, force: true });
  }
});

test("valid worktree-local Python environment remains available", async () => {
  const f = await fixture({ "module.py": "value = 1\n" });
  try {
    await mkdir(join(f.root, ".local-env", "bin"), { recursive: true });
    await writeFile(join(f.root, ".local-env", "pyvenv.cfg"), "home = /usr/bin\n");
    const local = join(f.root, ".local-env");
    const sanitized = await pythonSandboxEnvironment(f.root, {
      PATH: `${join(local, "bin")}:/usr/bin:/bin`, VIRTUAL_ENV: local,
      PYTHONHOME: local,
    });
    assert.equal(sanitized.VIRTUAL_ENV, await realpath(local));
    assert.equal(sanitized.PYTHONHOME, await realpath(local));
    assert.ok(sanitized.PATH.startsWith(await realpath(join(local, "bin"))));
  } finally { await f.close(); }
});

test("legacy setup.py/unittest infrastructure supplies a real local check", async () => {
  const f = await fixture({
    "setup.py": "from setuptools import setup\nsetup(name='sample', test_suite='tests')\n",
    "sample.py": "def value():\n    return 2\n",
    "tests/test_sample.py": "import unittest\nfrom sample import value\nclass SampleTest(unittest.TestCase):\n    def test_value(self): self.assertEqual(value(), 2)\n",
  });
  try {
    const profile = await f.profile();
    const candidates = verificationPlan(profile, ["sample.py"]);
    const check = candidates.find((candidate) => candidate.available && candidate.command.includes("unittest discover"));
    assert.ok(check);
    const passed = await verify(f.root, [check.command], 10000, undefined, undefined, candidates);
    assert.equal(passed.status, "VERIFIED_SUCCESS", JSON.stringify(passed));
    await writeFile(join(f.root, "sample.py"), "def value():\n    return 3\n");
    const failed = await verify(f.root, [check.command], 10000, undefined, undefined, candidates);
    assert.equal(failed.status, "FAILED");
  } finally { await f.close(); }
});

test("empty selection recovers a concrete local assertion after source mutation", async () => {
  const f = await fixture({ "calculator.py": "def add(a, b):\n    return a - b\n" });
  try {
    const profile = await f.profile();
    assert.deepEqual(verificationPlan(profile, ["calculator.py"]), []);
    const task = "Fix add(2, 3) == 5 in calculator.py";
    const check = await focusedLocalReproduction(profile, task, ["calculator.py"]);
    assert.ok(check);
    const initial = await verify(f.root, [check.command], 10000, undefined, undefined, [check]);
    assert.equal(initial.status, "FAILED");
    await writeFile(join(f.root, "calculator.py"), "def add(a, b):\n    return a + b\n");
    const passed = await verify(f.root, [check.command], 10000, undefined, undefined, [check]);
    assert.equal(passed.status, "VERIFIED_SUCCESS", JSON.stringify(passed));
    assert.equal(passed.checks[0]?.source, "task:concrete-local-reproduction");
  } finally { await f.close(); }
});

test("without a concrete safe reproduction, empty verification remains unverified", async () => {
  const f = await fixture({ "calculator.py": "def add(a, b):\n    return a + b\n" });
  try {
    const profile = await f.profile();
    assert.equal(await focusedLocalReproduction(profile, "Fix the arithmetic bug", ["calculator.py"]), undefined);
    assert.equal(verificationResult([]).status, "NOT_FULLY_VERIFIED");
    assert.equal(await focusedLocalReproduction(profile, "Fix absent(2) == 3", ["calculator.py"]), undefined);
  } finally { await f.close(); }
});

test("DIRECT source edit with no discovered runner executes recovered final verification", async () => {
  const { createServer } = await import("node:http");
  const { run } = await import("../src/run.js");
  const f = await fixture({ "calculator.py": "def add(a, b):\n    return a - b\n" });
  const output = await mkdtemp(join(tmpdir(), "koda-python-recovery-"));
  let calls = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "mock", model: body.model, choices: [{ index: 0,
      finish_reason: "tool_calls", message: { role: "assistant", content: null,
        tool_calls: [{ id: "write", type: "function", function: { name: "write_file",
          arguments: JSON.stringify({ path: "calculator.py", content: "def add(a, b):\n    return a + b\n" }) } }] } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0 } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await run({ repo: f.root, task: "Fix calculator.py: add(2, 3) == 5.",
      config: await config(undefined, { models: {},
        baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`, maxIterations: 3 }),
      output, quiet: true });
    assert.equal(result.status, "VERIFIED_SUCCESS", result.error);
    assert.equal(result.finalVerificationStatus, "VERIFIED_SUCCESS");
    assert.ok(calls >= 1);
    assert.ok(result.verification.checks.some((check: any) =>
      check.source === "task:concrete-local-reproduction" && check.outcome === "CHECK_PASS"));
    assert.equal(await readFile(join(f.root, "calculator.py"), "utf8"),
      "def add(a, b):\n    return a - b\n");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
    await rm(output, { recursive: true, force: true });
  }
});

test("unavailable inferred pytest does not suppress a local reproduction or erase declared checks", async () => {
  const f = await fixture({
    "requirements.txt": "pytest==999.0\n",
    "calculator.py": "def add(a, b):\n    return a + b\n",
    "tests/test_calculator.py": "def test_add(): pass\n",
  });
  try {
    const profile = await f.profile();
    const optional = verificationPlan(profile, ["calculator.py"]).find(optionalUnavailableCheck);
    assert.ok(optional);
    const reproduction = await focusedLocalReproduction(profile,
      "Fix add(2, 3) == 5", ["calculator.py"]);
    assert.ok(reproduction);
    assert.equal((await verify(f.root, [reproduction.command], 10000,
      undefined, undefined, [reproduction])).status, "VERIFIED_SUCCESS");
    assert.equal(optionalUnavailableCheck({ ...optional, source: "pytest.ini" }), false);
  } finally { await f.close(); }
});
test("required project evidence remains fully verified when an advisory runner is unavailable", async () => {
  const f = await fixture({
    "package.json": pkg({ test: "node -e \"process.exit(0)\"" }),
    "requirements.txt": "pytest\n",
    "module.js": "export const value = 1;\n",
    "test_optional.py": "def test_optional(): assert True\n",
  });
  try {
    const profile = await f.profile();
    const candidates = verificationPlan(profile, ["module.js"], true);
    const required = candidates.find((candidate) => candidate.source.includes("scripts.test"));
    const advisory = candidates.find((candidate) =>
      candidate.reason === "dependencies_not_available" && candidate.kind === "test");
    assert.ok(required);
    assert.ok(advisory);
    const result = await verify(
      f.root, candidates.map((candidate) => candidate.command), 10000,
      undefined, undefined, candidates,
    );
    assert.equal(result.status, "VERIFIED_SUCCESS", JSON.stringify(result));
    assert.equal(result.checks.find((check) => check.command === required.command)?.requirement, "required");
    assert.equal(result.checks.find((check) => check.command === advisory.command)?.requirement, "advisory");
    assert.equal(result.checks.find((check) => check.command === advisory.command)?.outcome, "CHECK_UNAVAILABLE");
  } finally {
    await f.close();
  }
});

test("existing Python venv verifies locally but is not bridged in JavaScript-first V1", async () => {
  const f = await fixture({
    "pyproject.toml": "[project]\ndependencies=['pytest']",
    "app.py": "value = 7",
    "tests/test_app.py": "",
    " .unused": "",
  });
  const target = await mkdtemp(join(tmpdir(), "koda-env-copy-"));
  try {
    await execa("python3", [
      "-m",
      "venv",
      "--without-pip",
      join(f.root, ".venv"),
    ]);
    const python = join(
      f.root,
      ".venv",
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
    );
    const site = (
      await execa(python, [
        "-c",
        "import sysconfig; print(sysconfig.get_path('purelib'))",
      ])
    ).stdout;
    await mkdir(join(site, "pytest"));
    await writeFile(
      join(site, "pytest/__main__.py"),
      "import app\nassert app.value == 7\n",
    );
    const p = await f.profile(),
      checks = verificationPlan(p);
    assert.equal(checks[0]!.available, true);
    assert.equal(
      (
        await verify(
          f.root,
          checks.map((c) => c.command),
          10000,
          undefined,
          undefined,
          checks,
        )
      ).status,
      "VERIFIED_SUCCESS",
    );
    await writeFile(join(f.root, "app.py"), "value = 8");
    assert.equal(
      (
        await verify(
          f.root,
          checks.map((c) => c.command),
          10000,
          undefined,
          undefined,
          checks,
        )
      ).status,
      "FAILED",
    );
    assert.equal(await bridgeDependencies(f.root, target, p.ecosystem), false);
  } finally {
    await f.close();
    await rm(target, { recursive: true, force: true });
  }
});

test("final selection retains separately declared test dimensions and Python task precedence", async () => {
  const f = await fixture({
    "package.json": pkg({
      test: "node unit.cjs",
      "test:integration": "node integration.cjs",
      build: "node build.cjs",
    }),
    "pyproject.toml":
      "[project]\ndependencies=['pytest']\n[tool.pdm.scripts]\ntest = 'pytest tests/special'\n",
    "unit.cjs": "",
    "integration.cjs": "",
    "build.cjs": "",
  });
  try {
    const p = await f.profile(),
      checks = verificationPlan(p, [], true);
    assert.ok(
      checks.some((c) => c.source.endsWith("scripts.test:integration")),
    );
    assert.ok(
      p.ecosystem!.projectUnits[0]!.verification.some((c) =>
        c.source.includes("pyproject.toml:task.test"),
      ),
    );
    // Python task supersedes Python inference, but must not erase the JS contract in a mixed root.
    assert.ok(
      checks.some((c) => c.source.includes("package.json:scripts.test")),
    );
  } finally {
    await f.close();
  }
});
test("local TypeScript inference never uses network resolution and malformed metadata admits uncertainty", async () => {
  const f = await fixture({
    "package.json": pkg(),
    "tsconfig.json": "{}",
    "src/a.ts": "export const a=1",
  });
  try {
    let p = await f.profile();
    assert.equal(
      p.ecosystem!.projectUnits[0]!.verification[0]!.available,
      false,
    );
    await mkdir(join(f.root, "node_modules/.bin"), { recursive: true });
    await writeFile(join(f.root, "node_modules/.bin/tsc"), "#!/bin/sh\nexit 0");
    await chmod(join(f.root, "node_modules/.bin/tsc"), 0o755);
    p = await f.profile();
    const c = p.ecosystem!.projectUnits[0]!.verification[0]!;
    assert.equal(c.available, true);
    assert.match(
      c.command,
      /node_modules\/\.bin\/tsc.*--noEmit -p tsconfig.json/,
    );
    assert.ok(!c.command.includes("npx"));
    await writeFile(join(f.root, "package.json"), "null");
    assert.ok(
      (await f.profile()).ecosystem!.ambiguities.some((a) =>
        a.includes("Invalid JSON"),
      ),
    );
  } finally {
    await f.close();
  }
});

test("filesystem workspace executes pnpm test and typecheck with bridged dependencies", async () => {
  const source = await fixture({
    "package.json": pkg(
      { test: "node -e \"require('pkg').check()\"", typecheck: "tsc --noEmit" },
      {
        packageManager: "pnpm@11.7.0",
        dependencies: { pkg: "1" },
        devDependencies: { typescript: "1" },
      },
    ),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "src.js": "export const value = 1;\n",
    "node_modules/pkg/index.js": "exports.check=()=>{};\n",
    "node_modules/.bin/tsc": "#!/bin/sh\nexit 0\n",
  });
  const target = await mkdtemp(join(tmpdir(), "koda-fs-deps-"));
  try {
    await writeFile(
      join(target, "package.json"),
      pkg(
        {
          test: "node -e \"require('pkg').check()\"",
          typecheck: "tsc --noEmit",
        },
        {
          packageManager: "pnpm@11.7.0",
          dependencies: { pkg: "1" },
          devDependencies: { typescript: "1" },
        },
      ),
    );
    await writeFile(join(target, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await writeFile(join(target, "src.js"), "export const value = 1;\n");
    await chmod(join(source.root, "node_modules/.bin/tsc"), 0o755);
    let targetProfile = await profileRepo(target);
    assert.ok(
      targetProfile.ecosystem!.projectUnits[0]!.verification.every(
        (candidate) => !candidate.available,
      ),
    );
    const sourceProfile = await source.profile();
    assert.equal(
      await bridgeDependencies(source.root, target, sourceProfile.ecosystem),
      true,
    );
    targetProfile = await profileRepo(target);
    const candidates = targetProfile.ecosystem!.projectUnits[0]!.verification;
    assert.ok(candidates.some((candidate) => candidate.available));
    assert.equal(
      (
        await verify(
          target,
          ["pnpm run test", "pnpm run typecheck"],
          10000,
          undefined,
          undefined,
          candidates,
        )
      ).status,
      "VERIFIED_SUCCESS",
    );
    await assert.rejects(readFile(join(target, "node_modules/pkg/index.js")));
    assert.equal(
      await readFile(join(source.root, "node_modules/pkg/index.js"), "utf8"),
      "exports.check=()=>{};\n",
    );
    await assert.rejects(readFile(join(target, "installed")));
  } finally {
    await source.close();
    await rm(target, { recursive: true, force: true });
  }
});

for (const baselineFails of [true, false])
test(`workspace DIRECT final verification: ${baselineFails ? "unchanged baseline is neutral" : "new root failure is a regression"}`, async () => {
  const { createServer } = await import("node:http");
  const { run } = await import("../src/run.js");
  const f = await fixture({
    "package.json": pkg(
      { check: "node final.cjs" },
      { workspaces: ["packages/*"] },
    ),
    "final.cjs": baselineFails ? "process.exit(1)" :
      "import('./packages/calc/src/calc.js').then(({add})=>process.exit(add(2,3)===5?1:0))",
    "packages/calc/package.json": pkg(
      { test: "node --test" },
      { type: "module" },
    ),
    "packages/calc/src/calc.js": "export function add(a,b){return a-b;}",
    "packages/calc/test/calc.test.js":
      "import {test} from 'node:test';import assert from 'node:assert/strict';import {add} from '../src/calc.js';test('add',()=>assert.equal(add(2,3),5));",
  });
  const output = await mkdtemp(join(tmpdir(), "koda-stack-run-"));
  let calls = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls++;
    assert.ok(!body.messages[0].content.startsWith("Compile"));
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id: "mock",
        model: body.model,
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "edit",
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments: JSON.stringify({
                      path: "packages/calc/src/calc.js",
                      content: "export function add(a,b){return a+b;}",
                    }),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0 },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const cfg = await config(undefined, {
      models: {},
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      maxIterations: 2,
    });
    const result = await run({
      repo: f.root,
      task: "Fix add in packages/calc/src/calc.js so all tests pass.",
      config: cfg,
      output,
      quiet: true,
    });
    assert.equal(result.execution_strategy, "direct");
    assert.equal(result.plannerModelCalls, 0);
    assert.equal(calls, 1);
    assert.equal(result.status, baselineFails ? "VERIFIED_SUCCESS" : "FAILED");
    assert.equal(result.verificationDimensions!.test, "PASS");
    assert.equal(result.verificationDimensions!.check, baselineFails ? "PASS" : "FAIL");
    assert.equal(
      await readFile(
        join(result.integration!.path, "packages/calc/src/calc.js"),
        "utf8",
      ),
      "export function add(a,b){return a+b;}",
    );
    assert.equal(await git(f.root, "status", "--porcelain"), "");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    for (const line of (
      await git(f.root, "worktree", "list", "--porcelain")
    ).split("\n"))
      if (line.startsWith("worktree ") && line.includes("/koda-worktrees/"))
        await git(f.root, "worktree", "remove", "--force", line.slice(9));
    await f.close();
    await rm(output, { recursive: true, force: true });
  }
});

test("solution-style TypeScript references require an explicit typecheck contract", async () => {
  const f = await fixture({
    "package.json": pkg(),
    "tsconfig.json": '{"files":[],"references":[{"path":"./app"}]}',
    "app/tsconfig.json": "{}",
  });
  try {
    const check = (await f.profile()).ecosystem!.projectUnits[0]!
      .verification[0]!;
    assert.equal(check.available, false);
    assert.equal(check.reason, "project_references_require_explicit_command");
  } finally {
    await f.close();
  }
});

test("recursive workspace contracts retain local availability and unsupported managers remain unresolved", async () => {
  const f = await fixture({
    "package.json": pkg(
      { test: "npm run test --workspaces" },
      { workspaces: ["packages/*"] },
    ),
    "packages/a/package.json": pkg({ test: "node --test" }),
    "packages/a/test.cjs": "",
  });
  try {
    let p = await f.profile();
    assert.equal(
      p.ecosystem!.projectUnits[0]!.verification[0]!.available,
      true,
    );
    assert.equal(
      verificationPlan(p, ["packages/a/test.cjs"], true).filter(
        (c) => c.kind === "test",
      ).length,
      1,
    );
    await writeFile(
      join(f.root, "package.json"),
      pkg({ test: "node --test" }, { packageManager: "unsupported@1" }),
    );
    p = await f.profile();
    assert.equal(p.ecosystem!.packageManager, undefined);
    assert.ok(
      p.ecosystem!.ambiguities.some((a) =>
        a.includes("Unsupported package manager"),
      ),
    );
  } finally {
    await f.close();
  }
});

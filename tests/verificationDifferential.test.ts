import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verify, verificationAgainstBaseline, verificationRegressions,
  verificationResult } from "../src/verifier/verifier.js";
import { pythonSandboxEnvironment } from "../src/repo/commands.js";

async function concreteSystemPython(root: string) {
  const resolved = await pythonSandboxEnvironment(root, { PATH: process.env.PATH });
  assert.ok(resolved.interpreter, "controlled system Python is required by this Python fixture");
  return resolved.interpreter;
}

const result = (stdout: string, exitCode = 1, command = "pytest -q") => verificationResult([{
  command, stdout, stderr: "", exitCode, wallClockMs: 1, timedOut: false, kind: "test" as const,
}]);
const old = "FAILED tests/test_a.py::test_old - AssertionError\n";
const other = "FAILED tests/test_a.py::test_other - AssertionError\n";
test("unchanged baseline pytest failure is neutral with original diagnostics retained", () => {
  const actual = verificationAgainstBaseline(result(old + "1 failed in 1.2s"), result(old + "1 failed in 3.4s"));
  assert.equal(actual.status, "VERIFIED_SUCCESS");
  assert.equal(actual.failedChecks, 0);
  assert.equal(actual.failingTests, null);
  assert.match(actual.checks[0]!.stdout, /test_old/);
});
test("new candidate pytest failure remains a regression", () => {
  assert.equal(verificationAgainstBaseline(result(old), result(old + other)).status, "FAILED");
  assert.equal(verificationAgainstBaseline(result("passed", 0), result(other)).status, "FAILED");
});
test("removing some or all baseline failures is improvement", () => {
  assert.equal(verificationAgainstBaseline(result(old + other), result(old)).status, "VERIFIED_SUCCESS");
  assert.equal(verificationAgainstBaseline(result(old), result("passed", 0)).status, "VERIFIED_SUCCESS");
});
test("new compiler diagnostics and unavailable verification remain strict", () => {
  assert.equal(verificationAgainstBaseline(result("error TS1234: old", 1, "tsc"),
    result("error TS1234: old\nerror TS5678: new", 1, "tsc")).status, "FAILED");
  const unavailable = result(old);
  unavailable.checks[0]!.unavailable = "python_environment_inaccessible";
  unavailable.checks[0]!.outcome = "INFRA_FAILURE";
  assert.equal(verificationAgainstBaseline(result(old), unavailable).status, "NOT_FULLY_VERIFIED");
  const interrupted = result(old);
  interrupted.checks[0]!.timedOut = true;
  assert.equal(verificationAgainstBaseline(result(old), interrupted).status, "FAILED");
});
for (const layout of ["root", "src", "nested-src"]) {
  test(`Python ${layout} layout imports candidate source in isolated verification`, async () => {
    const root = await mkdtemp(join(tmpdir(), "koda-python-import-"));
    const unit = layout === "nested-src" ? "unit" : ".";
    const source = join(root, unit, layout === "root" ? "." : "src", "example_pkg");
    try {
      await mkdir(source, { recursive: true });
      await mkdir(join(root, unit, "tests"), { recursive: true });
      await writeFile(join(source, "__init__.py"), "value = 42\n");
      await writeFile(join(root, unit, "tests", "check.py"),
        "from pathlib import Path\nimport example_pkg\nassert example_pkg.value == 42\nassert 'koda-verify-' in str(Path(example_pkg.__file__).resolve())\nprint('candidate imported')\n");
      const command = `${unit === "." ? "" : "cd unit && "}python3 -B tests/check.py`;
      const candidate = { command, kind: "test" as const, cwd: unit, source: "test:python",
        confidence: 1, available: true, mutatesSource: false as const, requiresInstalledDependencies: false };
      const run = () => verify(root, [command], 10000, undefined, undefined, [candidate]);
      const passed = await run();
      assert.equal(passed.status, "VERIFIED_SUCCESS", JSON.stringify(passed));
      await writeFile(join(source, "__init__.py"), "value = 99\n");
      assert.equal((await run()).status, "FAILED");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("safe external Python environment is reused read-only with candidate source first", async () => {
  const { execa } = await import("execa");
  const root = await mkdtemp(join(tmpdir(), "koda-python-env-source-"));
  const external = await mkdtemp(join(tmpdir(), "koda-python-env-"));
  const saved = { PATH: process.env.PATH, VIRTUAL_ENV: process.env.VIRTUAL_ENV };
  try {
    // No pip, package installation, or network is involved.
    await execa(await concreteSystemPython(root), ["-m", "venv", "--without-pip", external]);
    const python = join(external, "bin", "python");
    const site = (await execa(python, ["-c", "import site; print(site.getsitepackages()[0])"])).stdout;
    await writeFile(join(site, "existing_dependency.py"), "value = 7\n");
    await writeFile(join(site, "candidate_module.py"), "value = -1\n");
    await writeFile(join(site, "bootstrap.pth"),
      "import os; os.environ.setdefault('SAFE_VENV_BOOTSTRAP', '1')\n");
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "candidate_module.py"), "value = 42\n");
    await writeFile(join(root, "check.py"), [
      "from pathlib import Path", "import sys, existing_dependency, candidate_module",
      "assert existing_dependency.value == 7", "assert candidate_module.value == 42",
      "assert 'koda-verify-' in candidate_module.__file__",
      "try:", "    Path(sys.prefix, 'should-not-write').write_text('bad')",
      "except PermissionError:", "    pass", "else:", "    raise AssertionError('external environment writable')",
    ].join("\n"));
    process.env.VIRTUAL_ENV = external;
    process.env.PATH = `${join(external, "bin")}:${saved.PATH}`;
    const commands = ["python -B check.py", "python3 -B check.py"];
    const candidates = commands.map((command) => ({ command, kind: "test" as const,
      cwd: ".", source: "test:external", confidence: 1, available: true,
      mutatesSource: false as const, requiresInstalledDependencies: true }));
    const actual = await verify(root, commands, 10000, undefined, undefined, candidates);
    assert.equal(actual.status, "VERIFIED_SUCCESS", JSON.stringify(actual));
    assert.equal(actual.checks.length, 2);
    // Editable startup hooks could import the original source instead of the copy.
    await writeFile(join(site, "editable.pth"), `import sys; sys.path.insert(0, ${JSON.stringify(root)})\n`);
    const unsafe = await verify(root, commands, 10000, undefined, undefined, candidates);
    assert.equal(unsafe.status, "NOT_FULLY_VERIFIED");
    assert.ok(unsafe.checks.every((check) => check.outcome === "INFRA_FAILURE"));
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("inherited repo-local Python environment is remapped to the isolated copy", async () => {
  const { execa } = await import("execa");
  const root = await mkdtemp(join(tmpdir(), "koda-python-local-"));
  const unrelated = await mkdtemp(join(tmpdir(), "koda-python-unrelated-"));
  const saved = { PATH: process.env.PATH, VIRTUAL_ENV: process.env.VIRTUAL_ENV };
  try {
    const env = join(root, ".venv");
    const hostPython = await concreteSystemPython(root);
    await execa(hostPython, ["-m", "venv", "--without-pip", env]);
    await execa(hostPython, ["-m", "venv", "--without-pip", unrelated]);
    await writeFile(join(root, "check.py"),
      "import sys\nassert 'koda-verify-' in sys.prefix\nassert '.venv' in sys.prefix\n");
    process.env.VIRTUAL_ENV = unrelated;
    process.env.PATH = `${join(unrelated, "bin")}:${saved.PATH}`;
    const commands = ["python -B check.py", "python3 -B check.py"];
    const candidates = commands.map((command) => ({ command, kind: "test" as const,
      cwd: ".", source: "test:local-env", confidence: 1, available: true,
      mutatesSource: false as const, requiresInstalledDependencies: false }));
    const actual = await verify(root, commands, 10000, undefined, undefined, candidates);
    assert.equal(actual.status, "VERIFIED_SUCCESS", JSON.stringify(actual));
    assert.equal(actual.checks.length, 2);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
    await rm(unrelated, { recursive: true, force: true });
  }
});

test("unavailable baseline cannot establish candidate regression", () => {
  const baseline = verificationResult([{ ...result(old).checks[0]!,
    unavailable: "python_environment_inaccessible", outcome: "INFRA_FAILURE" }]);
  const actual = verificationAgainstBaseline(baseline, result(other));
  assert.equal(actual.status, "NOT_FULLY_VERIFIED");
  assert.equal(actual.checks[0]!.outcome, "INFRA_FAILURE");
  assert.equal(actual.failedChecks, 0);
});

test("pytest failure identity preserves parametrized names and new compiler failures", () => {
  const baseline = result("FAILED tests/test_a.py::test_value[a b] - AssertionError");
  assert.equal(verificationAgainstBaseline(baseline,
    result("FAILED tests/test_a.py::test_value[a c] - AssertionError")).status, "FAILED");
  assert.equal(verificationAgainstBaseline(baseline,
    result(baseline.checks[0]!.stdout + "\nfile.ts(2,1): error TS1234: new failure")).status, "FAILED");
});

test("removed compiler diagnostic is improvement while changed collection errors regress", () => {
  assert.equal(verificationAgainstBaseline(result("file.ts(1,1): error TS1234: old\nfile.ts(2,1): error TS5678: removed", 1, "tsc"),
    result("file.ts(1,1): error TS1234: old", 1, "tsc")).status, "VERIFIED_SUCCESS");
  const baseline = result("ERROR tests/test_a.py - ModuleNotFoundError: No module named 'existing_dependency'", 2);
  const candidate = result("ERROR tests/test_a.py - ModuleNotFoundError: No module named 'candidate_module'", 2);
  assert.equal(verificationAgainstBaseline(baseline, candidate).status, "FAILED");
});

test("duration-looking pytest parameters remain distinct failure identities", () => {
  assert.equal(verificationAgainstBaseline(
    result("FAILED tests/test_a.py::test_timeout[1s] - AssertionError"),
    result("FAILED tests/test_a.py::test_timeout[2s] - AssertionError"),
  ).status, "FAILED");
});

test("differential attribution keeps coding regressions strict and infrastructure operational", () => {
  const pass = (command: string, kind: "build" | "typecheck" | "test" = "test") => ({
    command, kind, outcome: "CHECK_PASS" as const, exitCode: 0, stdout: "ok", stderr: "",
    wallClockMs: 1, timedOut: false,
  });
  const fail = (command: string, stdout: string, kind: "build" | "typecheck" | "test" = "test") => ({
    ...pass(command, kind), outcome: "CHECK_FAIL" as const, exitCode: 1, stdout,
  });
  const infra = (command: string) => ({ ...fail(command,
    "ENOENT: invalid .git/worktrees/candidate path"), outcome: "INFRA_FAILURE" as const,
    unavailable: "verification_git_worktree_environment" });

  const buildRegression = verificationAgainstBaseline(
    verificationResult([pass("pnpm build", "build"), pass("pnpm typecheck", "typecheck")]),
    verificationResult([fail("pnpm build", "src/a.ts(1,1): error TS1234: bad", "build"),
      fail("pnpm typecheck", "src/a.ts(1,1): error TS1234: bad", "typecheck")]),
  );
  assert.equal(buildRegression.status, "FAILED");
  assert.equal(verificationRegressions(
    verificationResult([pass("pnpm build", "build"), pass("pnpm typecheck", "typecheck")]),
    buildRegression).length, 2);

  const baselineInfra = verificationResult([infra("pnpm test")]);
  const sameInfra = verificationAgainstBaseline(baselineInfra,
    verificationResult([infra("pnpm test")]));
  assert.equal(sameInfra.status, "NOT_FULLY_VERIFIED");
  assert.equal(sameInfra.checks[0]!.outcome, "INFRA_FAILURE");
  assert.match(sameInfra.checks[0]!.source ?? "", /baseline_environment_unchanged/);
  assert.equal(verificationRegressions(baselineInfra, sameInfra).length, 0);

  const candidateTest = verificationAgainstBaseline(
    verificationResult([pass("pnpm test")]),
    verificationResult([fail("pnpm test", "FAILED tests/new.test.ts - AssertionError")]),
  );
  assert.equal(candidateTest.status, "FAILED");

  const mixedBaseline = verificationResult([pass("pnpm typecheck", "typecheck"), infra("pnpm test")]);
  const mixed = verificationAgainstBaseline(mixedBaseline, verificationResult([
    fail("pnpm typecheck", "src/a.ts(2,1): error TS9999: candidate regression", "typecheck"),
    infra("pnpm test"),
  ]));
  assert.equal(mixed.status, "FAILED");
  assert.deepEqual(verificationRegressions(mixedBaseline, mixed).map((check) => check.command),
    ["pnpm typecheck"]);
});

test("successful candidate evidence plus unrelated Python infrastructure is not repairable regression", () => {
  const pass = (command: string, kind: "test" | "typecheck" = "test") => ({
    command, kind, outcome: "CHECK_PASS" as const, exitCode: 0, stdout: "ok", stderr: "",
    wallClockMs: 1, timedOut: false, requirement: "required" as const,
  });
  const pythonInfrastructure = {
    ...pass("python3 -m pytest"), exitCode: 1, outcome: "INFRA_FAILURE" as const,
    stderr: "python_environment_inaccessible",
  };
  const baseline = verificationResult([
    pass("pnpm typecheck", "typecheck"), pass("python3 -m pytest"),
  ]);
  const candidate = verificationAgainstBaseline(baseline, verificationResult([
    pass("pnpm typecheck", "typecheck"), pythonInfrastructure,
  ]));
  const attributable = verificationRegressions(baseline, candidate);
  let repairCalls = 0;
  if (candidate.status === "FAILED" && attributable.length) repairCalls++;

  assert.equal(candidate.status, "NOT_FULLY_VERIFIED");
  assert.equal(candidate.checks[1]!.outcome, "INFRA_FAILURE");
  assert.equal(candidate.failedChecks, 0);
  assert.deepEqual(attributable, []);
  assert.equal(repairCalls, 0);
});

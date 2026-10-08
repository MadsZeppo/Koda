import assert from "node:assert/strict";
import type { VerificationCandidate } from "../src/repo/ecosystem.js";
import test from "node:test";
import { chmod, mkdir, mkdtemp, rm, writeFile, lstat, readFile, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  bridgeDependencies,
  dependenciesForWorkspace,
  dependencyPathAvailable,
  materializeDependencyTree,
} from "../src/repo/dependencies.js";
import { command } from "../src/repo/commands.js";
import { profileRepo } from "../src/repo/profiler.js";

const packageJson = JSON.stringify(
  {
    type: "module",
    packageManager: "pnpm@11.7.0",
    scripts: {
      build: "tsc",
      typecheck: "tsc --noEmit",
      test: "tsx --test tests/*.test.ts",
    },
    devDependencies: {
      tsx: "1",
      typescript: "1",
    },
  },
  null,
  2,
);

test("baseline verification reuses the integration dependency bridge", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-baseline-deps-"));
  const source = join(root, "source");
  const workspaceRoot = join(root, "workspaces", "run-example");
  const baseline = join(workspaceRoot, "baseline");
  const integration = join(workspaceRoot, "integration");

  try {
    for (const directory of [source, baseline, integration])
      await mkdir(directory, { recursive: true });

    for (const directory of [source, baseline, integration]) {
      await writeFile(join(directory, "package.json"), packageJson);
      await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    }

    await mkdir(join(source, "node_modules", ".bin"), { recursive: true });
    await mkdir(join(source, "node_modules", "tsx"), { recursive: true });
    await mkdir(join(source, "node_modules", "typescript"), { recursive: true });
    await writeFile(join(source, "node_modules", ".bin", "tsx"), "#!/bin/sh\nexit 0\n");
    await writeFile(join(source, "node_modules", ".bin", "tsc"), "#!/bin/sh\nexit 0\n");
    await chmod(join(source, "node_modules", ".bin", "tsx"), 0o755);
    await chmod(join(source, "node_modules", ".bin", "tsc"), 0o755);

    const sourceProfile = await profileRepo(source);
    assert.equal(
      await bridgeDependencies(source, integration, sourceProfile.ecosystem),
      true,
    );

    const integrationBridges = await dependenciesForWorkspace(integration);
    const baselineBridges = await dependenciesForWorkspace(baseline);

    assert.deepEqual(baselineBridges, integrationBridges);
    assert.equal(baselineBridges.length, 1);
    assert.equal(baselineBridges[0]!.relativePath, "node_modules");
    assert.equal(
      await dependencyPathAvailable(baseline, "node_modules/.bin/tsx"),
      true,
    );
    assert.equal(
      await dependencyPathAvailable(baseline, "node_modules/.bin/tsc"),
      true,
    );

    const baselineProfile = await profileRepo(baseline);
    const rootUnit = baselineProfile.ecosystem?.projectUnits.find(
      (unit) => unit.root === ".",
    );
    assert.ok(rootUnit);

    for (const command of ["pnpm run build", "pnpm run typecheck", "pnpm run test"]) {
        const candidate: VerificationCandidate | undefined = rootUnit.verification.find(
        (item) => item.command === command,
      );
      assert.ok(candidate, `missing verification candidate: ${command}`);
      assert.equal(candidate.available, true, `${command} should see bridged dependencies`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("isolated dependencies have a real root and relocate package/bin links without sharing writes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "koda-local-deps-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source", "node_modules"), target = join(root, "candidate", "node_modules");
  await mkdir(join(source, "pkg"), { recursive: true });
  await mkdir(join(source, ".bin"));
  await writeFile(join(source, "pkg", "cli.js"), "original");
  await symlink(join(source, "pkg", "cli.js"), join(source, ".bin", "pkg"));
  await materializeDependencyTree(source, target);
  assert.equal((await lstat(target)).isSymbolicLink(), false);
  assert.equal(await realpath(join(target, ".bin", "pkg")), await realpath(join(target, "pkg", "cli.js")));
  await writeFile(join(target, "pkg", "cli.js"), "candidate");
  assert.equal(await readFile(join(source, "pkg", "cli.js"), "utf8"), "original");
});

test("dependency materialization rejects external links and removes partial copies", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "koda-deps-escape-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "node_modules"), target = join(root, "candidate", "node_modules");
  await mkdir(source);
  await writeFile(join(root, "private.txt"), "must not enter sandbox");
  await symlink("../private.txt", join(source, "escape"));
  await assert.rejects(materializeDependencyTree(source, target), /escapes/);
  await assert.rejects(lstat(target), { code: "ENOENT" });
});

test("actual macOS sandbox mounts dependencies inside its root and protects both copies", { skip: process.platform !== "darwin" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "koda-deps-sandbox-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source"), candidate = join(root, "candidate");
  await mkdir(join(source, "node_modules", "pkg"), { recursive: true });
  await mkdir(candidate);
  await writeFile(join(source, "node_modules", "pkg", "index.js"), "module.exports=7;\n");
  await bridgeDependencies(source, candidate);
  await writeFile(join(candidate, "check.cjs"), `const fs=require('node:fs');const a=require('node:assert/strict');
a.equal(fs.lstatSync('node_modules').isSymbolicLink(),false);
a.ok(fs.realpathSync('node_modules/pkg').startsWith(process.cwd()+'/'));
a.equal(require('pkg'),7);
a.throws(()=>fs.writeFileSync('node_modules/pkg/index.js','bad'));
`);
  const result = await command(candidate, "node check.cjs");
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(await readFile(join(source, "node_modules", "pkg", "index.js"), "utf8"), "module.exports=7;\n");
  await assert.rejects(lstat(join(candidate, "node_modules")), { code: "ENOENT" });
});

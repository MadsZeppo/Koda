import assert from "node:assert/strict";
import type { VerificationCandidate } from "../src/repo/ecosystem.js";
import test from "node:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  bridgeDependencies,
  dependenciesForWorkspace,
  dependencyPathAvailable,
} from "../src/repo/dependencies.js";
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

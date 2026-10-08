import { test } from "node:test";
import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { runFakeSmoke } from "../src/dev/fakeSmoke.js";
import {
  createWorkspaceBackend,
  applyWorkspaceRun,
  applyVerifiedChanges,
} from "../src/workspace/backend.js";
import { Logger } from "../src/telemetry/logger.js";
import { verifyAppliedRepository } from "../src/workspace/verification.js";
import { verify, verificationResult } from "../src/verifier/verifier.js";

for (const git of [false, true])
  for (const scenario of ["create", "edit", "multi"]) {
    test(`local CLI applies verified ${scenario} in ${git ? "Git" : "non-Git"} repo`, async (t) => {
      const result = await runFakeSmoke(scenario, {
        apply: true,
        git,
        cli: true,
      });
      t.after(() => rm(result.parent, { recursive: true, force: true }));
      assert.equal(
        result.child.exitCode,
        0,
        result.child.stderr + result.summary.error,
      );
      assert.equal(result.summary.status, "VERIFIED_SUCCESS");
      assert.equal(result.summary.applyResult, "applied");
      assert.equal(
        await readFile(join(result.repo, "src/value.cjs"), "utf8"),
        "exports.value=2;\n",
      );
      assert.ok(
        result.events.some(
          (event) =>
            event.type === "applied_verification" &&
            event.kind === "test" &&
            event.outcome === "CHECK_PASS",
        ),
      );
      if (scenario === "multi")
        assert.ok(result.events.some((event) => event.type === "verification_reused"),
          "byte-identical direct verification must be reused instead of rerunning the same final commands");
      assert.ok(
        result.events.some(
          (event) =>
            event.type === "applied_verification" &&
            event.kind === "typecheck" &&
            event.outcome === "CHECK_PASS",
        ),
      );
      if (scenario === "multi")
        assert.match(
          await readFile(join(result.repo, "tests/value.test.cjs"), "utf8"),
          /a.equal/,
        );
    });
  }

for (const scenario of ["regression", "review-failure", "provider-failure"]) {
  test(`--apply never applies ${scenario} candidate`, async (t) => {
    const result = await runFakeSmoke(scenario, { apply: true, cli: true });
    t.after(() => rm(result.parent, { recursive: true, force: true }));
    assert.equal(result.child.exitCode, 1);
    assert.equal(
      result.summary.status,
      scenario === "regression" ? "FAILED" : "NOT_FULLY_VERIFIED",
    );
    assert.equal(result.summary.applyResult, "not_verified");
    assert.equal(
      await readFile(join(result.repo, "src/value.cjs"), "utf8"),
      "exports.value=1;\n",
    );
    assert.equal(
      result.events.some((event) => event.type === "applied_verification"),
      false,
    );
  });
}

test("linked CLI resolves its runtime outside Koda and accepts both command forms", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "koda-cli-link-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const bin = join(folder, "koda");
  await symlink(
    fileURLToPath(new URL("../bin/koda.mjs", import.meta.url)),
    bin,
  );
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.bin.koda, "bin/koda.mjs");
  for (const args of [
    ["agent", "run", "--help"],
    ["run", "--help"],
  ]) {
    const result = await execa(bin, args, { cwd: folder });
    assert.match(result.stdout, /--apply/);
    assert.match(result.stdout, /--repo/);
  }
});

async function fixture(t: any, apply = true) {
  const parent = await mkdtemp(join(tmpdir(), "koda-apply-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "repo"),
    output = join(parent, "report");
  await mkdir(root);
  await writeFile(join(root, "keep.cjs"), "exports.value=1;\n");
  await writeFile(join(root, "remove.cjs"), "obsolete\n");
  const backend = await createWorkspaceBackend(
    root,
    join(parent, "workspaces"),
    new Logger(output, "test", true),
    apply,
  );
  const integration = await backend.initialize();
  await rm(join(integration.path, "remove.cjs"));
  await writeFile(join(integration.path, "keep.cjs"), "exports.value=2;\n");
  return { root, output, backend, integration };
}

test("verified deletion is applied together with only the changed files", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "user.txt"), "unrelated user change");
  const result = await f.backend.apply(f.output, f.integration, true);
  assert.equal(result.status, "applied");
  await assert.rejects(access(join(f.root, "remove.cjs")));
  assert.equal(
    await readFile(join(f.root, "user.txt"), "utf8"),
    "unrelated user change",
  );
});

test("a conflicting user edit stops all apply writes and preserves explicit conflict paths", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "keep.cjs"), "user edit");
  const result = await f.backend.apply(f.output, f.integration, true);
  assert.equal(result.status, "conflict");
  assert.deepEqual(result.conflicts, ["keep.cjs"]);
  assert.equal(
    await readFile(join(f.root, "remove.cjs"), "utf8"),
    "obsolete\n",
  );
  assert.equal(await readFile(join(f.root, "keep.cjs"), "utf8"), "user edit");
});

test("a user-created directory conflicts with a new file before any write", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.integration.path, "new.cjs"), "new file");
  await mkdir(join(f.root, "new.cjs"));
  const result = await f.backend.apply(f.output, f.integration, true);
  assert.equal(result.status, "conflict");
  assert.deepEqual(result.conflicts, ["new.cjs"]);
  assert.equal(
    await readFile(join(f.root, "keep.cjs"), "utf8"),
    "exports.value=1;\n",
  );
});

test("filesystem apply works when no Git executable is discoverable", async (t) => {
  const previous = process.env.PATH;
  process.env.PATH = "";
  try {
    const f = await fixture(t);
    assert.equal(f.backend.mode, "filesystem");
    assert.equal(
      (await f.backend.apply(f.output, f.integration, true)).status,
      "applied",
    );
    assert.equal(
      await readFile(join(f.root, "keep.cjs"), "utf8"),
      "exports.value=2;\n",
    );
  } finally {
    process.env.PATH = previous;
  }
});

test("tampered preview candidate cannot be applied", async (t) => {
  const f = await fixture(t, false);
  await f.backend.apply(f.output, f.integration, true);
  await writeFile(
    join(f.output, "summary.json"),
    JSON.stringify({ status: "VERIFIED_SUCCESS" }),
  );
  await writeFile(
    join(f.output, "workspace/after/keep.cjs"),
    "unverified replacement",
  );
  await assert.rejects(
    applyWorkspaceRun(f.output),
    /Verified candidate changed/,
  );
  assert.equal(
    await readFile(join(f.root, "keep.cjs"), "utf8"),
    "exports.value=1;\n",
  );
  assert.equal(
    await readFile(join(f.root, "remove.cjs"), "utf8"),
    "obsolete\n",
  );
});

test("integration changed after verification cannot become a new accepted apply state", async (t) => {
  const f = await fixture(t);
  const accepted = await f.backend.changes(f.integration.path);
  await writeFile(join(f.integration.path, "keep.cjs"), "exports.value=99;\n");
  await assert.rejects(
    f.backend.apply(f.output, f.integration, true, accepted),
    /Verified integration changed/,
  );
  assert.equal(
    await readFile(join(f.root, "keep.cjs"), "utf8"),
    "exports.value=1;\n",
  );
  assert.equal(
    await readFile(join(f.root, "remove.cjs"), "utf8"),
    "obsolete\n",
  );
});

test("a mid-apply failure rolls back earlier paths without changing the conflicting file", async (t) => {
  const f = await fixture(t, false);
  const preview = await f.backend.apply(f.output, f.integration, true);
  await writeFile(join(f.root, "remove.cjs"), "new user edit");
  await assert.rejects(
    applyVerifiedChanges(f.output, f.integration.path, f.root, preview.changes),
    /APPLY_CONFLICT.*remove.cjs.*rolled back/,
  );
  assert.equal(
    await readFile(join(f.root, "keep.cjs"), "utf8"),
    "exports.value=1;\n",
  );
  assert.equal(
    await readFile(join(f.root, "remove.cjs"), "utf8"),
    "new user edit",
  );
});

test("post-apply verification detects destination-only failure and preserves known baseline failures", async (t) => {
  const f = await fixture(t);
  const check = "node -e \"process.exit(require('./keep.cjs').value===2?0:1)\"";
  const accepted = await verify(f.integration.path, [check], 10_000);
  assert.equal(accepted.status, "VERIFIED_SUCCESS");
  assert.equal(
    (await verifyAppliedRepository(f.root, accepted, 10_000)).status,
    "FAILED",
  );
  const neutral = {
    ...accepted,
    checks: [
      ...accepted.checks,
      {
        command: 'node -e "process.exit(1)"',
        exitCode: 1,
        stdout: "",
        stderr: "",
        wallClockMs: 1,
        timedOut: false,
        outcome: "CHECK_FAIL" as const,
        source: "verification:baseline_unchanged",
        requirement: "required" as const,
      },
    ],
  };
  await f.backend.apply(f.output, f.integration, true);
  assert.equal(
    (await verifyAppliedRepository(f.root, neutral, 10_000)).status,
    "VERIFIED_SUCCESS",
  );
});

test("post-apply verification reruns the smallest accepted structural check", async (t) => {
  const f = await fixture(t);
  const accepted = verificationResult([
    { command: "node -e \"process.exit(0)\" # build", kind: "build", outcome: "CHECK_PASS", exitCode: 0,
      stdout: "", stderr: "", wallClockMs: 1, timedOut: false },
    { command: "node -e \"process.exit(0)\" # lint", kind: "lint", outcome: "CHECK_PASS", exitCode: 0,
      stdout: "", stderr: "", wallClockMs: 1, timedOut: false },
    { command: "node -e \"process.exit(0)\" # typecheck", kind: "typecheck", outcome: "CHECK_PASS", exitCode: 0,
      stdout: "", stderr: "", wallClockMs: 1, timedOut: false },
  ]);
  const commands: string[] = [];
  const result = await verifyAppliedRepository(f.root, accepted, 10_000,
    (check) => commands.push(check.command));
  assert.equal(result.status, "VERIFIED_SUCCESS");
  assert.deepEqual(commands, ["node -e \"process.exit(0)\" # typecheck"]);
});

test('applied internal documentation check verifies actual hashes rather than executing a sentinel command', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.integration.path, 'README.md'), '# Verified text\n');
  const changes = (await f.backend.changes(f.integration.path)).filter((change) => change.path === 'README.md');
  const accepted = verificationResult([{ command: 'internal:tiny-documentation-structure', exitCode: 0,
    outcome: 'CHECK_PASS', source: 'deterministic:diff-write-scope', kind: 'check', stdout: 'Scoped structural change verified', stderr: '', wallClockMs: 0, timedOut: false }]);
  assert.equal((await verifyAppliedRepository(f.root, accepted, 5000, undefined, changes)).status, 'FAILED');
  await writeFile(join(f.root, 'README.md'), '# Verified text\n');
  assert.equal((await verifyAppliedRepository(f.root, accepted, 5000, undefined, changes)).status, 'VERIFIED_SUCCESS');
  await writeFile(join(f.root, 'README.md'), '# Different user text\n');
  assert.equal((await verifyAppliedRepository(f.root, accepted, 5000, undefined, changes)).status, 'FAILED');
});

test("deferred preview apply verifies the actual destination and records failures", async (t) => {
  const f = await fixture(t, false);
  const check = "node -e \"process.exit(require('./keep.cjs').value===2?0:1)\"";
  const verification = await verify(f.integration.path, [check], 10_000);
  await f.backend.apply(f.output, f.integration, true);
  await writeFile(
    join(f.output, "summary.json"),
    JSON.stringify({ status: "VERIFIED_SUCCESS", verification }),
  );
  assert.equal((await applyWorkspaceRun(f.output)).status, "APPLIED");
  const summary = JSON.parse(
    await readFile(join(f.output, "summary.json"), "utf8"),
  );
  assert.equal(summary.appliedVerification.status, "VERIFIED_SUCCESS");
  assert.equal(summary.applyResult, "applied");
});

test("deferred apply cannot report verified success when destination checks fail", async (t) => {
  const f = await fixture(t, false);
  const check =
    "node -e \"process.exit(require('node:fs').existsSync('user-marker')?1:0)\"";
  const verification = await verify(f.integration.path, [check], 10_000);
  assert.equal(verification.status, "VERIFIED_SUCCESS");
  await f.backend.apply(f.output, f.integration, true);
  await writeFile(
    join(f.root, "user-marker"),
    "unrelated original-only environment",
  );
  await writeFile(
    join(f.output, "summary.json"),
    JSON.stringify({ status: "VERIFIED_SUCCESS", verification }),
  );
  assert.equal(
    (await applyWorkspaceRun(f.output)).status,
    "APPLY_VERIFICATION_FAILED",
  );
  const summary = JSON.parse(
    await readFile(join(f.output, "summary.json"), "utf8"),
  );
  assert.equal(summary.status, "FAILED");
  assert.equal(summary.applyResult, "verification_failed");
  assert.equal(summary.applyRollback.status, "REVERTED");
  assert.equal(
    await readFile(join(f.root, "keep.cjs"), "utf8"),
    "exports.value=1;\n",
  );
  assert.equal(
    await readFile(join(f.root, "remove.cjs"), "utf8"),
    "obsolete\n",
  );
  assert.equal(
    await readFile(join(f.root, "user-marker"), "utf8"),
    "unrelated original-only environment",
  );
});

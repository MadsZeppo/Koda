import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "../src/telemetry/logger.js";
import {
  applyWorkspaceRun,
  createWorkspaceBackend,
  revertWorkspaceRun,
} from "../src/workspace/backend.js";
import { listWorkspaceFiles, snapshotTree } from "../src/workspace/files.js";
import { profileRepo } from "../src/repo/profiler.js";
import { command, git, linuxTemporaryMountArguments } from "../src/repo/commands.js";
import { config } from "../src/config.js";
import { run } from "./helpers/run.js";
import { AgentTools, currentDiff } from "../src/agent/tools.js";
import { WriteScope } from "../src/repo/writeScope.js";
import { ProgressTracker } from "../src/router/progress.js";
import { verificationResult } from "../src/verifier/verifier.js";
import { testRequirementAlreadyCovered } from "../src/agent/mutationInvariant.js";

async function sandbox(prefix = "koda-workspace-") {
  const parent = await mkdtemp(join(tmpdir(), prefix));
  const root = join(parent, "repo");
  const output = join(parent, "output");
  await mkdir(root);
  return { parent, root, output };
}

test("DIRECT explicit test mutation codes despite related words and keeps final checks scoped", async () => {
  const f = await sandbox("koda-direct-test-mutation-");
  const testPath = "tests/controlPolicy.test.ts";
  const source = `import {test} from "node:test";\nimport assert from "node:assert/strict";\nconst maxCodingAttempts=1;\nfunction chooseAdaptiveRecovery(attempted:Set<string>){return attempted.size>=maxCodingAttempts?undefined:"next";}\ntest("configured attempts are exposed",()=>assert.equal(maxCodingAttempts,1));\ntest("recovery starts with a candidate",()=>assert.equal(chooseAdaptiveRecovery(new Set()),"next"));\n`;
  const changed = `${source}test("recovery stops at the configured attempt bound",()=>assert.equal(chooseAdaptiveRecovery(new Set(["first"])),undefined));\n`;
  const task = `In ${testPath}, add a deterministic regression test proving recovery stops when maxCodingAttempts is reached.`;
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "mock", model: body.model, choices: [{ index: 0,
      finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{
        id: "write-test", type: "function", function: { name: "write_file",
          arguments: JSON.stringify({ path: testPath, content: changed }) },
      }] } }], usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0 } }));
  });
  try {
    await mkdir(join(f.root, "tests"), { recursive: true });
    await mkdir(join(f.root, "tests/fixtures/math"), { recursive: true });
    await writeFile(join(f.root, testPath), source);
    await writeFile(join(f.root, "package.json"), JSON.stringify({ scripts: {
      test: "node --test tests/*.test.ts", build: "node -e \"process.exit(0)\"",
      typecheck: "node -e \"process.exit(0)\"",
    }, type: "module" }));
    await writeFile(join(f.root, "tests/fixtures/math/package.json"), JSON.stringify({ scripts: {
      test: "node --test failing.test.cjs",
    } }));
    await writeFile(join(f.root, "tests/fixtures/math/failing.test.cjs"),
      `const {test}=require("node:test");test("unrelated fixture",()=>{throw Error("must not run")});\n`);
    await git(f.root, "init", "-q");
    await git(f.root, "config", "user.email", "test@koda.local");
    await git(f.root, "config", "user.name", "Koda Test");
    await git(f.root, "add", ".");
    await git(f.root, "commit", "-qm", "covered regression");
    assert.equal(testRequirementAlreadyCovered(task, [{ path: testPath, content: source }]), false);
    assert.equal(testRequirementAlreadyCovered(task, [{ path: testPath,
      content: `// recovery maxCodingAttempts\ntest("name only",()=>assert.equal(1,1));\n` }]), false);

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const result = await run({ repo: f.root, task, output: f.output, quiet: true,
      config: await config(undefined, { adaptiveCoding: false, specialistRouting: false,
        models: {}, baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
        budgetUsd: 10 }) });
    const events = (await readFile(join(f.output, "events.jsonl"), "utf8")).trim()
      .split("\n").map((line) => JSON.parse(line));
    assert.equal(result.status, "VERIFIED_SUCCESS",
      `${result.error ?? ""}\n${JSON.stringify(events.slice(-20), null, 2)}`);
    assert.equal(result.execution_strategy, "direct");
    assert.equal(result.execution_effort, "normal");
    assert.equal(events.some((event) => event.type === "no_changes_required"), false);
    assert.equal(events.some((event) => event.type === "coding_worker_start"), true);
    assert.equal(requests.length, 1);
    assert.deepEqual(result.workerScopes[0]?.allowed_write_paths, [testPath]);
    assert.deepEqual(result.changedFiles, [testPath]);
    const finalCommands = events.filter((event) => event.type === "final_verification")
      .map((event) => event.command);
    assert.ok(finalCommands.some((command) => command.includes(testPath)), finalCommands.join("\n"));
    assert.ok(finalCommands.some((command) => /build/.test(command)), finalCommands.join("\n"));
    assert.ok(finalCommands.some((command) => /typecheck/.test(command)), finalCommands.join("\n"));
    assert.equal(finalCommands.some((command) => command.includes("tests/fixtures/math")), false);
    assert.equal(await readFile(join(f.root, testPath), "utf8"), source);
    assert.equal((await git(f.root, "status", "--porcelain")).trim(), "");
  } finally {
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(f.parent, { recursive: true, force: true });
  }
});

test("Linux /tmp workspaces have mountpoints before /tmp becomes read-only", async () => {
  for (const cwd of [
    "/tmp/koda-verify-example/repo",
    "/tmp/koda-workspaces/run-example/integration",
  ]) {
    const args = linuxTemporaryMountArguments(cwd, "/tmp/k");
    const remount = args.indexOf("--remount-ro");
    assert.ok(remount > 0);
    assert.ok(args.indexOf(cwd) < remount, "cwd mountpoint must exist before remount");
    assert.ok(args.indexOf("/tmp/k") < remount, "scratch mountpoint must exist before remount");
    assert.deepEqual(args.slice(remount, remount + 4),
      ["--remount-ro", "/tmp", "--tmpfs", "/tmp/k"]);
    assert.ok(!args.includes("--bind"), "all of /tmp must not become writable");
  }
  if (process.platform !== "linux") return;
  for (const prefix of ["koda-verify-", "koda-workspaces-"]) {
    const parent = await mkdtemp(join("/tmp", prefix));
    const repo = join(parent, "nested", "repo");
    try {
      await mkdir(repo, { recursive: true });
      await git(repo, "init", "-q");
      const result = await command(repo, "printf sandbox-ok", 10000, true);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stdout, "sandbox-ok");
    } finally { await rm(parent, { recursive: true, force: true }); }
  }
});

test("Linux verification snapshots without Git metadata remain sandboxable", async () => {
  if (process.platform !== "linux") return;
  const parent = await mkdtemp(join("/tmp", "koda-verify-no-git-"));
  const repo = join(parent, "repo");
  try {
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, "check.py"), "print('baseline-ok')\n");
    const result = await command(repo, "python3 -B check.py", 10000, true);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.equal(result.stdout, "baseline-ok");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("clean Git integration and untouched worker begin with zero snapshot changes", async () => {
  const f = await sandbox("koda-clean-git-baseline-");
  await mkdir(join(f.root, "package.egg-info"), { recursive: true });
  await mkdir(join(f.root, "src", "nested"), { recursive: true });
  await writeFile(join(f.root, ".gitignore"), "scratch.egg-info/\n");
  await writeFile(join(f.root, "package.egg-info", "PKG-INFO"), "tracked metadata\n");
  await writeFile(join(f.root, "src", "nested", "plain.py"), "value = 1\n");
  await writeFile(join(f.root, "src", "tool.sh"), "#!/bin/sh\nexit 0\n");
  await chmod(join(f.root, "src", "tool.sh"), 0o755);
  await git(f.root, "init", "-q");
  await git(f.root, "config", "user.email", "test@koda.local");
  await git(f.root, "config", "user.name", "Koda Test");
  await git(f.root, "add", ".");
  await git(f.root, "commit", "-qm", "baseline");
  await chmod(join(f.root, "src", "nested", "plain.py"), 0o600);
  await mkdir(join(f.root, "scratch.egg-info"));
  await writeFile(join(f.root, "scratch.egg-info", "ignored.txt"), "ignored\n");
  let integration: { path: string } | undefined;
  try {
    assert.equal(await git(f.root, "status", "--porcelain"), "");
    const backend = await createWorkspaceBackend(f.root, join(f.parent, "workspaces"),
      new Logger(f.output, "clean-git", true), false);
    assert.equal(backend.mode, "git");
    integration = await backend.initialize();
    assert.deepEqual(await backend.changes(integration.path), []);
    const worker = await backend.createWorker("untouched");
    try {
      assert.deepEqual(await backend.changes(worker.path), []);
      await writeFile(join(worker.path, "src", "nested", "plain.py"), "value = 2\n");
      assert.deepEqual((await backend.changes(worker.path)).map((change) => change.path),
        ["src/nested/plain.py"]);
    } finally { await backend.cleanupWorker(worker); }
    assert.deepEqual(await backend.changes(integration.path), []);
  } finally {
    if (integration) await git(f.root, "worktree", "remove", "--force", integration.path);
    await rm(f.parent, { recursive: true, force: true });
  }
});

test("edit_file replaces one exact text span and rejects missing, ambiguous, or unsafe targets", async () => {
  const f = await sandbox("koda-edit-file-");
  const original = "before\r\nUnique sentence.\r\nafter\r\n";
  await writeFile(join(f.root, "README.md"), original);
  await writeFile(join(f.root, "other.md"), "protected\n");
  const logger = new Logger(f.output, "edit", true);
  const tools = new AgentTools(
    f.root,
    false,
    10000,
    logger,
    "tiny",
    4000,
    new WriteScope(["README.md"], logger, "tiny"),
  );
  try {
    await assert.rejects(
      () =>
        tools.execute("edit_file", {
          path: "README.md",
          oldText: "",
          newText: "x",
        }),
      /non-empty oldText/,
    );
    await assert.rejects(
      () =>
        tools.execute("edit_file", {
          path: "README.md",
          oldText: "missing",
          newText: "x",
        }),
      /not found/,
    );
    await assert.rejects(
      () =>
        tools.execute("edit_file", {
          path: "README.md",
          oldText: "\r\n",
          newText: "x",
        }),
      /ambiguous/,
    );
    await assert.rejects(
      () =>
        tools.execute("edit_file", {
          path: "other.md",
          oldText: "protected",
          newText: "x",
        }),
      /WRITE_SCOPE_VIOLATION/,
    );
    assert.equal(await readFile(join(f.root, "README.md"), "utf8"), original);
    await tools.execute("edit_file", {
      path: "README.md",
      oldText: "Unique sentence.",
      newText: "Correct sentence.",
    });
    assert.equal(
      await readFile(join(f.root, "README.md"), "utf8"),
      original.replace("Unique sentence.", "Correct sentence."),
    );
    assert.equal(
      await readFile(join(f.root, "other.md"), "utf8"),
      "protected\n",
    );
    assert.ok(
      logger.events.some(
        (event) =>
          event.type === "write_attempt" && event.source === "edit_file",
      ),
    );
    assert.ok(
      logger.events.some(
        (event) =>
          event.type === "write_success" && event.source === "edit_file",
      ),
    );
    await link(join(f.root, "README.md"), join(f.root, "hardlink.md"));
    await assert.rejects(
      () =>
        tools.execute("edit_file", {
          path: "README.md",
          oldText: "Correct sentence.",
          newText: "unsafe",
        }),
      /hardlink|alias|WRITE_SCOPE_VIOLATION/i,
    );
    await symlink("other.md", join(f.root, "alias.md"));
    const aliasTools = new AgentTools(
      f.root,
      false,
      10000,
      logger,
      "tiny",
      4000,
      new WriteScope(["alias.md"], logger, "tiny"),
    );
    await assert.rejects(
      () =>
        aliasTools.execute("edit_file", {
          path: "alias.md",
          oldText: "protected",
          newText: "unsafe",
        }),
      /WRITE_SCOPE_VIOLATION/,
    );
    await writeFile(join(f.root, "binary.txt"), Buffer.from([0, 1, 2]));
    const binaryTools = new AgentTools(
      f.root,
      false,
      10000,
      logger,
      "tiny",
      4000,
      new WriteScope(["binary.txt"], logger, "tiny"),
    );
    await assert.rejects(
      () =>
        binaryTools.execute("edit_file", {
          path: "binary.txt",
          oldText: "x",
          newText: "y",
        }),
      /text, not binary/,
    );
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

test("filesystem backend previews and atomically applies binary-safe create, modify and delete changes", async () => {
  const f = await sandbox();
  try {
    await writeFile(join(f.root, "modify.txt"), "before\n");
    await writeFile(join(f.root, "delete.bin"), Buffer.from([0, 1, 2, 255]));
    const backend = await createWorkspaceBackend(
      f.root,
      join(f.parent, "workspaces"),
      new Logger(f.output, "test", true),
      false,
    );
    assert.equal(backend.mode, "filesystem");
    const integration = await backend.initialize();
    await writeFile(join(integration.path, "modify.txt"), "after\n");
    await chmod(join(integration.path, "modify.txt"), 0o600);
    await rm(join(integration.path, "delete.bin"));
    await writeFile(
      join(integration.path, "create.bin"),
      Buffer.from([255, 0, 128]),
    );

    assert.equal(
      await readFile(join(f.root, "modify.txt"), "utf8"),
      "before\n",
    );
    const result = await backend.apply(f.output, integration, true);
    assert.equal(result.status, "preview");
    assert.deepEqual(
      result.changes.map((change) => [change.type, change.path]),
      [
        ["create", "create.bin"],
        ["delete", "delete.bin"],
        ["modify", "modify.txt"],
      ],
    );
    await assert.rejects(readFile(join(f.root, "create.bin")));
    assert.equal(
      await readFile(join(f.root, "modify.txt"), "utf8"),
      "before\n",
    );

    await writeFile(
      join(f.output, "summary.json"),
      JSON.stringify({ status: "VERIFIED_SUCCESS" }),
    );
    assert.equal((await applyWorkspaceRun(f.output)).status, "APPLIED");
    assert.deepEqual(
      await readFile(join(f.root, "create.bin")),
      Buffer.from([255, 0, 128]),
    );
    assert.equal(await readFile(join(f.root, "modify.txt"), "utf8"), "after\n");
    assert.deepEqual(await revertWorkspaceRun(f.output), {
      status: "REVERTED",
      conflicts: [],
    });
    assert.equal(
      await readFile(join(f.root, "modify.txt"), "utf8"),
      "before\n",
    );
    assert.deepEqual(
      await readFile(join(f.root, "delete.bin")),
      Buffer.from([0, 1, 2, 255]),
    );
    await assert.rejects(readFile(join(f.root, "create.bin")));
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

test("filesystem Stable mutations use the immutable snapshot for diff and progress without Git", async () => {
  const f = await sandbox("koda-stable-filesystem-diff-");
  try {
    await writeFile(join(f.root, "write.txt"), "before\n");
    await writeFile(join(f.root, "shell.txt"), "before\n");
    await writeFile(join(f.root, "deleted.txt"), "remove me\n");
    const logger = new Logger(f.output, "stable-filesystem-diff", true);
    const backend = await createWorkspaceBackend(
      f.root,
      join(f.parent, "workspaces"),
      logger,
      false,
    );
    assert.equal(backend.state, "non_git");
    assert.equal(backend.mode, "filesystem");
    const integration = await backend.initialize();
    const scope = new WriteScope(
      ["write.txt", "shell.txt", "created.txt", "deleted.txt"],
      logger,
      "stable",
    );
    const tools = new AgentTools(
      integration.path,
      false,
      10000,
      logger,
      "stable",
      4000,
      scope,
    );

    await tools.execute("write_file", {
      path: "write.txt",
      content: "after\n",
    });
    const writeDiff = await currentDiff(await realpath(integration.path));
    assert.ok(Buffer.byteLength(writeDiff) > 0);
    assert.match(writeDiff, /MODIFY write\.txt/);

    await tools.execute("run_command", {
      command:
        "node -e \"require('node:fs').writeFileSync('shell.txt','shell patch\\n')\"",
    });
    const shellDiff = await currentDiff(integration.path);
    assert.ok(Buffer.byteLength(shellDiff) > 0);
    assert.match(shellDiff, /MODIFY shell\.txt/);

    await tools.execute("write_file", {
      path: "created.txt",
      content: "created\n",
    });
    await tools.execute("run_command", { command: "rm deleted.txt" });
    assert.deepEqual(
      (await backend.changes(integration.path)).map((change) => [
        change.type,
        change.path,
      ]),
      [
        ["create", "created.txt"],
        ["delete", "deleted.txt"],
        ["modify", "shell.txt"],
        ["modify", "write.txt"],
      ],
    );
    await assert.rejects(realpath(join(integration.path, ".git")));

    const empty = verificationResult([]);
    const progress = new ProgressTracker().assess(
      empty,
      empty,
      await currentDiff(integration.path),
      ["write_file:write.txt"],
      false,
      [],
      true,
    );
    assert.equal(progress.workspaceProgress, true);
    assert.equal(progress.measurableProgress, true);
    assert.equal(progress.escalate, false);
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

test("apply detects original-workspace races before writing any path", async () => {
  const f = await sandbox();
  try {
    await writeFile(join(f.root, "a.txt"), "a0");
    await writeFile(join(f.root, "b.txt"), "b0");
    const backend = await createWorkspaceBackend(
      f.root,
      join(f.parent, "workspaces"),
      new Logger(f.output, "test", true),
      true,
    );
    const integration = await backend.initialize();
    await writeFile(join(integration.path, "a.txt"), "agent-a");
    await writeFile(join(integration.path, "b.txt"), "agent-b");
    await writeFile(join(f.root, "a.txt"), "user-a");
    const result = await backend.apply(f.output, integration, true);
    assert.equal(result.status, "conflict");
    assert.deepEqual(result.conflicts, ["a.txt"]);
    assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "user-a");
    assert.equal(await readFile(join(f.root, "b.txt"), "utf8"), "b0");
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

test("apply treats a user-created destination as a conflict", async () => {
  const f = await sandbox();
  try {
    const backend = await createWorkspaceBackend(
      f.root,
      join(f.parent, "workspaces"),
      new Logger(f.output, "test", true),
      false,
    );
    const integration = await backend.initialize();
    await writeFile(join(integration.path, "new.ts"), "agent");
    assert.equal(
      (await backend.apply(f.output, integration, true)).status,
      "preview",
    );
    await writeFile(
      join(f.output, "summary.json"),
      JSON.stringify({ status: "VERIFIED_SUCCESS" }),
    );
    await writeFile(join(f.root, "new.ts"), "user");
    const result = await applyWorkspaceRun(f.output);
    assert.equal(result.status, "APPLY_CONFLICT");
    assert.deepEqual(result.conflicts, ["new.ts"]);
    assert.equal(await readFile(join(f.root, "new.ts"), "utf8"), "user");
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

test("apply treats a user-modified deletion target as a conflict", async () => {
  const f = await sandbox();
  try {
    await writeFile(join(f.root, "remove.ts"), "baseline");
    const backend = await createWorkspaceBackend(
      f.root,
      join(f.parent, "workspaces"),
      new Logger(f.output, "test", true),
      true,
    );
    const integration = await backend.initialize();
    await rm(join(integration.path, "remove.ts"));
    await writeFile(join(f.root, "remove.ts"), "user");
    const result = await backend.apply(f.output, integration, true);
    assert.equal(result.status, "conflict");
    assert.deepEqual(result.conflicts, ["remove.ts"]);
    assert.equal(await readFile(join(f.root, "remove.ts"), "utf8"), "user");
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

test("revert refuses to overwrite edits made after apply", async () => {
  const f = await sandbox();
  try {
    await writeFile(join(f.root, "value.txt"), "one");
    const backend = await createWorkspaceBackend(
      f.root,
      join(f.parent, "workspaces"),
      new Logger(f.output, "test", true),
      true,
    );
    const integration = await backend.initialize();
    await writeFile(join(integration.path, "value.txt"), "two");
    assert.equal(
      (await backend.apply(f.output, integration, true)).status,
      "applied",
    );
    await writeFile(join(f.root, "value.txt"), "three");
    assert.deepEqual(await revertWorkspaceRun(f.output), {
      status: "REVERT_CONFLICT",
      conflicts: ["value.txt"],
    });
    assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), "three");
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

test("dirty Git uses the filesystem backend and preserves tracked and untracked baseline content", async () => {
  const f = await sandbox();
  try {
    await writeFile(join(f.root, "tracked.txt"), "committed");
    await git(f.root, "init");
    await git(f.root, "config", "user.name", "Fixture");
    await git(f.root, "config", "user.email", "fixture@localhost");
    await git(f.root, "add", ".");
    await git(f.root, "commit", "-m", "initial");
    await writeFile(join(f.root, "tracked.txt"), "dirty");
    await writeFile(join(f.root, "untracked.txt"), "local");
    const backend = await createWorkspaceBackend(
      f.root,
      join(f.parent, "workspaces"),
      new Logger(f.output, "test", true),
      false,
    );
    assert.equal(backend.state, "dirty_git");
    assert.equal(backend.mode, "filesystem");
    const integration = await backend.initialize();
    assert.equal(
      await readFile(join(integration.path, "tracked.txt"), "utf8"),
      "dirty",
    );
    assert.equal(
      await readFile(join(integration.path, "untracked.txt"), "utf8"),
      "local",
    );
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

test("filesystem workers integrate independent parallel changes deterministically", async () => {
  const f = await sandbox();
  try {
    await writeFile(join(f.root, "a.txt"), "a0");
    await writeFile(join(f.root, "b.txt"), "b0");
    const backend = await createWorkspaceBackend(
      f.root,
      join(f.parent, "workspaces"),
      new Logger(f.output, "test", true),
      false,
    );
    const integration = await backend.initialize();
    const [a, b] = await Promise.all([
      backend.createWorker("a"),
      backend.createWorker("b"),
    ]);
    await Promise.all([
      writeFile(join(a.path, "a.txt"), "a1"),
      writeFile(join(b.path, "b.txt"), "b1"),
    ]);
    const [revisionA, revisionB] = await Promise.all([
      backend.finalizeWorker(a, "a"),
      backend.finalizeWorker(b, "b"),
    ]);
    await Promise.all([
      backend.integrate(revisionB, "b"),
      backend.integrate(revisionA, "a"),
    ]);
    assert.equal(await readFile(join(integration.path, "a.txt"), "utf8"), "a1");
    assert.equal(await readFile(join(integration.path, "b.txt"), "utf8"), "b1");
    assert.deepEqual(
      (await backend.changes(integration.path)).map((change) => change.path),
      ["a.txt", "b.txt"],
    );
    assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "a0");
    assert.equal(await readFile(join(f.root, "b.txt"), "utf8"), "b0");
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

test("failed verification never applies a prepared filesystem change", async () => {
  const f = await sandbox();
  try {
    await writeFile(join(f.root, "value.txt"), "original");
    const backend = await createWorkspaceBackend(
      f.root,
      join(f.parent, "workspaces"),
      new Logger(f.output, "test", true),
      true,
    );
    const integration = await backend.initialize();
    await writeFile(join(integration.path, "value.txt"), "unverified");
    const result = await backend.apply(f.output, integration, false);
    assert.equal(result.status, "not_verified");
    assert.equal(await readFile(join(f.root, "value.txt"), "utf8"), "original");
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

test("clean Git keeps the worktree backend", async () => {
  const f = await sandbox();
  try {
    await writeFile(join(f.root, "tracked.txt"), "committed");
    await mkdir(join(f.root, "dist"));
    await writeFile(
      join(f.root, "dist", "tracked-source.js"),
      "committed output",
    );
    await git(f.root, "init");
    await git(f.root, "config", "user.name", "Fixture");
    await git(f.root, "config", "user.email", "fixture@localhost");
    await git(f.root, "add", ".");
    await git(f.root, "commit", "-m", "initial");
    const backend = await createWorkspaceBackend(
      f.root,
      join(f.parent, "workspaces"),
      new Logger(f.output, "test", true),
      false,
    );
    assert.equal(backend.state, "clean_git");
    assert.equal(backend.mode, "git");
    assert.ok(backend.baseline.files["dist/tracked-source.js"]);
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

test("filesystem traversal is bounded, ignores generated trees and rejects aliases", async () => {
  const f = await sandbox();
  try {
    await writeFile(join(f.root, "source.js"), "export {};");
    await mkdir(join(f.root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(f.root, "node_modules", "pkg", "huge.js"), "ignored");
    await mkdir(join(f.root, ".venv", "lib"), { recursive: true });
    await writeFile(join(f.root, ".venv", "lib", "huge.py"), "ignored");
    await mkdir(join(f.root, ".next", "cache"), { recursive: true });
    await writeFile(join(f.root, ".next", "cache", "huge.bin"), "ignored");
    assert.deepEqual(await listWorkspaceFiles(f.root), ["source.js"]);
    await writeFile(join(f.root, "other.js"), "export {};");
    await assert.rejects(
      snapshotTree(f.root, {
        maxFiles: 1,
        maxFileBytes: 1024,
        maxTotalBytes: 2048,
      }),
      /file_count/,
    );
    await rm(join(f.root, "other.js"));
    await writeFile(join(f.parent, "outside.txt"), "outside");
    await symlink("../outside.txt", join(f.root, "alias.js"));
    await assert.rejects(snapshotTree(f.root), /symlink alias\.js/);
    assert.equal(
      await readFile(join(f.parent, "outside.txt"), "utf8"),
      "outside",
    );
    await rm(join(f.root, "alias.js"));
    await link(join(f.root, "source.js"), join(f.root, "hard.js"));
    await assert.rejects(snapshotTree(f.root), /hardlink/);
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

test("non-Git JavaScript and Python repositories produce normalized profiles", async () => {
  const js = await sandbox("koda-js-profile-");
  const py = await sandbox("koda-py-profile-");
  try {
    await writeFile(
      join(js.root, "package.json"),
      '{"scripts":{"test":"node --test"}}',
    );
    await writeFile(join(js.root, "calc.js"), "export const add=(a,b)=>a+b;");
    await writeFile(join(js.root, ".env.local"), "TOKEN=do-not-send");
    await writeFile(
      join(py.root, "pyproject.toml"),
      '[project]\nname="sample"\nversion="1.0.0"\n',
    );
    await writeFile(join(py.root, "calc.py"), "def add(a, b): return a + b\n");
    const [jsProfile, pyProfile] = await Promise.all([
      profileRepo(js.root),
      profileRepo(py.root),
    ]);
    assert.equal(jsProfile.commit, "");
    assert.equal(jsProfile.ecosystem?.ecosystem, "javascript");
    assert.deepEqual(jsProfile.files.sort(), ["calc.js", "package.json"]);
    assert.equal(pyProfile.commit, "");
    assert.equal(pyProfile.ecosystem?.ecosystem, "python");
    assert.ok(pyProfile.files.includes("calc.py"));
  } finally {
    await Promise.all([
      rm(js.parent, { recursive: true, force: true }),
      rm(py.parent, { recursive: true, force: true }),
    ]);
  }
});

test("non-Git DIRECT run edits, verifies and leaves the original unchanged in preview mode", async () => {
  const f = await sandbox("koda-direct-nongit-");
  await writeFile(
    join(f.root, "package.json"),
    '{"scripts":{"test":"node --test"},"type":"module"}',
  );
  await writeFile(join(f.root, "calc.js"), "export const add=(a,b)=>a-b;\n");
  await writeFile(
    join(f.root, "calc.test.js"),
    "import {test} from 'node:test';import assert from 'node:assert/strict';import {add} from './calc.js';test('add',()=>assert.equal(add(2,3),5));\n",
  );
  const coderRequests: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    coderRequests.push(body);
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
                      path: "calc.js",
                      content: "export const add=(a,b)=>a+b;\n",
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const cfg = await config(undefined, {
      models: {},
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      maxIterations: 2,
    });
    const result = await run({
      repo: f.root,
      task: "Change calc.js addition from subtraction to addition.",
      config: cfg,
      output: f.output,
      quiet: true,
    });
    assert.equal(result.status, "VERIFIED_SUCCESS");
    assert.equal(result.workspace?.backend, "filesystem");
    assert.equal(result.execution_strategy, "direct");
    assert.equal(result.execution_effort, "tiny");
    assert.equal(result.coderModelCalls, 1);
    assert.deepEqual(result.workerContexts[0]?.context_files, ["calc.js"]);
    assert.match(coderRequests[0].messages[1].content, /a-b/);
    assert.ok(
      result.verification.checks.some((check: any) =>
        check.command.includes("test"),
      ),
    );
    assert.equal(result.applyResult, "preview");
    assert.equal(result.finalVerificationStatus, "VERIFIED_SUCCESS");
    assert.equal(
      await readFile(join(f.root, "calc.js"), "utf8"),
      "export const add=(a,b)=>a-b;\n",
    );
    assert.equal(
      await readFile(join(result.integration!.path, "calc.js"), "utf8"),
      "export const add=(a,b)=>a+b;\n",
    );

    const failed = await run({
      repo: f.root,
      task: "Change calc.js addition from subtraction to addition.",
      verify: ["node -e \"import('./calc.js').then(({add})=>process.exit(Number(add(2,3)===5)))\""],
      config: cfg,
      output: join(f.parent, "failed-output"),
      apply: true,
      quiet: true,
    });
    assert.equal(failed.status, "FAILED");
    assert.equal(failed.applyResult, "not_verified");
    assert.equal(failed.candidateProduced, true);
    assert.deepEqual(failed.candidateChangedFiles, ["calc.js"]);
    assert.equal(failed.candidatePatchPath, join(f.parent, "failed-output", "candidate.patch"));
    const candidatePatch = await readFile(failed.candidatePatchPath, "utf8");
    assert.match(
      candidatePatch,
      /-export const add=\(a,b\)=>a-b;[\s\S]*\+export const add=\(a,b\)=>a\+b;/,
    );
    assert.doesNotMatch(candidatePatch, /koda-workspaces|koda-nongit/);
    assert.equal(
      await readFile(join(f.root, "calc.js"), "utf8"),
      "export const add=(a,b)=>a-b;\n",
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(f.parent, { recursive: true, force: true });
  }
});

test("localized README dogfood task is DIRECT and makes zero planner calls", async () => {
  const f = await sandbox("koda-readme-direct-");
  await writeFile(join(f.root, "README.md"), "# Sample\n\n## Run\n");
  await writeFile(
    join(f.root, "package.json"),
    JSON.stringify({
      packageManager: "pnpm@11.7.0",
      scripts: {
        test: "node --test smoke.test.cjs",
        typecheck: "tsc --noEmit",
        lint: "node check-readme.cjs README.md",
      },
      devDependencies: { typescript: "1" },
    }),
  );
  await writeFile(join(f.root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(
    join(f.root, "smoke.test.cjs"),
    "const {test}=require('node:test');test('smoke',()=>{});\n",
  );
  await writeFile(
    join(f.root, "check-readme.cjs"),
    "const fs=require('node:fs');if(!fs.readFileSync('README.md','utf8').includes('Workspace safety'))process.exit(1);\n",
  );
  await mkdir(join(f.root, "node_modules/.bin"), { recursive: true });
  await writeFile(join(f.root, "node_modules/.bin/tsc"), "#!/bin/sh\nexit 0\n");
  await chmod(join(f.root, "node_modules/.bin/tsc"), 0o755);
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    assert.ok(!body.messages[0].content.startsWith("Compile"));
    if (requests.length === 1) {
      const input = JSON.parse(body.messages[1].content);
      assert.deepEqual(input.allowed_write_paths, ["README.md"]);
    }
    const calls = [
      {
        id: "edit-readme",
        name: "write_file",
        arguments: {
          path: "README.md",
          content:
            "# Sample\n\n## Run\n\n- Workspace safety: previews do not modify the original project directory.\n",
        },
      },
    ];
    const next = calls[requests.length - 1]!;
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
                  id: next.id,
                  type: "function",
                  function: {
                    name: next.name,
                    arguments: JSON.stringify(next.arguments),
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await run({
      repo: f.root,
      task: "In README.md, add one Workspace safety bullet. Make no other changes.",
      config: await config(undefined, {
        models: {},
        baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
        maxIterations: 6,
      }),
      output: f.output,
      quiet: true,
    });
    assert.equal(result.status, "VERIFIED_SUCCESS", JSON.stringify(result));
    assert.equal(result.workspace?.backend, "filesystem");
    assert.equal(result.execution_strategy, "direct");
    assert.equal(result.execution_effort, "tiny");
    assert.equal(result.strategy_reason, "One explicit localized file target");
    assert.equal(result.plannerModelCalls, 0);
    assert.equal(result.coderModelCalls, 1);
    assert.equal(result.totalModelCalls, 1);
    assert.equal(result.escalations, 0);
    assert.equal(result.toolCalls, 1);
    assert.equal(result.finalVerificationStatus, "VERIFIED_SUCCESS");
    assert.equal(result.applyResult, "preview");
    assert.equal(requests.length, 1);
    assert.ok(requests[0].tools.some((tool: any) =>
      tool.function.name === "write_file"));
    assert.deepEqual(result.workerContexts[0]?.context_files, ["README.md"]);
    assert.deepEqual(result.workerScopes[0]?.allowed_write_paths, [
      "README.md",
    ]);
    assert.match(JSON.stringify(JSON.parse(requests[0].messages[1].content).context.files),
      /Workspace safety|# Sample/);
    assert.deepEqual(
      result.verification.checks.map((check: any) => check.command),
      ["pnpm run lint", "internal:tiny-documentation-structure"],
    );
    assert.equal(result.verificationCalls, 1);
    const events = (await readFile(join(f.output, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      events.filter((event) => event.type === "verification").length,
      0,
    );
    assert.ok(
      events.findIndex((event) => event.type === "final_verification") >
        events.findIndex((event) => event.type === "model_call"),
    );
    assert.ok(
      !events.some(
        (event) =>
          (event.type === "verification" ||
            event.type === "final_verification") &&
          /(?:test|typecheck)/.test(event.command ?? ""),
      ),
    );
    assert.deepEqual(result.changedFiles, ["README.md"]);
    assert.match(
      await readFile(join(result.integration!.path, "README.md"), "utf8"),
      /Workspace safety/,
    );
    assert.equal(
      await readFile(join(f.root, "README.md"), "utf8"),
      "# Sample\n\n## Run\n",
    );
    assert.equal(
      await readFile(join(f.root, "node_modules/.bin/tsc"), "utf8"),
      "#!/bin/sh\nexit 0\n",
    );
    await writeFile(
      join(f.root, "package.json"),
      JSON.stringify({ scripts: { test: "node --test smoke.test.cjs" } }),
    );
    requests.length = 0;
    const noDocumentCheck = await run({
      repo: f.root,
      task: "In README.md, add one Workspace safety bullet. Make no other changes.",
      config: await config(undefined, {
        models: {},
        baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      }),
      output: join(f.parent, "no-document-check"),
      quiet: true,
    });
    assert.equal(noDocumentCheck.status, "VERIFIED_SUCCESS");
    assert.equal(noDocumentCheck.verificationCalls, 1);
    assert.equal(noDocumentCheck.coderModelCalls, 1);
    assert.deepEqual(noDocumentCheck.changedFiles, ["README.md"]);
    assert.equal(
      noDocumentCheck.verification.checks[0]?.command,
      "internal:tiny-documentation-structure",
    );
    assert.match(
      noDocumentCheck.verification.checks[0]?.stdout ?? "",
      /prose meaning was not checked/,
    );
    assert.equal(
      await readFile(join(f.root, "README.md"), "utf8"),
      "# Sample\n\n## Run\n",
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(f.parent, { recursive: true, force: true });
  }
});

test("large README TINY request uses a bounded edit_file window and preserves surrounding bytes", async () => {
  const f = await sandbox("koda-tiny-large-readme-");
  const oldText = "Previews can alter the original project.";
  const newText = "Previews leave the original project unchanged.";
  const original = `# Workspace\n${"Existing introduction line.\n".repeat(500)}## Workspace safety\n${oldText}\n${"Existing reference line.\n".repeat(550)}END OF README\n`;
  await writeFile(join(f.root, "README.md"), original);
  await writeFile(
    join(f.root, "package.json"),
    JSON.stringify({ scripts: { test: "node --test tests/*.test.cjs" } }),
  );
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith("/models")) {
      res.end(JSON.stringify({ data: [{ id: "frontier", context_length: 100000,
        pricing: { prompt: "0.000001", completion: "0.000002" },
        supported_parameters: ["tools", "tool_choice", "structured_outputs"] }] }));
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    res.end(
      JSON.stringify({
        id: "mock",
        model: "served-low-coder",
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
                    name: "edit_file",
                    arguments: JSON.stringify({
                      path: "README.md",
                      oldText,
                      newText,
                    }),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0001 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await run({
      repo: f.root,
      task: "In README.md, correct the Workspace safety sentence. Make no other changes.",
      config: await config(undefined, {
        modelPool: {
          provider: "openrouter",
          models: [
            {
              id: "frontier",
              tier: "frontier",
              qualityPrior: 0.99,
              latencyPriorMs: 1000,
              strengths: ["coding", "tool_use", "structured_output"],
            },
          ],
        },
        adaptiveCoding: true,
        specialistRouting: false,
        baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
        routing: { stateDirectory: join(f.parent, "history") },
        context: {
          maxBytes: 1024,
          fileBytes: 128,
          readBytes: 1024,
          maxPromptBytes: 32768,
        },
      }),
      output: f.output,
      quiet: true,
    });
    assert.equal(result.execution_strategy, "direct");
    assert.equal(result.execution_effort, "tiny");
    assert.equal(result.status, "VERIFIED_SUCCESS", JSON.stringify(result));
    assert.equal(result.coderModelCalls, 1);
    assert.equal(result.escalations, 0);
    assert.equal(result.verificationCalls, 1);
    assert.equal(requests.length, 1);
    assert.ok(requests[0].tools.some((tool: any) =>
      tool.function.name === "edit_file"));
    assert.equal(requests[0].tool_choice, "required");
    assert.equal(requests[0].plugins[0].min_coding_score, 0);
    const payload = JSON.parse(requests[0].messages[1].content);
    assert.ok(Buffer.byteLength(JSON.stringify(requests[0])) < 10000);
    const excerpt = payload.context.files.find((file: any) => file.path === "README.md").snippet;
    assert.ok(Buffer.byteLength(excerpt) <= 4096);
    assert.match(excerpt, /Workspace safety/);
    assert.match(
      excerpt,
      /Previews can alter the original project/,
    );
    assert.ok(!JSON.stringify(requests[0]).includes("END OF README"));
    assert.deepEqual(result.changedFiles, ["README.md"]);
    assert.equal(
      await readFile(join(result.integration!.path, "README.md"), "utf8"),
      original.replace(oldText, newText),
    );
    assert.equal(await readFile(join(f.root, "README.md"), "utf8"), original);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(f.parent, { recursive: true, force: true });
  }
});

test("Pareto endpoint parameter incompatibility falls back without raising TINY quality", async () => {
  const f = await sandbox("koda-tiny-endpoint-fallback-");
  await writeFile(join(f.root, "README.md"), "# Workspace\n");
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith("/models")) {
      res.end(
        JSON.stringify({
          data: [
            {
              id: "compatible",
              context_length: 100000,
              pricing: { prompt: "0.000001", completion: "0.000002" },
              supported_parameters: ["tools", "structured_outputs"],
            },
          ],
        }),
      );
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    if (body.model === "openrouter/pareto-code") {
      res.writeHead(404);
      res.end(
        JSON.stringify({
          error: {
            message:
              "No endpoints found that can handle the requested parameters",
          },
        }),
      );
      return;
    }
    res.end(
      JSON.stringify({
        id: "mock",
        model: "compatible",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "write",
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments: JSON.stringify({
                      path: "README.md",
                      content:
                        "# Workspace\n- Workspace safety: previews preserve the original.\n",
                    }),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0001 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await run({
      repo: f.root,
      task: "In README.md, add one Workspace safety bullet. Make no other changes.",
      config: await config(undefined, {
        modelPool: {
          provider: "openrouter",
          models: [
            {
              id: "compatible",
              tier: "cheap",
              qualityPrior: 0.99,
              latencyPriorMs: 1000,
              strengths: ["coding", "tool_use", "structured_output"],
            },
          ],
        },
        adaptiveCoding: true,
        specialistRouting: false,
        baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
        routing: { stateDirectory: join(f.parent, "history") },
      }),
      output: f.output,
      quiet: true,
    });
    assert.equal(result.status, "VERIFIED_SUCCESS", result.error);
    assert.deepEqual(
      requests.map((request) => request.model),
      ["openrouter/pareto-code", "compatible"],
    );
    assert.ok(
      requests.every(
        (request) =>
          request.tools.map((tool: any) => tool.function.name).join(",") ===
          "write_file",
      ),
    );
    assert.equal(result.escalations, 0);
    assert.equal(result.fallbacks, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(f.parent, { recursive: true, force: true });
  }
});

for (const recover of [true, false]) {
  test(`known-context TINY ${recover ? "recovers after one no-op" : "fails after two no-ops"}`, async () => {
    const f = await sandbox("koda-tiny-tool-policy-");
    await writeFile(join(f.root, "README.md"), "# Sample\n");
    await writeFile(
      join(f.root, "package.json"),
      JSON.stringify({ scripts: { lint: "node check-readme.cjs README.md" } }),
    );
    await writeFile(
      join(f.root, "check-readme.cjs"),
      "if(!require('node:fs').readFileSync('README.md','utf8').includes('Workspace safety'))process.exit(1);\n",
    );
    const requests: any[] = [];
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      requests.push(body);
      const write = recover && requests.length === 2;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "mock",
          model:
            body.model === "openrouter/pareto-code"
              ? "mock-served-coder"
              : body.model,
          choices: [
            {
              index: 0,
              message: write
                ? {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "edit",
                        type: "function",
                        function: {
                          name: "write_file",
                          arguments: JSON.stringify({
                            path: "README.md",
                            content:
                              "# Sample\n- Workspace safety: previews leave the original unchanged.\n",
                          }),
                        },
                      },
                    ],
                  }
                : {
                    role: "assistant",
                    content: "I have not changed anything yet.",
                  },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0 },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const result = await run({
        repo: f.root,
        task: "In README.md, add one Workspace safety bullet. Make no other changes.",
        config: await config(undefined, {
          models: {},
          adaptiveCoding: recover,
          specialistRouting: false,
          modelPool: recover
            ? {
                provider: "openrouter",
                models: [
                  {
                    id: "frontier",
                    tier: "frontier",
                    qualityPrior: 0.99,
                    latencyPriorMs: 1000,
                    strengths: ["coding", "tool_use", "structured_output"],
                  },
                ],
              }
            : undefined,
          routing: { stateDirectory: join(f.parent, "history") },
          baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
          maxIterations: 2,
        }),
        output: f.output,
        quiet: true,
      });
      assert.equal(result.execution_effort, "tiny");
      assert.equal(result.coderModelCalls, 2, "one bounded recovery follows the first TINY no-op");
      assert.equal(result.plannerModelCalls, 0);
      assert.ok(
        requests.every((request) => request.tool_choice === "required"),
      );
      assert.ok(requests.every((request) => request.tools.some((tool: any) =>
        tool.function.name === "write_file")));
      if (recover)
        assert.deepEqual(
          requests.map((request) => request.plugins?.[0]?.min_coding_score),
          [0, 0.33],
        );
      const events = (await readFile(join(f.output, "events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(
        events.filter(
          (event) =>
            event.type === "tool" &&
            /^(?:read_file|search_code|run_command|git_diff|git_status)$/.test(
              event.name ?? "",
            ),
        ).length,
        0,
      );
      assert.equal(result.status, recover ? "VERIFIED_SUCCESS" : "FAILED");
      assert.equal(result.toolCalls, recover ? 1 : 0);
      assert.deepEqual(result.changedFiles, recover ? ["README.md"] : []);
      if (!recover)
        assert.match(
          result.error ?? "",
          /Tiny direct task produced no mutation/,
        );
      assert.equal(
        await readFile(join(f.root, "README.md"), "utf8"),
        "# Sample\n",
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(f.parent, { recursive: true, force: true });
    }
  });
}

test("verification infrastructure failure stops before model escalation", async () => {
  const f = await sandbox("koda-infra-stop-");
  await writeFile(join(f.root, "README.md"), "# Sample\n");
  await writeFile(
    join(f.root, "package.json"),
    JSON.stringify({ scripts: { test: "node infra.cjs" } }),
  );
  await writeFile(
    join(f.root, "infra.cjs"),
    "console.error(\"Error: listen EINVAL; syscall: 'listen'; address: '/too/long/tsx-501/31066.pipe'\");process.exit(1);\n",
  );
  try {
    const result = await run({
      repo: f.root,
      task: "Fix the outdated Workspace safety bullet in README.md.",
      config: await config(undefined, {
        models: {},
        baseUrl: "http://127.0.0.1:1/v1",
      }),
      output: f.output,
      quiet: true,
    });
    assert.equal(result.status, "NOT_FULLY_VERIFIED");
    assert.match(result.error ?? "", /Verification infrastructure unavailable/);
    assert.equal(result.plannerModelCalls, 0);
    assert.equal(result.coderModelCalls, 0);
    assert.equal(result.escalations, 0);
    assert.equal(
      result.subtaskVerification.direct.checks[0]!.outcome,
      "INFRA_FAILURE",
    );
    assert.equal(
      await readFile(join(f.root, "README.md"), "utf8"),
      "# Sample\n",
    );
  } finally {
    await rm(f.parent, { recursive: true, force: true });
  }
});

test("non-Git deterministic plan runs independent filesystem workers in parallel", async () => {
  const f = await sandbox("koda-parallel-nongit-");
  await mkdir(join(f.root, "src"));
  await mkdir(join(f.root, "test"));
  await writeFile(
    join(f.root, "package.json"),
    '{"scripts":{"test":"node --test test/*.test.js"},"type":"module"}',
  );
  for (const id of ["a", "b", "c"]) {
    await writeFile(
      join(f.root, `src/${id}.js`),
      `export function ${id}(){return 0}\n`,
    );
    await writeFile(
      join(f.root, `test/${id}.test.js`),
      `import {test} from 'node:test';import assert from 'node:assert/strict';import {${id}} from '../src/${id}.js';test('${id}',()=>assert.equal(${id}(),1));\n`,
    );
  }
  const pool = {
    provider: "openrouter",
    models: [
      {
        id: "fast",
        tier: "fast",
        qualityPrior: 0.95,
        latencyPriorMs: 1000,
        strengths: ["coding", "tool_use", "structured_output"],
      },
    ],
  };
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith("/models")) {
      res.end(
        JSON.stringify({
          data: [
            {
              id: "fast",
              context_length: 100000,
              pricing: { prompt: "0.0000001", completion: "0.0000002" },
              supported_parameters: ["tools", "structured_outputs"],
            },
          ],
        }),
      );
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    assert.ok(!body.messages[0].content.startsWith("Compile"));
    const input = JSON.parse(body.messages[1].content);
    const path = input.subtask.likelyWritePaths[0] as string;
    const id = path.match(/([abc])\.js$/)![1];
    await new Promise((resolve) => setTimeout(resolve, 40));
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
                  id: `edit-${id}`,
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments: JSON.stringify({
                      path,
                      content: `export function ${id}(){return 1}\n`,
                    }),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.00001 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const cfg = await config(undefined, {
      modelPool: pool,
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      routing: { stateDirectory: join(f.parent, "history") },
      maxParallel: 3,
      budgetUsd: 0.1,
    });
    const result = await run({
      repo: f.root,
      task: "Fix src/a.js, src/b.js and src/c.js so all tests pass. These are independent bugs.",
      config: cfg,
      output: f.output,
      quiet: true,
    });
    assert.equal(result.status, "VERIFIED_SUCCESS", result.error);
    assert.equal(result.workspace?.state, "non_git");
    assert.equal(result.workspace?.backend, "filesystem");
    assert.equal(result.execution_strategy, "planned");
    assert.equal(result.planning.planner_strategy, "deterministic");
    assert.equal(result.plannerModelCalls, 0);
    assert.equal(result.coderExecutions, 3);
    assert.equal(requests.length, 3);
    assert.ok(result.maxConcurrentCodingWorkers >= 2);
    assert.equal(result.finalVerificationStatus, "VERIFIED_SUCCESS");
    assert.equal(
      new Set(result.workerScopes.flatMap((scope) => scope.allowed_write_paths))
        .size,
      3,
    );
    for (const id of ["a", "b", "c"])
      assert.equal(
        await readFile(join(f.root, `src/${id}.js`), "utf8"),
        `export function ${id}(){return 0}\n`,
      );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(f.parent, { recursive: true, force: true });
  }
});

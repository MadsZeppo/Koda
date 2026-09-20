import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  mkdir,
  symlink,
  rm,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { createServer } from "node:net";
import { validateDag, readyTasks, overlap } from "../src/orchestrator/dag.js";
import { schedule } from "../src/orchestrator/scheduler.js";
import { router } from "../src/router/router.js";
import { ProgressTracker } from "../src/router/progress.js";
import { Budget, parseUsage } from "../src/openrouter/usage.js";
import { Worktrees } from "../src/worktrees/manager.js";
import { git, command } from "../src/repo/commands.js";
import { advisoryInfrastructureOnly, verificationResult, verify } from "../src/verifier/verifier.js";
import {
  repoBackedVerificationCommands,
  workerChecks,
} from "../src/verifier/selection.js";
import { safePath } from "../src/agent/tools.js";
import type { Subtask } from "../src/planner/schemas.js";
export const task = (
  id: string,
  dependsOn: string[] = [],
  path = id,
): Subtask => ({
  id,
  title: id,
  objective: id,
  dependsOn,
  likelyReadPaths: [path],
  likelyWritePaths: [path],
  integrationContract: id,
  verificationCommands: [],
  estimatedDifficulty: "normal",
  parallelSafe: true,
});
export async function fixture() {
  const repo = await mkdtemp(join(tmpdir(), "koda-test-"));
  await git(repo, "init");
  await git(repo, "config", "user.name", "Test");
  await git(repo, "config", "user.email", "test@localhost");
  await writeFile(join(repo, "seed.txt"), "seed");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "fixture");
  return repo;
}
const check = (n: number) =>
  verificationResult([
    {
      command: "test",
      stdout: `# fail ${n}`,
      stderr: "",
      exitCode: n ? 1 : 0,
      timedOut: false,
      wallClockMs: 1,
    },
  ]);
test("DAG rejects cycles, unknown dependencies, unsafe paths and duplicate IDs", () => {
  for (const subtasks of [
    [task("a", ["b"]), task("b", ["a"])],
    [task("a", ["missing"])],
    [task("a"), task("a")],
    [task("a", [], "../x")],
  ])
    assert.throws(() =>
      validateDag({
        taskSummary: "test",
        acceptanceCriteria: ["works"],
        subtasks,
      }),
    );
  assert.deepEqual(
    readyTasks([task("a"), task("b", ["a"])], new Set(), new Set(), []).map(
      (t) => t.id,
    ),
    ["a"],
  );
});
test("acceptance checks reject undiscovered runners and retain executable repo evidence", () => {
  const profile = {
    files: ["src/run.ts", "tests/core.test.ts", "package.json"],
    scripts: { test: "tsx --test tests/*.test.ts", typecheck: "tsc --noEmit" },
    verificationCommands: ["pnpm run test", "pnpm run typecheck"],
    ecosystem: {
      projectUnits: [
        {
          root: ".",
          verification: [
            {
              kind: "test",
              command: "pnpm run test",
              available: true,
              cwd: ".",
              source: "package.json:scripts.test",
              confidence: 1,
              mutatesSource: false,
              requiresInstalledDependencies: true,
            },
            {
              kind: "typecheck",
              command: "pnpm run typecheck",
              available: true,
              cwd: ".",
              source: "package.json:scripts.typecheck",
              confidence: 1,
              mutatesSource: false,
              requiresInstalledDependencies: true,
            },
            {
              kind: "test",
              command: "pnpm exec vitest run tests/core.test.ts",
              available: false,
              reason: "dependencies_not_available",
              cwd: ".",
              source: "model",
              confidence: 0,
              mutatesSource: false,
              requiresInstalledDependencies: true,
            },
          ],
        },
      ],
    },
  } as any;
  const proposed = [
    "pnpm exec vitest run tests/core.test.ts",
    "pnpm run test",
    "pnpm run typecheck",
  ];
  assert.deepEqual(repoBackedVerificationCommands(proposed, profile), [
    "pnpm run test",
    "pnpm run typecheck",
  ]);
  assert.deepEqual(
    workerChecks(
      {
        ...task("fix", [], "src/run.ts"),
        verificationCommands: ["pnpm exec vitest run tests/core.test.ts"],
      },
      profile,
      { files: [], bytes: 0, truncated: false } as any,
    ),
    [],
  );
});
test("scheduler starts independent work concurrently, waits for dependency and serializes overlapping writes", async () => {
  let active = 0,
    peak = 0;
  const completed: string[] = [];
  await schedule(
    [task("a"), task("b"), task("c", ["a"]), task("d", [], "a")],
    3,
    async (t) => {
      if (t.id === "c") assert.ok(completed.includes("a"));
      if (t.id === "d") assert.ok(completed.includes("a"));
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      completed.push(t.id);
    },
  );
  assert.ok(peak >= 2);
  assert.ok(overlap(task("a", [], "src"), task("b", [], "src/a.ts")));
  assert.ok(overlap(task("a", [], "src/*"), task("b", [], "other")));
});
test("failed dependencies never execute; running workers drain", async () => {
  const seen: string[] = [];
  await assert.rejects(
    schedule([task("a"), task("b", ["a"]), task("c")], 2, async (t) => {
      seen.push(t.id);
      if (t.id === "a") throw Error("failure");
      await new Promise((r) => setTimeout(r, 5));
    }),
  );
  assert.ok(!seen.includes("b"));
});
test("routing ladder and measurable progress", () => {
  assert.equal(router.escalate("CHEAP_CODER_B"), "STRONG_MODEL");
  assert.equal(router.escalate("STRONG_MODEL"), "FRONTIER_MODEL");
  assert.equal(router.escalate("FRONTIER_MODEL"), null);
  const p = new ProgressTracker();
  assert.equal(
    p.assess(check(3), check(2), "patch", []).measurableProgress,
    true,
  );
  assert.equal(p.assess(check(2), check(2), "patch", []).escalate, false);
  assert.equal(p.assess(check(2), check(2), "patch", []).escalate, true);
});
test("novel inspection evidence permits read then locate before a verified write", () => {
  const p = new ProgressTracker();
  assert.equal(
    p.assess(check(2), check(2), "", ["read_file:README.md"], false, [
      "read_file:README.md",
    ]).escalate,
    false,
  );
  assert.equal(
    p.assess(check(2), check(2), "", ["search_code:Workspace"], false, [
      "search_code:new-result",
    ]).escalate,
    false,
  );
  assert.equal(
    p.assess(check(2), check(1), "README patch", ["write_file:README.md"])
      .verificationProgress,
    true,
  );
});
test("repeated evidence stalls and novel inspection has a hard bound", () => {
  const repeated = new ProgressTracker();
  repeated.assess(check(2), check(2), "", [], false, ["read:a"]);
  assert.equal(
    repeated.assess(check(2), check(2), "", [], false, ["read:a"]).escalate,
    false,
  );
  assert.equal(
    repeated.assess(check(2), check(2), "", [], false, ["read:a"]).escalate,
    true,
  );

  const endless = new ProgressTracker();
  for (let i = 0; i < ProgressTracker.maxEvidenceProgressCycles; i++)
    assert.equal(
      endless.assess(check(2), check(2), "", [], false, [`read:${i}`]).escalate,
      false,
    );
  assert.equal(
    endless.assess(check(2), check(2), "", [], false, ["read:next"]).escalate,
    false,
  );
  assert.equal(
    endless.assess(check(2), check(2), "", [], false, ["read:last"]).escalate,
    true,
  );
});
test("read progress distinguishes new ranges but deduplicates identical ranges", async () => {
  const { AgentTools } = await import("../src/agent/tools.js");
  const { Logger } = await import("../src/telemetry/logger.js");
  const root = await mkdtemp(join(tmpdir(), "koda-read-progress-"));
  try {
    await writeFile(join(root, "README.md"), "one\ntwo\nthree\nfour\n");
    const tools = new AgentTools(
      root,
      true,
      10000,
      new Logger(join(root, "logs"), "ranges", true),
      "ranges",
    );
    await tools.execute("read_file", {
      path: "README.md",
      startLine: 1,
      endLine: 2,
    });
    await tools.execute("read_file", {
      path: "README.md",
      startLine: 1,
      endLine: 2,
    });
    await tools.execute("read_file", {
      path: "README.md",
      startLine: 3,
      endLine: 4,
    });
    assert.equal(tools.progressEvidence[0], tools.progressEvidence[1]);
    assert.notEqual(tools.progressEvidence[1], tools.progressEvidence[2]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("usage retains exact charged cost and all cache counters", () => {
  const u = parseUsage({
    prompt_tokens: 20,
    completion_tokens: 8,
    cost: 0.003,
    completion_tokens_details: { reasoning_tokens: 4 },
    prompt_tokens_details: { cached_tokens: 10, cache_write_tokens: 3 },
  });
  assert.equal(u.costUsd, 0.003);
  assert.equal(u.cacheWriteTokens, 3);
  assert.equal(u.reasoningTokens, 4);
  assert.equal(parseUsage({}).costUsd, null);
});
test("budget reserves concurrent requests, enforces tokens/time, and fails closed on unknown cost", () => {
  const b = new Budget(1, 100, 1000);
  const release = b.reserve(0.7, 60);
  assert.throws(() => b.reserve(0.4, 10));
  assert.throws(() => b.reserve(0.1, 50));
  release(parseUsage({ prompt_tokens: 10, completion_tokens: 10, cost: 0.2 }));
  assert.equal(b.spent, 0.2);
  b.reserve(0.1, 10)();
  assert.throws(() => b.reserve(0.1, 1));
  assert.throws(() => new Budget(1, 100, -1).reserve(0.1, 1));
});
test("worktrees isolate writes, produce commits, and clean up without modifying original checkout", async () => {
  const repo = await fixture();
  const directory = await mkdtemp(join(tmpdir(), "koda-wt-"));
  try {
    const manager = new Worktrees(repo, directory, "unit");
    const wt = await manager.create("a", "HEAD");
    await writeFile(join(wt.path, "seed.txt"), "changed");
    await manager.commit(wt.path, "change");
    assert.equal(await readFile(join(repo, "seed.txt"), "utf8"), "seed");
    await manager.cleanup(wt.path);
    assert.ok(!(await git(repo, "worktree", "list")).includes(wt.path));
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});
test("verification derives status from exit codes, no checks stays unverified", () => {
  assert.equal(verificationResult([]).status, "NOT_FULLY_VERIFIED");
  const passing = check(0),
    failing = check(2),
    unavailable = verificationResult([
      {
        command: "missing-check",
        stdout: "",
        stderr: "dependencies_not_available",
        unavailable: "dependencies_not_available",
        exitCode: 0,
        timedOut: false,
        wallClockMs: 0,
      },
    ]);
  assert.equal(passing.status, "VERIFIED_SUCCESS");
  assert.equal(passing.checks[0]!.outcome, "CHECK_PASS");
  assert.equal(failing.status, "FAILED");
  assert.equal(failing.checks[0]!.outcome, "CHECK_FAIL");
  assert.equal(unavailable.status, "NOT_FULLY_VERIFIED");
  assert.equal(unavailable.checks[0]!.outcome, "CHECK_UNAVAILABLE");
  assert.equal(check(2).failingTests, 2);
});
test("advisory infrastructure is non-blocking only beside required evidence", () => {
  const requiredPass = {
    command: "required-test", stdout: "ok", stderr: "", exitCode: 0,
    timedOut: false, wallClockMs: 1, requirement: "required" as const,
  };
  const unavailable = {
    command: "discovered-extra", stdout: "", stderr: "missing dependency",
    unavailable: "dependencies_not_available", exitCode: 0, timedOut: false,
    wallClockMs: 0, requirement: "advisory" as const,
  };
  const supported = verificationResult([requiredPass, unavailable]);
  assert.equal(supported.status, "VERIFIED_SUCCESS");
  assert.equal(supported.checks[1]!.outcome, "CHECK_UNAVAILABLE");
  assert.equal(verificationResult([unavailable]).status, "NOT_FULLY_VERIFIED");
  assert.equal(
    verificationResult([{ ...unavailable, requirement: "required" }]).status,
    "NOT_FULLY_VERIFIED",
  );
  assert.equal(advisoryInfrastructureOnly(verificationResult([unavailable])), true);
  assert.equal(
    advisoryInfrastructureOnly(
      verificationResult([{ ...unavailable, requirement: "required" }]),
    ),
    false,
  );
});
test("verification candidates carry explicit required and advisory semantics", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-check-requirement-"));
  try {
    const required = {
      kind: "check" as const, command: "node -e \"process.exit(0)\"", cwd: ".",
      source: "task:acceptance", confidence: 1, available: true,
      requirement: "required" as const, mutatesSource: false as const,
      requiresInstalledDependencies: false,
    };
    const advisory = {
      kind: "test" as const, command: "missing-advisory-runner", cwd: ".",
      source: "inferred:test-file convention", confidence: 0.7, available: false,
      reason: "dependencies_not_available", requirement: "advisory" as const,
      mutatesSource: false as const, requiresInstalledDependencies: true,
    };
    const result = await verify(
      root, [required.command, advisory.command], 10000,
      undefined, undefined, [required, advisory],
    );
    assert.equal(result.status, "VERIFIED_SUCCESS");
    assert.equal(result.checks[0]!.requirement, "required");
    assert.equal(result.checks[1]!.requirement, "advisory");
    assert.equal(result.checks[1]!.outcome, "CHECK_UNAVAILABLE");
    const blocked = await verify(
      root, [required.command, advisory.command], 10000,
      undefined, undefined, [required, { ...advisory, requirement: "required" }],
    );
    assert.equal(blocked.status, "NOT_FULLY_VERIFIED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("file tools reject traversal and escaping symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-path-"));
  try {
    await symlink(tmpdir(), join(root, "escape"));
    await assert.rejects(safePath(root, "../outside"));
    await assert.rejects(safePath(root, "escape/secret"));
    await assert.rejects(safePath(root, ".git/config"));
    assert.equal(
      await safePath(root, "src/new.ts"),
      join(
        await import("node:fs/promises").then((f) => f.realpath(root)),
        "src/new.ts",
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("shell sandbox can run tests but denies outside writes and scout writes", async () => {
  const repo = await fixture();
  try {
    const good = await command(repo, 'node -e "console.log(42)"');
    assert.equal(good.exitCode, 0, good.stderr);
    const bad = await command(repo, "echo bad > /tmp/koda-forbidden-write");
    assert.notEqual(bad.exitCode, 0);
    const scout = await command(repo, "echo bad > seed.txt", 10000, true);
    assert.notEqual(scout.exitCode, 0);
    assert.equal(await readFile(join(repo, "seed.txt"), "utf8"), "seed");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("shell sandbox permits loopback test servers but denies external network", async () => {
  const repo = await fixture();
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const result = await command(
      repo,
      `node -e "const s=require('net').connect(${port},'127.0.0.1');s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(2))"`,
      5000,
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const external = await command(
      repo,
      `node -e "const s=require('net').connect(80,'192.0.2.1');s.on('connect',()=>process.exit(2));s.on('error',e=>process.exit(e.code==='EPERM'?0:3));setTimeout(()=>process.exit(4),500)"`,
      5000,
    );
    assert.equal(external.exitCode, 0, external.stderr);
  } finally {
    server.close();
    await rm(repo, { recursive: true, force: true });
  }
});

test("tsx verification uses a short Unix socket path and cleans its temp directory", async () => {
  const { bridgeDependencies } = await import("../src/repo/dependencies.js");
  const parent = await mkdtemp(join(tmpdir(), "koda-long-verification-root-"));
  const root = join(
    parent,
    "a-very-long-source-snapshot-path-that-would-overflow-a-nested-tsx-ipc-socket",
  );
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      packageManager: "pnpm@11.7.0",
      scripts: { test: "tsx --test socket.test.ts" },
    }),
  );
  await writeFile(
    join(root, "socket.test.ts"),
    `import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createServer} from 'node:net';
test('short IPC path binds', async()=>{
  const dir=join(process.env.TMPDIR!,'tsx-501');
  await mkdir(dir,{recursive:true});
  const socket=join(dir,'31066.pipe');
  assert.ok(Buffer.byteLength(socket)<90, socket);
  const server=createServer();
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve)});
  await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  console.log('KODA_TMP='+process.env.TMPDIR);
});
`,
  );
  try {
    assert.equal(await bridgeDependencies(process.cwd(), root), true);
    const result = await command(root, "pnpm run test", 15000);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    const scratch = result.stdout.match(/KODA_TMP=(\S+)/)?.[1];
    assert.ok(scratch);
    assert.ok(Buffer.byteLength(join(scratch!, "tsx-501/31066.pipe")) < 90);
    await assert.rejects(access(scratch!));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test(
  "nested macOS verification commands receive a fresh bounded sandbox",
  { skip: process.platform !== "darwin" },
  async () => {
    const commandModule = (await import("node:url")).pathToFileURL(
      join(process.cwd(), "src/repo/commands.ts"),
    ).href;
    const script = `
import {mkdtemp,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {command} from '${commandModule}';
const fixture=await mkdtemp(join(process.env.TMPDIR,'nested-'));
const good=await command(fixture,'echo nested > result.txt');
if(good.exitCode!==0||(await readFile(join(fixture,'result.txt'),'utf8'))!=='nested\\n') process.exit(2);
const escape=await command(fixture,'echo escaped > ../outside.txt');
if(escape.exitCode===0) process.exit(3);
console.log('NESTED_SANDBOX_OK');
`;
    const encoded = Buffer.from(script).toString("base64");
    const result = await command(
      process.cwd(),
      `node --import tsx --input-type=module -e "await import('data:text/javascript;base64,${encoded}')"`,
      15000,
    );
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /NESTED_SANDBOX_OK/);
  },
);

test("sandbox permits local writes, denies external reads and git metadata edits", async () => {
  const repo = await fixture(),
    outside = await mkdtemp(join(tmpdir(), "koda-private-"));
  try {
    await writeFile(join(outside, "secret.txt"), "sensitive");
    assert.equal((await command(repo, "echo changed > seed.txt")).exitCode, 0);
    assert.notEqual(
      (await command(repo, `cat '${outside}/secret.txt'`)).exitCode,
      0,
    );
    assert.notEqual(
      (await command(repo, "echo bad > .git/config")).exitCode,
      0,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
test("speculative race chooses first verified result and drains losing work", async () => {
  const { raceVerified } = await import("../src/orchestrator/race.js");
  let drained = false;
  const winner = await raceVerified([
    async () => {
      throw Error("verification failed");
    },
    async () => {
      await new Promise((r) => setTimeout(r, 5));
      return "verified";
    },
    async (stop) => {
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(stop(), true);
      drained = true;
      throw Error("superseded");
    },
  ]);
  assert.equal(winner, "verified");
  assert.equal(drained, true);
});
test("integration conflicts require a resolver, and failed resolution aborts cleanly", async () => {
  const { Integrator } = await import("../src/integration/integrator.js");
  const { Logger } = await import("../src/telemetry/logger.js");
  const repo = await fixture(),
    directory = await mkdtemp(join(tmpdir(), "koda-conflict-"));
  try {
    const manager = new Worktrees(repo, directory, "conflict");
    const base = await git(repo, "rev-parse", "HEAD");
    const integration = await manager.create("integration", base),
      a = await manager.create("a", base),
      b = await manager.create("b", base);
    await writeFile(join(a.path, "seed.txt"), "a");
    const ca = await manager.commit(a.path, "a");
    await writeFile(join(b.path, "seed.txt"), "b");
    const cb = await manager.commit(b.path, "b");
    const integrator = new Integrator(
      integration.path,
      new Logger(join(directory, "logs"), "conflict", true),
    );
    await integrator.merge(ca, "a", async () => {
      throw Error("unexpected conflict");
    });
    await assert.rejects(
      integrator.merge(cb, "b", async () => {
        throw Error("failed verification");
      }),
    );
    assert.equal(
      await readFile(join(integration.path, "seed.txt"), "utf8"),
      "a",
    );
    assert.equal(await git(integration.path, "status", "--porcelain"), "");
    let resolved = false;
    await integrator.merge(cb, "b", async (paths) => {
      assert.deepEqual(paths, ["seed.txt"]);
      await writeFile(join(integration.path, "seed.txt"), "a and b");
      resolved = true;
    });
    assert.equal(resolved, true);
    assert.equal(
      await readFile(join(integration.path, "seed.txt"), "utf8"),
      "a and b",
    );
    for (const wt of [integration, a, b]) await manager.cleanup(wt.path);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});
test("dependency bridge permits reads and denies writes to original dependencies", async () => {
  const { bridgeDependencies } = await import("../src/repo/dependencies.js");
  const root = await mkdtemp(join(tmpdir(), "koda-deps-"));
  try {
    const a = join(root, "a"),
      b = join(root, "b");
    await mkdir(join(a, "node_modules", "pkg"), { recursive: true });
    await mkdir(b);
    await writeFile(join(a, "node_modules", "pkg", "value"), "original");
    assert.equal(await bridgeDependencies(a, b), true);
    assert.equal(
      (
        await command(
          b,
          "node -e \"console.log(require('fs').readFileSync('node_modules/pkg/value','utf8'))\"",
        )
      ).stdout,
      "original",
    );
    assert.notEqual(
      (
        await command(
          b,
          "node -e \"require('fs').writeFileSync('node_modules/pkg/value','changed')\"",
        )
      ).exitCode,
      0,
    );
    assert.equal(
      await readFile(join(a, "node_modules", "pkg", "value"), "utf8"),
      "original",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("empty suites and trivial commands cannot certify success", () => {
  for (const c of [
    { command: "true", stdout: "" },
    { command: "node --test", stdout: "# tests 0\n# fail 0" },
  ])
    assert.equal(
      verificationResult([
        { ...c, stderr: "", exitCode: 0, wallClockMs: 1, timedOut: false },
      ]).status,
      "NOT_FULLY_VERIFIED",
    );
});
test("command timeout terminates execution", async () => {
  const repo = await fixture();
  try {
    const r = await command(repo, 'node -e "setTimeout(()=>{},30000)"', 100);
    assert.equal(r.timedOut, true);
    assert.notEqual(r.exitCode, 0);
    assert.ok(r.wallClockMs < 3000);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("agent shell tool uses dynamic deadlines and removes its scratch directory", async () => {
  const { AgentTools } = await import("../src/agent/tools.js");
  const { Logger } = await import("../src/telemetry/logger.js");
  const repo = await fixture(),
    logs = await mkdtemp(join(tmpdir(), "koda-tools-"));
  try {
    const tools = new AgentTools(
      repo,
      false,
      () => 10000,
      new Logger(logs, "tools", true),
      "task",
    );
    const result = JSON.parse(
      await tools.execute("run_command", {
        command: 'node -e "console.log(process.cwd())"',
      }),
    );
    assert.equal(result.exitCode, 0);
    assert.equal(await git(repo, "status", "--porcelain"), "");
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(logs, { recursive: true, force: true });
  }
});

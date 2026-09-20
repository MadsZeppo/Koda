import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  link,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WriteScope } from "../src/repo/writeScope.js";
import { AgentTools } from "../src/agent/tools.js";
import { Logger } from "../src/telemetry/logger.js";
import { git } from "../src/repo/commands.js";
import { config } from "../src/config.js";
import { profileRepo } from "../src/repo/profiler.js";
import { compileContext } from "../src/context/compiler.js";
import { justifiedSiblingWrite } from "../src/repo/scopeExpansion.js";
import type { Subtask } from "../src/planner/schemas.js";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "koda-scope-")),
    repo = join(root, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src/a.ts"), "original a");
  await writeFile(join(repo, "src/b.ts"), "original b");
  await writeFile(join(repo, ".gitignore"), "ignored.txt\n");
  await git(repo, "init");
  await git(repo, "config", "user.name", "Test");
  await git(repo, "config", "user.email", "test@local");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "baseline");
  const logger = new Logger(join(root, "logs"), "scope", true);
  const supplied = ["src/a.ts"];
  const scope = new WriteScope(supplied, logger, "a");
  supplied.push("src/b.ts");
  return {
    root,
    repo,
    logger,
    scope,
    tools: new AgentTools(repo, false, 10000, logger, "a", 4000, scope),
  };
}
test("write_file enforces immutable ownership before modification and permits recovery and dependency reads", async () => {
  const f = await fixture();
  try {
    assert.ok(Object.isFrozen(f.scope.paths));
    await assert.rejects(
      f.tools.execute("write_file", {
        path: "src/b.ts",
        content: "unauthorized",
      }),
      /WRITE_SCOPE_VIOLATION/,
    );
    assert.equal(
      await readFile(join(f.repo, "src/b.ts"), "utf8"),
      "original b",
    );
    assert.match(
      await f.tools.execute("read_file", { path: "src/b.ts" }),
      /original b/,
    );
    assert.equal(
      await f.tools.execute("write_file", {
        path: "./src/a.ts",
        content: "fixed",
      }),
      "written",
    );
    assert.equal(await readFile(join(f.repo, "src/a.ts"), "utf8"), "fixed");
    assert.ok(f.logger.events.some((e) => e.type === "write_scope_violation"));
    assert.ok(f.logger.events.some((e) => e.type === "write_success"));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("scope expansion requires a task-named imported sibling and rejects unrelated files", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.repo, "src/a.ts"), 'import { fix } from "./b.js";\nexport const run = fix;\n');
    await writeFile(join(f.repo, "src/b.ts"), "export const fix = () => 1;\n");
    await writeFile(join(f.repo, "src/unrelated.ts"), "export const unrelated = 1;\n");
    const profile = await profileRepo(f.repo);
    profile.files.push("src/unrelated.ts");
    const subtask: Subtask = {
      id: "a", title: "fix", objective: "Fix src/b.ts used by src/a.ts",
      dependsOn: [], likelyReadPaths: [], likelyWritePaths: ["src/a.ts"],
      integrationContract: "", verificationCommands: [], estimatedDifficulty: "low", parallelSafe: false,
    };
    assert.equal(await justifiedSiblingWrite(f.repo, "src/b.ts", subtask, profile, subtask.objective), true);
    assert.equal(await justifiedSiblingWrite(f.repo, "src/unrelated.ts", subtask, profile, subtask.objective), false);
    assert.equal(await justifiedSiblingWrite(f.repo, "../src/b.ts", subtask, profile, subtask.objective), false);
    assert.equal(await justifiedSiblingWrite(f.repo, "src/b.ts", subtask, profile, "Fix src/a.ts"), true);
    subtask.objective = "Fix src/a.ts";
    assert.equal(await justifiedSiblingWrite(f.repo, "src/b.ts", subtask, profile, subtask.objective), false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test("write_file rejects traversal, symlink and hardlink aliases of sibling files", async () => {
  const f = await fixture();
  try {
    await rm(join(f.repo, "src/a.ts"));
    await symlink("b.ts", join(f.repo, "src/a.ts"));
    await assert.rejects(
      f.tools.execute("write_file", { path: "src/a.ts", content: "bad" }),
      /WRITE_SCOPE_VIOLATION/,
    );
    await rm(join(f.repo, "src/a.ts"));
    await link(join(f.repo, "src/b.ts"), join(f.repo, "src/a.ts"));
    await assert.rejects(
      f.tools.execute("write_file", { path: "src/a.ts", content: "bad" }),
      /WRITE_SCOPE_VIOLATION/,
    );
    await assert.rejects(
      f.tools.execute("write_file", {
        path: "src/../src/b.ts",
        content: "bad",
      }),
      /WRITE_SCOPE_VIOLATION/,
    );
    assert.equal(
      await readFile(join(f.repo, "src/b.ts"), "utf8"),
      "original b",
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("shell transactions discard sibling/ignored/deleted writes, preserve earlier edits, and permit owned edits and scratch", async () => {
  const f = await fixture();
  try {
    await f.tools.execute("write_file", {
      path: "src/a.ts",
      content: "earlier edit",
    });
    for (const command of [
      "echo hacked > src/b.ts",
      "cp src/a.ts src/b.ts",
      "mv src/a.ts src/b.ts",
      "node -e \"require('fs').writeFileSync('src/b.ts','bad')\"",
      "rm src/b.ts",
      "echo bad > ignored.txt",
      "echo changed > src/a.ts; echo bad > src/b.ts",
      "rm src/a.ts; ln -s b.ts src/a.ts",
    ]) {
      const result = JSON.parse(
        await f.tools.execute("run_command", { command }),
      );
      assert.equal(result.exitCode, 1, command);
      assert.match(result.stderr, /WRITE_SCOPE_VIOLATION/);
      assert.equal(
        await readFile(join(f.repo, "src/a.ts"), "utf8"),
        "earlier edit",
      );
      assert.equal(
        await readFile(join(f.repo, "src/b.ts"), "utf8"),
        "original b",
      );
      await assert.rejects(readFile(join(f.repo, "ignored.txt")), {
        code: "ENOENT",
      });
    }
    const ok = JSON.parse(
      await f.tools.execute("run_command", {
        command: 'echo fixed > src/a.ts; echo scratch > "$TMPDIR/scratch"',
      }),
    );
    assert.equal(ok.exitCode, 0, ok.stderr);
    assert.equal(await readFile(join(f.repo, "src/a.ts"), "utf8"), "fixed\n");
    const gitConfig = await readFile(join(f.repo, ".git/config"), "utf8");
    assert.notEqual(
      JSON.parse(
        await f.tools.execute("run_command", {
          command: "echo bad > .git/config",
        }),
      ).exitCode,
      0,
    );
    assert.equal(
      await readFile(join(f.repo, ".git/config"), "utf8"),
      gitConfig,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("focused worker context excludes independent siblings but retains tests and read-only imports", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.repo, "test"));
    await mkdir(join(f.repo, "src/types"));
    await writeFile(
      join(f.repo, "src/a.ts"),
      "import { Order } from './types/order.js'; export function a(value: Order) { return value; }",
    );
    await writeFile(
      join(f.repo, "src/types/order.ts"),
      "export interface Order { id: string; }",
    );
    await writeFile(
      join(f.repo, "test/a.test.js"),
      "import { a } from '../src/a.ts';",
    );
    await writeFile(
      join(f.repo, "test/b.test.js"),
      "import { b } from '../src/b.ts';",
    );
    await writeFile(join(f.repo, "package.json"), "{}");
    await git(f.repo, "add", ".");
    await git(f.repo, "commit", "-m", "context");
    const c = await compileContext(
      f.repo,
      "Fix a",
      ["src/a.ts"],
      await profileRepo(f.repo),
      (await config(undefined, { models: {} })).context,
      true,
    );
    const paths = c.files.map((f) => f.path);
    for (const path of [
      "src/a.ts",
      "test/a.test.js",
      "package.json",
      "src/types/order.ts",
    ])
      assert.ok(paths.includes(path), path);
    for (const path of ["src/b.ts", "test/b.test.js"]) {
      assert.ok(!paths.includes(path));
      assert.ok(!c.repoMap.includes(path));
    }
    assert.ok(c.localDependencies.includes("src/types/order.ts"));
    assert.equal(f.scope.allows("src/types/order.ts"), false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

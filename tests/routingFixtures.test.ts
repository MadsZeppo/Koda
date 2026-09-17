import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { git, command } from "../src/repo/commands.js";
import { profileRepo } from "../src/repo/profiler.js";
import { chooseExecutionStrategy } from "../src/router/executionStrategy.js";
test("manual live fixtures are clean, independently broken, routable, and idempotent without any inference", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-routing-fixtures-"));
  const create = () =>
    execa(process.execPath, [
      resolve("scripts/create-routing-fixtures.mjs"),
      root,
    ]);
  try {
    await create();
    for (const name of ["direct", "parallel"]) {
      const repo = join(root, name);
      assert.equal(await git(repo, "status", "--porcelain"), "");
      assert.equal((await command(repo, "npm test", 10000)).exitCode, 1);
    }
    assert.equal(
      chooseExecutionStrategy(
        "Fix the add function so all tests pass.",
        await profileRepo(join(root, "direct")),
      ).execution_strategy,
      "direct",
    );
    assert.equal(
      chooseExecutionStrategy(
        "Fix the broken math helper, slug helper, and display-name formatter so all tests pass. These are independent bugs.",
        await profileRepo(join(root, "parallel")),
      ).execution_strategy,
      "planned",
    );
    for (const name of ["math", "slug", "display-name"])
      assert.equal(
        (
          await command(
            join(root, "parallel"),
            `node --test test/${name}.test.js`,
            10000,
          )
        ).exitCode,
        1,
      );
    const file = join(root, "direct", "src", "calculator.js");
    const baseline = await readFile(file, "utf8");
    await writeFile(file, "changed");
    await create();
    assert.equal(await readFile(file, "utf8"), baseline);
    assert.equal(await git(join(root, "direct"), "status", "--porcelain"), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

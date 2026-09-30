import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { routingBaselinePreflight } from "../src/agent/stableNoChangePreflight.js";
import { profileRepo } from "../src/repo/profiler.js";

test("routing preflight skips a full suite without a focused test target", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-routing-preflight-"));
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "tests"));
    await writeFile(join(root, "src/value.cjs"), "module.exports = 1;\n");
    await writeFile(join(root, "tests/value.test.cjs"),
      "const { test } = require('node:test'); test('value', () => {});\n");
    await writeFile(join(root, "package.json"), JSON.stringify({
      scripts: { test: "node --test tests/*.test.cjs" },
    }));
    const profile = await profileRepo(root);

    const broad = await routingBaselinePreflight(
      root,
      profile,
      [],
      () => 5_000,
    );
    assert.equal(broad.checks.length, 0);

    const focused = await routingBaselinePreflight(
      root,
      profile,
      ["tests/value.test.cjs"],
      () => 5_000,
    );
    assert.equal(focused.checks.length, 1);
    assert.match(focused.checks[0]!.command, /tests\/value\.test\.cjs/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

#!/usr/bin/env node
import { mkdir, readFile, writeFile, lstat, rm } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const marker = ".koda-routing-fixture.json";
const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const pkg = {
  name: "koda-routing-fixture",
  private: true,
  type: "module",
  scripts: { test: "node --test" },
};
const test = (imports, body) =>
  `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n${imports}\ntest('behavior', () => { ${body} });\n`;
const direct = {
  "src/calculator.js": "export function add(a, b) { return a - b; }\n",
  "test/calculator.test.js": test(
    "import { add } from '../src/calculator.js';",
    "assert.equal(add(2, 3), 5); assert.equal(add(-4, 7), 3); assert.equal(add(0, 0), 0);",
  ),
};
const parallel = {
  "src/math.js": "export function multiply(a, b) { return a + b; }\n",
  "src/slug.js": "export function slug(text) { return text.trim(); }\n",
  "src/display-name.js":
    "export function displayName(first, last) { return last + ', ' + first; }\n",
  "test/math.test.js": test(
    "import { multiply } from '../src/math.js';",
    "assert.equal(multiply(3, 4), 12); assert.equal(multiply(-2, 5), -10);",
  ),
  "test/slug.test.js": test(
    "import { slug } from '../src/slug.js';",
    "assert.equal(slug(' Hello World '), 'hello-world'); assert.equal(slug('Two   Spaces'), 'two-spaces');",
  ),
  "test/display-name.test.js": test(
    "import { displayName } from '../src/display-name.js';",
    "assert.equal(displayName('Ada', 'Lovelace'), 'Ada Lovelace'); assert.equal(displayName('Grace', 'Hopper'), 'Grace Hopper');",
  ),
};
export async function createRoutingFixtures(destination) {
  const root = resolve(destination);
  await mkdir(root, { recursive: true });
  for (const [name, files] of Object.entries({ direct, parallel })) {
    const repo = join(root, name);
    try {
      if ((await lstat(repo)).isSymbolicLink())
        throw Error(`Refusing symlink fixture: ${repo}`);
      const saved = JSON.parse(
        await readFile(join(repo, marker), "utf8").catch(() => {
          throw Error(`Refusing unmarked fixture directory: ${repo}`);
        }),
      );
      if (saved.kind !== "koda-routing-fixture" || saved.name !== name)
        throw Error(`Refusing to replace unrelated directory: ${repo}`);
      if (
        git(repo, "worktree", "list", "--porcelain")
          .split("\n")
          .filter((l) => l.startsWith("worktree ")).length > 1
      )
        throw Error(`Remove linked agent worktrees before recreating ${repo}`);
      await rm(repo, { recursive: true, force: true });
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    await mkdir(repo, { recursive: true });
    await writeFile(
      join(repo, marker),
      JSON.stringify({ kind: "koda-routing-fixture", name }) + "\n",
    );
    await writeFile(
      join(repo, "package.json"),
      JSON.stringify({ ...pkg, name: `koda-${name}-fixture` }, null, 2) + "\n",
    );
    for (const [file, content] of Object.entries(files)) {
      await mkdir(dirname(join(repo, file)), { recursive: true });
      await writeFile(join(repo, file), content);
    }
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.name", "Koda Fixture");
    git(repo, "config", "user.email", "fixture@localhost");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "Known broken routing baseline");
  }
  return { direct: join(root, "direct"), parallel: join(root, "parallel") };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (!process.argv[2]) {
    console.error(
      "Usage: node scripts/create-routing-fixtures.mjs /tmp/koda-routing-fixtures",
    );
    process.exitCode = 1;
  } else
    createRoutingFixtures(process.argv[2])
      .then((paths) => console.log(JSON.stringify(paths, null, 2)))
      .catch((e) => {
        console.error(String(e));
        process.exitCode = 1;
      });
}

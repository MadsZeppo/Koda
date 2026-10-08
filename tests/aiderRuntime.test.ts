import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureAiderRuntime, aiderSandboxReadRoots } from "../src/agent/aiderRuntime.js";

for (const trampoline of [false, true]) {
  test(`Aider runtime uses its owning interpreter (${trampoline ? "pipx path with spaces" : "normal shebang"})`, async t => {
    const root = await mkdtemp(join(tmpdir(), "koda-runtime-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const folder = join(root, trampoline ? "Application Support" : "venv");
    await mkdir(folder);
    const python = join(folder, "python");
    await writeFile(python, '#!/bin/sh\n[ "$1" = "-I" ] || exit 1\n[ "$2" = "-c" ] || exit 1\nprintf "%s\\n" "$0"\n', { mode: 0o755 });
    const entry = join(root, "aider");
    await writeFile(entry, trampoline
      ? `#!/bin/sh\n'''exec' '${python}' "$0" "$@"\n' '''\n`
      : `#!${python}\n`, { mode: 0o755 });
    assert.equal(await ensureAiderRuntime({ AIDER_BIN: entry, PATH: "/missing" }), python);
  });
}

test('Aider runtime discovers a user pipx install with Finder minimal PATH', async t => {
  const root = await mkdtemp(join(tmpdir(), 'koda-finder-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, 'Library', 'Application Support', 'pipx', 'venvs', 'aider-chat', 'bin');
  await mkdir(folder, { recursive: true });
  const python = join(folder, 'python');
  await writeFile(python, '#!/bin/sh\nprintf "%s\\n" "$0"\n', { mode: 0o755 });
  await writeFile(join(folder, 'aider'), `#!/bin/sh\n'''exec' '${python}' "$0" "$@"\n' '''\n`, { mode: 0o755 });
  assert.equal(await ensureAiderRuntime({ HOME: root, PATH: '/usr/bin:/bin' }), python);
});

test('managed Python base aliases remain visible in the sandbox without granting home access', async t => {
  const root = await mkdtemp(join(tmpdir(), "koda-python-alias-"));
  t.after(() => rm(root, {recursive:true,force:true}));
  const cache=join(root,"python-cache"),base=join(cache,"versioned"),alias=join(cache,"current"),venv=join(root,"venv");
  await mkdir(join(base,"bin"),{recursive:true});await mkdir(join(venv,"bin"),{recursive:true});
  await writeFile(join(base,"bin","python"),'runtime');
  await symlink(base,alias);await symlink(join(alias,"bin","python"),join(venv,"bin","python"));
  await writeFile(join(venv,"pyvenv.cfg"),`home = ${alias}/bin\n`);
  const roots=await aiderSandboxReadRoots(join(venv,"bin","python"));
  assert.ok(roots.includes(venv));assert.ok(roots.includes(await realpath(base)));assert.ok(roots.includes(cache));
  assert.ok(!roots.includes(root));
});

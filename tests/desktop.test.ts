import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopInvocation, startDesktopRun } from '../src/desktop/runner.js';
test('desktop uses real CLI with literal task arguments and backend-only environment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'koda-desktop-'));
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-do-not-pass-to-client';
  try {
    const task = 'Change a label; $(echo never-execute)';
    const invocation = await desktopInvocation({ repo: directory, task, apiUrl: 'http://127.0.0.1:8787', budgetUsd: 0.5, apply: true }, directory, directory);
    assert.equal(invocation.args[invocation.args.indexOf('--task') + 1], task);
    assert.ok(invocation.args.includes('--apply'));
    assert.equal(invocation.env.KODA_PROVIDER_MODE, 'backend');
    assert.equal(invocation.env.OPENROUTER_API_KEY, undefined);
    assert.equal(invocation.env.ELECTRON_RUN_AS_NODE, '1');
  } finally { if (previous === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previous; await rm(directory, { recursive: true, force: true }); }
});
test('desktop preview does not request apply, and rejects invalid input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'koda-desktop-'));
  const request = { repo: directory, task: 'Fix the label', apiUrl: 'http://localhost:8787', budgetUsd: 0.5, apply: false };
  try {
    assert.equal((await desktopInvocation(request, directory, directory)).args.includes('--apply'), false);
    await assert.rejects(desktopInvocation({ ...request, task: '' }, directory, directory));
    await assert.rejects(desktopInvocation({ ...request, apiUrl: 'file:///tmp' }, directory, directory));
    await assert.rejects(desktopInvocation({ ...request, budgetUsd: NaN }, directory, directory));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('desktop subprocess streams output and returns its report without provider calls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'koda-desktop-process-'));
  try {
    await mkdir(join(directory, 'bin'));
    await writeFile(join(directory, 'bin/koda.mjs'), `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.env.KODA_PROVIDER_MODE !== 'backend' || process.env.OPENROUTER_API_KEY) process.exit(2);
const output = process.argv[process.argv.indexOf('--output') + 1];
console.log('test subprocess running');
writeFileSync(join(output, 'summary.json'), JSON.stringify({ status: 'NOT_FULLY_VERIFIED', applyResult: 'not_verified' }));
process.exitCode = 1;
`);
    const logs: string[] = [];
    const run = await startDesktopRun({ repo: directory, task: 'Test transport', apiUrl: 'http://localhost:8787', budgetUsd: 0.5, apply: true }, directory, directory, text => logs.push(text), process.execPath);
    const result = await run.done as { code: number; summary: { status: string; applyResult: string } };
    assert.equal(result.code, 1);
    assert.equal(result.summary.status, 'NOT_FULLY_VERIFIED');
    assert.equal(result.summary.applyResult, 'not_verified');
    assert.match(logs.join(''), /test subprocess running/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

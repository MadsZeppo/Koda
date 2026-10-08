import { spawn } from 'node:child_process';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
export interface DesktopRequest { repo: string; task: string; apiUrl: string; budgetUsd: number; apply: boolean }
export async function desktopInvocation(request: DesktopRequest, root: string, runs: string) {
  if (!(await stat(request.repo)).isDirectory()) throw Error('Vælg en projektmappe');
  if (!request.task?.trim()) throw Error('Skriv en opgave');
  const url = new URL(request.apiUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('Ugyldig backend-adresse');
  if (!Number.isFinite(request.budgetUsd) || request.budgetUsd <= 0 || request.budgetUsd > 100) throw Error('Budget skal være mellem 0 og 100 USD');
  const output = join(runs, `desktop-${Date.now()}-${randomUUID()}`);
  await mkdir(output, { recursive: true });
  const args = [join(root, 'bin/koda.mjs'), 'run', '--repo', request.repo, '--task', request.task, '--budget-usd', String(request.budgetUsd), '--output', output];
  if (request.apply) args.push('--apply');
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', KODA_PROVIDER_MODE: 'backend', KODA_API_URL: url.toString() };
  delete env.OPENROUTER_API_KEY;
  return { args, env, output };
}
export async function startDesktopRun(request: DesktopRequest, root: string, runs: string, onLog: (text: string) => void, runtime = process.execPath) {
  const invocation = await desktopInvocation(request, root, runs);
  const child = spawn(runtime, invocation.args, { cwd: root, env: invocation.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => onLog(chunk.toString()));
  child.stderr.on('data', chunk => onLog(chunk.toString()));
  const done = new Promise<object>((resolve) => {
    child.once('error', error => resolve({ error: error.message, output: invocation.output }));
    child.once('close', async (code, signal) => {
      let summary;
      try { summary = JSON.parse(await readFile(join(invocation.output, 'summary.json'), 'utf8')); } catch { /* Cancellation/startup failure can leave no report. */ }
      resolve({ code, signal, summary, output: invocation.output });
    });
  });
  return { child, done };
}

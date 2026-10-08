/** Manually invoked paid pilot. Reuses suite fixtures, isolation and acceptance. */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { runCodingSuite } from './codingSuite.js';
import { config as loadConfig } from '../config.js';
import { Catalog } from '../openrouter/catalog.js';
import { CapabilityRegistry } from '../router/capabilityRegistry.js';
import { supportsParameters } from '../router/pool.js';
import { codingScenarios } from './codingSuiteFixtures.js';
import { expertCodingScenarios } from './expertCodingSuiteFixtures.js';
import { hardCodingScenarios } from './hardCodingSuiteFixtures.js';
import { stressCodingScenarios } from './stressCodingSuiteFixtures.js';
import { kodaUsage } from './benchmarkCompare.js';

export const pilotTasks = ['clamp', 'chunk', 'median', 'pagination', 'safe-json'];
export function pilotConfigs(base: Record<string, any>, model: string): { auto: Record<string, any>; frontier: Record<string, any> } {
  if (!model || model.startsWith('openrouter/auto')) throw Error('An exact frontier model is required');
  const common: Record<string, any> = { ...base, modelsFile: base.modelsFile ? resolve(base.modelsFile) : undefined };
  return {
    auto: { ...common, routing: { ...base.routing, authority: 'openrouter-auto', openRouterAuto: { ...base.routing?.openRouterAuto, referenceModel: model, costTier: 'auto' } } },
    frontier: { ...common, routing: { ...base.routing, authority: 'cold-start', coldStart: { models: [model], referenceModel: model } } },
  };
}
export function pilotSelection(suite = 'basic', names?: string[], parallel = 1) {
 const available = suite === 'basic' ? codingScenarios : suite === 'expert' ? expertCodingScenarios : suite === 'hard' ? hardCodingScenarios : suite === 'stress' ? stressCodingScenarios : undefined;
 if (!available) throw Error('Unknown suite');
 if (!Number.isSafeInteger(parallel) || parallel < 1) throw Error('Positive integer --parallel required');
 const tasks = names ?? (suite === 'basic' ? pilotTasks : available.map(s=>s.id));
 if (!tasks.length || new Set(tasks).size !== tasks.length || tasks.some(id=>!available.some(s=>s.id===id))) throw Error('Invalid or duplicate task selection');
 return {suite: suite as 'basic'|'expert'|'hard'|'stress', tasks, parallel};
}
export function taskCostTable(arms: {arm: string; runs: {id: string; passed: boolean; costUsd: number | null; costComplete: boolean; knownReceiptCostUsd: number; wallClockMs: number}[]}[]) {
  const rows = ['| Task | Arm | Passed | Cost | Known receipts | Time |', '|---|---|---|---:|---:|---:|'];
  for (const arm of arms) for (const run of arm.runs) {
    const cost = run.costComplete && run.costUsd !== null ? '$' + run.costUsd.toFixed(6) : 'unknown';
    rows.push(`| ${run.id} | ${arm.arm} | ${run.passed ? 'yes' : 'no'} | ${cost} | $${run.knownReceiptCostUsd.toFixed(6)} | ${(run.wallClockMs / 1000).toFixed(1)}s |`);
  }
  return rows.join('\n');
}
export async function runPilot(options: { output: string; config: string; model: string; budgetUsd: number; suite?: string; names?: string[]; parallel?: number }) {
  if (!Number.isFinite(options.budgetUsd) || options.budgetUsd <= 0) throw Error('Explicit positive --budget-usd required');
  const selection=pilotSelection(options.suite,options.names,options.parallel);
  const configs = pilotConfigs(JSON.parse(await readFile(resolve(options.config), 'utf8')), options.model);
  const root = resolve(options.output);
  await mkdir(root, { recursive: false });
  const preflightPath = join(root, 'preflight-config.json');
  await writeFile(preflightPath, JSON.stringify(configs.frontier));
  const cfg = await loadConfig(preflightPath);
  const catalog = new Catalog(cfg.baseUrl, join(root, 'metadata'), cfg.routing.cacheTtlMs, cfg.modelPool!.models);
  const registry = new CapabilityRegistry(cfg, catalog);
  const snapshot = await registry.freezeRunSnapshot();
  const reference = snapshot.find(m => m.model.id === options.model);
  const md = reference?.metadata;
  const reasons = !reference ? ['not discovered'] : [
    !reference.model.enabled && 'disabled', md?.available === false && 'unavailable',
    !Number.isFinite(md?.inputPrice) && 'missing input price',
    !Number.isFinite(md?.outputPrice) && 'missing output price',
    !supportsParameters(md ?? {}, ['tools', 'tool_choice']) && 'missing tools/tool_choice',
    (md?.maxOutputTokens ?? 0) < cfg.maxOutputTokens && 'insufficient output capacity',
    (md?.contextLength ?? 0) < cfg.stageMaxTokens && 'insufficient context capacity',
    (md?.inputPrice ?? Infinity) > cfg.maxInputPrice && 'input price ceiling',
    (md?.outputPrice ?? Infinity) > cfg.maxOutputPrice && 'output price ceiling',
    cfg.stageMaxTokens * Math.max(md?.inputPrice ?? Infinity, md?.outputPrice ?? Infinity) / 1e6 > options.budgetUsd / (2 * selection.tasks.length) * .9 && 'insufficient per-run reference reservation',
  ].filter(Boolean);
  await writeFile(join(root, 'preflight.json'), JSON.stringify({ model: options.model, metadata: md, reasons }, null, 2));
  if (reasons.length) throw Error(`Benchmark preflight: ${options.model}: ${reasons.join(', ')}. No coding calls made.`);
  const arms = [];
  // Equal fixed per-run caps; unused funds are not reused, so total cannot exceed the configured budget.
  for (const arm of ['auto', 'frontier'] as const) {
    const suite = await runCodingSuite({ mode: 'live', output: join(root, arm), concurrency: selection.parallel, suite: selection.suite, names: selection.tasks, budgetUsd: options.budgetUsd / 2, config: configs[arm], timeoutMs: 360_000 });
    const runs = [];
    for (const result of suite.results) {
      let usage: ReturnType<typeof kodaUsage> | undefined;
      try {
        const events = (await readFile(join(result.report, 'events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        const summary = JSON.parse(await readFile(join(result.report, 'summary.json'), 'utf8'));
        usage = kodaUsage(events, summary);
      } catch { /* Missing receipts remain unknown, never zero. */ }
      runs.push({ ...result, costUsd: usage?.costUsd ?? null, models: usage?.models ?? [], costComplete: usage?.costComplete ?? false, knownReceiptCostUsd: usage?.knownReceiptCostUsd ?? 0,
        missingReceipts: usage?.missingReceipts ?? [{ error: "Report unavailable" }] });
    }
    const complete = runs.every(r => r.costComplete);
    const cost = complete ? runs.reduce((n,r) => n + (r.costUsd ?? 0), 0) : null;
    arms.push({ arm, passed: suite.passed, tasks: runs.length, costUsd: cost, costPerSolve: cost !== null && suite.passed ? cost / suite.passed : null, wallClockMs: suite.wallClockMs, runs });
    await writeFile(join(root, 'comparison.json'), JSON.stringify({ budgetUsd: options.budgetUsd, arms }, null, 2));
  }
  const detail = taskCostTable(arms);
  console.log('\n' + detail);
  await writeFile(join(root, 'tasks.md'), detail + '\n');
  console.log('\n| Arm | Passed | Total cost | Cost/solve | Wall time |\n|---|---:|---:|---:|---:|');
  const money = (n: number | null) => n === null ? 'unknown' : '$' + n.toFixed(6);
  for (const a of arms) console.log(`| ${a.arm} | ${a.passed}/${a.tasks} | ${money(a.costUsd)} | ${money(a.costPerSolve)} | ${(a.wallClockMs / 1000).toFixed(1)}s |`);
  const [auto, frontier] = arms;
  if (auto?.costPerSolve !== null && frontier?.costPerSolve && auto?.passed === frontier.passed) console.log(`Saving per verified solve: ${(100 * (1 - auto!.costPerSolve! / frontier.costPerSolve)).toFixed(1)}%`);
  else console.log('Savings are inconclusive: unequal solve counts or missing cost receipts.');
  for (const arm of arms) {
    if (arm.costUsd === null) {
      const known = arm.runs.reduce((n,run)=>n+run.knownReceiptCostUsd,0);
      console.log(`${arm.arm}: known receipts $${known.toFixed(6)}; total remains unknown.`);
      for (const run of arm.runs) for (const receipt of run.missingReceipts)
        console.log(`  ${run.id}: ${JSON.stringify(receipt)}`);
    }
  }
  console.log(`Reports: ${root}. ${selection.tasks.length} fixture tasks are a pilot, not evidence of general frontier parity.`);
  return arms;
}
export async function refreshPilot(output: string) {
  const file = join(resolve(output), 'comparison.json');
  const report = JSON.parse(await readFile(file, 'utf8'));
  for (const arm of report.arms) {
    for (const run of arm.runs) {
      const events = (await readFile(join(run.report, 'events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      const summary = JSON.parse(await readFile(join(run.report, 'summary.json'), 'utf8'));
      const usage = kodaUsage(events, summary);
      run.costUsd = usage.costUsd; run.costComplete = usage.costComplete;
      run.knownReceiptCostUsd = usage.knownReceiptCostUsd; run.missingReceipts = usage.missingReceipts;
    }
    arm.costUsd = arm.runs.every((r: any) => r.costComplete) ? arm.runs.reduce((n: number,r: any) => n + r.costUsd, 0) : null;
    arm.costPerSolve = arm.costUsd !== null && arm.passed ? arm.costUsd / arm.passed : null;
  }
  const [a,f] = report.arms;
  report.savingsPercent = a.passed === f.passed && a.costPerSolve !== null && f.costPerSolve > 0 ? 100 * (1 - a.costPerSolve / f.costPerSolve) : null;
  await writeFile(file, JSON.stringify(report, null, 2));
  const table = '| Arm | Passed | Total cost | Cost/solve | Wall time |\n|---|---:|---:|---:|---:|\n' + report.arms.map((a: any) => `| ${a.arm} | ${a.passed}/${a.tasks} | ${a.costUsd === null ? 'unknown' : '$' + a.costUsd.toFixed(6)} | ${a.costPerSolve === null ? 'unknown' : '$' + a.costPerSolve.toFixed(6)} | ${(a.wallClockMs / 1000).toFixed(1)}s |`).join('\n') + `\n\nSavings: ${report.savingsPercent === null ? 'unknown' : report.savingsPercent.toFixed(1) + '%'}.\n`;
  await writeFile(join(resolve(output), 'comparison.md'), table);
  console.log(table);
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { config: { type: 'string', default: 'koda.auto.example.json' }, 'frontier-model': { type: 'string' }, 'budget-usd': { type: 'string' }, output: { type: 'string' }, 'report-only': { type: 'boolean' }, suite: { type: 'string', default: 'basic' }, only: { type: 'string' }, parallel: { type: 'string', default: '1' } } });
  if (values['report-only']) {
    if (!values.output) throw Error('--output required');
    await refreshPilot(values.output);
  } else {
  if (!values['frontier-model'] || !values.output || !values['budget-usd']) throw Error('Requires --frontier-model --budget-usd --output. This command makes paid calls.');
  const arms = await runPilot({ config: values.config!, model: values['frontier-model'], budgetUsd: Number(values['budget-usd']), output: values.output, suite: values.suite, names: values.only?.split(','), parallel: Number(values.parallel) });
  if (arms.some(a => a.passed !== a.tasks)) process.exitCode = 1;
  }
}

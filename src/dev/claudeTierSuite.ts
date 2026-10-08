/** Manual paid comparison; reuses compareTask and existing independent contracts. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { compareTask } from './benchmarkCompare.js';
import { codingScenarios, scenarioFixture, type CodingScenario } from './codingSuiteFixtures.js';
import { expertCodingScenarios } from './expertCodingSuiteFixtures.js';

export interface TierTask { id: string; tier: string; files: Record<string,string>; task: string; acceptance: string; }
export function tierTasks(): TierTask[] {
  const simple = (s: CodingScenario, tier: string): TierTask => {
    const f = scenarioFixture(s);
    return { id: `${tier}-${s.id}`, tier, files: f.files, task: f.task, acceptance: `const a=require('node:assert/strict');const fn=require(process.cwd()+'/${f.source}');\n` + checks(s, 'fn') };
  };
  const easy = ['sum','clamp','slug','deduplicate','count-words'].map(id => simple(codingScenarios.find(s => s.id === id)!, 'easy'));
  const medium = expertCodingScenarios.slice(0,10).map(s => simple({ ...s, create: false, addTests: true }, 'medium'));
  const hard = Array.from({length:10}, (_, i): TierTask => {
    const parts = expertCodingScenarios.slice(i * 3, i * 3 + 3);
    if (parts.length !== 3) throw Error('Missing hard task components');
    const files: Record<string,string> = {
      'package.json': JSON.stringify({ scripts: { test: 'node --test tests/*.test.cjs', typecheck: 'node --check src/index.cjs' } }),
      'src/index.cjs': 'exports.run=()=>null;\n',
      'tests/api.test.cjs': "const {test}=require('node:test');const a=require('node:assert/strict');test('API',()=>a.equal(typeof require('../src/index.cjs').run,'function'));\n",
      'README.md': 'Batch workflow: src/index.cjs is the public API; operations live in src/operations/. No dependencies.\n',
    };
    for (const p of parts) files[`src/operations/${p.id}.cjs`] = 'module.exports=()=>null;\n';
    const task = `Implement a multi-file batch workflow. Modify src/index.cjs and ${parts.map(p => `src/operations/${p.id}.cjs`).join(', ')}; add regression tests in tests/api.test.cjs. Export run(requests) from src/index.cjs: map each {operation,args} in order to the corresponding module result, preserving inputs. Empty requests returns []; unknown operations throw RangeError. Each operation module exports its function with module.exports. Use real imports between modules; preserve package.json and README.md. The exact request.operation keys are ${parts.map(p => JSON.stringify(p.id)).join(", ")}; do not shorten or rename them. Add regression tests exercising run with each exact key as well as the operation modules. Contracts:\n` + parts.map(p => `${p.id}: ${p.requirement}`).join('\n') + '\nRun tests and syntax checks.';
    const acceptance = "const a=require('node:assert/strict');const {run}=require(process.cwd()+'/src/index.cjs');a.deepEqual(run([]),[]);a.throws(()=>run([{operation:'unknown',args:[]}]),RangeError);\n" + parts.map((p,j) => `const f${j}=require(process.cwd()+'/src/operations/${p.id}.cjs');\n${checks(p, `f${j}`)}\n${checks(p, `(...args)=>run([{operation:${JSON.stringify(p.id)},args}])[0]`)}\n`).join('\n') + `const batch=${JSON.stringify(parts.map(p => ({operation:p.id,args:p.cases[0]![0]})))};const before=structuredClone(batch);a.deepEqual(run(batch),${JSON.stringify(parts.map(p => p.cases[0]![1]))});a.deepEqual(batch,before);`;
    return { id: `hard-workflow-${i+1}`, tier:'hard', files, task, acceptance };
  });
  return [...easy,...medium,...hard];
}
function checks(s: CodingScenario, fn: string) {
  return s.cases.map(([args,out]) => `{const xs=${JSON.stringify(args)},before=structuredClone(xs);a.deepEqual((${fn})(...xs),${JSON.stringify(out)});a.deepEqual(xs,before);}`).join('\n') + (s.invalidArgs ?? []).map(args => `a.throws(()=>(${fn})(...${JSON.stringify(args)}),RangeError);`).join('\n');
}
export function selectTierTasks(profile = 'all', limit = 25, offset = 0): TierTask[] {
  const all = tierTasks();
  if (profile !== 'all' && profile !== 'medium-hard' && profile !== 'hard') throw Error('profile must be all, medium-hard or hard');
  const selected = profile === 'medium-hard'
    ? Array.from({length:10}, (_,i) => [all.filter(t=>t.tier==='medium')[i]!, all.filter(t=>t.tier==='hard')[i]!]).flat()
    : profile === 'hard' ? all.filter(t=>t.tier==='hard') : all;
  if (!Number.isInteger(limit) || limit < 1 || limit > selected.length) throw Error(`limit must be 1..${selected.length}`);
  if (!Number.isInteger(offset) || offset < 0 || offset + limit > selected.length) throw Error('offset + limit exceeds available tasks');
  return selected.slice(offset,offset+limit);
}
export async function runTierSuite(o: {output:string; config:string; execute:boolean; claudeBudget:number; kodaBudget:number; limit:number; profile?:string; offset?:number}) {
  const tasks=selectTierTasks(o.profile,o.limit,o.offset);
  if (!tasks.length || !Number.isInteger(o.limit) || o.limit<1 || o.limit>25) throw Error('limit must be 1..25');
  if(o.execute && (![o.claudeBudget,o.kodaBudget].every(n=>Number.isFinite(n)&&n>0))) throw Error('Explicit positive --claude-budget-usd and --koda-budget-usd required for paid execution');
  const root=resolve(o.output); await mkdir(root,{recursive:true});
  const plan = JSON.stringify({ tasks, config: JSON.parse(await readFile(o.config,'utf8')), claudeBudget:o.claudeBudget, kodaBudget:o.kodaBudget });
  const planPath=join(root,'suite-plan.json');
  try { const prior=await readFile(planPath,'utf8');if(prior!==plan)throw Error('Existing suite plan differs; use a new output directory'); }
  catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;await writeFile(planPath,plan);}
  console.log(`Tasks: ${tasks.length}; Claude configured cap $${o.claudeBudget}; Koda cap $${o.kodaBudget}. No calls unless --execute.`);
  const results:any[]=[];
  for(const t of tasks) {
    const dir=join(root,t.id),repo=join(dir,'repo'),out=join(dir,'result');
    let existing:any;
    try {existing=JSON.parse(await readFile(join(out,'comparison.json'),'utf8'));}catch{}
    if(existing) {results.push({id:t.id,tier:t.tier,...existing});continue;}
    // Never regenerate a partially run comparison or overwrite its candidates.
    try {await readFile(join(out,'inputs.json'));throw Error(`Incomplete run at ${out}; inspect it or use a fresh output directory`);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    await mkdir(repo,{recursive:true});
    for(const [p,text] of Object.entries(t.files)){await mkdir(dirname(join(repo,p)),{recursive:true});await writeFile(join(repo,p),text);}
    await writeFile(join(dir,'acceptance.cjs'),t.acceptance);
    await writeFile(join(dir,'task.txt'),t.task);
    // Syntax-check before payment, never repair malformed checks using model calls.
    new Function(t.acceptance);
    if(!o.execute)continue;
    const check=`node '${join(dir,'acceptance.cjs').replace(/'/g,"'\\''")}'`;
    const r=await compareTask({ baseline:'claude', claudeBudgetUsd:o.claudeBudget/tasks.length, budgetUsd:o.kodaBudget/tasks.length, repo, task:t.task, check, output:out, config:o.config });
    results.push({id:t.id,tier:t.tier,...r});
    console.log(`${t.id}: Claude ${r.results.claude.passed?'PASS':'FAIL'} (${formatWallTime(r.results.claude.wallClockMs)}); Koda ${r.results.koda.passed?'PASS':'FAIL'} (${formatWallTime(r.results.koda.wallClockMs)})`);
    await save(root,results);
  }
  await save(root,results);
  console.log(`Reports: ${root}/suite.md`);
}
export function formatWallTime(ms: unknown): string {
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? `${(ms / 1000).toFixed(3)}s` : 'unknown';
}
async function save(root:string,results:any[]) {
  const lines=['# Koda Auto vs Claude Code: 25-task pilot','','Generated local fixtures, not real-world SWE repositories. Hard tasks require three modules plus a batch API; these labels describe this suite, not calibrated customer difficulty. Claude uses API-only default model; both arms run identical external checks. Times are measured wall-clock for agent + independent check, shown to millisecond resolution; initial repository copying is excluded.','','| Task | Claude | Koda | Claude USD | Koda USD | Claude time | Koda time |','|---|---|---|---:|---:|---:|---:|'];
  for(const r of results)lines.push(`| ${r.id} | ${r.results.claude.passed?'PASS':'FAIL'} | ${r.results.koda.passed?'PASS':'FAIL'} | ${r.results.claude.costUsd ?? 'unknown'} | ${r.results.koda.costUsd ?? 'unknown'} | ${formatWallTime(r.results.claude.wallClockMs)} | ${formatWallTime(r.results.koda.wallClockMs)} |`);
  for(const tier of ['easy','medium','hard','all']) {
    const rows=results.filter(r=>tier==='all'||r.tier===tier);if(!rows.length)continue;
    const complete=rows.every(r=>r.results.claude.costComplete&&r.results.koda.costComplete);
    const c=rows.reduce((n,r)=>n+(r.results.claude.costUsd??0),0),k=rows.reduce((n,r)=>n+(r.results.koda.costUsd??0),0);
    const times = ['claude', 'koda'].map(arm => rows.every(r => typeof r.results[arm].wallClockMs === 'number' && Number.isFinite(r.results[arm].wallClockMs)) ? rows.reduce((n,r)=>n+r.results[arm].wallClockMs,0) : undefined);
    const cs=rows.filter(r=>r.results.claude.passed).length,ks=rows.filter(r=>r.results.koda.passed).length;
    lines.push('',`## ${tier}`,`Claude: ${cs}/${rows.length}; Koda: ${ks}/${rows.length}.`,complete?`Total: Claude $${c.toFixed(6)}; Koda $${k.toFixed(6)}. Cost/solve: Claude ${cs?'$'+(c/cs).toFixed(6):'undefined'}; Koda ${ks?'$'+(k/ks).toFixed(6):'undefined'}.`:'Cost incomplete; no savings claim.',complete&&cs&&cs===ks&&c>0?`Savings per solve: ${(100*(1-k/c)).toFixed(1)}%.`:'No parity-based savings claim: missing receipts or unequal/no solves.');
    lines.push(`Wall time (agent + independent check): Claude ${formatWallTime(times[0])}; Koda ${formatWallTime(times[1])}.`, `Time per solved task (including failed runs): Claude ${cs && times[0] !== undefined ? formatWallTime(times[0]/cs) : 'undefined'}; Koda ${ks && times[1] !== undefined ? formatWallTime(times[1]/ks) : 'undefined'}.`);
  }
  await writeFile(join(root,'suite.json'),JSON.stringify(results,null,2));await writeFile(join(root,'suite.md'),lines.join('\n')+'\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const {values:v}=parseArgs({options:{output:{type:'string'},config:{type:'string',default:'koda.auto.example.json'},execute:{type:'boolean'},profile:{type:'string',default:'all'},'claude-budget-usd':{type:'string'},'koda-budget-usd':{type:'string'},limit:{type:'string',default:'25'},offset:{type:'string',default:'0'}}});
  if(!v.output)throw Error('--output required');
  await runTierSuite({output:v.output,config:resolve(v.config!),execute:!!v.execute,claudeBudget:Number(v['claude-budget-usd']??0),kodaBudget:Number(v['koda-budget-usd']??0),limit:Number(v.limit),profile:v.profile,offset:Number(v.offset)});
}

import { mkdir, readFile, writeFile, rename, rm, lstat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { hash, stableCompare, type Dataset, type Outcome, type Task } from './types.js';
export const DATASET = 'Lance1573/CodeRouterBench';
export const FILES = ['id_results_long.csv', 'id_tasks.jsonl', 'id_probing_results_long.csv', 'id_test_results_long.csv', 'id_probing_tasks.jsonl', 'id_test_tasks.jsonl', 'ood176_results_long.csv', 'ood176_tasks.jsonl', 'models.json', 'README.md'];
export function csv(text: string): Record<string, string>[] {
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false;
  for (let i=0; i<text.length; i++) {
    const c=text[i]!;
    if (quoted) { if (c==='"' && text[i+1]==='"') {cell+='"';i++;} else if(c==='"') quoted=false; else cell+=c; }
    else if(c==='"') { if(cell) throw Error('Invalid CSV quote'); quoted=true; }
    else if(c===',') { row.push(cell);cell=''; }
    else if(c==='\n') { row.push(cell.replace(/\r$/, '')); rows.push(row);row=[];cell=''; }
    else cell+=c;
  }
  if(quoted) throw Error('Unterminated CSV quote');
  if(cell || row.length) {row.push(cell.replace(/\r$/, ''));rows.push(row);}
  const header=rows.shift() ?? []; if(!header.length || new Set(header).size!==header.length) throw Error('Invalid CSV header');
  return rows.filter(r=>r.some(Boolean)).map((r,i)=>{if(r.length!==header.length) throw Error(`CSV row ${i+2}: column mismatch`);return Object.fromEntries(header.map((k,j)=>[k,r[j]!]));});
}
function numeric(v: unknown, field: string, optional = true): number | null {
  if(v===undefined || v===null || v==='') {if(optional) return null;throw Error(`Missing ${field}`);}
  if(typeof v==='boolean' || (typeof v!=='number' && typeof v!=='string') || (typeof v==='string' && !v.trim())) throw Error(`Invalid ${field}`);
  const n=Number(v);if(!Number.isFinite(n) || n<0) throw Error(`Invalid ${field}: ${v}`);return n;
}
function jsonl(text: string): Record<string, unknown>[] {return text.split(/\r?\n/).filter(Boolean).map((l,i)=>{try { const r=JSON.parse(l); if(!r || Array.isArray(r) || typeof r!=='object') throw Error();return r;}catch {throw Error(`Invalid JSONL row ${i+1}`);}});}
export async function acquire(destination: string, revision = 'main') {
  // Resolve once, then ALL files use the immutable revision. No model endpoints.
  const infoResponse=await fetch(`https://huggingface.co/api/datasets/${DATASET}/revision/${encodeURIComponent(revision)}`);
  if(!infoResponse.ok) throw Error(`Dataset metadata HTTP ${infoResponse.status}`);
  const info=await infoResponse.json() as {sha: string; siblings: {rfilename: string}[]};
  if(!/^[a-f0-9]{40}$/.test(info.sha)) throw Error('Dataset lacks immutable revision');
  const target=resolve(destination), temporary=`${target}.partial-${process.pid}`;
  await mkdir(dirname(target),{recursive:true});
  await mkdir(temporary, {recursive:false});
  try {
    const fingerprints: Record<string,string>={};
    for(const file of FILES) {
      if(!info.siblings.some(s=>s.rfilename===file)) throw Error(`Required public file missing: ${file}`);
      const response=await fetch(`https://huggingface.co/datasets/${DATASET}/resolve/${info.sha}/${file}`);
      if(!response.ok) throw Error(`${file}: HTTP ${response.status}`);
      const bytes=Buffer.from(await response.arrayBuffer()); fingerprints[file]=hash(bytes);
      await writeFile(join(temporary,file),bytes,{flag:'wx'});
    }
    await writeFile(join(temporary,'snapshot.json'),JSON.stringify({dataset:DATASET,revision:info.sha,files:fingerprints,snapshot:hash(JSON.stringify(fingerprints))},null,2));
    // Never merge with or overwrite an existing snapshot, even if the revision matches.
    try {await lstat(target);throw Error(`Dataset destination already exists: ${target}`);} catch(e) {if((e as NodeJS.ErrnoException).code!=='ENOENT') throw e;}
    await rename(temporary,target); return target;
  } catch(e) {await rm(temporary,{recursive:true,force:true});throw e;}
}
export async function loadDataset(directory: string): Promise<Dataset> {
  const files: Record<string,string>={}, fingerprints: Record<string,string>={};
  for(const file of FILES) {const bytes=await readFile(join(directory,file));files[file]=bytes.toString('utf8');fingerprints[file]=hash(bytes);}
  let revision: string | null=null;
  try {const snapshot=JSON.parse(await readFile(join(directory,'snapshot.json'),'utf8'));revision=snapshot.revision ?? null;
    for(const file of FILES) if(snapshot.files[file]!==fingerprints[file]) throw Error(`Snapshot fingerprint mismatch: ${file}`);
  } catch(e) {if((e as NodeJS.ErrnoException).code!=='ENOENT') throw e;}
  const parsed=JSON.parse(files['models.json']!);const metadata=new Map<string,Record<string,unknown>>();
  for(const model of parsed.models ?? []) {if(typeof model.model!=='string' || !model.model || metadata.has(model.model)) throw Error('Invalid/duplicate model metadata');metadata.set(model.model,model);}
  if(!metadata.size) throw Error('No model metadata');
  const tasks=new Map<string,Task>();
  const addTasks=(file: string, expected?: Task['taskSplit'])=>{
    for(const r of jsonl(files[file]!)) {
      const taskId=r.task_id;const split=expected ?? r.split;
      if(typeof taskId!=='string' || !taskId || !['probing','id_test','ood'].includes(String(split))) throw Error(`Invalid task in ${file}`);
      const rawText=r.prompt ?? r.task_text ?? r.text; if(rawText!==undefined && typeof rawText!=='string') throw Error(`Malformed task text ${taskId}`);
      const task: Task={taskId,taskText: typeof rawText==='string' && rawText.trim() ? rawText : null,taskSplit:split as Task['taskSplit'],taskDimension:typeof r.dimension==='string'?r.dimension:null,taskMetadata:r};
      if(tasks.has(taskId)) throw Error(`Duplicate/conflicting task ${taskId}`);tasks.set(taskId,task);
    }
  };
  addTasks('id_tasks.jsonl');addTasks('ood176_tasks.jsonl','ood');
  // Split-specific task exports must agree with canonical joins; they aren't extra observations.
  for(const [file,split] of [['id_probing_tasks.jsonl','probing'],['id_test_tasks.jsonl','id_test']] as const) {
    const seen=new Set<string>();
    for(const r of jsonl(files[file]!)) {const t=tasks.get(String(r.task_id)); if(!t || t.taskSplit!==split || r.split!==split || r.dimension!==t.taskDimension || JSON.stringify(r)!==JSON.stringify(t.taskMetadata) || seen.has(t.taskId)) throw Error(`Inconsistent split task ${r.task_id}`);seen.add(t.taskId);}
    if(seen.size!==[...tasks.values()].filter(t=>t.taskSplit===split).length) throw Error(`Incomplete task export ${file}`);
  }
  const outcomes: Outcome[]=[], seen=new Map<string,Outcome>();
  const parseRows=(file: string, expected: Task['taskSplit'] | null, collect: boolean)=>{
    const local=new Set<string>();
    for(const [i,r] of csv(files[file]!).entries()) {
      const t=tasks.get(r.task_id!);if(!t) throw Error(`Missing task join ${r.task_id}`);
      const split=expected ?? r.split;
      if(t.taskSplit!==split || (split!=='ood' && r.split!==split) || r.dimension!==t.taskDimension || r.source_split!==t.taskMetadata.source_split) throw Error(`Inconsistent source split/dimension ${r.task_id}`);
      const modelId=r.model!;const model=metadata.get(modelId);if(!model) throw Error(`Unknown model ${modelId}`);
      const key=JSON.stringify([t.taskId,modelId]);if(local.has(key) || (collect && seen.has(key))) throw Error(`Duplicate task/model observation ${key}`);local.add(key);
      const score=numeric(split==='ood'?r.resolved:r.score,'outcome',false)!;if(score>1) throw Error(`Outcome outside [0,1]: ${score}`);
      if(split==='ood' && ![0,1].includes(score)) throw Error('OOD resolved must be binary');
      const outcome: Outcome={...t,dataset:DATASET,harness:'CodeRouterBench',sourceFile:file,sourceRevisionOrFingerprint:revision ?? fingerprints[file]!,modelId,modelRevision:typeof model.revision==='string'?model.revision:null,modelMetadata:model,outcome:score,costUsd:numeric(r.cost_usd,'cost'),latencyMs:numeric(r.latency_ms,'latency'),inputTokens:numeric(r.input_tokens ?? r.in_tok,'inputTokens'),outputTokens:numeric(r.output_tokens ?? r.out_tok,'outputTokens'),totalTokens:numeric(r.total_tokens,'totalTokens'),rawRecordReference:`${file}:row:${i+2}`};
      for(const n of [outcome.inputTokens,outcome.outputTokens,outcome.totalTokens]) if(n!==null && !Number.isInteger(n)) throw Error('Noninteger tokens');
      if(collect) {seen.set(key,outcome);outcomes.push(outcome);}
      else {const existing=seen.get(key);if(!existing || ['outcome','costUsd','latencyMs','inputTokens','outputTokens','totalTokens'].some(k=>existing[k as keyof Outcome]!==outcome[k as keyof Outcome])) throw Error(`Combined/split outcome mismatch ${key}`);}
    }
    return local.size;
  };
  parseRows('id_probing_results_long.csv','probing',true);parseRows('id_test_results_long.csv','id_test',true);parseRows('ood176_results_long.csv','ood',true);
  const combined=parseRows('id_results_long.csv',null,false);
  if(combined!==outcomes.filter(o=>o.taskSplit!=='ood').length) throw Error('Combined ID export not equivalent to split exports');
  const models=[...metadata.keys()].sort(stableCompare), taskList=[...tasks.values()].sort((a,b)=>stableCompare(a.taskId,b.taskId));
  const counts=new Map<string,number>();for(const o of outcomes) counts.set(o.taskId,(counts.get(o.taskId) ?? 0)+1);
  const countBy=(field:'taskSplit'|'taskDimension')=>Object.fromEntries([...new Set(taskList.map(t=>String(t[field])))].sort().map(v=>[v,taskList.filter(t=>String(t[field])===v).length]));
  const missing=taskList.length*models.length-outcomes.length;
  return {tasks:taskList,models,outcomes,summary:{dataset:DATASET,tasks:taskList.length,models:models.length,modelIds:models,outcomes:outcomes.length,completeMatrices:taskList.filter(t=>counts.get(t.taskId)===models.length).length,missingOutcomes:missing,missingTaskText:taskList.filter(t=>t.taskText===null).length,splits:countBy('taskSplit'),dimensions:countBy('taskDimension'),costCoverage:outcomes.filter(o=>o.costUsd!==null).length/outcomes.length,latencyCoverage:outcomes.filter(o=>o.latencyMs!==null).length/outcomes.length,modelRevisionCoverage:outcomes.filter(o=>o.modelRevision!==null).length/outcomes.length,warnings:taskList.some(t=>t.taskText===null)?['ID_TASK_TEXT_UNAVAILABLE: no ID text retrieval claims; dimension-only features are available']:[]},fingerprint:{dataset:DATASET,revision,files:fingerprints,snapshot:hash(JSON.stringify(fingerprints))}};
}

/** Explicit, capped V6.2 live experiment. Reuses Koda run and existing realBenchmark manifest. */
import {readFile,writeFile,mkdir,cp,rm,access} from 'node:fs/promises';
import {join,resolve,dirname,relative,isAbsolute} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {createHash} from 'node:crypto';
import {execa} from 'execa';
import {z} from 'zod';
import {realBenchmarkSchema} from '../../../src/dev/realBenchmark.js';
import {run} from '../../../src/run.js';
import {config} from '../../../src/config.js';
import {snapshotTree,changesBetween} from '../../../src/workspace/files.js';
import {providerTransport} from '../../../src/provider/transport.js';
import {WriteScope} from '../../../src/repo/writeScope.js';
import {Logger} from '../../../src/telemetry/logger.js';
import {runtimeInfrastructureFailure} from '../../../src/verifier/verifier.js';
import {PilotLedger,startPilotTransport,type PilotModel} from './liveBudget.js';
import {startTier,pilotWorker} from './liveWorker.js';
import {FrozenPilotScores} from './liveScores.js';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
const shellCommand=(argv:string[])=>argv.map(quote).join(' ');
export const caps=(estimate:number)=>{if(!Number.isFinite(estimate)||estimate<=0)throw Error('Explicit frontier estimate required');return {frontier:estimate,dynamic:estimate*1.1};};
export interface PilotRow {taskId:string;arm:'frontier'|'dynamic';verified:boolean;kodaStatus:string;oraclePass:boolean|null;apiCostUsd:number|null;knownCostUsd:number;reservedBudgetUsd:number;tokens:number;wallClockMs:number;switches:number;actions:unknown[];verification:unknown;error?:string}
export function comparison(rows:readonly PilotRow[]){return ['frontier','dynamic'].map(arm=>{const a=rows.filter(r=>r.arm===arm);const solved=a.filter(r=>r.verified).length;const actual=a.every(r=>r.apiCostUsd!==null)?a.reduce((n,r)=>n+r.apiCostUsd!,0):null;return {arm,tasks:a.length,verifiedSolved:solved,totalApiCostUsd:actual,costPerVerifiedSolve:solved&&actual!==null?actual/solved:null,runtimeMs:a.reduce((n,r)=>n+r.wallClockMs,0),switches:a.reduce((n,r)=>n+r.switches,0)};});}
export function catalogModels(catalog:any,reference:string):PilotModel[]{
 const a=catalog.data??catalog.models??catalog;if(!Array.isArray(a))throw Error('Catalog requires cached OpenRouter model array');
 const frozen=JSON.parse(requireRead(join(ROOT,'artifacts/predictor.json'),'utf8'));const eligible=a.filter((m:any)=>frozen.models.includes(String(m.id).split('/').slice(1).join('/'))&&m.supported_parameters?.includes('tools')&&m.supported_parameters?.includes('tool_choice')).map((m:any)=>({id:m.id,tier:'cheap' as PilotModel['tier'],inputUsdPerMillion:Number(m.pricing?.prompt)*1e6,outputUsdPerMillion:Number(m.pricing?.completion)*1e6,contextTokens:m.context_length,supportedParameters:m.supported_parameters})).filter((m:PilotModel)=>[m.inputUsdPerMillion,m.outputUsdPerMillion].every(n=>Number.isFinite(n)&&n>=0)&&Number.isSafeInteger(m.contextTokens)&&m.contextTokens>4096).sort((a:PilotModel,b:PilotModel)=>a.inputUsdPerMillion+a.outputUsdPerMillion-b.inputUsdPerMillion-b.outputUsdPerMillion);
 if(!eligible.some((m:PilotModel)=>m.id===reference)||eligible.length<2)throw Error('Compatible frontier + cheaper model required in factual catalog');
 for(let i=0;i<eligible.length;i++)eligible[i]!.tier=eligible[i]!.id===reference?'frontier':i<Math.ceil(eligible.length/2)?'cheap':'strong';
 if(!eligible.some((m:PilotModel)=>m.tier==='strong'))eligible.find((m:PilotModel)=>m.id!==reference)!.tier='strong';return eligible;
}
import {readFileSync as requireRead} from 'node:fs';
export async function runLivePilot(options:{manifest:string;catalog:string;output:string;estimateUsd:number;budgetUsd:number;execute?:boolean;resume?:boolean;limit?:number}){
 const manifest=realBenchmarkSchema.parse(JSON.parse(await readFile(resolve(options.manifest),'utf8')));const tasks=manifest.tasks.filter(t=>t.split==='development').slice(0,options.limit??10);
 if(tasks.length!==10)throw Error('Pilot requires exactly 10 real development SWE tasks, not synthetic examples');
 const plan=JSON.parse(await readFile(resolve(ROOT,'../cold-start-v3/artifacts/data-plan/data-plan.json'),'utf8'));const official=new Map<string,any>(Object.values(plan.metadata).map((m:any)=>[m.instance_id,m]));
 for(const t of tasks){const m=official.get(t.id);if(!m||m.base_commit!==t.commit||m.problem_statement!==t.task)throw Error('Manifest task must exactly match public SWE issue/base commit; no synthetic substitution: '+t.id);}
 const frozen=JSON.parse(await readFile(join(ROOT,'artifacts/frozen.json'),'utf8'));const catalog=JSON.parse(await readFile(resolve(options.catalog),'utf8'));const referenceEntry=(catalog.data??catalog.models??catalog).find((m:any)=>String(m.id).split('/').slice(1).join('/')===frozen.reference);if(!referenceEntry)throw Error('Frozen reference unavailable');const frontier=referenceEntry.id;const models=catalogModels(catalog,frontier);
 const c=caps(options.estimateUsd);const maxTotal=tasks.length*(c.frontier+c.dynamic);
 if(!Number.isFinite(options.budgetUsd)||options.budgetUsd<maxTotal-1e-9)throw Error(`Budget must cover frozen paired maximum $${maxTotal.toFixed(4)}; lower --frontier-estimate-usd or use a sufficient explicit budget`);
 const output=resolve(options.output);await mkdir(output,{recursive:true});const identity=createHash('sha256').update(JSON.stringify({tasks,models,c,budgetUsd:options.budgetUsd,predictor:await readFile(join(ROOT,'artifacts/predictor.json'),'utf8')})).digest('hex');
 const statePath=join(output,'state.json');let saved:any;try{saved=JSON.parse(await readFile(statePath,'utf8'));}catch{}
 if(saved&&(!options.resume||saved.identity!==identity))throw Error('Resume requires identical frozen tasks/models/caps');
 const state=saved??{identity,rows:[] as PilotRow[],inFlight:null};
 if(state.inFlight)throw Error('Previous request/run incomplete: cost unknown; do not automatically replay it');
 const prepared=[];
 // ALL environment/acceptance checks before ANY provider dispatch.
 for(const task of tasks){const base=join(output,task.id,'base'),oracle=join(output,task.id,'oracle');const source=resolve(dirname(resolve(options.manifest)),task.repo);const oracleSource=resolve(dirname(resolve(options.manifest)),task.oracleDirectory);if(!relative(source,oracleSource).startsWith('..')&&!isAbsolute(relative(source,oracleSource)))throw Error('Oracle must be outside candidate source');await access(source);await access(oracleSource);
  const allowedIds=new Set(plan.split.parts.final_holdout.filter((id:string)=>id.startsWith('swe-bench:')).map((id:string)=>plan.metadata[id].instance_id));if(!allowedIds.has(task.id))throw Error('Pilot must exclude frozen predictor training tasks: '+task.id);
  if(!saved){await mkdir(dirname(base),{recursive:true});await execa('git',['clone','--no-hardlinks','--no-checkout','--',source,base]);await execa('git',['checkout','--detach',task.commit],{cwd:base});await rm(join(base,'.git'),{recursive:true,force:true});await cp(oracleSource,oracle,{recursive:true});}
  const oracleHash=(await snapshotTree(oracle)).files;const baseBefore=await snapshotTree(base);const result=await execa(task.acceptance.argv[0]!,[...task.acceptance.argv.slice(1),base],{cwd:oracle,reject:false,timeout:task.acceptance.timeoutMs,env:{OPENAI_API_KEY:'',OPENROUTER_API_KEY:'',CODEX_API_KEY:''}});
  await writeFile(join(output,task.id,'baseline-acceptance.json'),JSON.stringify({exitCode:result.exitCode,stdout:result.stdout,stderr:result.stderr},null,2));
  const check={command:shellCommand(task.acceptance.argv),exitCode:result.exitCode??1,stdout:result.stdout,stderr:result.stderr,wallClockMs:0,timedOut:result.timedOut};if(result.exitCode===0)throw Error('Baseline already passes: task cannot prove a new solve: '+task.id);if(runtimeInfrastructureFailure(check)||/ModuleNotFoundError|ImportError|command not found|No such file or directory/.test(result.stderr)||result.timedOut)throw Error('Acceptance environment unavailable: '+task.id);
  if(changesBetween(baseBefore,await snapshotTree(base)).length)throw Error('Baseline acceptance mutated source; validator must isolate its own test patches');
  if(JSON.stringify((await snapshotTree(oracle)).files)!==JSON.stringify(oracleHash))throw Error('Oracle mutated during baseline');
  const tier=await startTier(task.task,base,task.writeScope);prepared.push({task,base,oracle,tier,oracleHash});
 }
 await writeFile(join(output,'plan.json'),JSON.stringify({identity,frontier,models,caps:c,maximumApiCostUsd:maxTotal,tasks:prepared.map(p=>({id:p.task.id,startTier:p.tier.tier,reason:p.tier.reason})),paidCalls:0,estimateProvenance:'explicit user-supplied frozen frontier-only estimate; not a measured baseline cost'},null,2));
 if(!options.execute)return {mode:'preflight',maximumApiCostUsd:maxTotal,paidCalls:0};
 if(process.env.KODA_ALLOW_PAID_V62_PILOT!=='1')throw Error('Explicit KODA_ALLOW_PAID_V62_PILOT=1 plus --execute required');
 const upstream=providerTransport();if(upstream.mode!=='backend')throw Error('Live pilot requires server-key backend mode');const scorer=new FrozenPilotScores(join(ROOT,'artifacts/predictor.json'));
 for(const p of prepared)for(const arm of ['frontier','dynamic'] as const){if(state.rows.some((r:PilotRow)=>r.taskId===p.task.id&&r.arm===arm))continue;
  const root=join(output,p.task.id,arm),repo=join(root,'repo');await mkdir(root,{recursive:true});await cp(p.base,repo,{recursive:true});const cap=arm==='frontier'?c.frontier:c.dynamic;const ledger=new PilotLedger(cap);const transport=await startPilotTransport(upstream.baseUrl,upstream.apiKey,models,ledger);const oldUrl=process.env.KODA_API_URL;process.env.KODA_API_URL=transport.url;
  state.inFlight={taskId:p.task.id,arm,maximumCostUsd:cap};await writeFile(statePath,JSON.stringify(state,null,2));const start=Date.now();let status='NOT_FULLY_VERIFIED',oraclePass:boolean|null=null,error:string|undefined,verification:unknown=null;
  try{
   const cfg=await config(undefined,{models:{SCOUT_MODEL:frontier,CHEAP_CODER_A:frontier,CHEAP_CODER_B:frontier,STRONG_MODEL:frontier,FRONTIER_MODEL:frontier},forceModel:frontier,budgetUsd:cap,maxParallel:1,stageMaxUsd:cap,stageMaxTokens:65536,maxTokens:200000,maxIterations:18,maxMinutes:15});for(const key of Object.keys(cfg.registry))cfg.registry[key as keyof typeof cfg.registry]=frontier;
   const summary=await run({repo,dependencyRoot:resolve(dirname(resolve(options.manifest)),p.task.repo),task:p.task.task,config:cfg,verify:p.task.verification.map(v=>shellCommand(v.argv)),output:join(root,'report'),quiet:true,offlineCalibration:true,apply:true,codingWorkerFactory:gateway=>pilotWorker(gateway,{dynamic:arm==='dynamic',models,frontier,profile:p.tier.profile,tier:p.tier.tier,ledger,scope:p.task.writeScope,output:join(root,'trajectory'),scorer,qualityValueUsd:options.estimateUsd})});
   status=summary.status;verification=summary;
   const before=await snapshotTree(repo);const accepted=await execa(p.task.acceptance.argv[0]!,[...p.task.acceptance.argv.slice(1),repo],{cwd:p.oracle,reject:false,timeout:p.task.acceptance.timeoutMs});await writeFile(join(root,'acceptance.json'),JSON.stringify({exitCode:accepted.exitCode,stdout:accepted.stdout,stderr:accepted.stderr},null,2));oraclePass=accepted.exitCode===0;
   const logger=new Logger(join(root,'scope-audit'),'pilot',true);const scope=new WriteScope(p.task.writeScope,logger,'pilot');if(changesBetween(await snapshotTree(p.base),before).some(c=>!scope.allows(c.path)))throw Error('Independent write-scope violation');if(changesBetween(before,await snapshotTree(repo)).length)throw Error('Acceptance mutated candidate');if(JSON.stringify((await snapshotTree(p.oracle)).files)!==JSON.stringify(p.oracleHash))throw Error('Independent oracle mutated');
  }catch(e){error=String(e);oraclePass=null;}finally{if(oldUrl===undefined)delete process.env.KODA_API_URL;else process.env.KODA_API_URL=oldUrl;await transport.close();}
  let actions:any[]=[];try{actions=JSON.parse(await readFile(join(root,'trajectory/actions.json'),'utf8'));}catch{}
  const row:PilotRow={taskId:p.task.id,arm,verified:status==='VERIFIED_SUCCESS'&&oraclePass===true&&!error&&!ledger.uncertain,kodaStatus:status,oraclePass,apiCostUsd:ledger.uncertain?null:ledger.spent,knownCostUsd:ledger.spent,reservedBudgetUsd:cap,tokens:ledger.receipts.reduce((n,r)=>n+r.inputTokens+r.outputTokens,0),wallClockMs:Date.now()-start,switches:actions.filter(a=>a.decision==='SWITCH').length,actions,verification,error};state.rows.push(row);state.inFlight=null;await writeFile(join(root,'receipts.json'),JSON.stringify(ledger.receipts,null,2));await writeFile(statePath,JSON.stringify(state,null,2));await writeFile(join(output,'comparison.json'),JSON.stringify(comparison(state.rows),null,2));console.log(`${p.task.id} ${arm}: ${row.verified?'VERIFIED_SUCCESS':status} cost=${row.apiCostUsd??'UNKNOWN'}`);
  if(ledger.uncertain)throw Error('Cost unknown or provider bound violated; stop entire pilot');
 }
 const report=comparison(state.rows);await writeFile(join(output,'REPORT.md'),'# Actual V6.2 live pilot\n\n'+JSON.stringify(report,null,2)+'\n');return {mode:'executed',report};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const{values}=parseArgs({options:{manifest:{type:'string'},catalog:{type:'string'},output:{type:'string'},'frontier-estimate-usd':{type:'string'},'budget-usd':{type:'string'},execute:{type:'boolean'},resume:{type:'boolean'},limit:{type:'string'}}});if(!values.manifest||!values.catalog||!values.output||!values['frontier-estimate-usd']||!values['budget-usd'])throw Error('Requires --manifest --catalog --output --frontier-estimate-usd --budget-usd; default preflight, --execute explicitly authorizes paid calls');console.log(await runLivePilot({manifest:values.manifest,catalog:values.catalog,output:values.output,estimateUsd:Number(values['frontier-estimate-usd']),budgetUsd:Number(values['budget-usd']),execute:values.execute,resume:values.resume,limit:values.limit?Number(values.limit):10}));}

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {config} from '../src/config.js';
import {run} from '../src/run.js';
import {startFakeProvider} from '../src/dev/fakeProvider.js';
import {AgenticCodingWorker} from '../src/agent/agenticCodingWorker.js';
import {deterministicRepositoryExploration} from '../src/agent/openHandsExplorer.js';
import {fitContextualQuality} from '../src/router/contextualQuality.js';
import {canonicalRoutingTask} from '../src/router/canonicalTask.js';
import type {CanonicalQualityObservation} from '../src/router/knowledge/canonical.js';

for (const authority of ['cold-start','openrouter-auto'] as const) test(`${authority} real pipeline rejects bad cheap mutation, reserves rescue, and applies verified reference mutation`,async(t)=>{
 const root=await mkdtemp(join(tmpdir(),'koda-cold-flow-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const repo=join(root,'repo');await mkdir(join(repo,'src'),{recursive:true});await mkdir(join(repo,'tests'),{recursive:true});
 await writeFile(join(repo,'package.json'),JSON.stringify({scripts:{test:'node --test tests/*.test.cjs',typecheck:'node --check src/value.cjs'}}));
 await writeFile(join(repo,'src/value.cjs'),'exports.value=1;\n');
 await writeFile(join(repo,'tests/value.test.cjs'),"const {test}=require('node:test');const a=require('node:assert/strict');test('positive invariant',()=>a.ok(require('../src/value.cjs').value>0));\n");
 const read={stage:'worker' as const,toolCalls:[{name:'read_file',arguments:{path:'src/value.cjs'}}]};
 const write=(value:number)=>({stage:'worker' as const,toolCalls:[{name:'write_file',arguments:{path:'src/value.cjs',content:`exports.value=${value};\n`}}]});
 const keys=['NODE_ENV','KODA_PROVIDER_MODE','KODA_API_URL','OPENROUTER_API_KEY'];const previous=new Map(keys.map(k=>[k,process.env[k]]));
 process.env.NODE_ENV='test';delete process.env.OPENROUTER_API_KEY;
 t.after(()=>{for(const [k,v] of previous)if(v===undefined)delete process.env[k];else process.env[k]=v;});
 const review={stage:'review' as const,review:{passed:true,evidence:'src/value.cjs exports the requested value 2 and the invariant test passes'}};
 const provider=await startFakeProvider({steps:[{...read,...(authority==='openrouter-auto'?{servedModel:'koda-test/cheap'}:{})},write(-1),read,write(2),review,review,review,review]});t.after(()=>provider.close());
 process.env.KODA_PROVIDER_MODE='backend';process.env.KODA_API_URL=provider.baseUrl;
 const ids=['koda-test/cheap','koda-test/reference'];
 const nativeTask=canonicalRoutingTask({family:'implementation',engine:'direct',harness:'koda'});
 const rows:CanonicalQualityObservation[]=ids.flatMap(model=>Array.from({length:2500},(_,i)=>({id:`${model}:${i}`,taskId:`native-${i}`,task:{...nativeTask,text:`Independent bounded task ${i}`,textDigest:`task-${i}`},model,
  identity:'SOURCE_EXACT' as const,source:'native',origin:'local' as const,split:'local' as const,provenance:'native:fixture',timestamp:'2026-10-07',success:true,outcome:'VERIFIED_SUCCESS',proof:{independent:true,requirementLevel:true},trainingAllowed:true})));
 const artifact=fitContextualQuality(rows,'empirical','fixture');const file=join(root,'evidence.json');
 await writeFile(file,JSON.stringify({version:1,artifact,sources:[{provenance:'native:fixture',license:'native-koda',revision:'fixture',url:'koda://test'}]}));
 const c=await config(undefined,{baseUrl:provider.baseUrl,models:Object.fromEntries(['SCOUT_MODEL','CHEAP_CODER_A','CHEAP_CODER_B','STRONG_MODEL','FRONTIER_MODEL'].map(role=>[role,ids[1]])),
  modelPool:{provider:authority==='openrouter-auto'?'openrouter':'test',models:ids.map((id,i)=>({id,tier:i?'frontier':'cheap',qualityPrior:.1,latencyPriorMs:1000,fallback:{inputPrice:i?1:.01,outputPrice:i?1:.01,available:true,contextLength:100000,maxOutputTokens:10000,supportedParameters:['tools','tool_choice']}}))},
  routing:{authority,stateDirectory:join(root,'history'),...(authority==='openrouter-auto'?{openRouterAuto:{models:ids,referenceModel:ids[1],costTier:'low'}}:{coldStart:{models:ids,referenceModel:ids[1],evidenceFile:file}})},
  semanticRouter:{enabled:false},maxIterations:3,maxOutputTokens:1200,stageMaxTokens:30000,budgetUsd:authority==='openrouter-auto'?.0335:1,maxTokens:200000,maxMinutes:2});
 const output=join(root,'report');const result=await run({repo,task:'Modify src/value.cjs to export value=2. Preserve existing tests.',config:c,output,quiet:true,apply:true,syntheticTelemetry:true,
  codingWorkerFactory:(gateway:import("../src/openrouter/client.js").Gateway)=>{
   const worker=new AgenticCodingWorker(gateway.budget,gateway.logger);
   const originalRun=worker.run.bind(worker);
   worker.run=async(input)=>{
    assert.equal(input.requestTimeoutMs,gateway.config.modelTimeoutMs.implementation,
      'tiny tasks must inherit the configured provider deadline, not a hidden 12s cap');
    return originalRun(input);
   };
   return worker;
  },
  repositoryExplorerFactory:()=>({explore:({repoPath,task,profile})=>deterministicRepositoryExploration(repoPath,task,profile)})});
 if(result.status!=='VERIFIED_SUCCESS') console.error(await readFile(join(output,'events.jsonl'),'utf8'));
 assert.equal(result.status,'VERIFIED_SUCCESS',JSON.stringify({error:result.error,requests:provider.requests.map(r=>({stage:r.stage,model:r.payload.model}))}));
 assert.equal((await readFile(join(repo,'src/value.cjs'),'utf8')).trim(),'exports.value=2;');
 const served=provider.requests.filter(r=>r.stage==='worker').map(r=>r.payload.model);
 assert.ok(served.includes(ids[0]),JSON.stringify(served));assert.ok(served.includes(ids[1]),JSON.stringify(served));
 if(authority==='openrouter-auto') {
  const calls=provider.requests.filter(r=>r.stage==='worker');
  assert.equal(calls[0]!.payload.model,'openrouter/auto');
  assert.deepEqual(calls[0]!.payload.plugins,[{id:'auto-router',allowed_models:[ids[0]],cost_tier:'low'}]);
  assert.equal(calls[1]!.payload.model,ids[0]);
  assert.equal(calls[1]!.payload.plugins,undefined,'concrete model stays pinned');
 }
 const events=(await readFile(join(output,'events.jsonl'),'utf8')).trim().split('\n').map(l=>JSON.parse(l));
 assert.ok(events.some(e=>e.type==='adaptive_recovery_decision'&&e.recovery_model===ids[1]));
 const workers=events.filter(e=>e.type==='coding_worker_start');assert.equal(workers.length,2);
 const decision=events.find(e=>e.type===(authority==='openrouter-auto'?'openrouter_auto_route':'cold_start_route'));assert.ok(decision);
 assert.ok(workers[0].attempt_budget_usd<=(authority==='openrouter-auto'?.03:.003)+1e-9,'first worker cannot spend reserved reference funds');
 if(authority==='openrouter-auto') {
  assert.ok(Number(decision.forecastAttemptUsd)>Number(decision.allocatedAttemptUsd));
  assert.ok(workers[0].attempt_budget_usd<=Number(decision.allocatedAttemptUsd)+1e-9);
  assert.ok(Number(decision.reservedAttemptUsd)+Number(decision.completionReserveUsd)<=c.budgetUsd+1e-9);
 }
 assert.ok(events.every(e=>e.synthetic===true),'fake model outcomes remain synthetic');
});

for(const scenario of ['missing-tests','failed-check','continuation-provider-failure','interrupted-candidate','review-timeout','review-protocol'] as const) test(`Auto recovery preserves candidate and test evidence: ${scenario}`,async(t)=>{
 const root=await mkdtemp(join(tmpdir(),'koda-retained-flow-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const repo=join(root,'repo');await mkdir(join(repo,'src'),{recursive:true});await mkdir(join(repo,'tests'),{recursive:true});
 await writeFile(join(repo,'package.json'),JSON.stringify({scripts:{test:'node --test tests/*.test.cjs',typecheck:'node --check src/value.cjs'}}));
 await writeFile(join(repo,'src/value.cjs'),'exports.value=1;\n');
 const originalTest="const {test}=require('node:test');test('placeholder',()=>{});\n";
 const candidateTest="const {test}=require('node:test');const a=require('node:assert/strict');test('retained contract',()=>a.equal(require('../src/value.cjs').value,2));\n";
 await writeFile(join(repo,'tests/value.test.cjs'),originalTest);
 const read={stage:'worker' as const,toolCalls:[{name:'read_file',arguments:{path:'src/value.cjs'}},{name:'read_file',arguments:{path:'tests/value.test.cjs'}}]};
 const write=(p:string,content:string)=>({stage:'worker' as const,toolCalls:[{name:'write_file',arguments:{path:p,content}}]});
 const done={stage:'worker' as const,content:'Implementation complete.'};
 const review={stage:'review' as const,review:{passed:true,evidence:'Candidate implements value=2 and the requested regression test verifies value=2.'}};
 const steps=scenario==='review-timeout' || scenario==='review-protocol'
  ? [{...read,servedModel:'koda-test/cheap'},write('src/value.cjs','exports.value=2;\n'),write('tests/value.test.cjs',candidateTest),done,(scenario==='review-timeout' ? {stage:'review' as const,error:{status:408,message:'Request timed out'}} : {stage:'review' as const,content:'Not structured JSON'}),review,review,review,review,review,review,review,review]
  : scenario==='interrupted-candidate'
  ? [{...read,servedModel:'koda-test/cheap'},write('src/value.cjs','exports.value=2;\n'),{stage:'worker' as const,error:{status:408,message:'Request timed out'}},write('tests/value.test.cjs',candidateTest),done,review,review,review,review,review,review,review,review]
  : scenario==='continuation-provider-failure'
  ? [{...read,servedModel:'koda-test/cheap'},write('src/value.cjs','exports.value=2;\n'),done,{stage:'worker' as const,error:{status:408,message:'Request timed out'}},{stage:'worker' as const,error:{status:408,message:'Request timed out'}},write('tests/value.test.cjs',candidateTest),done,review,review,review,review,review,review,review,review]
  : scenario==='missing-tests'
  ? [{...read,servedModel:'koda-test/cheap'},write('src/value.cjs','exports.value=2;\n'),done,write('tests/value.test.cjs',candidateTest),done,review,review,review,review,review,review,review,review]
  : [{...read,servedModel:'koda-test/cheap'},write('src/value.cjs','exports.value=-1;\n'),write('tests/value.test.cjs',candidateTest),read,write('src/value.cjs','exports.value=2;\n'),done,review,review,review,review,review,review,review,review];
 const previous=new Map(['NODE_ENV','KODA_PROVIDER_MODE','KODA_API_URL','OPENROUTER_API_KEY'].map(k=>[k,process.env[k]]));
 process.env.NODE_ENV='test';delete process.env.OPENROUTER_API_KEY;
 t.after(()=>{for(const [k,v] of previous)if(v===undefined)delete process.env[k];else process.env[k]=v;});
 const provider=await startFakeProvider({steps});t.after(()=>provider.close());
 process.env.KODA_PROVIDER_MODE='backend';process.env.KODA_API_URL=provider.baseUrl;
 const ids=['koda-test/cheap','koda-test/reference'];
 const c=await config(undefined,{baseUrl:provider.baseUrl,models:Object.fromEntries(['SCOUT_MODEL','CHEAP_CODER_A','CHEAP_CODER_B','STRONG_MODEL','FRONTIER_MODEL'].map(role=>[role,(scenario==='review-timeout' || scenario==='review-protocol') && role==='SCOUT_MODEL' ? ids[0] : ids[1]])),
  modelPool:{provider:'openrouter',models:ids.map((id,i)=>({id,tier:i?'frontier':'cheap',qualityPrior:.1,latencyPriorMs:1000,fallback:{inputPrice:i?1:.01,outputPrice:i?1:.01,available:true,contextLength:100000,maxOutputTokens:10000,supportedParameters:['tools','tool_choice']}}))},
  routing:{authority:'openrouter-auto',stateDirectory:join(root,'history'),openRouterAuto:{models:ids,referenceModel:ids[1],costTier:'low'}},semanticRouter:{enabled:false},maxIterations:3,maxOutputTokens:1200,stageMaxTokens:30000,budgetUsd:scenario==='interrupted-candidate'?.0335:1,maxTokens:200000,maxMinutes:2});
 const output=join(root,'report');const result=await run({repo,task:'Modify src/value.cjs to export value=2. Add a regression test in tests/value.test.cjs. Preserve other files.',config:c,output,quiet:true,apply:true,syntheticTelemetry:true,
 repositoryExplorerFactory:()=>({explore:({repoPath,profile,task}:any)=>deterministicRepositoryExploration(repoPath,profile,task)})});
 assert.equal(result.status,'VERIFIED_SUCCESS',JSON.stringify({error:result.error,requests:provider.requests.map(r=>({stage:r.stage,model:r.payload.model}))}));
 assert.equal(await readFile(join(repo,'tests/value.test.cjs'),'utf8'),candidateTest,'test must survive repair and escalation');
 assert.equal((await readFile(join(repo,'src/value.cjs'),'utf8')).trim(),'exports.value=2;');
 const events=(await readFile(join(output,'events.jsonl'),'utf8')).trim().split('\n').map(l=>JSON.parse(l));
 if(scenario==='review-protocol'){
  const reviews=provider.requests.filter(r=>r.stage==='review');
  assert.ok(reviews.length>=2);
  assert.equal(reviews[0]!.payload.model,'koda-test/cheap');
  assert.equal(reviews[1]!.payload.model,'koda-test/reference','malformed review must still use stronger structured retry');
  assert.equal(events.filter(e=>e.type==='coding_worker_start').length,1,'malformed review must not start coding repair');
 }else if(scenario==='review-timeout'){
  const reviews=provider.requests.filter(r=>r.stage==='review');
  assert.ok(reviews.length>=2);
  assert.ok(reviews.every(r=>r.payload.model==='koda-test/cheap'),'transport retry must retain cheap reviewer');
  const reviewCalls=events.filter(e=>e.type==='model_call'&&e.stage==='completion-review');
  assert.ok(reviewCalls.length>=2);
  assert.ok(reviewCalls.every(e=>e.timeoutMs===c.modelTimeoutMs.implementation),'review must use configured stage deadline instead of hidden first/retry timeouts');
  assert.equal(events.filter(e=>e.type==='coding_worker_start').length,1);
  assert.ok(events.some(e=>e.type==='completion_review_protocol_retry'&&e.retry_reason==='transport'&&e.from_model===e.to_model));
 }else if(scenario==='interrupted-candidate'){
  const continuation=events.find(e=>e.type==='completion_continuation');
  assert.equal(continuation?.to_model,'koda-test/reference');
  assert.equal(continuation?.escalated,true);
  assert.ok(events.some(e=>e.type==='adaptive_recovery_decision'&&e.failure_mode==='operational'));
  assert.ok(!events.some(e=>e.type==='execution_plan_exhausted'));
  const workers=events.filter(e=>e.type==='coding_worker_start');assert.equal(workers.length,2);
  assert.equal(workers[1].model,'koda-test/reference');
  assert.match(JSON.stringify(provider.requests.filter(r=>r.payload.model==='koda-test/reference').map(r=>r.payload.messages)),/exports.value=2/);
 }else if(scenario==='missing-tests'){
  assert.ok(provider.requests.filter(r=>r.stage==='worker').every(r=>r.payload.model!=='koda-test/reference'));
  assert.ok(events.some(e=>e.type==='agentic_missing_tests_continuation'));
  assert.equal(events.filter(e=>e.type==='coding_worker_start').length,1,'missing tests must be completed without reopening a worker');
  assert.ok(!events.some(e=>e.type==='completion_continuation'));
  assert.equal(provider.requests.filter(r=>r.stage==='worker')[3]!.payload.model,'koda-test/cheap');
 }else{
  if(scenario==='failed-check')assert.ok(events.some(e=>e.type==='verification_candidate_preserved'));
  const reference=provider.requests.filter(r=>r.stage==='worker'&&r.payload.model==='koda-test/reference');
  assert.ok(reference.length>0);
  if(scenario==='failed-check')assert.match(JSON.stringify(reference.map(r=>r.payload.messages)),/retained contract/);
  else {
   const workers=provider.requests.filter(r=>r.stage==='worker');
   const firstReference=workers.findIndex(r=>r.payload.model==='koda-test/reference');
   assert.ok(firstReference>=0);
   assert.ok(workers.slice(firstReference).every(r=>r.payload.model==='koda-test/reference'),'stale pin must never override operational recovery authority');
  }
 }
});

test('real pipeline blocks wrong public return shape and never applies it',async(t)=>{
 const root=await mkdtemp(join(tmpdir(),'koda-return-contract-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const repo=join(root,'repo');await mkdir(join(repo,'src'),{recursive:true});await mkdir(join(repo,'tests'),{recursive:true});
 const original='module.exports = () => 1;\n';
 await writeFile(join(repo,'src/value.cjs'),original);
 await writeFile(join(repo,'package.json'),JSON.stringify({scripts:{test:'node --test tests/*.test.cjs',typecheck:'node --check src/value.cjs'}}));
 await writeFile(join(repo,'tests/value.test.cjs'),"const {test}=require('node:test');const a=require('node:assert/strict');test('public return type',()=>a.equal(typeof require('../src/value.cjs')(),'number'));\n");
 const keys=['NODE_ENV','KODA_PROVIDER_MODE','KODA_API_URL','OPENROUTER_API_KEY'];const prior=new Map(keys.map(k=>[k,process.env[k]]));
 process.env.NODE_ENV='test';delete process.env.OPENROUTER_API_KEY;
 t.after(()=>{for(const[k,v]of prior)if(v===undefined)delete process.env[k];else process.env[k]=v;});
 const provider=await startFakeProvider({steps:Array.from({length:6},()=>({stage:'review' as const,review:{passed:true,evidence:'Candidate claims completion'}}))});t.after(()=>provider.close());
 process.env.KODA_PROVIDER_MODE='backend';process.env.KODA_API_URL=provider.baseUrl;
 const id='koda-test/reference';const cfg=await config(undefined,{baseUrl:provider.baseUrl,
  models:Object.fromEntries(['SCOUT_MODEL','CHEAP_CODER_A','CHEAP_CODER_B','STRONG_MODEL','FRONTIER_MODEL'].map(role=>[role,id])),
  modelPool:{provider:'test',models:[{id,tier:'frontier',qualityPrior:1,fallback:{inputPrice:1,outputPrice:1,available:true,contextLength:100000,maxOutputTokens:10000,supportedParameters:['tools','tool_choice']}}]},
  routing:{authority:'cold-start',stateDirectory:join(root,'history'),coldStart:{models:[id],referenceModel:id}},semanticRouter:{enabled:false},maxIterations:1,budgetUsd:1});
 let mutations=0;
 const result=await run({repo,task:'Modify src/value.cjs. Export a function returning the number 2. Preserve existing tests.',config:cfg,output:join(root,'report'),quiet:true,apply:true,syntheticTelemetry:true,
  codingWorkerFactory:()=>({run:async(input)=>{
   mutations++;await writeFile(join(input.repoPath,'src/value.cjs'),'module.exports = () => [{value:2}];\n');
   return {exitStatus:'completed' as const,model:id,engine:'agentic' as const,engineVersion:'test',wallClockMs:1,changedPaths:['src/value.cjs'],terminationReason:'candidate_ready_for_verification'};
  }}),
  repositoryExplorerFactory:()=>({explore:({repoPath,task,profile})=>deterministicRepositoryExploration(repoPath,task,profile)})});
 assert.ok(mutations>0);
 assert.notEqual(result.status,'VERIFIED_SUCCESS');
 assert.equal(await readFile(join(repo,'src/value.cjs'),'utf8'),original);
 const summary=JSON.parse(await readFile(join(root,'report/summary.json'),'utf8'));
 assert.notEqual(summary.applyResult,'applied');
});

for(const failure of ['implementation','new-expectation'] as const) test(`bounded verification repair diagnoses ${failure} with fresh source and assertion reads`,async(t)=>{
 const root=await mkdtemp(join(tmpdir(),'koda-contract-repair-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const repo=join(root,'repo');await mkdir(join(repo,'src'),{recursive:true});await mkdir(join(repo,'tests'),{recursive:true});
 await writeFile(join(repo,'src/value.cjs'),'exports.value=1;\n');
 const original="const {test}=require('node:test');const a=require('node:assert/strict');test('existing positive invariant',()=>a.ok(require('../src/value.cjs').value>0));\n";
 const testSource=(expected:number)=>original+`test('requested value',()=>a.equal(require('../src/value.cjs').value,${expected}));\n`;
 await writeFile(join(repo,'tests/value.test.cjs'),original);
 await writeFile(join(repo,'package.json'),JSON.stringify({scripts:{test:'node --test tests/*.test.cjs',typecheck:'node --check src/value.cjs'}}));
 const keys=['NODE_ENV','KODA_PROVIDER_MODE','KODA_API_URL','OPENROUTER_API_KEY'];const prior=new Map(keys.map(k=>[k,process.env[k]]));
 process.env.NODE_ENV='test';delete process.env.OPENROUTER_API_KEY;
 t.after(()=>{for(const[k,v]of prior)if(v===undefined)delete process.env[k];else process.env[k]=v;});
 const provider=await startFakeProvider({steps:Array.from({length:8},()=>({stage:'review' as const,review:{passed:true,evidence:'Source exports value 2; unchanged positive invariant and new regression assertion for 2 both pass.'}}))});t.after(()=>provider.close());
 process.env.KODA_PROVIDER_MODE='backend';process.env.KODA_API_URL=provider.baseUrl;
 const id='koda-test/reference';const cfg=await config(undefined,{baseUrl:provider.baseUrl,
  models:Object.fromEntries(['SCOUT_MODEL','CHEAP_CODER_A','CHEAP_CODER_B','STRONG_MODEL','FRONTIER_MODEL'].map(role=>[role,id])),
  modelPool:{provider:'test',models:[{id,tier:'frontier',qualityPrior:1,fallback:{inputPrice:1,outputPrice:1,available:true,contextLength:100000,maxOutputTokens:10000,supportedParameters:['tools','tool_choice']}}]},
  routing:{authority:'cold-start',stateDirectory:join(root,'history'),coldStart:{models:[id],referenceModel:id}},semanticRouter:{enabled:false},maxIterations:3,budgetUsd:1});
 let round=0,turn=0;const repairReads:string[]=[];
 const call=(name:string,args:object)=>({id:`${round}-${turn}`,type:'function' as const,function:{name,arguments:JSON.stringify(args)}});
 const result=await run({repo,task:'Modify src/value.cjs to export value=2. Add regression tests in tests/value.test.cjs. Preserve existing tests.',config:cfg,output:join(root,'report'),quiet:true,apply:true,syntheticTelemetry:true,
  codingWorkerFactory:(gateway)=>{
   const worker=new AgenticCodingWorker(gateway.budget,gateway.logger,async()=>{
    turn++;let calls;
    if(round===1)calls=turn===1?[call('read_file',{path:'src/value.cjs'}),call('read_file',{path:'tests/value.test.cjs'})]:turn===2?[call('write_file',{path:'src/value.cjs',content:`exports.value=${failure==='implementation'?3:2};\n`}),call('write_file',{path:'tests/value.test.cjs',content:testSource(failure==='new-expectation'?3:2)})]:[];
    else if(turn<=2){const path=turn===1?'src/value.cjs':'tests/value.test.cjs';repairReads.push(path);calls=[call('read_file',{path})];}
    else calls=turn===3?[call('write_file',{path:failure==='implementation'?'src/value.cjs':'tests/value.test.cjs',content:failure==='implementation'?'exports.value=2;\n':testSource(2)})]:[];
    return {model:id,usage:{prompt_tokens:50,completion_tokens:20,cost:.00001},message:{content:calls.length?null:'Done',tool_calls:calls}};
   });
   const originalRun=worker.run.bind(worker);worker.run=async(input)=>{
    round++;turn=0;
    if(round===2){assert.ok(input.maxSteps>=3);assert.equal(input.context?.completionRepair?.mutationRequiredBeforeDiscovery,false);}
    return originalRun(input);
   };return worker;
  },repositoryExplorerFactory:()=>({explore:({repoPath,task,profile})=>deterministicRepositoryExploration(repoPath,task,profile)})});
 assert.equal(result.status,'VERIFIED_SUCCESS',result.error);
 assert.equal(round,2);
 assert.deepEqual(repairReads,['src/value.cjs','tests/value.test.cjs']);
 assert.equal(await readFile(join(repo,'src/value.cjs'),'utf8'),'exports.value=2;\n');
 assert.equal(await readFile(join(repo,'tests/value.test.cjs'),'utf8'),testSource(2));
});

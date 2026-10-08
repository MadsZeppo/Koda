import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {config} from '../src/config.js';
import {routingSchema,modelSchema} from '../src/router/pool.js';
import {openRouterAutoPlan,autoRequestPlugin,autoTaskTier,AUTO_MODEL} from '../src/router/openRouterAutoPolicy.js';
import {chooseAdaptiveRecovery} from '../src/router/controlPolicy.js';
import {AgenticCodingWorker} from '../src/agent/agenticCodingWorker.js';
import {Budget} from '../src/openrouter/usage.js';
import type {TaskFingerprint} from '../src/router/taskFingerprint.js';
import type {Features} from '../src/router/features.js';
import type {SpecialistModel} from '../src/router/capabilityRegistry.js';
const ids=['vendor/small','vendor/reference'];
const models:SpecialistModel[]=ids.map((id,i)=>({model:modelSchema.parse({id,tier:'cheap',qualityPrior:i?0:1}),metadata:{inputPrice:i?1:.01,outputPrice:i?1:.01,available:true,contextLength:100000,maxOutputTokens:10000,supportedParameters:['tools','tool_choice']},vision:false,evidence:[],configured:true}));
const fingerprint={primary:'debugging',scope:'single',executionStrategy:'direct',toolsRequired:true,visionRequired:false,verificationStrength:'strong',difficulty:{technicalComplexity:'low',changeRisk:'low'}} as TaskFingerprint;
const features={contextBytes:1000,likelyWritePaths:['value.ts']} as Features;
async function plan(extra:Record<string,unknown>={},configExtra:Record<string,unknown>={}) {
 const c=await config(undefined,{modelPool:{provider:'openrouter',models:models.map(m=>m.model)},routing:{authority:'openrouter-auto',openRouterAuto:{models:ids,referenceModel:ids[1]}},maxOutputTokens:1000,stageMaxTokens:10000,maxIterations:3,...configExtra});
 return openRouterAutoPlan({config:c,models,fingerprint,features,budgetUsd:1,subtaskId:'test',...extra});
}
test('Auto is opt-in and only accepts exact bounded concrete pools',()=>{
 assert.equal(routingSchema.parse({}).authority,'legacy');
 for(const models of [['vendor/*',ids[1]],['openrouter/auto',ids[1]],[ids[1],ids[1]]])assert.throws(()=>routingSchema.parse({authority:'openrouter-auto',openRouterAuto:{models,referenceModel:ids[1]}}));
 assert.throws(()=>routingSchema.parse({authority:'openrouter-auto'}));
 assert.deepEqual(autoRequestPlugin({models:ids,costTier:'low'}),{id:'auto-router',allowed_models:ids,cost_tier:'low'});
});
test('Auto plan keeps quality unknown, uses worst allowed price bounds and reserves reference rescue',async()=>{
 const p=await plan();assert.equal(p.initialModel,AUTO_MODEL);assert.equal(p.authority,'openrouter-auto');assert.equal(p.initialCandidate.evidenceLevel,'UNKNOWN');
 assert.equal(p.initialCandidate.reservationCost,.0001);assert.equal(p.coldStartDecision!.qualityPrediction,null);
 assert.deepEqual(p.coldStartDecision!.autoModels,[ids[0]]);assert.equal(p.approvedCandidateSet[1]!.model.id,ids[1]);
 assert.equal(chooseAdaptiveRecovery(p,{failureMode:'test_failure',codingAttempts:1,failurePhase:'VERIFICATION_ATTEMPTED',previousModel:AUTO_MODEL,mutationObserved:true},new Set([AUTO_MODEL]))?.model.id,ids[1]);
 assert.equal(chooseAdaptiveRecovery(p,{failureMode:'operational',codingAttempts:0,failurePhase:'DISCOVERY',previousModel:AUTO_MODEL,mutationObserved:false},new Set([AUTO_MODEL]))?.model.id,ids[1]);
});
test('Auto cannot replace explicit high-risk policy or consume reference budget',async()=>{
 assert.equal((await plan({fingerprint:{...fingerprint,schemaRisk:true}})).initialModel,ids[1]);
 assert.equal((await plan({budgetUsd:.01112})).initialModel,ids[1]);
 assert.equal((await plan({}, {maxIterations:1})).initialModel,ids[1]);
});
test('Auto excludes tool-incompatible candidates and stops if reference is incompatible',async()=>{
 const bad={...models[0]!,metadata:{...models[0]!.metadata,supportedParameters:['tools']}};
 assert.equal((await plan({models:[bad,models[1]]})).initialModel,ids[1]);
 await assert.rejects(plan({models:[models[0],{...models[1]!,metadata:{...models[1]!.metadata,contextLength:1}}]}),/reference/);
});
test('unauthorized Auto response is charged and blocked before tool mutation',async(t)=>{
 const repo=await mkdtemp(join(tmpdir(),'koda-auto-invalid-'));t.after(()=>rm(repo,{recursive:true,force:true}));
 const budget=new Budget(1,20000,60000);const logger={events:[] as any[],log(type:string,payload:any){this.events.push({type,...payload});}} as any;
 const worker=new AgenticCodingWorker(budget,logger,async()=>({model:'vendor/outside',usage:{prompt_tokens:100,completion_tokens:30,cost:.001},message:{tool_calls:[{id:'write',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'value.ts',content:'export const value=1;'})}}]}}));
 const r=await worker.run({repoPath:repo,attemptId:'test',task:'Create value.ts',model:AUTO_MODEL,autoRouter:{models:ids,costTier:'low'},budgetUsd:1,maxTokens:10000,maxSteps:3,timeoutMs:20000,requestTimeoutMs:5000,commandTimeoutMs:5000,maxOutputTokens:1000,baseUrl:'http://127.0.0.1:1/v1',writeScope:['value.ts'],promptPricePerMillion:1,completionPricePerMillion:1,modelMetadata:{supportedParameters:['tools','tool_choice']}});
 assert.equal(r.exitStatus,'infra_failure');assert.match(r.fatalError??r.stderr??'',/unauthorized concrete model/);assert.deepEqual(r.changedPaths,[]);
 await assert.rejects(access(join(repo,'value.ts')));assert.equal(r.costUsd,.001);
});

test('open discovery accepts more than six models and low tasks exclude expensive endpoints',async()=>{
 const broad=Array.from({length:20},(_,i)=>({...models[0]!,model:{...models[0]!.model,id:`vendor/cheap-${i}`}}));
 const p=await plan({models:[...broad,models[1]]},{routing:{authority:'openrouter-auto',openRouterAuto:{referenceModel:ids[1],costTier:'auto'}}});
 assert.equal(p.initialModel,AUTO_MODEL);assert.equal((p.coldStartDecision!.autoModels as string[]).length,20);
 assert.equal(p.coldStartDecision!.costTier,'low');assert.ok(!(p.coldStartDecision!.autoModels as string[]).includes(ids[1]!));
 assert.equal(autoTaskTier({...fingerprint,scope:'multi-file',crossComponent:true}),'medium');
 assert.equal(autoTaskTier({...fingerprint,architectureHeavy:true}),'high');
 assert.equal(autoTaskTier({...fingerprint,schemaRisk:true}),'max');
});

test('free compatible starts keep a dispatchable budget without fabricated prices',async()=>{
 const free={...models[0]!,metadata:{...models[0]!.metadata,inputPrice:0,outputPrice:0}};
 const p=await plan({models:[free,models[1]]});
 assert.equal(p.initialModel,AUTO_MODEL);assert.equal(p.initialCandidate.metadata.inputPrice,0);assert.ok(p.initialCandidate.reservationCost>0);
});

test('strongly verified coupled files may use Auto while genuine consequence risks still start reference',async()=>{
 const fp={...fingerprint,scope:'multi-file',crossComponent:true,verificationStrength:'strong',recoveryDetectability:'high',verifierFalseAcceptRisk:'medium',consequenceRisk:'medium',difficulty:{...fingerprint.difficulty,technicalComplexity:'medium'}} as TaskFingerprint;
 assert.equal((await plan({fingerprint:fp})).initialModel,AUTO_MODEL);
 for(const risk of [{schemaRisk:true},{publicApiRisk:true},{configRisk:true},{concurrencyRisk:true},{architectureHeavy:true},{consequenceRisk:'high'},{verifierFalseAcceptRisk:'high'},{verificationStrength:'weak'}]) {
  assert.equal((await plan({fingerprint:{...fp,...risk}})).initialModel,ids[1],JSON.stringify(risk));
 }
});

test('reference fallback reports the actual blocking gate',async()=>{
 assert.match(String((await plan({fingerprint:{...fingerprint,schemaRisk:true}})).coldStartDecision!.reason),/risk\/verification/);
 assert.match(String((await plan({budgetUsd:.01112})).coldStartDecision!.reason),/Insufficient budget/);
 assert.match(String((await plan({}, {maxIterations:1})).coldStartDecision!.reason),/No recovery attempt/);
});

 test('Auto can allocate a bounded attempt smaller than forecast without spending reference reserves',async()=>{
 const p=await plan({budgetUsd:.0112});
 assert.equal(p.initialModel,AUTO_MODEL);
 assert.ok(p.initialCandidate.reservationCost<.0001);
 assert.ok(Number(p.coldStartDecision!.reservedAttemptUsd)+Number(p.coldStartDecision!.completionReserveUsd)<=.0112+1e-12);
 assert.equal(p.approvedCandidateSet[1]!.reservationCost,.01);
 });

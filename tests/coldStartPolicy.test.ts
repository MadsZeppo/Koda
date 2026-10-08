import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {config} from '../src/config.js';
import {routingSchema,modelSchema} from '../src/router/pool.js';
import {coldStartExecutionPlan,loadColdStartEvidence,validateColdStartEvidence} from '../src/router/coldStartPolicy.js';
import {fitContextualQuality} from '../src/router/contextualQuality.js';
import {canonicalRoutingTask} from '../src/router/canonicalTask.js';
import {lexicalTask} from '../src/router/lexicalTask.js';
import {chooseAdaptiveRecovery} from '../src/router/controlPolicy.js';
import {PoolRouter} from '../src/router/modelRouter.js';
import {Logger} from '../src/telemetry/logger.js';
import type {CanonicalQualityObservation} from '../src/router/knowledge/canonical.js';
import type {SpecialistModel} from '../src/router/capabilityRegistry.js';
import type {TaskFingerprint} from '../src/router/taskFingerprint.js';
import {extractFeatures} from '../src/router/features.js';
const text='Fix the arithmetic interval utility';
const features=extractFeatures({id:'fix',title:text,objective:text,likelyReadPaths:['value.ts'],likelyWritePaths:['value.ts'],dependsOn:[],integrationContract:'',verificationCommands:['node --test'],estimatedDifficulty:'normal',parallelSafe:true},{files:['value.ts']} as never,600);
const fp={primary:'debugging',secondary:[],languages:['typescript'],frameworks:[],scope:'single',effort:'normal',executionStrategy:'direct',toolsRequired:true,visionRequired:false,
 visualRelevant:false,browserRelevant:false,terminalHeavy:false,repoReasoningHeavy:false,architectureHeavy:false,verificationStrength:'strong',targetedExecutableVerification:true,
 confidence:'high',reasons:[],difficulty:{technicalComplexity:'low',visualComplexity:'low',architecturalComplexity:'low',interactionComplexity:'low',repoReasoningComplexity:'low',changeRisk:'low',contextUncertainty:'low'}} as TaskFingerprint;
const task=canonicalRoutingTask({text,semantic:lexicalTask(text),fingerprint:fp,harness:'koda'});
const model=(id:string,price:number):SpecialistModel=>({model:modelSchema.parse({id,tier:'cheap',qualityPrior:.1}),metadata:{inputPrice:price,outputPrice:price,contextLength:100000,maxOutputTokens:10000,supportedParameters:['tools','tool_choice']},vision:false,evidence:[],configured:true});
const models=[model('vendor/small-v1',.1),model('vendor/reference-v1',1)];
async function cfg(overrides:Record<string,unknown>={}) {return config(undefined,{maxOutputTokens:1000,stageMaxTokens:10000,maxIterations:3,budgetUsd:1,
 routing:{authority:'cold-start',coldStart:{referenceModel:models[1]!.model.id,models:models.map(m=>m.model.id)}},...overrides});}
function evidence() {
 const observations:CanonicalQualityObservation[]=models.flatMap(m=>Array.from({length:2000},(_,i)=>({id:`${m.model.id}:${i}`,taskId:`native-${i}`,task:{...task,semantic:undefined,text:`Independent bounded utility requirement ${i}`,textDigest:`distinct-${i}`},model:m.model.id,identity:'SOURCE_EXACT' as const,
  source:'native',origin:'local' as const,split:'local' as const,provenance:'native:test',timestamp:'2026-10-07',success:true,outcome:'VERIFIED_SUCCESS',proof:{independent:true,requirementLevel:true},trainingAllowed:true})));
 return fitContextualQuality(observations,'empirical','frozen-test-fixture');
}
const artifact=evidence();
const plan=async(extra:Record<string,unknown>={})=>coldStartExecutionPlan({config:await cfg(),models,fingerprint:fp,features,text,budgetUsd:1,subtaskId:'fix',artifact,...extra});
test('cold-start needs an explicit bounded unique pool and reference; legacy remains default',()=>{
 assert.equal(routingSchema.parse({}).authority,'legacy');assert.throws(()=>routingSchema.parse({authority:'cold-start'}));
 assert.throws(()=>routingSchema.parse({authority:'cold-start',coldStart:{referenceModel:'a',models:['b']}}));
 assert.throws(()=>routingSchema.parse({authority:'cold-start',coldStart:{referenceModel:'a',models:Array.from({length:7},(_,i)=>`${i}`)}}));
});
test('credible near-reference quality selects cheapest exact model and reserves rescue',async()=>{
 const p=await plan();assert.equal(p.initialModel,models[0]!.model.id);assert.equal(p.authority,'cold-start');assert.deepEqual(p.qualityCascadeModelIds,models.map(m=>m.model.id));
 assert.ok(Number(p.coldStartDecision!.reservedAttemptUsd)+Number(p.coldStartDecision!.completionReserveUsd)<=p.totalBudgetUsd);
});
test('no local/public evidence or unseen version starts explicit reference without fake confidence',async()=>{
 const p=await plan({artifact:undefined});assert.equal(p.initialModel,models[1]!.model.id);
 const candidates=p.coldStartDecision!.candidates as {expectedSuccess:number|null}[];assert.ok(candidates.every(c=>c.expectedSuccess===null));
 const changed=[model('vendor/small-v2',.01),models[1]!];assert.equal((await plan({models:changed})).initialModel,models[1]!.model.id);
});
test('legacy priors/tier rankings cannot change cold-start selection',async()=>{
 const changed=models.map(m=>({...m,model:{...m.model,qualityPrior:m.model.id===models[0]!.model.id?0:1,tier:'frontier' as const}}));
 assert.equal((await plan({models:changed})).initialModel,(await plan()).initialModel);
});
test('hard risk uses reference and provider tool incompatibility excludes cheap model',async()=>{
 assert.equal((await plan({fingerprint:{...fp,schemaRisk:true}})).initialModel,models[1]!.model.id);
 const incompatible=[{...models[0]!,metadata:{...models[0]!.metadata,supportedParameters:['tools']}},models[1]!];
 assert.equal((await plan({models:incompatible})).initialModel,models[1]!.model.id);
});
test('budget and attempt limit preserve rescue rather than consume it on cheap first',async()=>{
 assert.equal((await plan({budgetUsd:.012})).initialModel,models[1]!.model.id);
 assert.equal((await plan({config:await cfg({maxIterations:1})})).initialModel,models[1]!.model.id);
 await assert.rejects(plan({budgetUsd:.009}),/reserve a reference/);
});
test('failed/no mutation/discovery attempt escalates once to the frozen reference; operational is separate',async()=>{
 const p=await plan();for(const failureMode of ['test_failure','no_mutation','discovery_limit','operational'] as const){
  const next=chooseAdaptiveRecovery(p,{failureMode,failurePhase:'IMPLEMENTATION',previousModel:p.initialModel,mutationObserved:failureMode!=='no_mutation',codingAttempts:1},new Set([p.initialModel]));
  assert.equal(next?.model.id,p.referenceModel);
 }
 assert.equal(chooseAdaptiveRecovery(p,{failureMode:'test_failure',failurePhase:'VERIFICATION',previousModel:p.referenceModel,mutationObserved:true,codingAttempts:2},new Set(models.map(m=>m.model.id))),undefined);
});
test('unlicensed evidence, undeclared provenance and version transfer are rejected',()=>{
 const source={provenance:'native:test',license:'native-koda',revision:'local-verified-receipts',url:'koda://native'};
 assert.equal(validateColdStartEvidence({version:1,artifact,sources:[source]}).digest,artifact.digest);
 assert.throws(()=>validateColdStartEvidence({version:1,artifact,sources:[{...source,license:'unknown'}]}));
 assert.throws(()=>validateColdStartEvidence({version:1,artifact,sources:[]}));
});
test('actual PoolRouter cold-start dispatch bypasses legacy quality estimation',async(t)=>{
 const root=await mkdtemp(join(tmpdir(),'cold-policy-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const file=join(root,'evidence.json');await writeFile(file,JSON.stringify({version:1,artifact,sources:[{provenance:'native:test',license:'native-koda',revision:'local',url:'koda://native'}]}));
 const c=await cfg({routing:{authority:'cold-start',stateDirectory:root,coldStart:{referenceModel:models[1]!.model.id,models:models.map(m=>m.model.id),evidenceFile:file}}});
 const router=new PoolRouter(c,new Logger('test',root,true));router.setContextualTaskText(text);
 router.capabilities.forTask=async()=>models;(router as any).legacyProductionRouter.decide=()=>{throw Error('legacy must not run');};
 const selected=await router.selectExecutionPlan(fp,features,'fix',1);assert.equal(selected.initialModel,models[0]!.model.id);assert.equal(selected.authority,'cold-start');
 assert.equal(loadColdStartEvidence(file)?.digest,artifact.digest);
});

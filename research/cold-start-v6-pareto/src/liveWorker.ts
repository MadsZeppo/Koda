import OpenAI from 'openai';
import {writeFile,mkdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {execa} from 'execa';
import {createHash} from 'node:crypto';
import {AgenticCodingWorker,type AgenticCodingRequester} from '../../../src/agent/agenticCodingWorker.js';
import type {CodingWorker,CodingWorkerInput} from '../../../src/agent/codingWorker.js';
import type {Gateway} from '../../../src/openrouter/client.js';
import {snapshotTree,changesBetween} from '../../../src/workspace/files.js';
import {providerTransport} from '../../../src/provider/transport.js';
import {providerPayloadBound} from '../../../src/context/packetPolicy.js';
import {taskCapabilityProfile,initialExecutionState,type TaskCapabilityProfile,type ExecutionState} from '../../../src/router/capabilityRoutingV6.js';
import {canonicalRoutingTask} from '../../../src/router/canonicalTask.js';
import {codingDemand} from '../../../src/router/codingDemand.js';
import {taskFingerprint} from '../../../src/router/taskFingerprint.js';
import {extractFeatures} from '../../../src/router/features.js';
import {profileRepo} from '../../../src/repo/profiler.js';
import {subtaskSchema} from '../../../src/planner/schemas.js';
import {planAction,boundedCapabilityHandoff,type Score,type Session} from './router.js';
import type {PilotLedger,PilotModel} from './liveBudget.js';
import type {FrozenPilotScores} from './liveScores.js';
export async function startTier(task:string,repo:string,scope:string[]):Promise<{tier:PilotModel['tier'];profile:TaskCapabilityProfile;reason:string}>{
 const repoProfile=await profileRepo(repo);const subtask=subtaskSchema.parse({id:'pilot',title:task,objective:task,dependsOn:[],likelyReadPaths:scope,likelyWritePaths:scope,integrationContract:'',verificationCommands:repoProfile.verificationCommands,estimatedDifficulty:'normal',parallelSafe:false});
 const features=extractFeatures(subtask,repoProfile,0,undefined,'direct');const fingerprint=taskFingerprint(subtask,repoProfile,features,'normal');const demand=codingDemand(features,subtask,'normal',fingerprint);
 const profile=taskCapabilityProfile(canonicalRoutingTask({text:task,fingerprint,family:fingerprint.primary,engine:'direct',harness:'koda-live-pilot'}));
 return {tier:profile.highConsequence?'frontier':demand?.tier==='low'?'cheap':'strong',profile,reason:profile.highConsequence?'existing risk gate high consequence':demand?.reason??'uncertain task -> strong'};
}
/** No winner predictor: cheapest compatible deployed model INSIDE the risk-gated tier. */
export function chooseTier(models:readonly PilotModel[],tier:PilotModel['tier'],frontier:string){const pool=models.filter(m=>m.tier===tier&&m.supportedParameters.includes('tools')&&m.supportedParameters.includes('tool_choice'));return pool.sort((a,b)=>(a.inputUsdPerMillion+a.outputUsdPerMillion)-(b.inputUsdPerMillion+b.outputUsdPerMillion)||a.id.localeCompare(b.id))[0]??models.find(m=>m.id===frontier)!;}
export interface ActionLog {model:string;decision:string;evUsd:number|null;action:string;handoffBytes:number;handoffCostUsd:number;worktree:string;inputTokens?:number;outputTokens?:number;costUsd?:number|null;reason:string}
export function pilotWorker(gateway:Gateway,opts:{dynamic:boolean;models:PilotModel[];frontier:string;profile:TaskCapabilityProfile;tier:PilotModel['tier'];ledger:PilotLedger;scope:string[];output:string;scorer:FrozenPilotScores;qualityValueUsd:number}):CodingWorker{
 let session:Session|undefined;let state:ExecutionState=initialExecutionState();const actions:ActionLog[]=[];let initialSnapshot:Awaited<ReturnType<typeof snapshotTree>>|undefined;let failureRevision=0;
 gateway.logger.subscribe(event=>{
  if(['verification_repair','completion_repair_start','completion_review_unsatisfied','attempt_rollback'].includes(event.type)){state.verification='candidate_failure';state.consecutiveFailures++;failureRevision++;}
  if(event.type==='completion_review_failure'){state.verification='infrastructure_failure';}
 });
 const requester:AgenticCodingRequester=async(input,messages,tools,maxOutput)=>{
  if(!session)throw Error('No pinned session');
  const toolMessages=messages.filter(m=>m.role==='tool');const last=messages.filter(m=>m.role==='assistant').at(-1) as any;const names=(last?.tool_calls??[]).map((t:any)=>t.function.name);
  const changes=initialSnapshot?changesBetween(initialSnapshot,await snapshotTree(input.repoPath)):[];const mutation=names.some((n:string)=>['write_file','edit_file','apply_patch'].includes(n))&&changes.length>0;
  state.changed=changes.map(c=>c.path);state.read=[...new Set([...state.read,...(last?.tool_calls??[]).filter((t:any)=>t.function.name==='read_file').flatMap((t:any)=>{try{return [JSON.parse(t.function.arguments).path];}catch{return []}})])];
  state.step=mutation?'mutation':names.includes('read_file')?'read':'discovery';state.progress=mutation;state.noProgress=mutation?0:state.noProgress+1;state.costUsd=opts.ledger.spent;
  const meaningful=mutation||failureRevision>0||names.includes('read_file');
  const tokens=providerPayloadBound({messages,tools});const current=opts.models.find(m=>m.id===session!.model)!;
  const required=state.verification==='candidate_failure'?'frontier':opts.tier;
  const rank={cheap:0,strong:1,frontier:2};
  const allowed=opts.models.filter(m=>rank[m.tier]>=rank[required]||m.id===session!.model);
  const prices=(m:PilotModel)=>(tokens*m.inputUsdPerMillion+maxOutput*m.outputUsdPerMillion)/1e6;
  const predictions=opts.scorer.predict(opts.profile);
  const scores:Score[]=allowed.map(m=>({model:m.id,quality:predictions.get(m.id.split('/').slice(1).join('/'))??NaN,costUsd:prices(m),compatible:m.supportedParameters.includes('tools')&&m.supportedParameters.includes('tool_choice')}));
  const d=opts.dynamic&&meaningful?planAction(session,state,opts.profile,()=>scores,.02,{remainingTurns:2,switchUsd:0,cacheLossUsd:tokens*Math.max(...opts.models.map(m=>m.inputUsdPerMillion))/1e6,handoverUsd:8192/3*Math.max(...opts.models.map(m=>m.inputUsdPerMillion))/1e6,routerUsd:0,recoveryUsd:state.verification==='candidate_failure'?prices(current):0,qualityValueUsd:opts.qualityValueUsd,budgetRemainingUsd:opts.ledger.capUsd-opts.ledger.spent}):{decision:'STAY',model:session.model,session,evUsd:null,action:state.step,reason:opts.dynamic?'no meaningful action':'frontier baseline'};
  let handoffBytes=0;const requestMessages=[...messages];
  if(d.decision==='SWITCH'){
   let diff=JSON.stringify(changes);try{diff=(await execa('git',['diff','--no-ext-diff','HEAD'],{cwd:input.repoPath})).stdout;}catch{}
   for(const change of changes.filter(c=>c.type==='create'))diff+='\nCREATED '+change.path+'\n'+await readFile(join(input.repoPath,change.path),'utf8');
   const evidence={task:input.task,diff,discoveries:state.read,toolResults:toolMessages.slice(-4).map(m=>String(m.content)),failures:[],unresolved:[String(input.context?.diagnostics??'')]};
   await mkdir(opts.output,{recursive:true});const hash=createHash('sha256').update(JSON.stringify(evidence)).digest('hex');await writeFile(join(opts.output,hash+'.json'),JSON.stringify(evidence));const packet=boundedCapabilityHandoff(evidence,8192);handoffBytes=Buffer.byteLength(JSON.stringify(packet));
   // Preserve system + original task + pending tool protocol, attach bounded handoff; do not drop task.
   const lastAssistant=messages.map((m,i)=>m.role==='assistant'?i:-1).filter(i=>i>=0).at(-1)??messages.length;
   requestMessages.splice(0,requestMessages.length,...messages.filter(m=>m.role==='system'),messages.find(m=>m.role==='user')!,{role:'user',content:'MODEL HANDOVER\n'+JSON.stringify(packet)+'\nFull evidence retained in run report; re-read source if omitted details are needed.'},...messages.slice(lastAssistant));
   session=d.session;
  }
  const model=opts.models.find(m=>m.id===session!.model)!;const transport=providerTransport(input.baseUrl);const sdk=new OpenAI({apiKey:transport.apiKey,baseURL:transport.baseUrl,maxRetries:0,timeout:input.requestTimeoutMs});
  const log:ActionLog={model:model.id,decision:d.decision,evUsd:d.evUsd,action:d.action,handoffBytes,handoffCostUsd:handoffBytes/3*model.inputUsdPerMillion/1e6,worktree:session.worktree,reason:d.reason};actions.push(log);await writeFile(join(opts.output,'actions.json'),JSON.stringify(actions,null,2));
  const response=await sdk.chat.completions.create({model:model.id,messages:requestMessages,tools,tool_choice:'required',max_tokens:Math.min(maxOutput,4096),stream:false});const u=response.usage as any;Object.assign(log,{inputTokens:u?.prompt_tokens,outputTokens:u?.completion_tokens,costUsd:u?.cost??null});await writeFile(join(opts.output,'actions.json'),JSON.stringify(actions,null,2));failureRevision=0;
  const message=response.choices[0]?.message;return {model:response.model,usage:response.usage,message:{content:message?.content,tool_calls:message?.tool_calls?.filter((t):t is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall=>t.type==='function')}};
 };
 const worker=new AgenticCodingWorker(gateway.budget,gateway.logger,requester);
 return {engine:'agentic',run:async(input)=>{
  await mkdir(opts.output,{recursive:true});const chosen=opts.dynamic?chooseTier(opts.models,opts.tier,opts.frontier):opts.models.find(m=>m.id===opts.frontier)!;
  if(!session)session={model:chosen.id,switches:0,visited:[chosen.id],worktree:input.repoPath};
  if(session.worktree!==input.repoPath){session={...session,worktree:input.repoPath};initialSnapshot=undefined;}
  initialSnapshot??=await snapshotTree(input.repoPath);
  if(input.context?.diagnostics){state.verification='candidate_failure';state.step='verification';state.consecutiveFailures++;failureRevision++;}
  const minContext=Math.min(...opts.models.map(m=>m.contextTokens));return worker.run({...input,model:session.model,writeScope:opts.scope.filter(p=>input.writeScope.some(s=>s==='.'||p===s||p.startsWith(s+'/'))),modelMetadata:{supportedParameters:['tools','tool_choice']},contextWindowTokens:minContext,promptPricePerMillion:Math.max(...opts.models.map(m=>m.inputUsdPerMillion)),completionPricePerMillion:Math.max(...opts.models.map(m=>m.outputUsdPerMillion))});
 }};
}

import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Config } from '../config.js';
import type { Features } from './features.js';
import type { TaskFingerprint } from './taskFingerprint.js';
import type { SpecialistModel } from './capabilityRegistry.js';
import type { SpecialistEstimate } from './routeOptimizer.js';
import type { FrozenExecutionPlan } from './modelRouter.js';
import { supportsParameters } from './pool.js';
import { canonicalRoutingTask } from './canonicalTask.js';
import { lexicalTask } from './lexicalTask.js';
import { ContextualRouterVNext } from './contextualRouterVNext.js';
import { fitContextualQuality, validateContextualArtifact, type ContextualQualityArtifact } from './contextualQuality.js';
import { canonicalEvidenceDirectory, trainingEligible, type CanonicalQualityObservation } from './knowledge/canonical.js';
import { requiredQualityClass, freezeExecutionPolicy } from './controlPolicy.js';

export interface LicensedColdStartEvidence {
 version: 1;
 artifact: ContextualQualityArtifact;
 sources: Array<{ provenance:string; license:string; revision:string; url:string }>;
}
/** Explicit public data rights. Native verified evidence does not import public priors. */
export function validateColdStartEvidence(value: LicensedColdStartEvidence) {
 if(value.version!==1 || !Array.isArray(value.sources)) throw Error('Invalid cold-start evidence envelope');
 const allowed=new Set(['MIT','Apache-2.0','BSD-2-Clause','BSD-3-Clause','CC-BY-4.0','CC0-1.0','native-koda']);
 for(const source of value.sources) {
  if(!source.provenance || !allowed.has(source.license) || !source.revision || !source.url)
   throw Error('Cold-start evidence needs explicit compatible data rights and pinned provenance');
 }
 const declared=new Set(value.sources.map(s=>s.provenance));
 const a=validateContextualArtifact(value.artifact);
 const refs=[...a.cells.flatMap(c=>c.sources),...(a.semanticExamples??[]).flatMap(e=>e.sources??[]),...(a.paired??[]).flatMap(p=>p.provenance)];
 if(refs.some(ref=>!declared.has(ref))) throw Error('Undeclared cold-start evidence provenance');
 if(a.versionTransfers?.length) throw Error('Cold-start evidence cannot silently transfer model versions');
 return a;
}
const evidenceCache=new Map<string,{mtime:number;size:number;artifact:ContextualQualityArtifact|undefined}>();
export function loadColdStartEvidence(file?:string,directory=canonicalEvidenceDirectory()) {
 const path=file??join(directory,'quality-local.jsonl');
 let stat;
 try{stat=statSync(path);}catch(error){if(!file&&(error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
 const cached=evidenceCache.get(path);
 if(cached?.mtime===stat.mtimeMs&&cached.size===stat.size)return cached.artifact;
 if(stat.size>16_000_000)throw Error('Cold-start evidence must be compacted offline before routing');
 let artifact:ContextualQualityArtifact|undefined;
 if(file)artifact=validateColdStartEvidence(JSON.parse(readFileSync(path,'utf8')));
 else {
  const rows=readFileSync(path,'utf8').split('\n').flatMap(line=>{
   try{const row=JSON.parse(line) as CanonicalQualityObservation;return row.origin==='local'&&trainingEligible(row)?[row]:[];}catch{return [];}
  });
  // Repeated attempts on the same task/model do not manufacture independent support.
  const dedup=[...new Map(rows.map(r=>[JSON.stringify([r.model,r.task.textDigest??r.taskId,r.task.engine,r.task.harness]),r])).values()];
  if(dedup.length) {
   try{artifact=fitContextualQuality(dedup,'empirical');}catch(error){
    if(!String(error).includes('Need disjoint fit and calibration tasks'))throw error;
   }
  }
 }
 evidenceCache.set(path,{mtime:stat.mtimeMs,size:stat.size,artifact});
 return artifact;
}

/** Separate authority: raw capabilities/prices and canonical estimates only.
 * No legacy quality priors, posterior, tier ranking or attainable reference score.
 */
export function coldStartExecutionPlan(input:{config:Config;models:SpecialistModel[];fingerprint:TaskFingerprint;features:Features;
 text?:string;budgetUsd:number;subtaskId:string;artifact?:ContextualQualityArtifact}) {
 const {config,fingerprint:fp,features,budgetUsd}=input;const settings=config.routing.coldStart;
 if(!settings)throw Error('Cold-start policy requires explicit model pool');
 const task=canonicalRoutingTask({text:input.text,semantic:input.text?lexicalTask(input.text):undefined,fingerprint:fp,harness:'koda'});
 const estimator=new ContextualRouterVNext(input.artifact);
 const inputTokens=Math.max(Math.ceil(features.contextBytes/3)+256,fp.contextRequirementTokens??0);
 const outputTokens=config.maxOutputTokens;const attemptTokens=Math.max(inputTokens+outputTokens,config.stageMaxTokens);
 const completionReserve=budgetUsd*settings.completionReserveFraction;
 const required=fp.executionStrategy==='aider'?[]:['tools','tool_choice'];
 const rows=input.models.filter(m=>settings.models.includes(m.model.id)).map(m=>{
  const md=m.metadata;const p=estimator.predict(task,m.model.id);
  const cost=(inputTokens*(md.inputPrice??Infinity)+outputTokens*(md.outputPrice??Infinity))/1e6;
  const reservation=attemptTokens*Math.max(md.inputPrice??Infinity,md.outputPrice??Infinity)/1e6;
  const unsupported=required.length>0&&md.supportedParameters===undefined&&md.routableParameterSets===undefined;
  const compatible=m.model.enabled&&md.available!==false&&(!fp.visionRequired||m.vision)&&!unsupported&&supportsParameters(md,required)&&
   (md.contextLength??0)>=inputTokens+outputTokens&&(md.maxOutputTokens??0)>=outputTokens&&Number.isFinite(cost)&&Number.isFinite(reservation)&&
   (md.inputPrice??Infinity)<=config.maxInputPrice&&(md.outputPrice??Infinity)<=config.maxOutputPrice;
  const credible=!!p&&p.calibratedDomain&&['EXACT','SOURCE_EXACT'].includes(p.identity)&&p.support>0;
  return {m,p,cost,reservation,compatible,credible};
 });
 const reference=rows.find(r=>r.m.model.id===settings.referenceModel&&r.compatible);
 if(!reference)throw Error('Cold-start reference is unavailable, unpriced or incompatible; no legacy substitution');
 if(reference.reservation+completionReserve>budgetUsd)throw Error('Cold-start budget cannot reserve a reference attempt and completion');
 const credible=rows.filter(r=>r.compatible&&r.credible);
 const referenceUpper=Math.max(reference.credible?reference.p!.upper:1,...credible.map(r=>r.p!.upper));
 const hardRisk=requiredQualityClass(fp)==='HIGH';
 const eligible=hardRisk||config.maxIterations<2?[]:credible.filter(r=>r.p!.lower+config.routing.maxQualityRegret>=referenceUpper&&
  r.reservation+(r===reference?0:reference.reservation)+completionReserve<=budgetUsd);
 eligible.sort((a,b)=>a.cost-b.cost||a.m.model.id.localeCompare(b.m.model.id));
 const first=eligible[0]??reference;const chain=first===reference?[reference]:[first,reference];
 const reason=hardRisk?'deterministic high-risk reference policy':eligible.length?'cheapest credible model within conservative reference regret':'ABSTAIN on cheap starts; explicit reference fallback';
 function estimate(r:(typeof rows)[number]):SpecialistEstimate {
  const q=r.credible?r.p!.mean:0;const lower=r.credible?r.p!.lower:0;
  const efficiency={expectedInputTokens:inputTokens,expectedOutputTokens:outputTokens,expectedTotalTokens:inputTokens+outputTokens,
   p50TotalTokens:inputTokens+outputTokens,p75TotalTokens:attemptTokens,p90TotalTokens:attemptTokens,p99TotalTokens:attemptTokens,
   typicalTurns:null,cachedTokenRatio:null,observedCostPerTaskUsd:null,evidenceUsed:[]};
  return {model:r.m.model,metadata:r.m.metadata,quality:q,conservativeQuality:lower,cost:r.cost,latency:0,score:r.cost,
   confidence:r.credible?'medium':'low',evidence:[],expectedCompletionCost:r.cost,expectedCompletionLatencyMs:0,
   expectedAttemptCost:r.cost,reservationCost:r.reservation,expectedAttemptLatencyMs:0,expectedInputTokens:inputTokens,expectedOutputTokens:outputTokens,
   expectedTotalTokens:inputTokens+outputTokens,p50AttemptCost:r.cost,conservativeAttemptCost:r.reservation,p99AttemptCost:r.reservation,
   knowledgeSources:r.p?.provenance??[],evidenceLevel:r.credible?'SUPPORTED':'UNKNOWN',localQualityEvidence:r.p?.evidence?.nativeSupport??0,
   observationCount:r.p?.support??0,evidenceFreshness:0,tokenEfficiency:efficiency,expectedFinalSuccess:q,uncertainty:r.credible?r.p!.upper-r.p!.lower:1,
   qualityGap:referenceUpper-lower,qualityFloorPassed:r===reference||eligible.includes(r),firstAttemptQualityFloor:Math.max(0,referenceUpper-config.routing.maxQualityRegret),callCount:0,
   latencyEwmaMs:0,latencyP50Ms:null,latencyP90Ms:null,latencyP99Ms:null,latencyEvidenceKnown:false,latencySlaPassed:false,deadlineFeasible:true,operationalErrorRate:0,
   hardRejection:r.compatible?undefined:'cold-start capability/price/context incompatibility'};
 }
 const approved=chain.map(estimate);const ref=estimate(reference);
 const decision={reason,taskFamily:task.family,artifactDigest:input.artifact?.digest??null,referenceModel:settings.referenceModel,
  selectedModel:first.m.model.id,completionReserveUsd:completionReserve,reservedAttemptUsd:chain.reduce((s,r)=>s+r.reservation,0),
  candidates:rows.map(r=>({model:r.m.model.id,compatible:r.compatible,expectedSuccess:r.credible?r.p!.mean:null,
   conservativeSuccess:r.credible?r.p!.lower:null,upper:r.credible?r.p!.upper:null,provenance:r.p?.provenance??[],support:r.p?.support??0,
   credible:r.credible,eligible:eligible.includes(r),costUsd:Number.isFinite(r.cost)?r.cost:null}))};
 const plan:FrozenExecutionPlan=freezeExecutionPolicy({
  id:'cold-'+createHash('sha256').update(JSON.stringify([input.subtaskId,decision,input.artifact?.digest])).digest('hex').slice(0,12),
  authority:'cold-start' as const,coldStartDecision:decision,type:chain.length>1?'cascade':'single',executionEngine:fp.executionStrategy,
  initialCandidate:approved[0]!,taskFingerprint:fp,routingMode:'quality_safe',qualityClass:requiredQualityClass(fp),requiredQuality:Math.max(0,approved[0]!.conservativeQuality-config.routing.maxQualityRegret),
  approvedCandidateSet:approved,qualityCascadeModelIds:approved.map(c=>c.model.id),operationalRecoveryModelIds:[],orderedRecoveryModelIds:[],
  activeBoard:approved.map(c=>({candidate:c,lifecycle:c.model.id===settings.referenceModel?'REFERENCE' as const:'ACTIVE' as const,reason})),
  referenceModel:ref.model.id,initialModel:approved[0]!.model.id,evidenceClass:approved[0]!.evidenceLevel,
  conservativeQuality:approved[0]!.conservativeQuality,expectedCostPerVerifiedSolve:approved[0]!.conservativeQuality?first.cost/approved[0]!.conservativeQuality:Infinity,
  expectedLatencyMs:0,expectedTotalCostUsd:chain.reduce((s,r)=>s+r.cost,0),optimizerScore:first.cost,allowedQualityRegret:config.routing.maxQualityRegret,
  discoveredModelCount:rows.length,evaluatedCandidates:rows.map(estimate),whySelected:reason,verificationStrength:fp.verificationStrength,
  totalBudgetUsd:budgetUsd,latencyBudgetMs:config.stageMaxMinutes*60000,maxCodingAttempts:Math.min(config.maxIterations,approved.length),maxScoutCalls:0,
  providerConstraints:{requiredParameters:required,sessionSticky:true},writeScopes:[...features.likelyWritePaths],
  verificationContract:{strength:fp.verificationStrength,targeted:fp.targetedExecutableVerification===true,broaderProject:fp.broaderProjectVerification===true},
  stopConditions:['verified','budget exhausted','plan exhausted'],
 });
 return plan;
}

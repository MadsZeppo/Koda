import type {Config} from '../config.js';
import type {SpecialistModel} from './capabilityRegistry.js';
import type {TaskFingerprint} from './taskFingerprint.js';
import type {Features} from './features.js';
import type {FrozenExecutionPlan} from './modelRouter.js';
import {coldStartExecutionPlan} from './coldStartPolicy.js';
import {freezeExecutionPolicy} from './controlPolicy.js';
export const AUTO_MODEL='openrouter/auto';
export interface AutoRequestSettings {models:string[];costTier:'low'|'medium'|'high'|'xhigh'|'max'}
export function autoRequestPlugin(settings:AutoRequestSettings) {
 return {id:'auto-router',allowed_models:[...settings.models],cost_tier:settings.costTier};
}
export function autoTaskTier(fp:TaskFingerprint):AutoRequestSettings['costTier'] {
 const difficulty=fp.difficulty;
 if(fp.schemaRisk||fp.concurrencyRisk||fp.publicApiRisk||difficulty?.changeRisk==='high')return 'max';
 if(fp.architectureHeavy||difficulty?.technicalComplexity==='high'||difficulty?.architecturalComplexity==='high')return 'high';
 if(fp.scope==='single'&&!fp.crossComponent&&difficulty?.technicalComplexity==='low'&&difficulty?.contextUncertainty!=='high'&&!fp.visualRelevant)return 'low';
 return 'medium';
}
/** Coupled files alone are not a consequence risk. Cheap exploration remains
 * experimental and always retains the concrete reference rescue. */
export function autoRequiresReference(fp:TaskFingerprint):boolean {
 if(fp.schemaRisk||fp.concurrencyRisk||fp.publicApiRisk||fp.configRisk||fp.architectureHeavy||
    fp.difficulty?.architecturalComplexity==='high'||fp.difficulty?.changeRisk==='high'||
    fp.consequenceRisk==='high'||fp.verifierFalseAcceptRisk==='high')return true;
 return fp.verificationStrength!=='strong'||fp.recoveryDetectability==='low';
}
/** Auto is a market-based start recommendation, never an estimated quality probability. */
export function openRouterAutoPlan(input:{config:Config;models:SpecialistModel[];fingerprint:TaskFingerprint;features:Features;budgetUsd:number;subtaskId:string}):FrozenExecutionPlan {
 const settings=input.config.routing.openRouterAuto;
 if(!settings)throw Error('Auto requires a configured concrete pool and reference');
 if(input.config.modelPool?.provider!=='openrouter')throw Error('Auto authority requires the OpenRouter provider');
 const poolIds=settings.models ?? [...new Set(input.models.map(m=>m.model.id))];
 const tier=settings.costTier==='auto'?autoTaskTier(input.fingerprint):settings.costTier;
 const base=coldStartExecutionPlan({...input,fingerprint:{...input.fingerprint,executionStrategy:"direct"},config:{...input.config,routing:{...input.config.routing,authority:'cold-start',coldStart:{...settings,models:poolIds}}}});
 const technicallyCompatible=(base.evaluatedCandidates ?? []).filter(c=>!c.hardRejection);
 const ref=base.initialCandidate;
 const ratio=settings.priceRatio[tier];
 // Price is an execution bound, never model-quality evidence. Small tasks may
 // try cheaper endpoints while the existing reference and checks remain intact.
 const compatible=technicallyCompatible.filter(c=>c.metadata.inputPrice!<=ref.metadata.inputPrice!*ratio && c.metadata.outputPrice!<=ref.metadata.outputPrice!*ratio);
 if(!compatible.length) return freezeExecutionPolicy({...base,authority:'openrouter-auto' as const,coldStartDecision:{...base.coldStartDecision,reason:'No compatible models inside task price bound; reference fallback',autoModels:[],costTier:tier,discoveredModels:input.models.length}});
 const worstPrice=Math.max(...compatible.flatMap(c=>[c.metadata.inputPrice!,c.metadata.outputPrice!]));
 const attemptTokens=ref.tokenEfficiency.p90TotalTokens;
 const forecastReserve=Math.max(0.000001,attemptTokens*worstPrice/1e6);
 const completionReserve=input.budgetUsd*settings.completionReserveFraction;
 // A forecast is not a minimum allocation. Runtime enforces the cheap
 // attempt's dollar cap; reference and completion reserves stay untouched.
 const available=Math.max(0,input.budgetUsd-ref.reservationCost-completionReserve);
 const autoReserve=Math.min(forecastReserve,available);
 const minimumDispatchReserve=(ref.expectedInputTokens*Math.max(...compatible.map(c=>c.metadata.inputPrice!))+
   Math.min(1200,input.config.maxOutputTokens)*Math.max(...compatible.map(c=>c.metadata.outputPrice!)))/1e6;
 if((base.qualityClass==="HIGH"&&autoRequiresReference(input.fingerprint))||input.config.maxIterations<2||autoReserve<=0||autoReserve<minimumDispatchReserve) {
  return freezeExecutionPolicy({...base,authority:'openrouter-auto' as const,coldStartDecision:{...base.coldStartDecision,reason:(base.qualityClass==="HIGH"&&autoRequiresReference(input.fingerprint)) ? 'Task risk/verification gate requires reference' : input.config.maxIterations<2 ? 'No recovery attempt available; start reference' : `Insufficient budget for a bounded cheap request: available ${available}, minimum forecast ${minimumDispatchReserve}; reference ${ref.reservationCost} and completion ${completionReserve} reserved`,autoModels:[]}});
 }
 const metadata={...ref.metadata,inputPrice:Math.max(...compatible.map(c=>c.metadata.inputPrice!)),outputPrice:Math.max(...compatible.map(c=>c.metadata.outputPrice!)),
  contextLength:Math.min(...compatible.map(c=>c.metadata.contextLength!)),maxOutputTokens:Math.min(...compatible.map(c=>c.metadata.maxOutputTokens!)),supportedParameters:['tools','tool_choice']};
 const auto={...ref,model:{...ref.model,id:AUTO_MODEL},metadata,reservationCost:autoReserve,conservativeAttemptCost:autoReserve,p99AttemptCost:autoReserve,
  knowledgeSources:[],evidenceLevel:'UNKNOWN' as const,observationCount:0,localQualityEvidence:0,quality:0,conservativeQuality:0,expectedFinalSuccess:0,uncertainty:1};
 const plan:FrozenExecutionPlan=freezeExecutionPolicy({...base,id:`auto-${base.id}`,authority:'openrouter-auto' as const,type:'cascade',initialCandidate:auto,initialModel:AUTO_MODEL,
  approvedCandidateSet:[auto,ref],qualityCascadeModelIds:[AUTO_MODEL,ref.model.id],maxCodingAttempts:2,
  conservativeQuality:0,evidenceClass:'UNKNOWN',requiredQuality:0,whySelected:'OpenRouter Auto experimental start; no frontier-quality estimate',
  coldStartDecision:{reason:'OpenRouter Auto experimental start; reference rescue reserved',selectedModel:AUTO_MODEL,referenceModel:ref.model.id,completionReserveUsd:completionReserve,
    reservedAttemptUsd:autoReserve+ref.reservationCost,forecastAttemptUsd:forecastReserve,allocatedAttemptUsd:autoReserve,autoModels:compatible.map(c=>c.model.id),costTier:tier,priceRatio:ratio,discoveredModels:input.models.length,compatibleModels:technicallyCompatible.length,qualityPrediction:null},
  activeBoard:[{candidate:auto,lifecycle:'ACTIVE' as const,reason:'External market-based router recommendation'},{candidate:ref,lifecycle:'REFERENCE' as const,reason:'Explicit verification recovery'}]});
 return plan;
}

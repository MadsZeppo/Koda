/** Research-only inference adapter. No production imports/dispatch changes. */
import { startFeatures } from '../../../src/router/startRouterV6.js';
import type { TaskCapabilityProfile, ExecutionState } from '../../../src/router/capabilityRoutingV6.js';
import { planAction } from '../../cold-start-v6-pareto/src/router.js';
type Linear = {coefficients:number[][];intercept:number[]};
type Fit = {model:Linear|null;calibration:Linear|null;prior:number};
export interface PublicFit {version:number;models:Record<string,Fit>;state_features:string[];agent:Record<string,Fit>;source_digest:string;calibratedKodaProbability:false}
function probability(f:Fit,x:number[]) {
 if (!f.model) return f.prior;
 const linear=(m:Linear,v:number[]) => m.intercept[0]!+m.coefficients[0]!.reduce((s,w,i)=>s+w*(v[i]??0),0);
 const z=linear(f.model,x); return 1/(1+Math.exp(-Math.max(-35,Math.min(35,f.calibration?linear(f.calibration,[z]):z))));
}
export class PublicStartRouter {
 constructor(private readonly artifact:PublicFit) {}
 score(profile:TaskCapabilityProfile,candidates:string[]=Object.keys(this.artifact.models)) {
  // Public tasks lack Koda-specific risk/verification annotations. Do not invent them.
  const x=startFeatures(profile);x.fill(0,256,282);
  return candidates.map(model=>({model,expectedSuccess:this.artifact.models[model]?probability(this.artifact.models[model]!,x):null,
   calibratedKodaProbability:false as const,trainingDigest:this.artifact.source_digest,provenance:['licensed-public-cross-harness'],
   uncertainty:{kodaTransfer:'unknown' as const},decision:this.artifact.models[model]?'PUBLIC_ESTIMATE' as const:'ABSTAIN' as const}));
 }
}
export function publicAgentSignals(artifact:PublicFit,prefix:Record<string,number>) {
 const x=artifact.state_features.map(k=>prefix[k]??0);
 return {nextObservedProgress:probability(artifact.agent.next_progress!,x),nextObservedStuck:probability(artifact.agent.next_stuck!,x),
  escalationUsefulness:null,requiredCapability:null,calibratedKodaProbability:false as const};
}
/** Estimates are advisory only. They cannot manufacture counterfactual switch EV.
 * Existing state, evidence scores, pin, cap and handoff policy keep authority. */
export function publicWeaveAdvice(artifact:PublicFit,prefix:Record<string,number>,state:ExecutionState,
 ...rest:Parameters<typeof planAction> extends [infer S,ExecutionState,...infer R] ? [S,...R] : never) {
 const [session,profile,scorer,gap,economics]=rest;
 return {signals:publicAgentSignals(artifact,prefix),decision:planAction(session,state,profile,scorer,gap,economics)};
}

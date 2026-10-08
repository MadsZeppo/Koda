import { createHash } from "node:crypto";
import { V6_MODEL_POOL, capabilityFloor, costAwareSelector, type TaskCapabilityProfile, type ModelCapabilityProfile, type FloorPolicy } from "./capabilityRoutingV6.js";
import type { ContextualQualityArtifact } from "./contextualQuality.js";
export const START_FEATURES = 288;
export interface StartRouterArtifact {
  version: 6; encoder: "fnv1a-ascii-logtf-v1"; models: string[];
  hidden: number[][]; hiddenBias: number[]; output: number[][]; outputBias: number[];
  trainingDigest: string; provenance: string[]; digest: string;
}
/** Fixed outcome-blind compact encoder, shared by offline fit and runtime. */
export function startFeatures(profile: TaskCapabilityProfile): number[] {
  const vector = Array<number>(START_FEATURES).fill(0);
  for (const token of (profile.task.text ?? "").toLowerCase().match(/[a-z0-9_]+/g) ?? []) {
    let h = 2166136261;
    for (const c of token) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    vector[h%256] = vector[h%256]! + 1;
  }
  let norm = 0;
  for (let i=0;i<256;i++) { vector[i] = Math.log1p(vector[i]!); norm += vector[i]!**2; }
  norm = Math.sqrt(norm) || 1;
  for (let i=0;i<256;i++) vector[i] = vector[i]!/norm;
  const domains = ["implementation","frontend","backend","database","debugging","refactor","tests","infra","architecture","visual"];
  domains.forEach((d,i)=>vector[256+i]=Number(profile.domains.includes(d as never)));
  ["security","concurrency","database","schema","architecture","publicApi","config","destructive"].forEach((r,i)=>vector[266+i]=Number(profile.risks[r]===true));
  vector[274]=Number(profile.highConsequence);
  const rank=(s:string)=>s==="high" || s==="hard" ? 1 : s==="medium" ? .5 : s==="unknown" ? -.5 : 0;
  vector[275]=rank(profile.difficulty.implementation); vector[276]=rank(profile.difficulty.reasoning); vector[277]=rank(profile.difficulty.visual);
  vector[278]=rank(profile.uncertainty); vector[279]=profile.verification.strength==="strong"?1:profile.verification.strength==="medium"?.5:0;
  vector[280]=Math.log1p(profile.expectedFiles ?? 0); vector[281]=Number(profile.coupling==="cross-component" || profile.coupling==="high");
  ["python","typescript","javascript","sql","go","rust"].forEach((lang,i)=>vector[282+i]=Number(profile.task.languages.includes(lang)));
  return vector;
}
export function validateStartRouter(a: StartRouterArtifact) {
  const {digest,...body}=a;
  if (a.version!==6 || a.encoder!=="fnv1a-ascii-logtf-v1" || JSON.stringify(a.models)!==JSON.stringify(V6_MODEL_POOL) ||
    !a.provenance.length || !a.trainingDigest || a.hidden.length!==START_FEATURES || !a.hiddenBias.length ||
    a.hidden.some(v=>v.length!==a.hiddenBias.length || !v.every(Number.isFinite)) ||
    a.output.length!==a.hiddenBias.length || a.output.some(v=>v.length!==6 || !v.every(Number.isFinite)) ||
    a.outputBias.length!==6 || ![...a.hiddenBias,...a.outputBias].every(Number.isFinite) ||
    createHash("sha256").update(JSON.stringify(body)).digest("hex")!==digest) throw Error("Invalid frozen V6 StartRouter artifact");
  return a;
}
/** Small TRAIN-fitted multi-label MLP. No provider calls or legacy quality estimates. */
export class StartRouterV6 {
  private readonly artifact: StartRouterArtifact;
  constructor(a: StartRouterArtifact) { this.artifact=validateStartRouter(structuredClone(a)); }
  score(profile: TaskCapabilityProfile) {
    const x=startFeatures(profile),a=this.artifact;
    const h=a.hiddenBias.map((b,j)=>Math.max(0,b+x.reduce((s,v,i)=>s+v*a.hidden[i]![j]!,0)));
    return V6_MODEL_POOL.map((model,j)=>({model,expectedSuccess:1/(1+Math.exp(-Math.max(-35,Math.min(35,a.outputBias[j]!+h.reduce((s,v,i)=>s+v*a.output[i]![j]!,0))))),
      provenance:a.provenance,trainingDigest:a.trainingDigest,calibratedKodaProbability:false as const}));
  }
}
/** Start suitability, Koda safety floor, and total-cost selection remain explicit separate outputs. */
export function routeCapabilityStart(profile: TaskCapabilityProfile, models: readonly ModelCapabilityProfile[],
  evidence: ContextualQualityArtifact, policy: FloorPolicy, router: StartRouterV6) {
  const scores=router.score(profile),floor=capabilityFloor(profile,models,evidence,policy);
  const reference=scores.find(s=>s.model===floor.reference);
  const constrained={...floor,alternatives:floor.alternatives.map(a=>{
    const score=scores.find(s=>s.model===a.model);
    const suitable=!!reference && !!score && score.expectedSuccess>=reference.expectedSuccess-policy.allowedRegret;
    return {...a,eligible:a.eligible&&suitable,reasons:[...a.reasons,...(suitable?[]:["start_router_unsuitable"])]};
  })};
  return {scores,floor:constrained,selection:costAwareSelector(constrained,models)};
}

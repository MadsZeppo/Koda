import { assertEvidence, type RoutingEvidence } from './split.js';
import { Tfidf, similarity, type TaskFeatureExtractor, type TaskSimilarity } from './features.js';
import { hash, preexecution, stableCompare, type Decision, type Options, type PreexecutionTask } from './types.js';
export interface Router { name: string; predict(task: PreexecutionTask):Decision }
export function routers(evidence: RoutingEvidence, options:Options, extractor?:TaskFeatureExtractor, distance?:TaskSimilarity):Router[] {
  assertEvidence(evidence);
  if(!Number.isInteger(options.k) || options.k<1 || !Number.isInteger(options.minimumNeighbors) || options.minimumNeighbors<1 || options.minimumNeighbors>options.k) throw Error('Invalid neighbor configuration');
  const models=[...evidence.models].sort(stableCompare);
  const aggregate=Object.fromEntries(models.map(m=>{const obs=evidence.tasks.flatMap(t=>t.observations.filter(o=>o.modelId===m));return [m,{score:obs.length?obs.reduce((s,o)=>s+o.outcome,0)/obs.length:null,cost:obs.length && obs.every(o=>o.costUsd!==null)?obs.reduce((s,o)=>s+o.costUsd!,0)/obs.length:null,count:obs.length}];}));
  const choose=(scores:Record<string,number|null>,low=false)=>models.filter(m=>scores[m]!==null && scores[m]!==undefined).sort((a,b)=> (low?1:-1)*(scores[a]!-scores[b]!) || stableCompare(a,b))[0] ?? null;
  const scores=Object.fromEntries(models.map(m=>[m,aggregate[m]!.score]));
  const costs=Object.fromEntries(models.map(m=>[m,aggregate[m]!.cost]));
  // Cost baseline requires complete training coverage, never partial extrapolation.
  const cheapest=models.every(m=>aggregate[m]!.count===evidence.tasks.length && costs[m]!==null)?choose(costs,true):null;
  const feature=extractor ?? new Tfidf(evidence.tasks.map(t=>preexecution(t.task)),options.features), sim=distance ?? similarity(options.metric);
  const vectors=evidence.tasks.map(t=>({entry:t,vector:feature.transform(preexecution(t.task)),tie:hash(JSON.stringify(preexecution(t.task)))}));
  const constant=(name:string,model:string|null,estimates:Record<string,number|null>,reason:string):Router=>({name,predict:()=>({model,estimates:{...estimates},neighbors:[],reason})});
  return [...models.map(m=>constant(`Always(${m})`,m,{},'static model; no outcome prediction')),constant('Global best',choose(scores),scores,'training-only mean quality'),constant('Global cheapest',cheapest,costs,cheapest?'training-only complete mean recorded cost':'UNAVAILABLE_INCOMPLETE_TRAINING_COST'),{name:'kNN',predict(task) {
    const query=feature.transform(task);
    const ranked=vectors.map(v=>({...v,weight:sim.compare(query,v.vector)})).filter(n=>n.weight>0).sort((a,b)=>b.weight-a.weight || stableCompare(a.tie,b.tie));
    const boundary=ranked[Math.min(options.k,ranked.length)-1]?.weight;
    const neighbors=boundary===undefined?[]:ranked.filter(n=>n.weight>=boundary);
    const estimates=Object.fromEntries(models.map(m=>{const obs=neighbors.map(n=>({weight:n.weight,value:n.entry.observations.find(o=>o.modelId===m)?.outcome})).filter((o):o is {weight:number;value:number}=>o.value!==undefined);return [m,obs.length>=options.minimumNeighbors?obs.reduce((s,o)=>s+o.weight*o.value,0)/obs.reduce((s,o)=>s+o.weight,0):null];}));
    const model=choose(estimates);return {model,estimates,neighbors:neighbors.map(n=>({taskId:n.entry.task.taskId,similarity:n.weight})),reason:model?'similarity-weighted admissible neighbor quality':'ABSTAIN_INSUFFICIENT_NEIGHBORS'};
  }}];
}
// All similarity ties at the kth boundary are included: no task ID or outcome breaks feature ties.

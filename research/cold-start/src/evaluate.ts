import type { EvaluationGroundTruth } from './split.js';
import { stableCompare, type Prediction } from './types.js';
export interface Metrics {
  evaluatedTasks:number; routedTasks:number; abstentions:number; resolved:number; resolvedRate:number;
  meanRegret:number|null; p50Regret:number|null; p90Regret:number|null;p95Regret:number|null;
  catastrophicMissRate:number|null;top1Accuracy:number|null;selectedModels:Record<string,number>;
  costCoverage:number;costPerTask:number|null;costPerResolved:number|null;relativeCostVsBestStatic:number|null;
  latencyCoverage:number;latencyPerTaskMs:number|null;
}
const mean=(values:number[])=>values.length?values.reduce((s,n)=>s+n,0)/values.length:null;
/** Nearest-rank quantile: index ceil(p*n)-1. */
const quantile=(values:number[],p:number)=>values.length?[...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(p*values.length)-1)]!:null;
/** Evaluation only. Oracle is NOT a Router and is absent from the router dispatch registry. */
export function evaluate(predictions:readonly Prediction[],truth:EvaluationGroundTruth) {
  if(truth.kind!=='evaluation-ground-truth') throw Error('Evaluator requires ground truth');
  const rows=new Map(truth.tasks.map(t=>[t.taskId,truth.outcomes.filter(o=>o.taskId===t.taskId)]));
  const oracle:Prediction[]=truth.tasks.map(t=>{
    const best=[...rows.get(t.taskId)!].sort((a,b)=>b.outcome-a.outcome || stableCompare(a.modelId,b.modelId))[0]!;
    return {router:'Oracle (posthoc)',taskId:t.taskId,model:best.modelId,estimates:{},neighbors:[],reason:'posthoc maximum outcome; lexical model tie-break, NOT cost-optimal'};
  });
  const all=[...predictions,...oracle];const metrics:Record<string,Metrics>={};
  for(const name of [...new Set(all.map(p=>p.router))]) {
    const selected=all.filter(p=>p.router===name);
    if(selected.length!==truth.tasks.length || new Set(selected.map(p=>p.taskId)).size!==truth.tasks.length) throw Error(`Incomplete predictions: ${name}`);
    const regrets:number[]=[],costs:number[]=[],latencies:number[]=[],distribution:Record<string,number>={};let resolved=0,misses=0,top1=0,routed=0;
    for(const p of selected) {
      const candidates=rows.get(p.taskId);if(!candidates) throw Error(`Unknown evaluation task ${p.taskId}`);
      if(p.model===null) continue;
      const o=candidates.find(o=>o.modelId===p.model);if(!o) throw Error(`Missing evaluation observation ${p.taskId}/${p.model}`);
      const best=Math.max(...candidates.map(o=>o.outcome));routed++;resolved+=Number(o.outcome===1);top1+=Number(o.outcome===best);misses+=Number(o.outcome<1 && best===1);regrets.push(best-o.outcome);distribution[p.model]=(distribution[p.model] ?? 0)+1;
      if(o.costUsd!==null) costs.push(o.costUsd);if(o.latencyMs!==null) latencies.push(o.latencyMs);
    }
    const completeCost=routed===selected.length && costs.length===routed;
    metrics[name]={evaluatedTasks:selected.length,routedTasks:routed,abstentions:selected.length-routed,resolved,resolvedRate:resolved/selected.length,meanRegret:mean(regrets),p50Regret:quantile(regrets,.5),p90Regret:quantile(regrets,.9),p95Regret:quantile(regrets,.95),catastrophicMissRate:routed?misses/routed:null,top1Accuracy:routed?top1/routed:null,selectedModels:distribution,costCoverage:costs.length/selected.length,costPerTask:completeCost?mean(costs):null,costPerResolved:completeCost && resolved?costs.reduce((s,n)=>s+n,0)/resolved:null,relativeCostVsBestStatic:null,latencyCoverage:latencies.length/selected.length,latencyPerTaskMs:routed===selected.length && latencies.length===routed?mean(latencies):null};
  }
  const bestStatic=truth.models.map(m=>`Always(${m})`).sort((a,b)=>metrics[b]!.resolvedRate-metrics[a]!.resolvedRate || stableCompare(a,b))[0]!;
  const staticCost=metrics[bestStatic]!.costPerTask;
  for(const m of Object.values(metrics)) if(m.costPerTask!==null && staticCost!==null && staticCost>0) m.relativeCostVsBestStatic=m.costPerTask/staticCost;
  return {metrics,comparisons:{bestStaticPosthoc:bestStatic,knnSolveDeltaVsBestStatic:metrics.kNN!.resolvedRate-metrics[bestStatic]!.resolvedRate,knnGapVsOracle:metrics['Oracle (posthoc)']!.resolvedRate-metrics.kNN!.resolvedRate},oracle};
}
export function markdown(result:ReturnType<typeof evaluate>, warning:string) {
  const fmt=(n:number|null)=>n===null?'N/A':n.toFixed(4);
  return `# Offline CodeRouterBench task-routing experiment\n\n${warning}\n\nComplete solve = score exactly 1; regret uses continuous score. Abstentions count as unresolved, regret/miss/top1 are conditional on routed tasks. Missing selected cost/latency makes the whole aggregate N/A.\n\n| Router | Tasks | Routed | Solve | Mean regret | p95 regret | Catastrophic miss | Cost/solve | Cost/task | Latency ms/task |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n${Object.entries(result.metrics).map(([r,m])=>`| ${r} | ${m.evaluatedTasks} | ${m.routedTasks} | ${fmt(m.resolvedRate)} | ${fmt(m.meanRegret)} | ${fmt(m.p95Regret)} | ${fmt(m.catastrophicMissRate)} | ${fmt(m.costPerResolved)} | ${fmt(m.costPerTask)} | ${fmt(m.latencyPerTaskMs)} |`).join('\n')}\n\nBest static **posthoc**: ${result.comparisons.bestStaticPosthoc}. It is an evaluation reference, not the training-only Global best decision.\n\nkNN solve delta vs posthoc best static: ${fmt(result.comparisons.knnSolveDeltaVsBestStatic)}. Gap to oracle: ${fmt(result.comparisons.knnGapVsOracle)}. Oracle breaks quality ties by model ID, not cost.\n\nThis is unseen-task routing only. UNSEEN_MODEL_SELECTION_NOT_SUPPORTED_IN_PHASE_1. Historical reported costs are not current provider bills or new inference spending. No statistical significance or public→Koda transfer claim is implied.\n`;
}

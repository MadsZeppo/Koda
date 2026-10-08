import { readFile } from 'node:fs/promises';
import { hash, stableCompare, type Dataset, type Task, type Outcome, type Options, type Prediction } from './types.js';
export interface EvidenceObservation { modelId: string; outcome: number; costUsd: number | null }
export interface EvidenceTask { task: Readonly<Task>; observations: readonly Readonly<EvidenceObservation>[] }
export interface RoutingEvidence { readonly kind: 'routing-evidence'; readonly models: readonly string[]; readonly tasks: readonly EvidenceTask[] }
export interface EvaluationGroundTruth { readonly kind: 'evaluation-ground-truth'; readonly tasks: readonly Task[]; readonly outcomes: readonly Outcome[]; readonly models: readonly string[] }
const admissible=new WeakSet<object>();
export function assertEvidence(e: RoutingEvidence) {if(!admissible.has(e) || e.kind!=='routing-evidence') throw Error('Router requires admissible RoutingEvidence, not oracle/ground truth');}
function deepFreeze<T>(v:T): T {if(v && typeof v==='object') {Object.values(v).forEach(deepFreeze);Object.freeze(v);}return v;}
/** Owns hidden labels. It cannot release them until the full prediction artifact is persisted. */
export function partition(data: Dataset, options: Options) {
  if(!['task-holdout','model-holdout','ood'].includes(options.mode)) throw Error('Invalid mode');
  if(options.limit!==undefined && (!Number.isInteger(options.limit) || options.limit<1)) throw Error('Invalid limit');
  if(options.taskHoldout!==undefined && !(options.taskHoldout>0 && options.taskHoldout<1)) throw Error('task-holdout must be between 0 and 1');
  if(options.mode==='ood' && options.taskHoldout!==undefined) throw Error('OOD always trains on probing; task-holdout is not applicable');
  const models=options.models ?? data.models;
  if(!models.length || new Set(models).size!==models.length || models.some(m=>!data.models.includes(m))) throw Error('Unknown/duplicate/empty candidate models');
  if(options.mode==='model-holdout' && (!options.holdoutModel || !models.includes(options.holdoutModel))) throw Error('model-holdout requires a candidate --holdout-model');
  if(options.mode!=='model-holdout' && options.holdoutModel) throw Error('holdout-model requires model-holdout mode');
  const order=(a: Task,b:Task)=>stableCompare(hash(`${options.seed}:${a.taskId}`),hash(`${options.seed}:${b.taskId}`));
  const probing=data.tasks.filter(t=>t.taskSplit==='probing').sort(order);
  const n=options.taskHoldout===undefined?0:Math.ceil(probing.length*options.taskHoldout);
  const trainTasks=probing.slice(n), pool=options.mode==='ood'?data.tasks.filter(t=>t.taskSplit==='ood'):n?probing.slice(0,n):data.tasks.filter(t=>t.taskSplit==='id_test');
  const trainIds=new Set(trainTasks.map(t=>t.taskId));
  const trainRows=new Map<string,Outcome[]>();
  for(const o of data.outcomes) if(trainIds.has(o.taskId) && models.includes(o.modelId) && o.modelId!==options.holdoutModel) {const rows=trainRows.get(o.taskId) ?? [];rows.push(o);trainRows.set(o.taskId,rows);}
  const evidence: RoutingEvidence=deepFreeze({kind:'routing-evidence',models:[...models],tasks:trainTasks.map(task=>({task:structuredClone(task),observations:(trainRows.get(task.taskId) ?? []).map(o=>({modelId:o.modelId,outcome:o.outcome,costUsd:o.costUsd}))}))});
  admissible.add(evidence);
  const byTask=new Map<string,Outcome[]>();for(const o of data.outcomes) if(models.includes(o.modelId)) {const rows=byTask.get(o.taskId) ?? [];rows.push(o);byTask.set(o.taskId,rows);}
  const excluded=pool.filter(t=>byTask.get(t.taskId)?.length!==models.length).map(t=>({taskId:t.taskId,reason:'incomplete candidate outcome matrix'}));
  const eligible=pool.filter(t=>byTask.get(t.taskId)?.length===models.length).sort(order);
  const tasks=eligible.slice(0,options.limit ?? eligible.length).map(t=>structuredClone(t));
  if(!tasks.length || !evidence.tasks.length) throw Error('Empty evaluation or training partition');
  if(tasks.some(t=>trainIds.has(t.taskId))) throw Error('Task leakage');
  const evaluationIds=new Set(tasks.map(t=>t.taskId));
  const groundTruth: EvaluationGroundTruth=deepFreeze({kind:'evaluation-ground-truth',models:[...models],tasks,outcomes:data.outcomes.filter(o=>evaluationIds.has(o.taskId) && models.includes(o.modelId)).map(o=>structuredClone(o))});
  const split={mode:options.mode,trainTaskIds:trainTasks.map(t=>t.taskId),evaluationTaskIds:tasks.map(t=>t.taskId),candidateModels:[...models],heldoutModel:options.holdoutModel ?? null,excluded,eligibleEvaluationTasks:eligible.length,sourcePolicy:n?'seeded probing holdout; published ID test never trained on':'published probing training; ID test / OOD evaluation',trainFingerprint:hash(JSON.stringify(evidence)),evaluationTaskFingerprint:hash(JSON.stringify(tasks)),status:options.mode==='model-holdout'?'UNSEEN_MODEL_SELECTION_NOT_SUPPORTED_IN_PHASE_1':'UNSEEN_TASK_ROUTING_ONLY'};
  return {evidence,tasks:deepFreeze(tasks),split,
    async releaseGroundTruth(predictionFile: string, predictions: readonly Prediction[]): Promise<EvaluationGroundTruth> {
      const expected=serializePredictions(predictions);
      if(await readFile(predictionFile,'utf8')!==expected) throw Error('Predictions must be finalized on disk before scoring');
      const expectedRouters=[...models.map(m=>`Always(${m})`),'Global best','Global cheapest','kNN'];
      const predictionKeys=new Set(predictions.map(p=>JSON.stringify([p.router,p.taskId])));
      if(predictions.length!==tasks.length*expectedRouters.length || predictionKeys.size!==predictions.length || expectedRouters.some(r=>tasks.some(t=>!predictionKeys.has(JSON.stringify([r,t.taskId]))))) throw Error('Incomplete prediction artifact');
      return groundTruth;
    }};
}
export function serializePredictions(predictions: readonly Prediction[]) {return predictions.map(p=>JSON.stringify(p)).join('\n')+'\n';}

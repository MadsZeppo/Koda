import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { acquire, loadDataset } from './data.js';
import { partition, serializePredictions } from './split.js';
import { routers } from './routers.js';
import { evaluate, markdown } from './evaluate.js';
import { hash, preexecution, type Options, type Prediction } from './types.js';
export async function experiment(datasetDirectory:string,outputDirectory:string,options:Options) {
  const data=await loadDataset(datasetDirectory), split=partition(data,options);
  console.log(JSON.stringify(data.summary,null,2));
  const output=resolve(outputDirectory);await mkdir(dirname(output),{recursive:true});await mkdir(output,{recursive:false});
  let gitCommit='unknown';try{gitCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();}catch{}
  const config={experimentVersion:1,gitCommit,createdAt:new Date().toISOString(),options,extractor:'train-only TF-IDF v1',selection:'similarity-weighted neighbor quality; quality ties lexical model ID',neighborBoundary:'include all kth-similarity ties; k is minimum rank boundary',paidCalls:0,datasetDirectory:resolve(datasetDirectory),datasetFingerprint:data.fingerprint};
  const save=(name:string,value:unknown)=>writeFile(`${output}/${name}`,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
  await save('config.json',config);await save('dataset-summary.json',data.summary);await save('dataset-fingerprint.json',data.fingerprint);await save('split.json',split.split);
  const policies=routers(split.evidence,options),predictions:Prediction[]=[];
  const started=performance.now();
  for(const task of split.tasks) for(const router of policies) predictions.push({router:router.name,taskId:task.taskId,...router.predict(preexecution(task))});
  const routingMs=performance.now()-started;
  const bytes=serializePredictions(predictions),predictionFile=`${output}/predictions.jsonl`;
  await writeFile(predictionFile,bytes,{flag:'wx'});
  // Only the evaluator can release labels, after checking complete persisted predictions.
  const truth=await split.releaseGroundTruth(predictionFile,predictions);
  await writeFile(`${output}/ground-truth.jsonl`,truth.outcomes.map(o=>JSON.stringify(o)).join('\n')+'\n',{flag:'wx'});
  const result=evaluate(predictions,truth);await save('metrics.json',{...result,oracle:undefined});
  await save('execution.json',{routingMs,predictionFingerprint:hash(bytes),predictionCount:predictions.length});
  const missingText=split.evidence.tasks.filter(t=>t.task.taskText===null).length;
  const warning=missingText?`WARNING: ${missingText}/${split.evidence.tasks.length} training tasks lack text. Features=${options.features}. Published ID export contains metadata only; this run cannot establish lexical task-similarity signal.`:'Fixture/public tasks contain text. Fixture outcomes test mechanics only, not scientific performance.';
  const report=markdown(result,warning);await writeFile(`${output}/summary.md`,report,{flag:'wx'});console.log(report);console.log(`Artifacts: ${output}; prediction time ${routingMs.toFixed(1)} ms; paid calls 0`);
  return {result,predictions,split:split.split,routingMs};
}
export async function main(args:string[]) {
  const action=args.shift();const allowed=new Set(['dataset','output','revision','mode','seed','limit','task-holdout','holdout-model','models','k','minimum-neighbors','metric','features','list-models']);const flags=new Map<string,string>();
  while(args.length){const key=args.shift()!;if(!key.startsWith('--') || !allowed.has(key.slice(2)) || flags.has(key.slice(2))) throw Error(`Unknown/duplicate argument ${key}`);if(key==='--list-models') flags.set('list-models','true');else {const value=args.shift();if(!value || value.startsWith('--')) throw Error(`Missing value ${key}`);flags.set(key.slice(2),value);}}
  if(action==='data') {const output=flags.get('output') ?? 'research/cold-start/.cache/coderouterbench';await acquire(output,flags.get('revision'));const data=await loadDataset(output);console.log(JSON.stringify({summary:data.summary,fingerprint:data.fingerprint},null,2));return;}
  if(action!=='eval' && action!=='validate') throw Error('Use data, validate or eval');
  const dataset=flags.get('dataset') ?? 'research/cold-start/.cache/coderouterbench';
  if(action==='validate' || flags.has('list-models')) {const data=await loadDataset(dataset);console.log(JSON.stringify({summary:data.summary,fingerprint:data.fingerprint},null,2));return;}
  const num=(key:string,fallback:number)=>{const value=Number(flags.get(key) ?? fallback);if(!Number.isFinite(value)) throw Error(`Invalid ${key}`);return value;};
  const options:Options={mode:(flags.get('mode') ?? 'task-holdout') as Options['mode'],seed:num('seed',42),k:num('k',25),minimumNeighbors:num('minimum-neighbors',3),metric:(flags.get('metric') ?? 'cosine') as Options['metric'],features:(flags.get('features') ?? 'text-dimension') as Options['features']};
  if(!Number.isInteger(options.seed) || !['text','dimension','text-dimension'].includes(options.features)) throw Error('Invalid seed/features');
  if(flags.has('limit')) options.limit=num('limit',100);if(flags.has('task-holdout')) options.taskHoldout=num('task-holdout',.2);if(flags.has('holdout-model')) options.holdoutModel=flags.get('holdout-model');if(flags.has('models')) options.models=flags.get('models')!.split(',');
  const output=flags.get('output');if(!output) throw Error('--output is required (a new directory; no silent overwrite)');
  await experiment(dataset,output,options);
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(e=>{console.error(e);process.exitCode=1;});

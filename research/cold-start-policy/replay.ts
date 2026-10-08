/** Evidence audit and reference-fallback replay, not a replacement router.
 * Routing decisions never receive evaluation outcomes or receipt costs.
 */
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {loadColdStartEvidence} from '../../src/router/coldStartPolicy.js';
import {ContextualRouterVNext} from '../../src/router/contextualRouterVNext.js';
import {canonicalRoutingTask} from '../../src/router/canonicalTask.js';
import {lexicalTask} from '../../src/router/lexicalTask.js';
const root=resolve('research/cold-start-v6-pareto/artifacts');
const output=resolve('research/cold-start-policy/results');
const load=async(name:string)=>JSON.parse(await readFile(`${root}/${name}.json`,'utf8'));
const tasks=await load('evaluation-inputs');
const metadata=await load('evaluation-features');
const taskMetadata=new Map(metadata.rows.map((row:any)=>[row.taskId,row.profile.task]));
const models=['claude-sonnet-4','gemini-2.5-flash','gpt-5','qwen3-235b-a22b-2507','deepseek-v3.1-terminus','glm-4.6'];
// Reference comes from the frozen TRAIN-only artifact, never evaluation scores.
const frozen=await load('results');const reference=frozen.reference;
if(!models.includes(reference))throw Error('TRAIN reference not in the six-model pool');
const artifact=loadColdStartEvidence();const router=new ContextualRouterVNext(artifact);
const start=performance.now();
const decisions=tasks.map((input:any)=>{
 const preExecution=taskMetadata.get(input.taskId) as any;
 if(!preExecution)throw Error('Missing frozen pre-execution task metadata');
 const task=canonicalRoutingTask({...preExecution,text:input.text,semantic:lexicalTask(input.text),engine:'direct',harness:'koda'});
 const candidates=models.map(model=>({model,prediction:router.predict(task,model)}));
 // With no credible candidate the actual cold-start policy must use its explicit
 // reference, independent of prices. Do not invent capability/price metadata to
 // execute a full plan against this old public model catalogue.
 const credible=candidates.filter(c=>c.prediction?.calibratedDomain&&['EXACT','SOURCE_EXACT'].includes(c.prediction.identity)&&c.prediction.support>0);
 if(credible.length)throw Error('Credible evidence found: full frozen capability/price plan is required; fallback-only audit must stop');
 return {taskId:input.taskId,selected:reference,reason:'ABSTAIN on cheap starts; explicit reference fallback',candidates};
});
const routingMs=performance.now()-start;
// Only after decisions freeze may the evaluator read outcome/cost labels.
const paired=await load('paired');const outcomes=paired.outcomes;
if(decisions.length!==100||new Set(decisions.map((d:any)=>d.taskId)).size!==100)throw Error('Expected exact frozen FINAL100');
for(const d of decisions)for(const model of paired.models){const r=outcomes[model]?.[d.taskId];if(!r||!Number.isFinite(r.cost)||![0,1].includes(r.score))throw Error('Incomplete paired outcomes');}
const oracle=(pool:string[])=>decisions.map((d:any)=>{
 const ordered=pool.slice().sort((a,b)=>outcomes[b][d.taskId].score-outcomes[a][d.taskId].score||outcomes[a][d.taskId].cost-outcomes[b][d.taskId].cost||a.localeCompare(b));return ordered[0]!;
});
function metrics(selected:string[]){let solved=0,cost=0,harmful=0;selected.forEach((m,i)=>{const id=decisions[i]!.taskId;const r=outcomes[m][id];solved+=r.score;cost+=r.cost;harmful+=outcomes[reference][id].score===1&&r.score===0?1:0;});return {solved,tasks:selected.length,totalHistoricalCostUsd:cost,costPerHistoricalSolveUsd:solved?cost/solved:null,harmfulDowngrades:harmful,liveVerifiedSuccess:null};}
const policies={'Frontier/reference':metrics(decisions.map(()=>reference)),'Cold-start fallback':metrics(decisions.map(d=>d.selected)),'Oracle six-model pool':metrics(oracle(models)),'Oracle previous twelve-model pool':metrics(oracle(paired.models))};
const report={models,reference,tasks:100,artifactDigest:artifact?.digest??null,cheapSelections:0,routingMs,meanRoutingMs:routingMs/100,paidCalls:0,policies,limitation:'Historical single-patch replay only. No live Koda verification or recovery measured. No credible Koda-domain support for this pool: actual cold-start authority falls back to reference. Public task/model capability metadata was not fabricated.'};
await mkdir(output,{recursive:true});await writeFile(`${output}/decisions.json`,JSON.stringify(decisions,null,2));await writeFile(`${output}/results.json`,JSON.stringify(report,null,2));
const lines=['# Cold-start policy vs frozen SWE oracle','',report.limitation,'','| Policy | Solved / 100 | Historical cost / solve | Harmful downgrades |','|---|---:|---:|---:|',...Object.entries(policies).map(([name,m])=>`| ${name} | ${m.solved} | $${m.costPerHistoricalSolveUsd?.toFixed(5)} | ${m.harmfulDowngrades} |`),'',`Cheap selections: 0. Routing audit: ${routingMs.toFixed(2)} ms for 100 tasks. Paid calls: 0.`];await writeFile(`${output}/REPORT.md`,lines.join('\n')+'\n');console.log(lines.join('\n'));

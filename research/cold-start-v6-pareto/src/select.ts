import { readFileSync, writeFileSync } from 'node:fs';
import { paretoSelect } from './router.js';
const input = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as {tasks:{taskId:string;scores:{model:string;quality:number;costUsd:number;compatible:boolean;hardExcluded?:string}[]}[]};
const results=input.tasks.map(t=>{const start=performance.now(); const selected=Object.fromEntries([.01,.02,.03].map(gap=>[gap.toString(),paretoSelect(t.scores,gap)?.model ?? null]));return {taskId:t.taskId,selected,elapsedMs:performance.now()-start};});
writeFileSync(process.argv[3]!,JSON.stringify(results));

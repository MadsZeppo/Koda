import { readFileSync,writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { StartRouterV6, routeCapabilityStart } from "../../../src/router/startRouterV6.js";
import { modelCapabilityProfiles, capabilityFloorSelector, type TaskCapabilityProfile } from "../../../src/router/capabilityRoutingV6.js";
import type { ContextualQualityArtifact } from "../../../src/router/contextualQuality.js";
const input=JSON.parse(readFileSync(process.argv[2]!,"utf8"));
const router=new StartRouterV6(JSON.parse(readFileSync(process.argv[3]!,"utf8")));
const artifact=input.evidence as ContextualQualityArtifact;
const decisions=input.tasks.map((r:{taskId:string;profile:TaskCapabilityProfile})=>{
 const start=performance.now(),scores=router.score(r.profile);
 const models=modelCapabilityProfiles(r.profile,input.facts,artifact,1000,100);
 for(const m of models) m.costUsd=input.costs[m.model];
 const baseline=capabilityFloorSelector(r.profile,models,artifact,input.policy);
 const startDecision=routeCapabilityStart(r.profile,models,artifact,input.policy,router);
 const selected=startDecision.selection.selected;
 const learned=startDecision.floor;
 const suggested=[...scores].filter(s=>s.expectedSuccess>=Math.max(...scores.map(x=>x.expectedSuccess))-input.policy.allowedRegret)
   .sort((a,b)=>input.costs[a.model]-input.costs[b.model] || a.model.localeCompare(b.model))[0]!.model;
 return {taskId:r.taskId,startScores:scores,rawStart:selected??null,unconstrainedSuggestion:suggested,
  baselineStart:baseline.selected??null,reference:baseline.reference,status:selected?"SELECTED":"ABSTAIN",
  alternatives:learned.alternatives,elapsedMs:performance.now()-start};
});
writeFileSync(process.argv[4]!,JSON.stringify(decisions));

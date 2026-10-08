import { readFileSync,writeFileSync } from "node:fs";
import { canonicalRoutingTask } from "../../../src/router/canonicalTask.js";
import { taskCapabilityProfile, V6_MODEL_POOL } from "../../../src/router/capabilityRoutingV6.js";
import { startFeatures, StartRouterV6 } from "../../../src/router/startRouterV6.js";
const input=JSON.parse(readFileSync(process.argv[2]!,"utf8"));
const router=process.argv[4]?new StartRouterV6(JSON.parse(readFileSync(process.argv[4],"utf8"))):undefined;
const profiles=input.map((row:any)=>{
 const task=canonicalRoutingTask({text:row.text,family:"debugging",engine:"direct",harness:"public-swe"});
 task.languages=row.languages; task.frameworks=row.frameworks;
 task.risks={...row.risks};
 task.fingerprint={primary:"debugging",secondary:row.domains,concurrencyRisk:row.risks.concurrency,
   scope:row.scope, expectedFiles:row.expectedFiles, difficulty:{technicalComplexity:"unknown",visualComplexity:row.visual?"high":"low",repoReasoningComplexity:"unknown"}} as never;
 task.visual=row.visual;task.scope=row.scope;
 const profile=taskCapabilityProfile(task);
 return {taskId:row.taskId,profile,features:startFeatures(profile),scores:router?.score(profile)};
});
writeFileSync(process.argv[3]!,JSON.stringify({models:V6_MODEL_POOL,rows:profiles}));

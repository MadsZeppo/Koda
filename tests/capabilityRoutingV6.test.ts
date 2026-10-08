import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalRoutingTask } from "../src/router/canonicalTask.js";
import { fitContextualQuality, predictContextualQuality } from "../src/router/contextualQuality.js";
import { modelCapabilityProfiles, taskCapabilityProfile, capabilityFloorSelector, executionStateRouter, initialExecutionState,
  boundedCapabilityHandoff, V6_MODEL_POOL, type ModelCapabilityProfile } from "../src/router/capabilityRoutingV6.js";
import { startCapabilityShadowV6 } from "../src/router/capabilityShadowV6.js";
import { Logger } from "../src/telemetry/logger.js";
import type { CanonicalQualityObservation } from "../src/router/knowledge/canonical.js";
const cheap = V6_MODEL_POOL[5], strong = V6_MODEL_POOL[0];
const task = canonicalRoutingTask({ family: "debugging", engine: "direct", harness: "koda", text: "Repair arithmetic interval handling" });
const rows: CanonicalQualityObservation[] = Array.from({length: 200}, (_,i) => ({ id: `obs-${i}`, taskId: `task-${i}`, task,
  model: strong, revision: strong, identity: "EXACT", source: "fixture", split: "development", origin: "external", provenance: "fixture:v1", timestamp: "2026-10-07",
  success: i%10 !== 0, trainingAllowed: true }));
const artifact = fitContextualQuality(rows,"empirical","2026-10-07");
// Explicit admissible paired FIT evidence; no evaluation labels passed into selection.
artifact.paired = Array.from({length: 200},(_,i) => ({taskId:`paired-${i}`,family:task.family,engine:task.engine,harness:task.harness,source:"fixture:v1",provenance:["fixture:v1"],outcomes:{[cheap]:1,[strong]:i%10===0?0:1}}));
const quality = predictContextualQuality(artifact,task,strong);
const models: ModelCapabilityProfile[] = [
  {model:cheap,compatible:true,costUsd:.01,quality:{...quality,mean:.9},dimensions:{implementation:quality,debugging:quality}},
  {model:strong,compatible:true,costUsd:.1,quality:{...quality,mean:.98,lower:.9},dimensions:{implementation:quality,debugging:quality,database:quality,architecture:quality}},
];
const profile = taskCapabilityProfile(task);
const policy = {allowedRegret:.02,maxRegretProbability:.05,budgetUsd:1};
const floor = () => capabilityFloorSelector(profile,models,artifact,policy);
const route = (state=initialExecutionState()) => executionStateRouter(state,cheap,profile,models,artifact,policy);

test("capability profile reuses pre-execution fields and keeps UI demand independent of technical difficulty", () => {
  const ui = taskCapabilityProfile({...task, visual:true, complexity:"low"});
  const db = taskCapabilityProfile({...task, risks:{schema:true,security:true}});
  assert.ok(ui.requiredDimensions.includes("visual")); assert.equal(ui.difficulty.implementation,"low");
  assert.ok(db.requiredDimensions.includes("database")); assert.equal(db.highConsequence,true);
  assert.equal(ui.verification.strength,"unknown"); assert.equal(db.highConsequence,true);
});
test("six-model capability profiles use canonical evidence, current prices, and mark missing visual evidence unknown", () => {
  const facts = [{id:strong,compatible:true,inputPrice:1,outputPrice:2},{id:"unknown/model",compatible:true,inputPrice:0,outputPrice:0}];
  const result = modelCapabilityProfiles(taskCapabilityProfile({...task,visual:true}),facts,artifact,1000,100);
  assert.equal(result.length,1); assert.equal(result[0]!.costUsd,.0012); assert.equal(result[0]!.dimensions.visual,undefined);
  assert.deepEqual(result[0]!.quality,quality); assert.ok(result[0]!.quality.provenance.length);
});
test("localized task starts cheapest safe model; unsupported or visually unproven task abstains", () => {
  assert.equal(floor().selected,cheap);
  assert.equal(capabilityFloorSelector({...profile,requiredDimensions:["visual"]},models,artifact,policy).status,"ABSTAIN");
  assert.equal(capabilityFloorSelector(profile,[],artifact,policy).status,"ABSTAIN");
});
test("database/security/concurrency consequence can start directly at evidence-backed reference", () => {
  const risk = taskCapabilityProfile({...task,risks:{database:true,security:true,concurrency:true}});
  assert.equal(capabilityFloorSelector(risk,models,artifact,policy).selected,strong);
});
test("expected recovery cost can reverse first-request price ordering", () => {
  const adjusted = models.map(m => m.model===cheap ? {...m,costUsd:.04,quality:{...m.quality,mean:0}} : {...m,costUsd:.1});
  const decision=capabilityFloorSelector(profile,adjusted,artifact,policy);
  assert.equal(decision.selected,strong);
  const c=decision.alternatives.find(m=>m.model===cheap)!;
  assert.equal(c.expectedTotalCostUsd,.14); assert.equal(c.recoveryCostUsd,.1);
});
test("hard budget reserves reference recovery rather than comparing first cost alone", () => {
  const d=capabilityFloorSelector(profile,models,artifact,{...policy,budgetUsd:.05});
  assert.equal(d.status,"ABSTAIN"); assert.ok(d.alternatives[0]!.reasons.includes("recovery_reserve_unfunded"));
});
test("progress stays; one concrete verification regression repairs; repeated candidate failure escalates", () => {
  assert.equal(route({...initialExecutionState(),step:"mutation",progress:true,changed:["a.ts"]}).action,"STAY");
  assert.equal(route({...initialExecutionState(),verification:"candidate_failure",consecutiveFailures:1}).action,"REPAIR");
  const d=route({...initialExecutionState(),verification:"candidate_failure",consecutiveFailures:2});
  assert.equal(d.action,"ESCALATE"); assert.equal(d.selected,strong);
});
test("infrastructure failure never starts coding repair or supplies negative model-quality evidence", () => {
  const d=route({...initialExecutionState(),verification:"infrastructure_failure",consecutiveFailures:8});
  assert.equal(d.action,"INFRASTRUCTURE_RECOVERY"); assert.equal(d.selected,cheap);
});
test("new database/dependency complexity raises capability floor without expanding write scope", () => {
  assert.equal(route({...initialExecutionState(),newComplexity:["database"]}).selected,strong);
  assert.equal(route({...initialExecutionState(),newComplexity:["dependency"]}).selected,strong);
  const missing=models.map(m=>({...m,dimensions:{implementation:quality,debugging:quality}}));
  assert.equal(executionStateRouter({...initialExecutionState(),newComplexity:["database"]},cheap,profile,missing,artifact,policy).action,"ABSTAIN");
});
test("bounded structured handoff preserves complete evidence by attachment digest without mutating it", () => {
  const evidence={task:"requirements😀".repeat(10000),diff:"diff".repeat(10000),discoveries:["a.ts"],toolResults:["result".repeat(10000)],failures:["specific test failed"],unresolved:["question"]};
  const original=structuredClone(evidence),packet=boundedCapabilityHandoff(evidence,2048);
  assert.ok(Buffer.byteLength(JSON.stringify(packet))<=2048); assert.equal(packet.requiresEvidenceAttachment,true);
  assert.equal(packet.evidenceDigest.length,64); assert.deepEqual(evidence,original);
  assert.deepEqual(packet,boundedCapabilityHandoff(evidence,2048));
});
test("small handoff retains task, diff, discoveries, tool results, failures, and unresolved questions exactly", () => {
  const e={task:"fix bug",diff:"-old\n+new",discoveries:["a.ts"],toolResults:["read a"],failures:["unit fail"],unresolved:["why?"]};
  const p=boundedCapabilityHandoff(e); assert.equal(p.requiresEvidenceAttachment,false);
  for(const k of Object.keys(e)) assert.deepEqual(p[k as keyof typeof p],e[k as keyof typeof e]);
});
test("routing is deterministic and only outcome-blind task features enter profile", () => {
  assert.deepEqual(floor(),floor());
  const poisoned={...task}; Object.defineProperty(poisoned,"goldPatch",{get(){throw Error("leak");}});
  assert.deepEqual(taskCapabilityProfile(poisoned),profile);
});
test("disabled shadow performs no evidence load, logging, subscription or production mutation", () => {
  const previous=process.env.KODA_CAPABILITY_ROUTING; delete process.env.KODA_CAPABILITY_ROUTING;
  try { startCapabilityShadowV6(new Proxy({} as never,{get(){throw Error("disabled branch accessed input");}})); }
  finally { if(previous===undefined) delete process.env.KODA_CAPABILITY_ROUTING; else process.env.KODA_CAPABILITY_ROUTING=previous; }
});
test("append-only logger observers get detached events and cannot abort or mutate authoritative logging", async () => {
  const path=await mkdtemp(join(tmpdir(),"v6-log-"));
  try { const logger=new Logger(path,"test",true); const stop=logger.subscribe(e=>{(e as any).candidate="wrong";throw Error("shadow failure");});
    logger.log("coding_route_decision",{candidate:strong}); stop();logger.log("final_result",{status:"VERIFIED_SUCCESS"});
    const events=(await readFile(join(path,"events.jsonl"),"utf8")).trim().split("\n").map(l=>JSON.parse(l));
    assert.equal(events[0].candidate,strong); assert.equal(events[1].status,"VERIFIED_SUCCESS"); assert.equal(logger.events.length,2);
  } finally {await rm(path,{recursive:true,force:true});}
});

test("StartRouter exports exactly six deterministic model scores from frozen public TRAIN artifact", async () => {
  const {gunzipSync}=await import("node:zlib"); const {StartRouterV6}=await import("../src/router/startRouterV6.js");
  const a=JSON.parse(gunzipSync(await readFile(new URL("../src/router/knowledge/data/capability-start-v6.json.gz",import.meta.url))).toString());
  const r=new StartRouterV6(a),s=r.score(profile);
  assert.deepEqual(s.map(v=>v.model),[...V6_MODEL_POOL]); assert.deepEqual(s,r.score(profile));
  assert.ok(s.every(v=>v.expectedSuccess>=0&&v.expectedSuccess<=1&&!v.calibratedKodaProbability));
  assert.throws(()=>new StartRouterV6({...a,models:["another/model"]}));
});
test("StepRouter enforces at most two escalations and weak Twin tier alone never changes model", async () => {
  const {stepRouterV6}=await import("../src/router/stepRouterV6.js");
  const input={state:{...initialExecutionState(),verification:"candidate_failure" as const,consecutiveFailures:2},current:cheap,profile,models,evidence:artifact,policy,
    guardrails:{maxEscalations:2,escalations:1,taskBudgetUsd:1,realizedCostUsd:0},tierAdvice:"high" as const};
  assert.equal(stepRouterV6(input).action,"ESCALATE");
  assert.equal(stepRouterV6({...input,guardrails:{...input.guardrails,escalations:2}}).action,"ABSTAIN");
  assert.equal(stepRouterV6({...input,state:{...initialExecutionState(),progress:true}}).action,"STAY");
  assert.throws(()=>stepRouterV6({...input,guardrails:{...input.guardrails,maxEscalations:3}}));
});
test("StepRouter respects realized budget and excludes operational failures even after repeated attempts", async () => {
  const {stepRouterV6}=await import("../src/router/stepRouterV6.js");
  const input={state:{...initialExecutionState(),consecutiveFailures:2},current:cheap,profile,models,evidence:artifact,policy,
    guardrails:{maxEscalations:2,escalations:0,taskBudgetUsd:.15,realizedCostUsd:.14}};
  assert.equal(stepRouterV6(input).action,"ABSTAIN");
  assert.equal(stepRouterV6({...input,state:{...input.state,verification:"infrastructure_failure"}}).action,"INFRASTRUCTURE_RECOVERY");
});
test("unknown outcome/gold fields never enter capability features", async () => {
  const {startFeatures}=await import("../src/router/startRouterV6.js");
  const dirty={...task,outcomes:{[cheap]:true},goldPatch:"cheat",testPatch:"cheat",evaluatorResult:true};
  const p=taskCapabilityProfile(dirty);
  assert.ok(!("outcomes" in p.task)); assert.ok(!("goldPatch" in p.task)); assert.deepEqual(startFeatures(p),startFeatures(profile));
});

test("actual production selection and history are identical with V6 shadow on/off", async () => {
  const {config}=await import("../src/config.js"),{PoolRouter}=await import("../src/router/modelRouter.js");
  const {modelSchema}=await import("../src/router/pool.js"),{extractFeatures}=await import("../src/router/features.js"),{taskFingerprint}=await import("../src/router/taskFingerprint.js");
  const root=await mkdtemp(join(tmpdir(),"v6-isolation-")),previous=process.env.KODA_CAPABILITY_ROUTING;
  try {
    const subtask={id:"task",title:"Repair utility",objective:"Repair utility",likelyWritePaths:["src/util.ts"],likelyReadPaths:[],dependsOn:[],integrationContract:"",verificationCommands:[],estimatedDifficulty:"normal" as const,parallelSafe:true};
    const repo={files:["src/util.ts"],languages:["typescript"],frameworks:[],verificationCommands:[]} as never;
    const features=extractFeatures(subtask,repo,1000),fp=taskFingerprint(subtask,repo,features,"normal");
    const pool=[cheap,strong].map(id=>modelSchema.parse({id,tier:"fast",qualityPrior:.99,latencyPriorMs:20,
      fallback:{inputPrice:.1,outputPrice:.2,contextLength:100000,maxOutputTokens:10000,supportedParameters:["tools","tool_choice"],available:true}}));
    const c=await config(undefined,{modelPool:{provider:"openrouter",models:pool},routing:{stateDirectory:join(root,"history")},budgetUsd:1});
    const decisions=[];
    for(const enabled of [false,true]) {
      if(enabled) process.env.KODA_CAPABILITY_ROUTING="shadow";else delete process.env.KODA_CAPABILITY_ROUTING;
      const logger=new Logger(join(root,String(enabled)),"same",true),router=new PoolRouter(c,logger);
      router.capabilities.forTask=async()=>pool.map(model=>({model,metadata:model.fallback!,vision:false,configured:true,evidence:[]}));
      router.catalog.get=async()=>new Map();
      decisions.push(await router.selectExecutionPlan(fp,features,"task",1));
      assert.equal(logger.events.some(e=>e.type==="routing_capability_v6_shadow"),enabled);
      assert.deepEqual(router.history.read(),[]); assert.deepEqual(router.history.readOperations(),[]);
      if(enabled) {
        logger.log("coding_route_decision",{subtaskId:"task",candidate:cheap});
        logger.log("tool",{subtaskId:"task",name:"read_file",path:"src/util.ts"});
        logger.log("tool_result",{subtaskId:"task",name:"read_file",result:"actual source"});
        logger.log("model_attempt",{subtaskId:"task",modelRequested:cheap,verification:"OPERATIONAL_FAILURE"});
        const last=logger.events.findLast(e=>e.type==="routing_capability_v6_shadow");
        assert.equal(last.decision.action,"INFRASTRUCTURE_RECOVERY"); assert.equal(last.actualDispatchedModel,cheap);
        logger.log("verification",{subtaskId:"task",outcome:"CHECK_FAIL",command:"baseline failing test"});
        const raw=logger.events.findLast(e=>e.type==="routing_capability_v6_shadow");assert.equal(raw.state.verification,"unknown");
        logger.log("apply",{status:"not_verified"});
        const count=logger.events.filter(e=>e.type==="routing_capability_v6_shadow").length;
        logger.log("tool_result",{subtaskId:"task",name:"write_file",result:"done"});
        assert.equal(logger.events.filter(e=>e.type==="routing_capability_v6_shadow").length,count);
      }
    }
    assert.deepEqual(decisions[0],decisions[1]);
  } finally {if(previous===undefined)delete process.env.KODA_CAPABILITY_ROUTING;else process.env.KODA_CAPABILITY_ROUTING=previous;await rm(root,{recursive:true,force:true});}
});

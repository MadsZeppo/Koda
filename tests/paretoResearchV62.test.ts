import {test} from 'node:test';
import assert from 'node:assert/strict';
import {paretoSelect,hardRiskExclusions,planAction,boundedCapabilityHandoff} from '../research/cold-start-v6-pareto/src/router.js';
import {initialExecutionState,taskCapabilityProfile} from '../src/router/capabilityRoutingV6.js';
import {canonicalRoutingTask} from '../src/router/canonicalTask.js';
const scores=[{model:'cheap',quality:.9,costUsd:.01,compatible:true},{model:'best',quality:.92,costUsd:.1,compatible:true}];
const profile=taskCapabilityProfile(canonicalRoutingTask({text:'Fix rendering',family:'debugging',engine:'direct',harness:'public-swe'}));
const session={model:'best',switches:0,visited:['best'],worktree:'/same'};
const economics={remainingTurns:3,switchUsd:0,cacheLossUsd:.01,handoverUsd:.01,routerUsd:.001,recoveryUsd:.01,qualityValueUsd:0,budgetRemainingUsd:1};
test('Pareto near-best uses every compatible model and actual costs without named tiers',()=>{assert.equal(paretoSelect(scores,.03)?.model,'cheap');assert.equal(paretoSelect(scores,.01)?.model,'best');assert.equal(paretoSelect([...scores,{model:'third',quality:.93,costUsd:.005,compatible:true}],.01)?.model,'third');});
test('normal domains impose no hard capability floor; attested serious risk preserves restriction',()=>{assert.equal(paretoSelect(hardRiskExclusions({},new Set(),scores),.03)?.model,'cheap');assert.equal(paretoSelect(hardRiskExclusions({destructiveSchema:true},new Set(['best']),scores),.03)?.model,'best');});
test('unknown compatibility, nonfinite predictions and negative cost are excluded',()=>{assert.equal(paretoSelect([{...scores[0]!,compatible:false},{...scores[1]!,quality:NaN}],.02),undefined);assert.throws(()=>paretoSelect(scores,NaN));});
test('fresh action scores produce positive EV switch on same worktree',()=>{let calls=0;const d=planAction(session,{...initialExecutionState(),step:'mutation'},profile,()=>{calls++;return scores},.03,economics);assert.equal(calls,1);assert.equal(d.decision,'SWITCH');assert.equal(d.session.worktree,session.worktree);assert.equal(d.session.switches,1);assert.equal(session.model,'best');});
test('switch costs, cache loss, handover, router and recovery can make STAY optimal',()=>{assert.equal(planAction(session,initialExecutionState(),profile,()=>scores,.03,{...economics,cacheLossUsd:1}).decision,'STAY');});
test('two switch limit and visited models prevent oscillation',()=>{for(const s of [{...session,switches:2},{...session,visited:['best','cheap']}])assert.equal(planAction(s,initialExecutionState(),profile,()=>scores,.03,economics).decision,'STAY');});
test('infrastructure failures and final verification do not initiate quality switches',()=>{for(const state of [{...initialExecutionState(),verification:'infrastructure_failure' as const},{...initialExecutionState(),step:'completion' as const,verification:'pass' as const}])assert.equal(planAction(session,state,profile,()=>scores,.03,economics).decision,'STAY');});
test('bounded handoff preserves inspectable evidence digest without changing original',()=>{const e={task:'x'.repeat(30000),diff:'y'.repeat(30000),discoveries:['file'],toolResults:['read'],failures:['error'],unresolved:['test']};const before=JSON.stringify(e);const h=boundedCapabilityHandoff(e,2048);assert.ok(Buffer.byteLength(JSON.stringify(h))<=2048);assert.equal(JSON.stringify(e),before);});

test("invalid pinned prediction never produces a NaN EV switch",()=>{assert.equal(planAction(session,initialExecutionState(),profile,()=>[scores[0]!,{...scores[1]!,quality:NaN}],.03,economics).decision,"STAY");});

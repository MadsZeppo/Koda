import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PublicStartRouter,publicAgentSignals,publicWeaveAdvice,type PublicFit} from '../research/public-routing-data/src/adapter.js';
import {initialExecutionState,taskCapabilityProfile} from '../src/router/capabilityRoutingV6.js';
import {canonicalRoutingTask} from '../src/router/canonicalTask.js';
const artifact=JSON.parse(readFileSync(new URL('../research/public-routing-data/fitted.json',import.meta.url),'utf8')) as PublicFit;
const profile=taskCapabilityProfile(canonicalRoutingTask({text:'Fix parser',family:'debugging',engine:'direct',harness:'public-swe'}));
test('public Start score never aliases unsupported frozen model versions',()=>{
 const scores=new PublicStartRouter(artifact).score(profile,['claude-sonnet-4','qwen3-235b-a22b-2507']);
 for(const s of scores){assert.equal(s.decision,'ABSTAIN');assert.equal(s.expectedSuccess,null);assert.equal(s.calibratedKodaProbability,false);}
});
test('supported model gets public prediction without claiming calibrated Koda quality',()=>{
 const s=new PublicStartRouter(artifact).score(profile,['minimax-m2.5'])[0]!;
 assert.equal(s.decision,'PUBLIC_ESTIMATE');assert.ok(s.expectedSuccess!>=0&&s.expectedSuccess!<=1);assert.equal(s.uncertainty.kodaTransfer,'unknown');
});
test('execution signals never manufacture capability or intervention labels',()=>{
 const s=publicAgentSignals(artifact,{step:3,reads:2,current_error:1});assert.equal(s.escalationUsefulness,null);assert.equal(s.requiredCapability,null);assert.ok(Number.isFinite(s.nextObservedStuck));
});
test('public advice preserves existing infrastructure STAY and session',()=>{
 const session={model:'current',visited:['current'],switches:0,worktree:'/same'};
 const advice=publicWeaveAdvice(artifact,{step:3}, {...initialExecutionState(),verification:'infrastructure_failure'},session,profile,
 ()=>[{model:'current',quality:.9,costUsd:.1,compatible:true},{model:'cheap',quality:.91,costUsd:.01,compatible:true}],.02,
 {remainingTurns:3,switchUsd:0,cacheLossUsd:0,handoverUsd:0,routerUsd:0,recoveryUsd:0,qualityValueUsd:0,budgetRemainingUsd:1});
 assert.equal(advice.decision.decision,'STAY');assert.deepEqual(advice.decision.session,session);
});

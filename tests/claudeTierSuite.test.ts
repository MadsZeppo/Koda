import test from 'node:test';
import assert from 'node:assert/strict';
import { tierTasks, selectTierTasks, formatWallTime } from '../src/dev/claudeTierSuite.js';
test('25 tasks have 5/10/10 tiers, valid external checks and genuine multi-module hard scope',()=>{
 const tasks=tierTasks();assert.equal(tasks.length,25);assert.equal(new Set(tasks.map(t=>t.id)).size,25);
 for(const [tier,n] of [['easy',5],['medium',10],['hard',10]] as const)assert.equal(tasks.filter(t=>t.tier===tier).length,n);
 for(const t of tasks){assert.doesNotThrow(()=>new Function(t.acceptance));assert.ok(!Object.values(t.files).includes(t.acceptance));if(t.tier==='hard'){assert.equal(Object.keys(t.files).filter(p=>p.startsWith('src/operations/')).length,3);assert.ok(t.task.includes('src/index.cjs'));assert.ok(t.acceptance.includes('run(batch)'));}}
});

test('hard external acceptance accepts existing references and rejects broken batch implementations',async()=>{
 const {expertCodingScenarios}=await import('../src/dev/expertCodingSuiteFixtures.js');
 for(const t of tierTasks().filter(t=>t.tier==='hard')){
  const selected=expertCodingScenarios.filter(s=>`src/operations/${s.id}.cjs` in t.files);
  const functions=Object.fromEntries(selected.map(s=>[s.id,new Function(`return (${s.implementation});`)()]));
  const run=(requests:any[])=>requests.map(r=>{if(!functions[r.operation])throw new RangeError();return functions[r.operation](...r.args);});
  const check=new Function('require','process',t.acceptance);
  const localRequire=(p:string):any=>p==='node:assert/strict'?assert:p.endsWith('/src/index.cjs')?{run}:functions[selected.find(s=>p.endsWith(`/src/operations/${s.id}.cjs`))!.id];
  assert.doesNotThrow(()=>check(localRequire,{cwd:()=>'/fixture'}),t.id);
  assert.throws(()=>check((p:string)=>p.endsWith('/src/index.cjs')?{run:()=>null}:localRequire(p),{cwd:()=>'/fixture'}));
  const renamed=Object.fromEntries(Object.entries(functions).map(([key,fn])=>[key.replace(/^expert-/,''),fn]));
  const wrongRun=(requests:any[])=>requests.map(r=>{if(!renamed[r.operation])throw new RangeError();return renamed[r.operation](...r.args);});
  assert.throws(()=>check((p:string)=>p.endsWith('/src/index.cjs')?{run:wrongRun}:localRequire(p),{cwd:()=>'/fixture'}));
 }
});

test('ten-task medium-hard selection is balanced and excludes easy tasks',()=>{
 const tasks=selectTierTasks('medium-hard',10);
 assert.equal(tasks.length,10);
 assert.equal(tasks.filter(t=>t.tier==='medium').length,5);
 assert.equal(tasks.filter(t=>t.tier==='hard').length,5);
 assert.equal(new Set(tasks.map(t=>t.id)).size,10);
 assert.throws(()=>selectTierTasks('unknown',10));
});

test('three-task hard profile preserves existing tasks and independent acceptance',()=>{
 const tasks=selectTierTasks('hard',3);
 assert.deepEqual(tasks.map(t=>t.id),['hard-workflow-1','hard-workflow-2','hard-workflow-3']);
 assert.ok(tasks.every(t=>t.tier==='hard'));
 assert.deepEqual(tasks,tierTasks().filter(t=>t.tier==='hard').slice(0,3));
 assert.throws(()=>selectTierTasks('hard',11));
});

test('hard offset selects fresh tasks and rejects invalid ranges before execution',()=>{
 assert.deepEqual(selectTierTasks('hard',3,3).map(t=>t.id),['hard-workflow-4','hard-workflow-5','hard-workflow-6']);
 for(const offset of [-1,1.5,8,NaN])assert.throws(()=>selectTierTasks('hard',3,offset));
});

 test('hard prompts explicitly specify every independently checked public dispatch key',()=>{
 for(const t of tierTasks().filter(t=>t.tier==='hard')){
  const keys=Object.keys(t.files).filter(p=>p.startsWith('src/operations/')).map(p=>p.split('/').at(-1)!.replace('.cjs',''));
  for(const key of keys){assert.ok(t.task.includes(JSON.stringify(key)));assert.ok(t.acceptance.includes(`operation:${JSON.stringify(key)}`));}
  assert.match(t.task,/regression tests exercising run with each exact key/);
 }
 });

test('wall time reports measured milliseconds without inventing missing timings',()=>{
 assert.equal(formatWallTime(12345),'12.345s');
 assert.equal(formatWallTime(0),'0.000s');
 for(const value of [undefined,null,NaN,Infinity,-1])assert.equal(formatWallTime(value),'unknown');
});

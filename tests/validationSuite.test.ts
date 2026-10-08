import test from 'node:test';
import assert from 'node:assert/strict';
import {selectValidationTasks,preflightValidation,assertReproducedBaseline} from '../src/dev/validationSuite.js';
const task=(id:string,repo:string,split='development')=>({id,repo,split,category:'debugging',commit:'a'.repeat(40),task:'Fix the documented bug',writeScope:['src'],oracleDirectory:'/missing-oracle',acceptance:{argv:['node','acceptance.cjs']},verification:[{argv:['node','--version']}]});
test('pilot is prefix of full real task selection and holdout never enters either',()=>{
 const manifest={version:1,tasks:[...Array.from({length:12},(_,i)=>task('task'+i,'/repo'+Math.floor(i/3))),task('held','/repo','holdout')]};
 const full=selectValidationTasks(manifest,12),pilot=selectValidationTasks(manifest,3);
 assert.deepEqual(pilot.tasks,full.tasks.slice(0,3));
 assert.equal(new Set(pilot.tasks.map(t=>t.repo)).size,3);
 assert.equal(full.tasks.some(t=>t.id==='held'),false);
 assert.throws(()=>selectValidationTasks(manifest,5));
});
test('missing real repositories block all selected tasks before dispatch',async()=>{
 const manifest=selectValidationTasks({version:1,tasks:[task('one','/missing-koda-repo-1'),task('two','/missing-koda-repo-2'),task('three','/missing-koda-repo-3')]},3);
 const issues=await preflightValidation(manifest,'/');
 assert.equal(issues.length,3);
 for(const t of manifest.tasks)assert.ok(issues.some(s=>s.startsWith(t.id+':')));
});

test('unrelated process failures cannot substitute for official regression reproduction',()=>{
 const metadata={tests:{FAIL_TO_PASS:['bug'],PASS_TO_PASS:['existing']}};
 const evidence=(failures:string[],missing:string[]=[])=>'SWE_VALIDATION_RESULT='+JSON.stringify({failures,missing});
 assert.throws(()=>assertReproducedBaseline(evidence([]),metadata),/not reproduced/);
 assert.throws(()=>assertReproducedBaseline(evidence(['existing']),metadata),/unrelated/);
 assert.throws(()=>assertReproducedBaseline(evidence(['bug'],['existing']),metadata),/not all collected/);
 assert.doesNotThrow(()=>assertReproducedBaseline(evidence(['bug']),metadata));
});

test('Conda activation cannot consume benchmark arguments and worker receives the original job', async()=>{
 const {validationEnvironmentScript}=await import('../src/dev/validationDocker.js');
 const {execa}=await import('execa');
 const script=validationEnvironmentScript('')
  .replace('source /opt/miniconda3/bin/activate','test "$#" -eq 0')
  .replace('conda activate testbed',':')
  .replace('python /opt/koda-materialize-runtime.py "$koda_repo" /tmp/koda-original-git','printf "%s\\n" "$koda_repo"')
  .replace('node --import /opt/koda/node_modules/tsx/dist/loader.mjs /opt/koda/src/dev/realBenchmarkWorker.ts "$koda_job"','printf "%s\\n" "$koda_job"');
 const result=await execa('/bin/bash',['-c',script,'validation','/job with spaces.json','/repo with spaces']);
 assert.equal(result.stdout,'/repo with spaces\n/job with spaces.json');
});

test('validation container restores relocated Git metadata even when the worker fails',async t=>{
 const {validationEnvironmentScript}=await import('../src/dev/validationDocker.js');
 const {execa}=await import('execa');
 const {mkdtemp,mkdir,writeFile,access,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const root=await mkdtemp(join(tmpdir(),'koda-git-restore-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const repo=join(root,'candidate-repo'),archive=join(root,'git-archive');
 await mkdir(join(repo,'.git'),{recursive:true});await writeFile(join(repo,'.git','config'),'test');
 const script=validationEnvironmentScript('')
  .replaceAll('/tmp/koda-original-git',archive)
  .replace('source /opt/miniconda3/bin/activate','test "$#" -eq 0')
  .replace('conda activate testbed',':')
  .replace('python /opt/koda-materialize-runtime.py "$koda_repo" '+archive,`mkdir -p "${archive}"; mv "$koda_repo/.git" "${archive}/.git"`)
  .replace('node --import /opt/koda/node_modules/tsx/dist/loader.mjs /opt/koda/src/dev/realBenchmarkWorker.ts "$koda_job"','exit 23');
 const result=await execa('/bin/bash',['-c',script,'validation','/job',repo],{reject:false});
 assert.equal(result.exitCode,23);await access(join(repo,'.git','config'));await assert.rejects(access(join(archive,'.git')));
});

test('baseline identity invalidates on source, oracle, commands or environment changes', async()=>{
 const {baselineEvidenceKey}=await import('../src/dev/validationBaseline.js');
 const check={argv:['test'],timeoutMs:100};
 const key=baselineEvidenceKey({source:'a'},{metadata:'image1',tests:'a'},[check],check);
 assert.equal(key,baselineEvidenceKey({source:'a'},{metadata:'image1',tests:'a'},[check],check));
 for(const changed of [baselineEvidenceKey({source:'b'},{metadata:'image1',tests:'a'},[check],check),baselineEvidenceKey({source:'a'},{metadata:'image2',tests:'a'},[check],check),baselineEvidenceKey({source:'a'},{metadata:'image1',tests:'b'},[check],check),baselineEvidenceKey({source:'a'},{metadata:'image1',tests:'a'},[{...check,argv:['other']}],check)])assert.notEqual(changed,key);
});
test('baseline cache reuses identical failures but never caches infrastructure failures', async t=>{
 const {validationBaseline}=await import('../src/dev/validationBaseline.js');
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const cache=await mkdtemp(join(tmpdir(),'koda-baseline-cache-'));t.after(()=>rm(cache,{recursive:true,force:true}));
 let calls=0,key='same',infra=false;
 const check={argv:['test'],timeoutMs:100};
 const services={identity:async()=>key,check:async()=>{calls++;return {pass:false,output:'real reproduced regression',infrastructureError:infra};}};
 await validationBaseline('repo','oracle',[check],check,cache,services);
 await validationBaseline('repo','oracle',[check],check,cache,services);assert.equal(calls,2);
 key='changed';await validationBaseline('repo','oracle',[check],check,cache,services);assert.equal(calls,4);
 key='infra';infra=true;await validationBaseline('repo','oracle',[check],check,cache,services);await validationBaseline('repo','oracle',[check],check,cache,services);assert.equal(calls,8);
});

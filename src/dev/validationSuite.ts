/** Small real-repository execution gate; no new routing or benchmark format. */
import {readFile,writeFile,mkdir,mkdtemp,rm,cp} from 'node:fs/promises';
import {resolve,dirname,join,relative,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {execa} from 'execa';
import {realBenchmarkSchema,runRealBenchmark} from './realBenchmark.js';
import {executePreparedValidation} from './validationDocker.js';
import {validationBaseline} from './validationBaseline.js';
import {runtimeInfrastructureFailure} from '../verifier/verifier.js';

export function selectValidationTasks(manifest: unknown, count: number) {
 if(count!==1&&count!==3&&count!==12)throw Error('--tasks must be 1, 3 or 12');
 const raw=manifest as {version:unknown;tasks:unknown[]};
 if(raw?.version!==1||!Array.isArray(raw.tasks)||!raw.tasks.length)throw Error('Invalid benchmark manifest');
 const parsed={tasks:raw.tasks.flatMap(t=>realBenchmarkSchema.parse({version:1,tasks:[t]}).tasks)};
 if(new Set(parsed.tasks.map(t=>t.id)).size!==parsed.tasks.length)throw Error('Duplicate task IDs / split leakage');
 const tasks=parsed.tasks.filter(t=>t.split==='development');
 // Round robin repositories: the pilot is the identical prefix of the full set.
 const groups=new Map<string,typeof tasks>();
 for(const t of tasks){const group=groups.get(t.repo)??[];group.push(t);groups.set(t.repo,group);}
 const selected:typeof tasks=[];
 while(selected.length<12){let added=false;for(const group of groups.values()){const t=group.shift();if(t){selected.push(t);added=true;if(selected.length===12)break;}}if(!added)break;}
 if(selected.length<count)throw Error(`Only ${selected.length} development tasks available; need ${count}`);
 return {version:1 as const,tasks:selected.slice(0,count)};
}
export function assertReproducedBaseline(stdout: string, metadata: {tests: {FAIL_TO_PASS: string[]; PASS_TO_PASS: string[]}}) {
 const marker=stdout.split('\n').filter(line=>line.startsWith('SWE_VALIDATION_RESULT=')).at(-1);
 if(!marker)throw Error('No official baseline test evidence');
 const evidence=JSON.parse(marker.slice('SWE_VALIDATION_RESULT='.length)) as {missing:string[];failures:string[]};
 if(evidence.missing.length)throw Error('Official baseline tests were not all collected');
 if(evidence.failures.some(id=>metadata.tests.PASS_TO_PASS.includes(id)))throw Error('Official baseline has unrelated regressions');
 if(!evidence.failures.some(id=>metadata.tests.FAIL_TO_PASS.includes(id)))throw Error('Official FAIL_TO_PASS failure was not reproduced');
}
export async function preflightValidation(manifest: ReturnType<typeof selectValidationTasks>, base: string, cache?: string) {
 const issues:string[]=[];
 for(const task of manifest.tasks){
  const root=await mkdtemp(join(tmpdir(),'koda-validation-preflight-'));
  try {
   const source=resolve(base,task.repo),oracleSource=resolve(base,task.oracleDirectory);
   const rel=relative(source,oracleSource);
   if(!rel.startsWith('..')&&!isAbsolute(rel))throw Error('Acceptance oracle must be outside repository');
   const repo=join(root,'repo'),oracle=join(root,'oracle');
   await execa('git',['clone','--no-hardlinks','--no-checkout','--',source,repo]);
   await execa('git',['checkout','--detach',task.commit],{cwd:repo});
   await cp(oracleSource,oracle,{recursive:true});
   if(task.acceptance.argv.includes('oracle.py')) {
    const metadata=JSON.parse(await readFile(join(oracle,'metadata.json'),'utf8'));
    if(!metadata.runtimeImage)throw Error('Prepared execution runtime missing');
    await execa('docker',['image','inspect',metadata.runtimeImage]);
   }
   const baseline=cache ? await validationBaseline(repo,oracle,task.verification,task.acceptance,cache) : undefined;
   if(baseline){
    if(baseline.checks.some(c=>c.infrastructureError)||baseline.oracle.infrastructureError)throw Error('Baseline environment unavailable');
    if(baseline.oracle.pass)throw Error('Acceptance already passes at baseline; no independent mutation proof');
    assertReproducedBaseline(baseline.oracle.output,JSON.parse(await readFile(join(oracle,'metadata.json'),'utf8')));
   }else{
   for(const check of task.verification){
    const result=await execa(check.argv[0]!,check.argv.slice(1),{cwd:repo,reject:false,timeout:check.timeoutMs});
    if(result.exitCode!==0&&runtimeInfrastructureFailure({command:check.argv.join(' '),exitCode:result.exitCode??1,stdout:result.stdout,stderr:result.stderr,wallClockMs:0,timedOut:false}))throw Error(`Baseline environment not ready: ${check.argv.join(' ')}`);
   }
   const check=task.acceptance;
   const result=await execa(check.argv[0]!,[...check.argv.slice(1),repo],{cwd:oracle,reject:false,timeout:check.timeoutMs});
   if(result.exitCode===0)throw Error('Acceptance already passes at baseline; no independent mutation proof');
   if(check.argv.includes('oracle.py'))assertReproducedBaseline(result.stdout,JSON.parse(await readFile(join(oracle,'metadata.json'),'utf8')));
   if(result.stderr.includes('Verification environment unavailable:')||runtimeInfrastructureFailure({command:check.argv.join(' '),exitCode:result.exitCode??1,stdout:result.stdout,stderr:result.stderr,wallClockMs:0,timedOut:false}))throw Error('Acceptance environment unavailable');
   }
  } catch(error){issues.push(`${task.id}: ${String(error)}`);}finally{await rm(root,{recursive:true,force:true});}
 }
 return issues;
}
export async function validationMain(args=process.argv.slice(2)) {
 const {values}=parseArgs({args,options:{manifest:{type:'string'},tasks:{type:'string',default:'3'},output:{type:'string'},config:{type:'string',default:'koda.auto.example.json'},'budget-usd':{type:'string'},execute:{type:'boolean'},resume:{type:'boolean'},'fixed-model':{type:'string'}}});
 if(!values.manifest||!values.output)throw Error('Requires --manifest and --output. No payment without --execute and --budget-usd.');
 const source=resolve(values.manifest),root=resolve(values.output);
 const selected=selectValidationTasks(JSON.parse(await readFile(source,'utf8')),Number(values.tasks));
 for(const t of selected.tasks){t.repo=resolve(dirname(source),t.repo);t.oracleDirectory=resolve(dirname(source),t.oracleDirectory);}
 await mkdir(root,{recursive:true});
 const cache=join(dirname(source),'baseline-cache');
 const issues=await preflightValidation(selected,dirname(source),cache);
 await writeFile(join(root,'preflight.json'),JSON.stringify({tasks:selected.tasks.map(t=>({id:t.id,category:t.category,repo:t.repo})),issues},null,2));
 if(issues.length)throw Error(`Preflight blocked BEFORE provider calls:\n${issues.join('\n')}`);
 const manifest=join(root,'tasks.json'),priors=join(root,'unused-priors.json');
 await writeFile(manifest,JSON.stringify(selected,null,2));await writeFile(priors,JSON.stringify({priors:[]}));
 if(!values.execute){console.log(`Ready: ${selected.tasks.length} real tasks. No paid calls made. Add --execute --budget-usd <cap>.`);return;}
 const budget=Number(values['budget-usd']);if(!Number.isFinite(budget)||budget<=0)throw Error('Explicit positive --budget-usd required');
 return runRealBenchmark({manifest,priors,output:join(root,'runs'),config:values.config!,budgetUsd:budget,split:'development',selectedArms:['current-koda'],resume:values.resume,baseline:(repo,oracle,checks,acceptance)=>validationBaseline(repo,oracle,checks,acceptance,cache),execute:async job=>{return executePreparedValidation(job,join(dirname(job.report),'oracle'),root,values.config!,values['fixed-model']);}});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await validationMain();

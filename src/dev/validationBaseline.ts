/** Validation-only reuse of immutable baseline evidence, never candidate checks. */
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {snapshotTree} from '../workspace/files.js';
import {execa} from 'execa';
import {benchmarkCheck} from './realBenchmark.js';
type Result=Awaited<ReturnType<typeof benchmarkCheck>>;
type Baseline={key:string;checks:Result[];oracle:Result};
type Check={argv:string[];timeoutMs:number};
export function baselineEvidenceKey(source:unknown,oracle:unknown,verification:Check[],acceptance:Check) {
 return createHash('sha256').update(JSON.stringify({version:1,source,oracle,verification,acceptance})).digest('hex');
}
export async function baselineIdentity(repo:string,oracle:string,verification:Check[],acceptance:Check) {
 const metadata=JSON.parse(await readFile(join(oracle,'metadata.json'),'utf8'));
 if(!metadata.runtimeImage?.startsWith('sha256:'))throw Error('Baseline reuse requires immutable runtime image');
 await execa('docker',['image','inspect',metadata.runtimeImage]);
 return baselineEvidenceKey((await snapshotTree(repo)).files,(await snapshotTree(oracle)).files,verification,acceptance);
}
export async function validationBaseline(repo:string,oracle:string,verification:Check[],acceptance:Check,cache:string,services={identity:baselineIdentity,check:benchmarkCheck}):Promise<Baseline> {
 const key=await services.identity(repo,oracle,verification,acceptance),path=join(cache,key+'.json');
 try {const saved=JSON.parse(await readFile(path,'utf8')) as Baseline;if(saved.key===key&&Array.isArray(saved.checks)&&saved.oracle&&!saved.checks.some((c:any)=>c.infrastructureError)&&!saved.oracle.infrastructureError){console.log('Baseline cache HIT '+key.slice(0,12));return saved;}}catch{}
 console.log('Baseline cache MISS '+key.slice(0,12));
 const checks=[];for(const c of verification)checks.push(await services.check(c,repo));
 const result={key,checks,oracle:await services.check(acceptance,oracle,[repo])};
 // A failed baseline is expected; infrastructure failures are never cached.
 if(!checks.some(c=>c.infrastructureError)&&!result.oracle.infrastructureError){
  if(key!==await services.identity(repo,oracle,verification,acceptance))throw Error('Baseline inputs changed during checks');
  await mkdir(cache,{recursive:true});const temporary=path+'.'+process.pid+'.tmp';await writeFile(temporary,JSON.stringify(result));await rename(temporary,path);
 }
 return result;
}

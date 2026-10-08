/** Validation-only execution in the prepared official Python environment. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {execa} from 'execa';
/** Conda's activation script consumes inherited positional arguments unless cleared. */
export function validationEnvironmentScript(environmentSetup: string) {
 return 'set -e\nkoda_job="$1"\nkoda_repo="$2"\nset --\nkoda_restore_git() { if [ -d /tmp/koda-original-git/.git ] && [ ! -e "$koda_repo/.git" ]; then mv /tmp/koda-original-git/.git "$koda_repo/.git"; fi; }\ntrap koda_restore_git EXIT\nsource /opt/miniconda3/bin/activate\nconda activate testbed\npython /opt/koda-materialize-runtime.py "$koda_repo" /tmp/koda-original-git\n'+environmentSetup+'\nnode --import /opt/koda/node_modules/tsx/dist/loader.mjs /opt/koda/src/dev/realBenchmarkWorker.ts "$koda_job"';
}
export async function executePreparedValidation(job:{arm:string;repo:string;report:string;prompt:string;budgetUsd:number;argv:string[];command:string},oracle:string,output:string,config:string,fixedModel?:string) {
 if(job.arm!=='current-koda')throw Error('Prepared validation supports current-koda only');
 const metadata=JSON.parse(await readFile(join(oracle,'metadata.json'),'utf8'));
 if(!metadata.runtimeImage)throw Error('Prepared Node runtime missing; no provider call dispatched');
 const root=resolve(output),source=resolve(new URL('../..',import.meta.url).pathname);
 const originalJob=JSON.parse(await readFile(job.argv.at(-1)!,'utf8'));
 const containerJob=join(dirname(job.report),'container-job.json');
 const containerConfig=join(dirname(job.report),'container-config.json');
 const cfg=JSON.parse(await readFile(resolve(config),'utf8'));
 if(cfg.modelsFile)cfg.modelsFile='/opt/koda/koda.models.json';
 await writeFile(containerConfig,JSON.stringify(cfg));
 await writeFile(containerJob,JSON.stringify({...originalJob,config:containerConfig,fixedModel}));
 const workspaces=join(root,'container-workspaces');await mkdir(workspaces,{recursive:true});
 const mounts=[`${job.repo}:${job.repo}`,`${root}:${root}`,`${workspaces}:/tmp/koda-workspaces`,`${source}/src:/opt/koda/src:ro`,`${source}/workers:/opt/koda/workers:ro`,`${source}/research:/opt/koda/research:ro`,`${source}/koda.models.json:/opt/koda/koda.models.json:ro`,`${oracle}:/oracle:ro`,`${source}/benchmarks/execution-validation/tools/materialize_runtime.py:/opt/koda-materialize-runtime.py:ro`];
 const backend=new URL(process.env.KODA_API_URL??'http://127.0.0.1:8787');
 if(['127.0.0.1','localhost','[::1]'].includes(backend.hostname))backend.hostname='host.docker.internal';
 return execa('docker',['run','--rm','--platform','linux/amd64','--cap-add','SYS_ADMIN','--cap-add','NET_ADMIN','--security-opt','seccomp=unconfined','--security-opt','systempaths=unconfined','--cpus','4','--memory','8g',...mounts.flatMap(m=>['-v',m]),
  '-e','KODA_PROVIDER_MODE=backend','-e',`KODA_API_URL=${backend}`,'-e','LANG=en_US.UTF-8','-e','LC_ALL=en_US.UTF-8',
  '-e',`PYTHONPATH=${job.repo}`,'-w',job.repo,metadata.runtimeImage,
  '/bin/bash','-c',validationEnvironmentScript(metadata.environment_setup??''),'validation',containerJob,job.repo],{reject:false,timeout:1800000});
}

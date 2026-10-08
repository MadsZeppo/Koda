/** No providers: prove the installed Aider interpreter works inside Koda's sandbox. */
import {mkdir} from 'node:fs/promises';
import {command} from '../../../src/repo/commands.js';
import {ensureAiderRuntime,aiderSandboxReadRoots} from '../../../src/agent/aiderRuntime.js';
const shellQuote=(value:string)=>"'"+value.replaceAll("'", "'\\''")+"'";
const cwd='/tmp/koda-aider-runtime-probe';await mkdir(cwd,{recursive:true});
const python=await ensureAiderRuntime();
const env={...process.env,OPENROUTER_API_KEY:undefined,OPENAI_API_KEY:undefined,LITELLM_LOCAL_MODEL_COST_MAP:'True',PYTHONDONTWRITEBYTECODE:'1'};
const result=await command(cwd,`${shellQuote(python)} -I -c ${shellQuote('from aider.main import main; from aider.llm import litellm; assert callable(main); assert callable(litellm.completion); print("AIDER_SANDBOX_RUNTIME_PASS")')}`,60000,false,undefined,[],false,undefined,env,false,'.',env,[],await aiderSandboxReadRoots(python));
console.log(JSON.stringify(result));
if(result.exitCode!==0||!result.stdout.includes('AIDER_SANDBOX_RUNTIME_PASS'))throw Error('Actual sandboxed Aider runtime failed');

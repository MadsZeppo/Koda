/** No providers: exercise the actual workspace and terminal sandbox. */
import {createWorkspaceBackend} from '../../../src/workspace/backend.js';
import {command} from '../../../src/repo/commands.js';
const backend=await createWorkspaceBackend('/probe','/tmp/koda-runtime-probe',{log(){}} as any,false);
await backend.initialize();
const worker=await backend.createWorker('probe');
const module=process.env.KODA_PROBE_MODULE;
if(!module||!/^[_a-zA-Z][_a-zA-Z0-9.]*$/.test(module))throw Error('Invalid probe module');
const result=await command(worker.path,`python3 -c 'import ${module}; print(${module}.__file__)'`,120000,true);
console.log(JSON.stringify({workspaceMode:backend.mode,...result}));
if(result.exitCode!==0)throw Error('Coding runtime probe failed');
if(!result.stdout.includes(worker.path))throw Error('Probe imported original source instead of isolated candidate');

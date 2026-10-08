"""Free actual Koda workspace/sandbox probes for prepared validation runtimes."""
from pathlib import Path
import subprocess,json,sys
root=Path(sys.argv[1]).resolve();source=Path(__file__).resolve().parents[3]
for task in json.loads((root/'tasks.json').read_text())['tasks']:
 oracle=Path(task['oracleDirectory']);m=json.loads((oracle/'metadata.json').read_text());module=task['id'].split('__')[0]
 args=['docker','run','--rm','--network','none','--platform','linux/amd64','--cap-add','SYS_ADMIN','--cap-add','NET_ADMIN','--security-opt','seccomp=unconfined','--security-opt','systempaths=unconfined','-e','LANG=en_US.UTF-8','-e','LC_ALL=en_US.UTF-8','-e','KODA_PROBE_MODULE='+module,'-v',task['repo']+':/source:ro','-v',str(oracle)+':/oracle:ro','-v',str(source/'src')+':/opt/koda/src:ro','-v',str(source/'benchmarks/execution-validation/tools')+':/opt/koda/benchmarks/execution-validation/tools:ro',m['runtimeImage'],'/bin/bash','-c','set -e\nsource /opt/miniconda3/bin/activate\nconda activate testbed\ngit clone --no-hardlinks /source /probe\npython /opt/koda/benchmarks/execution-validation/tools/materialize_runtime.py /probe /tmp/source-git\n'+m.get('environment_setup','')+'\ncd /probe\nnode --import /opt/koda/node_modules/tsx/dist/loader.mjs /opt/koda/benchmarks/execution-validation/tools/runtimeProbe.ts']
 with (root/(task['id']+'-coding-runtime.log')).open('w') as log:subprocess.run(args,stdout=log,stderr=subprocess.STDOUT,check=True)
 print(task['id']+' CODING RUNTIME PASS',flush=True)

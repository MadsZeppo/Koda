"""Prepare existing realBenchmark tasks using official local SWE artifacts/images."""
import argparse,hashlib,json,pathlib,shutil,subprocess,tempfile

def run(*args,**kwargs): return subprocess.run(list(args),check=True,**kwargs)
def field(text,name):
    line=next(l for l in text.splitlines() if l.startswith(name+':'))
    return line.split(':',1)[1].strip().strip("'\"")

def main():
    p=argparse.ArgumentParser();p.add_argument('--manifest',required=True);p.add_argument('--artifacts',required=True);p.add_argument('--swebench',required=True);p.add_argument('--output',required=True);p.add_argument('--tasks',type=int,default=3);p.add_argument('--koda',required=True);a=p.parse_args()
    data=json.loads(pathlib.Path(a.manifest).read_text());tasks=data['tasks'][:a.tasks]
    out=pathlib.Path(a.output).resolve();out.mkdir(parents=True,exist_ok=True)
    parser=pathlib.Path(a.swebench)/'swebench/harness/log_parsers/python.py'
    tools=pathlib.Path(__file__).parent;proof=[]
    run('docker','info',stdout=subprocess.DEVNULL)
    for t in tasks:
        art=pathlib.Path(a.artifacts)/'tasks'/t['id'];meta=(art/'task.yaml').read_text()
        if field(meta,'base_commit')!=t['commit']:raise RuntimeError('Official commit mismatch')
        image=field(meta,'image');run('docker','pull','--platform','linux/amd64',image)
        # Freeze image digest so later evaluation uses the same environment.
        digest=subprocess.check_output(['docker','image','inspect','--format','{{index .RepoDigests 0}}',image],text=True).strip()
        repo=out/'repos'/t['id'];repo.parent.mkdir(exist_ok=True)
        if not repo.exists():
            cid=subprocess.check_output(['docker','create','--platform','linux/amd64',image],text=True).strip()
            try:run('docker','cp',cid+':/testbed',str(repo))
            finally:run('docker','rm',cid,stdout=subprocess.DEVNULL)
        run('git','checkout','--detach',t['commit'],cwd=repo)
        oracle=out/'oracles'/t['id'];oracle.mkdir(parents=True,exist_ok=True)
        for name in ['oracle.py','sync.py','dependency_setup.py']:shutil.copy2(tools/name,oracle/name)
        shutil.copy2(parser,oracle/'official_parser.py');shutil.copy2(art/'test.patch',oracle/'test.patch')
        patch=(art/'test.patch').read_text();paths=[l[6:] for l in patch.splitlines() if l.startswith('+++ b/')]
        if not paths:raise RuntimeError('Empty official test patch')
        evaluation=(art/'eval.sh').read_text();command=evaluation.split(": '>>>>> Start Test Output'",1)[1].split(": '>>>>> End Test Output'",1)[0].strip()
        setup='\n'.join(l+(' --no-build-isolation --no-deps' if 'pip install' in l else '') for l in evaluation.split('git checkout',1)[0].splitlines() if l.startswith('python '))
        metadata={'setup':setup,'image':digest,'commit':t['commit'],'command':command,'parser':field(meta,'log_parser'),'tests':json.loads((art/'tests.json').read_text()),'test_paths':paths}
        # Preserve explicit local environment setup (for example frozen external data caches).
        previous=oracle/'metadata.json'
        if previous.exists():
            previous_metadata=json.loads(previous.read_text())
            if previous_metadata.get('commit')==t['commit'] and previous_metadata.get('image')==digest:
                metadata['environment_setup']=previous_metadata.get('environment_setup','')
                metadata['externalData']=previous_metadata.get('externalData',[])
                metadata['runtimeImage']=previous_metadata.get('runtimeImage')
                provenance=previous_metadata.get('mappingProvenance')
                if provenance:
                    if provenance['testPatchSha256']!=hashlib.sha256((oracle/'test.patch').read_bytes()).hexdigest():raise RuntimeError('Reviewed test mapping patch changed')
                    for name in ['command','setup','tests','mappingProvenance']:metadata[name]=previous_metadata[name]
        # Extend the official environment with Node, preserving Python/dependency versions.
        # Build context contains only dependency manifests, never .env or provider keys.
        if metadata.get('runtimeImage'):
            run('docker','image','inspect',metadata['runtimeImage'],stdout=subprocess.DEVNULL)
        else:
            with tempfile.TemporaryDirectory(prefix='koda-runtime-build-') as build:
                context=pathlib.Path(build)
                for name in ['package.json','pnpm-lock.yaml']:shutil.copy2(pathlib.Path(a.koda)/name,context/name)
                host_arch=subprocess.check_output(['docker','info','--format','{{.Architecture}}'],text=True).strip()
                sandbox_platform='linux/arm64' if host_arch in {'aarch64','arm64'} else 'linux/amd64'
                sandbox_lib='aarch64-linux-gnu' if sandbox_platform.endswith('arm64') else 'x86_64-linux-gnu'
                sandbox_loader='ld-linux-aarch64.so.1' if sandbox_platform.endswith('arm64') else 'ld-linux-x86-64.so.2'
                sandbox_stage='FROM --platform='+sandbox_platform+' ubuntu:22.04 AS sandbox\nRUN apt-get update && apt-get install -y --no-install-recommends bubblewrap\n'
                sandbox_copy='COPY --from=sandbox /usr/bin/bwrap /usr/bin/bwrap\nCOPY --from=sandbox /lib/'+sandbox_lib+'/ /lib/'+sandbox_lib+'/\nCOPY --from=sandbox /lib/'+sandbox_loader+' /lib/'+sandbox_loader+'\n'
                (context/'Dockerfile').write_text(sandbox_stage+'FROM --platform=linux/amd64 node:22-bookworm-slim AS node_runtime\nFROM --platform=linux/amd64 ghcr.io/astral-sh/uv:0.12.0 AS uv_runtime\nFROM --platform=linux/amd64 '+digest+'\n'+sandbox_copy+'COPY --from=node_runtime /usr/local/ /usr/local/\nCOPY --from=uv_runtime /uv /uvx /usr/local/bin/\nWORKDIR /opt/koda\nCOPY package.json pnpm-lock.yaml ./\nENV ELECTRON_SKIP_BINARY_DOWNLOAD=1\nRUN /opt/miniconda3/envs/testbed/bin/python -m pip install extension-helpers setuptools_scm wheel\nRUN npm install -g pnpm@11.7.0 && pnpm install --frozen-lockfile --ignore-scripts\nRUN uv venv --python 3.12 /opt/koda-aider && uv pip install --python /opt/koda-aider/bin/python aider-chat==0.86.2\nRUN uv venv --python 3.13 /opt/koda-openhands && uv pip install --python /opt/koda-openhands/bin/python openhands-sdk==1.50.0\nENV KODA_AIDER_PYTHON=/opt/koda-aider/bin/python KODA_OPENHANDS_PYTHON=/opt/koda-openhands/bin/python\n')
                tag='koda-validation-runtime:'+digest.split('sha256:')[-1][:16]
                run('docker','build','--platform','linux/amd64','-t',tag,str(context))
                metadata['runtimeImage']=subprocess.check_output(['docker','image','inspect','--format','{{.Id}}',tag],text=True).strip()
        run('docker','run','--rm','--network','none','--platform','linux/amd64',metadata['runtimeImage'],'/bin/bash','-c','node --version && /opt/koda-aider/bin/python -c "import aider" && /opt/koda-openhands/bin/python -c "import openhands.sdk"')
        (oracle/'metadata.json').write_text(json.dumps(metadata,indent=2))
        t['repo']=str(repo);t['oracleDirectory']=str(oracle)
        python=shutil.which('python3');t['acceptance']={'argv':[python,'oracle.py'],'timeoutMs':1800000}
        t['verification']=[{'argv':[python,str(oracle/'oracle.py'),'--baseline','.'],'timeoutMs':1800000}]
        # The baseline must collect every official test and reproduce at least one F2P failure.
        with (out/(t['id']+'-baseline.log')).open('w') as log:
            result=subprocess.run([python,str(oracle/'oracle.py'),str(repo)],stdout=log,stderr=subprocess.STDOUT)
        text=(out/(t['id']+'-baseline.log')).read_text()
        lines=[l for l in text.splitlines() if l.startswith('SWE_VALIDATION_RESULT=')]
        if not lines:raise RuntimeError('No official test evidence: '+t['id'])
        evidence=json.loads(lines[-1].split('=',1)[1])
        if result.returncode!=1 or evidence['missing'] or any(f in metadata['tests']['PASS_TO_PASS'] for f in evidence['failures']) or not any(f in metadata['tests']['FAIL_TO_PASS'] for f in evidence['failures']):raise RuntimeError('Baseline is not a valid reproduction: '+t['id'])
        # Positive control uses the official reference patch ONLY in an external disposable clone.
        # It is never copied into the coding candidate, prompt, or oracle directory.
        with tempfile.TemporaryDirectory(prefix='koda-oracle-positive-') as positive:
            control=pathlib.Path(positive)/'repo'
            run('git','clone','--no-hardlinks',str(repo),str(control),stdout=subprocess.DEVNULL)
            run('git','checkout','--detach',t['commit'],cwd=control)
            run('git','apply',str((art/'gold.patch').resolve()),cwd=control)
            with (out/(t['id']+'-positive.log')).open('w') as log:
                positive_result=subprocess.run([python,str(oracle/'oracle.py'),str(control)],stdout=log,stderr=subprocess.STDOUT)
            if positive_result.returncode!=0:raise RuntimeError('Official positive control failed: '+t['id'])
        proof.append({'id':t['id'],'commit':t['commit'],'image':digest,'runtimeImage':metadata['runtimeImage'],'testPatchSha256':hashlib.sha256((oracle/'test.patch').read_bytes()).hexdigest(),'baseline':evidence,'positiveControlPass':True})
        (out/'proof.json').write_text(json.dumps(proof,indent=2))
    (out/'tasks.json').write_text(json.dumps({'version':1,'tasks':tasks},indent=2))
    print('Prepared '+str(len(tasks))+' official tasks; no model calls made. Manifest: '+str(out/'tasks.json'))
if __name__=='__main__':main()

"""Independent SWE-bench test runner. No model calls and no solution input."""
import ast, enum, json, pathlib, re, subprocess, sys

class TestStatus(enum.Enum):
    PASSED='PASSED'
    FAILED='FAILED'
    SKIPPED='SKIPPED'
    ERROR='ERROR'

def load_parser(source):
    # Execute the frozen official parser without importing its unrelated SDKs.
    tree=ast.parse(source)
    tree.body=[n for n in tree.body if not isinstance(n,(ast.Import,ast.ImportFrom))]
    namespace={'re':re,'TestStatus':TestStatus,'TestSpec':object}
    exec(compile(tree,'official-swebench-parser','exec'),namespace)
    return namespace

def summarize(statuses, tests, exit_code):
    required=tests['FAIL_TO_PASS']+tests['PASS_TO_PASS']
    missing=[t for t in required if t not in statuses]
    failures=[t for t in required if statuses.get(t)!='PASSED']
    return {'observed':len(statuses),'required':len(required),'missing':missing,'failures':failures,'exitCode':exit_code}

def canonicalize_statuses(statuses):
    result=dict(statuses)
    for name,status in statuses.items():
        matches=[other for other in statuses if other.startswith(name+' (')]
        if len(matches)==1 and statuses[matches[0]]==status:
            result.pop(name,None)
    return result

def derive_control_tests(baseline, positive):
    if not baseline or set(baseline)!=set(positive):
        raise ValueError('Control runs must collect identical nonempty test sets')
    if any(status not in {'PASSED','FAILED'} for status in baseline.values()):
        raise ValueError('Baseline contains unavailable or skipped tests')
    if any(status!='PASSED' for status in positive.values()):
        raise ValueError('Reference must pass every collected test')
    failed=sorted(name for name,status in baseline.items() if status=='FAILED')
    if not failed:
        raise ValueError('No reproduced regression')
    return {'FAIL_TO_PASS':failed,'PASS_TO_PASS':sorted(name for name,status in baseline.items() if status=='PASSED')}

def main():
    root=pathlib.Path(__file__).resolve().parent
    metadata=json.loads((root/'metadata.json').read_text())
    repo=pathlib.Path(sys.argv[-1]).resolve()
    baseline='--baseline' in sys.argv[1:-1]
    # Test patches stay outside the candidate and are applied only in ephemeral containers.
    script="set -e\nexport LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8\nsource /opt/miniconda3/bin/activate\nconda activate testbed\ncd /testbed\nkoda_reuse_native=0\nif python /oracle/dependency_setup.py; then koda_reuse_native=1; fi\npython /oracle/sync.py\n"
    script+='if [ "$koda_reuse_native" = 1 ]; then echo KODA_FROZEN_DEPENDENCIES_REUSED; else\n'+metadata.get('setup','')+'\nfi\n' 
    script+=metadata.get('environment_setup','')+'\n'
    if not baseline:
        script+='git checkout '+metadata['commit']+' -- '+ ' '.join(metadata['test_paths'])+'\ngit apply /oracle/test.patch\n'
    script+=metadata['command']+'\n'
    result=subprocess.run(['docker','run','--rm','--network','none','--platform','linux/amd64','--cpus','4','--memory','8g',
        '--mount',f'type=bind,source={repo},target=/candidate,readonly',
        '--mount',f'type=bind,source={root},target=/oracle,readonly',metadata.get('runtimeImage',metadata['image']),
        '/bin/bash','-c',script],text=True,capture_output=True,timeout=1800)
    print(result.stdout); print(result.stderr,file=sys.stderr)
    if baseline:
        raise SystemExit(result.returncode)
    parser=load_parser((root/'official_parser.py').read_text())[metadata['parser']]
    statuses=canonicalize_statuses(parser(result.stdout+'\n'+result.stderr,None))
    evidence=summarize(statuses,metadata['tests'],result.returncode)
    missing=evidence['missing'];failures=evidence['failures']
    print('SWE_VALIDATION_RESULT='+json.dumps(evidence),flush=True)
    if missing:
        print('\nVerification environment unavailable: official tests were not all collected',file=sys.stderr)
        raise SystemExit(2)
    raise SystemExit(0 if not failures and result.returncode==0 else 1)

if __name__=='__main__':main()

"""Explicit offline V3 commands; no provider clients or paid calls."""
import argparse,time
from pathlib import Path
from source import *
from experiment import validate,freeze,final_test
from stress import run_stress,export_candidate

def main():
    p=argparse.ArgumentParser();p.add_argument('action',choices=['data','validate','freeze','test','stress','export','smoke']);p.add_argument('--output');p.add_argument('--plan',default=str(ROOT/'artifacts/data-plan/data-plan.json'));p.add_argument('--metadata',default=str(ROOT/'.cache/swe-metadata'));p.add_argument('--v2-data',default=str(V2/'.cache/public'));p.add_argument('--v2-frozen',default=str(V2/'artifacts/full-validation/frozen.json'));p.add_argument('--validation',default=str(ROOT/'artifacts/full-validation'));p.add_argument('--frozen',default=str(ROOT/'artifacts/frozen/frozen.json'));p.add_argument('--final',default=str(ROOT/'artifacts/final-holdout'));p.add_argument('--stress',default=str(ROOT/'artifacts/stress'));p.add_argument('--limit',type=int)
    a=p.parse_args();dest=a.output or str(ROOT/'artifacts'/f'{a.action}-{time.time_ns()}')
    if a.limit is not None and a.limit<1:p.error('limit must be positive')
    if a.action=='data':
        if not Path(a.metadata).exists():fetch_metadata(a.metadata)
        prepare(a.v2_data,a.metadata,dest)
    elif a.action=='validate':validate(a.plan,dest,a.v2_frozen,a.limit)
    elif a.action=='freeze':freeze(a.validation,dest)
    elif a.action=='test':final_test(a.frozen,dest)
    elif a.action=='stress':run_stress(a.frozen,a.final,dest)
    elif a.action=='export':export_candidate(a.frozen,a.stress,dest)
    else:
        import sys
        sys.path.insert(0,str(ROOT/'fixtures'))
        from fixture import build
        root=Path(dest);plan,v2freeze=build(root/'fixture');va=validate(plan,root/'validation',v2freeze);fr=freeze(va,root/'frozen');te=final_test(fr/'frozen.json',root/'test');run_stress(fr/'frozen.json',te,root/'stress')
if __name__=='__main__':main()

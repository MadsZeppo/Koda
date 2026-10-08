"""Offline commands; no production reads/imports, provider calls or paid inference."""
from __future__ import annotations
import argparse, gzip, json, subprocess, time
from pathlib import Path
from dataclasses import asdict
from core import *
from data import acquire,load
from routing import *
from evaluate import evaluate,report,decision
ROOT=Path(__file__).resolve().parents[1]
CRITERIA={'strongSolveDelta':.02,'maxCatastrophicMiss':.05,'maxEce':.10,'minimumPositiveBounds':.20,'minimumNonvacuousCoverage':.90,'promisingSolveDelta':.01}

def save(path,value):
    with Path(path).open('x') as f:f.write(encoded(value)+'\n')
def new_output(path):p=Path(path);p.parent.mkdir(parents=True,exist_ok=True);p.mkdir(exist_ok=False);return p

def predict_all(router,tasks,calibration):
    result=[]
    for t in tasks:
        pred=router.predict(RoutingTask(t.origin_query),calibration)
        result.append({'taskId':t.task_id,'dataset':t.dataset,**pred,'selections':operating_points(pred,router,t.dataset)})
    return result

def common(out,source,audit,manifest,config,search,calibration):
    save(out/'config.json',config);save(out/'source-manifest.json',source);save(out/'source-fingerprints.json',{'archive':source.get('archiveSha256'),'files':source['files'],'canonical':source['canonicalFingerprint']});save(out/'model-map.json',dict(MODEL_MAP));save(out/'dataset-audit.json',audit);save(out/'split-manifest.json',manifest);save(out/'feature-config.json',config['selectedConfig']);save(out/'hyperparameter-search.json',search);save(out/'calibration.json',calibration)

def score_run(out,predictions,sealed,criteria,notes):
    path=out/'predictions.jsonl'
    with path.open('x') as f:
        for pred in predictions:f.write(encoded(pred)+'\n')
    truth=sealed.release(path,predictions)
    with (out/'ground-truth.jsonl').open('x') as f:
        for row in truth.rows:f.write(encoded(matrix_json(row))+'\n')
    metrics,pairs=evaluate(predictions,truth);label=decision(metrics,criteria)
    save(out/'metrics.json',{'decision':label,'groups':metrics});save(out/'complementarity.json',pairs)
    (out/'summary.md').write_text(report(metrics,pairs,label,notes))
    print(f'{out}: {label}; tasks={len(truth.rows)}; text solve={metrics["overall"]["policies"]["Text retrieval"]["resolvedRate"]:.3%}; paid calls=0',flush=True)
    return metrics

def validate(directory,output,limit=None,seed=42):
    rows,source,audit=load(directory);train,val,test,manifest=split_rows(rows,seed)
    if limit:
        # Bound validation tasks, never truncate individual model rows. Include whole query groups.
        keys=sorted({r.task.query_hash for r in val.rows},key=lambda q:digest([seed,q]))[:limit]
        val=ValidationEvidence(tuple(r for r in val.rows if r.task.query_hash in keys))
    config,search=tune(train,val);router=ColdStartPredictor(train,config);calibration=fit_calibration(router,val)
    out=new_output(output)
    frozen={'version':VERSION,'selectedConfig':asdict(config),'seed':seed,'criteria':CRITERIA,'sourceFingerprint':source['canonicalFingerprint'],'trainTaskIds':[r.task.task_id for r in train.rows],'validationTaskIds':[r.task.task_id for r in val.rows],'splitManifest':manifest,'calibration':calibration,'modelMap':dict(MODEL_MAP),'selectionPolicy':'validation complete-solve maximum, then Brier, simplicity and deterministic config fingerprint','validationLimit':limit,'createdAt':time.time()}
    frozen['fingerprint']=digest({k:v for k,v in frozen.items() if k!='createdAt'})
    common(out,source,audit,manifest,frozen,search,calibration);save(out/'frozen.json',frozen)
    predictions=predict_all(router,[r.task for r in val.rows],calibration)
    score_run(out,predictions,SealedEvaluation(val.rows),CRITERIA,'TRAIN-only predictor; VALIDATION tuned and calibration fitted on these labels. These validation calibration numbers are in-sample diagnostics, NOT held-out coverage.')
    return out

def read_frozen(path,directory):
    frozen=json.loads(Path(path).read_text());expected=frozen['fingerprint']
    if digest({k:v for k,v in frozen.items() if k not in ('fingerprint','createdAt')})!=expected:raise ValueError('Frozen config fingerprint mismatch')
    if frozen['modelMap']!=dict(MODEL_MAP):raise ValueError('Unexpected frozen model pool')
    rows,source,audit=load(directory)
    if source['canonicalFingerprint']!=frozen['sourceFingerprint']:raise ValueError('Frozen source mismatch')
    train,val,test,manifest=split_rows(rows,frozen['seed'])
    if manifest!=frozen['splitManifest'] or [r.task.task_id for r in train.rows]!=frozen['trainTaskIds']:raise ValueError('Frozen split mismatch')
    return frozen,train,val,test,source,audit,manifest

def test_run(directory,frozen_path,output):
    frozen,train,val,sealed,source,audit,manifest=read_frozen(frozen_path,directory)
    if frozen['validationLimit'] is not None:raise ValueError('Formal TEST requires full validation freeze, not smoke config')
    # Single formal run for this config, exclusive lock. No automatic parameter changes/retries.
    lock=Path(frozen_path).parent/'sealed-test.claim'
    with lock.open('x') as f:f.write(encoded({'configFingerprint':frozen['fingerprint'],'output':str(output)})+'\n')
    router=ColdStartPredictor(train,Config(**frozen['selectedConfig']));out=new_output(output)
    common(out,source,audit,manifest,frozen,[],frozen['calibration'])
    predictions=predict_all(router,sealed.tasks,frozen['calibration'])
    return score_run(out,predictions,sealed,frozen['criteria'],'Formal SEALED TEST. Config and empirical error tables frozen on TRAIN/VALIDATION before labels released. No tuning on TEST. Cost selection uses TRAIN mean cost only; observed TEST cost is evaluation-only.')

def cross_eval(directory,frozen_path,output):
    frozen,train,val,test,source,audit,manifest=read_frozen(frozen_path,directory);out=new_output(output)
    common(out,source,audit,manifest,frozen,[],frozen['calibration'])
    # Target SEALED TEST only, never target train/val fitting. Same params; no cross tuning.
    rows,_,_=load(directory)
    for origin,target in [('livecodebench','swe-bench'),('swe-bench','livecodebench')]:
        source_train=TrainingEvidence(tuple(r for r in train.rows if r.task.dataset==origin));source_val=ValidationEvidence(tuple(r for r in val.rows if r.task.dataset==origin))
        # target queries cannot exist in source evidence, even if source dataset happened to duplicate them.
        targetids={t.query_hash for t in test.tasks if t.dataset==target}
        source_train=TrainingEvidence(tuple(r for r in source_train.rows if r.task.query_hash not in targetids));source_val=ValidationEvidence(tuple(r for r in source_val.rows if r.task.query_hash not in targetids))
        router=ColdStartPredictor(source_train,Config(**frozen['selectedConfig']));calibration=fit_calibration(router,source_val)
        tasks=[t for t in test.tasks if t.dataset==target];truth=SealedEvaluation(tuple(r for r in rows if r.task.task_id in {t.task_id for t in tasks}))
        sub=new_output(out/f'{origin}-to-{target}');common(sub,source,audit,manifest,frozen,[],calibration)
        score_run(sub,predict_all(router,tasks,calibration),truth,frozen['criteria'],f'Cross-benchmark {origin} TRAIN/VALIDATION → {target} SEALED TEST; no target fitting or cross-tuning. Dataset-aware static unavailable on unseen target.')
    return out

def export(directory,frozen_path,output):
    frozen,train,val,test,source,audit,manifest=read_frozen(frozen_path,directory)
    if frozen['validationLimit'] is not None:raise ValueError('Export requires full frozen validation')
    router=ColdStartPredictor(train,Config(**frozen['selectedConfig']));out=new_output(output)
    common(out,source,audit,manifest,frozen,[],frozen['calibration'])
    candidate={'version':VERSION,'productionInstalled':False,'models':dict(MODEL_MAP),'sourceFingerprint':source['canonicalFingerprint'],'frozenFingerprint':frozen['fingerprint'],'selectedConfig':frozen['selectedConfig'],'calibration':frozen['calibration'],'trainingCorpus':[matrix_json(r) for r in train.rows],'tfidfVocabulary':router.featurizer.idf,'globalPriors':router.priors,'expectedCostsTrain':router.expected_costs,'OOD':{'minimumSimilarity':router.config.low_similarity,'minimumMass':router.config.low_mass,'unsupportedCalibration':'LOW_EVIDENCE'},'limitations':['PUBLIC_HARNESS_ONLY','UNSEEN_MODEL_NOT_SUPPORTED','NO_FORMAL_INTERVAL_GUARANTEE']}
    with (out/'contextual-cold-start-v2-candidate.json.gz').open('xb') as f:f.write(gzip.compress(encoded(candidate).encode(),mtime=0))
    return out

def main():
    p=argparse.ArgumentParser();p.add_argument('action',choices=['data','validate','test','cross-eval','export','smoke']);p.add_argument('--dataset',default=str(ROOT/'.cache/public'));p.add_argument('--archive');p.add_argument('--revision',default='main');p.add_argument('--output');p.add_argument('--frozen');p.add_argument('--limit',type=int);p.add_argument('--seed',type=int,default=42)
    args=p.parse_args()
    if args.limit is not None and args.limit<1:p.error('limit must be positive')
    output=args.output or str(ROOT/'artifacts'/f'{args.action}-{time.time_ns()}')
    if args.action=='data':
        source,audit=acquire(args.output or args.dataset,args.archive,args.revision);print(json.dumps(audit,indent=2));return
    if args.action=='validate':validate(args.dataset,output,args.limit,args.seed)
    elif args.action=='smoke':
        import sys
        sys.path.insert(0,str(ROOT/'fixtures'))
        from build_fixture import prepare
        fixture=prepare(Path(output)/'dataset');frozen=validate(fixture,Path(output)/'validation',seed=args.seed)
        test_run(fixture,frozen/'frozen.json',Path(output)/'test');cross_eval(fixture,frozen/'frozen.json',Path(output)/'cross');export(fixture,frozen/'frozen.json',Path(output)/'export')
    else:
        if not args.frozen:p.error('--frozen /path/to/validation/frozen.json required')
        {'test':test_run,'cross-eval':cross_eval,'export':export}[args.action](args.dataset,args.frozen,output)
if __name__=='__main__':main()

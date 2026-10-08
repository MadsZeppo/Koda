"""Frozen-parameter repo and cross-benchmark stress tests, never hyperparameter tuning."""
import json
from pathlib import Path
from v2bridge import *
from source import *
from experiment import *
from models import ModelConfig

def refit(train,val,metadata,cfg):
    fits={f:fit_bundle(train,val,metadata,ModelConfig(**c),pair=f=='pairwise') for f,c in cfg['familyConfigs'].items()}
    v2=baseline(train,val,cfg['v2FrozenPath'])
    return fits,v2

def run_stress(frozen_path,final_directory,dest):
    cfg,plan,train,val,holdout,bundle=load_frozen(frozen_path);out=output(dest);save(out/'config.json',cfg)
    final=json.loads((Path(final_directory)/'config.json').read_text())
    if final['fingerprint']!=cfg['fingerprint']:raise ValueError('Final result/config mismatch')
    # Pure stress refits. Locked hyperparameters and method; no stress selection.
    rows=list(train.rows)+list(val.rows)+[r for r in load_v2(plan['v2DataDirectory'])[0] if r.task.task_id in {t.task_id for t in holdout.tasks}]
    metadata=plan['metadata'];folds=repo_folds(rows,metadata,5);allpreds=[];alltruth=[];fold_records=[]
    for fold_id,repos in enumerate(folds):
        testrows=tuple(sorted((r for r in rows if r.task.dataset=='swe-bench' and metadata.get(r.task.task_id,{}).get('repo') in repos),key=lambda r:r.task.task_id))
        trainrows=tuple(r for r in train.rows if metadata.get(r.task.task_id,{}).get('repo') not in repos)
        valrows=tuple(r for r in val.rows if metadata.get(r.task.task_id,{}).get('repo') not in repos)
        # Exclude semantic duplicates of heldout queries too, across repository aliases.
        held_hash={semantic_hash(routing_input(r.task,metadata.get(r.task.task_id,{})).text) for r in testrows}
        trainrows=tuple(r for r in trainrows if semantic_hash(routing_input(r.task,metadata.get(r.task.task_id,{})).text) not in held_hash);valrows=tuple(r for r in valrows if semantic_hash(routing_input(r.task,metadata.get(r.task.task_id,{})).text) not in held_hash)
        if not trainrows or not valrows:raise ValueError('Repo fold has insufficient source train/validation')
        if {metadata[r.task.task_id]['repo'] for r in (*trainrows,*valrows) if r.task.dataset=='swe-bench'} & set(repos):raise ValueError('Repository leakage')
        tr,va=TrainingEvidence(trainrows),ValidationEvidence(valrows);fits,v2=refit(tr,va,metadata,cfg);sub=output(out/f'repo-fold-{fold_id}')
        save(sub/'split.json',{'heldoutRepos':repos,'train':[r.task.task_id for r in trainrows],'validation':[r.task.task_id for r in valrows],'holdout':[r.task.task_id for r in testrows],'hyperparametersFrozen':True})
        preds=predictions([r.task for r in testrows],fits,cfg['selectedFamily'],metadata,v2);emit_score(sub,preds,SealedEvaluation(testrows),metadata,cfg['protocol']['bootstrapReplicates']);allpreds.extend(preds);alltruth.extend(testrows);fold_records.append({'fold':fold_id,'repos':repos,'train':len(trainrows),'validation':len(valrows),'holdout':len(testrows)})
        print('V3 repo-held-out fold',fold_id,'test',len(testrows),flush=True)
    # Combined out-of-repo predictions only. Each task predicted by a model never fitted on its repo.
    if len({r.task.task_id for r in alltruth})!=len(alltruth):raise ValueError('Duplicate repo test prediction')
    aligned=sorted(zip(alltruth,allpreds),key=lambda x:x[0].task.task_id);repoout=output(out/'repo-held-out');repo_metrics=emit_score(repoout,[p for r,p in aligned],SealedEvaluation(tuple(r for r,p in aligned)),metadata,cfg['protocol']['bootstrapReplicates']);save(out/'repo-folds.json',fold_records)
    cross={}
    for origin,target in [('livecodebench','swe-bench'),('swe-bench','livecodebench')]:
        source_train=TrainingEvidence(tuple(r for r in train.rows if r.task.dataset==origin));source_val=ValidationEvidence(tuple(r for r in val.rows if r.task.dataset==origin));target_tasks=[t for t in holdout.tasks if t.dataset==target];keys={t.task_id for t in target_tasks};testrows=tuple(sorted((r for r in rows if r.task.task_id in keys),key=lambda r:r.task.task_id))
        fits,v2=refit(source_train,source_val,metadata,cfg);sub=output(out/f'{origin}-to-{target}');metrics=emit_score(sub,predictions([r.task for r in testrows],fits,cfg['selectedFamily'],metadata,v2),SealedEvaluation(testrows),metadata,cfg['protocol']['bootstrapReplicates']);cross[f'{origin}-to-{target}']=metrics
        print('V3 cross',origin,'to',target,metrics['groups'][target]['methods']['Selected V3']['solveRate'],flush=True)
    primary=json.loads((Path(final_directory)/'metrics.json').read_text());label=result_label(primary,repo_metrics,cfg['criteria'],'Selected V3');save(out/'decision.json',{'label':label,'criteria':cfg['criteria'],'frozenFingerprint':cfg['fingerprint'],'primaryResult':str(Path(final_directory).resolve()),'repoResult':str(repoout.resolve()),'paidCalls':0,'productionIntegration':False})
    print('COLD START V3 — SWE-FIRST RESULT:',label,flush=True)
    return out

def export_candidate(frozen_path,stress_directory,dest):
    cfg,plan,train,val,holdout,bundle=load_frozen(frozen_path);decision=json.loads((Path(stress_directory)/'decision.json').read_text())
    if decision['frozenFingerprint']!=cfg['fingerprint']:raise ValueError('Decision/freeze mismatch')
    if decision['label'] not in ('PROMISING','STRONG_SIGNAL'):raise ValueError('No candidate export for NO_IMPROVEMENT')
    out=output(dest);chosen=bundle['fits'][cfg['selectedFamily']]
    joblib.dump(chosen,out/'contextual-cold-start-v3-candidate.joblib',compress=3)
    candidate={'schemaVersion':cfg['version'],'models':dict(MODEL_MAP),'decision':decision,'sourceFingerprints':plan['outcomeSource'],'metadataSource':plan['metadataSource'],'selectedFamily':cfg['selectedFamily'],'configFingerprint':cfg['fingerprint'],'featureSchema':chosen['model'].features.summary(),'parameters':chosen['model'].export(),'pairwise':chosen['pair'].export() if chosen['pair'] else None,'calibration':[c.export() for c in chosen['calibrators']],'support':chosen['support'].export(),'payloadSha256':digest((out/'contextual-cold-start-v3-candidate.joblib').read_bytes()),'productionInstalled':False,'artifactTrust':'Load only trusted locally generated joblib; dependencies pinned in requirements.txt'}
    with (out/'contextual-cold-start-v3-candidate.json.gz').open('xb') as f:f.write(gzip.compress(encoded(candidate).encode(),mtime=0))
    return out

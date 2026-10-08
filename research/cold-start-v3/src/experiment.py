"""SWE-first tuning, freeze, independent prediction artifacts and stress protocols."""
import json,time,copyreg,gzip
from pathlib import Path
from dataclasses import asdict
from types import MappingProxyType
import joblib,numpy as np
from v2bridge import *
from source import *
from features import structured
from models import *
from calibration import *
from evaluation import evaluate,rank,result_label
copyreg.pickle(type(MappingProxyType({})),lambda value:(dict,(dict(value),)))
PROTOCOL=json.loads((ROOT/'configs/protocol.json').read_text())
LABELS={'structured':'Structured','text':'Text','combined':'Text + structured','pairwise':'Pairwise','repo':'Repo identity ablation','nonlinear':'Nonlinear structured'}

def code_fingerprint():
    files=[*sorted((ROOT/'src').glob('*.py')),ROOT/'requirements.txt',ROOT/'configs/protocol.json']
    return digest({str(p.relative_to(ROOT)):digest(p.read_bytes()) for p in files})

def save(path,data):
    with Path(path).open('x') as f:f.write(encoded(data)+'\n')
def output(path):p=Path(path);p.mkdir(parents=True,exist_ok=False);return p

def truth_labels(evidence):return np.array([[int(r.outcomes[m].success) for m in MODELS] for r in evidence.rows])

def fit_bundle(train,val,metadata,config,pair=False,feature_cache=None):
    if type(train) is not TrainingEvidence or type(val) is not ValidationEvidence:raise TypeError('TRAIN and VALIDATION required')
    model=ModelSuccessPredictor(train,metadata,config,feature_cache=feature_cache);inputs=[routing_input(r.task,metadata.get(r.task.task_id,{})) for r in val.rows];p=model.predict(inputs);y=truth_labels(val)
    calibrators,oof,search=calibrate(p,y,val);support=EvidenceSupportEstimator(model,inputs,oof,y,val)
    return {'model':model,'pair':PairwiseModelPredictor(model) if pair else None,'calibrators':calibrators,'support':support,'calibrationSearch':search,'validationOOF':oof,'rawValidation':p}

def fit_all(train,val,metadata,Cs):
    mask=np.array([r.task.dataset=='swe-bench' for r in val.rows]);y=truth_labels(val)
    if not mask.any():mask=np.ones(len(val.rows),dtype=bool) # cross source-only fit never tunes here
    fits={};search=[];feature_caches={}
    for family in ('structured','text','combined','pairwise','repo','nonlinear'):
        entries=[]
        for C in Cs:
            config=ModelConfig('combined' if family in ('pairwise','repo') else 'structured' if family=='nonlinear' else family,C,family=='repo','tree' if family=='nonlinear' else 'logistic')
            cache_key=(config.mode,config.repo_identity)
            bundle=fit_bundle(train,val,metadata,config,pair=family=='pairwise',feature_cache=feature_caches.get(cache_key))
            base=bundle['model'];feature_caches[cache_key]=(base.inputs,base.features,base.x)
            if family=='pairwise':
                inputs=[routing_input(r.task,metadata.get(r.task.task_id,{})) for r in val.rows];scores,_=bundle['pair'].predict(inputs)
            else:scores=bundle['validationOOF']
            selected=np.array([rank(s)[0] for s in scores]);success=y[np.arange(len(y)),selected]
            metrics={'family':family,'config':asdict(config),'SWEValidationSolve':float(success[mask].mean()),'SWEValidationBrier':float(np.mean((bundle['validationOOF'][mask]-y[mask])**2)),'overallValidationSolve':float(success.mean())}
            search.append(metrics);entries.append((metrics,bundle));print(f'V3 VALIDATION {family} C={C}: SWE={metrics["SWEValidationSolve"]:.3%}',flush=True)
        entries.sort(key=lambda e:(-e[0]['SWEValidationSolve'],e[0]['SWEValidationBrier'],-e[0]['overallValidationSolve'],e[0]['config']['C'],digest(e[0]['config'])))
        fits[family]=entries[0][1];fits[family]['selectionMetrics']=entries[0][0]
    selected=sorted((f for f in fits if f!='repo'),key=lambda f:(-fits[f]['selectionMetrics']['SWEValidationSolve'],fits[f]['selectionMetrics']['SWEValidationBrier'],-fits[f]['selectionMetrics']['overallValidationSolve'],fits[f]['model'].config.C,f))[0]
    return fits,selected,search

def baseline(train,val,v2_frozen):
    cfg=json.loads(Path(v2_frozen).read_text());expected=cfg['fingerprint']
    if digest({k:v for k,v in cfg.items() if k not in ('fingerprint','createdAt')})!=expected:raise ValueError('V2 config changed')
    predictor=retrieval.ColdStartPredictor(train,retrieval.Config(**cfg['selectedConfig']));cal=retrieval.fit_calibration(predictor,val)
    return predictor,cal,expected

def method(probabilities,ranking=None,bounds=None,low=False,support=None,cuts=None):
    order=rank(probabilities) if ranking is None else ranking
    return {'selected':MODELS[order[0]],'ranking':[MODELS[j] for j in order],'probabilities':[float(v) for v in probabilities] if probabilities is not None else None,'bounds':[float(v) for v in bounds] if bounds is not None else [0.]*6,'lowEvidence':bool(low),'supportScore':float(support) if support is not None else None,'coverageCuts':cuts or {}}

def predictions(tasks,fits,selected,metadata,v2):
    inputs=[routing_input(t,metadata.get(t.task_id,{})) for t in tasks];cache={}
    for family,bundle in fits.items():
        raw=bundle['model'].predict(inputs);prob=apply(bundle['calibrators'],raw);sim,low,bounds=bundle['support'].predict(inputs,prob)
        pair_scores,pair_probs=bundle['pair'].predict(inputs) if bundle['pair'] else (None,None)
        cache[family]=(raw,prob,sim,low,bounds,pair_scores,pair_probs)
    primary=fits[selected]['model'];results=[]
    for i,t in enumerate(tasks):
        vp=v2[0].predict(RoutingTask(t.origin_query),v2[1]);ve={p['modelId']:p for p in vp['models']};vprob=[ve[m]['predictedSuccess'] for m in MODELS];vbound=[ve[m]['lowerBound'] or 0 for m in MODELS]
        methods={'Frozen V2':method(vprob,bounds=vbound,low=vp['status']=='LOW_EVIDENCE')}
        for family,bundle in fits.items():
            raw,prob,sim,low,bounds,pairs,pairprobs=cache[family];ranking=rank(pairs[i]) if pairs is not None else None
            methods[LABELS[family]]=method(prob[i],ranking,bounds[i],low[i],sim[i],bundle['support'].thresholds['coverageCuts'])
            if family!='pairwise':methods[LABELS[family]+' uncalibrated']=method(raw[i],bounds=[0.]*6,low=low[i],support=sim[i])
        raw,prob,sim,low,bounds,pairs,pairprobs=cache[selected];methods['Selected V3']=dict(methods[LABELS[selected]])
        conservative=sorted(range(6),key=lambda j:(-float(bounds[i,j]),-float(prob[i,j]),MODELS[j]));methods['V3 conservative']=method(prob[i],conservative,bounds[i],low[i],sim[i],fits[selected]['support'].thresholds['coverageCuts'])
        ref=rank(prob[i])[0]
        for gap in PROTOCOL['costGaps']:
            candidates=[j for j in range(6) if prob[i,j]>=prob[i,ref]-gap]
            if all(primary.expected_costs[m] is not None for m in MODELS):chosen=min(candidates,key=lambda j:(primary.expected_costs[MODELS[j]],-float(prob[i,j]),MODELS[j]))
            else:chosen=ref
            ranking=[chosen]+[j for j in rank(prob[i]) if j!=chosen];methods[f'V3 cost gap={gap}']=method(prob[i],ranking,bounds[i],low[i],sim[i],fits[selected]['support'].thresholds['coverageCuts'])
        priors=[primary.priors[m] for m in MODELS];methods['Best static TRAIN']=method(priors)
        dataset_prior=primary.dataset_priors.get(t.dataset)
        if dataset_prior is not None:methods['Dataset-aware static']=method([dataset_prior[m] for m in MODELS])
        else:
            # Explicitly mark unavailable; never call unseen target prior "dataset aware".
            methods['Dataset-aware static']=method(priors);methods['Dataset-aware static']['unavailable']=True
        for j,m in enumerate(MODELS):methods['Always '+m]=method(priors,[j]+[k for k in rank(priors) if k!=j])
        # Nearest relevant TRAIN examples, selected by features only, for later error audit.
        nearest=[]
        matrix=fits[selected]['model'].features.transform([inputs[i]])
        from sklearn.metrics.pairwise import cosine_similarity
        similarities=cosine_similarity(matrix,fits[selected]['model'].x).reshape(-1)
        for k in sorted(range(len(similarities)),key=lambda k:(-float(similarities[k]),primary.train_rows[k].task.task_id))[:3]:nearest.append({'taskId':primary.train_rows[k].task.task_id,'similarity':float(similarities[k])})
        results.append({'taskId':t.task_id,'dataset':t.dataset,'methods':methods,'pairwiseScores':cache['pairwise'][5][i].tolist() if 'pairwise' in cache else None,'nearestTrainTasks':nearest,'featureProfile':structured(inputs[i])})
    return results

def emit_score(out,preds,sealed,metadata,bootstrap):
    path=out/'predictions.jsonl'
    with path.open('x') as f:
        for pred in preds:f.write(encoded(pred)+'\n')
    truth=sealed.release(path,preds)
    with (out/'ground-truth.jsonl').open('x') as f:
        for row in truth.rows:f.write(encoded(matrix_json(row))+'\n')
    metrics,errors=evaluate(preds,truth,metadata,'Selected V3',bootstrap);save(out/'metrics.json',metrics);save(out/'error-analysis.json',errors)
    return metrics

def validate(plan_path,dest,v2_frozen,limit=None):
    plan,train,val,holdout=load_plan(plan_path)
    if limit is not None:
        # Choose all SWE validation first, then other groups. Never break a task's six outcomes.
        ordered=sorted(val.rows,key=lambda r:(r.task.dataset!='swe-bench',digest([plan['split']['seed'],r.task.query_hash])))
        keys=[]
        for r in ordered:
            key=semantic_hash(routing_input(r.task,plan['metadata'].get(r.task.task_id,{})).text)
            if key not in keys and len(keys)<limit:keys.append(key)
        val=ValidationEvidence(tuple(r for r in val.rows if semantic_hash(routing_input(r.task,plan['metadata'].get(r.task.task_id,{})).text) in keys))
    out=output(dest);save(out/'protocol.json',PROTOCOL);save(out/'data-plan.json',plan)
    fits,selected,search=fit_all(train,val,plan['metadata'],PROTOCOL['Cs']);v2=baseline(train,val,v2_frozen)
    config={'version':PROTOCOL['version'],'dataPlanFingerprint':plan['fingerprint'],'implementationFingerprint':code_fingerprint(),'selectedFamily':selected,'selectedConfig':asdict(fits[selected]['model'].config),'familyConfigs':{f:asdict(b['model'].config) for f,b in fits.items()},'criteria':PROTOCOL['criteria'],'protocol':PROTOCOL,'validationLimit':limit,'v2FrozenPath':str(Path(v2_frozen).resolve()),'v2FrozenFingerprint':v2[2],'validationTaskIds':[r.task.task_id for r in val.rows]}
    config['fingerprint']=digest(config);save(out/'selection.json',config);save(out/'hyperparameter-search.json',search)
    joblib.dump({'fits':fits,'selected':selected,'v2':v2},out/'models.joblib',compress=3)
    save(out/'models-fingerprint.json',{'sha256':digest((out/'models.joblib').read_bytes())})
    save(out/'feature-schema.json',{f:b['model'].features.summary() for f,b in fits.items()});save(out/'calibration.json',{f:{'search':b['calibrationSearch'],'calibrators':[c.export() for c in b['calibrators']],'support':b['support'].export()} for f,b in fits.items()})
    metrics=emit_score(out,predictions([r.task for r in val.rows],fits,selected,plan['metadata'],v2),SealedEvaluation(val.rows),plan['metadata'],PROTOCOL['bootstrapReplicates'])
    print('V3 validation selected',selected,'SWE',metrics['groups']['swe-bench']['methods']['Selected V3']['solveRate'],flush=True)
    return out

def freeze(validation,dest):
    root=Path(validation);cfg=json.loads((root/'selection.json').read_text())
    expected=cfg.pop('fingerprint')
    if digest(cfg)!=expected:raise ValueError('Selection config fingerprint mismatch')
    cfg['fingerprint']=expected
    if cfg['implementationFingerprint']!=code_fingerprint():raise ValueError('Implementation changed after validation')
    if cfg['validationLimit'] is not None:raise ValueError('Full validation required for final freeze')
    out=output(dest);cfg['validationDirectory']=str(root.resolve());cfg['modelsFingerprint']=json.loads((root/'models-fingerprint.json').read_text())['sha256'];cfg['selectionFingerprint']=cfg.pop('fingerprint');cfg['fingerprint']=digest(cfg);save(out/'frozen.json',cfg)
    return out

def load_frozen(path):
    cfg=json.loads(Path(path).read_text());expected=cfg.pop('fingerprint')
    if digest(cfg)!=expected:raise ValueError('Frozen fingerprint mismatch')
    cfg['fingerprint']=expected;root=Path(cfg['validationDirectory']);plan,train,val,holdout=load_plan(root/'data-plan.json')
    if plan['fingerprint']!=cfg['dataPlanFingerprint']:raise ValueError('Frozen plan changed')
    if digest((root/'models.joblib').read_bytes())!=cfg['modelsFingerprint']:raise ValueError('Frozen model payload changed')
    if cfg['implementationFingerprint']!=code_fingerprint():raise ValueError('Implementation changed after freeze')
    if cfg['protocol']!=PROTOCOL:raise ValueError('Protocol changed after freeze')
    return cfg,plan,train,val,holdout,joblib.load(root/'models.joblib')

def final_test(frozen_path,dest):
    cfg,plan,train,val,holdout,bundle=load_frozen(frozen_path)
    claim=Path(frozen_path).parent/'final-holdout.claim'
    with claim.open('x') as f:f.write(encoded({'frozenFingerprint':cfg['fingerprint'],'output':str(dest)})+'\n')
    out=output(dest);save(out/'config.json',cfg);save(out/'data-plan.json',plan)
    preds=predictions(holdout.tasks,bundle['fits'],bundle['selected'],plan['metadata'],bundle['v2']);metrics=emit_score(out,preds,holdout,plan['metadata'],cfg['protocol']['bootstrapReplicates'])
    print('V3 FINAL HOLDOUT SWE',metrics['groups']['swe-bench']['methods']['Selected V3']['solveRate'],'paid calls=0',flush=True)
    return out

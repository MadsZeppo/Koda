"""Hidden-label evaluation only: paired inference, recall, complementarity and errors."""
import numpy as np
from collections import Counter,defaultdict
from v2bridge import *
from source import routing_input
from features import structured

def rank(values):return sorted(range(6),key=lambda j:(-float(values[j]),MODELS[j]))
def calibration(p,y,bounds=None):
    result={}
    for key,indices in [(m,[j]) for j,m in enumerate(MODELS)]+[('overall',list(range(6)))]:
        probs=p[:,indices].reshape(-1);labels=y[:,indices].reshape(-1);n=len(labels);bins=[]
        for i in range(10):
            mask=np.minimum(9,(probs*10).astype(int))==i;count=int(mask.sum());bins.append({'bin':[i/10,(i+1)/10],'count':count,'predicted':float(probs[mask].mean()) if count else None,'observed':float(labels[mask].mean()) if count else None})
        b=bounds[:,indices].reshape(-1) if bounds is not None else np.zeros(n);positive=b>0
        result[key]={'brier':float(np.mean((probs-labels)**2)),'logLoss':float(-np.mean(labels*np.log(np.clip(probs,1e-12,1-1e-12))+(1-labels)*np.log(np.clip(1-probs,1e-12,1-1e-12)))),'ece':sum(b['count']/n*abs(b['predicted']-b['observed']) for b in bins if b['count']),'bins':bins,'boundCoverage':float(np.mean(labels>=b)),'positiveBoundRate':float(positive.mean()),'positiveBoundCoverage':float(np.mean(labels[positive]>=b[positive])) if positive.any() else None}
    return result

def paired_interval(a,b,seed=20261007,replicates=2000,groups=None):
    delta=np.asarray(a,dtype=float)-np.asarray(b,dtype=float);rng=np.random.default_rng(seed)
    if len(delta)==0:return None
    if groups is None:values=delta[rng.integers(0,len(delta),size=(replicates,len(delta)))].mean(axis=1)
    else:
        unique=sorted(set(groups));indexes={g:np.where(np.array(groups)==g)[0] for g in unique};values=[]
        for _ in range(replicates):values.append(float(delta[np.concatenate([indexes[unique[i]] for i in rng.integers(0,len(unique),len(unique))])].mean()))
    return {'delta':float(delta.mean()),'lower':float(np.quantile(values,.025)),'upper':float(np.quantile(values,.975)),'paired':True,'resampling':'repository clusters' if groups is not None else 'tasks','replicates':replicates}

def outcome_matrix(truth):
    if type(truth) is not EvaluationGroundTruth:raise TypeError('Released truth required')
    return np.array([[int(r.outcomes[m].success) for m in MODELS] for r in truth.rows],dtype=int)

def evaluate(predictions,truth,metadata,selected_name,bootstrap=2000):
    y=outcome_matrix(truth);rows=truth.rows
    if len(predictions)!=len(rows) or [p['taskId'] for p in predictions]!=[r.task.task_id for r in rows]:raise ValueError('Truth/prediction alignment mismatch')
    methods=list(predictions[0]['methods']);groups={};errors=[];selection_arrays={}
    for name in methods:
        selected=np.array([MODELS.index(p['methods'][name]['selected']) for p in predictions]);selection_arrays[name]=y[np.arange(len(rows)),selected]
    selection_arrays['Oracle']=y.max(axis=1)
    for dataset in ('swe-bench','overall','livecodebench'):
        mask=np.array([dataset=='overall' or r.task.dataset==dataset for r in rows]);ids=np.where(mask)[0]
        if not len(ids):continue
        sub=y[ids];oracle=sub.max(axis=1);mixed=(sub.sum(axis=1)>0)&(sub.sum(axis=1)<6);n=len(ids);metrics={}
        static_index=sorted(range(6),key=lambda j:(-float(sub[:,j].mean()),MODELS[j]))[0]
        methods2=methods+['Oracle']
        for name in methods2:
            ps=[predictions[i]['methods'][name] for i in ids] if name!='Oracle' else None
            selected=np.array([MODELS.index(p['selected']) for p in ps]) if ps else np.array([rank(sub[i])[0] for i in range(n)])
            success=sub[np.arange(n),selected];regret=oracle-success;cat=(success==0)&(oracle==1)
            rankings=[p['ranking'] for p in ps] if ps else [[MODELS[j] for j in rank(row)] for row in sub]
            recall={}
            for j,m in enumerate(MODELS):
                win=sub[:,j]==1;recall[m]={'successfulAlternatives':int(win.sum()),**{f'top{k}':int(sum(win[i] and m in rankings[i][:k] for i in range(n))) for k in (1,2,3)}}
            winner_recall={f'top{k}':sum(any(sub[i,MODELS.index(m)] for m in rankings[i][:k]) for i in range(n) if oracle[i])/int(oracle.sum()) if oracle.sum() else None for k in (1,2,3)}
            pairtable={};numerator=denominator=0
            for a in range(6):
                for b in range(a+1,6):
                    disagree=sub[:,a]!=sub[:,b];count=int(disagree.sum());correct=sum(disagree[i] and (rankings[i].index(MODELS[a])<rankings[i].index(MODELS[b]))==bool(sub[i,a]) for i in range(n));numerator+=correct;denominator+=count
                    pairtable[f'{MODELS[a]}|{MODELS[b]}']={'bothPass':int(((sub[:,a]==1)&(sub[:,b]==1)).sum()),'aOnly':int(((sub[:,a]==1)&(sub[:,b]==0)).sum()),'bOnly':int(((sub[:,a]==0)&(sub[:,b]==1)).sum()),'bothFail':int(((sub[:,a]==0)&(sub[:,b]==0)).sum()),'disagreements':count,'preferredSuccessful':int(correct),'resolutionAccuracy':correct/count if count else None}
            costs=[rows[i].outcomes[MODELS[selected[k]]].cost_usd for k,i in enumerate(ids)];costvalid=all(c is not None for c in costs);low=np.array([p['lowEvidence'] for p in ps]) if ps else np.zeros(n,dtype=bool);routed=~low
            probs=np.array([p['probabilities'] for p in ps]) if ps and ps[0]['probabilities'] is not None else None
            bounds=np.array([p['bounds'] for p in ps]) if probs is not None else None
            m={'tasks':n,'solved':int(success.sum()),'solveRate':float(success.mean()),'deltaBestStaticPosthoc':float(success.mean()-sub[:,static_index].mean()),'oracleRate':float(oracle.mean()),'remainingOracleGap':float(regret.mean()),'qualityRegret':{'mean':float(regret.mean()),**{f'p{k}':float(np.quantile(regret,k/100,method='higher')) for k in (50,90,95)}},'catastrophicMiss':float(cat.mean()),'catastrophicMissAmongDisagreement':float(cat[mixed].mean()) if mixed.any() else None,'winnerSetRecall':winner_recall,'modelRecall':recall,'pairwiseDisagreementResolution':numerator/denominator if denominator else None,'pairwise':pairtable,'selectedDistribution':dict(Counter(MODELS[j] for j in selected)),'costPerAttempt':sum(costs)/n if costvalid else None,'costPerResolved':sum(costs)/int(success.sum()) if costvalid and success.sum() else None,'lowEvidenceRate':float(low.mean()),'routedCoverage':float(routed.mean()),'conditionalRoutedSolve':float(success[routed].mean()) if routed.any() else None,'calibration':calibration(probs,sub,bounds) if probs is not None else None}
            if probs is not None and ps and ps[0].get('supportScore') is not None:
                cuts=ps[0].get('coverageCuts',{});m['selectiveCoverage']={}
                for point,cut in cuts.items():
                    routing=np.array([p['supportScore']>=cut for p in ps]);m['selectiveCoverage'][point]={'validationCut':cut,'actualCoverage':float(routing.mean()),'conditionalSolve':float(success[routing].mean()) if routing.any() else None,'catastrophicMissConditional':float(cat[routing].mean()) if routing.any() else None}
            m['unavailableTasks']=sum(p.get('unavailable',False) for p in ps) if ps else 0
            if m['unavailableTasks']:
                for k in ('solveRate','deltaBestStaticPosthoc','remainingOracleGap','catastrophicMiss','costPerAttempt','costPerResolved'):m[k]=None
            metrics[name]=m
        selected_success=selection_arrays[selected_name][ids];comparisons={}
        for baseline in ('Frozen V2','Best static TRAIN','Dataset-aware static','Oracle'):
            if baseline in selection_arrays and not metrics[baseline]['unavailableTasks']:
                comparisons[baseline]=paired_interval(selected_success,selection_arrays[baseline][ids],replicates=bootstrap)
                repos=[metadata.get(rows[i].task.task_id,{}).get('repo') for i in ids]
                if dataset=='swe-bench' and all(repos):comparisons[baseline]['repoClusterInterval']=paired_interval(selected_success,selection_arrays[baseline][ids],replicates=bootstrap,groups=repos)
        comparisons['Best static posthoc']=paired_interval(selected_success,sub[:,static_index],replicates=bootstrap)
        groups[dataset]={'headroom':{'bestStaticModel':MODELS[static_index],'bestStaticRate':float(sub[:,static_index].mean()),'oracleRate':float(oracle.mean()),'allPass':float((sub.sum(axis=1)==6).mean()),'allFail':float((sub.sum(axis=1)==0).mean()),'mixed':float(mixed.mean())},'methods':metrics,'selectedVsBaseline':comparisons}
    for i,r in enumerate(rows):
        if r.task.dataset!='swe-bench':continue
        p=predictions[i];method=p['methods'][selected_name];j=MODELS.index(method['selected'])
        if not y[i,j] and y[i].max():
            task=routing_input(r.task,metadata.get(r.task.task_id,{}));features=structured(task);errors.append({'taskId':r.task.task_id,'taskReference':{'text':task.text[:1600],'textHash':digest(task.text),'repo':task.metadata.get('repo'),'instanceId':task.metadata.get('instance_id')},'features':features,'selected':MODELS[j],'successfulAlternatives':[m for j,m in enumerate(MODELS) if y[i,j]],'probabilities':dict(zip(MODELS,method['probabilities'])) if method['probabilities'] is not None else None,'pairwiseScores':p.get('pairwiseScores'),'support':{'score':method.get('supportScore'),'nearestTrainTasks':p.get('nearestTrainTasks',[])},'lowEvidence':method['lowEvidence']})
    aggregates=Counter()
    for e in errors:
        for k,v in e['features'].items():
            if v>0 and k.startswith(('technical:','kind:','scope:','language:','ecosystem:')):aggregates[k]+=1
        if e['taskReference']['repo']:aggregates['repo:'+e['taskReference']['repo']]+=1
    return {'groups':groups,'selectedMethod':selected_name}, {'failures':errors,'featureFailureCounts':dict(aggregates.most_common()),'policy':'categories/features fixed before final outcomes; overlapping counts, no manual relabeling'}

def result_label(primary,repo,criteria,selected_name):
    g=primary['groups']['swe-bench'];v=g['methods'][selected_name];base=g['methods']['Frozen V2'];static=g['methods']['Always '+g['headroom']['bestStaticModel']];interval=g['selectedVsBaseline']['Frozen V2'];istatic=g['selectedVsBaseline']['Best static posthoc'];rg=repo['groups']['swe-bench'];r=rg['methods'][selected_name];rb=rg['methods']['Frozen V2'];rs=rg['methods']['Always '+rg['headroom']['bestStaticModel']]
    delta=v['solveRate']-base['solveRate'];repo_delta=r['solveRate']-rb['solveRate']
    if delta<criteria['promisingDeltaV2'] or interval['lower']<criteria['promisingPairedLowerV2'] or v['catastrophicMiss']>=base['catastrophicMiss'] or repo_delta<criteria['minimumRepoDeltaV2']:return 'NO_IMPROVEMENT'
    vc=v['calibration']['overall'] if v['calibration'] else None;bc=base['calibration']['overall'] if base['calibration'] else None
    strong=delta>=criteria['strongDeltaV2'] and interval['lower']>criteria['strongPairedLowerV2'] and v['solveRate']-static['solveRate']>=criteria['strongDeltaStatic'] and istatic['lower']>=criteria['strongPairedLowerStatic'] and base['catastrophicMiss']-v['catastrophicMiss']>=criteria['strongCatReduction'] and vc is not None and bc is not None and bc['ece']-vc['ece']>=criteria['strongEceReduction'] and v['routedCoverage']>=criteria['strongMinimumRoutedCoverage'] and v['conditionalRoutedSolve'] is not None and v['conditionalRoutedSolve']>=static['solveRate']-criteria['strongConditionalSolveTolerance'] and (v['costPerResolved'] is not None and static['costPerResolved'] is not None and v['costPerResolved']<=static['costPerResolved'] or v['solveRate']-static['solveRate']>=criteria['strongQualityAlternativeToCost']) and r['solveRate']-rs['solveRate']>=criteria['strongMinimumRepoDeltaStatic']
    return 'STRONG_SIGNAL' if strong else 'PROMISING'

"""Evaluator-only oracle, decision metrics, calibration and pairwise complementarity."""
from __future__ import annotations
import math
from collections import Counter
from core import *
from routing import quantile

def calibration_metrics(predictions,rows):
    table={}
    rowmap={r.task.task_id:r for r in rows}
    for model in (*MODELS,'overall'):
        obs=[]
        for pred in predictions:
            r=rowmap[pred['taskId']]
            for p in pred['models']:
                if model=='overall' or p['modelId']==model:obs.append((p,r.outcomes[p['modelId']].score))
        n=len(obs);bins=[]
        for i in range(10):
            values=[(p,y) for p,y in obs if min(9,int(p['predictedSuccess']*10))==i]
            bins.append({'bin':[i/10,(i+1)/10],'count':len(values),'predicted':sum(p['predictedSuccess'] for p,y in values)/len(values) if values else None,'observed':sum(y for p,y in values)/len(values) if values else None})
        nonzero=[(p,y) for p,y in obs if p['lowerBound'] is not None and p['lowerBound']>0]
        supported=[(p,y) for p,y in obs if p['status']!='LOW_EVIDENCE']
        table[model]={'n':n,'brier':sum((p['predictedSuccess']-y)**2 for p,y in obs)/n,'logLoss':-sum(y*math.log(max(1e-12,min(1-1e-12,p['predictedSuccess'])))+(1-y)*math.log(max(1e-12,1-p['predictedSuccess'])) for p,y in obs)/n,'ece':sum(b['count']/n*abs(b['predicted']-b['observed']) for b in bins if b['count']),'bins':bins,'conservativeBoundCoverage':sum(y>=(p['lowerBound'] or 0) for p,y in obs)/n,'positiveBoundRate':len(nonzero)/n,'positiveBoundCoverage':sum(y>=p['lowerBound'] for p,y in nonzero)/len(nonzero) if nonzero else None,'meanLowerBound':sum(p['lowerBound'] or 0 for p,y in obs)/n,'lowEvidenceRate':1-len(supported)/n,'interpretation':'Coverage compares individual held-out binary score against empirical residual bound; zero bounds are vacuous, not calibrated probability guarantees'}
    return table

def evaluate(predictions,truth:EvaluationGroundTruth):
    if type(truth) is not EvaluationGroundTruth:raise TypeError('Evaluator needs released ground truth')
    check_models(MODELS);rows=truth.rows;lookup={p['taskId']:p for p in predictions}
    if set(lookup)!={r.task.task_id for r in rows}:raise ValueError('Prediction/ground-truth mismatch')
    result={};pairs={}
    for dataset in ('overall',*DATASETS):
        subset=[r for r in rows if dataset=='overall' or r.task.dataset==dataset]
        if not subset:continue
        n=len(subset);policies=list(next(iter(lookup.values()))['selections'])+['Oracle POSTHOC']
        metrics={}
        for policy in policies:
            chosen=[];regret=[];solved=0;scores=[];cat=0;winner=0;top2=0;cost=[];dist=Counter();unavailable=0
            for r in subset:
                p=lookup[r.task.task_id];best=max(o.score for o in r.outcomes.values())
                model=sorted(MODELS,key=lambda m:(-r.outcomes[m].score,m))[0] if policy=='Oracle POSTHOC' else p['selections'][policy]
                if model is None:unavailable+=1;continue
                if model not in MODELS:raise ValueError('Unexpected routing candidate')
                o=r.outcomes[model];dist[model]+=1;solved+=o.success;scores.append(o.score);regret.append(best-o.score);cat+=not o.success and any(v.success for m,v in r.outcomes.items() if m!=model);winner+=o.score==best;top2+=any(r.outcomes[m].score==best for m in p['ranking'][:2]);chosen.append(model)
                if o.cost_usd is not None:cost.append(o.cost_usd)
            allcost=len(cost)==n;count=len(chosen)
            metrics[policy]={'attemptedTasks':n,'selectedTasks':count,'unavailable':unavailable,'resolvedTasks':solved,'resolvedRate':solved/n,'meanSelectedScore':sum(scores)/count if count else None,'meanRegret':sum(regret)/count if count else None,'p50Regret':quantile(regret,.5),'p90Regret':quantile(regret,.9),'p95Regret':quantile(regret,.95),'catastrophicMissRate':cat/count if count else None,'top1WinnerAccuracy':winner/count if count else None,'top2RankingWinnerRecall':top2/count if count else None,'selectedModelDistribution':dict(dist),'posthocCostCoverage':len(cost)/n,'costPerAttempt':sum(cost)/n if allcost else None,'costPerResolved':sum(cost)/solved if allcost and solved else None}
        beststatic=sorted(MODELS,key=lambda m:(-metrics['Always '+m]['resolvedRate'],m))[0]
        best=metrics['Always '+beststatic];oracle=metrics['Oracle POSTHOC']['resolvedRate']
        for m in metrics.values():
            m['qualityDifferenceVsBestStatic']=m['resolvedRate']-best['resolvedRate'];m['routerToOracleGap']=oracle-m['resolvedRate']
            m['costDifferencePerResolvedVsBestStatic']=m['costPerResolved']-best['costPerResolved'] if m['costPerResolved'] is not None and best['costPerResolved'] is not None else None
        successes=[sum(o.success for o in r.outcomes.values()) for r in subset]
        result[dataset]={'headroom':{'tasks':n,'bestStaticPosthoc':beststatic,'bestStaticSolveRate':best['resolvedRate'],'oracleSolveRate':oracle,'oracleUplift':oracle-best['resolvedRate'],'allSixSuccess':successes.count(6)/n,'allSixFail':successes.count(0)/n,'mixedOutcomes':sum(0<s<6 for s in successes)/n},'policies':metrics,'calibration':calibration_metrics([lookup[r.task.task_id] for r in subset],subset)}
        pairs[dataset]={}
        for a in MODELS:
            pairs[dataset][a]={}
            for b in MODELS:
                both=ao=bo=neither=0
                for r in subset:
                    x,y=r.outcomes[a].success,r.outcomes[b].success
                    both+=x and y;ao+=x and not y;bo+=not x and y;neither+=not x and not y
                pairs[dataset][a][b]={'bothSucceed':both,'aOnly':ao,'bOnly':bo,'bothFail':neither,'disagreementRate':(ao+bo)/n}
    return result,pairs

def decision(metrics,criteria):
    # Fixed before opening sealed TEST. Do not optimize this label after observing it.
    groups=[metrics[d] for d in DATASETS if d in metrics]
    if not groups:return 'NO_USEFUL_SIGNAL'
    strong=all(g['policies']['Text retrieval']['qualityDifferenceVsBestStatic']>=criteria['strongSolveDelta'] and g['policies']['Text retrieval']['catastrophicMissRate']<=criteria['maxCatastrophicMiss'] and g['calibration']['overall']['ece']<=criteria['maxEce'] and g['calibration']['overall']['positiveBoundRate']>=criteria['minimumPositiveBounds'] and g['calibration']['overall']['positiveBoundCoverage'] is not None and g['calibration']['overall']['positiveBoundCoverage']>=criteria['minimumNonvacuousCoverage'] for g in groups)
    if strong:return 'STRONG_SIGNAL'
    overall=metrics['overall'];r=overall['policies']['Text retrieval']
    return 'PROMISING_BUT_NOT_READY' if r['qualityDifferenceVsBestStatic']>=criteria['promisingSolveDelta'] else 'NO_USEFUL_SIGNAL'

def report(metrics,pairs,label,notes):
    lines=['# Cold Start V2: public unseen-task research', '',notes,'',f'Decision: **{label}**. No claim of public→Koda harness transfer or unseen-model prediction.','', '## Routing headroom (posthoc evaluation only)', '', '| Benchmark | Tasks | Best static | Oracle | Oracle uplift | Mixed |','|---|---:|---:|---:|---:|---:|']
    for d,g in metrics.items():h=g['headroom'];lines.append(f"| {d} | {h['tasks']} | {h['bestStaticSolveRate']:.3%} | {h['oracleSolveRate']:.3%} | {h['oracleUplift']:.3%} | {h['mixedOutcomes']:.3%} |")
    fmt=lambda x:'N/A' if x is None else f'{x:.5f}'
    for d,g in metrics.items():
        lines+=['',f'## {d}: model and router comparison','','| Policy | Solve | Mean regret | p95 regret | Catastrophic miss | Cost/solve |','|---|---:|---:|---:|---:|---:|']
        for name,m in g['policies'].items():lines.append('| '+name+' | '+' | '.join(fmt(m[k]) for k in ['resolvedRate','meanRegret','p95Regret','catastrophicMissRate','costPerResolved'])+' |')
        lines+=['',f'### {d}: calibration','','| Model | Brier | Log loss | ECE | Bound coverage | Positive-bound rate | Positive-bound coverage | LOW_EVIDENCE |','|---|---:|---:|---:|---:|---:|---:|---:|']
        for m,v in g['calibration'].items():lines.append('| '+m+' | '+' | '.join(fmt(v[k]) for k in ['brier','logLoss','ece','conservativeBoundCoverage','positiveBoundRate','positiveBoundCoverage','lowEvidenceRate'])+' |')
        lines+=['','Bound coverage can be vacuous when all lower bounds are zero. Positive-bound coverage is reported separately. These empirical residual envelopes are NOT guaranteed confidence intervals for model success probability.','',f'### {d}: complementarity','','| A | B | Both pass | A only | B only | Both fail | Disagreement |','|---|---|---:|---:|---:|---:|---:|']
        for i,a in enumerate(MODELS):
            for b in MODELS[i+1:]:
                v=pairs[d][a][b];lines.append(f"| {a} | {b} | {v['bothSucceed']} | {v['aOnly']} | {v['bOnly']} | {v['bothFail']} | {v['disagreementRate']:.3%} |")
    return '\n'.join(lines)+'\n'

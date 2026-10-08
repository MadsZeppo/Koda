"""Isolated paired harmful-downgrade research. No providers or production imports."""
import sys,json,math,hashlib,time
from pathlib import Path
from dataclasses import asdict
import numpy as np
from scipy.stats import norm
from scipy.optimize import milp,Bounds,LinearConstraint
from scipy.sparse import kron,eye,vstack,csr_matrix
from sklearn.model_selection import GroupKFold
V4=Path(__file__).resolve().parents[1]
V3=V4.parent/'cold-start-v3'
sys.path.insert(0,str(V3/'src'))
from source import load_plan,routing_input,semantic_hash
from features import TaskFeatureExtractor
from models import BinaryPredictor
from calibration import Calibrator,logit
from v2bridge import MODELS,TrainingEvidence,ValidationEvidence,SealedEvaluation,load_v2,digest,encoded
PROTOCOL={'version':'v4-harmful-downgrade-1','gaps':[0.0,.01,.02,.03], 'Cs':[.1,1.,10.], 'modes':['structured','text','combined'], 'folds':5,'confidence':.95,'riskBins':[0,.05,.15,1.000001], 'minBucketSupport':20,'selection':'minimum grouped TRAIN OOF paired-risk Brier; no winner-accuracy objective','calibration':'sigmoid on grouped TRAIN OOF risks; independent VALIDATION fixed-bin one-sided Wilson risk upper; sparse/unsupported bins reject','cost':'SWE TRAIN mean per model; actual task receipts only in independent scoring/oracles','scope':'offline public outcomes, not Koda verified success','paidCalls':0,'productionIntegration':False}

def save(path,data):
    with Path(path).open('x') as f:f.write(encoded(data)+'\n')
def matrices(rows):
    y=np.array([[int(r.outcomes[m].success) for m in MODELS] for r in rows]);c=np.array([[r.outcomes[m].cost_usd for m in MODELS] for r in rows],dtype=float)
    if not np.isfinite(c).all() or (c<0).any():raise ValueError('Complete finite nonnegative receipts required')
    return y,c

def reference(train):
    if type(train) is not TrainingEvidence:raise TypeError('Reference requires TRAIN only')
    y,c=matrices(train.rows);f=sorted(range(6),key=lambda j:(-y[:,j].mean(),c[:,j].mean(),MODELS[j]))[0];costs=c.mean(axis=0)
    return f,costs,[j for j in range(6) if costs[j]<costs[f]]
def harmful(y,f):return ((y==0)&(y[:,f,None]==1)).astype(int)
def upper(k,n,confidence=.95):
    if n<=0:return 1.
    z=float(norm.ppf(confidence));p=k/n
    return min(1.,(p+z*z/(2*n)+z*math.sqrt(p*(1-p)/n+z*z/(4*n*n)))/(1+z*z/n))
def choose(risks,costs,frontier,gap):
    a=np.asarray(risks,dtype=float)
    if a.ndim!=2 or a.shape[1]!=6 or not np.isfinite(a).all():raise ValueError('Six finite risk columns required')
    if not 0<=gap<=1:raise ValueError('Invalid regret')
    return np.array([min([frontier]+[j for j in range(6) if costs[j]<costs[frontier] and row[j]<=gap],key=lambda j:(costs[j],MODELS[j])) for row in a])

def score(y,c,index,frontier,rescue=False):
    n=len(y);ids=np.arange(n);selected=y[ids,index];harm=(y[:,frontier]==1)&(selected==0);total=c[ids,index].copy()
    if rescue:
        retry=(selected==0)&(index!=frontier);total+=retry*c[:,frontier];selected=np.maximum(selected,retry*y[:,frontier])
    solved=int(selected.sum());base=float(c[:,frontier].sum()/y[:,frontier].sum()) if y[:,frontier].sum() else None;cost=float(total.sum()/solved) if solved else None
    return {'tasks':n,'solved':solved,'solveRate':float(selected.mean()),'frontierRetained':float(selected.sum()/y[:,frontier].sum()) if y[:,frontier].sum() else None,'costPerSolved':cost,'costSaving':1-cost/base if base and cost is not None else None,'totalCost':float(total.sum()),'harmfulDowngrade':float(harm.mean()),'finalHarmfulDowngrade':float(((y[:,frontier]==1)&(selected==0)).mean()),'routedAway':float((index!=frontier).mean()),'models':{m:int((index==j).sum()) for j,m in enumerate(MODELS)},'cascade':'perfect benchmark-failure detection, no verifier cost; NOT deployable guarantee' if rescue else None}

def oracle(y,c,frontier,gap=0):
    # Fractional optimization: minimize actual cost/solved, with net regret AND harmful-loss caps.
    n=len(y);h=harmful(y,frontier);target=int(math.ceil(y[:,frontier].sum()-gap*n-1e-9));cap=int(math.floor(gap*n+1e-9))
    a=vstack([kron(eye(n),np.ones((1,6))),csr_matrix(y.reshape(1,-1)),csr_matrix(h.reshape(1,-1))],format='csc')
    constraint=LinearConstraint(a,np.r_[np.ones(n),target,-np.inf],np.r_[np.ones(n),np.inf,cap]);ratio=float(c[:,frontier].sum()/max(1,y[:,frontier].sum()));idx=None
    for _ in range(30):
        res=milp((c-ratio*y).reshape(-1),integrality=np.ones(c.size),bounds=Bounds(0,1),constraints=constraint,options={'time_limit':60})
        if not res.success:raise ValueError('Oracle optimizer did not prove optimality: '+res.message)
        idx=res.x.reshape(n,6).argmax(axis=1);s=y[np.arange(n),idx].sum();total=c[np.arange(n),idx].sum()
        if s==0:raise ValueError('No oracle solves')
        new=float(total/s)
        if abs(new-ratio)<1e-10:break
        ratio=new
    else:raise ValueError('Fractional oracle did not converge')
    return idx,score(y,c,idx,frontier)
def feasibility(rows,f,costs):
    y,c=matrices(rows);fixed=np.full(len(y),f);successful=np.where(y,c,np.inf).argmin(axis=1);successful=np.where(y.max(axis=1),successful,c.argmin(axis=1))
    out={'frontier':MODELS[f],'referenceChosenFrom':'SWE TRAIN only','Frontier':score(y,c,fixed,f),'Cheapest successful oracle':score(y,c,successful,f),'points':{}}
    for gap in PROTOCOL['gaps']:
        _,optimal=oracle(y,c,f,gap);eligible=[j for j in range(6) if y[:,j].mean()>=y[:,f].mean()-gap-1e-10];j=min(eligible,key=lambda j:(costs[j],MODELS[j]));out['points'][str(gap)]={'fractionalOracle':optimal,'cheapestQualityEligibleStatic':MODELS[j],'static':score(y,c,np.full(len(y),j),f)}
    out['disclosure']='Full-corpus hindsight diagnostic computed before training. Actual outcomes/costs inaccessible to router; corpus and V3 holdout previously observed. Not a pristine prospective test.'
    return out

class RiskPredictor:
    def __init__(self,train,metadata):
        if type(train) is not TrainingEvidence:raise TypeError('Risk fitting requires TRAIN')
        self.frontier,self.costs,self.candidates=reference(train);self.inputs=[routing_input(r.task,metadata.get(r.task.task_id,{})) for r in train.rows];y,_=matrices(train.rows);self.targets=harmful(y,self.frontier);groups=[semantic_hash(t.text) for t in self.inputs]
        folds=list(GroupKFold(n_splits=5).split(self.inputs,groups=groups));search=[];oof_cache={}
        for mode in PROTOCOL['modes']:
            features=[]
            for tr,te in folds:
                fit=TaskFeatureExtractor(mode).fit([self.inputs[i] for i in tr]);features.append((tr,te,fit.transform([self.inputs[i] for i in tr]),fit.transform([self.inputs[i] for i in te])))
            for C in PROTOCOL['Cs']:
                oof=np.zeros_like(self.targets,dtype=float)
                for tr,te,x,xt in features:
                    for j in self.candidates:oof[te,j]=BinaryPredictor(C).fit(x,self.targets[tr,j]).predict(xt)
                error=float(np.mean((oof[:,self.candidates]-self.targets[:,self.candidates])**2)) if self.candidates else 0.
                search.append({'mode':mode,'C':C,'brier':error});oof_cache[(mode,C)]=oof.copy()
        self.search=sorted(search,key=lambda s:(s['brier'],s['C'],s['mode']));self.config=self.search[0];self.oof=oof_cache[(self.config['mode'],self.config['C'])];self.features=TaskFeatureExtractor(self.config['mode']).fit(self.inputs);x=self.features.transform(self.inputs);self.classifiers={j:BinaryPredictor(self.config['C']).fit(x,self.targets[:,j]) for j in self.candidates};self.folds=[{'train':[int(i) for i in tr],'test':[int(i) for i in te]} for tr,te in folds]
    def predict(self,tasks):
        x=self.features.transform(tasks);p=np.ones((len(tasks),6));p[:,self.frontier]=0
        for j,clf in self.classifiers.items():p[:,j]=clf.predict(x)
        return p

class RiskCalibration:
    def __init__(self,model,val,metadata):
        if type(val) is not ValidationEvidence:raise TypeError('Risk calibration requires VALIDATION')
        inputs=[routing_input(r.task,metadata.get(r.task.task_id,{})) for r in val.rows];p=model.predict(inputs);y,_=matrices(val.rows);h=harmful(y,model.frontier);self.frontier=model.frontier;self.calibrators={};self.buckets={};self.validation={}
        for j in model.candidates:
            cal=Calibrator('sigmoid').fit(model.oof[:,j],model.targets[:,j]);values=cal.transform(p[:,j]);self.calibrators[j]=cal;bins=np.digitize(values,PROTOCOL['riskBins'][1:-1]);self.buckets[j]={}
            for b in range(len(PROTOCOL['riskBins'])-1):
                mask=bins==b;n=int(mask.sum());k=int(h[mask,j].sum());self.buckets[j][b]={'count':n,'harmful':k,'upper':upper(k,n),'eligibleSupport':n>=PROTOCOL['minBucketSupport']}
            self.validation[MODELS[j]]={'rawBrier':float(np.mean((p[:,j]-h[:,j])**2)),'independentCalibrationBrier':float(np.mean((values-h[:,j])**2)),'harmfulRate':float(h[:,j].mean()),'buckets':self.buckets[j]}
        self.disclosure='TRAIN-OOF-calibrated fixed-bin one-sided 95% Wilson bound for independent VAL-bin mean risk; not a per-task guarantee, not simultaneous across candidates.'
    def predict(self,p):
        calibrated=np.ones_like(p);bounds=np.ones_like(p);bounds[:,self.frontier]=0;calibrated[:,self.frontier]=0
        for j,cal in self.calibrators.items():
            values=cal.transform(p[:,j]);calibrated[:,j]=values;bins=np.digitize(values,PROTOCOL['riskBins'][1:-1]);bounds[:,j]=[self.buckets[j][int(b)]['upper'] if self.buckets[j][int(b)]['eligibleSupport'] else 1. for b in bins]
        return calibrated,bounds

def swe(evidence):
    rows=tuple(r for r in evidence.rows if r.task.dataset=='swe-bench')
    return type(evidence)(rows)
def run(destination):
    started=time.monotonic();out=Path(destination);out.mkdir(parents=True,exist_ok=False);save(out/'protocol.json',PROTOCOL)
    plan,train,val,holdout=load_plan(V3/'artifacts/data-plan/data-plan.json');train=swe(train);val=swe(val)
    rows,_,_=load_v2(plan['v2DataDirectory']);f,costs,candidates=reference(train)
    # Deliberate pre-fit feasibility audit; never used to tune predictors/thresholds.
    audit=feasibility([r for r in rows if r.task.dataset=='swe-bench'],f,costs);save(out/'feasibility.json',audit);print('FEASIBILITY',MODELS[f],audit['points']['0.0']['fractionalOracle']['costSaving'],flush=True)
    model=RiskPredictor(train,plan['metadata']);cal=RiskCalibration(model,val,plan['metadata'])
    code=digest({p.name:digest(p.read_bytes()) for p in sorted((V4/'src').glob('*.py'))});frozen={'protocol':PROTOCOL,'frontier':MODELS[f],'expectedCostsTRAIN':dict(zip(MODELS,map(float,costs))),'cheaperCandidates':[MODELS[j] for j in candidates],'config':model.config,'search':model.search,'calibration':cal.validation,'dataPlan':plan['fingerprint'],'implementation':code,'trainTaskIds':[r.task.task_id for r in train.rows],'validationTaskIds':[r.task.task_id for r in val.rows]};save(out/'frozen.json',frozen)
    import joblib,copyreg
    from types import MappingProxyType
    copyreg.pickle(type(MappingProxyType({})),lambda value:(dict,(dict(value),)))
    joblib.dump({'model':model,'calibration':cal},out/'models.joblib',compress=3)
    tasks=list(holdout.tasks);inputs=[routing_input(t,plan['metadata'].get(t.task_id,{})) for t in tasks];p,b=cal.predict(model.predict(inputs));decisions={str(g):choose(b,costs,f,g) for g in PROTOCOL['gaps']};save(out/'predictions.json',{'taskIds':[t.task_id for t in tasks],'risk':p.tolist(),'upperRisk':b.tolist(),'selected':{g:[MODELS[j] for j in idx] for g,idx in decisions.items()}})
    # Release hidden outcomes only after frozen decisions are persisted.
    records=[{'taskId':t.task_id,'selected':{g:MODELS[idx[i]] for g,idx in decisions.items()},'risk':p[i].tolist(),'upperRisk':b[i].tolist()} for i,t in enumerate(tasks)]
    artifact=out/'predictions.jsonl'
    with artifact.open('x') as file:
        for record in records:file.write(encoded(record)+'\n')
    truth=holdout.release(artifact,records);byid={r.task.task_id:r for r in truth.rows};mask=np.array([t.dataset=='swe-bench' for t in tasks]);tasks=[t for t in tasks if t.dataset=='swe-bench'];p=p[mask];b=b[mask];decisions={g:idx[mask] for g,idx in decisions.items()};testrows=[byid[t.task_id] for t in tasks];y,c=matrices(testrows);results={'Frontier':score(y,c,np.full(len(y),f),f),'Cheapest always':score(y,c,np.full(len(y),int(costs.argmin())),f)}
    v3rows=[json.loads(line) for line in (V3/'artifacts/final-holdout/predictions.jsonl').read_text().splitlines()];v3map={r['taskId']:r['methods']['Selected V3']['selected'] for r in v3rows};results['V3']=score(y,c,np.array([MODELS.index(v3map[t.task_id]) for t in tasks]),f)
    for gap,idx in decisions.items():results['V4 '+gap]=score(y,c,idx,f);results['V4 '+gap+' + rescue']=score(y,c,idx,f,True)
    successes=np.where(y,c,np.inf).argmin(axis=1);successes=np.where(y.max(axis=1),successes,c.argmin(axis=1));results['Cheapest-successful oracle']=score(y,c,successes,f);results['Oracle points']={str(g):oracle(y,c,f,g)[1] for g in PROTOCOL['gaps']}
    h=harmful(y,f);results['riskDiagnostics']={MODELS[j]:{'brier':float(np.mean((p[:,j]-h[:,j])**2)),'predictedRisk':float(p[:,j].mean()),'actualHarmfulRisk':float(h[:,j].mean()),'minUpper':float(b[:,j].min()),'medianUpper':float(np.median(b[:,j]))} for j in candidates};results['elapsedSeconds']=time.monotonic()-started;save(out/'results.json',results);print(json.dumps(results,indent=2),flush=True)
    return out
if __name__=='__main__':
    import argparse
    ap=argparse.ArgumentParser();ap.add_argument('--output',required=True);args=ap.parse_args();run(args.output)

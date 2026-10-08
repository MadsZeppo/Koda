"""Validation-only cross-fitted calibrator selection, frozen residual/support rules."""
import numpy as np
from sklearn.isotonic import IsotonicRegression
from sklearn.model_selection import KFold
from sklearn.metrics.pairwise import cosine_similarity
from models import BinaryPredictor
from v2bridge import *
from features import structured

def logit(p):p=np.clip(p,1e-6,1-1e-6);return np.log(p/(1-p)).reshape(-1,1)
class Calibrator:
    def __init__(self,kind='none'):self.kind=kind
    def fit(self,p,y):
        self.constant=None;self.model=None
        if self.kind=='none':return self
        if self.kind=='sigmoid':self.model=BinaryPredictor(1.).fit(logit(p),y)
        elif self.kind=='isotonic':self.model=IsotonicRegression(out_of_bounds='clip',y_min=.001,y_max=.999).fit(p,y)
        else:raise ValueError('Unknown calibration method')
        return self
    def transform(self,p):
        if self.kind=='none':return np.asarray(p)
        return self.model.predict(logit(p)) if self.kind=='sigmoid' else self.model.predict(p)
    def export(self):
        if self.kind=='none':return {'kind':'none'}
        return {'kind':'sigmoid',**self.model.parameters()} if self.kind=='sigmoid' else {'kind':'isotonic','x':self.model.X_thresholds_.tolist(),'y':self.model.y_thresholds_.tolist()}

def calibrate(p,y,evidence):
    if type(evidence) is not ValidationEvidence:raise TypeError('Calibration requires validation, never holdout')
    if len(p)!=len(evidence.rows) or y.shape!=p.shape:raise ValueError('Calibration alignment mismatch')
    calibrators=[];oof=np.zeros_like(p);search=[]
    gate=np.array([r.task.dataset=='swe-bench' for r in evidence.rows])
    if not gate.any():gate=np.ones(len(p),dtype=bool)
    folds=list(KFold(n_splits=min(5,len(p)),shuffle=True,random_state=20261007).split(p)) if len(p)>=3 else []
    for j,model in enumerate(MODELS):
        options=['none','sigmoid']+(['isotonic'] if int(gate.sum())>=200 and min(y[gate,j].sum(),int(gate.sum())-y[gate,j].sum())>=30 else [])
        scored=[]
        for kind in options:
            values=p[:,j].copy()
            for train,test in folds:values[test]=Calibrator(kind).fit(p[train,j],y[train,j]).transform(p[test,j])
            scored.append({'kind':kind,'brier':float(np.mean((values[gate]-y[gate,j])**2)),'oof':values})
        scored.sort(key=lambda r:(r['brier'],['none','sigmoid','isotonic'].index(r['kind'])))
        chosen=scored[0];oof[:,j]=chosen['oof'];calibrators.append(Calibrator(chosen['kind']).fit(p[:,j],y[:,j]));search.append({'model':model,'selected':chosen['kind'],'selectionGate':'SWE if present; otherwise source-only','crossFittedValidation':[{'kind':s['kind'],'brier':s['brier']} for s in scored]})
    return calibrators,oof,search

def apply(calibrators,p):return np.column_stack([c.transform(p[:,j]) for j,c in enumerate(calibrators)])

class EvidenceSupportEstimator:
    def __init__(self,predictor,validation_inputs,validation_p,validation_y,evidence):
        if type(evidence) is not ValidationEvidence:raise TypeError('Support freeze requires VALIDATION')
        self.predictor=predictor;self.train=predictor.x
        self.train_struct=predictor.features.profiles(predictor.inputs)
        self.thresholds={};self.buckets={};self.fallback={}
        sim=self.similarities(validation_inputs)
        self.thresholds['similarity']=float(np.quantile(sim,.1)) if len(sim) else 1.
        # Rule and coverage operating points fixed on validation support only, never heldout quality.
        self.thresholds['coverageCuts']={str(c):float(np.quantile(sim,1-c)) for c in (1.,.9,.75,.5)}
        for j,model in enumerate(MODELS):
            groups={}
            residual=np.maximum(0,validation_p[:,j]-validation_y[:,j]);self.fallback[model]={'count':len(residual),'quantile':float(np.quantile(residual,.9,method='higher')) if len(residual) else 1.}
            for i,p in enumerate(validation_p[:,j]):groups.setdefault(self.bucket(p,sim[i]),[]).append(float(residual[i]))
            self.buckets[model]={k:{'count':len(v),'quantile':float(np.quantile(v,.9,method='higher'))} for k,v in groups.items()}
    def similarities(self,tasks):
        # Feature distance uses TRAIN-only fitted representation; no outcome data.
        if not tasks:return np.array([])
        similarities=cosine_similarity(self.predictor.features.transform(tasks),self.train)
        return similarities.max(axis=1)
    def bucket(self,p,sim):return f'p{min(3,int(p*4))}:s{int(sim>=.5)}'
    def predict(self,tasks,p):
        sim=self.similarities(tasks);low=[];bounds=np.zeros_like(p)
        for i,task in enumerate(tasks):
            flagged=bool(sim[i]<self.thresholds['similarity'])
            f=structured(task);unseen=[k for k,v in f.items() if k.startswith(('language:','ecosystem:')) and v and not any(t.get(k,0)>0 for t in self.train_struct)]
            flagged=flagged or bool(unseen)
            for j,m in enumerate(MODELS):
                entry=self.buckets[m].get(self.bucket(p[i,j],sim[i]))
                if entry is None or entry['count']<20:flagged=True;entry=self.fallback[m]
                bounds[i,j]=max(0,float(p[i,j])-entry['quantile']) if entry['count']>=20 else 0
            low.append(flagged)
        return sim,np.array(low,dtype=bool),bounds
    def export(self):return {'fitPartition':'validation','thresholds':self.thresholds,'buckets':self.buckets,'globalFallbacks':self.fallback,'unsupportedBucketPolicy':'LOW_EVIDENCE, global residual fallback; <20 global samples → zero','boundInterpretation':'Empirical individual-score residual envelope, not confidence interval for latent probability'}

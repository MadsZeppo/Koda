"""Six regularized success classifiers and 15 discordance-only pair classifiers."""
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import HistGradientBoostingClassifier
from dataclasses import dataclass
from itertools import combinations
from v2bridge import *
from source import routing_input,TaskInput
from features import TaskFeatureExtractor

@dataclass(frozen=True)
class ModelConfig:
    mode:str='combined';C:float=1.;repo_identity:bool=False;kind:str='logistic'
class BinaryPredictor:
    def __init__(self,C=1.,kind='logistic'):self.C=C;self.kind=kind
    def fit(self,x,y):
        y=np.asarray(y,dtype=int);self.count=len(y);self.constant=None;self.model=None
        if len(y)==0:self.constant=.5
        elif len(set(y.tolist()))<2:self.constant=float((y.sum()+1)/(len(y)+2))
        else:
            if self.kind=='tree':
                self.model=HistGradientBoostingClassifier(l2_regularization=1/self.C,max_iter=100,max_depth=3,min_samples_leaf=20,random_state=0);self.model.fit(x.toarray(),y)
            else:self.model=LogisticRegression(C=self.C,solver='liblinear',random_state=0,max_iter=2000,tol=1e-7);self.model.fit(x,y)
        return self
    def predict(self,x):return np.full(x.shape[0],self.constant) if self.constant is not None else self.model.predict_proba(x.toarray() if self.kind=='tree' else x)[:,1]
    def parameters(self):
        if self.kind=='tree':return {'kind':'tree','count':self.count,'constant':self.constant,'params':self.model.get_params() if self.model is not None else None}
        return {'C':self.C,'count':self.count,'constant':self.constant,'coef':self.model.coef_[0].tolist() if self.model is not None else None,'intercept':float(self.model.intercept_[0]) if self.model is not None else None}

def labels(evidence):
    if type(evidence) is not TrainingEvidence:raise TypeError('TrainingEvidence only')
    check_models(MODELS)
    return np.array([[int(r.outcomes[m].success) for m in MODELS] for r in evidence.rows],dtype=int)

def pair_labels(y,a,b):
    mask=y[:,a]!=y[:,b]
    return mask,y[mask,a]

class ModelSuccessPredictor:
    def __init__(self,evidence,metadata,config=ModelConfig(),*,feature_cache=None):
        self.y=labels(evidence);self.config=config;self.train_rows=evidence.rows;self.metadata=metadata
        self.inputs=[routing_input(r.task,metadata.get(r.task.task_id,{})) for r in evidence.rows]
        if feature_cache is None:
            self.features=TaskFeatureExtractor(config.mode,config.repo_identity).fit(self.inputs);self.x=self.features.transform(self.inputs)
        else:
            old_inputs,self.features,self.x=feature_cache
            if old_inputs!=self.inputs or self.features.mode!=config.mode or self.features.repo_identity!=config.repo_identity:raise ValueError('Feature cache does not match TRAIN inputs/schema')
        self.classifiers=[BinaryPredictor(config.C,config.kind).fit(self.x,self.y[:,j]) for j in range(6)]
        self.priors={m:float(self.y[:,j].mean()) for j,m in enumerate(MODELS)}
        self.expected_costs={m:sum(r.outcomes[m].cost_usd for r in evidence.rows)/len(evidence.rows) if all(r.outcomes[m].cost_usd is not None for r in evidence.rows) else None for m in MODELS}
        self.dataset_priors={d:{m:sum(r.outcomes[m].success for r in evidence.rows if r.task.dataset==d)/sum(r.task.dataset==d for r in evidence.rows) for m in MODELS} for d in DATASETS if any(r.task.dataset==d for r in evidence.rows)}
    def predict(self,tasks):
        if any(type(t) is not TaskInput for t in tasks):raise TypeError('Routing inputs only')
        x=self.features.transform(tasks);return np.column_stack([c.predict(x) for c in self.classifiers])
    def export(self):return {'config':self.config.__dict__,'features':self.features.summary(),'classifiers':{m:c.parameters() for m,c in zip(MODELS,self.classifiers)},'priors':self.priors,'expectedCostsTrain':self.expected_costs}

class PairwiseModelPredictor:
    def __init__(self,predictor:ModelSuccessPredictor):
        self.base=predictor;self.classifiers={};self.support={}
        for a,b in combinations(range(6),2):
            mask,target=pair_labels(predictor.y,a,b);self.classifiers[(a,b)]=BinaryPredictor(predictor.config.C).fit(predictor.x[mask],target);self.support[f'{MODELS[a]}|{MODELS[b]}']=int(mask.sum())
    def predict(self,tasks):
        x=self.base.features.transform(tasks);scores=np.zeros((len(tasks),6));pair_prob={}
        for (a,b),classifier in self.classifiers.items():
            p=classifier.predict(x);scores[:,a]+=p;scores[:,b]+=1-p;pair_prob[f'{MODELS[a]}|{MODELS[b]}']=p.tolist()
        # Scores rank by expected pairwise wins. They are NOT absolute success probabilities.
        return scores/5,pair_prob
    def export(self):return {'labelPolicy':'TRAIN discordant pairs only; equal outcomes discarded, empty support → .5; single class → Laplace constant','aggregation':'sum win probabilities / 5; ranking score, not P(success)','support':self.support,'classifiers':{f'{MODELS[a]}|{MODELS[b]}':c.parameters() for (a,b),c in self.classifiers.items()}}

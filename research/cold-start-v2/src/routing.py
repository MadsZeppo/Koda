"""Train-only TF-IDF retrieval, shrinkage, frozen validation calibration."""
from __future__ import annotations
import re, math, itertools
from collections import Counter, defaultdict
from dataclasses import dataclass, asdict
from core import *

def split_rows(rows,seed=42):
    by_query=defaultdict(list)
    for r in rows:by_query[r.task.query_hash].append(r)
    strata=defaultdict(list)
    for q,group in by_query.items():strata[tuple(sorted({r.task.dataset for r in group}))].append(q)
    assignment={}
    for datasets,queries in sorted(strata.items()):
        queries.sort(key=lambda q:digest([seed,q]))
        n=len(queries);train=max(1,int(.70*n));validation=max(1,int(.15*n)) if n>=3 else 0
        for i,q in enumerate(queries):assignment[q]='train' if i<train else 'validation' if i<train+validation else 'test'
    parts={k:tuple(sorted((r for r in rows if assignment[r.task.query_hash]==k),key=lambda r:r.task.task_id)) for k in ('train','validation','test')}
    if any(not p for p in parts.values()):raise ValueError('Insufficient groups for TRAIN/VALIDATION/SEALED TEST')
    manifest={'seed':seed,'proportions':[.70,.15,.15],'policy':'normalized-query grouping globally; deterministic benchmark-stratified hash rank','parts':{k:[r.task.task_id for r in v] for k,v in parts.items()},'queryGroups':assignment,'benchmarkCounts':{k:dict(Counter(r.task.dataset for r in v)) for k,v in parts.items()}}
    return TrainingEvidence(parts['train']),ValidationEvidence(parts['validation']),SealedEvaluation(parts['test']),manifest

@dataclass(frozen=True)
class Config:
    feature:str='word';minimum_n:int=1;maximum_n:int=2;k:int=15;minimum_similarity:float=.05
    weight_power:float=1.;prior_strength:float=5.;maximum_features:int=12000;minimum_df:int=2
    low_similarity:float=.05;low_mass:float=.5;minimum_calibration:int=20

class TaskFeaturizer:
    def __init__(self,queries,config):
        self.config=config;df=Counter()
        for q in queries:df.update(set(self.terms(q)))
        terms=sorted((t for t,n in df.items() if n>=config.minimum_df),key=lambda t:(-df[t],t))[:config.maximum_features]
        self.idf={t:math.log((1+len(queries))/(1+df[t]))+1 for t in terms}
    def terms(self,text):
        text=normalize(text).lower()
        # Preserve identifiers, numbers, and error/code punctuation as tokens.
        tokens=re.findall(r'[\w]+|::|->|==|!=|[{}()\[\].:+=*/-]',text,re.UNICODE)
        if self.config.feature=='word':
            return ['w:'+ ' '.join(tokens[i:i+n]) for n in range(self.config.minimum_n,self.config.maximum_n+1) for i in range(len(tokens)-n+1)]
        if self.config.feature=='char':
            return ['c:'+text[i:i+n] for n in range(self.config.minimum_n,self.config.maximum_n+1) for i in range(len(text)-n+1)]
        raise ValueError('Unsupported feature type')
    def transform(self,text):
        counts=Counter(t for t in self.terms(text) if t in self.idf)
        vec={t:(1+math.log(n))*self.idf[t] for t,n in counts.items()}
        length=math.sqrt(sum(v*v for v in vec.values()))
        return {t:v/length for t,v in sorted(vec.items())} if length else {}

class TaskSimilarityIndex:
    def __init__(self,queries,featurizer):
        self.featurizer=featurizer;self.queries=queries;self.postings=defaultdict(list);self.cache={}
        self.normalized=[normalize(q) for q in queries];self.query_hashes=[digest(q) for q in self.normalized]
        for i,q in enumerate(queries):
            for term,value in featurizer.transform(q).items():self.postings[term].append((i,value))
    def retrieve(self,query,k,minimum_similarity):
        key=normalize(query)
        if key not in self.cache:
            scores=defaultdict(float)
            for term,qv in self.featurizer.transform(query).items():
                for i,v in self.postings.get(term,()):scores[i]+=qv*v
            # Cache only text similarity. No labels, costs, test scores or task IDs.
            self.cache[key]=sorted(((i,min(1.,s)) for i,s in scores.items() if key!=self.normalized[i]),key=lambda x:(-x[1],self.query_hashes[x[0]]))
        return [(i,s) for i,s in self.cache[key] if s>=minimum_similarity][:k]

class ColdStartPredictor:
    def __init__(self,evidence:TrainingEvidence,config:Config,*,text_index=None):
        if type(evidence) is not TrainingEvidence:raise TypeError('fit requires TrainingEvidence, never validation/test/oracle')
        check_models(MODELS)
        if config.k<1 or config.prior_strength<=0 or config.weight_power<=0:raise ValueError('Invalid retrieval parameters')
        self.config=config;grouped=defaultdict(list)
        for row in evidence.rows:grouped[row.task.query_hash].append(row)
        self.groups=[grouped[q] for q in sorted(grouped)]
        self.queries=[g[0].task.origin_query for g in self.groups]
        self.local=[{m:sum(r.outcomes[m].score for r in g)/len(g) for m in MODELS} for g in self.groups]
        self.priors={m:sum(v[m] for v in self.local)/len(self.local) for m in MODELS}
        self.dataset_priors={d:{m:sum(r.outcomes[m].score for r in evidence.rows if r.task.dataset==d)/sum(r.task.dataset==d for r in evidence.rows) for m in MODELS} for d in DATASETS if any(r.task.dataset==d for r in evidence.rows)}
        self.expected_costs={m:sum(r.outcomes[m].cost_usd for r in evidence.rows)/len(evidence.rows) if all(r.outcomes[m].cost_usd is not None for r in evidence.rows) else None for m in MODELS}
        if text_index is None:
            self.featurizer=TaskFeaturizer(self.queries,config);self.index=TaskSimilarityIndex(self.queries,self.featurizer)
        else:
            self.featurizer,self.index=text_index
            fields=('feature','minimum_n','maximum_n','maximum_features','minimum_df')
            if self.index.queries!=self.queries or any(getattr(self.featurizer.config,k)!=getattr(config,k) for k in fields):raise ValueError('Text cache does not match TRAIN corpus/features')
    def predict(self,task:RoutingTask,calibration=None):
        if type(task) is not RoutingTask:raise TypeError('predict requires preexecution RoutingTask text only')
        neighbors=self.index.retrieve(task.origin_query,self.config.k,self.config.minimum_similarity)
        mass=sum(s**self.config.weight_power for _,s in neighbors);nearest=neighbors[0][1] if neighbors else 0
        predictions=[]
        for model in MODELS:
            weighted=sum(s**self.config.weight_power*self.local[i][model] for i,s in neighbors)
            p=(self.config.prior_strength*self.priors[model]+weighted)/(self.config.prior_strength+mass)
            bucket=bucket_key(p,nearest,mass)
            low=nearest<self.config.low_similarity or mass<self.config.low_mass
            bound=None;calibration_source=None
            if calibration is not None:
                model_table=calibration['models'][model];entry=model_table['buckets'].get(bucket)
                if entry is None or entry['count']<self.config.minimum_calibration:entry=model_table['global'];calibration_source='model-global validation fallback';low=True
                else:calibration_source=bucket
                if entry['count']<self.config.minimum_calibration:low=True;bound=0
                else:bound=max(0.,p-entry['positiveResidualQuantile'])
            predictions.append({'modelId':model,'predictedSuccess':p,'neighborCount':len(neighbors),'effectiveNeighborWeight':mass,'nearestSimilarity':nearest,'globalPrior':self.priors[model],'localEstimate':weighted/mass if mass else None,'uncertaintyBucket':bucket,'lowerBound':bound,'status':'LOW_EVIDENCE' if low else 'SUPPORTED_PUBLIC_RETRIEVAL','evidenceSummary':{'source':'TRAIN public origin_query only','calibrationSource':calibration_source,'expectedCostTrainMean':self.expected_costs[model]}})
        predictions.sort(key=lambda p:(-p['predictedSuccess'],p['modelId']))
        return {'models':predictions,'ranking':[p['modelId'] for p in predictions],'status':'LOW_EVIDENCE' if any(p['status']=='LOW_EVIDENCE' for p in predictions) else 'SUPPORTED_PUBLIC_RETRIEVAL','neighbors':[{'queryHash':self.index.query_hashes[i],'similarity':s} for i,s in neighbors]}

def bucket_key(p,similarity,mass):return f'p{min(3,int(p*4))}:s{int(similarity>=.2)}:n{int(mass>=3)}'
def quantile(values,p):return sorted(values)[max(0,math.ceil(p*len(values))-1)] if values else None

def fit_calibration(predictor,evidence:ValidationEvidence):
    if type(evidence) is not ValidationEvidence:raise TypeError('Calibration requires VALIDATION only')
    residuals={m:defaultdict(list) for m in MODELS}
    for r in evidence.rows:
        pred=predictor.predict(RoutingTask(r.task.origin_query))
        for p in pred['models']:
            error=max(0.,p['predictedSuccess']-r.outcomes[p['modelId']].score)
            residuals[p['modelId']][p['uncertaintyBucket']].append(error)
    table={'description':'Empirical conservative lower bound for individual observed score: p minus validation 90th-percentile positive residual; NOT a confidence interval for latent success probability','quantile':.9,'fitPartition':'validation','models':{}}
    for m,buckets in residuals.items():
        entry=lambda values:{'count':len(values),'positiveResidualQuantile':quantile(values,.9)}
        table['models'][m]={'global':entry([v for values in buckets.values() for v in values]),'buckets':{k:entry(v) for k,v in sorted(buckets.items())}}
    return table

def search_configs():
    # Small predetermined grid covering each requested axis; no TEST tuning.
    configs=[]
    for feature,lo,hi in [('word',1,1),('word',1,2),('char',3,5)]:
        for k,prior,threshold,power in [(5,1.,.05,1.),(15,5.,.05,1.),(15,5.,.10,2.),(25,10.,.05,2.)]:configs.append(Config(feature,lo,hi,k,threshold,power,prior))
    return configs

def tune(train:TrainingEvidence,validation:ValidationEvidence):
    if type(train) is not TrainingEvidence or type(validation) is not ValidationEvidence:raise TypeError('TRAIN/VALIDATION required for tuning')
    results=[];text_cache={}
    for config in search_configs():
        key=(config.feature,config.minimum_n,config.maximum_n,config.maximum_features,config.minimum_df)
        router=ColdStartPredictor(train,config,text_index=text_cache.get(key));text_cache[key]=(router.featurizer,router.index);solved=0;regret=0.;brier=0.;low=0
        for r in validation.rows:
            p=router.predict(RoutingTask(r.task.origin_query));chosen=p['ranking'][0]
            solved+=r.outcomes[chosen].success;regret+=max(o.score for o in r.outcomes.values())-r.outcomes[chosen].score;low+=p['status']=='LOW_EVIDENCE'
            brier+=sum((q['predictedSuccess']-r.outcomes[q['modelId']].score)**2 for q in p['models'])/6
        print(f'VALIDATION grid {len(results)+1}/12: {config.feature} {config.minimum_n}-{config.maximum_n}, k={config.k}, prior={config.prior_strength}',flush=True)
        n=len(validation.rows);results.append({'config':asdict(config),'validationResolvedRate':solved/n,'validationMeanRegret':regret/n,'validationBrier':brier/n,'lowEvidenceRate':low/n})
    # Quality first; Brier tie-break, then simpler word features / config fingerprint.
    results.sort(key=lambda r:(-r['validationResolvedRate'],r['validationBrier'],r['config']['feature']!='word',digest(r['config'])))
    return Config(**results[0]['config']),results

def operating_points(pred,router,dataset=None):
    entries={p['modelId']:p for p in pred['models']};check_models(entries)
    maximum=pred['ranking'][0]
    conservative=sorted(MODELS,key=lambda m:(-(entries[m]['lowerBound'] or 0),-entries[m]['predictedSuccess'],m))[0]
    out={f'Always {m}':m for m in MODELS}
    out['Best static TRAIN']=sorted(MODELS,key=lambda m:(-router.priors[m],m))[0]
    out['Dataset-aware static ANALYSIS']=sorted(MODELS,key=lambda m:(-router.dataset_priors[dataset][m],m))[0] if dataset in router.dataset_priors else None
    out['Text retrieval']=maximum;out['Conservative text retrieval']=conservative
    if all(router.expected_costs[m] is not None for m in MODELS):
        for gap in (0.,.01,.025,.05):
            eligible=[m for m in MODELS if entries[m]['predictedSuccess']>=entries[maximum]['predictedSuccess']-gap and (entries[m]['lowerBound'] or 0)>=(entries[maximum]['lowerBound'] or 0)-gap]
            out[f'Cost-aware gap={gap}']=sorted(eligible,key=lambda m:(router.expected_costs[m],-entries[m]['predictedSuccess'],m))[0]
    else:
        for gap in (0.,.01,.025,.05):out[f'Cost-aware gap={gap}']=None
    return out

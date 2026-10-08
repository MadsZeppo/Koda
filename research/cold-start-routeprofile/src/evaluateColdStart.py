"""Leave-one-exact-model-out, task-grouped unseen-task evaluation. No paid calls."""
import json,math,hashlib,time
from collections import defaultdict
import numpy as np
from sklearn.metrics import roc_auc_score,brier_score_loss
from normalize import ROOT,load,features,digest
from buildProfiles import TaskSpace,Decoder,Profile,anchor_order,REGIMES,VARIANTS,SEED
ALLOWED_REGRET=.02

def calibration_error(y,p):
 bins=np.minimum((p*10).astype(int),9);return float(sum(np.sum(bins==b)/len(y)*abs(np.mean(y[bins==b])-np.mean(p[bins==b])) for b in range(10) if np.any(bins==b)))
def metrics(y,p):return {'n':len(y),'auroc':float(roc_auc_score(y,p)) if len(set(y))>1 else None,'brier':float(brier_score_loss(y,p)),'ece':calibration_error(y,p)}
def interval(p,n,transfer):
 radius=max(transfer,math.sqrt(math.log(40)/(2*n)) if n else 1)
 return np.maximum(0,p-radius),np.minimum(1,p+radius),radius

def evaluate(split_field='split'):
 rows=load()
 if split_field=='repo_split':rows=[{**r,'split':r['repo_split']} for r in rows]
 models=sorted({r['model'] for r in rows});results=[];predictions=[];folds=[];anchor_manifests=[]
 for heldout in models:
  # All candidate outcome history is excluded from encoder, decoder and calibration.
  training=[r for r in rows if r['model']!=heldout and r[split_field]=='train']
  validation=[r for r in rows if r['model']!=heldout and r[split_field]=='validation']
  tests=[r for r in rows if r[split_field]=='test'];target=[r for r in tests if r['model']==heldout]
  available=[r for r in rows if r['model']==heldout and r[split_field]=='train']
  # Profile class intentionally permits only training anchors for either grouping.
  if split_field!='split':available=[{**r,'split':r[split_field]} for r in available]
  if len(available)<32 or len(target)<30:continue
  space=TaskSpace(training);decoder=Decoder(training,space);ordered=anchor_order(available,space,decoder.base)
  family=heldout.split('-')[0];family_rows=[r for r in training if r['family']==family];family_prior=float(np.mean([r['labels']['resolved'] for r in family_rows])) if family_rows else decoder.prior
  manifests=[features(r) for r in ordered[:32]];anchor_manifests.append({'heldoutModel':heldout,'taskSpaceDigest':space.digest,'anchors':manifests,'split':split_field,'stratification':'task-neighborhood × other-model-predicted difficulty, labels not read','regimes':REGIMES})
  # Strict cross-harness task-specific calibration is not claimed: retain 95th
  # percentile public heldout residual as a conservative transfer floor.
  residuals={}
  for variant in VARIANTS:
   vp=np.array([decoder.predict(variant,decoder.profiles[r['model']],[r])[0] for r in validation]);vy=np.array([r['labels']['resolved'] for r in validation]);residuals[variant]=float(np.quantile(np.abs(vy-vp),.95,method='higher')) if len(vy) else 1
  fold={'heldout':heldout,'trainingModels':sorted({r['model'] for r in training}),'taskSpaceDigest':space.digest,'trainTasks':len(space.training_keys),'anchors':len(available),'test':len(target),'transferFloor':residuals,'split':split_field};folds.append(fold)
  for count in REGIMES:
   profile=Profile(heldout,ordered[:count],space,decoder.prior);y=np.array([r['labels']['resolved'] for r in target]);by_task=defaultdict(list)
   for r in tests:by_task[r['task_key']].append(r)
   for variant in VARIANTS+['constant_prior','family_average','static_train_rank','random']:
    if variant in VARIANTS:p=decoder.predict(variant,profile,target)
    elif variant=='family_average':p=np.full(len(target),family_prior)
    elif variant in ['constant_prior','static_train_rank']:p=np.full(len(target),decoder.prior)
    else:p=np.random.default_rng(SEED).random(len(target))
    lower,upper,radius=interval(p,count,residuals.get(variant,1));pairs=[];regrets=[];recall=[];harmful_raw=0;harmful_conservative=0;raw_safe=0;conservative_safe=0;paired_tasks=0;abstain=0
    for i,r in enumerate(target):
     group=by_task[r['task_key']]
     if len(group)<2:continue
     paired_tasks+=1;qs=[];ls=[];us=[];ys=[]
     for peer in group:
      if peer['model']==heldout:q=float(p[i]);l=float(lower[i]);u=float(upper[i])
      else:
       pp=decoder.profiles[peer['model']]
       q=float(decoder.predict(variant,pp,[peer])[0]) if variant in VARIANTS else (family_prior if variant=='family_average' else decoder.prior)
       larr,uarr,_=interval(np.array([q]),pp.n,residuals.get(variant,1));l=float(larr[0]);u=float(uarr[0])
       if peer['labels']['resolved']!=r['labels']['resolved']:pairs.append(float((q<float(p[i]))==(peer['labels']['resolved']<r['labels']['resolved'])) if q!=p[i] else .5)
      qs.append(q);ls.append(l);us.append(u);ys.append(peer['labels']['resolved'])
     best=max(ys);chosen=int(np.argmax(qs));regrets.append(best-ys[chosen]);recall.append(float(ys[chosen]==best))
     is_raw=p[i]>=max(qs)-ALLOWED_REGRET;is_safe=lower[i]>=max(us)-ALLOWED_REGRET
     raw_safe+=int(is_raw);conservative_safe+=int(is_safe);harmful_raw+=int(is_raw and y[i]<best);harmful_conservative+=int(is_safe and y[i]<best)
     abstain+=int(not any(l>=max(us)-ALLOWED_REGRET for l in ls))
    result={'heldout_model':heldout,'anchors':count,'variant':variant,'split':split_field,**metrics(y,p),'mean_uncertainty_radius':radius,'binary_predictive_coverage':float(np.mean((y>=lower)&(y<=upper))),
     'paired_tasks':paired_tasks,'pairwise_ranking_accuracy':float(np.mean(pairs)) if pairs else None,'discordant_pairs':len(pairs),'top_model_recall':float(np.mean(recall)) if recall else None,'observed_subset_oracle_regret':float(np.mean(regrets)) if regrets else None,
     'harmful_interchangeability_raw':harmful_raw/paired_tasks if paired_tasks else None,'harmful_interchangeability_conservative':harmful_conservative/paired_tasks if paired_tasks else None,'raw_interchangeability_rate':raw_safe/paired_tasks if paired_tasks else None,'conservative_interchangeability_rate':conservative_safe/paired_tasks if paired_tasks else None,
     'abstention_rate':abstain/paired_tasks if paired_tasks else None,'cheapest_safe_correct':None,'cost_opportunity':None,'cost_limitation':'no licensed per-task cost/token receipts; cannot identify cheapest models honestly'}
    results.append(result)
    if split_field=='split':
     for row,q,l,u in zip(target,p,lower,upper):predictions.append({'task_id':row['task_id'],'task_key':row['task_key'],'model':heldout,'anchors':count,'variant':variant,'prediction':float(q),'lower':float(l),'upper':float(u),'label':row['labels']['resolved']})
  (ROOT/'artifacts'/('space-'+heldout+'-'+split_field+'.json')).write_text(json.dumps(space.export(),sort_keys=True)+'\n')
  (ROOT/'artifacts'/('profile-'+heldout+'-'+split_field+'.json')).write_text(json.dumps(profile.export(),sort_keys=True)+'\n')
 return results,predictions,folds,anchor_manifests

def main():
 start=time.monotonic();protocol={'seed':SEED,'variants':VARIANTS,'regimes':REGIMES,'allowedRegret':ALLOWED_REGRET,'latentDimensions':24,'neighborhoods':8,'decoder':'L2 logistic C=1; disjoint profile/decoder task groups','transfer':'other-model validation residual .95 quantile; confidence anchors Hoeffding .95','selection':'LCB >= strongest UCB - existing .02 regret; no prices invented','kodaFinal100':'sealed; never read outcomes','hyperparameterTuning':False,'upstreamReproduction':False,'adaptation':'RouteProfile heterogeneous neighbourhood propagation and shared query-model edge decoder, local TFIDF/SVD instead of pretrained BERT/GPU HAN/GAT','paidCalls':0}
 (ROOT/'artifacts/protocol.json').write_text(json.dumps(protocol,indent=2)+'\n')
 results,predictions,folds,anchors=evaluate();repo_results,_,repo_folds,repo_anchors=evaluate('repo_split')
 # Acceptance gates cannot be passed without actual licensed cost evidence.
 result={'main':results,'repo_holdout':repo_results,'folds':folds+repo_folds,'runtimeSeconds':time.monotonic()-start,'frozen100':'NOT YET MEASURABLE WITHOUT CANDIDATE-MODEL CALIBRATION','recommendation':'ITERATE PUBLIC-DATA ROUTER','passed':False,'adapterBuilt':False,'paidCalls':0,'limitations':['Only four teacher versions; small paired heldout overlap','No task-level costs; economic acceptance D not measurable','Predictive intervals concern observed binary labels, not calibrated Koda success probability','No identifiable public-to-Koda transfer calibration','CPU graph adaptation is not full upstream HAN/GAT reproduction']}
 (ROOT/'artifacts/results.json').write_text(json.dumps(result,indent=2)+'\n');(ROOT/'artifacts/anchors.json').write_text(json.dumps(anchors+repo_anchors,indent=2)+'\n')
 with open(ROOT/'artifacts/predictions.jsonl','w') as f:
  for r in predictions:f.write(json.dumps(r,sort_keys=True)+'\n')
 print(json.dumps({'rows':len(results),'repoRows':len(repo_results),'runtimeSeconds':result['runtimeSeconds'],'recommendation':result['recommendation'],'paidCalls':0}))
if __name__=='__main__':main()

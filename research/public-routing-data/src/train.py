"""Simple regularized public fits; task-grouped validation precedes frozen audit."""
import json,math,sys
from collections import Counter,defaultdict
from pathlib import Path
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score,balanced_accuracy_score,brier_score_loss
sys.path.insert(0,str(Path(__file__).parent))
from normalize import ROOT,digest

def encode(task):
 v=np.zeros(288)
 for token in __import__('re').findall('[a-z0-9_]+',task['task_text'].lower()):
  h=2166136261
  for c in token:h=((h^ord(c))*16777619)&0xffffffff
  v[h%256]+=1
 v[:256]=np.log1p(v[:256]);v[:256]/=np.linalg.norm(v[:256]) or 1
 for i,lang in enumerate(['python','typescript','javascript','sql','go','rust']):v[282+i]=float(task['language'].lower()==lang)
 return v

def fit(x,y):
 if len(set(y))<2:return None
 return LogisticRegression(C=1,solver='liblinear',random_state=20261007,max_iter=500).fit(x,y)
def calibrate(model,x,y):
 if model is None or len(y)<20 or len(set(y))<2:return None
 return fit(model.decision_function(x).reshape(-1,1),y)
def predict(model,cal,x,prior):
 if model is None:return np.full(len(x),prior)
 return cal.predict_proba(model.decision_function(x).reshape(-1,1))[:,1] if cal else model.predict_proba(x)[:,1]
def metrics(y,p):
 return {'n':len(y),'brier':float(brier_score_loss(y,p)),'auroc':float(roc_auc_score(y,p)) if len(set(y))>1 else None,'balanced_accuracy':float(balanced_accuracy_score(y,p>=.5))}
def weights(m):return None if m is None else {'coefficients':m.coef_.tolist(),'intercept':m.intercept_.tolist()}
def evaluate(rows,feature,target,split_field):
 train=[r for r in rows if r[split_field]=='train'];val=[r for r in rows if r[split_field]=='validation'];test=[r for r in rows if r[split_field]=='test']
 if not train or not val or not test:return {'unavailable':'empty split'},None
 x=lambda rs:np.array([feature(r) for r in rs]); y=lambda rs:np.array([target(r) for r in rs]);prior=float(y(train).mean());m=fit(x(train),y(train));c=calibrate(m,x(val),y(val));p=predict(m,c,x(test),prior)
 return {'test':metrics(y(test),p),'constant_train_prior':metrics(y(test),np.full(len(test),prior)),'train':len(train),'validation':len(val),'calibrated_on_validation':c is not None}, {'model':weights(m),'calibration':weights(c),'prior':prior}
def main():
 tasks=[json.loads(l) for l in open(ROOT/'.cache/tasks.jsonl')];start={};art={};models=sorted({r['model'] for r in tasks})
 for model in models:
  rows=[r for r in tasks if r['model']==model];start[model]={}
  for split in ['split','repo_split']:
   result,fitted=evaluate(rows,encode,lambda r:r['labels']['resolved'],split);start[model][split]=result
   if split=='split':art[model]=fitted
 # Predict next observable event, never label current event with its own features.
 # One predeclared prefix per trajectory prevents long-trace pseudo-replication.
 rows=[];seen_task=set();buffer=[];previous=None
 def consume(states):
  if len(states)<2 or states[0]['task_key'] in seen_task:return
  seen_task.add(states[0]['task_key']);i=int(digest(states[0]['trajectory_id'])[:8],16)%(len(states)-1)
  rows.append({**states[i],'next_progress':states[i+1]['labels']['observed_progress'],'next_stuck':states[i+1]['labels']['observed_stuck']})
 with open(ROOT/'.cache/states.jsonl') as source:
  for line in source:
   r=json.loads(line)
   if previous is not None and r['trajectory_id']!=previous:consume(buffer);buffer=[]
   previous=r['trajectory_id'];buffer.append(r)
 consume(buffer)
 keys=sorted(rows[0]['features']) if rows else [];agent={};agent_art={}
 for target in ['next_progress','next_stuck']:
  agent[target]={}
  for split in ['split','repo_split']:
   result,fitted=evaluate(rows,lambda r:[r['features'][k] for k in keys],lambda r:r[target],split);agent[target][split]=result
   if split=='split':agent_art[target]=fitted
 pairs=defaultdict(set)
 for t in tasks:pairs[t['task_key']].add(t['model'])
 ranking=[]
 def fitted_predict(f,x):
  if f['model'] is None:return f['prior']
  z=float(np.dot(f['model']['coefficients'][0],x)+f['model']['intercept'][0])
  if f['calibration']:z=z*f['calibration']['coefficients'][0][0]+f['calibration']['intercept'][0]
  return 1/(1+math.exp(-max(-35,min(35,z))))
 held=defaultdict(list)
 for t in tasks:
  if t['split']=='test':held[t['task_key']].append(t)
 for group in held.values():
  for i,a in enumerate(group):
   for b in group[i+1:]:
    if a['labels']['resolved']==b['labels']['resolved']:continue
    predicted=fitted_predict(art[a['model']],encode(a))-fitted_predict(art[b['model']],encode(b))
    ranking.append(float((predicted>0)==(a['labels']['resolved']>b['labels']['resolved'])) if predicted else .5)
 old=json.load(open(ROOT.parents[1]/'research/cold-start-v6-pareto/artifacts/results.json'))
 frozen_models=json.load(open(ROOT.parents[1]/'research/cold-start-v6-pareto/artifacts/predictor.json'))['models']
 # Frozen cohort is outcome-blind: load only safe IDs from the existing plan.
 from normalize import frozen
 ids,_=frozen();decisions=[{'task_id':t,'decision':'ABSTAIN','supported_candidates':sorted(set(models)&set(frozen_models))} for t in sorted(ids)]
 report={'start_public_heldout':start,'paired_heldout_ranking':{'discordant_pairs':len(ranking),'accuracy':float(np.mean(ranking)) if ranking else None},'paired_tasks':sum(len(v)>1 for v in pairs.values()),'agent_public_heldout':agent,'agent_prediction_target':'next tool-result observable progress/stuck proxy, one seeded prefix per deduplicated task; not success or intervention effect','agent_escalation_discrimination':None,'agent_required_capability':None,'frozen100':{'abstain':len(decisions),'selected':0,'solve_rate':None,'cost_per_solve':None,'reason':'zero exact model overlap; cross-version transfer and prices unknown; no licensed paired training for V6.2 models'},'old_frozen_results':old,'paid_calls':0,'live_pilot_recommended':False}
 (ROOT/'results.json').write_text(json.dumps(report,indent=2)+'\n');(ROOT/'frozen-decisions.json').write_text(json.dumps(decisions,indent=2)+'\n')
 (ROOT/'fitted.json').write_text(json.dumps({'version':1,'encoder':'fnv1a-ascii-logtf-v1 (task text + known language only; unknown Koda dimensions zero)','models':art,'state_features':keys,'agent':agent_art,'source_digest':json.load(open(ROOT/'normalization.json'))['task_digest'],'calibratedKodaProbability':False,'escalationUsefulness':None,'requiredCapability':None},indent=2)+'\n')
 print(json.dumps({k:v for k,v in report.items() if k!='old_frozen_results'},indent=2))
if __name__=='__main__':main()

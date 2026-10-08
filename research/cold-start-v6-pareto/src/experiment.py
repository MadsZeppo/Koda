"""TRAIN-only multi-output ridge (Pareto methodology), frozen exact SWE100 replay."""
import json,sys,time,subprocess,hashlib
from pathlib import Path
import numpy as np
from scipy.sparse import hstack,csr_matrix
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import Ridge
ROOT=Path(__file__).resolve().parents[1];R=ROOT.parent;REPO=R.parent
sys.path.insert(0,str(R/'cold-start-v3/src'))
from source import load_plan,routing_input
from features import structured
from audit import POOL
PROTOCOL={'version':'6.2','qualityEstimator':'Pareto multi-output Ridge alpha=10 sparse_cg; task TF-IDF + existing Koda TaskCapabilityProfile features','fit':'frozen SWE TRAIN only','costEstimator':'per-model observed TRAIN mean receipt; no evaluation receipt in routing','gaps':[.01,.02,.03],'normalCapability':'soft feature, no domain hard floor','hardRisk':'only explicit attested serious security/destructive schema/transaction concurrency/Koda invariant restrictions; lexical proxy alone cannot attest seriousness','reference':'highest TRAIN success rate then TRAIN mean cost then canonical identity','evaluation':'unchanged previously observed V3/V4/V6 FINAL100; retrospective','stop':'no quality/cost frontier improvement OR harmful downgrade > configured 3pp maximum OR retained solve <97%; no retuning','paidCalls':0}
def save(name,obj): (ROOT/'artifacts'/name).write_text(json.dumps(obj,indent=2,allow_nan=False)+'\n')
def node(script,*args):subprocess.run(['node','--import','tsx',str(ROOT/'src'/script),*map(str,args)],cwd=REPO,check=True)
def preexecution(task,metadata):
 t=routing_input(task,metadata);f=structured(t);names={'frontend':'frontend_ui','backend':'backend','database':'sql_database','tests':'testing','configuration':'devops','refactor':'refactor'}
 return {'taskId':task.task_id,'text':t.text,'languages':[k.split(':')[1] for k,v in f.items() if k.startswith('language:') and v],'frameworks':[k.split(':')[1] for k,v in f.items() if k.startswith('ecosystem:') and v],'domains':[v for k,v in names.items() if f.get('technical:'+k,f.get('kind:'+k,0))>0],'risks':{k:bool(f.get('technical:'+k,0)) for k in ('database','schema','security','concurrency')},'scope':next((k.split(':')[1] for k,v in f.items() if k.startswith('scope:') and v),'unknown'),'expectedFiles':None,'visual':bool(f.get('technical:frontend',0))}
def metrics(y,c,index,f,models):
 solved=y[np.arange(len(y)),index];cost=c[np.arange(len(y)),index];base=y[:,f];total=float(cost.sum());rate=float(solved.mean());bs=float(base.mean());bc=float(c[:,f].sum()/base.sum()) if base.sum() else None;cp=total/solved.sum() if solved.sum() else None
 return {'solveRate':rate,'frontierRetained':rate/bs if bs else None,'costPerSolved':float(cp) if cp is not None else None,'saving':1-float(cp)/bc if cp is not None and bc else None,'harmfulDowngrade':float(((base==1)&(solved==0)).mean()),'totalCost':total,'distribution':{m:int((index==j).sum()) for j,m in enumerate(models)},'cheapStartRate':float((c[np.arange(len(y)),index]<c[:,f]).mean()),'verifiedKodaSolveRate':None,'routerAPIcost':0,'localRouterAndVerifierDollarCost':None}
def run():
 out=ROOT/'artifacts';coverage=json.loads((out/'coverage.json').read_text());paired=json.loads((out/'paired.json').read_text());models=paired['models'];parts=paired['parts'];outcomes=paired['outcomes'];save('protocol.json',PROTOCOL)
 if len(models)<2:raise ValueError('STOP: insufficient effective pool')
 trainids=[t for t in parts['train'] if all(t in outcomes[m] for m in models)];testids=parts['final_holdout'];assert len(testids)==100
 plan,train,val,sealed=load_plan(R/'cold-start-v3/artifacts/data-plan/data-plan.json');tasklookup={r.task.task_id:r.task for r in train.rows};tasklookup.update({t.task_id:t for t in sealed.tasks})
 trainraw=[preexecution(tasklookup[t],plan['metadata']) for t in trainids];testraw=[preexecution(tasklookup[t],plan['metadata']) for t in testids]
 save('train-inputs.json',trainraw);save('evaluation-inputs.json',testraw);node('encode.ts',out/'train-inputs.json',out/'train-features.json');node('encode.ts',out/'evaluation-inputs.json',out/'evaluation-features.json')
 tr=json.loads((out/'train-features.json').read_text())['rows'];te=json.loads((out/'evaluation-features.json').read_text())['rows']
 tf=TfidfVectorizer(max_features=8000,ngram_range=(1,2),sublinear_tf=True);x=tf.fit_transform([r['text'] for r in trainraw]);xt=tf.transform([r['text'] for r in testraw]);x=hstack([x,csr_matrix([r['features'] for r in tr])]).tocsr();xt=hstack([xt,csr_matrix([r['features'] for r in te])]).tocsr()
 y=np.array([[outcomes[m][t]['score']==1 for m in models] for t in trainids],float);traincost=np.array([[outcomes[m][t]['cost'] for m in models] for t in trainids]);cost=traincost.mean(axis=0)
 f=sorted(range(len(models)),key=lambda j:(-y[:,j].mean(),cost[j],models[j]))[0]
 start=time.perf_counter();reg=Ridge(alpha=10,solver='sparse_cg').fit(x,y);pred=np.clip(reg.predict(xt),0,1);predictms=(time.perf_counter()-start)*1000
 save('predictor.json',{'models':models,'trainingIds':trainids,'vocabulary':{k:int(v) for k,v in tf.vocabulary_.items()},'idf':tf.idf_.tolist(),'coefficients':reg.coef_.tolist(),'intercepts':reg.intercept_.tolist(),'trainingCostUsd':dict(zip(models,cost.tolist())),'trainingSuccess':dict(zip(models,y.mean(axis=0).tolist())),'profileEncoder':'startFeatures V6 frozen fnv1a-ascii-logtf-v1','calibratedKodaProbability':False})
 inputs={'tasks':[{'taskId':t,'scores':[{'model':m,'quality':float(pred[i,j]),'costUsd':float(cost[j]),'compatible':True} for j,m in enumerate(models)]} for i,t in enumerate(testids)]};save('routing-inputs.json',inputs);node('select.ts',out/'routing-inputs.json',out/'decisions.json')
 frozen={'models':models,'reference':models[f],'testIds':testids,'trainIds':trainids,'decisionsSHA256':hashlib.sha256((out/'decisions.json').read_bytes()).hexdigest(),'protocol':PROTOCOL};save('frozen.json',frozen)
 # Outcomes only now used for scoring frozen decisions. Predictor saw TRAIN targets only.
 ey=np.array([[outcomes[m][t]['score']==1 for m in models] for t in testids],float);ec=np.array([[outcomes[m][t]['cost'] for m in models] for t in testids]);dec=json.loads((out/'decisions.json').read_text());fixed=np.full(100,f);policies={'Strongest static (TRAIN-selected)':metrics(ey,ec,fixed,f,models)}
 aliases={'qwen3-235b':'qwen3-235b-a22b-2507','deepseek-v3.1':'deepseek-v3.1-terminus'};v3={r['taskId']:aliases.get(r['methods']['Selected V3']['selected'],r['methods']['Selected V3']['selected']) for r in map(json.loads,(R/'cold-start-v3/artifacts/final-holdout/predictions.jsonl').read_text().splitlines())}
 policies['V3']=metrics(ey,ec,np.array([models.index(v3[t]) for t in testids]),f,models)
 oldf=json.loads((R/'cold-start-v6-open-source/artifacts/pilot/frozen.json').read_text());oldd={d['taskId']:d['rawStart'] or oldf['frontier'] for d in json.loads((R/'cold-start-v6-open-source/artifacts/pilot/decisions.json').read_text())};oldalias=lambda m:m.split('/',1)[1];policies['Old V6']=metrics(ey,ec,np.array([models.index(oldalias(oldd[t])) for t in testids]),f,models)
 for gap in PROTOCOL['gaps']:
  policies[f'Pareto {int(gap*100)}pp']=metrics(ey,ec,np.array([models.index(d['selected'][str(gap)]) for d in dec]),f,models)
 oracle=np.where(ey==1,ec,np.inf).argmin(axis=1);oracle=np.where(ey.max(axis=1),oracle,ec.argmin(axis=1));policies['Oracle new pool']=metrics(ey,ec,oracle,f,models)
 static={m:metrics(ey,ec,np.full(100,j),f,models) for j,m in enumerate(models)};expost=max(models,key=lambda m:static[m]['solveRate']);oldpool=['claude-sonnet-4','gemini-2.5-flash','gpt-5','qwen3-235b-a22b-2507','deepseek-v3.1-terminus','glm-4.6'];oldcols=[models.index(m) for m in oldpool];oldoracle=float(ey[:,oldcols].max(axis=1).mean())
 useful=any(policies[f'Pareto {g}pp']['frontierRetained']>=.97 and policies[f'Pareto {g}pp']['saving']>0 and policies[f'Pareto {g}pp']['harmfulDowngrade']<=.03 for g in (1,2,3));broader=policies['Oracle new pool']['solveRate']>oldoracle or max(static[m]['solveRate'] for m in models)>max(static[m]['solveRate'] for m in oldpool)
 results={'policies':policies,'effectivePool':models,'excluded':coverage['excluded'],'reference':models[f],'strongestStaticExPost':expost,'perModel':static,'oldPoolOracleSolveRate':oldoracle,'broaderPoolHeadroomImproved':broader,'safeCheapRoutingDemonstrated':useful,'stop':not useful or not broader,'reason':'STOP: no acceptable retained-quality cost saving; no production promotion' if not useful else 'Retrospective signal only; dynamic live performance unknown','routingSelectionMeanMs':float(np.mean([d['elapsedMs'] for d in dec])),'fitAndPredictMs':predictms,'distanceToOracle':{g:{'solveGap':policies['Oracle new pool']['solveRate']-policies[g]['solveRate'],'costPerSolveRatio':policies[g]['costPerSolved']/policies['Oracle new pool']['costPerSolved']} for g in ('Pareto 1pp','Pareto 2pp','Pareto 3pp')},'paidCalls':0,'dynamicPerformance':'NOT EVALUATED','trainingTasks':len(trainids),'evaluationTasks':100,'finalSetPreviouslyObserved':True}
 
 for gap in PROTOCOL['gaps']:
  keys=[d['selected'][str(gap)] for d in dec];indices=np.array([models.index(k) for k in keys]);policies[f'Pareto {int(gap*100)}pp']['forecastCheapStartRate']=float((cost[indices]<cost[f]).mean())
 save('results.json',results);lines=['# V6.2 Pareto SWE replay','', 'Exact same previously observed 100 tasks. Historical benchmark solves are not live Koda VERIFIED_SUCCESS. No coding or judge calls.','',f'Effective pool: {len(models)}/12. TRAIN-selected strongest static: {models[f]}. Ex-post best static: {expost}.','', '| Policy | Solve rate | Frontier retained | Cost/solve | Saving | Harmful downgrade |','|---|---:|---:|---:|---:|---:|']
 for name,p in policies.items():lines.append(f"| {name} | {p['solveRate']:.1%} | {p['frontierRetained']:.1%} | ${p['costPerSolved']:.5f} | {p['saving']:.1%} | {p['harmfulDowngrade']:.1%} |")
 lines+=['',f'Broader-pool oracle headroom improved: {broader}. Safe cheaper starts demonstrated: {useful}.',f'Old-pool oracle: {oldoracle:.1%}. New oracle: {policies["Oracle new pool"]["solveRate"]:.1%}.',f'Selection mean latency: {results["routingSelectionMeanMs"]:.3f} ms (excludes feature encoding/predictor fit).', 'Costs are actual historical model receipts; forecast uses TRAIN mean receipts. Local router compute, verifier and handover cost are unmeasured, so these are lower bounds on cost per VERIFIED solve.', 'Public SWE is single-patch generation, not aligned Koda multi-action trajectories. Weave economics are tested deterministically, not validated by this replay. No actual dynamic or production routing changed.',results['reason']]
 lines += ['', '## Forecast cheap starts and distance to oracle', '', '| Policy | Cheaper than reference (TRAIN forecast) | Oracle solve gap | Cost/solve vs oracle |', '|---|---:|---:|---:|']
 for name in ('Pareto 1pp','Pareto 2pp','Pareto 3pp'):
  v=policies[name];d=results['distanceToOracle'][name];lines.append(f"| {name} | {v['forecastCheapStartRate']:.1%} | {d['solveGap']:.1%} | {d['costPerSolveRatio']:.2f}x |")
 lines += ['', '## Start-model distribution', '', '| Model | 1pp | 2pp | 3pp |', '|---|---:|---:|---:|']
 for m in models:lines.append(f"| {m} | {policies['Pareto 1pp']['distribution'][m]} | {policies['Pareto 2pp']['distribution'][m]} | {policies['Pareto 3pp']['distribution'][m]} |")
 (out/'REPORT.md').write_text('\n'.join(lines)+'\n');print(json.dumps(results,indent=2))
if __name__=='__main__':run()

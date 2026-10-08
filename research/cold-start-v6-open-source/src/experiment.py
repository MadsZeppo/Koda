"""Fixed offline falsification: six Koda models, TRAIN-only fit, no paid calls.
Real historical outcomes, separate weak Twin state labels; simulated recovery is never verified performance.
"""
import sys,json,hashlib,time,subprocess,importlib.util
from pathlib import Path
import numpy as np
from sklearn.neural_network import MLPClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import balanced_accuracy_score
ROOT=Path(__file__).resolve().parents[1];REPO=ROOT.parents[1];V3=ROOT.parent/'cold-start-v3';V4=ROOT.parent/'cold-start-v4'
sys.path.insert(0,str(V3/'src'))
from source import load_plan,routing_input
from features import structured
from v2bridge import MODELS,load_v2,encoded,digest
from twin import prefix_state,partition,tier,FEATURES
spec=importlib.util.spec_from_file_location('v4readonly',V4/'src/experiment.py');v4=importlib.util.module_from_spec(spec);sys.modules[spec.name]=v4;spec.loader.exec_module(v4)
IDS=['anthropic/claude-sonnet-4','google/gemini-2.5-flash','openai/gpt-5','qwen/qwen3-235b-a22b-2507','deepseek/deepseek-v3.1-terminus','z-ai/glm-4.6']
PROTOCOL={'version':6,'seed':20261007,'hidden':32,'alpha':1.,'maxIter':400,'allowedRegret':.02,'maxRegretProbability':.05,'taskBudgetFrontierMultiple':2.,'maxEscalations':2,
 'fit':'SWE TRAIN only; multi-label expected-success MLP; no external model labels','evaluation':'same previously observed SWE FINAL100; retrospective, not pristine prospective validation','paidCalls':0,'routerDollarCost':None,
 'stepLabels':'Twin SWE degradation_search_done WEAK labels; tiers never mapped to exact Koda identities','stop':'constrained cheap starts <10% OR start solve no better than V3 with no cost/solve improvement; no outcome tuning'}
def save(p,x):p.write_text(json.dumps(x,ensure_ascii=False,separators=(',',':'))+'\n')
def node(script,*args):subprocess.run(['node','--import','tsx',str(ROOT/'src'/script),*map(str,args)],cwd=REPO,check=True)
def preexecution(task,metadata):
 t=routing_input(task,metadata);f=structured(t)
 names={'frontend':'frontend_ui','backend':'backend','database':'sql_database','tests':'testing','configuration':'devops','refactor':'refactor'}
 domains=[mapped for name,mapped in names.items() if f.get('technical:'+name, f.get('kind:'+name,0))>0]
 return {'taskId':task.task_id,'text':t.text,'languages':[k.split(':')[1] for k,v in f.items() if k.startswith('language:') and v],
 'frameworks':[k.split(':')[1] for k,v in f.items() if k.startswith('ecosystem:') and v], 'domains':domains,
 'risks':{k:bool(f.get('technical:'+k,0)>0) for k in ('database','schema','security','concurrency')},'scope':next((k.split(':')[1] for k,v in f.items() if k.startswith('scope:') and v),'unknown'),
 'expectedFiles':None,'visual':bool(f.get('technical:frontend',0))}
def twin_audit(out, evaluation_instances):
 path=ROOT/'.cache/twin/data/static/question_bank.jsonl';rows=[r for r in map(json.loads,path.read_text().splitlines()) if r['benchmark']=='swebench'];x=np.log1p(np.array([prefix_state(r) for r in rows],float));y=np.array([tier(r) for r in rows]);groups=[r['instance_id'] for r in rows]
 tr=np.array([partition(g)<7 and g not in evaluation_instances for g in groups]);te=np.array([partition(g)>=7 for g in groups])
 if len(set(y[tr]))<2 or len(set(y[te]))<2:raise ValueError('Twin grouped split insufficient')
 clf=LogisticRegression(C=1,max_iter=1000,random_state=20261007).fit(x[tr],y[tr]);p=clf.predict(x[te]);majority=max(set(y[tr]),key=lambda k:int((y[tr]==k).sum()));baseline=np.full(te.sum(),majority)
 info={'codingStates':len(rows),'instances':len(set(groups)),'trainStates':int(tr.sum()),'heldoutStates':int(te.sum()),'heldoutInstances':len(set(np.array(groups)[te])),
 'evaluationInstanceOverlapTRAIN':len(set(np.array(groups)[tr])&evaluation_instances),'groupOverlap':len(set(np.array(groups)[tr])&set(np.array(groups)[te])),'classes':list(clf.classes_),'heldoutBalancedAccuracy':balanced_accuracy_score(y[te],p),
 'majorityBalancedAccuracy':balanced_accuracy_score(y[te],baseline),'statesWithObservedToolPrefix':int((x[:,0]>0).sum()),'labelStatus':'weak degradation_search_done; not strict ground truth',
 'mapping':'prefix commands/results -> read/search/mutate/verify/repetition/failure/scope/diff; no future total_steps or target label features',
 'KodaAdequacyCalibration':False,'KodaStepImprovement':None,'noCrossPoolModelIdentityLabels':True}
 save(out/'twin-state-audit.json',info);save(out/'twin-tier-proxy.json',{'features':FEATURES,'classes':list(clf.classes_),'coefficients':clf.coef_.tolist(),'intercepts':clf.intercept_.tolist(),'scope':'weak-tier research proxy only; cannot authorize six-model switch'})
 return info

def run(output):
 start=time.monotonic();out=Path(output);out.mkdir(parents=True,exist_ok=False);save(out/'protocol.json',PROTOCOL)
 plan,train,val,sealed=load_plan(V3/'artifacts/data-plan/data-plan.json');train=v4.swe(train);f,c,_=v4.reference(train);frontier=IDS[f];costs=dict(zip(IDS,c.tolist()))
 tasks=[t for t in sealed.tasks if t.dataset=='swe-bench'];trainraw=[preexecution(r.task,plan['metadata']) for r in train.rows];testraw=[preexecution(t,plan['metadata']) for t in tasks]
 save(out/'train-inputs.json',trainraw);save(out/'evaluation-inputs.json',testraw)
 node('encode.ts',out/'train-inputs.json',out/'train-features.json');node('encode.ts',out/'evaluation-inputs.json',out/'evaluation-features.json')
 x=json.loads((out/'train-features.json').read_text());xt=json.loads((out/'evaluation-features.json').read_text());y,_=v4.matrices(train.rows)
 clf=MLPClassifier(hidden_layer_sizes=(32,),activation='relu',solver='lbfgs',alpha=1.,max_iter=400,random_state=20261007).fit(np.array([r['features'] for r in x['rows']]),y)
 a={'version':6,'encoder':'fnv1a-ascii-logtf-v1','models':IDS,'hidden':clf.coefs_[0].tolist(),'hiddenBias':clf.intercepts_[0].tolist(),'output':clf.coefs_[1].tolist(),'outputBias':clf.intercepts_[1].tolist(),
 'trainingDigest':digest([r.task.task_id for r in train.rows]),'provenance':['LLMRouterBench:SWE TRAIN; frozen V3 partition','ACRouter MIT trained-router methodology; independent six-head success MLP reimplementation']}
 a['digest']='';save(out/'start-router.json',a)
 subprocess.run(['node','-e',"const fs=require('node:fs'),crypto=require('node:crypto');let a=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));delete a.digest;a.digest=crypto.createHash('sha256').update(JSON.stringify(a)).digest('hex');fs.writeFileSync(process.argv[1],JSON.stringify(a));",str(out/'start-router.json')],check=True)
 a=json.loads((out/'start-router.json').read_text())
 # One pair per TRAIN task: no correlated duplicate rows. Public harness remains public; never Koda native.
 evidence={'version':1,'digest':'offline-public-fit','trainingDigest':a['trainingDigest'],'frozenAt':'2026-10-07','target':'complete_benchmark_solve','estimator':'empirical','vocabulary':[],'weights':[],'temperature':1,'calibrationError':0,
 'cells':[{'model':m,'family':'debugging','engine':'direct','harness':'public-swe','count':len(train.rows),'solved':int(y[:,j].sum()),'local':0,'sources':['LLMRouterBench:SWE TRAIN']} for j,m in enumerate(IDS)],
 'paired':[{'family':'debugging','engine':'direct','harness':'public-swe','source':'LLMRouterBench:SWE TRAIN','taskId':r.task.task_id,'outcomes':{m:int(y[i,j]) for j,m in enumerate(IDS)},'provenance':['LLMRouterBench:SWE TRAIN']} for i,r in enumerate(train.rows)],
 'training':{'observations':len(train.rows)*6,'tasks':len(train.rows),'models':6,'missingSemantic':len(train.rows)*6}}
 inputs={'evidence':evidence,'tasks':xt['rows'],'costs':costs,'facts':[{'id':m,'compatible':True,'inputPrice':0,'outputPrice':0} for m in IDS],
 'policy':{'allowedRegret':.02,'maxRegretProbability':.05,'budgetUsd':float(2*c[f])}}
 save(out/'routing-inputs.json',inputs);node('replay.ts',out/'routing-inputs.json',out/'start-router.json',out/'decisions.json')
 decisions=json.loads((out/'decisions.json').read_text());save(out/'frozen.json',{'protocolDigest':digest(PROTOCOL),'dataPlanFingerprint':plan['fingerprint'],'frontier':frontier,'expectedCostsTRAIN':costs,
 'decisionsDigest':digest((out/'decisions.json').read_bytes()),'learnedArtifactDigest':a['digest'],'fitTasks':len(train.rows),'evaluationTasks':len(tasks),'noPaidCalls':True})
 finish(output)

def finish(output):
 start=time.monotonic();out=Path(output)
 plan,train,val,sealed=load_plan(V3/'artifacts/data-plan/data-plan.json');train=v4.swe(train);tasks=[t for t in sealed.tasks if t.dataset=='swe-bench']
 frozen=json.loads((out/'frozen.json').read_text());frontier=frozen['frontier'];f=IDS.index(frontier)
 decisions=json.loads((out/'decisions.json').read_text())
 if digest((out/'decisions.json').read_bytes())!=frozen['decisionsDigest'] or frozen['dataPlanFingerprint']!=plan['fingerprint']:raise ValueError('Frozen evidence/decisions changed')
 if json.loads((out/'protocol.json').read_text())!=PROTOCOL:raise ValueError('Protocol changed')
 # Scoring ONLY after frozen decisions. Do not give outcomes or receipts to the router for current tasks.
 rows=load_v2(plan['v2DataDirectory'])[0];lookup={r.task.task_id:r for r in rows};evalrows=[lookup[t.task_id] for t in tasks];ey,ec=v4.matrices(evalrows)
 v3p={r['taskId']:r['methods']['Selected V3']['selected'] for r in map(json.loads,(V3/'artifacts/final-holdout/predictions.jsonl').read_text().splitlines())};v4p={r['taskId']:r['selected']['0.02'] for r in map(json.loads,(V4/'artifacts/evaluation/predictions.jsonl').read_text().splitlines())}
 indexes=lambda keys:np.array([IDS.index(k) for k in keys]);alias=lambda k:IDS[MODELS.index(k)]
 baseline=indexes([d['baselineStart'] or frontier for d in decisions]);learned=indexes([d['rawStart'] or frontier for d in decisions]);raw=indexes([d['unconstrainedSuggestion'] for d in decisions]);fixed=np.full(len(tasks),f)
 result={'Frontier only':v4.score(ey,ec,fixed,f),'V3':v4.score(ey,ec,indexes([alias(v3p[t.task_id]) for t in tasks]),f),
 'V4':v4.score(ey,ec,indexes([alias(v4p[t.task_id]) for t in tasks]),f),'Current V6 baseline':v4.score(ey,ec,baseline,f),
 'ACRouter-style StartRouter + floor':v4.score(ey,ec,learned,f),'StartRouter without floor (diagnostic)':v4.score(ey,ec,raw,f)}
 oracle=np.where(ey,ec,np.inf).argmin(axis=1);oracle=np.where(ey.max(axis=1),oracle,ec.argmin(axis=1));result['Oracle']=v4.score(ey,ec,oracle,f)
 for label,idx in [('Current V6 baseline',baseline),('ACRouter-style StartRouter + floor',learned)]:
  result[label]['simulatedPerfectVerifierRecovery']=v4.score(ey,ec,idx,f,True)
 for label,v in result.items():
  v['verifiedKodaSolveRate']=None;v['observedRouterCostUsd']=0;v['routerComputeDollarCost']=None;v['costExcludesUnmeasuredLocalComputeAndVerifier']=True
 info=twin_audit(out,{plan['metadata'][t.task_id]['instance_id'] for t in tasks});cheap=float((learned!=f).mean());new=result['ACRouter-style StartRouter + floor'];old=result['V3']
 stop=cheap<.1 or (new['solveRate']<=old['solveRate'] and new['costPerSolved']>=old['costPerSolved'])
 result['StartRouter + TwinRouterBench StepRouter']={'evaluated':False,'reason':'STOP: constrained start router collapses or fails improvement criterion; no aligned six-model real trajectory outcomes','verifiedKodaSolveRate':None}
 metrics={'policies':result,'cheapStartRate':cheap,'abstentionRate':sum(d['status']=='ABSTAIN' for d in decisions)/len(decisions),'startModelDistribution':{IDS[j]:int((learned==j).sum()) for j in range(6)},
 'routingLatencyMs':{'mean':float(np.mean([d['elapsedMs'] for d in decisions])),'max':max(d['elapsedMs'] for d in decisions)},'realEscalationRate':None,'unnecessaryEscalationRate':None,
 'stop':stop,'reason':'no supported low-regret cheap region; Twin weak tier supervision is not calibrated six-model adequacy','Twin':info,'elapsedSeconds':time.monotonic()-start,'paidCalls':0}
 save(out/'results.json',metrics)
 lines=['# V6 open-source falsification','', 'Retrospective replay of the same 100 previously observed SWE tasks. Historical benchmark outcomes are real; no live Koda verification or trajectory evaluation was performed.','',
 '| Policy | Solve | Frontier retained | Cost/solve | Saving | Harmful loss |','|---|---:|---:|---:|---:|---:|']
 for label,v in result.items():
  if not v.get('evaluated',True):continue
  lines.append(f"| {label} | {100*v['solveRate']:.1f}% | {100*v['frontierRetained']:.1f}% | ${v['costPerSolved']:.4f} | {100*v['costSaving']:.1f}% | {100*v['harmfulDowngrade']:.1f}% |")
 lines+=['',f"Constrained cheap starts: {100*cheap:.1f}%; abstentions: {100*metrics['abstentionRate']:.1f}%. Reference fallback after ABSTAIN is an **evaluation baseline**, not a V6-selected model.",
 f"Router mean/max: {metrics['routingLatencyMs']['mean']:.2f}/{metrics['routingLatencyMs']['max']:.2f} ms. Provider router cost $0. Local compute/verifier dollar costs are unknown, so reported cost/solve is a lower bound.",
 f"Twin grouped heldout balanced accuracy: {info['heldoutBalancedAccuracy']:.3f}; majority baseline: {info['majorityBalancedAccuracy']:.3f}; states with tool prefixes: {info['statesWithObservedToolPrefix']}/{info['codingStates']}.",
 'Twin tiers are weak labels from another pool. They do not prove Koda stay/escalate improvements. Combined policy not evaluated; real escalation and unnecessary escalation are UNKNOWN. Perfect-verifier recovery simulations are separately nested in JSON, exclude verifier cost, and are not end-to-end results.',
 '**STOP. Remain shadow-only.** Missing signal: task-conditioned low-regret adequacy plus aligned Koda six-model step outcomes. No final-outcome tuning, paid inference, new routing generation, or production promotion.',
 'SWE-smith trajectories and optional LLMRouter baseline deferred. Existing isolation, verifier, recovery, write scope and apply authority unchanged.']
 (out/'REPORT.md').write_text('\n'.join(lines)+'\n');print(json.dumps(metrics,indent=2))
if __name__=='__main__':
 import argparse
 p=argparse.ArgumentParser();p.add_argument('--output',required=True);p.add_argument('--resume',action='store_true');args=p.parse_args();finish(args.output) if args.resume else run(args.output)

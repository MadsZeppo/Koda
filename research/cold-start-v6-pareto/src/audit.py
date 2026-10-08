"""Audit exact frozen SWE IDs before fit; no outcome substitution or fuzzy joins."""
import json,tarfile,hashlib,math
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]; RESEARCH=ROOT.parent
POOL=['gpt-5','gpt-5-chat','claude-sonnet-4','gemini-2.5-pro','gemini-2.5-flash','qwen3-235b-a22b-2507','qwen3-235b-a22b-thinking-2507','deepseek-v3.1-terminus','deepseek-r1-0528','deepseek-v3-0324','kimi-k2-0905','glm-4.6']
# Release folder omits version, but filename explicitly identifies thinking-2507.
FOLDERS={'qwen3-235b-a22b-thinking':'qwen3-235b-a22b-thinking-2507'}
def normalize(t):return ' '.join(t.split())
def sha(b):return hashlib.sha256(b).hexdigest()
def valid(r):
 return isinstance(r.get('origin_query'),str) and all(isinstance(r.get(k),(int,float)) and not isinstance(r.get(k),bool) and math.isfinite(r[k]) for k in ('score','cost')) and 0<=r['score']<=1 and r['cost']>=0

def run():
 plan=json.loads((RESEARCH/'cold-start-v3/artifacts/data-plan/data-plan.json').read_text());ids={p:[t for t in ts if t.startswith('swe-bench:')] for p,ts in plan['split']['parts'].items()}
 canonical=[json.loads(l) for l in (RESEARCH/'cold-start-v2/.cache/public/canonical.jsonl').read_text().splitlines()];tasks={r['task']['taskId']:r['task'] for r in canonical if r['task']['dataset']=='swe-bench'}
 data={m:{} for m in POOL};files={};invalid={m:[] for m in POOL};seen={m:{} for m in POOL}
 archive=RESEARCH/'cold-start-v2/.cache/bench-release.tar.gz'
 with tarfile.open(archive,'r|gz') as tf:
  for member in tf:
   parts=member.name.split('/')
   if len(parts)!=5 or parts[1:3]!=['swe-bench','verified'] or not member.name.endswith('.json'):continue
   model=FOLDERS.get(parts[3],parts[3])
   if model not in data:continue
   if parts[3] in FOLDERS and 'thinking-2507' not in parts[4]:raise ValueError('Unproven Qwen version')
   blob=tf.extractfile(member).read();payload=json.loads(blob);
   if str(payload.get('model_name','')).casefold()!=model.casefold():raise ValueError('Source model identity mismatch')
   files[member.name]={'sha256':sha(blob),'model':model,'model_name':payload.get('model_name')}
   for rec in payload['records']:
    key=str(rec.get('index'));q=sha(json.dumps(normalize(rec.get('origin_query','')),ensure_ascii=False,separators=(',',':')).encode())
    taskid=f'swe-bench:verified:{key}:{q}'
    if not valid(rec):invalid[model].append(taskid);continue
    value={'score':float(rec['score']),'cost':float(rec['cost']),'promptTokens':rec.get('prompt_tokens'),'completionTokens':rec.get('completion_tokens'),'sourceFile':member.name}
    if key in seen[model] and seen[model][key]!=(taskid,value):invalid[model].append(taskid);invalid[model].append(seen[model][key][0])
    seen[model][key]=(taskid,value);data[model][taskid]=value
 for m in POOL:
  for t in invalid[m]:data[m].pop(t,None)
 coverage={m:{p:sum(t in data[m] for t in ts) for p,ts in ids.items()} for m in POOL}
 effective=[m for m in POOL if coverage[m]['final_holdout']==100]
 report={'requestedPool':POOL,'effectivePool':effective,'excluded':{m:'missing or conflicting exact paired outcomes on unchanged 100 tasks' for m in POOL if m not in effective},'coverage':coverage,'taskIds':ids,'splitFingerprint':plan['fingerprint'],'sourceFiles':files,'paidCalls':0,'finalPreviouslyObserved':True}
 out=ROOT/'artifacts';out.mkdir(exist_ok=True)
 (out/'coverage.json').write_text(json.dumps(report,indent=2)+'\n')
 (out/'paired.json').write_text(json.dumps({'models':effective,'parts':ids,'outcomes':{m:data[m] for m in effective}},sort_keys=True)+'\n')
 print(json.dumps({'coverage':coverage,'effective':effective},indent=2))
if __name__=='__main__':run()

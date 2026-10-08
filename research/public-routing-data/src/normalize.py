"""Licensed, prefix-causal public views. Outcomes are labels, never features."""
import hashlib,json,re
from collections import Counter
from pathlib import Path
import pyarrow.parquet as pq
ROOT=Path(__file__).resolve().parents[1]
def digest(x): return hashlib.sha256(json.dumps(x,sort_keys=True,ensure_ascii=True).encode()).hexdigest()
def text(content):
 if isinstance(content,str): return content
 return '\n'.join(x.get('text','') for x in (content or []) if isinstance(x,dict) and x.get('type')=='text')
def model_alias(name):
 return {'MiniMax-M2.5':'minimax-m2.5','Qwen3.5-122B-A10B':'qwen3.5-122b-a10b'}.get(name,name.lower())
def split(key):
 n=int(digest(key)[:8],16)%10
 return 'train' if n<7 else 'validation' if n<9 else 'test'
def frozen():
 p=json.loads((ROOT.parents[1]/'research/cold-start-v3/artifacts/data-plan/data-plan.json').read_text())
 rows=[p['metadata'][k] for k in p['split']['parts']['final_holdout'] if k.startswith('swe-bench:')]
 return {r['instance_id'] for r in rows},{digest(' '.join(r['problem_statement'].split())) for r in rows}
def task_text(messages):
 raw=next((text(m.get('content')) for m in messages if m.get('role')=='user'),'')
 # Harness wrappers are not customer requirements; retain original issue only.
 for tag in ['issue','pr_description']:
  match=re.search('<'+tag+'>(.*?)</'+tag+'>',raw,re.S)
  if match: return match[1].strip()
 return raw
BANNED=re.compile(r'gold[_ -]?patch|reference[_ -]?patch|test[_ -]?patch|hidden[_ -]?answer',re.I)
def states(messages):
 """Only a prefix ending at the current tool result influences each feature row."""
 counts=Counter(); seen=Counter();paths=set();pending='unknown';step=0
 for m in messages:
  if m.get('role')=='assistant':
   calls=m.get('tool_calls') or []
   for call in calls:
    f=call.get('function',{});pending=f.get('name','unknown');arg=f.get('arguments','')
    signature=digest([pending,arg]);seen[signature]+=1;counts['repeat']=max(0,seen[signature]-1)
    for path in re.findall(r'[\w./-]+\.(?:py|tsx?|jsx?|go|rs|java|json|yaml)',str(arg)):paths.add(path)
   continue
  if m.get('role')!='tool':continue
  observation=text(m.get('content'));step+=1;low=observation.lower()
  category='mutation' if re.search('edit|write|replace|create',pending,re.I) else 'read' if re.search('read|view|search|find',pending,re.I) else 'command'
  error=bool(re.search(r'error|traceback|failed|exception|timed out',low))
  infra=bool(re.search(r'429|connection refused|timed out|missing dependency|permission denied',low))
  counts[category]+=1;counts['consecutive_errors']=counts['consecutive_errors']+1 if error else 0
  verifier=bool(re.search(r'\btest|pytest|typecheck|build|lint',low))
  progress=category=='mutation' and not error
  # Operational errors are not capability labels. Capability/escalation unknown.
  features={'step':step,'reads':counts['read'],'mutations':counts['mutation'],'commands':counts['command'],'files':len(paths),'repetition':counts['repeat'],'consecutive_errors':counts['consecutive_errors'],'current_error':int(error),'infrastructure':int(infra),'verification_event':int(verifier),'observation_chars':min(len(observation),20000)}
  yield {'step':step,'action':category,'tool':pending,'features':features,'observation':{'error':error,'infrastructure':infra,'verification_event':verifier},'scope':sorted(paths),'labels':{'observed_progress':int(progress),'observed_stuck':int(counts['repeat']>=2 or counts['consecutive_errors']>=2),'escalation_usefulness':None,'required_capability':None}}
def main():
 ids,hashes=frozen();sources=json.load(open(ROOT/'sources.json'));audit=Counter();tasks=[];state_count=0;seen_tasks=set();seen_traj=set();first_outcomes={};conflicts=set()
 with open(ROOT/'.cache/states.jsonl','w') as out:
  for source in sources['included']:
   smith=source['source'].endswith('SWE-smith-trajectories');cols=['instance_id','messages','resolved','model','traj_id'] if smith else ['instance_id','repo','language','license','trajectory_id','messages','resolved','metadata.teacher_model']
   path=ROOT/'.cache'/Path(source['localFile']).name
   h=hashlib.sha256()
   with open(path,'rb') as f:
    for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
   if h.hexdigest()!=source['sha256']:raise ValueError('source digest mismatch')
   for batch in pq.ParquetFile(path).iter_batches(batch_size=32,columns=cols):
    for row in batch.to_pylist():
     messages=json.loads(row['messages']) if smith else row['messages'];task=task_text(messages);tid=row['instance_id'];teacher=model_alias(row['model'] if smith else row['metadata']['teacher_model']['name'])
     if tid in ids or digest(' '.join(task.split())) in hashes:audit['frozen_excluded']+=1;continue
     if not task or BANNED.search(task):audit['unsafe_task_excluded']+=1;continue
     if not smith and row['license'] not in ['MIT','Apache-2.0','BSD-3-Clause','BSD-2-Clause','ISC']:audit['record_license_excluded']+=1;continue
     if row['resolved'] not in [0,1,False,True]:audit['unknown_outcome_excluded']+=1;continue
     repo=row.get('repo') or tid.split('.')[0].replace('__','/');key=digest([repo,' '.join(task.split())]);trajectory=digest([key,teacher,messages])
     if trajectory in seen_traj:audit['duplicate_trajectory']+=1;continue
     seen_traj.add(trajectory);provenance={k:source[k] for k in ['source','revision','license','subset','sha256']}
     base={'task_id':tid,'task_key':key,'repo':repo,'model':teacher,'family':teacher.split('-')[0],'split':split(key),'repo_split':split(repo),'provenance':provenance}
     outcome={'resolved':int(row['resolved']),'cost_usd':None,'tokens':None}
     pair=(key,teacher)
     if pair in first_outcomes and first_outcomes[pair]!=outcome['resolved']:conflicts.add(pair)
     first_outcomes[pair]=outcome['resolved']
     if (key,teacher) not in seen_tasks:
      seen_tasks.add((key,teacher));tasks.append({**base,'task_text':task,'language':row.get('language','python' if smith else 'unknown'),'framework':None,'harness':'swe-agent' if smith else 'openhands','labels':outcome})
     else:audit['duplicate_task_model']+=1
     for state in states(messages):
      out.write(json.dumps({**base,'trajectory_id':trajectory,**state,'final_outcome':outcome['resolved']},sort_keys=True)+'\n');state_count+=1
 audit['conflicting_task_model_excluded']=len(conflicts)
 tasks=[t for t in tasks if (t['task_key'],t['model']) not in conflicts]
 tasks.sort(key=lambda x:(x['task_key'],x['model']))
 with open(ROOT/'.cache/tasks.jsonl','w') as f:
  for row in tasks:f.write(json.dumps(row,sort_keys=True)+'\n')
 report={'task_outcomes':len(tasks),'trajectory_states':state_count,'trajectories':len(seen_traj),'unique_tasks':len({x['task_key'] for x in tasks}),'models':dict(Counter(x['model'] for x in tasks)),'sources':dict(Counter(x['provenance']['source'] for x in tasks)),'splits':dict(Counter(x['split'] for x in tasks)),'audit':dict(audit),'frozen_exclusion_ids':len(ids),'paid_calls':0,'labels':'observable event proxies; escalation/capability counterfactuals unknown','task_digest':digest(tasks)}
 (ROOT/'normalization.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
if __name__=='__main__':main()

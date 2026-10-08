"""Reuse the existing licensed normalized corpus; enforce license/frozen boundaries."""
import json,hashlib,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
PUBLIC=ROOT.parent/'public-routing-data'
import importlib.util
_spec=importlib.util.spec_from_file_location('public_normalizer',PUBLIC/'src/normalize.py');_public=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(_public)
frozen,digest=_public.frozen,_public.digest
_FROZEN_IDS,_FROZEN_TEXTS=frozen()
ALLOWED={'nvidia/Open-SWE-Traces':'CC-BY-4.0','SWE-bench/SWE-smith-trajectories':'MIT'}
def features(row):
 # Explicit whitelist: labels, model identity, costs and outcome columns cannot enter.
 return {k:row.get(k) for k in ['task_id','task_key','task_text','repo','language','framework','split','repo_split']}
def validate(row):
 p=row['provenance']
 if ALLOWED.get(p['source'])!=p['license'] or len(p['revision'])!=40 or len(p['sha256'])!=64:raise ValueError('Unlicensed/unpinned data')
 ids,texts=_FROZEN_IDS,_FROZEN_TEXTS
 if row['task_id'] in ids or digest(' '.join(row['task_text'].split())) in texts:raise ValueError('Frozen task leakage')
 if row['labels']['resolved'] not in [0,1]:raise ValueError('Unknown outcome')
def load():
 rows=[json.loads(line) for line in (PUBLIC/'.cache/tasks.jsonl').read_text().splitlines()]
 for row in rows:validate(row)
 keys=[(r['task_key'],r['model']) for r in rows]
 if len(keys)!=len(set(keys)):raise ValueError('Duplicate task/model observation')
 for field,group in [('split','task_key'),('repo_split','repo')]:
  splits={}
  for r in rows:
   if r[group] in splits and splits[r[group]]!=r[field]:raise ValueError('Split leakage')
   splits[r[group]]=r[field]
 return rows
def main():
 rows=load();sources=json.loads((PUBLIC/'sources.json').read_text());audit=json.loads((PUBLIC/'normalization.json').read_text())
 for s in sources['included']:
  s['rowsUsed']=sum(r['provenance']['sha256']==s['sha256'] for r in rows)
  import pyarrow.parquet as pq
  s['rowsDownloaded']=pq.ParquetFile(PUBLIC/s['localFile']).metadata.num_rows
  s['rowsExcluded']=s['rowsDownloaded']-s['rowsUsed'];s['exclusionAccounting']='task-outcome view: unknown results, deduplication or conflicting repeats; detailed aggregate reasons in corpus.publicNormalization.audit'
 sources['upstreamSoftware']={'source':'ulab-uiuc/RouteProfile','revision':'618c7a4b35a07f8c7d04dbff77073fe0bc40114f','license':'MIT','url':'https://github.com/ulab-uiuc/RouteProfile'}
 sources['excluded'].append({'source':'RouteProfile bundled profile_data/route_data','reason':'external benchmark data license not verified; software MIT does not license external datasets','rowsUsed':0})
 (ROOT/'sources.json').write_text(json.dumps(sources,indent=2)+'\n')
 (ROOT/'artifacts/corpus.json').write_text(json.dumps({'uniqueTasks':len({r['task_key'] for r in rows}),'models':sorted({r['model'] for r in rows}),'outcomes':len(rows),'taskViewSha256':hashlib.sha256((PUBLIC/'.cache/tasks.jsonl').read_bytes()).hexdigest(),'publicNormalization':audit,'frozenExcluded':100},indent=2)+'\n')
if __name__=='__main__':main()

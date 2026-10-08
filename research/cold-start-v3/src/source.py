"""Pinned public metadata, exact joins, predeclared grouped V3 split."""
import json,re,urllib.request
from pathlib import Path
from collections import Counter,defaultdict
from dataclasses import dataclass
from types import MappingProxyType
from v2bridge import *
REPO='princeton-nlp/SWE-bench_Verified'
REVISION='c104f840cc67f8b6eec6f759ebc8b2693d585d4a'
ALLOWED=('instance_id','problem_statement','repo','base_commit','version','environment_setup_commit')
FORBIDDEN=('patch','test_patch','solution','prediction','ground_truth','raw_output','score','FAIL_TO_PASS','PASS_TO_PASS')
ROOT=Path(__file__).resolve().parents[1]

def issue_text(text):
    match=re.search(r'<issue>\s*(.*?)\s*</issue>',text,re.S)
    return match.group(1) if match else text

def semantic_hash(text):return digest(normalize(text))
def public_metadata(record):return {k:record[k] for k in ALLOWED if record.get(k) is not None}
@dataclass(frozen=True)
class TaskInput:
    text:str
    context:str
    metadata:Mapping

def routing_input(task,metadata):
    clean=public_metadata(metadata)
    return TaskInput(clean.get('problem_statement',issue_text(task.origin_query)),task.origin_query,MappingProxyType(clean))

def fetch_metadata(destination):
    import pyarrow.parquet as pq
    dest=Path(destination);dest.mkdir(parents=True,exist_ok=False)
    url=f'https://huggingface.co/datasets/{REPO}/resolve/{REVISION}/data/test-00000-of-00001.parquet'
    archive=dest/'official.parquet'
    with urllib.request.urlopen(url) as response,archive.open('xb') as f:
        while chunk:=response.read(1024*1024):f.write(chunk)
    # Select columns at the reader: gold patch, evaluator tests and solution fields never enter metadata.
    columns=pq.read_schema(archive).names
    records=pq.read_table(archive,columns=[k for k in ALLOWED if k in columns]).to_pylist()
    clean=[public_metadata(r) for r in records]
    (dest/'metadata.json').write_text(encoded(clean)+'\n')
    provenance={'repository':REPO,'revision':REVISION,'url':url,'archiveFingerprint':digest(archive.read_bytes()),'metadataFingerprint':digest((dest/'metadata.json').read_bytes()),'columns':list(ALLOWED),'records':len(clean),'paidCalls':0}
    (dest/'source.json').write_text(encoded(provenance)+'\n')
    return dest

def load_metadata(directory):
    p=Path(directory);source=json.loads((p/'source.json').read_text());content=(p/'metadata.json').read_bytes()
    if digest(content)!=source['metadataFingerprint']:raise ValueError('Metadata fingerprint mismatch')
    return [public_metadata(r) for r in json.loads(content)],source

def exact_join(rows,official):
    index=defaultdict(list)
    for r in official:
        clean=public_metadata(r)
        if isinstance(clean.get('problem_statement'),str):index[semantic_hash(clean['problem_statement'])].append(clean)
    metadata={};missing=[];ambiguous=[];methods=Counter()
    for r in rows:
        if r.task.dataset!='swe-bench':continue
        matches=index.get(semantic_hash(issue_text(r.task.origin_query)),[])
        if len(matches)==1:metadata[r.task.task_id]=matches[0];methods['exact_normalized_problem_statement_hash']+=1
        elif len(matches)>1:ambiguous.append(r.task.task_id)
        else:missing.append(r.task.task_id)
    return metadata,{'sweTasks':sum(r.task.dataset=='swe-bench' for r in rows),'joined':len(metadata),'missing':missing,'ambiguous':ambiguous,'joinMethods':dict(methods),'repos':dict(Counter(r['repo'] for r in metadata.values() if r.get('repo'))),'forbiddenFieldsRetained':[]}

def split(rows,metadata,seed=20261007):
    # Equivalent public issue statements are grouped even if wrappers/code listings differ.
    groups=defaultdict(list)
    for r in rows:groups[semantic_hash(routing_input(r.task,metadata.get(r.task.task_id,{})).text)].append(r)
    strata=defaultdict(list)
    for key,group in groups.items():strata[tuple(sorted({r.task.dataset for r in group}))].append(key)
    assignments={}
    for datasets,keys in sorted(strata.items()):
        keys.sort(key=lambda k:digest([seed,k]));n=len(keys);ntrain=max(1,int(.6*n));nval=max(1,int(.2*n)) if n>=3 else 0
        for i,key in enumerate(keys):assignments[key]='train' if i<ntrain else 'validation' if i<ntrain+nval else 'final_holdout'
    parts={p:tuple(sorted((r for k,group in groups.items() if assignments[k]==p for r in group),key=lambda r:r.task.task_id)) for p in ('train','validation','final_holdout')}
    if any(not v for v in parts.values()):raise ValueError('Insufficient split groups')
    manifest={'version':'v3-60-20-20','seed':seed,'proportions':[.6,.2,.2],'semanticQueryGroups':assignments,'parts':{p:[r.task.task_id for r in group] for p,group in parts.items()},'counts':{p:dict(Counter(r.task.dataset for r in group)) for p,group in parts.items()},'disclosure':'New model holdout, NOT pristine unobserved public evidence; V2 corpus/results have been examined.'}
    return TrainingEvidence(parts['train']),ValidationEvidence(parts['validation']),SealedEvaluation(parts['final_holdout']),manifest

def prepare(v2data,meta_directory,destination,seed=20261007):
    rows,source,audit=load_v2(v2data);official,meta_source=load_metadata(meta_directory);metadata,joins=exact_join(rows,official);train,val,holdout,manifest=split(rows,metadata,seed)
    out=Path(destination);out.mkdir(parents=True,exist_ok=False)
    plan={'outcomeSource':source,'outcomeFingerprint':source['canonicalFingerprint'],'v2DataDirectory':str(Path(v2data).resolve()),'metadataSource':meta_source,'metadataDirectory':str(Path(meta_directory).resolve()),'joins':joins,'metadata':metadata,'split':manifest}
    plan['fingerprint']=digest(plan)
    (out/'data-plan.json').write_text(encoded(plan)+'\n')
    return plan

def load_plan(path):
    plan=json.loads(Path(path).read_text());expected=plan.pop('fingerprint')
    if digest(plan)!=expected:raise ValueError('Data/split plan fingerprint mismatch')
    plan['fingerprint']=expected;rows,source,audit=load_v2(plan['v2DataDirectory'])
    if source!=plan['outcomeSource']:raise ValueError('V2 source changed')
    official,meta_source=load_metadata(plan['metadataDirectory'])
    if meta_source!=plan['metadataSource']:raise ValueError('Metadata source changed')
    metadata,joins=exact_join(rows,official)
    if metadata!=plan['metadata'] or joins!=plan['joins']:raise ValueError('Exact joins changed')
    train,val,holdout,manifest=split(rows,metadata,plan['split']['seed'])
    if manifest!=plan['split']:raise ValueError('Frozen split changed')
    return plan,train,val,holdout

def repo_folds(rows,metadata,nfolds=5,seed=20261007):
    byrepo=defaultdict(list)
    for r in rows:
        if r.task.dataset=='swe-bench' and metadata.get(r.task.task_id,{}).get('repo'):byrepo[metadata[r.task.task_id]['repo']].append(r)
    folds=[[] for _ in range(min(nfolds,len(byrepo)))];sizes=[0]*len(folds)
    for repo in sorted(byrepo,key=lambda r:(-len(byrepo[r]),digest([seed,r]))):
        i=min(range(len(folds)),key=lambda i:(sizes[i],i));folds[i].append(repo);sizes[i]+=len(byrepo[repo])
    return folds

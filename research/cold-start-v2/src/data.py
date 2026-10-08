"""Official release acquisition, selective safe extraction and explicit six-model audit."""
from __future__ import annotations
import json, tarfile, urllib.request, os, hashlib
from pathlib import Path, PurePosixPath
from collections import defaultdict, Counter
from types import MappingProxyType
from core import *
RELEASE_REPO='NPULH/LLMRouterBench'
PROJECT='https://github.com/ynulihao/LLMRouterBench'

def identify(path):
    parts=PurePosixPath(path).parts
    if '..' in parts or PurePosixPath(path).is_absolute(): raise ValueError('Unsafe archive path')
    try: i=next(i for i,p in enumerate(parts) if p in ('bench','bench-release'))
    except StopIteration: return None
    if len(parts)!=i+5 or not parts[-1].endswith('.json'): return None
    dataset=parts[i+1].lower().replace('_','-')
    dataset={'livecodebench':'livecodebench','swe-bench':'swe-bench','swebench':'swe-bench'}.get(dataset)
    reverse=SOURCE_MODEL_MAP
    if dataset not in DATASETS or parts[i+3].casefold() not in reverse:return None
    return dataset,parts[i+2],reverse[parts[i+3].casefold()]

def acquire(destination,archive=None,revision='main'):
    dest=Path(destination);dest.mkdir(parents=True,exist_ok=False)
    source={'project':PROJECT,'releaseRepository':RELEASE_REPO,'revision':None,'paidCalls':0,'modelIdentityProvenance':json.loads((Path(__file__).resolve().parents[1]/'fixtures/model-map-provenance.json').read_text())}
    if archive is None:
        info=json.load(urllib.request.urlopen(f'https://huggingface.co/api/datasets/{RELEASE_REPO}/revision/{revision}'))
        sha=info['sha']
        if len(sha)!=40:raise ValueError('No immutable release revision')
        source['revision']=sha;source['url']=f'https://huggingface.co/datasets/{RELEASE_REPO}/resolve/{sha}/bench-release.tar.gz'
        archive=dest/'bench-release.tar.gz'
        with urllib.request.urlopen(source['url']) as response,archive.open('xb') as output:
            while block:=response.read(1024*1024):output.write(block)
    else:
        archive=Path(archive).resolve();source['localArchive']=str(archive)
        if revision != 'main':
            if len(revision)!=40 or any(c not in '0123456789abcdef' for c in revision):raise ValueError('Local archive revision must be immutable SHA')
            source['revision']=revision;source['revisionProvenance']='caller-supplied immutable release revision; archive fingerprint independently recorded'
    h=hashlib.sha256()
    with Path(archive).open('rb') as f:
        while b:=f.read(1024*1024):h.update(b)
    source['archiveSha256']=h.hexdigest();source['archiveBytes']=Path(archive).stat().st_size
    raw=dest/'raw';raw.mkdir();files={};ignored=0
    with tarfile.open(archive,'r|gz') as bundle:
        for member in bundle:
            selected=identify(member.name)
            if not selected:ignored+=1;continue
            if not member.isfile() or member.size>250_000_000:raise ValueError('Selected member must be a bounded regular JSON file')
            target=raw/member.name;target.parent.mkdir(parents=True,exist_ok=True)
            content=bundle.extractfile(member).read()
            if target.exists():raise ValueError('Duplicate archive file path')
            target.write_bytes(content);files[member.name]=digest(content)
    if not files:raise ValueError('No matching six-model LCB/SWE files; never fall back to fixture')
    source['files']=files;source['ignoredArchiveMembers']=ignored;source['fingerprint']=digest(files)
    matrices,audit=import_raw(raw)
    (dest/'dataset-audit.json').write_text(encoded(audit)+'\n')
    canonical=''.join(encoded(matrix_json(r))+'\n' for r in matrices)
    (dest/'canonical.jsonl').write_text(canonical)
    source['canonicalFingerprint']=digest(canonical.encode());source['auditFingerprint']=digest(encoded(audit).encode())
    (dest/'source-manifest.json').write_text(encoded(source)+'\n')
    return source,audit

def import_raw(raw):
    raw=Path(raw);groups=defaultdict(list);audit={'models':dict(MODEL_MAP),'files':{},'snapshots':{},'benchmarks':{},'excluded':[],'scoreSemantics':'Pass@1 complete solve is score == 1; fractional values retain continuous score, never rethresholded'}
    for path in sorted(raw.rglob('*.json')):
        relative=path.relative_to(raw).as_posix();key=identify(relative)
        if key is None: continue
        payload=json.loads(path.read_text());records=payload.get('records')
        if payload.get('model_name') is not None and SOURCE_MODEL_MAP.get(str(payload['model_name']).casefold())!=key[2]:raise ValueError('Source model metadata disagrees with selected identity')
        if not isinstance(records,list):raise ValueError(f'Missing records in {relative}')
        fingerprint=digest(path.read_bytes());rows={};invalid={};duplicates=0;conflicts=0
        count={'records':len(records),'origin_query':0,'score':0,'cost':0,'prompt_tokens':0,'completion_tokens':0,'duplicateRecords':0,'conflictingRecords':0,'sourceFingerprint':fingerprint,'dataset':key[0],'split':key[1],'modelId':key[2],'scoreValues':[]}
        values=set()
        for position,r in enumerate(records):
            if not isinstance(r,dict):raise ValueError('Malformed record')
            for field in ('origin_query','score','cost','prompt_tokens','completion_tokens'):count[field]+=int(r.get(field) is not None)
            index=r.get('index');indexkey=encoded(index)
            if not isinstance(index,(str,int)) or isinstance(index,bool):raise ValueError(f'Invalid record index {relative}')
            if not isinstance(r.get('origin_query'),str) or not r['origin_query'].strip():invalid[indexkey]='missing origin_query';continue
            if r.get('score') is None:invalid[indexkey]='missing score';continue
            rawscore=r['score'];score=number(int(rawscore) if isinstance(rawscore,bool) else rawscore,'score',False)
            if score>1:raise ValueError(f'Unsupported score outside [0,1]: {relative}')
            values.add(score)
            normalized={'index':index,'query':r['origin_query'],'queryHash':digest(normalize(r['origin_query'])),'score':score,'cost':number(r.get('cost'),'cost'),'prompt_tokens':number(r.get('prompt_tokens'),'prompt_tokens'),'completion_tokens':number(r.get('completion_tokens'),'completion_tokens'),'prompt':r.get('prompt'),'position':position}
            for field in ('prompt_tokens','completion_tokens'):
                if normalized[field] is not None and not normalized[field].is_integer():raise ValueError('Noninteger token count')
            if indexkey in rows:
                duplicates+=1
                old=rows[indexkey]
                if (old['queryHash'],old['score'],old['cost'],old['prompt_tokens'],old['completion_tokens'])!=(normalized['queryHash'],score,normalized['cost'],normalized['prompt_tokens'],normalized['completion_tokens']):invalid[indexkey]='conflicting duplicate within snapshot';conflicts+=1
            else:rows[indexkey]=normalized
        count['duplicateRecords']=duplicates;count['conflictingRecords']=conflicts;count['scoreValues']=sorted(values)
        for index in invalid:rows.pop(index,None)
        audit['files'][relative]=count;groups[key].append((relative,fingerprint,rows,invalid))
    chosen={};bad=defaultdict(set)
    for key,snapshots in sorted(groups.items()):
        # Most valid records, then stable source path; never quality/cost-based snapshot picking.
        ranked=sorted(snapshots,key=lambda s:(-len(s[2]),s[0]));selected=ranked[0]
        by_index=defaultdict(set)
        for filename,fp,rows,invalid in snapshots:
            for idx in invalid:bad[key].add(idx)
            for idx,row in rows.items():by_index[idx].add((row['queryHash'],row['score']))
        for idx,versions in by_index.items():
            if len(versions)>1:bad[key].add(idx)
        chosen[key]=selected
        audit['snapshots']['/'.join(key)]={'available':[s[0] for s in ranked],'selected':selected[0],'policy':'maximum valid record coverage then source path; exclude any query/score conflict across snapshots','excludedConflictIndices':sorted(bad[key])}
    matrices=[]
    for dataset in DATASETS:
        candidates=defaultdict(dict);rawtasks=set();ambiguities=[]
        for (d,split,model),(filename,fp,rows,invalid) in chosen.items():
            if d!=dataset:continue
            for idx in set(rows)|set(invalid)|bad[(d,split,model)]:rawtasks.add((split,idx))
            for idx,row in rows.items():
                if idx not in bad[(d,split,model)]:candidates[(split,idx)][model]=(row,filename,fp)
        for split,idx in sorted(rawtasks):
            outcomes=candidates.get((split,idx),{})
            reason=None
            if len(outcomes)!=6:reason='incomplete six-model matrix / missing or conflicting record'
            elif len({r[0]['queryHash'] for r in outcomes.values()})!=1:reason='ambiguous origin_query across models'
            if reason:audit['excluded'].append({'dataset':dataset,'sourceSplit':split,'index':json.loads(idx),'reason':reason});continue
            first=outcomes[MODELS[0]][0];queryhash=first['queryHash'];taskid=f'{dataset}:{split}:{idx}:{queryhash}'
            task=Task(taskid,dataset,split,first['index'],first['query'],queryhash,MappingProxyType({'prompt':first['prompt'],'provenance':'origin_query only for features'}))
            observed={m:Outcome(taskid,m,r['score'],r['score']==1,r['cost'],r['prompt_tokens'],r['completion_tokens'],file,fp) for m,(r,file,fp) in outcomes.items()}
            matrices.append(Matrix(task,MappingProxyType(observed)))
        complete=sum(r.task.dataset==dataset for r in matrices)
        audit['benchmarks'][dataset]={'rawTasks':len(rawtasks),'completeSixModelTasks':complete,'excludedTasks':len(rawtasks)-complete,'availableSplits':sorted({k[1] for k in chosen if k[0]==dataset})}
    if any(audit['benchmarks'][d]['completeSixModelTasks']==0 for d in DATASETS):raise ValueError('Both required benchmarks must have complete six-model evidence')
    audit['byBenchmarkModel']={}
    fields=('records','origin_query','score','cost','prompt_tokens','completion_tokens','duplicateRecords','conflictingRecords')
    for dataset in DATASETS:
        audit['byBenchmarkModel'][dataset]={}
        for model in MODELS:
            selected={f:v for f,v in audit['files'].items() if v['dataset']==dataset and v['modelId']==model}
            audit['byBenchmarkModel'][dataset][model]={**{k:sum(v[k] for v in selected.values()) for k in fields},'availableSplits':sorted({v['split'] for v in selected.values()}),'sourceFiles':list(selected)}
    audit['taskCount']=len(matrices);audit['fingerprint']=digest({f:a['sourceFingerprint'] for f,a in audit['files'].items()})
    return matrices,audit

def load(directory):
    root=Path(directory);source=json.loads((root/'source-manifest.json').read_text());audit=json.loads((root/'dataset-audit.json').read_text())
    if 'auditFingerprint' in source and digest(encoded(audit).encode())!=source['auditFingerprint']:raise ValueError('Audit content fingerprint mismatch')
    if digest((root/'canonical.jsonl').read_bytes())!=source['canonicalFingerprint']:raise ValueError('Canonical fingerprint mismatch')
    rows=[from_json(json.loads(line)) for line in (root/'canonical.jsonl').read_text().splitlines()]
    for file,expected in source['files'].items():
        if digest((root/'raw'/file).read_bytes())!=expected:raise ValueError(f'Source fingerprint mismatch: {file}')
    if digest({f:a['sourceFingerprint'] for f,a in audit['files'].items()})!=audit['fingerprint']:raise ValueError('Audit fingerprint mismatch')
    return rows,source,audit

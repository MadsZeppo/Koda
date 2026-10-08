"""Synthetic mechanics only; real-data commands never fall back here."""
import sys,json
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
from source import *
from experiment import save

def build(destination):
    root=Path(destination);root.mkdir(parents=True,exist_ok=False);data=root/'v2-data';data.mkdir();raw=data/'raw';raw.mkdir();matrices=[];official=[];files={}
    for dataset in DATASETS:
        for i in range(40):
            text=f'SYNTHETIC {dataset} case {i}: {("Fix invalid API schema field error in parser.py", "Improve cache concurrency thread state", "Add a configuration test for missing types", "Refactor string array parsing function")[i%4]} while preserving existing behavior.'
            query='<issue>\n'+text+'\n</issue>\n<code>def parse(value): pass</code>' if dataset=='swe-bench' else text
            taskid=f'{dataset}:fixture:{i}:{digest(normalize(query))}';task=Task(taskid,dataset,'fixture',i,query,digest(normalize(query)),{})
            outcome={m:Outcome(taskid,m,float((i+j)%7<4),(i+j)%7<4,.001*(j+1),100.,20.,'fixture.json','fixture') for j,m in enumerate(MODELS)};matrices.append(Matrix(task,outcome))
            if dataset=='swe-bench':official.append({'instance_id':f'fixture-{i}','problem_statement':text,'repo':f'public/repo-{i%6}','base_commit':'fixture','version':'1.0','patch':'FORBIDDEN','test_patch':'FORBIDDEN'})
    canonical=''.join(encoded(matrix_json(r))+'\n' for r in matrices);(data/'canonical.jsonl').write_text(canonical);(data/'dataset-audit.json').write_text(encoded({'synthetic':True,'files':{},'fingerprint':digest({})}));(data/'source-manifest.json').write_text(encoded({'synthetic':True,'files':{},'canonicalFingerprint':digest(canonical.encode())}))
    meta=root/'metadata';meta.mkdir();content=encoded([public_metadata(r) for r in official])+'\n';(meta/'metadata.json').write_text(content);(meta/'source.json').write_text(encoded({'synthetic':True,'metadataFingerprint':digest(content.encode())}))
    plan=prepare(data,meta,root/'plan');freeze=root/'v2-frozen.json';cfg={'selectedConfig':{'feature':'word','minimum_n':1,'maximum_n':1,'k':5,'minimum_similarity':.05,'weight_power':1.,'prior_strength':5.},'modelMap':dict(MODEL_MAP),'createdAt':0};cfg['fingerprint']=digest({k:v for k,v in cfg.items() if k!='createdAt'});freeze.write_text(encoded(cfg))
    return root/'plan/data-plan.json',freeze

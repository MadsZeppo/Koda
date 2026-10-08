"""Explicit synthetic mechanics fixture. Never used by real-data commands."""
import json, sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
from core import *
from data import import_raw

def prepare(destination):
    root=Path(destination);root.mkdir(parents=True,exist_ok=False);raw=root/'raw'
    for dataset in DATASETS:
        for model_index,(model,label) in enumerate(MODEL_MAP.items()):
            records=[]
            for i in range(40):
                query=f'SYNTHETIC {dataset} task {i}: implement {("graph traversal", "string parsing", "array sorting", "tree search")[i%4]} preserving input and rejecting invalid values.'
                records.append({'index':i,'origin_query':query,'score':int((i+model_index)%7<4),'cost':.001*(model_index+1),'prompt_tokens':100+i,'completion_tokens':20,'prompt':'AUDIT WRAPPER ONLY','prediction':'NEVER A FEATURE','ground_truth':'NEVER A FEATURE'})
            path=raw/'bench-release'/dataset/'test'/label.lower()/'fixture.json';path.parent.mkdir(parents=True,exist_ok=True);path.write_text(encoded({'synthetic':True,'records':records}))
    rows,audit=import_raw(raw);canonical=''.join(encoded(matrix_json(r))+'\n' for r in rows)
    files={p.relative_to(raw).as_posix():digest(p.read_bytes()) for p in sorted(raw.rglob('*.json'))}
    (root/'canonical.jsonl').write_text(canonical);(root/'dataset-audit.json').write_text(encoded(audit))
    (root/'source-manifest.json').write_text(encoded({'synthetic':True,'paidCalls':0,'files':files,'canonicalFingerprint':digest(canonical.encode())}))
    return root
if __name__=='__main__':prepare(sys.argv[1])

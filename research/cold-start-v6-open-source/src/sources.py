"""Explicit frozen downloads after license inspection. No paid model APIs."""
import json,hashlib,urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
SOURCES={
 'acrouter':('LanceZPF/agent-as-a-router','e43839edb0d5d0a9feec2f7078019406ab4d64bd','MIT',['LICENSE','src/routing/trained_routers.py','src/routing/data_manager.py','README.md']),
 'twin':('CommonstackAI/TwinRouterBench','7cbb0deac8f697b5faa8489c309560e53d2ef088','Apache-2.0',['LICENSE','data/static/manifest.json','data/static/question_bank.jsonl','swerouter/router.py']),
 'swesmith':('SWE-bench/SWE-smith','9b74ac08118a85c39c356802f7961893af73e07f','MIT',['LICENSE']),
 'llmrouter':('ulab-uiuc/LLMRouter','338335d24e29c26f66b0f11dc9a3b50fe3e742c1','MIT',['LICENSE'])}
def acquire():
    cache=ROOT/'.cache';cache.mkdir(exist_ok=True);manifest=[]
    for key,(repo,rev,license,paths) in SOURCES.items():
        for asset in paths:
            destination=cache/key/asset;destination.parent.mkdir(parents=True,exist_ok=True)
            url=f'https://raw.githubusercontent.com/{repo}/{rev}/{asset}'
            if not destination.exists():destination.write_bytes(urllib.request.urlopen(url,timeout=60).read())
            raw=destination.read_bytes()
            if asset=='LICENSE':(ROOT/'licenses'/f'{key}.txt').write_bytes(raw)
            manifest.append({'project':key,'repository':repo,'commit':rev,'asset':asset,'url':url,'license':license,'sha256':hashlib.sha256(raw).hexdigest(),
                'use':'deferred; no trajectories imported' if key=='swesmith' else 'optional baseline deferred' if key=='llmrouter' else 'weak coding state/tier supervision' if asset.endswith('question_bank.jsonl') else 'methodological reference; no code copied'})
    (ROOT/'sources.json').write_text(json.dumps(manifest,indent=2)+'\n');return manifest
if __name__=='__main__':acquire()

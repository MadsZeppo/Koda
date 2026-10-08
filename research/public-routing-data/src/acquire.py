"""Immutable explicitly licensed sources only. Dataset downloads, never paid inference."""
import json,urllib.request,hashlib
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
SOURCES=[{'source':'nvidia/Open-SWE-Traces','revision':'f8fb5b3d2c787f85f8a00f5fe04fe3f1a11088ef','license':'CC-BY-4.0','subset':'v1.0/openhands/minimax_m25/swe-rebench-v2','file':'data/openhands/minimax_m25/swe-rebench-v2/train-00000-of-00018.parquet'}, {'source':'nvidia/Open-SWE-Traces','revision':'f8fb5b3d2c787f85f8a00f5fe04fe3f1a11088ef','license':'CC-BY-4.0','subset':'v1.0/openhands/qwen35_122b/swe-rebench-v2','file':'data/openhands/qwen35_122b/swe-rebench-v2/train-00000-of-00017.parquet'}, {'source':'SWE-bench/SWE-smith-trajectories','revision':'08e109b4a59eaeebf80e4675cd125d42e7ac99a4','license':'MIT','codeRevision':'9b74ac08118a85c39c356802f7961893af73e07f','subset':'tool','file':'data/tool-00000-of-00008.parquet'}]
EXCLUDED=[{'source':'SAILResearch/swe-agent-subset-selection','revision':'74bb414fbe7662a7cfdfd2e78b22fdecc53d0389','reason':'LICENSE placeholder; provenance lookup only; bundled data never ingested'}, {'source':'SWE-bench/experiments','revision':'40f164d5b8f1d249bf95a6df8b74b577fd8e519d','reason':'original SAIL multi-model source; no explicit repository/data license found; S3 data license not established'}, {'source':'NPULH/LLMRouterBench','revision':'0e5af1b84bf73437a01a1849c0f1d2468baa93fc','reason':'HF dataset has no license card/README; MIT router CODE does not license benchmark DATA'}, {'source':'CodeRouterBench','reason':'existing cached evidence is not accompanied by verified exact dataset license; exclude from new training pending verification'}]
def sha(path):
 h=hashlib.sha256()
 with path.open('rb') as f:
  while b:=f.read(1024*1024):h.update(b)
 return h.hexdigest()
def run():
 cache=ROOT/'.cache';cache.mkdir(exist_ok=True);manifest=[]
 previous=json.loads((ROOT/'sources.json').read_text())['included'] if (ROOT/'sources.json').exists() else []
 for i,s in enumerate(SOURCES):
  path=cache/f'source-{i}.parquet';url=f"https://huggingface.co/datasets/{s['source']}/resolve/{s['revision']}/{s['file']}"
  if not path.exists():
   tmp=path.with_suffix('.part');print('download',s['subset'],flush=True)
   with urllib.request.urlopen(url,timeout=120) as response,tmp.open('wb') as f:
    while b:=response.read(1024*1024):f.write(b)
   tmp.rename(path)
  checksum=sha(path)
  pinned=next((r for r in previous if r['source']==s['source'] and r['revision']==s['revision'] and r['file']==s['file']),None)
  if pinned and checksum!=pinned['sha256']:raise ValueError('Pinned dataset checksum mismatch; cache is not silently trusted')
  manifest.append({**s,'url':url,'localFile':str(path.relative_to(ROOT)),'sha256':checksum,'bytes':path.stat().st_size})
 (ROOT/'sources.json').write_text(json.dumps({'included':manifest,'excluded':EXCLUDED,'paidCalls':0,'sampling':'predeclared first shard for each of two OpenHands teachers plus SWE-smith tool; no outcome-dependent sampling'},indent=2)+'\n')
 print('sources ready',flush=True)
if __name__=='__main__':run()

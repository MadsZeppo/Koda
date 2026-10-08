"""Fetch only audited upstream SOFTWARE. Never fetch its bundled datasets."""
import hashlib,json,urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
COMMIT='618c7a4b35a07f8c7d04dbff77073fe0bc40114f'
FILES=['LICENSE','README.md','routeprofile/build_data_graph/build_task_graph.py','routeprofile/get_model_profile/training_free/emb_gnn_profile.py','routeprofile/get_model_profile/trainable/trainable_gnn_profile.py','routeprofile/routing_evaluation/GraphRouter.py','profile_data/get_data/get_queries_from_hf.py','route_data/get_data/get_routing_data.py']
def main():
 records=[]
 for name in FILES:
  path=ROOT/'.cache/upstream'/name;url=f'https://raw.githubusercontent.com/ulab-uiuc/RouteProfile/{COMMIT}/{name}'
  if not path.exists():path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(urllib.request.urlopen(url,timeout=60).read())
  records.append({'path':name,'url':url,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
 (ROOT/'licenses/RouteProfile-MIT.txt').write_bytes((ROOT/'.cache/upstream/LICENSE').read_bytes())
 (ROOT/'artifacts/upstream-audit.json').write_text(json.dumps({'commit':COMMIT,'codeLicense':'MIT','files':records,'bundledDataIngested':False},indent=2)+'\n')
if __name__=='__main__':main()

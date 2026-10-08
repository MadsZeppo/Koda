"""Prepare a future 24–32 anchor campaign, never execute it or supply hidden labels."""
import argparse,json
from normalize import ROOT,load,features,digest
from buildProfiles import TaskSpace,Decoder,anchor_order

def generate(model,count=32):
 if not model or count<24 or count>32:raise ValueError('Explicit model ID and 24–32 anchors required')
 rows=[r for r in load() if r['split']=='train'];unique={r['task_key']:r for r in sorted(rows,key=lambda r:(r['task_key'],r['model']))};tasks=[unique[k] for k in sorted(unique)]
 space=TaskSpace(rows);decoder=Decoder(rows,space);chosen=anchor_order(tasks,space,decoder.base)[:count]
 return {'version':1,'targetModel':model,'taskSpaceDigest':space.digest,'count':len(chosen),'paidCalls':0,'executionEnabled':False,'selection':'unsupervised task neighborhood × training-only predicted difficulty; never target outcomes','tasks':[{**features(r),'provenance':r['provenance'],'acceptanceChecks':None} for r in chosen],
  'limitations':['Public issue text is not a runnable Koda acceptance contract','Local repos/commits and independent acceptance checks must be supplied before any later paid campaign','No claim that this SWE subset covers frontend/database/migration or every requested risk/verification stratum']}
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--model',required=True);p.add_argument('--count',type=int,default=32);p.add_argument('--output',required=True);a=p.parse_args()
 from pathlib import Path
 Path(a.output).write_text(json.dumps(generate(a.model,a.count),indent=2)+'\n')

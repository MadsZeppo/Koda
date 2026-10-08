import unittest,copy,json
import numpy as np
from normalize import ROOT,load,validate,features,frozen
from buildProfiles import TaskSpace,Decoder,Profile,anchor_order
from evaluateColdStart import interval
class RouteProfileTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.rows=load();cls.models=sorted({r['model'] for r in cls.rows});cls.held=cls.models[0]
  cls.training=[r for r in cls.rows if r['model']!=cls.held and r['split']=='train'][:400]
  cls.space=TaskSpace(cls.training);cls.decoder=Decoder(cls.training,cls.space)
  cls.anchors=[r for r in cls.rows if r['model']==cls.held and r['split']=='train'][:32]
 def test_exact_identity(self):
  self.assertEqual(len(self.models),4);self.assertNotIn('claude-sonnet-4',self.models);self.assertNotIn('qwen3-235b-a22b-2507',self.models)
 def test_license_enforcement(self):
  r=copy.deepcopy(self.rows[0]);r['provenance']['license']='unknown'
  with self.assertRaises(ValueError):validate(r)
 def test_provenance(self):
  for row in self.rows:self.assertEqual(len(row['provenance']['revision']),40);self.assertIn(row['provenance']['license'],['MIT','CC-BY-4.0'])
 def test_frozen_exclusion(self):
  r=copy.deepcopy(self.rows[0]);r['task_id']=sorted(frozen()[0])[0]
  with self.assertRaises(ValueError):validate(r)
 def test_feature_outcome_future_isolation(self):
  a=features(self.rows[0]);r=copy.deepcopy(self.rows[0]);r.update(model='unknown',gold_patch='hidden',future='hidden',cost=999);r['labels']['resolved']=1-r['labels']['resolved']
  self.assertEqual(a,features(r));np.testing.assert_array_equal(self.space.encode([r]),self.space.encode([self.rows[0]]))
 def test_task_and_repo_grouping(self):
  for key,field in [('task_key','split'),('repo','repo_split')]:
   seen={}
   for row in self.rows:
    if row[key] in seen:self.assertEqual(seen[row[key]],row[field])
    seen[row[key]]=row[field]
 def test_leave_one_model_out(self):
  self.assertNotIn(self.held,self.decoder.profiles);self.assertFalse(set(r['task_key'] for r in self.rows if r['split']=='test')&set(self.space.training_keys))
 def test_deterministic_graph(self):
  b=TaskSpace(self.training);self.assertEqual(self.space.digest,b.digest)
  a=Profile(self.held,self.anchors,self.space,self.decoder.prior);b=Profile(self.held,self.anchors,self.space,self.decoder.prior);self.assertEqual(a.export(),b.export())
 def test_anchor_outcomes_not_used_in_selection(self):
  changed=copy.deepcopy(self.anchors)
  for r in changed:r['labels']['resolved']=1-r['labels']['resolved']
  a=anchor_order(self.anchors,self.space,self.decoder.base);b=anchor_order(changed,self.space,self.decoder.base)
  self.assertEqual([r['task_key'] for r in a],[r['task_key'] for r in b])
 def test_profile_update_frozen_encoder(self):
  before=self.space.digest;Profile(self.held,self.anchors[:4],self.space,self.decoder.prior);Profile(self.held,self.anchors,self.space,self.decoder.prior);self.assertEqual(before,self.space.digest)
 def test_sparse_uncertainty(self):
  radii=[interval(np.array([.5]),n,0)[2] for n in [0,4,8,16,32]];self.assertEqual(radii,sorted(radii,reverse=True));self.assertEqual(radii[0],1)
 def test_profile_rejects_other_model_and_test_labels(self):
  bad=copy.deepcopy(self.anchors[:1]);bad[0]['model']='different'
  with self.assertRaises(ValueError):Profile(self.held,bad,self.space,.5)
  bad=copy.deepcopy(self.anchors[:1]);bad[0]['split']='test'
  with self.assertRaises(ValueError):Profile(self.held,bad,self.space,.5)
 def test_production_baseline_unchanged(self):
  import hashlib
  from pathlib import Path
  baseline=json.loads((ROOT.parent/'public-routing-data/frozen-baseline.json').read_text())
  for path,sha in baseline.items():self.assertEqual(hashlib.sha256(Path(path).read_bytes()).hexdigest(),sha)
if __name__=='__main__':unittest.main()

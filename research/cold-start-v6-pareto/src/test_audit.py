import unittest,json,hashlib
from pathlib import Path
from audit import POOL,normalize,valid
class AuditTests(unittest.TestCase):
 def test_exact_pool_and_frozen_task_set(self):
  root=Path(__file__).resolve().parents[1];a=json.loads((root/'artifacts/coverage.json').read_text());p=json.loads((root.parent/'cold-start-v3/artifacts/data-plan/data-plan.json').read_text())
  self.assertEqual(a['requestedPool'],POOL);self.assertEqual(len(set(POOL)),12);self.assertEqual(a['taskIds']['final_holdout'],[t for t in p['split']['parts']['final_holdout'] if t.startswith('swe-bench:')]);self.assertEqual(len(a['taskIds']['final_holdout']),100)
 def test_bad_observations_never_fabricated(self):
  for r in [{'score':1,'cost':None,'origin_query':'x'},{'score':float('nan'),'cost':1,'origin_query':'x'},{'score':1,'cost':-1,'origin_query':'x'}]:self.assertFalse(valid(r))
 def test_hash_matches_canonical_identity(self):
  q=' x\n y ';self.assertEqual(normalize(q),'x y');self.assertNotEqual(hashlib.sha256(normalize(q).encode()).hexdigest(),hashlib.sha256(json.dumps(normalize(q),separators=(',',':')).encode()).hexdigest())
 def test_frozen_predictions_cover_same_tasks_and_only_training_costs(self):
  root=Path(__file__).resolve().parents[1];f=json.loads((root/'artifacts/frozen.json').read_text());d=json.loads((root/'artifacts/decisions.json').read_text());p=json.loads((root/'artifacts/predictor.json').read_text())
  self.assertEqual([r['taskId'] for r in d],f['testIds']);self.assertFalse(set(f['testIds'])&set(f['trainIds']));self.assertEqual(p['trainingIds'],f['trainIds']);self.assertEqual(p['models'],POOL);self.assertEqual(hashlib.sha256((root/'artifacts/decisions.json').read_bytes()).hexdigest(),f['decisionsSHA256']);self.assertFalse(p['calibratedKodaProbability'])
if __name__=='__main__':unittest.main()

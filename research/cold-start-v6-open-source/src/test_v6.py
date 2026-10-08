import unittest,json,sys,hashlib
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from twin import prefix_state,partition
ROOT=Path(__file__).resolve().parents[1]
class V6Tests(unittest.TestCase):
 def test_prefix_ignores_labels_and_future(self):
  r={'benchmark':'swebench','messages':[{'role':'assistant','tool_calls':[{'function':{'arguments':json.dumps({'command':'cat src/a.py'})}}]},{'role':'tool','content':'source'}]}
  x=prefix_state(r);self.assertEqual(x,prefix_state({**r,'target_tier':'high','total_steps':100000,'gold_patch':'cheat','evaluator_result':1}));self.assertEqual(x[1],1)
 def test_group_split_is_deterministic(self):
  self.assertEqual(partition('same-issue'),partition('same-issue'));self.assertIn(partition('another'),range(10))
 def test_failed_repeat_and_diff_are_observed_prefix_signals(self):
  r={'benchmark':'swebench','messages':[{'role':'assistant','tool_calls':[{'function':{'arguments':'{"command":"pytest tests/test_a.py"}'}}]}]*2+[{'role':'tool','content':'FAILED\ndiff --git a/a.py b/a.py'}]}
  x=prefix_state(r);self.assertEqual(x[5],1);self.assertEqual(x[8],1);self.assertEqual(x[4],2)
 def test_twin_groups_and_swe_evaluation_are_disjoint(self):
  a=json.loads((ROOT/'artifacts/pilot/twin-state-audit.json').read_text());self.assertEqual(a['groupOverlap'],0);self.assertEqual(a['evaluationInstanceOverlapTRAIN'],0);self.assertFalse(a['KodaAdequacyCalibration'])
 def test_exact_pool_and_saved_decisions(self):
  a=json.loads((ROOT/'artifacts/pilot/start-router.json').read_text());d=json.loads((ROOT/'artifacts/pilot/decisions.json').read_text())
  self.assertEqual(len(a['models']),6);self.assertEqual(len(set(a['models'])),6)
  for r in d:self.assertEqual([s['model'] for s in r['startScores']],a['models'])
 def test_training_excludes_final_tasks(self):
  a=json.loads((ROOT/'artifacts/pilot/train-inputs.json').read_text());b=json.loads((ROOT/'artifacts/pilot/evaluation-inputs.json').read_text());self.assertFalse({r['taskId'] for r in a}&{r['taskId'] for r in b})
  for r in a+b:self.assertFalse({'gold_patch','outcomes','test_patch','score','success'}&set(r))
 def test_simulated_recovery_is_not_verified_outcome(self):
  a=json.loads((ROOT/'artifacts/pilot/results.json').read_text());self.assertEqual(a['paidCalls'],0)
  for v in a['policies'].values():self.assertIsNone(v.get('verifiedKodaSolveRate'))
  self.assertFalse(a['policies']['StartRouter + TwinRouterBench StepRouter']['evaluated']);self.assertTrue(a['stop'])
 def test_python_export_matches_ts_encoder_and_mlp(self):
  # The persisted TS decisions must reproduce sklearn's exported multilabel MLP algebra.
  import numpy as np
  a=json.loads((ROOT/'artifacts/pilot/start-router.json').read_text());x=json.loads((ROOT/'artifacts/pilot/evaluation-features.json').read_text());d=json.loads((ROOT/'artifacts/pilot/decisions.json').read_text())
  h=np.maximum(0,np.array([r['features'] for r in x['rows']])@np.array(a['hidden'])+np.array(a['hiddenBias']));p=1/(1+np.exp(-(h@np.array(a['output'])+np.array(a['outputBias']))))
  self.assertTrue(np.allclose(p,[[s['expectedSuccess'] for s in r['startScores']] for r in d],atol=1e-12))
if __name__=='__main__':unittest.main()

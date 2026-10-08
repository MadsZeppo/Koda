import copy,unittest
from normalize import states,task_text,model_alias,split,frozen,ROOT
import json
from train import fit,encode
import numpy as np
class PublicTests(unittest.TestCase):
 def test_original_task_parser(self):
  self.assertEqual(task_text([{'role':'user','content':'wrapper<issue>Fix code</issue>'}]),'Fix code')
  self.assertEqual(task_text([{'role':'user','content':[{'type':'text','text':'hello'}]}]),'hello')
 def test_model_versions_remain_separate(self):
  self.assertNotEqual(model_alias('Qwen3.5-122B-A10B'),'qwen3-235b-a22b-2507')
 def test_prefix_causality(self):
  prefix=[{'role':'assistant','tool_calls':[{'function':{'name':'read_file','arguments':'a.py'}}]},{'role':'tool','content':'observed contents'}]
  extension=[{'role':'tool','content':'FUTURE ERROR gold_patch hidden_answer'}]
  self.assertEqual(list(states(prefix)),list(states(prefix+extension))[:1])
  self.assertNotIn('gold',str(list(states(prefix+extension))).lower())
 def test_unknown_interventions(self):
  r=list(states([{'role':'tool','content':'429 timed out'}]))[0]
  self.assertIsNone(r['labels']['escalation_usefulness']);self.assertTrue(r['observation']['infrastructure'])
 def test_splits_group_by_task(self):
  self.assertEqual(split('same-task'),split('same-task'));self.assertEqual(len(frozen()[0]),100)
 def test_outcome_blind_features(self):
  a={'task_text':'fix parser','language':'python','labels':{'resolved':0}}
  b=copy.deepcopy(a);b['labels']['resolved']=1;b['gold_patch']='answer';np.testing.assert_array_equal(encode(a),encode(b))
 def test_provenance_and_group_exclusions(self):
  rows=[json.loads(l) for l in (ROOT/'.cache/tasks.jsonl').read_text().splitlines()]
  ids,_=frozen();groups={}
  for r in rows:
   self.assertNotIn(r['task_id'],ids);self.assertIn(r['provenance']['license'],['MIT','CC-BY-4.0']);self.assertEqual(len(r['provenance']['revision']),40)
   if r['task_key'] in groups:self.assertEqual(groups[r['task_key']],r['split'])
   groups[r['task_key']]=r['split']
  self.assertEqual(len({(r['task_key'],r['model']) for r in rows}),len(rows))
 def test_deterministic_fit(self):
  x=np.array([[0,1],[1,0],[1,1],[0,0]]);y=[0,1,1,0]
  np.testing.assert_array_equal(fit(x,y).coef_,fit(x,y).coef_)
if __name__=='__main__':unittest.main()

import sys,unittest,tempfile,itertools
from pathlib import Path
from dataclasses import replace
import numpy as np
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'src'))
from experiment import *
from v2bridge import Task,Matrix,Outcome,normalize

class Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rows=[]
        for i in range(50):
            text=f'Fix API parser error case {i//2} in parser.py; preserve schema tests'
            task=Task(str(i),'swe-bench','synthetic',i,text,digest(normalize(text)),{})
            outs={m:Outcome(str(i),m,float((i+j)%9<5),(i+j)%9<5,.01*(6-j),100,20,'fixture','fixture') for j,m in enumerate(MODELS)}
            rows.append(Matrix(task,outs))
        cls.train=TrainingEvidence(tuple(rows));cls.val=ValidationEvidence(tuple(rows[:30]));cls.model=RiskPredictor(cls.train,{});cls.cal=RiskCalibration(cls.model,cls.val,{})
    def test_exact_six_models(self):self.assertEqual(len(MODELS),6)
    def test_reference_train_only(self):
        with self.assertRaises(TypeError):reference(self.val)
    def test_frontier_uses_train_quality(self):
        f,c,cheap=reference(self.train);y,_=matrices(self.train.rows);self.assertEqual(y[:,f].mean(),max(y.mean(axis=0)))
        self.assertTrue(all(c[j]<c[f] for j in cheap))
    def test_harmful_is_asymmetric(self):
        y=np.array([[1,0,1,1,1,1],[0,1,0,0,0,0],[1,1,0,0,0,0]]);h=harmful(y,0);self.assertEqual(h[:,1].tolist(),[1,0,0]);self.assertEqual(h[:,0].tolist(),[0,0,0])
    def test_train_guard(self):
        with self.assertRaises(TypeError):RiskPredictor(self.val,{})
    def test_calibration_guard(self):
        with self.assertRaises(TypeError):RiskCalibration(self.model,self.train,{})
    def test_prediction_accepts_no_outcome_matrix(self):
        with self.assertRaises(TypeError):self.model.predict(list(self.train.rows))
    def test_no_identifier_or_repo_feature(self):
        names=self.model.features.summary();self.assertFalse(names['repoIdentity']);self.assertFalse(any(x.startswith(('repo:','taskId')) for x in names['structuredSchema']))
    def test_grouped_cv_keeps_task_pairs(self):
        for fold in self.model.folds:
            a={semantic_hash(self.model.inputs[i].text) for i in fold['train']};b={semantic_hash(self.model.inputs[i].text) for i in fold['test']};self.assertFalse(a&b)
    def test_fold_determinism(self):self.assertEqual(self.model.folds,RiskPredictor(self.train,{}).folds)
    def test_task_ids_do_not_change_features(self):
        task=self.train.rows[0].task;inputs=[routing_input(task,{}),routing_input(replace(task,task_id='different'),{})];self.assertTrue(np.array_equal(*self.model.predict(inputs)))
    def test_unseen_outcomes_not_prediction_inputs(self):
        row=self.val.rows[0];changed=replace(row,outcomes={m:replace(o,success=not o.success,cost_usd=999) for m,o in row.outcomes.items()});p=self.model.predict([routing_input(row.task,{}),routing_input(changed.task,{})]);self.assertTrue(np.array_equal(*p))
    def test_val_labels_cannot_change_calibrated_point_predictions(self):
        changed=ValidationEvidence(tuple(replace(r,outcomes={m:replace(o,success=not o.success) for m,o in r.outcomes.items()}) for r in self.val.rows));cal=RiskCalibration(self.model,changed,{});p=self.model.predict([routing_input(self.val.rows[0].task,{})]);self.assertTrue(np.array_equal(self.cal.predict(p)[0],cal.predict(p)[0]))
    def test_sparse_bucket_rejects(self):
        tiny=RiskCalibration(self.model,ValidationEvidence(self.val.rows[:1]),{});_,b=tiny.predict(self.model.predict([routing_input(self.val.rows[0].task,{})]));self.assertTrue(all(b[0,j]==1 for j in self.model.candidates))
    def test_wilson_empty(self):self.assertEqual(upper(0,0),1.)
    def test_wilson_zero_events_not_zero_risk(self):self.assertGreater(upper(0,20),.03)
    def test_wilson_monotone(self):self.assertLess(upper(0,100),upper(5,100))
    def test_choose_cheapest_eligible(self):
        self.assertEqual(choose(np.array([[0,.01,.02,1,1,1]]),[6,3,1,2,4,5],0,.02).tolist(),[2])
    def test_fallback_not_lowest_risk_winner(self):
        self.assertEqual(choose(np.ones((1,6)),[6,3,1,2,4,5],0,.03).tolist(),[0])
    def test_zero_regret_no_positive_risk(self):
        self.assertEqual(choose(np.full((1,6),.0001),[6,3,1,2,4,5],0,0).tolist(),[0])
    def test_expensive_model_cannot_replace_frontier(self):
        self.assertEqual(choose(np.zeros((1,6)),[1,2,3,4,5,6],0,.03).tolist(),[0])
    def test_risk_validation(self):
        with self.assertRaises(ValueError):choose(np.zeros((1,5)),[1]*6,0,.03)
    def test_cost_per_solved_and_harm(self):
        y=np.array([[1,0,0,0,0,0],[0,1,0,0,0,0]]);c=np.ones((2,6));c[:,0]=5;s=score(y,c,np.array([1,1]),0);self.assertEqual(s['costPerSolved'],2);self.assertEqual(s['harmfulDowngrade'],.5);self.assertAlmostEqual(s['costSaving'],.8)
    def test_rescue_only_failed_nonfrontier(self):
        y=np.array([[1,0,0,0,0,0],[1,1,0,0,0,0]]);c=np.ones((2,6));c[:,0]=5;s=score(y,c,np.array([1,1]),0,True);self.assertEqual(s['totalCost'],7);self.assertEqual(s['solved'],2);self.assertEqual(s['finalHarmfulDowngrade'],0)
    def test_frontier_failure_not_retried(self):
        y=np.zeros((1,6));c=np.ones((1,6));self.assertEqual(score(y,c,np.array([0]),0,True)['totalCost'],1)
    def test_oracle_matches_bruteforce_fractional_objective(self):
        y=np.array([[1,1,0,0,0,0],[1,0,1,0,0,0],[0,1,0,0,0,0]]);c=np.array([[8,1,2,3,4,5],[8,1,2,3,4,5],[8,1,2,3,4,5]],float)
        idx,s=oracle(y,c,0,0);possible=[]
        for z in itertools.product(range(6),repeat=3):
            z=np.array(z);v=y[np.arange(3),z]
            if ((y[:,0]==1)&(v==0)).any() or v.sum()<2:continue
            possible.append(c[np.arange(3),z].sum()/v.sum())
        self.assertAlmostEqual(s['costPerSolved'],min(possible));self.assertEqual(s['harmfulDowngrade'],0)
    def test_missing_cost_rejected(self):
        row=self.train.rows[0];bad=replace(row,outcomes={m:replace(o,cost_usd=None) for m,o in row.outcomes.items()})
        with self.assertRaises(ValueError):matrices([bad])
    def test_no_overwrite_artifact(self):
        with tempfile.TemporaryDirectory() as t:
            p=Path(t)/'x';save(p,{});
            with self.assertRaises(FileExistsError):save(p,{})
if __name__=='__main__':unittest.main()

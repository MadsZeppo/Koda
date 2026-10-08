import sys,json,tempfile,unittest,copy
from pathlib import Path
from dataclasses import replace
import numpy as np
ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT/'src'),str(ROOT/'fixtures')]
from v2bridge import *
from source import *
from features import structured,TaskFeatureExtractor
from models import *
from calibration import *
from evaluation import evaluate,paired_interval,outcome_matrix
from experiment import *
from fixture import build

class V3Tests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.plan_path,self.v2freeze=build(self.root/'fixture');self.plan,self.train,self.val,self.test=load_plan(self.plan_path);self.metadata=self.plan['metadata'];self.inputs=[routing_input(r.task,self.metadata.get(r.task.task_id,{})) for r in self.val.rows];self.model=ModelSuccessPredictor(self.train,self.metadata,ModelConfig())
    def tearDown(self):self.temp.cleanup()
    def test_six_models_exact(self):
        self.assertEqual(len(MODELS),6)
        with self.assertRaises(ValueError):TrainingEvidence((replace(self.train.rows[0],outcomes={**self.train.rows[0].outcomes,'gpt-5-chat':None}),))
    def test_same_source_fingerprint(self):
        self.assertEqual(load_v2(self.plan['v2DataDirectory'])[1],self.plan['outcomeSource'])
    def test_source_change_rejected(self):
        path=Path(self.plan['v2DataDirectory'])/'canonical.jsonl';path.write_text(path.read_text()+'\n')
        with self.assertRaises(ValueError):load_plan(self.plan_path)
    def test_exact_metadata_join(self):
        self.assertEqual(self.plan['joins']['joined'],40);self.assertEqual(self.plan['joins']['missing'],[])
    def test_fuzzy_join_forbidden(self):
        rows=list(self.train.rows)+list(self.val.rows);r=next(r for r in rows if r.task.dataset=='swe-bench');text=issue_text(r.task.origin_query)
        joined,audit=exact_join([r],[{'instance_id':'one','problem_statement':text+' modified'}]);self.assertEqual(joined,{});self.assertEqual(audit['missing'],[r.task.task_id])
    def test_ambiguous_join_excluded(self):
        r=next(r for r in self.train.rows if r.task.dataset=='swe-bench');entry={'problem_statement':issue_text(r.task.origin_query),'repo':'public/a'};joined,audit=exact_join([r],[entry,entry]);self.assertEqual(joined,{});self.assertEqual(audit['ambiguous'],[r.task.task_id])
    def test_metadata_whitelist(self):
        d={'repo':'public/a','problem_statement':'request','patch':'secret','test_patch':'secret','score':1,'FAIL_TO_PASS':'secret','ground_truth':'secret'};self.assertEqual(public_metadata(d),{'repo':'public/a','problem_statement':'request'})
    def test_issue_text_wrapper_removed(self):self.assertEqual(issue_text('wrapper<issue>\nRequest\n</issue><code>old code</code>'),'Request')
    def test_original_query_identity_preserved(self):
        before=self.train.rows[0].task.origin_query;routing_input(self.train.rows[0].task,{});self.assertEqual(self.train.rows[0].task.origin_query,before)
    def test_split_deterministic(self):
        rows=load_v2(self.plan['v2DataDirectory'])[0];self.assertEqual(split(rows,self.metadata)[3],self.plan['split'])
    def test_split_six_outcomes_together(self):
        parts=self.plan['split']['parts'];ids=[i for group in parts.values() for i in group];self.assertEqual(len(ids),len(set(ids)));self.assertEqual(len(ids),80)
    def test_equivalent_wrapped_issues_grouped(self):
        rows=load_v2(self.plan['v2DataDirectory'])[0];a,b=rows[:2];r=replace(b,task=replace(b.task,origin_query=a.task.origin_query+'\n EXTRA CONTEXT'))
        # Both have the same exact public issue once metadata is attached.
        meta={a.task.task_id:{'problem_statement':'Same request'},b.task.task_id:{'problem_statement':'Same request'}};parts=split([a,r,*rows[2:]],meta)[3]['parts'];assigned={i:k for k,group in parts.items() for i in group};self.assertEqual(assigned[a.task.task_id],assigned[b.task.task_id])
    def test_final_holdout_not_training(self):
        self.assertFalse({r.task.task_id for r in self.train.rows}&{t.task_id for t in self.test.tasks})
    def test_repo_fold_separation(self):
        rows=load_v2(self.plan['v2DataDirectory'])[0];folds=repo_folds(rows,self.metadata);self.assertEqual(len([r for fold in folds for r in fold]),6)
        for held in folds:
            training=[r for r in self.train.rows if self.metadata.get(r.task.task_id,{}).get('repo') not in held];self.assertFalse({self.metadata[r.task.task_id]['repo'] for r in training if r.task.dataset=='swe-bench'}&set(held))
    def test_fitting_holdout_rejected(self):
        with self.assertRaises(TypeError):ModelSuccessPredictor(EvaluationGroundTruth(self.train.rows),self.metadata)
    def test_predict_matrix_rejected(self):
        with self.assertRaises(TypeError):self.model.predict([self.train.rows[0]])
    def test_structured_only_available_fields(self):
        t=self.inputs[0];d={**dict(t.metadata),'score':1,'prediction':'OUTPUT','patch':'SECRET','taskId':'SENTINEL'}
        self.assertEqual(structured(t),structured(TaskInput(t.text,t.context,d)))
    def test_no_task_identifier_features(self):
        t=self.inputs[0];features=self.model.features.transform([t]);other=TaskInput(t.text,t.context,{**dict(t.metadata),'instance_id':'OTHER-ID','base_commit':'OTHER','version':'OTHER'})
        self.assertEqual((features!=self.model.features.transform([other])).nnz,0)
    def test_repo_identity_not_primary(self):
        t=self.inputs[0];a=TaskInput(t.text,t.context,{'repo':'public/a'});b=TaskInput(t.text,t.context,{'repo':'public/b'});self.assertEqual(structured(a),structured(b));self.assertNotEqual(structured(a,True),structured(b,True))
    def test_features_no_solution_field(self):
        t=self.inputs[0];d={k:'FORBIDDEN OUTPUT' for k in FORBIDDEN};a=TaskInput(t.text,t.context,d);self.assertEqual(structured(a),structured(TaskInput(t.text,t.context,{})))
    def test_hidden_outcome_mutation_no_prediction_change(self):
        t=routing_input(self.test.tasks[0],self.metadata.get(self.test.tasks[0].task_id,{}));a=self.model.predict([t]);held=next(r for r in load_v2(self.plan['v2DataDirectory'])[0] if r.task.task_id==self.test.tasks[0].task_id);changed=replace(held,outcomes={m:replace(o,success=not o.success,score=1-o.score,cost_usd=999.) for m,o in held.outcomes.items()});b=self.model.predict([routing_input(changed.task,self.metadata.get(changed.task.task_id,{}))]);self.assertTrue(np.array_equal(a,b))
    def test_hidden_cost_not_feature_or_selection(self):
        t=self.inputs[0];a=self.model.predict([t]);b=self.model.predict([TaskInput(t.text,t.context,{**dict(t.metadata),'cost':999,'prompt_tokens':999})]);self.assertTrue(np.array_equal(a,b))
    def test_fit_deterministic(self):
        other=ModelSuccessPredictor(self.train,self.metadata,ModelConfig());self.assertTrue(np.array_equal(self.model.predict(self.inputs),other.predict(self.inputs)))
    def test_missing_features_deterministic(self):
        t=TaskInput('', '',{});self.assertTrue(np.array_equal(self.model.predict([t]),self.model.predict([t])))
    def test_each_model_same_schema(self):self.assertEqual(len(self.model.classifiers),6);self.assertEqual(set(self.model.priors),set(MODELS))
    def test_pairwise_labels_discard_ties(self):
        y=np.array([[1,0],[0,1],[0,0],[1,1]]);mask,target=pair_labels(y,0,1);self.assertEqual(mask.tolist(),[True,True,False,False]);self.assertEqual(target.tolist(),[1,0])
    def test_pairwise_empty_support_neutral(self):
        x=self.model.x[:0];c=BinaryPredictor().fit(x,[]);self.assertEqual(c.predict(self.model.x[:1]).tolist(),[.5])
    def test_pairwise_deterministic(self):
        a=PairwiseModelPredictor(self.model);b=PairwiseModelPredictor(self.model);pa,_=a.predict(self.inputs);pb,_=b.predict(self.inputs);self.assertTrue(np.array_equal(pa,pb));self.assertEqual(len(a.classifiers),15)
    def test_tie_break_deterministic(self):self.assertEqual([MODELS[j] for j in rank([.5]*6)],sorted(MODELS))
    def test_calibration_rejects_holdout(self):
        p=self.model.predict(self.inputs);y=truth_labels(self.val)
        with self.assertRaises(TypeError):calibrate(p,y,EvaluationGroundTruth(self.val.rows))
    def test_calibrator_no_test_inputs(self):
        p=self.model.predict(self.inputs);y=truth_labels(self.val);a,_,_=calibrate(p,y,self.val);b,_,_=calibrate(p,y,self.val);self.assertTrue(np.array_equal(apply(a,p),apply(b,p)))
    def test_calibration_oof_shape(self):
        p=self.model.predict(self.inputs);c,oof,search=calibrate(p,truth_labels(self.val),self.val);self.assertEqual(oof.shape,p.shape);self.assertEqual(len(search),6);self.assertNotIn('isotonic',[s['selected'] for s in search])
    def test_support_freeze_validation_only(self):
        p=self.model.predict(self.inputs)
        with self.assertRaises(TypeError):EvidenceSupportEstimator(self.model,self.inputs,p,truth_labels(self.val),EvaluationGroundTruth(self.val.rows))
    def test_ood_unseen_language_low(self):
        p=self.model.predict(self.inputs);support=EvidenceSupportEstimator(self.model,self.inputs,p,truth_labels(self.val),self.val);t=TaskInput('Fix network async task','public class Something in source.java',{});prob=self.model.predict([t]);_,low,bounds=support.predict([t],prob);self.assertTrue(low[0]);self.assertTrue(np.all(bounds>=0))
    def test_bounds_small_support_zero(self):
        p=self.model.predict(self.inputs);support=EvidenceSupportEstimator(self.model,self.inputs,p,truth_labels(self.val),self.val);_,_,b=support.predict(self.inputs,p);self.assertTrue(np.array_equal(b,np.zeros_like(b)))
    def test_paired_interval_exact_no_difference(self):
        d=paired_interval([1,0,1],[1,0,1]);self.assertEqual(d['lower'],0);self.assertEqual(d['upper'],0);self.assertTrue(d['paired'])
    def test_cluster_interval_available(self):
        d=paired_interval([1,0,1],[0,0,1],groups=['a','b','a']);self.assertEqual(d['resampling'],'repository clusters')
    def test_evaluator_rejects_unreleased_truth(self):
        with self.assertRaises(TypeError):outcome_matrix(self.train)
    def test_source_plan_tamper_rejected(self):
        p=self.plan_path;d=json.loads(p.read_text());d['split']['seed']=0;p.write_text(encoded(d))
        with self.assertRaises(ValueError):load_plan(p)
    def test_no_overwrite_data_plan(self):
        with self.assertRaises(FileExistsError):prepare(self.plan['v2DataDirectory'],self.plan['metadataDirectory'],self.plan_path.parent)
    def test_protocol_swe_primary(self):
        self.assertIn('SWE validation cross-fitted-calibrated solve first',PROTOCOL['selection']);self.assertEqual(PROTOCOL['split'],[.6,.2,.2]);self.assertEqual(PROTOCOL['paidCalls'],0)
    def test_end_to_end_freeze_and_independent_metrics(self):
        # Small grid exercises serialization and the exact production-independent evaluator.
        fits,selected,search=fit_all(self.train,self.val,self.metadata,[.1]);v2=baseline(self.train,self.val,self.v2freeze);preds=predictions(self.test.tasks,fits,selected,self.metadata,v2);out=output(self.root/'result');metrics=emit_score(out,preds,self.test,self.metadata,100)
        self.assertIn('Selected V3',metrics['groups']['swe-bench']['methods']);self.assertEqual(metrics['groups']['swe-bench']['methods']['Oracle']['qualityRegret']['mean'],0)
        for dataset,group in metrics['groups'].items():
            for model in MODELS:
                m=group['methods']['Always '+model];self.assertEqual(m['tasks'],group['methods']['Oracle']['tasks']);self.assertGreaterEqual(m['pairwiseDisagreementResolution'],0)
        joblib.dump(fits,self.root/'fits.joblib');again=joblib.load(self.root/'fits.joblib');self.assertEqual(predictions(self.test.tasks,fits,selected,self.metadata,v2),predictions(self.test.tasks,again,selected,self.metadata,v2))
    def test_v2_replay_config_not_retuned(self):
        v2=baseline(self.train,self.val,self.v2freeze);self.assertEqual(v2[0].config.k,5);self.assertEqual({r.task.task_id for g in v2[0].groups for r in g},{r.task.task_id for r in self.train.rows})
    def test_static_uses_train(self):
        for j,m in enumerate(MODELS):self.assertAlmostEqual(self.model.priors[m],sum(r.outcomes[m].success for r in self.train.rows)/len(self.train.rows))
    def test_known_regret_catastrophe_recall_cost(self):
        matrices=[];preds=[]
        for i,ys in enumerate(([1,0,0,0,0,0],[0,1,0,0,0,0],[0,0,0,0,0,0])):
            task=Task(str(i),'swe-bench','fixture',i,'task',digest('task'),{})
            matrices.append(Matrix(task,{m:Outcome(str(i),m,float(ys[j]),bool(ys[j]),1.,1.,1.,'fixture','fp') for j,m in enumerate(MODELS)}))
            policy=method([.8,.6,.4,.3,.2,.1],list(range(6)))
            preds.append({'taskId':str(i),'dataset':'swe-bench','methods':{'Selected V3':policy,'Frozen V2':policy,'Best static TRAIN':policy,'Dataset-aware static':policy}})
        result,errors=evaluate(preds,EvaluationGroundTruth(tuple(matrices)),{},'Selected V3',100);m=result['groups']['swe-bench']['methods']['Selected V3']
        self.assertAlmostEqual(m['solveRate'],1/3);self.assertAlmostEqual(m['catastrophicMiss'],1/3);self.assertEqual(m['catastrophicMissAmongDisagreement'],.5);self.assertEqual(m['costPerResolved'],3.);self.assertEqual(m['winnerSetRecall']['top2'],1.);self.assertEqual(m['winnerSetRecall']['top1'],.5);self.assertEqual(m['modelRecall'][MODELS[1]]['top2'],1);self.assertEqual(m['pairwise'][f'{MODELS[0]}|{MODELS[1]}']['resolutionAccuracy'],.5);self.assertEqual(len(errors['failures']),1)
    def test_feature_cache_exact_and_guarded(self):
        cache=(self.model.inputs,self.model.features,self.model.x);cached=ModelSuccessPredictor(self.train,self.metadata,ModelConfig(),feature_cache=cache);self.assertTrue(np.array_equal(cached.predict(self.inputs),self.model.predict(self.inputs)))
        with self.assertRaises(ValueError):ModelSuccessPredictor(self.train,self.metadata,ModelConfig(mode='structured'),feature_cache=cache)
    def test_no_production_imports(self):
        for p in (ROOT/'src').glob('*.py'):
            s=p.read_text();self.assertNotIn('openrouter.ai',s);self.assertNotIn('.koda/',s);self.assertNotIn('src/router',s)
if __name__=='__main__':unittest.main()

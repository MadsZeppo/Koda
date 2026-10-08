import copy, json, sys, tempfile, unittest
from dataclasses import replace
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT/'src'),str(ROOT/'fixtures')]
from core import *
from data import identify,load,import_raw
from routing import *
from evaluate import evaluate
from cli import validate,test_run,export,read_frozen,predict_all
from build_fixture import prepare

class ResearchTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.data=prepare(self.root/'data');self.rows,self.source,self.audit=load(self.data);self.train,self.val,self.test,self.manifest=split_rows(self.rows);self.router=ColdStartPredictor(self.train,Config(minimum_df=1))
    def tearDown(self):self.temp.cleanup()
    def change(self,dataset,model,fn):
        path=self.data/'raw'/'bench-release'/dataset/'test'/MODEL_MAP[model].lower()/'fixture.json';payload=json.loads(path.read_text());fn(payload['records']);path.write_text(encoded(payload))
    def test_exact_six_immutable(self):
        self.assertEqual(len(MODELS),6)
        with self.assertRaises(TypeError):MODEL_MAP['other']='Other'
        with self.assertRaises(ValueError):check_models([*MODELS,'gpt-5-chat'])
    def test_filter_other_models(self):
        self.assertIsNone(identify('bench-release/livecodebench/test/gpt-5-chat/x.json'))
        self.assertEqual(identify('bench-release/livecodebench/test/gpt-5/x.json')[2],'gpt-5')
    def test_filter_other_benchmarks(self):self.assertIsNone(identify('bench-release/humaneval/test/glm-4.6/x.json'))
    def test_archive_path_safety(self):
        for p in ('../bench-release/livecodebench/test/glm-4.6/x.json','/bench-release/livecodebench/test/glm-4.6/x.json'):
            with self.assertRaises(ValueError):identify(p)
    def test_fingerprints_deterministic(self):
        other=prepare(self.root/'other');self.assertEqual(load(other)[1],self.source)
    def test_tampered_source_rejected(self):
        self.change('livecodebench',MODELS[0],lambda r:r[0].update(score=1-r[0]['score']))
        with self.assertRaisesRegex(ValueError,'fingerprint'):load(self.data)
    def test_preserves_exact_query(self):
        for m in MODELS:self.change('livecodebench',m,lambda r:r[0].update(origin_query='  Literal\nX == Y  '))
        rows,_=import_raw(self.data/'raw');r=next(r for r in rows if r.task.dataset=='livecodebench' and r.task.record_index==0);self.assertEqual(r.task.origin_query,'  Literal\nX == Y  ')
    def test_missing_score_explicitly_excluded(self):
        self.change('livecodebench',MODELS[0],lambda r:r[0].pop('score'))
        rows,audit=import_raw(self.data/'raw');self.assertEqual(len(rows),79);self.assertEqual(len(audit['excluded']),1)
    def test_missing_model_excluded(self):
        self.change('livecodebench',MODELS[0],lambda r:r.pop(0));rows,audit=import_raw(self.data/'raw');self.assertEqual(len(rows),79);self.assertEqual(audit['benchmarks']['livecodebench']['excludedTasks'],1)
    def test_query_disagreement_excluded(self):
        self.change('livecodebench',MODELS[0],lambda r:r[0].update(origin_query='Materially different task'));_,a=import_raw(self.data/'raw');self.assertIn('ambiguous',a['excluded'][0]['reason'])
    def test_exact_duplicate_deduplicated(self):
        self.change('livecodebench',MODELS[0],lambda r:r.append(copy.deepcopy(r[0])));rows,a=import_raw(self.data/'raw');self.assertEqual(len(rows),80);self.assertEqual(sum(v['duplicateRecords'] for v in a['files'].values()),1)
    def test_conflicting_duplicate_excluded(self):
        self.change('livecodebench',MODELS[0],lambda r:r.append({**r[0],'score':1-r[0]['score']}));rows,a=import_raw(self.data/'raw');self.assertEqual(len(rows),79);self.assertEqual(sum(v['conflictingRecords'] for v in a['files'].values()),1)
    def test_conflicting_snapshots_excluded(self):
        p=self.data/'raw'/'bench-release'/'livecodebench'/'test'/MODEL_MAP[MODELS[0]].lower()/'fixture.json';d=json.loads(p.read_text());d['records'][0]['score']=1-d['records'][0]['score'];p.with_name('other.json').write_text(encoded(d));rows,a=import_raw(self.data/'raw');self.assertEqual(len(rows),79);self.assertTrue(any(v['excludedConflictIndices'] for v in a['snapshots'].values()))
    def test_nonbinary_score_preserved(self):
        self.change('livecodebench',MODELS[0],lambda r:r[0].update(score=.7));rows,_=import_raw(self.data/'raw');o=next(r for r in rows if r.task.dataset=='livecodebench' and r.task.record_index==0).outcomes[MODELS[0]];self.assertEqual(o.score,.7);self.assertFalse(o.success)
    def test_missing_cost_not_fabricated(self):
        self.change('livecodebench',MODELS[0],lambda r:r[0].pop('cost'));rows,_=import_raw(self.data/'raw');self.assertTrue(any(r.outcomes[MODELS[0]].cost_usd is None for r in rows))
    def test_split_determinism_and_stratification(self):
        self.assertEqual(split_rows(self.rows)[3],self.manifest)
        for part,counts in self.manifest['benchmarkCounts'].items():self.assertEqual(set(counts),set(DATASETS))
    def test_split_all_model_rows_together(self):
        ids=[i for ids in self.manifest['parts'].values() for i in ids];self.assertEqual(len(ids),len(set(ids)));self.assertEqual(len(ids),80)
    def test_duplicate_queries_never_cross_splits(self):
        a,b=self.rows[:2];duplicate=replace(b,task=replace(b.task,origin_query=a.task.origin_query,query_hash=a.task.query_hash));rows=[a,duplicate,*self.rows[2:]];train,val,test,manifest=split_rows(rows);parts={i:k for k,ids in manifest['parts'].items() for i in ids};self.assertEqual(parts[a.task.task_id],parts[b.task.task_id])
    def test_fit_rejects_test_and_validation(self):
        for evidence in (self.val,EvaluationGroundTruth(self.rows)):
            with self.assertRaises(TypeError):ColdStartPredictor(evidence,Config())
    def test_predict_rejects_matrix_or_oracle(self):
        with self.assertRaises(TypeError):self.router.predict(self.rows[0])
    def test_features_ignore_metadata(self):
        original=self.rows[0];changed=replace(original.task,metadata={'score':0,'ground_truth':'HIDDEN','prompt':'SECRET','taskId':'other'})
        self.assertEqual(self.router.featurizer.transform(original.task.origin_query),self.router.featurizer.transform(changed.origin_query))
    def test_hidden_outcomes_do_not_change_prediction_or_choice(self):
        task=self.test.tasks[0];before=self.router.predict(RoutingTask(task.origin_query));changed=[replace(r,outcomes={m:replace(o,score=1-o.score,cost_usd=999) for m,o in r.outcomes.items()}) for r in self.rows if r.task.task_id==task.task_id];self.assertTrue(changed);after=self.router.predict(RoutingTask(task.origin_query));self.assertEqual(before,after);self.assertEqual(operating_points(before,self.router,task.dataset),operating_points(after,self.router,task.dataset))
    def test_prior_train_only(self):
        for m in MODELS:self.assertAlmostEqual(self.router.priors[m],sum(r.outcomes[m].score for r in self.train.rows)/len(self.train.rows))
    def test_shrinkage_matches_formula(self):
        pred=self.router.predict(RoutingTask(self.val.rows[0].task.origin_query))
        for p in pred['models']:
            w=p['effectiveNeighborWeight'];expected=(5*p['globalPrior']+w*(p['localEstimate'] or 0))/(5+w);self.assertAlmostEqual(p['predictedSuccess'],expected)
    def test_deterministic_neighbors(self):
        q=RoutingTask(self.val.rows[0].task.origin_query);self.assertEqual(self.router.predict(q),ColdStartPredictor(self.train,Config(minimum_df=1)).predict(q))
    def test_self_neighbor_excluded(self):
        q=self.train.rows[0].task;pred=self.router.predict(RoutingTask(q.origin_query));self.assertNotIn(q.query_hash,[n['queryHash'] for n in pred['neighbors']])
    def test_ood_returns_low_evidence(self):
        pred=self.router.predict(RoutingTask('zzzzzz entirelyunseenxyz'));self.assertEqual(pred['status'],'LOW_EVIDENCE');self.assertTrue(all(p['localEstimate'] is None for p in pred['models']))
    def test_ties_deterministic(self):
        rows=TrainingEvidence(tuple(replace(r,outcomes={m:replace(o,score=1) for m,o in r.outcomes.items()}) for r in self.train.rows));pred=ColdStartPredictor(rows,Config()).predict(RoutingTask('unknown'));self.assertEqual(pred['ranking'],sorted(MODELS))
    def test_calibration_validation_only(self):
        with self.assertRaises(TypeError):fit_calibration(self.router,EvaluationGroundTruth(self.rows))
        self.assertEqual(fit_calibration(self.router,self.val),fit_calibration(self.router,self.val))
    def test_unsupported_calibration_is_low_with_zero_bound(self):
        cal=fit_calibration(self.router,self.val);pred=self.router.predict(RoutingTask(self.test.tasks[0].origin_query),cal);self.assertTrue(all(p['status']=='LOW_EVIDENCE' and p['lowerBound']==0 for p in pred['models']))
    def test_sealed_requires_persisted_predictions(self):
        preds=[{'taskId':t.task_id} for t in self.test.tasks];p=self.root/'predictions.jsonl';p.write_text('')
        with self.assertRaises(ValueError):self.test.release(p,preds)
        p.write_text(''.join(encoded(q)+'\n' for q in preds));self.assertIsInstance(self.test.release(p,preds),EvaluationGroundTruth)
    def test_tuning_rejects_test(self):
        with self.assertRaises(TypeError):tune(self.train,EvaluationGroundTruth(self.rows))
    def test_metric_oracle_regret_cost_pairs(self):
        cal=fit_calibration(self.router,self.val);preds=predict_all(self.router,self.test.tasks,cal);truth=EvaluationGroundTruth(tuple(r for r in self.rows if r.task.task_id in {t.task_id for t in self.test.tasks}));metrics,pairs=evaluate(preds,truth);m=metrics['overall'];self.assertEqual(m['policies']['Oracle POSTHOC']['meanRegret'],0);self.assertEqual(m['policies']['Oracle POSTHOC']['catastrophicMissRate'],0)
        for model in MODELS:
            o=m['policies']['Always '+model];expected=sum(r.outcomes[model].success for r in truth.rows);self.assertEqual(o['resolvedTasks'],expected);self.assertAlmostEqual(o['costPerResolved'],sum(r.outcomes[model].cost_usd for r in truth.rows)/expected);v=pairs['overall'][model][model];self.assertEqual(v['disagreementRate'],0);self.assertEqual(v['bothSucceed']+v['bothFail'],len(truth.rows))
    def test_artifact_freeze_and_no_overwrite(self):
        out=validate(self.data,self.root/'val');read_frozen(out/'frozen.json',self.data)
        with self.assertRaises(FileExistsError):validate(self.data,out)
        test_run(self.data,out/'frozen.json',self.root/'test')
        with self.assertRaises(FileExistsError):test_run(self.data,out/'frozen.json',self.root/'test2')
        dest=export(self.data,out/'frozen.json',self.root/'export');self.assertTrue((dest/'contextual-cold-start-v2-candidate.json.gz').exists())
    def test_frozen_tampering_rejected(self):
        out=validate(self.data,self.root/'val');p=out/'frozen.json';d=json.loads(p.read_text());d['seed']=3;p.write_text(encoded(d))
        with self.assertRaisesRegex(ValueError,'fingerprint'):read_frozen(p,self.data)
    def test_text_cache_matches_uncached_prediction(self):
        q=RoutingTask(self.val.rows[0].task.origin_query)
        self.router.predict(q)
        cached=ColdStartPredictor(self.train,Config(minimum_df=1),text_index=(self.router.featurizer,self.router.index))
        self.assertEqual(cached.predict(q),self.router.predict(q))
    def test_text_cache_rejects_different_features(self):
        with self.assertRaises(ValueError):ColdStartPredictor(self.train,Config(feature='char',minimum_n=3,maximum_n=5),text_index=(self.router.featurizer,self.router.index))
    def test_identical_substantive_artifacts(self):
        a=validate(self.data,self.root/'first');b=validate(self.data,self.root/'second')
        for name in ('predictions.jsonl','metrics.json','calibration.json','split-manifest.json','hyperparameter-search.json','ground-truth.jsonl'):
            self.assertEqual((a/name).read_bytes(),(b/name).read_bytes(),name)
        self.assertEqual(json.loads((a/'frozen.json').read_text())['fingerprint'],json.loads((b/'frozen.json').read_text())['fingerprint'])
    def test_calibration_global_fallback_remains_low_evidence(self):
        cal=fit_calibration(self.router,self.val)
        for model in MODELS:
            cal['models'][model]['buckets']={};cal['models'][model]['global']={'count':100,'positiveResidualQuantile':.1}
        pred=self.router.predict(RoutingTask(self.val.rows[0].task.origin_query),cal)
        self.assertTrue(all(p['status']=='LOW_EVIDENCE' for p in pred['models']))
    def test_canonical_outcome_identity_enforced(self):
        d=matrix_json(self.rows[0]);d['outcomes'][MODELS[0]]['modelId']='gpt-5-chat'
        with self.assertRaises(ValueError):from_json(d)
    def test_canonical_success_semantics_enforced(self):
        d=matrix_json(self.rows[0]);d['outcomes'][MODELS[0]]['success']=not d['outcomes'][MODELS[0]]['success']
        with self.assertRaises(ValueError):from_json(d)
    def test_canonical_invalid_cost_rejected(self):
        d=matrix_json(self.rows[0]);d['outcomes'][MODELS[0]]['costUsd']=-1
        with self.assertRaises(ValueError):from_json(d)
    def test_source_model_metadata_mismatch_rejected(self):
        p=self.data/'raw'/'bench-release'/'livecodebench'/'test'/MODEL_MAP[MODELS[0]].lower()/'fixture.json';d=json.loads(p.read_text());d['model_name']='gpt-5-chat';p.write_text(encoded(d))
        with self.assertRaises(ValueError):import_raw(self.data/'raw')
    def test_no_production_imports_or_history(self):
        for p in (ROOT/'src').glob('*.py'):
            s=p.read_text();self.assertNotIn('.koda/',s);self.assertNotIn('src/router/',s);self.assertNotIn('openrouter.ai',s)
if __name__=='__main__':unittest.main()

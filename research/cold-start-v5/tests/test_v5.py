import sys,json,tempfile,unittest,subprocess,threading,os
from pathlib import Path
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler,HTTPServer
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'src'))
from experiment import *
from v2bridge import Task,Matrix,Outcome,ValidationEvidence,normalize

class Tests(unittest.TestCase):
    def setUp(self):
        self.costs={m:float(i+1) for i,m in enumerate(MODELS)};self.frontier=MODELS[-1]
        self.answer={'ranking':[{'model':m,'estimated_frontier_gap_pp':0 if m==self.frontier else 1,'confidence':.8} for m in [self.frontier,*MODELS[:-1]]],'selected_model':MODELS[0],'reason':'known price with estimated one-point loss'}
        text='Fix parser exception in source.py while preserving tests';self.task=Task('hidden-id','swe-bench','fixture',0,text,digest(normalize(text)),{});self.row=Matrix(self.task,{m:Outcome('hidden-id',m,1.,True,.01,1,1,'fixture','fixture') for m in MODELS})
    def test_exact_six_models(self):self.assertEqual(set(IDS),set(MODELS));self.assertEqual(len(IDS),6)
    def test_judge_fixed(self):self.assertEqual(PROTOCOL['judge'],'openai/gpt-5-2025-08-07');self.assertEqual(PROTOCOL['reasoning'],'medium')
    def test_json_valid(self):self.assertEqual(validate(self.answer,self.costs,self.frontier),self.answer)
    def test_duplicate_models_rejected(self):
        self.answer['ranking'][1]=self.answer['ranking'][0].copy()
        with self.assertRaises(ValueError):validate(self.answer,self.costs,self.frontier)
    def test_extra_field_rejected(self):
        self.answer['secret']=True
        with self.assertRaises(ValueError):validate(self.answer,self.costs,self.frontier)
    def test_unknown_model_rejected(self):
        self.answer['ranking'][1]['model']='other-model'
        with self.assertRaises(ValueError):validate(self.answer,self.costs,self.frontier)
    def test_cheapest_eligible_required(self):
        self.answer['selected_model']=self.frontier
        with self.assertRaises(ValueError):validate(self.answer,self.costs,self.frontier)
    def test_bad_gap_rejected(self):
        self.answer['ranking'][0]['estimated_frontier_gap_pp']=float('nan')
        with self.assertRaises(ValueError):validate(self.answer,self.costs,self.frontier)
    def test_boolean_confidence_rejected(self):
        self.answer['ranking'][0]['confidence']=True
        with self.assertRaises(ValueError):validate(self.answer,self.costs,self.frontier)
    def test_frontier_zero(self):
        self.answer['ranking'][0]['estimated_frontier_gap_pp']=-1
        with self.assertRaises(ValueError):validate(self.answer,self.costs,self.frontier)
    def test_gap_operating_points(self):
        self.assertEqual(select(self.answer,self.costs,0),self.frontier);self.assertEqual(select(self.answer,self.costs,1),MODELS[0])
    def test_profiles_training_guard(self):
        with self.assertRaises(TypeError):profiles(ValidationEvidence((self.row,)),{}, {},self.frontier)
    def test_profiles_public_and_train_only(self):
        catalog={'data':[{'id':IDS[m],'description':'public description','pricing':{'prompt':'0.000001','completion':'0.000002'}} for m in MODELS]}
        p=profiles(TrainingEvidence((self.row,)),{'hidden-id':{'patch':'NEVER LEAK','test_patch':'NEVER LEAK','score':0}},catalog,self.frontier)
        self.assertNotIn('NEVER LEAK',encoded(p));self.assertEqual(len(p),6);self.assertTrue(all(x['train_tasks']==1 for x in p))
    def test_payload_no_outcomes_or_gold(self):
        b=payload(self.task,{'problem_statement':'Fix parser error','repo':'public/repo','patch':'GOLD','test_patch':'GOLD','evaluator_result':'GOLD'},[],self.frontier);s=encoded(b);self.assertNotIn('GOLD',s);self.assertNotIn('hidden-id',s);self.assertNotIn('score',b['messages'][1]['content'])
    def test_user_task_not_silently_truncated(self):
        from dataclasses import replace
        with self.assertRaises(ValueError):payload(replace(self.task,origin_query='x'*(PROTOCOL['maxInputBytes']+1)),{},[],self.frontier)
    def test_small_payload_strict_json(self):
        b=payload(self.task,{},[],self.frontier);self.assertTrue(b['response_format']['json_schema']['strict']);self.assertEqual(b['max_tokens'],4096);self.assertNotIn('temperature',b)
    def test_cost_reserves_output_reasoning(self):
        self.assertGreaterEqual(expected_cost(payload(self.task,{},[],self.frontier)),4096*.00001)
    def test_pilot_deterministic_no_outcomes(self):
        from dataclasses import replace
        tasks=[replace(self.task,task_id=str(i),origin_query=f'problem {i}') for i in range(20)];meta={str(i):{'repo':f'repo-{i%5}'} for i in range(20)}
        a=pilot_select(tasks,meta);self.assertEqual([t.task_id for t in a],[t.task_id for t in pilot_select(tasks[::-1],meta)]);self.assertEqual(len({meta[t.task_id]['repo'] for t in a}),5)
    def test_judge_cost_in_economics(self):
        e=economics([self.row],[MODELS[0]],self.frontier,.04);self.assertAlmostEqual(e['costPerSolved'],.05);self.assertAlmostEqual(e['costSaving'],-4)
    def test_zero_solved_cost_not_fake(self):
        from dataclasses import replace
        bad=replace(self.row,outcomes={m:replace(o,success=False) for m,o in self.row.outcomes.items()});self.assertIsNone(economics([bad],[MODELS[0]],self.frontier,.04)['costPerSolved'])
    def test_gate_rejects_frontier_everywhere(self):
        x={'Frontier':{'solved':3},'LLM 3pp':{'routedAway':0,'frontierRetained':1,'costPerSolved':.1}};x['Frontier']['costPerSolved']=.2;self.assertFalse(gate(x,True,0))
    def test_gate_rejects_instability(self):
        x={'Frontier':{'solved':3,'costPerSolved':.2},'LLM 3pp':{'routedAway':.3,'frontierRetained':1,'costPerSolved':.1}};self.assertFalse(gate(x,False,3));self.assertTrue(gate(x,True,3))
    def test_gate_rejects_harmful_quality(self):
        x={'Frontier':{'solved':3,'costPerSolved':.2},'LLM 3pp':{'routedAway':.3,'frontierRetained':.66,'costPerSolved':.1}};self.assertFalse(gate(x,True,3))
    def test_budget_blocks_before_transport(self):
        with tempfile.TemporaryDirectory() as td,patch('experiment.subprocess.run') as dispatch:
            with self.assertRaises(ValueError):judge(payload(self.task,{},[],self.frontier),Path(td)/'call',self.costs,self.frontier,{'reserved':0,'cap':0})
            dispatch.assert_not_called()
    def test_real_receipt_replaces_reservation_and_backend_env(self):
        raw={'model':PROTOCOL['judge'],'usage':{'cost':.004,'prompt_tokens':100,'completion_tokens':30},'choices':[{'finish_reason':'stop','message':{'content':encoded(self.answer)}}]};transport={'status':200,'body':encoded(raw),'elapsedMs':4,'transport':'backend'}
        completed=subprocess.CompletedProcess([],0,stdout=encoded(transport),stderr='')
        with tempfile.TemporaryDirectory() as td,patch('experiment.subprocess.run',return_value=completed) as dispatch,patch.dict(os.environ,{'OPENROUTER_API_KEY':'DO NOT USE','OPENAI_API_KEY':'DO NOT USE'}):
            budget={'reserved':0.,'actual':0.,'calls':0,'cap':1};a,c=judge(payload(self.task,{},[],self.frontier),Path(td)/'call',self.costs,self.frontier,budget);self.assertAlmostEqual(budget['reserved'],.004);self.assertAlmostEqual(budget['actual'],.004);env=dispatch.call_args.kwargs['env'];self.assertNotIn('OPENROUTER_API_KEY',env);self.assertNotIn('OPENAI_API_KEY',env);self.assertEqual(env['KODA_PROVIDER_MODE'],'backend')
    def test_missing_cost_stops(self):
        response={'status':200,'body':encoded({'usage':{},'choices':[]})}
        with tempfile.TemporaryDirectory() as td,patch('experiment.subprocess.run',return_value=subprocess.CompletedProcess([],0,encoded(response),'')):
            budget={'reserved':0.,'actual':0.,'calls':0,'cap':1}
            with self.assertRaises(ValueError):judge(payload(self.task,{},[],self.frontier),Path(td)/'call',self.costs,self.frontier,budget)
            self.assertGreater(budget['reserved'],0)
    def test_actual_shared_backend_transport_no_local_key(self):
        requests=[]
        class Handler(BaseHTTPRequestHandler):
            def do_POST(handler):
                requests.append({'path':handler.path,'auth':handler.headers.get('Authorization'),'body':json.loads(handler.rfile.read(int(handler.headers['content-length'])))})
                handler.send_response(200);handler.end_headers();handler.wfile.write(b'{"usage":{"cost":0}}')
            def log_message(*args):pass
        server=HTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();env=os.environ.copy();env.pop('OPENROUTER_API_KEY',None);env['KODA_PROVIDER_MODE']='backend';env['KODA_API_URL']=f'http://127.0.0.1:{server.server_port}'
        try:
            result=subprocess.run(['node','--import','tsx',str(ROOT/'src/request.ts')],input=encoded(payload(self.task,{},[],self.frontier)),text=True,capture_output=True,env=env,timeout=20);self.assertEqual(result.returncode,0,result.stderr);self.assertEqual(requests[0]['path'],'/v1/chat/completions');self.assertEqual(requests[0]['auth'],'Bearer koda-backend-client');self.assertEqual(requests[0]['body']['model'],PROTOCOL['judge'])
        finally:server.shutdown();server.server_close();thread.join()
if __name__=='__main__':unittest.main()

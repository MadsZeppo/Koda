import importlib.util,pathlib,unittest,tempfile,subprocess
HERE=pathlib.Path(__file__).parent
spec=importlib.util.spec_from_file_location('oracle',HERE/'oracle.py');oracle=importlib.util.module_from_spec(spec);spec.loader.exec_module(oracle)
class PreparationTests(unittest.TestCase):
    def test_native_build_reuse_invalidates_native_and_build_inputs(self):
        spec=importlib.util.spec_from_file_location('setup',HERE/'dependency_setup.py');setup=importlib.util.module_from_spec(spec);spec.loader.exec_module(setup)
        with tempfile.TemporaryDirectory() as folder:
            source=pathlib.Path(folder)/'source';candidate=pathlib.Path(folder)/'candidate';source.mkdir();candidate.mkdir()
            (source/'extension.so').write_bytes(b'frozen')
            for name in ['module.py','native.c','setup.py','requirements.txt']:
                (source/name).write_text('old');(candidate/name).write_text('old')
            tracked=['module.py','native.c','setup.py','requirements.txt']
            self.assertTrue(setup.native_build_reusable(source,candidate,tracked))
            (candidate/'module.py').write_text('new code');self.assertTrue(setup.native_build_reusable(source,candidate,tracked))
            for name in ['native.c','setup.py','requirements.txt']:
                (candidate/name).write_text('changed');self.assertFalse(setup.native_build_reusable(source,candidate,tracked));(candidate/name).write_text('old')
    def test_native_dependencies_are_copied_without_changing_tracked_unicode_source(self):
        spec=importlib.util.spec_from_file_location('materializer',HERE/'materialize_runtime.py')
        materializer=importlib.util.module_from_spec(spec);spec.loader.exec_module(materializer)
        with tempfile.TemporaryDirectory() as root:
            root=pathlib.Path(root);source=root/'source';target=root/'repo';source.mkdir();target.mkdir()
            subprocess.run(['git','init','-q',str(target)],check=True)
            tracked=target/'unicode-⊗.py';tracked.write_text('original source')
            subprocess.run(['git','add','.'],cwd=target,check=True)
            (source/'extension.so').write_bytes(b'frozen native dependency')
            (source/'unicode-⊗.py').write_text('must not copy source')
            copied=materializer.materialize(source,target,root/'archived-git')
            self.assertEqual(copied,['extension.so'])
            self.assertEqual(tracked.read_text(),'original source')
            self.assertEqual((target/'extension.so').read_bytes(),b'frozen native dependency')
            self.assertFalse((target/'.git').exists())
            self.assertTrue((root/'archived-git').exists())
    def test_official_parser_functions_load_without_sdk_imports(self):
        source="import nonexistent_sdk\nfrom elsewhere import TestSpec\ndef parser(log: TestSpec):\n    return {'case': TestStatus.PASSED.value} if re.search('ok',log) else {}\n"
        parser=oracle.load_parser(source)['parser']
        self.assertEqual(parser('ok'),{'case':'PASSED'})
        self.assertEqual(parser('failed'),{})
    def test_missing_official_test_blocks_acceptance_even_if_process_passed(self):
        report=oracle.summarize({'regression':'PASSED'},{'FAIL_TO_PASS':['regression'],'PASS_TO_PASS':['existing']},0)
        self.assertEqual(report['missing'],['existing'])
        self.assertEqual(report['failures'],['existing'])
    def test_preexisting_and_regression_tests_both_required(self):
        report=oracle.summarize({'regression':'PASSED','existing':'FAILED'},{'FAIL_TO_PASS':['regression'],'PASS_TO_PASS':['existing']},1)
        self.assertEqual(report['missing'],[])
        self.assertEqual(report['failures'],['existing'])
        passed=oracle.summarize({'regression':'PASSED','existing':'PASSED'},{'FAIL_TO_PASS':['regression'],'PASS_TO_PASS':['existing']},0)
        self.assertEqual(passed['failures'],[])
    def test_duplicate_summary_names_are_removed_only_when_unambiguous_and_consistent(self):
        self.assertEqual(oracle.canonicalize_statuses({'bug':'FAILED','bug (suite.Case)':'FAILED'}),{'bug (suite.Case)':'FAILED'})
        ambiguous={'bug':'FAILED','bug (suite.A)':'FAILED','bug (suite.B)':'FAILED'}
        self.assertEqual(oracle.canonicalize_statuses(ambiguous),ambiguous)
        conflicting={'bug':'FAILED','bug (suite.Case)':'PASSED'}
        self.assertEqual(oracle.canonicalize_statuses(conflicting),conflicting)
    def test_control_mapping_requires_real_failures_and_all_reference_tests_passing(self):
        self.assertEqual(oracle.derive_control_tests({'bug':'FAILED','old':'PASSED'},{'bug':'PASSED','old':'PASSED'}),{'FAIL_TO_PASS':['bug'],'PASS_TO_PASS':['old']})
        for baseline,positive in [({},{}),({'a':'PASSED'},{'a':'PASSED'}),({'a':'FAILED'},{'a':'FAILED'}),({'a':'FAILED','b':'ERROR'},{'a':'PASSED','b':'PASSED'}),({'a':'FAILED'},{'b':'PASSED'})]:
            with self.assertRaises(ValueError):oracle.derive_control_tests(baseline,positive)
if __name__=='__main__':unittest.main()

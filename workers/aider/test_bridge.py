import json
import os
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch
from bridge import CallGuard, StopExecution, run


class GuardTests(unittest.TestCase):
    def setUp(self):
        self.request = dict(model="openrouter/foo/bar", maxSteps=2, deadline=time.time()*1000+10000,
                            promptPricePerMillion=1, completionPricePerMillion=2, maxTokens=10000,
                            maxOutputTokens=100, budgetUsd=.1, requestTimeoutMs=1000, baseUrl="http://unused")
        self.state = dict(steps=0, tokens=0, costUsd=0, inputTokens=0, outputTokens=0)
        self.calls = []
        self.guard = CallGuard(self.request, self.state, lambda: None, self.complete)
        self.env = patch.dict(os.environ, OPENROUTER_API_KEY="not-a-paid-key")
        self.env.start()
        self.addCleanup(self.env.stop)

    def complete(self, **kwargs):
        self.calls.append(kwargs)
        return types.SimpleNamespace(usage={"prompt_tokens": 20, "completion_tokens": 10, "cost": .00004})

    def call(self, **kwargs):
        return self.guard(model=self.request["model"], messages=[{"role": "user", "content": "fix"}], **kwargs)

    def test_exact_model_and_steps(self):
        self.call()
        self.call()
        with self.assertRaises(StopExecution): self.call()
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.state["tokens"], 60)
        self.assertEqual(self.calls[0]["num_retries"], 0)
        with self.assertRaises(StopExecution): self.guard(model="openrouter/other/model")
        self.assertEqual(len(self.calls), 2)

    def test_budget_preflight_and_unknown_pricing(self):
        for change in ({"budgetUsd": 0}, {"maxTokens": 10}, {"promptPricePerMillion": None}):
            request = dict(self.request, **change)
            guard = CallGuard(request, self.state, lambda: None, self.complete)
            with self.assertRaises(StopExecution): guard(model=request["model"], messages=[])
        self.assertEqual(self.calls, [])

    def test_uncertain_provider_calls_consume_reservation(self):
        def failure(**kwargs): raise RuntimeError("HTTP 429 or 503 or timeout")
        guard = CallGuard(self.request, self.state, lambda: None, failure)
        with self.assertRaises(StopExecution) as error: guard(model=self.request["model"], messages=[])
        self.assertEqual(error.exception.kind, "provider")
        self.assertGreater(self.state["costUsd"], 0)
        self.assertGreater(self.state["tokens"], 0)

    def test_no_hidden_alternate_model_or_multiple_completions(self):
        self.call(fallbacks=["other"], model_list=["other"], n=20, max_completion_tokens=100000)
        self.assertNotIn("fallbacks", self.calls[0])
        self.assertNotIn("model_list", self.calls[0])
        self.assertNotIn("max_completion_tokens", self.calls[0])
        self.assertEqual(self.calls[0]["n"], 1)

    def test_native_and_unknown_settings(self):
        for known in (True, False):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root/"prompt").write_text("fix")
                request = dict(self.request, report=str(root/"report"), ledger=str(root/"ledger"), prompt=str(root/"prompt"))
                model = request["model"]
                models = types.ModuleType("aider.models")
                models.MODEL_SETTINGS = [types.SimpleNamespace(name=model, edit_format="diff")] if known else []
                models.MODEL_ALIASES = {model: "other/model"}
                main = types.ModuleType("aider.main")
                main.get_parser = lambda defaults, root: defaults
                llm = types.ModuleType("aider.llm")
                llm.litellm = types.SimpleNamespace(completion=self.complete)
                repomap = types.ModuleType("aider.repomap")
                repomap.RepoMap = type("RepoMap", (), {})
                def create(args, return_coder=False):
                    self.assertTrue(return_coder)
                    self.assertEqual(main.get_parser(["user config"], "."), [])
                    self.assertEqual(main.load_dotenv_files("."), [])
                    self.assertEqual(main.generate_search_path_list(".env", ".", "/tmp/explicit"), ["/tmp/explicit"])
                    self.assertNotIn(model, models.MODEL_ALIASES)
                    if known:
                        self.assertNotIn("--model-settings-file", args)
                        fmt = models.MODEL_SETTINGS[0].edit_format
                    else:
                        setting_path = Path(args[args.index("--model-settings-file")+1])
                        settings = json.loads(setting_path.read_text())[0]
                        self.assertEqual(settings["name"], model)
                        self.assertTrue(settings["use_repo_map"])
                        fmt = settings["edit_format"]
                    return types.SimpleNamespace(edit_format=fmt, num_malformed_responses=0,
                        run=lambda **kwargs: llm.litellm.completion(model=model, messages=[]))
                main.main = create
                aider = types.ModuleType("aider")
                aider.__version__ = "mock"
                aider.main, aider.models = main, models
                with patch.dict("sys.modules", {"aider": aider, "aider.main": main, "aider.models": models,
                                               "aider.llm": llm, "aider.repomap": repomap}):
                    self.assertEqual(run(request, []), 0)
                report = json.loads((root/"report").read_text())
                self.assertEqual(report["nativeSettings"], known)
                self.assertEqual(report["format"], "diff")

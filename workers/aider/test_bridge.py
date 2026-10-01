import json
import os
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from bridge import (
    CallGuard,
    StopExecution,
    _install_isolated_home,
    run,
)


class GuardTests(unittest.TestCase):
    def setUp(self):
        self.request = dict(
            model="openrouter/foo/bar",
            maxSteps=2,
            deadline=time.time()
            * 1000
            + 10000,
            promptPricePerMillion=1,
            completionPricePerMillion=2,
            maxTokens=10000,
            maxOutputTokens=100,
            budgetUsd=0.1,
            requestTimeoutMs=1000,
            baseUrl="http://unused",
        )

        self.state = dict(
            steps=0,
            tokens=0,
            costUsd=0,
            inputTokens=0,
            outputTokens=0,
        )

        self.calls = []

        self.guard = CallGuard(
            self.request,
            self.state,
            lambda: None,
            self.complete,
            self.token_counter,
        )

        self.env = patch.dict(
            os.environ,
            OPENROUTER_API_KEY=(
                "not-a-paid-key"
            ),
        )

        self.env.start()

        self.addCleanup(
            self.env.stop
        )

    def token_counter(
        self,
        *,
        model,
        messages,
        **_kwargs,
    ):
        self.assertIn(
            model,
            (
                "openrouter/foo/bar",
                "foo/bar",
            ),
        )

        # Deterministic fake tokenizer for tests.
        # Deliberately much smaller than raw byte length.
        text = json.dumps(
            messages,
            ensure_ascii=False,
        )

        return max(
            1,
            len(text) // 4,
        )

    def complete(self, **kwargs):
        self.calls.append(kwargs)

        return types.SimpleNamespace(
            usage={
                "prompt_tokens": 20,
                "completion_tokens": 10,
                "cost": 0.00004,
            }
        )

    def call(self, **kwargs):
        return self.guard(
            model=self.request["model"],
            messages=[
                {
                    "role": "user",
                    "content": "fix",
                }
            ],
            **kwargs,
        )

    def test_exact_model_and_steps(self):
        self.call()
        self.call()

        with self.assertRaises(
            StopExecution
        ) as error:
            self.call()

        self.assertEqual(
            error.exception.kind,
            "attempt_step_exhausted",
        )

        self.assertEqual(
            len(self.calls),
            2,
        )

        self.assertEqual(
            self.state[
                "inputTokens"
            ],
            40,
        )

        self.assertEqual(
            self.state[
                "outputTokens"
            ],
            20,
        )

        self.assertEqual(
            self.calls[0][
                "num_retries"
            ],
            0,
        )

        with self.assertRaises(
            StopExecution
        ) as error:
            self.guard(
                model=(
                    "openrouter/"
                    "other/model"
                ),
                messages=[],
            )

        self.assertEqual(
            error.exception.kind,
            "model_substitution",
        )

        self.assertEqual(
            len(self.calls),
            2,
        )

    def test_budget_preflight_and_unknown_pricing(
        self,
    ):
        cases = (
            (
                {
                    "budgetUsd": 0,
                },
                "attempt_budget_exhausted",
            ),
            (
                {
                    "maxTokens": 1,
                    "contextLength": 1,
                },
                "context_preflight_exhausted",
            ),
            (
                {
                    "promptPricePerMillion":
                        None,
                },
                "pricing_unavailable",
            ),
        )

        for change, expected in cases:
            request = dict(
                self.request,
                **change,
            )

            state = dict(
                steps=0,
                tokens=0,
                costUsd=0,
                inputTokens=0,
                outputTokens=0,
            )

            guard = CallGuard(
                request,
                state,
                lambda: None,
                self.complete,
                self.token_counter,
            )

            before = len(
                self.calls
            )

            with self.assertRaises(
                StopExecution
            ) as error:
                guard(
                    model=request[
                        "model"
                    ],
                    messages=[],
                )

            self.assertEqual(
                error.exception.kind,
                expected,
            )

            self.assertEqual(
                len(self.calls),
                before,
            )

    def test_large_aider_prompt_does_not_use_bytes_as_tokens(
        self,
    ):
        """
        Regression test for the real failure:

        the previous implementation counted every UTF-8 byte as one token,
        so an ordinary Aider system/repo-map prompt could consume an 8k token
        budget before any provider call was made.
        """
        request = dict(
            self.request,
            maxTokens=8192,
            maxOutputTokens=1000,
            budgetUsd=1,
        )

        state = dict(
            steps=0,
            tokens=0,
            costUsd=0,
            inputTokens=0,
            outputTokens=0,
        )

        calls = []

        def tokenizer(
            *,
            model,
            messages,
            **_kwargs,
        ):
            self.assertIn(
                model,
                (
                    "openrouter/foo/bar",
                    "foo/bar",
                ),
            )

            return 4200

        def complete(**kwargs):
            calls.append(
                kwargs
            )

            return types.SimpleNamespace(
                usage={
                    "prompt_tokens":
                        4100,
                    "completion_tokens":
                        600,
                    "cost": 0.01,
                }
            )

        guard = CallGuard(
            request,
            state,
            lambda: None,
            complete,
            tokenizer,
        )

        huge_prompt = (
            "repository context\n"
            + ("x" * 30000)
        )

        guard(
            model=request["model"],
            messages=[
                {
                    "role": "system",
                    "content":
                        huge_prompt,
                }
            ],
        )

        self.assertEqual(
            len(calls),
            1,
        )

        self.assertEqual(
            calls[0][
                "max_tokens"
            ],
            1000,
        )

        self.assertEqual(
            state[
                "inputTokens"
            ],
            4100,
        )

        self.assertEqual(
            state[
                "outputTokens"
            ],
            600,
        )

    def test_total_attempt_budget_counts_prompt_and_completion(
        self,
    ):
        request = dict(
            self.request,
            maxTokens=5000,
            maxOutputTokens=1000,
            budgetUsd=1,
        )

        state = dict(
            steps=0,
            tokens=0,
            costUsd=0,
            inputTokens=0,
            outputTokens=0,
        )

        calls = []

        def tokenizer(
            *,
            model,
            messages,
            **_kwargs,
        ):
            self.assertIn(
                model,
                (
                    "openrouter/foo/bar",
                    "foo/bar",
                ),
            )

            return 4200

        def complete(**kwargs):
            calls.append(kwargs)

            return types.SimpleNamespace(
                usage={
                    "prompt_tokens": 4100,
                    "completion_tokens": 600,
                    "cost": 0.01,
                }
            )

        guard = CallGuard(
            request,
            state,
            lambda: None,
            complete,
            tokenizer,
        )

        guard(
            model=request["model"],
            messages=[
                {
                    "role": "user",
                    "content": "large prompt",
                }
            ],
        )

        # 5000 total - 4200 current prompt = at most 800 output.
        self.assertEqual(
            calls[0]["max_tokens"],
            800,
        )

        # Provider truth replaces the reservation:
        # 4100 prompt + 600 completion = 4700 consumed.
        self.assertEqual(
            state["tokens"],
            4700,
        )

        # A second 4200-token prompt cannot fit in the same
        # 5000-token whole-attempt allowance.
        with self.assertRaises(
            StopExecution
        ) as error:
            guard(
                model=request["model"],
                messages=[
                    {
                        "role": "user",
                        "content": "second call",
                    }
                ],
            )

        self.assertEqual(
            error.exception.kind,
            "attempt_budget_exhausted",
        )

        self.assertEqual(
            len(calls),
            1,
        )


    def test_unknown_tokenizer_uses_bounded_fallback(
        self,
    ):
        request = dict(
            self.request,
            maxTokens=8192,
            maxOutputTokens=1000,
            budgetUsd=1,
        )

        state = dict(
            steps=0,
            tokens=0,
            costUsd=0,
            inputTokens=0,
            outputTokens=0,
        )

        calls = []

        def broken_tokenizer(
            **_kwargs,
        ):
            raise RuntimeError(
                "unknown tokenizer"
            )

        def complete(**kwargs):
            calls.append(
                kwargs
            )

            return types.SimpleNamespace(
                usage={
                    "prompt_tokens":
                        3000,
                    "completion_tokens":
                        500,
                    "cost": 0.01,
                }
            )

        guard = CallGuard(
            request,
            state,
            lambda: None,
            complete,
            broken_tokenizer,
        )

        guard(
            model=request["model"],
            messages=[
                {
                    "role": "user",
                    "content":
                        "x" * 12000,
                }
            ],
        )

        self.assertEqual(
            len(calls),
            1,
        )

    def test_uncertain_provider_calls_consume_reservation(
        self,
    ):
        def failure(**kwargs):
            raise RuntimeError(
                "HTTP 429 or 503 "
                "or timeout"
            )

        state = dict(
            steps=0,
            tokens=0,
            costUsd=0,
            inputTokens=0,
            outputTokens=0,
        )

        guard = CallGuard(
            self.request,
            state,
            lambda: None,
            failure,
            self.token_counter,
        )

        with self.assertRaises(
            StopExecution
        ) as error:
            guard(
                model=self.request[
                    "model"
                ],
                messages=[],
            )

        self.assertEqual(
            error.exception.kind,
            "provider",
        )

        self.assertGreater(
            state["costUsd"],
            0,
        )

        self.assertGreater(
            state["tokens"],
            0,
        )

    def test_no_hidden_alternate_model_or_multiple_completions(
        self,
    ):
        self.call(
            fallbacks=["other"],
            model_list=["other"],
            n=20,
            max_completion_tokens=
                100000,
        )

        self.assertNotIn(
            "fallbacks",
            self.calls[0],
        )

        self.assertNotIn(
            "model_list",
            self.calls[0],
        )

        self.assertNotIn(
            "max_completion_tokens",
            self.calls[0],
        )

        self.assertEqual(
            self.calls[0]["n"],
            1,
        )

    def test_isolated_home_stays_inside_attempt_scratch(
        self,
    ):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(
                directory
            )

            report = (
                root
                / "scratch"
                / "report.json"
            )

            report.parent.mkdir(
                parents=True
            )

            request = {
                "report":
                    str(report)
            }

            original_home = (
                os.environ.get(
                    "HOME"
                )
            )

            _install_isolated_home(
                request
            )

            expected_home = (
                report.parent
                / "home"
            )

            self.assertEqual(
                os.environ["HOME"],
                str(expected_home),
            )

            self.assertTrue(
                expected_home.exists()
            )

            self.assertTrue(
                os.environ[
                    "XDG_CACHE_HOME"
                ].startswith(
                    str(
                        report.parent
                    )
                )
            )

            self.assertTrue(
                os.environ[
                    "XDG_CONFIG_HOME"
                ].startswith(
                    str(
                        report.parent
                    )
                )
            )

            self.assertNotIn(
                "AIDER_CONFIG_FILE",
                os.environ,
            )

            if original_home is not None:
                os.environ[
                    "HOME"
                ] = original_home

    def test_native_and_unknown_settings(
        self,
    ):
        for known in (
            True,
            False,
        ):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(
                    directory
                )

                (
                    root / "prompt"
                ).write_text("fix")

                request = dict(
                    self.request,
                    report=str(
                        root
                        / "report"
                    ),
                    ledger=str(
                        root
                        / "ledger"
                    ),
                    prompt=str(
                        root
                        / "prompt"
                    ),
                )

                model = request[
                    "model"
                ]

                models = types.ModuleType(
                    "aider.models"
                )

                models.MODEL_SETTINGS = (
                    [
                        types.SimpleNamespace(
                            name=model,
                            edit_format=
                                "diff",
                        )
                    ]
                    if known
                    else []
                )

                models.MODEL_ALIASES = {
                    model:
                        "other/model"
                }

                main = types.ModuleType(
                    "aider.main"
                )

                main.get_parser = (
                    lambda defaults,
                    root:
                    defaults
                )

                llm = types.ModuleType(
                    "aider.llm"
                )

                fake_litellm = (
                    types.SimpleNamespace(
                        completion=
                            self.complete,
                        token_counter=
                            self.token_counter,
                    )
                )

                llm.litellm = (
                    fake_litellm
                )

                repomap = (
                    types.ModuleType(
                        "aider.repomap"
                    )
                )

                repomap.RepoMap = type(
                    "RepoMap",
                    (),
                    {},
                )

                def create(
                    args,
                    return_coder=False,
                ):
                    self.assertTrue(
                        return_coder
                    )

                    self.assertEqual(
                        main.get_parser(
                            [
                                "user config"
                            ],
                            ".",
                        ),
                        [],
                    )

                    self.assertEqual(
                        main.load_dotenv_files(
                            "."
                        ),
                        [],
                    )

                    self.assertEqual(
                        main.generate_search_path_list(
                            ".env",
                            ".",
                            "/tmp/explicit",
                        ),
                        [
                            "/tmp/explicit"
                        ],
                    )

                    self.assertNotIn(
                        model,
                        models.MODEL_ALIASES,
                    )

                    if known:
                        self.assertNotIn(
                            "--model-settings-file",
                            args,
                        )

                        fmt = (
                            models
                            .MODEL_SETTINGS[0]
                            .edit_format
                        )
                    else:
                        setting_path = Path(
                            args[
                                args.index(
                                    "--model-settings-file"
                                )
                                + 1
                            ]
                        )

                        settings = (
                            json.loads(
                                setting_path
                                .read_text()
                            )[0]
                        )

                        self.assertEqual(
                            settings[
                                "name"
                            ],
                            model,
                        )

                        self.assertTrue(
                            settings[
                                "use_repo_map"
                            ]
                        )

                        fmt = settings[
                            "edit_format"
                        ]

                    return (
                        types.SimpleNamespace(
                            edit_format=fmt,
                            num_malformed_responses=0,
                            run=lambda **kwargs:
                                llm.litellm.completion(
                                    model=model,
                                    messages=[],
                                ),
                        )
                    )

                main.main = create

                aider = (
                    types.ModuleType(
                        "aider"
                    )
                )

                aider.__version__ = (
                    "mock"
                )

                aider.main = main
                aider.models = models

                with patch.dict(
                    "sys.modules",
                    {
                        "aider":
                            aider,
                        "aider.main":
                            main,
                        "aider.models":
                            models,
                        "aider.llm":
                            llm,
                        "aider.repomap":
                            repomap,
                    },
                ):
                    self.assertEqual(
                        run(
                            request,
                            [],
                        ),
                        0,
                    )

                report = json.loads(
                    (
                        root
                        / "report"
                    ).read_text()
                )

                self.assertEqual(
                    report[
                        "nativeSettings"
                    ],
                    known,
                )

                self.assertEqual(
                    report[
                        "format"
                    ],
                    "diff",
                )


if __name__ == "__main__":
    unittest.main()

"""Thin Aider launcher. Koda owns limits; Aider owns repository editing.

No provider/model registry lives here. All completions, including summarization
and architect editing, cross one guard and use the exact routed model.
"""

import json
import math
import os
import sys
import time
from pathlib import Path


class StopExecution(BaseException):
    def __init__(self, kind):
        super().__init__(kind)
        self.kind = kind


def _safe_error(exc):
    """Return bounded diagnostic text without leaking the OpenRouter key."""
    text = f"{type(exc).__name__}: {exc}"

    secret = os.environ.get(
        "OPENROUTER_API_KEY",
        "",
    )

    if secret:
        text = text.replace(
            secret,
            "[REDACTED]",
        )

    return (
        text.replace("\r", " ")
        .replace("\n", " ")[:2000]
    )


class CallGuard:
    def __init__(
        self,
        request,
        ledger,
        save,
        completion,
        token_counter=None,
    ):
        self.request = request
        self.ledger = ledger
        self.save = save
        self.completion = completion
        self.token_counter = token_counter

    def _count_prompt_tokens(
        self,
        messages,
    ):
        """
        Prefer LiteLLM's tokenizer.

        Fall back to a conservative byte estimate only when the
        tokenizer does not support the routed model.
        """
        if callable(
            self.token_counter
        ):
            model = self.request[
                "model"
            ]

            candidates = [model]

            if model.startswith(
                "openrouter/"
            ):
                candidates.append(
                    model[
                        len(
                            "openrouter/"
                        ) :
                    ]
                )

            for candidate in candidates:
                try:
                    count = (
                        self.token_counter(
                            model=candidate,
                            messages=messages,
                        )
                    )

                    if (
                        isinstance(
                            count,
                            int,
                        )
                        and count >= 0
                    ):
                        return count

                except Exception:
                    pass

        payload = json.dumps(
            messages,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")

        # Do not repeat the old bug where
        # 1 UTF-8 byte == 1 token.
        return max(
            1,
            math.ceil(
                len(payload) / 3
            )
            + 256,
        )

    def __call__(
        self,
        *args,
        **kwargs,
    ):
        r = self.request
        state = self.ledger

        if (
            args
            or kwargs.get("model")
            != r["model"]
        ):
            raise StopExecution(
                "model_substitution"
            )

        if (
            state["steps"]
            >= r["maxSteps"]
        ):
            raise StopExecution(
                "attempt_step_exhausted"
            )

        if (
            time.time() * 1000
            >= r["deadline"]
        ):
            raise StopExecution(
                "attempt_deadline_exhausted"
            )

        prices = [
            r.get(
                "promptPricePerMillion"
            ),
            r.get(
                "completionPricePerMillion"
            ),
        ]

        if any(
            not isinstance(
                price,
                (float, int),
            )
            or not math.isfinite(
                price
            )
            or price < 0
            for price in prices
        ):
            raise StopExecution(
                "pricing_unavailable"
            )

        messages = kwargs.get(
            "messages",
            [],
        )

        if not isinstance(
            messages,
            list,
        ):
            raise StopExecution(
                "unsupported_content"
            )

        for message in messages:
            if not isinstance(
                message,
                dict,
            ):
                raise StopExecution(
                    "unsupported_content"
                )

            content = message.get(
                "content"
            )

            if not isinstance(
                content,
                (str, type(None)),
            ):
                raise StopExecution(
                    "unsupported_content"
                )

        prompt = (
            self._count_prompt_tokens(
                messages
            )
        )

        payload_bytes = len(json.dumps({"model": kwargs.get("model"), "messages": messages,
            "tools": kwargs.get("tools"), "extra_body": kwargs.get("extra_body"),
            "response_format": kwargs.get("response_format"), "max_tokens": r["maxOutputTokens"]},
            ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        prompt_bound = max(prompt, payload_bytes + 512)
        state["lastPromptTokens"] = prompt
        state["lastPromptBound"] = prompt_bound
        if prompt_bound > r.get("maxInputTokens", 32768):
            self.save()
            raise StopExecution("provider_input_preflight")

        # maxTokens is Koda's TOTAL provider-token allowance for
        # this attempt, not a completion-only allowance.
        #
        # Count:
        #   previous provider usage
        # + this provider prompt
        # + this provider completion
        #
        # state["tokens"] contains usage from previous provider calls.
        remaining_tokens = (
            r["maxTokens"]
            - state["tokens"]
            - prompt_bound
        )

        output = min(
            r["maxOutputTokens"],
            max(
                0,
                remaining_tokens,
            ),
        )

        requested_max_tokens = (
            kwargs.get(
                "max_tokens"
            )
        )

        if (
            requested_max_tokens
            is not None
        ):
            try:
                output = min(
                    output,
                    int(
                        requested_max_tokens
                    ),
                )

            except (
                TypeError,
                ValueError,
            ):
                raise StopExecution(
                    "invalid_output_limit"
                ) from None

        prompt_cost = (
            prompt_bound
            * prices[0]
            / 1e6
        )

        available = (
            r["budgetUsd"]
            - state["costUsd"]
            - prompt_cost
        )

        if prices[1] > 0:
            affordable_output = (
                math.floor(
                    available
                    * 1e6
                    / prices[1]
                )
            )

            output = min(
                output,
                affordable_output,
            )

        context_limit = r.get("contextLength")

        if (
            context_limit is not None
            and prompt_bound + output > context_limit
        ):
            raise StopExecution(
                "context_preflight_exhausted"
            )

        if (
            output < 1
            or available < 0
        ):
            # Actual attempt budget / economic budget exhausted.
            raise StopExecution(
                "attempt_budget_exhausted"
            )

        reserved_cost = (
            prompt_bound * prices[0]
            + output * prices[1]
        ) / 1e6

        # Reserve before provider dispatch.
        state["steps"] += 1

        state["tokens"] += (
            prompt_bound + output
        )

        state["costUsd"] += (
            reserved_cost
        )

        self.save()

        remaining_ms = (
            r["deadline"]
            - time.time() * 1000
        )

        if remaining_ms <= 0:
            raise StopExecution(
                "attempt_deadline_exhausted"
            )

        kwargs.update(
            stream=False,
            max_tokens=output,
            num_retries=0,
            api_key=os.environ[
                "OPENROUTER_API_KEY"
            ],
            api_base=r["baseUrl"],
            timeout=max(
                0.001,
                min(
                    r[
                        "requestTimeoutMs"
                    ]
                    / 1000,
                    remaining_ms
                    / 1000,
                ),
            ),
        )

        # Koda owns routing.
        # Do not allow hidden provider/model
        # fallback inside LiteLLM/Aider.
        for key in (
            "fallbacks",
            "model_list",
            "deployment_id",
            "max_completion_tokens",
            "custom_llm_provider",
            "context_window_fallback_dict",
        ):
            kwargs.pop(
                key,
                None,
            )

        body = dict(
            kwargs.get(
                "extra_body"
            )
            or {}
        )

        for key in (
            "model",
            "models",
            "route",
            "max_tokens",
            "max_completion_tokens",
            "n",
        ):
            body.pop(
                key,
                None,
            )

        if body:
            kwargs[
                "extra_body"
            ] = body
        else:
            kwargs.pop(
                "extra_body",
                None,
            )

        kwargs["n"] = 1

        try:
            response = (
                self.completion(
                    **kwargs
                )
            )

        except Exception as exc:
            # Provider outcome may be
            # uncertain, so preserve
            # the reservation.
            self.save()

            print(
                (
                    "KODA_AIDER_PROVIDER_ERROR "
                    + _safe_error(exc)
                ),
                file=sys.stderr,
                flush=True,
            )

            raise StopExecution(
                "provider"
            ) from None

        usage = getattr(
            response,
            "usage",
            None,
        )

        choices = getattr(response, "choices", []) or []
        if any(
            (choice.get("finish_reason") if isinstance(choice, dict)
             else getattr(choice, "finish_reason", None)) == "length"
            for choice in choices
        ):
            state["outputLimitReached"] = True

        raw = (
            usage.model_dump()
            if hasattr(
                usage,
                "model_dump",
            )
            else usage
        )

        if isinstance(
            raw,
            dict,
        ):
            actual_prompt = raw.get(
                "prompt_tokens"
            )

            actual_completion = raw.get(
                "completion_tokens"
            )

            actual_cost = raw.get(
                "cost"
            )

            if (
                isinstance(
                    actual_prompt,
                    int,
                )
                and isinstance(
                    actual_completion,
                    int,
                )
                and actual_prompt
                >= 0
                and actual_completion
                >= 0
            ):
                reserved_tokens = (
                    prompt_bound + output
                )

                actual_tokens = (
                    actual_prompt
                    + actual_completion
                )

                state[
                    "tokens"
                ] += (
                    actual_tokens
                    - reserved_tokens
                )

                state[
                    "inputTokens"
                ] += actual_prompt

                state[
                    "outputTokens"
                ] += (
                    actual_completion
                )

                if not (
                    isinstance(
                        actual_cost,
                        (float, int),
                    )
                    and math.isfinite(
                        actual_cost
                    )
                    and actual_cost
                    >= 0
                ):
                    actual_cost = (
                        actual_prompt
                        * prices[0]
                        + actual_completion
                        * prices[1]
                    ) / 1e6

                state[
                    "costUsd"
                ] += (
                    actual_cost
                    - reserved_cost
                )

        self.save()

        return response


def _install_isolated_home(
    request,
):
    """
    Keep Aider's home/cache state inside
    Koda's disposable attempt scratch dir.

    Do not set AIDER_CONFIG_FILE here:
    TypeScript already passes --config with
    an existing temporary config file.
    """
    scratch = Path(
        request["report"]
    ).parent

    home = (
        scratch / "home"
    )

    cache = (
        scratch / "xdg-cache"
    )

    config = (
        scratch / "xdg-config"
    )

    data = (
        scratch / "xdg-data"
    )

    state = (
        scratch / "xdg-state"
    )

    for directory in (
        home,
        cache,
        config,
        data,
        state,
    ):
        directory.mkdir(
            parents=True,
            exist_ok=True,
        )

    os.environ[
        "HOME"
    ] = str(home)

    os.environ[
        "XDG_CACHE_HOME"
    ] = str(cache)

    os.environ[
        "XDG_CONFIG_HOME"
    ] = str(config)

    os.environ[
        "XDG_DATA_HOME"
    ] = str(data)

    os.environ[
        "XDG_STATE_HOME"
    ] = str(state)

    # Critical:
    # the TypeScript launcher already provides
    # a real --config file.
    os.environ.pop(
        "AIDER_CONFIG_FILE",
        None,
    )

    # Prevent startup from touching update/
    # analytics state in the real home dir.
    os.environ[
        "AIDER_CHECK_UPDATE"
    ] = "false"

    os.environ[
        "AIDER_SHOW_RELEASE_NOTES"
    ] = "false"

    os.environ[
        "AIDER_ANALYTICS_DISABLE"
    ] = "true"

    return scratch


def _empty_ledger():
    return {
        "costUsd": 0,
        "tokens": 0,
        "inputTokens": 0,
        "outputTokens": 0,
        "steps": 0,
    }


def run(
    request,
    args,
):
    # Aider touches Path.home() during
    # import/startup, so isolate before import.
    _install_isolated_home(
        request
    )

    report_path = Path(
        request["report"]
    )

    ledger_path = Path(
        request["ledger"]
    )

    report = {
        "version": "unknown",
        "format": None,
        "failureKind": None,
        "runtimeError": None,
    }

    coder = None

    if ledger_path.exists():
        try:
            ledger = json.loads(
                ledger_path.read_text()
            )

            if not isinstance(
                ledger,
                dict,
            ):
                ledger = (
                    _empty_ledger()
                )

        except Exception:
            ledger = (
                _empty_ledger()
            )

    else:
        ledger = (
            _empty_ledger()
        )

    def save():
        ledger_path.write_text(
            json.dumps(
                ledger
            )
        )

    try:
        from aider import (
            __version__,
        )

        from aider import (
            main,
            models,
        )

        from aider.llm import (
            litellm,
        )

        from aider.repomap import (
            RepoMap,
        )

        report[
            "version"
        ] = __version__

        RepoMap.TAGS_CACHE_DIR = (
            str(
                report_path.parent
                / "tags-cache"
            )
        )

        # Ignore user/repository model/env
        # discovery. Koda provides explicit
        # config + metadata.
        original_parser = (
            main.get_parser
        )

        def isolated_parser(
            defaults,
            root,
        ):
            return (
                original_parser(
                    [],
                    root,
                )
            )

        main.get_parser = (
            isolated_parser
        )

        main.load_dotenv_files = (
            lambda *a, **k: []
        )

        main.generate_search_path_list = (
            lambda default,
            root,
            explicit:
            [explicit]
            if explicit
            else []
        )

        models.MODEL_ALIASES.pop(
            request["model"],
            None,
        )

        known = any(
            setting.name
            == request["model"]
            for setting
            in models.MODEL_SETTINGS
        )

        report[
            "nativeSettings"
        ] = known

        if not known:
            supported = (
                (
                    request.get(
                        "modelMetadata"
                    )
                    or {}
                ).get(
                    "supportedParameters"
                )
                or []
            )

            settings = [
                {
                    "name":
                        request[
                            "model"
                        ],

                    "edit_format":
                        "diff",

                    "use_repo_map":
                        True,

                    "use_temperature":
                        "temperature"
                        in supported,

                    "weak_model_name":
                        request[
                            "model"
                        ],

                    "editor_model_name":
                        request[
                            "model"
                        ],
                }
            ]

            settings_path = (
                report_path.with_suffix(
                    ".settings.json"
                )
            )

            settings_path.write_text(
                json.dumps(
                    settings
                )
            )

            # Copy args so callers never see
            # mutation from this bridge.
            args = list(args) + [
                "--model-settings-file",
                str(
                    settings_path
                ),
            ]

        token_counter = getattr(
            litellm,
            "token_counter",
            None,
        )

        original_completion = (
            litellm.completion
        )

        litellm.completion = (
            CallGuard(
                request,
                ledger,
                save,
                original_completion,
                token_counter,
            )
        )

        coder = main.main(
            args,
            return_coder=True,
        )

        if not hasattr(
            coder,
            "run",
        ):
            raise RuntimeError(
                (
                    "Aider main returned "
                    "non-coder value: "
                    + type(
                        coder
                    ).__name__
                )
            )

        report["format"] = (
            getattr(
                coder,
                "edit_format",
                None,
            )
        )

        report_path.write_text(
            json.dumps(
                report
            )
        )

        coder.run(
            with_message=Path(
                request["prompt"]
            ).read_text()
        )

        if getattr(
            coder,
            "num_malformed_responses",
            0,
        ):
            report[
                "failureKind"
            ] = "edit_format"

    except StopExecution as exc:
        report[
            "failureKind"
        ] = exc.kind

    except Exception as exc:
        diagnostic = (
            _safe_error(exc)
        )

        report[
            "failureKind"
        ] = "runtime"

        report[
            "runtimeError"
        ] = diagnostic

        # aiderExecutor.ts already captures
        # subprocess stderr, so the real
        # startup error will now appear in
        # aider_execution_error telemetry.
        print(
            (
                "KODA_AIDER_RUNTIME_ERROR "
                + diagnostic
            ),
            file=sys.stderr,
            flush=True,
        )

    finally:
        try:
            save()

        finally:
            report_path.write_text(
                json.dumps(
                    report
                )
            )

    return (
        1
        if report[
            "failureKind"
        ]
        else 0
    )


if __name__ == "__main__":
    request = json.loads(
        Path(
            sys.argv[1]
        ).read_text()
    )

    sys.exit(
        run(
            request,
            sys.argv[2:],
        )
    )

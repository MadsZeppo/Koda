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
        self.kind = kind


class CallGuard:
    def __init__(self, request, ledger, save, completion):
        self.request, self.ledger, self.save, self.completion = request, ledger, save, completion

    def __call__(self, *args, **kwargs):
        r, state = self.request, self.ledger
        if args or kwargs.get("model") != r["model"]:
            raise StopExecution("model_substitution")
        if state["steps"] >= r["maxSteps"] or time.time() * 1000 >= r["deadline"]:
            raise StopExecution("budget_exhausted")
        prices = [r.get("promptPricePerMillion"), r.get("completionPricePerMillion")]
        if any(not isinstance(p, (float, int)) or not math.isfinite(p) or p < 0 for p in prices):
            raise StopExecution("pricing_unavailable")
        # Text-only coding requests: UTF-8 bytes plus framing is deliberately
        # conservative for arbitrary/unknown tokenizers. No guessed token ratio.
        messages = kwargs.get("messages", [])
        if any(not isinstance(m.get("content"), (str, type(None))) for m in messages):
            raise StopExecution("unsupported_content")
        prompt = len(json.dumps(messages, ensure_ascii=False).encode("utf-8")) + 1024
        output = min(r["maxOutputTokens"], r["maxTokens"] - state["tokens"] - prompt)
        if kwargs.get("max_tokens") is not None:
            output = min(output, int(kwargs["max_tokens"]))
        available = r["budgetUsd"] - state["costUsd"] - prompt * prices[0] / 1e6
        if prices[1] > 0:
            output = min(output, math.floor(available * 1e6 / prices[1]))
        if output < 1 or available < 0:
            raise StopExecution("budget_exhausted")
        cost = (prompt * prices[0] + output * prices[1]) / 1e6
        # Persist the reservation BEFORE dispatch. A killed worker/uncertain
        # provider response cannot make a later format retry spend it again.
        state["steps"] += 1
        state["tokens"] += prompt + output
        state["costUsd"] += cost
        self.save()
        kwargs.update(stream=False, max_tokens=output, num_retries=0,
                      api_key=os.environ["OPENROUTER_API_KEY"],
                      api_base=r["baseUrl"],
                      timeout=max(.001, min(r["requestTimeoutMs"] / 1000,
                                          (r["deadline"] - time.time() * 1000) / 1000)))
        # Forbid native extra_params from injecting alternate routing or spend.
        for key in ("fallbacks", "model_list", "deployment_id", "max_completion_tokens",
                    "custom_llm_provider", "context_window_fallback_dict"):
            kwargs.pop(key, None)
        body = dict(kwargs.get("extra_body") or {})
        for key in ("model", "models", "route", "max_tokens", "max_completion_tokens", "n"):
            body.pop(key, None)
        if body:
            kwargs["extra_body"] = body
        else:
            kwargs.pop("extra_body", None)
        kwargs["n"] = 1
        try:
            response = self.completion(**kwargs)
        except Exception:
            raise StopExecution("provider") from None
        usage = getattr(response, "usage", None)
        raw = usage.model_dump() if hasattr(usage, "model_dump") else usage
        if isinstance(raw, dict):
            p, c = raw.get("prompt_tokens"), raw.get("completion_tokens")
            actual = raw.get("cost")
            if isinstance(p, int) and isinstance(c, int) and 0 <= p <= prompt and 0 <= c <= output:
                state["tokens"] -= prompt + output - p - c
                state["inputTokens"] += p
                state["outputTokens"] += c
                # Use provider USD when supplied, otherwise catalog upper cost.
                actual = actual if isinstance(actual, (float, int)) and math.isfinite(actual) and actual >= 0 else (p * prices[0] + c * prices[1]) / 1e6
                state["costUsd"] += actual - cost
        self.save()
        return response


def run(request, args):
    from aider import __version__
    from aider import main, models
    from aider.llm import litellm
    from aider.repomap import RepoMap

    report_path = Path(request["report"])
    RepoMap.TAGS_CACHE_DIR = str(report_path.parent / "tags-cache")
    ledger_path = Path(request["ledger"])
    ledger = json.loads(ledger_path.read_text()) if ledger_path.exists() else dict(
        costUsd=0, tokens=0, inputTokens=0, outputTokens=0, steps=0)
    report = dict(version=__version__, format=None, failureKind=None)

    def save():
        ledger_path.write_text(json.dumps(ledger))

    # Ignore repository/user configuration and dotenv overrides. Only packaged
    # native settings and Koda's temporary metadata/settings are eligible.
    original_parser = main.get_parser
    main.get_parser = lambda defaults, root: original_parser([], root)
    main.load_dotenv_files = lambda *a, **k: []
    main.generate_search_path_list = lambda default, root, explicit: [explicit] if explicit else []
    models.MODEL_ALIASES.pop(request["model"], None)
    known = any(setting.name == request["model"] for setting in models.MODEL_SETTINGS)
    report["nativeSettings"] = known
    if not known:
        settings = [{"name": request["model"], "edit_format": "diff",
                     "use_repo_map": True,
                     "use_temperature": "temperature" in ((request.get("modelMetadata") or {}).get("supportedParameters") or []),
                     "weak_model_name": request["model"],
                     "editor_model_name": request["model"]}]
        settings_path = report_path.with_suffix(".settings.json")
        settings_path.write_text(json.dumps(settings))
        args += ["--model-settings-file", str(settings_path)]
    litellm.completion = CallGuard(request, ledger, save, litellm.completion)
    coder = None
    try:
        coder = main.main(args, return_coder=True)
        if not hasattr(coder, "run"):
            raise StopExecution("runtime")
        report["format"] = coder.edit_format
        report_path.write_text(json.dumps(report))
        # Aider may reflect internally; the guard bounds all model calls. One
        # external format retry is controlled by the TypeScript adapter.
        coder.run(with_message=Path(request["prompt"]).read_text())
        if coder.num_malformed_responses:
            report["failureKind"] = "edit_format"
    except StopExecution as exc:
        report["failureKind"] = exc.kind
    except Exception:
        # Do not serialize provider objects, headers, environment, or secrets.
        report["failureKind"] = "runtime"
    finally:
        save()
        report_path.write_text(json.dumps(report))
    return 1 if report["failureKind"] else 0


if __name__ == "__main__":
    request = json.loads(Path(sys.argv[1]).read_text())
    sys.exit(run(request, sys.argv[2:]))

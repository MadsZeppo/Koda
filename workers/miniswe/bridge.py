#!/usr/bin/env python3
"""Structured Koda bridge for the pinned upstream mini-swe-agent API."""
from __future__ import annotations

import contextlib
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import time
import traceback
from pathlib import Path

VERSION = "2.4.6"
_PLACEHOLDER_KEYS = {"redacted", "replace_me", "replace-me", "your_api_key", "your-key", "changeme", "none", "null"}


def _api_key() -> str:
    key = (os.environ.get("OPENROUTER_API_KEY") or "").strip()
    if not key:
        raise RuntimeError("OPENROUTER_API_KEY is missing")
    if key.lower() in _PLACEHOLDER_KEYS:
        raise RuntimeError("OPENROUTER_API_KEY is a placeholder")
    if "\r" in key or "\n" in key:
        raise RuntimeError("OPENROUTER_API_KEY is malformed")
    return key


def _scrub(value, secret: str):
    if isinstance(value, dict):
        return {key: ("[REDACTED]" if key.lower() == "api_key" else _scrub(item, secret))
                for key, item in value.items()}
    if isinstance(value, list):
        return [_scrub(item, secret) for item in value]
    if isinstance(value, str):
        return value.replace(secret, "[REDACTED]")
    return value


def _usage(serialized: dict) -> tuple[int, int, int, int]:
    prompt = completion = cached = cache_write = 0
    for message in serialized.get("messages", []):
        usage = message.get("extra", {}).get("response", {}).get("usage", {}) or {}
        prompt += int(usage.get("prompt_tokens") or 0)
        completion += int(usage.get("completion_tokens") or 0)
        details = usage.get("prompt_tokens_details") or {}
        cached += int(details.get("cached_tokens") or usage.get("cached_input_tokens") or 0)
        cache_write += int(details.get("cache_write_tokens") or usage.get("cache_write_tokens") or 0)
    return prompt, completion, cached, cache_write


def _limit(message: str, limit_kind: str, details: dict | None = None):
    from minisweagent.exceptions import LimitsExceeded
    extra = {"exit_status": "LimitsExceeded", "submission": "",
             "limit_kind": limit_kind, "exact_limit_fired": limit_kind}
    extra.update(details or {})
    return LimitsExceeded({
        "role": "exit",
        "content": message,
        "extra": extra,
    })


def _token_limit_state(configured: int, consumed: int, next_prompt: int) -> dict:
    """Describe the one attempt-token ledger without calling a provider."""
    remaining = max(0, int(configured) - int(consumed))
    if consumed >= configured:
        kind = "token_limit"
    elif next_prompt >= remaining:
        # No tokens were consumed by this rejected request. Calling this a
        # hard token_limit made telemetry claim a lower, hidden cap.
        kind = "token_preflight"
    else:
        kind = ""
    return {
        "limit_kind": kind,
        "configured_token_limit": int(configured),
        "consumed_tokens": int(consumed),
        "remaining_tokens": remaining,
        "next_prompt_tokens": int(next_prompt),
    }


_MUTATION = re.compile(r"(?:apply_patch|cat\s+[^|;&]*>|(?:sed|perl)\s+-i|"
                       r"(?:write|append)_file|python\w*\s+-c.*(?:write|open\())", re.I | re.S)
_VERIFICATION = re.compile(r"(?:^|\s)(?:pytest|unittest|pnpm\s+(?:test|typecheck|build)|"
                           r"npm\s+(?:test|run\s+(?:test|typecheck|build))|"
                           r"yarn\s+(?:test|typecheck|build)|cargo\s+test|go\s+test|"
                           r"node\s+--test|tsc(?:\s|$))", re.I)


def _workspace_signature(cwd: str) -> str:
    """Content-sensitive local progress proof; never leaves the candidate repo."""
    try:
        diff = subprocess.run(
            ["git", "diff", "--binary", "--no-ext-diff"], cwd=cwd,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False,
        ).stdout
        status = subprocess.run(
            ["git", "status", "--porcelain", "--untracked-files=all"], cwd=cwd,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False,
        ).stdout
        digest = hashlib.sha256(diff + status)
        for line in status.decode("utf-8", "replace").splitlines():
            if line.startswith("?? "):
                path = Path(cwd, line[3:])
                if path.is_file():
                    digest.update(path.read_bytes())
        return digest.hexdigest()
    except Exception:
        return "unavailable"


def _paths_signature(cwd: str, paths: list[str]) -> str:
    """Track explicit scope content even when an isolated copy has no usable .git."""
    digest = hashlib.sha256()
    root = Path(cwd).resolve()
    for relative in sorted(set(paths)):
        if not relative or relative == ".":
            continue
        target = (root / relative).resolve()
        if target != root and root not in target.parents:
            continue
        digest.update(relative.encode("utf-8", "replace"))
        if target.is_file():
            digest.update(target.read_bytes())
        else:
            digest.update(b"<missing-or-non-file>")
    return digest.hexdigest()


def _truncate_output(value: str, limit: int) -> str:
    raw = value.encode("utf-8", "replace")
    if limit <= 0 or len(raw) <= limit:
        return value
    marker = b"\n... Koda truncated tool output ...\n"
    available = max(0, limit - len(marker))
    head = available * 2 // 3
    return (raw[:head] + marker + raw[-(available - head):]).decode("utf-8", "replace")


class ProgressWatchdog:
    """Small deterministic phase tracker and repeated-call loop guard."""
    def __init__(self, cwd: str, stall_limit: int = 3):
        self.cwd = cwd
        self.phase = "DISCOVERY"
        self.stall_limit = stall_limit
        self.seen_commands: set[str] = set()
        self.stalled_turns = 0

    def observe(self, commands: list[str], before: str, after: str):
        normalized = [" ".join(command.split()) for command in commands if command.strip()]
        novel = any(command not in self.seen_commands for command in normalized)
        mutation_attempted = any(_MUTATION.search(command) for command in normalized)
        verification = any(_VERIFICATION.search(command) for command in normalized)
        prior = self.phase
        if mutation_attempted and prior == "VERIFICATION_ATTEMPTED":
            self.phase = "REPAIR"
        elif mutation_attempted and prior == "DISCOVERY":
            self.phase = "MUTATION_ATTEMPTED"
        if before != after:
            self.phase = "REPAIR" if prior == "VERIFICATION_ATTEMPTED" else "MUTATION_OBSERVED"
        if verification and self.phase in {"MUTATION_ATTEMPTED", "MUTATION_OBSERVED", "REPAIR"}:
            self.phase = "VERIFICATION_ATTEMPTED"
        changed = before != after
        self.stalled_turns = 0 if novel or changed else self.stalled_turns + 1
        self.seen_commands.update(normalized)

    @property
    def stalled(self) -> bool:
        return self.stalled_turns >= self.stall_limit


def main() -> int:
    started = time.monotonic()
    request = json.load(sys.stdin)
    model = request["model"]
    result = {
        "exitStatus": "infra_failure",
        "model": model,
        "engine": "mini-swe-agent",
        "engineVersion": VERSION,
        "changedPaths": [],
        "wallClockMs": 0,
    }
    api_key = ""
    try:
        api_key = _api_key()
        # Upstream currently prints version/config notices during import. Keep
        # stdout exclusively for the bridge response contract.
        with contextlib.redirect_stdout(sys.stderr):
            from minisweagent.agents.default import DefaultAgent
            from minisweagent.environments.local import LocalEnvironment
            from minisweagent.models.litellm_model import LitellmModel
            from minisweagent.exceptions import Submitted
            import litellm
            import minisweagent

            if minisweagent.__version__ != VERSION:
                raise RuntimeError(
                    f"mini-swe-agent version mismatch: {minisweagent.__version__} != {VERSION}"
                )

            trajectory = Path(request["trajectoryPath"])
            provider_model = model if model.startswith("openrouter/") else f"openrouter/{model}"
            coding_route = request.get("codingRoute")
            model_kwargs = {
                "drop_params": True,
                "api_base": request.get("baseUrl", "https://openrouter.ai/api/v1"),
                "api_key": api_key,
                "max_tokens": request.get("maxOutputTokens", 4096),
                "num_retries": 0,
                "timeout": max(1, request.get("requestTimeoutMs", 30000) / 1000),
            }
            if request.get("sessionId"):
                model_kwargs["session_id"] = request["sessionId"]
            if coding_route:
                scores = {"low": 0, "medium": 0.33, "high": 0.66}
                model_kwargs["plugins"] = [{
                    "id": "pareto-router",
                    "min_coding_score": scores[coding_route["tier"]],
                }]
            class BoundedLitellmModel(LitellmModel):
                """Enforce Koda's whole-attempt token and dollar bounds before every call."""

                def __init__(self, *args, token_limit, cost_limit, context_limit=None,
                             prompt_price=None, completion_price=None, **kwargs):
                    super().__init__(*args, **kwargs)
                    self.koda_token_limit = max(1, int(token_limit))
                    self.koda_cost_limit = max(0.0, float(cost_limit))
                    self.koda_context_limit = int(context_limit) if context_limit else None
                    self.koda_prompt_price = prompt_price
                    self.koda_completion_price = completion_price
                    self.koda_tokens = 0
                    self.koda_cost = 0.0

                def _prompt_bound(self, messages):
                    prepared = self._prepare_messages_for_api(messages)
                    try:
                        estimate = int(litellm.token_counter(
                            model=self.config.model_name, messages=prepared
                        ))
                        # Provider tokenizers can differ slightly. Keep a
                        # deterministic safety margin around the local count.
                        return max(1, math.ceil(estimate * 1.15) + 64)
                    except Exception:
                        # UTF-8 bytes are a conservative local fallback for
                        # ordinary model tokenizers and require no provider call.
                        return len(json.dumps(prepared, ensure_ascii=False).encode("utf-8"))

                def query(self, messages, **kwargs):
                    prompt_bound = self._prompt_bound(messages)
                    token_state = _token_limit_state(
                        self.koda_token_limit, self.koda_tokens, prompt_bound
                    )
                    remaining_tokens = token_state["remaining_tokens"]
                    if token_state["limit_kind"]:
                        raise _limit(
                            "KodaTokenLimitExceeded", token_state["limit_kind"], token_state
                        )
                    if self.koda_context_limit is not None and prompt_bound >= self.koda_context_limit:
                        raise _limit("KodaContextLimitExceeded", "context_limit")
                    output_limit = min(
                        int(kwargs.get("max_tokens") or
                            self.config.model_kwargs.get("max_tokens") or 4096),
                        remaining_tokens - prompt_bound,
                    )
                    if self.koda_context_limit is not None:
                        output_limit = min(output_limit, self.koda_context_limit - prompt_bound)
                    if self.koda_prompt_price is not None and self.koda_completion_price is not None:
                        prompt_cost = prompt_bound * float(self.koda_prompt_price) / 1_000_000
                        remaining_cost = self.koda_cost_limit - self.koda_cost - prompt_cost
                        if remaining_cost <= 0:
                            raise _limit("KodaCostLimitExceeded", "cost_limit")
                        completion_price = float(self.koda_completion_price)
                        if completion_price > 0:
                            output_limit = min(output_limit, math.floor(
                                remaining_cost * 1_000_000 / completion_price
                            ))
                    if output_limit < 1:
                        kind = "context_limit" if self.koda_context_limit is not None and \
                            prompt_bound >= self.koda_context_limit else "cost_limit"
                        raise _limit("KodaAttemptLimitExceeded", kind)
                    message = super().query(messages, **(kwargs | {"max_tokens": output_limit}))
                    usage = message.get("extra", {}).get("response", {}).get("usage", {}) or {}
                    self.koda_tokens += int(usage.get("prompt_tokens") or prompt_bound)
                    self.koda_tokens += int(usage.get("completion_tokens") or 0)
                    self.koda_cost += float(message.get("extra", {}).get("cost") or 0.0)
                    return message

            model_client = BoundedLitellmModel(
                model_name=provider_model,
                model_kwargs=model_kwargs,
                token_limit=request["maxTokens"],
                cost_limit=request["budgetUsd"],
                prompt_price=request.get("promptPricePerMillion"),
                completion_price=request.get("completionPricePerMillion"),
                context_limit=request.get("contextWindowTokens"),
            )
            class BoundedLocalEnvironment(LocalEnvironment):
                def execute(self, action, cwd="", *, timeout=None):
                    output = super().execute(action, cwd, timeout=timeout)
                    output["output"] = _truncate_output(
                        output.get("output", ""), int(request.get("maxToolOutputBytes", 4000))
                    )
                    return output

            environment = BoundedLocalEnvironment(
                cwd=request["repoPath"],
                timeout=max(1, int(request["commandTimeoutMs"] / 1000)),
                env={"PAGER": "cat", "MANPAGER": "cat", "PIP_PROGRESS_BAR": "off"},
            )
            scope = ", ".join(request.get("writeScope") or [])
            context = request.get("context") or {}
            context_text = json.dumps(context, ensure_ascii=False)
            watchdog = ProgressWatchdog(request["repoPath"])
            first_mutation_ms = None

            class KodaProgressAgent(DefaultAgent):
                def query(self):
                    if watchdog.stalled:
                        raise _limit("KodaProgressStalled", "other")
                    if 0 < self.config.step_limit <= self.n_calls:
                        raise _limit("KodaStepLimitExceeded", "step_limit")
                    if 0 < self.config.cost_limit <= self.cost:
                        raise _limit("KodaCostLimitExceeded", "cost_limit")
                    if 0 < self.config.wall_time_limit_seconds <= int(time.time() - self._start_time):
                        raise _limit("KodaTimeLimitExceeded", "timeout")
                    return super().query()

                def execute_actions(self, message):
                    nonlocal first_mutation_ms
                    actions = message.get("extra", {}).get("actions", [])
                    commands = [str(action.get("command", "")) for action in actions]
                    watched = request.get("writeScope") or []
                    before = _workspace_signature(watchdog.cwd)
                    before_paths = _paths_signature(watchdog.cwd, watched)
                    observations = super().execute_actions(message)
                    after = _workspace_signature(watchdog.cwd)
                    after_paths = _paths_signature(watchdog.cwd, watched)
                    watchdog.observe(commands, before + before_paths, after + after_paths)
                    if first_mutation_ms is None and before_paths != after_paths:
                        first_mutation_ms = int((time.monotonic() - started) * 1000)
                    if request.get("returnOnMutation") and before_paths != after_paths:
                        raise Submitted({
                            "role": "exit", "content": "Mutation ready for Koda verification",
                            "extra": {"exit_status": "Submitted", "submission": "mutation_observed"},
                        })
                    return observations

            agent = KodaProgressAgent(
                model_client,
                environment,
                system_template=(
                    "You are the sole coding worker for one Koda attempt. Explore the assigned "
                    "repository, implement the task, and use shell commands to inspect and edit. "
                    "Do not route to or invoke another language model. Work only in the current "
                    "repository. Authorized write paths: " + scope + ". Koda independently checks "
                    "the final diff and verification. Finish with exactly: "
                    "echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT"
                ),
                instance_template=(
                    "Task:\n{{task}}\n\nKoda source context (current repository content, "
                    "captured immediately before this attempt):\n" + context_text +
                    "\nUse this bounded context as the initial source truth. Do not re-read a file "
                    "already included here unless its excerpt omits the exact edit location or a "
                    "required definition. For a localized task, mutate the authorized target "
                    "directly from this context, then run the focused check."
                ),
                step_limit=request["maxSteps"],
                cost_limit=request["budgetUsd"],
                wall_time_limit_seconds=max(1, int(request["timeoutMs"] / 1000)),
                output_path=trajectory,
            )
            outcome = agent.run(task=request["task"])
            serialized = _scrub(agent.serialize(), api_key)
            # Upstream serializes model_kwargs into the trajectory. Replace the
            # explicit credential before the artifact leaves the bridge.
            trajectory.write_text(json.dumps(serialized, ensure_ascii=False), encoding="utf-8")
        prompt, completion, cached, cache_write = _usage(serialized)
        outcome_extra = outcome.get("extra", {}) or {}
        limit_kind = outcome.get("limit_kind") or outcome_extra.get("limit_kind")
        configured_tokens = model_client.koda_token_limit
        consumed_tokens = model_client.koda_tokens
        result.update(
            exitStatus="completed" if outcome.get("exit_status") == "Submitted" else "failed",
            trajectoryPath=str(trajectory),
            costUsd=float(serialized["info"]["model_stats"]["instance_cost"]),
            inputTokens=prompt,
            outputTokens=completion,
            cachedInputTokens=cached,
            cacheWriteTokens=cache_write,
            terminationReason=outcome.get("exit_status") or "unknown",
            limitKind=limit_kind,
            configuredTokenLimit=configured_tokens,
            consumedTokens=consumed_tokens,
            remainingTokens=max(0, configured_tokens - consumed_tokens),
            exactLimitFired=(outcome.get("exact_limit_fired") or
                             outcome_extra.get("exact_limit_fired") or limit_kind),
            progressPhase=watchdog.phase,
            steps=agent.n_calls,
            timeToFirstMutationMs=first_mutation_ms,
        )
    except Exception as error:
        name = type(error).__name__.lower()
        limit_kind = ("context_limit" if "context" in name else
                      "timeout" if "timeout" in name else
                      "provider_limit" if any(key in name for key in
                      ("ratelimit", "serviceunavailable", "apierror")) else None)
        result.update(
            exitStatus="infra_failure",
            fatalError=_scrub(f"{type(error).__name__}: {error}", api_key) if api_key else f"{type(error).__name__}: {error}",
            stderr=_scrub(traceback.format_exc(limit=8), api_key) if api_key else traceback.format_exc(limit=8),
            terminationReason="bridge_or_provider_failure",
            limitKind=limit_kind,
        )
    result["wallClockMs"] = int((time.monotonic() - started) * 1000)
    sys.stdout.write(json.dumps(result, separators=(",", ":")))
    return 0 if result["exitStatus"] != "infra_failure" else 2


if __name__ == "__main__":
    raise SystemExit(main())

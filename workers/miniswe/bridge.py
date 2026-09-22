#!/usr/bin/env python3
"""Structured Koda bridge for the pinned upstream mini-swe-agent API."""
from __future__ import annotations

import contextlib
import json
import os
import sys
import time
import traceback
from pathlib import Path

VERSION = "2.4.6"


def _usage(serialized: dict) -> tuple[int, int]:
    prompt = completion = 0
    for message in serialized.get("messages", []):
        usage = message.get("extra", {}).get("response", {}).get("usage", {}) or {}
        prompt += int(usage.get("prompt_tokens") or 0)
        completion += int(usage.get("completion_tokens") or 0)
    return prompt, completion


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
    try:
        # Upstream currently prints version/config notices during import. Keep
        # stdout exclusively for the bridge response contract.
        with contextlib.redirect_stdout(sys.stderr):
            from minisweagent.agents.default import DefaultAgent
            from minisweagent.environments.local import LocalEnvironment
            from minisweagent.models.litellm_model import LitellmModel
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
                "max_tokens": request.get("maxOutputTokens", 4096),
                "num_retries": 0,
            }
            if coding_route:
                scores = {"low": 0, "medium": 0.33, "high": 0.66}
                model_kwargs["plugins"] = [{
                    "id": "pareto-router",
                    "min_coding_score": scores[coding_route["tier"]],
                }]
            model_client = LitellmModel(
                model_name=provider_model,
                model_kwargs=model_kwargs,
            )
            environment = LocalEnvironment(
                cwd=request["repoPath"],
                timeout=max(1, int(request["commandTimeoutMs"] / 1000)),
                env={"PAGER": "cat", "MANPAGER": "cat", "PIP_PROGRESS_BAR": "off"},
            )
            scope = ", ".join(request.get("writeScope") or [])
            context = request.get("context") or {}
            context_text = json.dumps(context, ensure_ascii=False)
            agent = DefaultAgent(
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
                    "Task:\n{{task}}\n\nKoda context (hints, not proof):\n" + context_text
                ),
                step_limit=request["maxSteps"],
                cost_limit=request["budgetUsd"],
                wall_time_limit_seconds=max(1, int(request["timeoutMs"] / 1000)),
                output_path=trajectory,
            )
            outcome = agent.run(task=request["task"])
            serialized = agent.serialize()
        prompt, completion = _usage(serialized)
        result.update(
            exitStatus="completed" if outcome.get("exit_status") == "Submitted" else "failed",
            trajectoryPath=str(trajectory),
            costUsd=float(serialized["info"]["model_stats"]["instance_cost"]),
            inputTokens=prompt,
            outputTokens=completion,
            terminationReason=outcome.get("exit_status") or "unknown",
        )
    except Exception as error:
        result.update(
            exitStatus="infra_failure",
            fatalError=f"{type(error).__name__}: {error}",
            stderr=traceback.format_exc(limit=8),
            terminationReason="bridge_or_provider_failure",
        )
    result["wallClockMs"] = int((time.monotonic() - started) * 1000)
    sys.stdout.write(json.dumps(result, separators=(",", ":")))
    return 0 if result["exitStatus"] != "infra_failure" else 2


if __name__ == "__main__":
    raise SystemExit(main())

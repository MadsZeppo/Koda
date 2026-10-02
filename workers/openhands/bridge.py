#!/usr/bin/env python3
"""Read-only OpenHands repository exploration bridge.

Koda exposes only bounded inspection tools plus one structured submission tool.
The OpenHands default terminal and file editor tools are not registered, so the
explorer cannot mutate the repository.

The explorer owns localization. Existing editable paths must be grounded in
repository evidence. Missing paths are allowed only when the task genuinely
requires file creation (or the repository is empty); TypeScript performs the
authoritative repository-relative path validation before any write scope is
accepted.
"""

from __future__ import annotations

import fnmatch
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path
from collections.abc import Sequence
from typing import Any, ClassVar, Self

from pydantic import BaseModel, Field

from openhands.sdk import Agent, Conversation, LLM, Tool
from openhands.sdk.tool import (
    Action,
    Observation,
    ToolAnnotations,
    ToolDefinition,
    ToolExecutor,
    register_tool,
)

SDK_VERSION = "1.50.0"
MAX_TOOL_TEXT = 16_000
SKIP_DIRS = {
    ".git",
    "node_modules",
    ".venv",
    "venv",
    "dist",
    "build",
    "coverage",
}


class BridgeFailure(RuntimeError):
    def __init__(self, message: str, provider_dispatched: bool):
        super().__init__(message)
        self.provider_dispatched = provider_dispatched


def _is_iteration_limit_error(exc: Exception) -> bool:
    text = f"{type(exc).__name__}: {exc}".lower()
    return (
        "iteration" in text
        and "limit" in text
        and (
            "maximum" in text
            or "max iteration" in text
            or "reached" in text
        )
    )


def _normalize_candidate_path(value: str) -> str:
    """Validate repository-relative syntax without requiring existence."""
    value = value.strip().replace("\\", "/")
    if (
        not value
        or value.startswith("/")
        or "\0" in value
        or re.match(r"^[A-Za-z]:/", value)
    ):
        raise ValueError("path must be repository-relative")

    parts = [part for part in value.split("/") if part not in ("", ".")]
    if not parts or ".." in parts or parts[0] in {".git", ".koda"}:
        raise ValueError("path escapes repository")

    return "/".join(parts)


def _safe_path(root: Path, value: str) -> Path:
    relative = _normalize_candidate_path(value)
    candidate = (root / relative).resolve(strict=True)
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise ValueError("path escapes repository") from exc
    return candidate


def _safe_missing_path(root: Path, value: str) -> Path:
    """Validate a creation target without creating it."""
    relative = _normalize_candidate_path(value)
    candidate = root / relative

    ancestor = candidate.parent
    while ancestor != root and not ancestor.exists():
        ancestor = ancestor.parent

    try:
        resolved_ancestor = ancestor.resolve(strict=True)
        resolved_ancestor.relative_to(root)
    except (OSError, ValueError) as exc:
        raise ValueError("path escapes repository") from exc

    return candidate


def _relative_files(root: Path, limit: int = 4000) -> list[str]:
    files: list[str] = []
    for current, dirs, names in os.walk(root):
        dirs[:] = sorted(
            d for d in dirs if d not in SKIP_DIRS and not d.startswith(".koda")
        )
        base = Path(current)
        for name in sorted(names):
            path = base / name
            try:
                relative = path.relative_to(root).as_posix()
            except ValueError:
                continue
            files.append(relative)
            if len(files) >= limit:
                return files
    return files


def _snapshot(root: Path) -> str:
    digest = hashlib.sha256()
    for relative in _relative_files(root, 20_000):
        path = root / relative
        try:
            if path.is_symlink():
                digest.update(f"L:{relative}:{os.readlink(path)}\n".encode())
            elif path.is_file():
                digest.update(f"F:{relative}:".encode())
                with path.open("rb") as source:
                    while chunk := source.read(128 * 1024):
                        digest.update(chunk)
        except OSError:
            digest.update(f"E:{relative}\n".encode())
    return digest.hexdigest()


def _creation_allowed(task: str, root: Path) -> bool:
    if not _relative_files(root, 1):
        return True

    return bool(
        re.search(
            r"\b(?:create|scaffold|bootstrap|initialize|initialise)\b"
            r"|\bnew\s+(?:file|module|component|class|service|package|test|spec)\b"
            r"|\badd\b[^\n]{0,100}\b(?:test|tests|spec|specs)\b",
            task,
            re.IGNORECASE,
        )
    )


class _TextObservation(Observation):
    pass


class ListFilesAction(Action):
    glob: str = Field(default="**/*", description="Optional repository-relative glob")
    limit: int = Field(default=200, ge=1, le=500)


class SearchCodeAction(Action):
    query: str = Field(min_length=1, max_length=200, description="Literal text or regular expression")
    glob: str = Field(default="**/*", description="Optional repository-relative glob")
    limit: int = Field(default=80, ge=1, le=200)


class ReadFileAction(Action):
    path: str = Field(description="Repository-relative file path")
    start_line: int = Field(default=1, ge=1)
    end_line: int = Field(default=240, ge=1)


class InspectImportsAction(Action):
    path: str = Field(description="Repository-relative source file")


class FileReason(BaseModel):
    path: str
    reason: str


class Dependency(BaseModel):
    from_path: str = Field(alias="from")
    to: str
    kind: str

    model_config: ClassVar[dict[str, Any]] = {"populate_by_name": True}


class Evidence(BaseModel):
    path: str
    detail: str


class SubmitExplorationAction(Action):
    confidence: str = Field(pattern="^(high|medium|low)$")
    editable_candidates: list[FileReason] = Field(default_factory=list, max_length=128)
    readonly_files: list[FileReason] = Field(default_factory=list, max_length=16)
    related_tests: list[str] = Field(default_factory=list, max_length=12)
    dependencies: list[Dependency] = Field(default_factory=list, max_length=24)
    evidence: list[Evidence] = Field(default_factory=list, max_length=24)
    unresolved_questions: list[str] = Field(default_factory=list, max_length=12)


class RepositoryExecutor(ToolExecutor):
    def __init__(self, root: Path, kind: str, state: dict[str, Any]):
        self.root = root
        self.kind = kind
        self.state = state

    def _record(self, paths: list[str] | None = None) -> None:
        new_paths = set(paths or []) - self.state["files_inspected"]
        if len(self.state["files_inspected"]) + len(new_paths) > self.state["max_files_read"]:
            raise ValueError("repository file-read budget exhausted")
        self.state["tool_calls"] += 1
        self.state["files_inspected"].update(paths or [])

    def _validate_submission(self, result: dict[str, Any]) -> str | None:
        editable = result.get("editable_candidates") or []

        if self.state.get("mutation_required", False) and not editable:
            if self.state.get("creation_allowed", False):
                return (
                    "SUBMISSION REJECTED: editable_candidates is empty for a mutation task. "
                    "Existing targets must be grounded in files you inspected. If the task "
                    "genuinely requires a new file or the repository is empty, propose the "
                    "smallest safe repository-relative creation path in editable_candidates."
                )
            return (
                "SUBMISSION REJECTED: editable_candidates is empty for a repository mutation "
                "task. Review the evidence you already collected, identify the actual existing "
                "implementation file(s), inspect them if necessary, and submit the smallest "
                "evidence-backed editable scope."
            )

        for item in editable:
            raw = item.get("path")
            if not isinstance(raw, str):
                return "SUBMISSION REJECTED: editable candidate path must be a string."

            try:
                relative = _normalize_candidate_path(raw)
            except ValueError as exc:
                return f"SUBMISSION REJECTED: unsafe editable path {raw!r}: {exc}"

            candidate = self.root / relative
            if candidate.exists():
                try:
                    safe = _safe_path(self.root, relative)
                except ValueError as exc:
                    return f"SUBMISSION REJECTED: unsafe editable path {relative!r}: {exc}"

                if not safe.is_file():
                    return f"SUBMISSION REJECTED: editable candidate must be a file: {relative}"

                if relative not in self.state["files_inspected"]:
                    return (
                        "SUBMISSION REJECTED: existing editable candidate "
                        f"{relative} has not been inspected. Read or search that file first "
                        "so the scope is evidence-backed."
                    )
                continue

            if not self.state.get("creation_allowed", False):
                return (
                    f"SUBMISSION REJECTED: missing editable path {relative} is not authorized "
                    "by this task. Existing targets must come from repository evidence."
                )

            try:
                _safe_missing_path(self.root, relative)
            except ValueError as exc:
                return f"SUBMISSION REJECTED: unsafe creation path {relative!r}: {exc}"

        return None

    def __call__(self, action: Action, conversation=None) -> Observation:  # noqa: ANN001, ARG002
        try:
            if self.kind == "list":
                assert isinstance(action, ListFilesAction)
                files = [
                    path
                    for path in _relative_files(self.root)
                    if fnmatch.fnmatch(path, action.glob)
                ][: action.limit]
                self._record()
                return _TextObservation.from_text("\n".join(files))

            if self.kind == "search":
                assert isinstance(action, SearchCodeAction)
                try:
                    pattern = re.compile(action.query, re.IGNORECASE)
                except re.error:
                    pattern = re.compile(re.escape(action.query), re.IGNORECASE)

                matches: list[str] = []
                inspected: list[str] = []
                for relative in _relative_files(self.root):
                    if not fnmatch.fnmatch(relative, action.glob):
                        continue
                    path = self.root / relative
                    if relative not in self.state["files_inspected"] and (
                        len(self.state["files_inspected"]) + len(set(inspected))
                        >= self.state["max_files_read"]
                    ):
                        break
                    try:
                        if path.stat().st_size > 1_000_000:
                            continue
                        text = path.read_text("utf-8", errors="replace")
                    except OSError:
                        continue
                    inspected.append(relative)
                    for number, line in enumerate(text.splitlines(), 1):
                        if pattern.search(line):
                            matches.append(f"{relative}:{number}:{line[:300]}")
                            if len(matches) >= action.limit:
                                break
                    if len(matches) >= action.limit:
                        break

                self._record(inspected)
                return _TextObservation.from_text("\n".join(matches)[:MAX_TOOL_TEXT])

            if self.kind == "read":
                assert isinstance(action, ReadFileAction)
                path = _safe_path(self.root, action.path)
                if not path.is_file():
                    raise ValueError("path is not a file")
                relative = path.relative_to(self.root).as_posix()
                lines = path.read_text("utf-8", errors="replace").splitlines()
                end = min(len(lines), action.end_line, action.start_line + 399)
                body = "\n".join(
                    f"{index}: {lines[index - 1]}"
                    for index in range(action.start_line, end + 1)
                )
                self._record([relative])
                return _TextObservation.from_text(body[:MAX_TOOL_TEXT])

            if self.kind == "imports":
                assert isinstance(action, InspectImportsAction)
                path = _safe_path(self.root, action.path)
                relative = path.relative_to(self.root).as_posix()
                text = path.read_text("utf-8", errors="replace")
                import_lines = [
                    f"{number}: {line[:500]}"
                    for number, line in enumerate(text.splitlines(), 1)
                    if re.search(r"^\s*(?:import\b|from\b|require\s*\(|use\b|#include\b)", line)
                ][:120]
                self._record([relative])
                return _TextObservation.from_text("\n".join(import_lines)[:MAX_TOOL_TEXT])

            if self.kind == "submit":
                assert isinstance(action, SubmitExplorationAction)
                self.state["tool_calls"] += 1
                result = action.model_dump(by_alias=True)
                rejection = self._validate_submission(result)
                if rejection:
                    return _TextObservation.from_text(rejection, is_error=True)
                self.state["result"] = result
                return _TextObservation.from_text("Repository exploration accepted. Finish now.")

            raise ValueError("unknown tool")
        except Exception as exc:
            self.state["tool_calls"] += 1
            return _TextObservation.from_text(str(exc), is_error=True)


def _definition(name: str, action_type: type[Action], description: str, executor: ToolExecutor) -> type[ToolDefinition]:
    class KodaReadOnlyTool(ToolDefinition):
        @classmethod
        def create(cls, conv_state=None, **params) -> Sequence[Self]:  # noqa: ANN001, ARG003
            if params:
                raise ValueError("Koda read-only tools do not accept configuration")
            return [
                cls(
                    description=description,
                    action_type=action_type,
                    observation_type=_TextObservation,
                    executor=executor,
                    annotations=ToolAnnotations(
                        readOnlyHint=True,
                        destructiveHint=False,
                        idempotentHint=True,
                        openWorldHint=False,
                    ),
                )
            ]

    KodaReadOnlyTool.name = name
    return KodaReadOnlyTool


def _metrics(conversation) -> dict[str, Any]:  # noqa: ANN001
    prompt = completion = cached = cache_write = 0
    cost = 0.0
    model_calls = 0
    for metrics in conversation.state.stats.usage_to_metrics.values():
        cost += float(metrics.accumulated_cost)
        model_calls += len(metrics.token_usages)
        for usage in metrics.token_usages:
            prompt += usage.prompt_tokens
            completion += usage.completion_tokens
            cached += usage.cache_read_tokens
            cache_write += usage.cache_write_tokens
    return {
        "input_tokens": prompt,
        "output_tokens": completion,
        "cached_input_tokens": cached,
        "cache_write_tokens": cache_write,
        "cost_usd": cost,
        "model_calls": model_calls,
    }


def run(request: dict[str, Any]) -> dict[str, Any]:
    started = time.monotonic()
    root = Path(request["repo_path"]).resolve(strict=True)
    before = _snapshot(root)
    task = str(request.get("task", ""))

    state: dict[str, Any] = {
        "result": None,
        "tool_calls": 0,
        "files_inspected": set(),
        "max_files_read": request["max_files_read"],
        "mutation_required": bool(
            re.search(
                r"\b(?:add|change|modify|update|fix|refactor|rewrite|rename|remove|delete|"
                r"replace|implement|migrate|introduce|create|adjust|patch)\b",
                task,
                re.IGNORECASE,
            )
        ),
        "creation_allowed": _creation_allowed(task, root),
    }

    tools: list[Tool] = []
    specs = [
        ("koda_list_repository", ListFilesAction, "List bounded repository-relative file paths.", "list"),
        ("koda_search_repository", SearchCodeAction, "Search repository files and return path:line evidence.", "search"),
        ("koda_read_repository_file", ReadFileAction, "Read a bounded line range from one repository file.", "read"),
        ("koda_inspect_imports", InspectImportsAction, "Read import/reference declarations from one source file.", "imports"),
        ("koda_submit_repository_exploration", SubmitExplorationAction, "Submit the structured, evidence-backed repository exploration result.", "submit"),
    ]
    for name, action_type, description, kind in specs:
        register_tool(name, _definition(name, action_type, description, RepositoryExecutor(root, kind, state)))
        tools.append(Tool(name=name))

    llm = LLM(
        model=request["llm_model"],
        api_key=os.environ.get("KODA_EXPLORER_API_KEY", "missing"),
        base_url=request.get("base_url"),
        num_retries=0,
        timeout=max(1, int(request["request_timeout_ms"] / 1000)),
        max_input_tokens=request["max_input_tokens"],
        max_output_tokens=request["max_output_tokens"],
        input_cost_per_token=request.get("input_cost_per_token"),
        output_cost_per_token=request.get("output_cost_per_token"),
        native_tool_calling=True,
        reasoning_effort=request.get("reasoning_effort", "low"),
    )

    system = """You are Koda's read-only repository explorer.

Your job is to identify the smallest implementation scope that a later Aider
coding worker should modify.

You may list, search, and read the repository, follow imports and references,
and inspect relevant tests.

You cannot edit files and cannot run shell commands.

GROUNDING RULES

1. Existing editable files must be grounded in repository evidence. Inspect an
   existing file before placing it in editable_candidates.
2. Never invent an EXISTING path.
3. A missing path may be proposed only when the user task genuinely requires a
   new file, module, test/spec, scaffold, or when the repository is empty.
4. Proposed new paths must be the smallest sensible repository-relative paths.
   Never use absolute paths, '..', '.git', or '.koda'.

OUTPUT CONTRACT

5. For every mutation task, editable_candidates must contain the files Aider
   actually needs permission to modify or create.
6. Do not put every inspected file into editable_candidates.
7. Tests belong in related_tests unless the task explicitly requires changing
   them. If the task requires changing or creating tests, include those tests
   in editable_candidates.
8. Dependencies and contextual files belong in readonly_files.
9. If you have identified the responsible implementation file, stop broad
   exploration and submit the scope.
10. If the task requires a new file and no existing implementation file is the
    correct target, propose the new path in editable_candidates instead of
    searching forever for a file that does not exist.
11. Before submitting, ask: Which exact files would Aider need permission to
    change or create to complete this task?
12. Finish by calling koda_submit_repository_exploration.
13. If the submission tool rejects the result, correct the scope using the
    error message. Do not answer with prose instead.
14. If two or fewer iterations remain, submit the best grounded scope already
    available rather than continuing broad discovery.

The objective is accurate write-scope discovery, not maximum repository coverage.
"""

    agent = Agent(llm=llm, tools=tools, system_prompt=system)
    conversation = Conversation(
        agent,
        workspace=root,
        persistence_dir=None,
        visualizer=None,
        max_iteration_per_run=request["max_iterations"],
        stuck_detection=True,
    )

    provider_dispatched = False
    try:
        prompt = {
            "task": request["task"],
            "continuation_reason": request.get("continuation_reason"),
            "previous_exploration": request.get("previous_exploration"),
            "creation_allowed": state["creation_allowed"],
            "repository_empty": not bool(_relative_files(root, 1)),
            "limits": {
                "editable_candidates": 128,
                "readonly_files": 16,
                "related_tests": 12,
                "files_read": request["max_files_read"],
            },
        }
        conversation.send_message(json.dumps(prompt, separators=(",", ":")))
        provider_dispatched = True

        try:
            conversation.run()
        except Exception as exc:
            if not _is_iteration_limit_error(exc):
                raise BridgeFailure(f"{type(exc).__name__}: {exc}", True) from exc

        if state["result"] is None:
            conversation.max_iteration_per_run = 1
            conversation.send_message(
                "FINALIZATION ONLY. Do not search, list, read files, or inspect imports. "
                "Using only repository evidence already observed plus the creation permission "
                "in the task payload, call koda_submit_repository_exploration exactly once now. "
                "Existing editable paths must have been inspected. If creation_allowed is true "
                "and the task requires a missing file, you may propose the smallest safe "
                "repository-relative creation path. Do not answer with prose."
            )
            try:
                conversation.run()
            except Exception as exc:
                if state["result"] is None or not _is_iteration_limit_error(exc):
                    raise BridgeFailure(f"{type(exc).__name__}: {exc}", True) from exc

        metrics = _metrics(conversation)
    finally:
        conversation.close()

    after = _snapshot(root)
    if before != after:
        raise BridgeFailure("READ_ONLY_VIOLATION: OpenHands exploration mutated the repository", True)
    if metrics["cost_usd"] > request["budget_usd"]:
        raise BridgeFailure("EXPLORATION_USD_BUDGET_EXHAUSTED", True)

    result = state["result"] or {
        "confidence": "low",
        "editable_candidates": [],
        "readonly_files": [],
        "related_tests": [],
        "dependencies": [],
        "evidence": [],
        "unresolved_questions": ["Exploration ended before structured evidence was submitted."],
    }

    if (
        state["result"] is not None
        and not result.get("editable_candidates")
        and not result.get("unresolved_questions")
    ):
        result["unresolved_questions"] = ["Mutation task produced no editable_candidates."]

    return {
        "status": "completed",
        "sdk_version": SDK_VERSION,
        "provider_dispatched": provider_dispatched,
        "result": result,
        "tool_calls": state["tool_calls"],
        "files_inspected": sorted(state["files_inspected"])[: request["max_files_read"]],
        "wall_clock_ms": round((time.monotonic() - started) * 1000),
        **metrics,
    }


def main() -> int:
    request_path, report_path = map(Path, sys.argv[1:3])
    request = json.loads(request_path.read_text("utf-8"))
    report: dict[str, Any]
    try:
        report = run(request)
    except Exception as exc:
        report = {
            "status": "infra_failure",
            "sdk_version": SDK_VERSION,
            "provider_dispatched": bool(getattr(exc, "provider_dispatched", False)),
            "error": f"{type(exc).__name__}: {exc}",
            "wall_clock_ms": 0,
        }
    report_path.write_text(json.dumps(report, separators=(",", ":")), "utf-8")
    return 0 if report["status"] == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())

# Koda engineering contract

## Product objective

Koda is a coding-agent orchestration system.

Its core objective is NOT to use cheap models at any cost.


It must choose the lowest-cost / lowest-latency execution plan that preserves
approximately frontier-level VERIFIED final outcomes.

This can include:
- cheaper model first
- deterministic verification
- escalation only when evidence requires it
- parallel execution for genuinely independent work

The primary business metrics are:
- resolved-task rate
- cost per resolved task
- wall-clock time per resolved task

## Hard invariants

- Never hardcode SWE-bench task IDs, benchmark repos, benchmark solutions, or task-specific heuristics.
- Never weaken correctness checks merely to improve benchmark numbers.
- Verification infrastructure failure is not coding failure.
- Provider timeout / 429 / 5xx / sandbox failure / missing environment is not negative model-quality evidence.
- Failed or not-fully-verified candidates must never auto-apply to the user's original repo.
- Candidate source changes must remain inspectable even when internal verification fails.
- Preserve parallel execution architecture.
- Concurrent workers must never mutate overlapping write scopes.
- Quality outranks cost. Cost and latency are optimized only among execution plans expected to preserve the required final quality.
- Do not make unrelated refactors.

## Existing architecture

Inspect current code before changing it. Several systems are already partially implemented.

Important areas include:
- src/verifier/
- src/router/
- src/openrouter/
- src/repo/
- src/workspace/
- src/run.ts

Do not rebuild an existing subsystem from scratch unless the current architecture makes the requirement impossible.

## Development workflow

For each task:
- inspect relevant current implementation first
- reproduce the failure or establish the current behavior
- make the smallest general fix
- add deterministic regression tests
- run focused tests while iterating
- run pnpm typecheck before completion
- run the full pnpm test suite once the implementation is stable

Do not repeatedly run the entire suite after every small edit unless necessary.

## Completion standard

A change is not finished merely because code was written.

It is finished only when:
- requested behavior exists
- regression tests cover it
- pnpm typecheck passes
- pnpm test passes
- no benchmark-specific hacks were added

Keep the final report concise:
- root cause
- files changed
- behavior before/after
- test result
- remaining limitation, if any

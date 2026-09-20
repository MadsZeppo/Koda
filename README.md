# Koda: parallel coding-agent experiment

A local TypeScript CLI for measuring whether explicit model routing and isolated parallel execution can reduce coding-agent cost and latency while preserving executable task success. No server, dashboard, accounts, database, or billing system.

## Run

Requires Node.js 22+, pnpm, ripgrep, and **macOS `sandbox-exec` or Linux `bubblewrap` (`bwrap`)**. Git is optional for non-Git and dirty-workspace runs. The macOS execution path is tested; Linux support requires a host that permits unprivileged namespaces.

```sh
pnpm install
export OPENROUTER_API_KEY='your-key'
pnpm agent run \
  --repo /absolute/path/to/repository \
  --task "Implement X and fix Y" \
  --max-parallel 3 \
  --budget-usd 5
```

Koda chooses a workspace backend before profiling. A clean Git repository uses the existing isolated Git worktree and integration branch. A dirty Git checkout or ordinary non-Git directory uses bounded filesystem snapshots; tracked edits and untracked files are part of the immutable baseline. Both modes leave the original directory untouched while agents run.

The default is preview mode. Review `summary.json`, `workspace.json`, and the printed integration directory. Apply that exact verified preview with `pnpm agent apply --run /absolute/path/to/run-output`, or pass `--apply` to a run to apply immediately after verification. Apply compares every affected original file with the baseline first and refuses the whole operation on a conflict. A failed or incomplete verification is never applied. To undo an applied run, use `pnpm agent revert --run /absolute/path/to/run-output`; revert also refuses to overwrite files edited since apply.

Install the target repository's dependencies **before** running Koda. Existing `node_modules` is copied into each worktree (copy-on-write where supported), never shared as a writable directory. Global toolchains under standard system paths are readable. Home-directory toolchains, virtual environments, workspace symlinks escaping the worktree, network-dependent tests, and services requiring network access need adaptation to the sandbox. V0 does not autonomously install packages or provision external services. Dependencies added by a task may therefore require another run after installation.

The agent can read/write files, search, inspect git status/diffs, and execute shell commands. Shell commands are sandboxed: writable files stay inside their own worktree, `.git` metadata is protected, network access is denied, and only the worktree plus system/toolchain paths are readable. Environment variables are reduced to a small allowlist, so the OpenRouter key is not inherited by commands. File tools reject traversal and escaping symlinks. This is an experimental local developer tool, not a hardened hostile-code hosting service.

## Adaptive execution and focused context

Before any model call, deterministic local rules select `direct` or `planned` and log `execution_strategy` plus `strategy_reason`. DIRECT is the default when there is no demonstrated benefit from decomposition. A uniquely named file remains DIRECT even in a large monorepo when the request has no dependency, migration, architecture, broad-scope, or multiple-action signals. Explicit independent work, cross-component work, multiple action clauses, three or more implementation targets, client/server changes, or broad task wording select PLANNED. File names and profiled symbols identify likely targets. See `src/router/executionStrategy.ts` for the exact guards.

DIRECT sends the original request to one coder in the isolated integration worktree. It skips the planner, DAG generation, scheduler, scout calls, and speculative races. It can modify tightly coupled files: inferred source targets, local imports, and matching existing tests are included in the write scope. Unknown targets use the small source inventory or repository scope. Existing write guards, sandbox, budgets, escalation, and final verification remain active.

Both strategies compile context locally: explicit/likely paths, lexical matches, related tests, package configuration, and one-hop imports. Configurable `context` limits bound scanned files, read prefixes, snippet bytes/count, serialized context, tool results, and serialized conversation messages. Older complete conversation exchanges are discarded before exceeding the prompt limit; the original task remains. The prompt limit excludes the fixed tool schemas. There is no embedding service or worker scout model call.

Workers run appropriate executable checks before the first coder call. A passing clean worktree finishes with `no_changes_required` / `already_satisfied` and zero coder calls. Explicit task checks take precedence; otherwise simple native Node test scripts can use relevant tests when every target is covered, falling back to repository checks. After an edit passes acceptance verification, the loop stops immediately. Final repository, task, and benchmark checks remain mandatory. No meaningful executable checks means `NOT_FULLY_VERIFIED`.

Routing and lexical retrieval are heuristics: ambiguous wording can hide independent work, and inferred write scope can miss a dependency. Tests only certify behavior they cover. These changes reduce avoidable calls; no live latency improvement is claimed without measurement.

## Worker ownership

Every coding worker receives a frozen write scope derived from its normalized responsibility. The worker prompt makes that subtask the sole objective; parent acceptance criteria are not passed as the worker's assignment. Scope stays present across fallback and escalation. File tools reject unowned paths before creating directories or opening files, including traversal, symlink, and hardlink aliases. A `WRITE_SCOPE_VIOLATION` is returned to the model so it can recover; unchanged failing verification continues to count toward normal stall detection.

PLANNED worker context starts from assigned files, related tests, configuration, and explicit useful read hints. Independent sibling hints and unrelated lexical matches are excluded from both snippets and the compact file map. Direct imports (including TypeScript `.js` import specifiers) and genuine dependency read hints remain available. Reading a dependency does not grant write access.

Worker shell tools and task-specific verification execute in a disposable copy under the existing macOS/Linux sandbox. The runtime compares filesystem changes, including untracked/ignored files, deletions, modes, and links. Any out-of-scope mutation rejects the whole command's patch; the worker worktree stays unchanged. Only authorized regular-file changes are copied back. The existing command scratch directory, HOME/cache isolation, Git metadata protection, and network restrictions remain active. Use relative repository paths and `$TMPDIR`; temporary staging paths do not persist between commands. Copying uses filesystem cloning where supported, but copying and scanning a large dependency tree adds overhead. Linux uses the existing bubblewrap path; this implementation was validated on macOS.

Post-run write-responsibility validation remains in place before integration. Coalescing and scheduler overlap protection are unchanged: overlapping or broad scopes cannot run as independent writers. Final repository verification still runs after integration and is authoritative.

Reports include `workerScopes`: allowed writes, selected context files, attempted writes, successful writes, and violations per worker. Shell attempted-write telemetry reports observed filesystem changes rather than parsing shell command text.

## What happens

1. The workspace router snapshots current state and selects Git worktrees for clean Git or filesystem snapshots for dirty/non-Git input. Profiling then gathers commit/status when available plus a normalized file inventory, scripts, language/configuration signals, and likely checks before any model call.
2. On the PLANNED path, the scout model compiles a Zod-validated DAG with at most four tasks. Cycles and invalid dependencies are rejected. Context-only nodes are removed with dependency rewiring unless they declare a reusable artifact for multiple consumers. Same-layer tasks with at least 50% overlap of the smaller concrete write set are coalesced; objectives, contracts, checks, and dependencies are retained. Real dependencies and broad wildcard guesses are not merged. Overlapping write paths, wildcard paths, and non-parallel-safe tasks cannot execute together.
3. Ready tasks receive worktrees based on the latest integrated commit. Bounded local context and preflight verification run before any coder request.
4. Each worker independently selects a quality-qualified pool candidate using local features, metadata, and history. Stalls or stage budgets trigger a compact handoff to an untried stronger candidate.
5. Required executable checks gate commits. No checks means `NOT_FULLY_VERIFIED`; a model's “done” does not satisfy verification.
6. Git commits are cherry-picked through a serialized integration queue. Filesystem workers integrate byte-level create/modify/delete change sets through the same dependency and scheduling lifecycle. Conflicting paths fail closed; Git conflicts retain the existing strong-model resolution path.
7. Repository checks, all task checks, and benchmark-only checks run on the final integrated tree. The result is `VERIFIED_SUCCESS`, `FAILED`, or `NOT_FULLY_VERIFIED`.

“Verified” means the configured executable checks passed. It is not proof of requirements that those checks do not cover. Use independent benchmark tests to evaluate quality; do not infer Codex parity from the included mock tests.

## JS/TS and Python repo intelligence V1

The existing profiler now returns one normalized `profile.ecosystem`: ecosystem, languages, frameworks, package/environment manager with evidence and confidence, project roots, workspace status, config paths, ambiguities, and verification candidates. Legacy script/command fields are derived from this profile. Profiling reads bounded Git-tracked metadata only: at most 1,500 non-generated paths, 64 manifest units, 64 KiB per manifest, and small known environment locations. It never runs a project executable, installs dependencies, contacts a registry, or invokes a model.

JS/TS detection uses manifests, source extensions and tool configuration. Package-manager precedence is explicit `packageManager`/devEngines, a unique lockfile, declared workspace metadata, then npm for a package.json project. npm, pnpm, Yarn and Bun locks are recognized. Conflicting lockfiles remain an ambiguity; a supported explicit declaration wins. Next.js, React, Vite, Node.js, Express and NestJS are recognized, along with Vitest, Jest, Playwright and native Node tests.

Python metadata is parsed with `smol-toml`. The profile recognizes uv, Poetry, PDM, Pipenv locks and requirements-based pip environments; build backends are separate. FastAPI and Django, pytest, Ruff and mypy are recognized through declarations/configs. pytest takes precedence over native Django tests. Existing `.venv`/`venv` interpreters are used directly with `-B -m`, avoiding manager sync or lock updates entirely. For unmanaged/pip projects, existing PATH test/lint/typecheck executables may be used. Existing root/package node_modules and local Python environments are copied into isolated worktrees without provisioning.

Every verification candidate retains kind, command, relative cwd, source, origin, confidence and availability. A missing tool remains a discovered contract with `dependencies_not_available`. Unavailable selected checks produce `NOT_FULLY_VERIFIED`; process failures still produce `FAILED`. Tests, types, lint, build and aggregate checks have independent PASS/FAIL/NOT_RUN/UNAVAILABLE dimensions. Build never implies test success.

Task-specific executable checks retain precedence. Otherwise workers select project-local tests/checks/types/lint and avoid broad builds when faster contracts exist. Existing root Nx/Turbo/workspace verification scripts remain final authority for their dimensions, with uncovered local checks retained. Separate explicit integration-test scripts are retained at final verification. The integrated profile is refreshed, and original applicable contracts cannot disappear just because a manifest changed. Existing programmatic final verification overrides remain additional mandatory checks.

Automatic selection whitelists verification script names, inspects referenced scripts and pre/post hooks, and rejects known installation, server, deployment, release, destructive and auto-fix commands. Network restrictions remain enforced by the existing sandbox; package managers also receive offline/no-network environment settings. Automatically discovered checks execute in disposable copies: build/cache output is discarded, and changes to tracked source or non-ignored untracked files invalidate the check. Unknown scripts are not selected merely because they exist. This is conservative command selection, not a proof of the semantics of arbitrary repository scripts.

Workspace globs in package.json and ordinary pnpm YAML package lists identify manager inheritance. Nested package.json/pyproject.toml files define units; deepest matching root owns a file. Bounded relevant unit configs are included in worker retrieval. Planner prompts receive compact stack/unit metadata only. Router history gains ecosystem/framework categories with legacy observation compatibility; manager, runner, workspace and task-scope features are recorded without adding repository-specific buckets. Model pools, quality/cost/latency weights and escalation policy are unchanged.

Telemetry adds `repo_profile` and `verification_plan`; summaries contain the full ecosystem evidence, candidates, targeted selections, final selections and verification dimensions.

V1 limits: no full Nx/Turbo graph, complex workspace YAML or Yarn PnP resolver; no automatic dependency setup; no discovery of centrally stored Poetry/PDM environments; no automatic tox/nox environment provisioning; only simple native PDM/Hatch task strings can run from a resolved local environment. Local availability is filesystem evidence, not a guarantee all transitive dependencies or platform libraries work. Python imports, custom test-runner targeting and editable-install relocation are not comprehensively modeled. TypeScript project-reference configs require an explicit typecheck script. Configuration-driven semantic analysis is bounded, not a whole-repo scan. Profiling understands Windows environment paths, but command execution still requires the existing macOS/Linux sandbox. Go/Rust retain generic fallback behavior rather than first-class support.

## Planner Performance V1

Only PLANNED runs enter the local planner policy. Explicit independent repairs can produce a validated DAG without model calls. Other trivial/standard plans try an eligible cheap/fast candidate; dependency-heavy or cross-cutting tasks start strong. After invalid schema, unsafe ownership, unknown dependencies, or cycles, routing excludes the failed model and re-ranks every remaining qualified candidate using planner-specific quality, cost, latency, history, and remaining budget. At most three distinct candidates are attempted. Unknown billing and exhausted budgets still stop requests.

The deterministic gate deliberately accepts a narrow repair vocabulary: explicit independent/unrelated wording, 2–4 uniquely matched existing JS/TS files or symbols, and no extra unassigned requirements. Tasks must be at most 600 characters, with at most 40 JS/TS source files and 64 tests. Each assigned source must be a fully inspected leaf (at most 32 KiB, no imports or dynamic/global access markers), with exactly one distinct mapped native Node test importing only that source and Node test/assert modules. The existing test script must use `node --test` without pre/post hooks. Missing, ambiguous, coupled, or unsupported evidence falls through to model planning. This is conservative local evidence, not a proof of semantic independence; scoped execution and final repository verification remain authoritative.

Planner context contains bounded file/symbol/import/test metadata and a small repository map, normally no source bodies. Complex tasks can include two short relevant snippets. Defaults are 6,000 context bytes and 1,800 output tokens (also bounded by the existing global limits). The central model deadline policy defaults to 18 seconds for inspection/discovery, 30 seconds for planning, 45 seconds for an implementation turn, and 12 seconds for finalization; `modelTimeoutMs` configures each class.

Planner ranking uses only planning observations: DAG validation success by planner complexity, plus smoothed planner latency and charged cost. The independent default planner quality prior is 0.95 with strength 10 and threshold 0.90; it is an initial assumption, not measured accuracy. Optional candidate `plannerQualityPrior` and `plannerLatencyPriorMs` override planner priors without changing coder priors. Eligible candidates are ranked by `0.4 × cost / $0.001 + 0.6 × latency / 5000ms`. Catalog structured-output capability (or configured strength when metadata is absent), known prices, availability, and context limits remain required. Existing pool IDs and coder ranking are unchanged.

Configure targets and bounds under `planner` in `koda.config.example.json`. The CLI prints compact `planner_policy`, `planner_route`, and `planner_summary` events; detailed candidate scores remain in JSONL and summary telemetry. `summary.json.planning` records strategy, complexity, last model, elapsed planning time, cost, tokens, model calls, fallback count and DAG validity. Deterministic planning records zero model calls/cost/tokens and a null model. DIRECT has no planner policy or planner calls.

## Model Router V1

Normal runs load `koda.models.json`, a replaceable OpenRouter candidate pool. Use `--models-file /path/to/pool.json`, or `modelsFile` in a config (resolved relative to that config), to replace it. Each candidate declares an ID, enabled flag, tier, strengths, quality prior, and latency prior. The example IDs were checked against OpenRouter's `/api/v1/models` catalog on 2026-09-15. The priors are deliberately configurable assumptions, not measured success rates or latency claims. Free pricing gives no exemption from the quality filter.

Each executable worker extracts local features: task kind, languages, write paths/count, context size, dependencies, checks, repository size, and complexity/frontend/backend/refactor/bug-fix signals. DIRECT still makes zero planner calls. The planner uses the same pool with structured-output capability requirements; `routing.plannerCandidates` optionally limits its candidates.

Normal AUTO specialist routing evaluates every discovered model against the worker's task fingerprint. Availability, known prices, context, tools, required vision, and Stable's required `tool_choice` support are technical gates. Missing quality evidence is represented by priors and uncertainty. `qualityPrior` is a configurable ability prior, not measured Koda success; `tier` does not designate the reference. The reference is the compatible model with the strongest conservative task-local success estimate above `routing.minimumQuality` (default 0.90), even if it is outside the remaining budget.

The optimizer evaluates standalone estimates and two-stage plans: attempt, verify, then a stronger compatible model on recoverable failure. It returns the selected sequence to the existing execution loop. Nonterminal standalone estimates remain visible as counterfactuals because the existing recovery policy requires an affordable qualified fallback. Both attempts must fit the estimated remaining budget. Infrastructure unavailability earns no assumed recovery credit and retains its existing execution policy.

Final success is conservatively estimated as `pA + detection × (pB − pA)`, assuming correlated errors rather than independent successes. Recovery coverage priors are 0.95/0.65/0.25 for strong/medium/weak verification; these are policy assumptions, not measured rates. Regret compares both mean and conservative final success against the reference. Its cap is `routing.maxQualityRegret` (default 0.025), at most 0.025 for strong/medium verification or 0.012 for weak verification, halved for high-risk/architectural work. High-risk work also requires first-attempt parity. Bounded low-risk work with strong checks retains the existing relaxed first-attempt floor, but its whole plan must meet final parity. Shared uncertainty does not automatically exclude cheaper candidates under weak checks.

Among eligible plans, ranking minimizes `costWeight × expectedCost / finalSuccess + latencyWeight × expectedLatencyMs / finalSuccess / 1000 × $0.001`, plus the existing interactive latency penalty weighted by `latencyWeight`, with deterministic ID ties. Attempt estimates start from input/output prices and latency priors, then learn matching attempt token/time totals; operational calls separately inform latency and reliability. Latency estimates cover model time, not unmeasured verifier overhead. `specialist_route` telemetry includes reference/selected plans, standalone/final success, regret, completion cost/latency, and acceptance/rejection reasons. Explicit legacy routing retains its compatibility path.

A local JSONL ledger records model attempts, requested/served IDs, feature buckets, executable outcomes, tokens, charged cost, elapsed model time, and escalation. Specialist quality estimates blend a weak prior (weight 4) with task-local verified outcomes; matching fingerprints and write scopes receive more weight than distant observations. Only attributed coding regressions supply negative quality evidence. Provider, timeout, rate-limit, sandbox, dependency, and verification-infrastructure failures remain operational evidence. Planner DAG validation is recorded separately as `DAG_VALIDATED`, never as executable verified success. Final run failure removes provisional positive credit without turning that worker's success into a coding failure.

Catalog metadata is cached for six hours and refreshed once per run when stale or the pool changes. Fetch failure uses stale cache, then explicit candidate `fallback` metadata, then unknown pricing. Prices and fallback values are USD per million tokens; catalog per-token prices are converted, taking the maximum known long-context price band. Models with nonzero per-request surcharges are rejected because those charges are not bounded by prompt/completion price caps. Cache/history default to `~/.koda/model-router/<provider-url-hash>/`; configure `routing.stateDirectory` for isolated evaluation history. Cache replacement is atomic; ledger entries use append mode and fsync. Malformed/truncated ledger lines are ignored.

Before every request, the concurrency-safe budget reserves the full UTF-8 input bound and maximum output at provider-enforced price ceilings. Unknown prices or ambiguous charged cost stop spending. Explicit pre-generation rejection, timeout, connection failure, 429, or 5xx is operational evidence and can select an untried eligible model immediately; it never lowers coding-quality history. Malformed tool protocols with known response cost can also fall back. Attempts remain bounded by worker iterations, pool exhaustion, phase budgets, and run budgets.

Use `--routing auto` for automatic selection. `--force-model <configured-id>` bypasses the quality/objective choice for controlled evaluation, but preserves availability/capability checks, known pricing, budgets, sandboxing, context limits, execution strategy, and final verification. It never switches to a different model on failure and applies to the planner too on PLANNED runs. Use DIRECT fixtures for isolated coder comparisons.

Explicit legacy `models` role maps and role environment overrides retain the compatibility path unless a pool is explicitly supplied. `koda.free.json` remains unchanged. See [koda.config.example.json](koda.config.example.json) for the normal pool configuration. No OpenRouter inference was run during implementation; tests mock provider calls.

`--race` enables two distinct eligible pool candidates for high-difficulty tasks with at least two worker slots (two cheap roles in legacy mode). Forced-model evaluation disables races. Each candidate has its own directory and session. Only a verified candidate can win. In-flight requests are drained to preserve accounting; this can delay return after a winner is found. Only tasks actually eligible for a race reserve two slots; ordinary independent tasks each use one.

Run-wide USD, token, iteration, and wall-time limits are complemented by phase limits. By default discovery and planning can each spend at most 25% of the run, pre-implementation calls preserve 50% of USD/tokens for coding, and model calls leave a 15-second verification tail. Configure these under `phaseBudget`. Before sending a request, a shared ledger reserves a conservative maximum using UTF-8 request bytes as an input-token upper bound, maximum output tokens, and configured provider price ceilings. Concurrent reservations count against the same budget. Exact response `usage.cost` replaces the reservation; missing or ambiguous charged cost stops new requests and marks accounting incomplete.

Stage budgets are evaluated after each bounded call/check cycle; phase reservation is enforced before a model request. Model deadlines pass an abort signal to the provider client. Shell cleanup and speculative-worker draining can still extend wall time beyond the scheduling deadline.

## Reports and cleanup

Reports default to `~/.koda/runs/<run-id>/`; override with `--output` **outside the target checkout**. Each run writes:

- `plan.json`: normalized task DAG on PLANNED runs.
- `events.jsonl`: models requested/returned, provider when available, exact raw usage, all token/cache counters, charged cost, durations, tools, progress, escalations, verification, and integration events.
- `summary.json`: status, wall time, summed model cost/tokens, per-model totals, actual worker concurrency, escalations, frontier calls, conflicts, checks, and changed files. It also records total/planner/coder calls, calls per role, planned/coalesced task counts, per-worker context files/bytes, and final verification status. Concurrency is derived from coding-worker start/stop lifetimes, including verification and escalation, rather than DAG width; preflight no-ops do not count as coding workers.
- `workspace.json`: workspace mode/state, baseline counts, normalized change metadata, apply status, and conflicts. Byte-preserving before/after files for changed paths live under `workspace/` and support safe revert.

Successful worker directories are removed after integration. The final integration directory and failed attempts remain under the OS temporary directory for inspection. Clean Git mode also retains its integration branch; remove its linked worktree with `git -C /path/to/repo worktree remove /printed/worktree/path` when done. Reports and filesystem snapshot artifacts can contain repository source and command output; keep them private.

## Benchmarks and development

```sh
pnpm agent benchmark --manifest ./benchmarks/tasks.json
pnpm test
pnpm typecheck
pnpm build
```

See [benchmarks/README.md](benchmarks/README.md). Tests use real temporary Git repositories, sandboxed Node tests, and a local HTTP server implementing the OpenRouter response shape. They do not require a key or incur model charges. Paid-model quality, model availability, real provider usage behavior, and the cost/latency thesis require real benchmark runs; no such performance claim is made here.

Protocol references: [OpenRouter usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting), [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection), and [prompt caching/session IDs](https://openrouter.ai/docs/guides/best-practices/prompt-caching).

## Manual free-model routing runs

Create the committed, intentionally broken, dependency-free fixtures:

```sh
node scripts/create-routing-fixtures.mjs /tmp/koda-routing-fixtures
pnpm agent run --config ./koda.free.json --repo /tmp/koda-routing-fixtures/direct --task "Fix the add function so all tests pass."
pnpm agent run --config ./koda.free.json --repo /tmp/koda-routing-fixtures/parallel --task "Fix the broken math helper, slug helper, and display-name formatter so all tests pass. These are independent bugs." --max-parallel 3
```

Set `OPENROUTER_API_KEY` first. Fixture generation makes no model calls. Rerunning generation resets only marked fixture repositories; remove their retained linked worktrees before resetting. Unmarked directories are refused. `koda.free.json` is unchanged. No live OpenRouter benchmark was run for this implementation.

## Manual model-router evaluation

With `OPENROUTER_API_KEY` set, run from the Koda repository. These commands use paid pool candidates with a $0.10 per-run maximum, not the legacy free config. Worktrees preserve the fixtures' original broken checkout, so the same task can be repeated without resetting between runs.

```sh
node scripts/create-routing-fixtures.mjs /tmp/koda-model-router-v1

pnpm agent run --models-file ./koda.models.json --routing auto --budget-usd 0.10 --repo /tmp/koda-model-router-v1/direct --task "Fix the add function so all tests pass."

pnpm agent run --models-file ./koda.models.json --routing auto --budget-usd 0.10 --max-parallel 3 --repo /tmp/koda-model-router-v1/parallel --task "Fix the broken math helper, slug helper, and display-name formatter so all tests pass. These are independent bugs."

pnpm agent run --models-file ./koda.models.json --force-model qwen/qwen3-coder-30b-a3b-instruct --budget-usd 0.10 --repo /tmp/koda-model-router-v1/direct --task "Fix the add function so all tests pass."

pnpm agent run --models-file ./koda.models.json --force-model openai/gpt-5.6-sol --budget-usd 0.10 --repo /tmp/koda-model-router-v1/direct --task "Fix the add function so all tests pass."
```

Look for `execution_strategy`, `model_router`, `selected_model`, `routing_reason`, `estimated_quality`, model cost, wall clock, and verification. `summary.json` includes routing decisions/candidates, attempts, fallbacks, planner models/calls, actual per-call tokens/cost/time, concurrency, and final verification. A $0.10 budget can stop a larger/parallel run before completion; it is a cap, not a completion guarantee. No comparison with Codex or other agents has been established.

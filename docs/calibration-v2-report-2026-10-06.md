# Offline calibration hardening — 2026-10-06

## A. Scope and authority

LegacyProductionRouter remains production authority. ContextualRouterVNext remains shadow: no activation, dispatch/recovery override or writes to production quality history. Offline experimental assignments live only in the dedicated benchmark child. No qualityPrior, specialist posterior or tier score is used to choose experimental models. Calibration engine is Agentic, one coding attempt, no cross-model rescue; all stages/registry roles use the same assigned model. Zero-quality fields in the shared execution shape mean unmeasured, not a quality claim. The proxy rejects any other requested or served identity.

## B. Root causes and changed files

Host Python lacked repository dependencies; this was incorrectly conflated with candidate failure. Whole-job forecasts were insufficient to protect concurrent provider calls. Stage A cache identity and statistical denominators did not adequately separate infrastructure failure and ground truth. A forced-model flag also bypassed the immutable execution-plan selector; production selection would reject some experimental assignments before measurement. These are now separate offline runtime, experimental assignment and durable transport boundaries.

- src/dev/calibrationBudget.ts
- src/dev/calibrationTransport.ts
- src/dev/calibrationPlan.ts
- src/dev/verificationRuntime.ts
- src/dev/verifierPilot.ts
- src/dev/nativeCalibration.ts
- src/dev/verifierCalibration.ts
- src/dev/realBenchmark.ts
- src/dev/realBenchmarkWorker.ts
- src/run.ts
- src/router/knowledge/nativeCalibrationAdapter.ts
- tests/calibrationSafety.test.ts
- tests/contextualMilestone.test.ts
- package.json
- docs/calibration-v2-report-2026-10-06.md

The worktree already contained unrelated changes; they were retained.

## C. Verifier runtime

Task metadata explicitly selects a pinned container image/workdir or repository environment/venv. No host pytest installation or automatic image pull. Preflight checks Docker/daemon/platform/disk, pinned commit, task image and Stage A runner. Containers run with no network, host volume, Docker socket or provider key; resource limits and --pull=never apply. Image ID, tool versions and harness/environment digests are recorded. A reused image's baked workdir is removed before copying the pinned candidate checkout. Missing tools/images are unresolved infrastructure, never model failure.

Docker was reachable (linux/aarch64). The cached preact task image supplied Node 20.20.2 for the mechanics smoke under amd64 emulation. The two actual Requests task images were absent. Public image manifest inspection succeeded but no layers were downloaded. This is a preparation gap, not proof that those tasks cannot run here.

## D. Leakage protection

Stage A parses an allowlist of runtime/task fields, never Stage B labels/gold fields. Gold files stay outside candidate/workspaces. A pinned base clone has its complete .git history removed and a new base-only history created, preventing future gold commits from being inspected. Container mounts expose no external oracle files. Stage A freezes task/base/patch/run/code/environment digests, commands, check results, stdout/stderr hashes, proof and timestamp before Stage B opens truth. Stage B validates the frozen digest first and creates an immutable labeled artifact. Resume rejects changed patches, code, environments or labels. Corpus paths are trusted local inputs; this is not a security boundary against malicious host symlinks or a compromised Docker daemon.

## E. Actual verifier smoke

| Corpus | Candidates | Evaluable | Infrastructure unresolved | Correct / wrong | Accept / reject | False accept / false reject |
|---|---:|---:|---:|---:|---:|---:|
| Container integration fixture | 4 | 4 | 0 | 2 / 2 | 2 / 2 | 0 / 0 |
| Public Requests candidates | 2 | 0 | 2 | 1 / 1 | 0 / 0 | undefined / undefined |

Fixture resume was actually exercised. Fixture rows are permanently excluded from empirical measuredVerifier calibration, including large-support fixtures. Detection/correct acceptance are 2/2, Wilson interval [0.3424,1]; false rates 0/2, interval [0,0.6576]. Smoothed means in JSON are estimates, not observed rates. Public candidates provide no evaluable denominator. Missing environment never contributes to detection, false accept or false reject denominators.

Reports: /Users/madsflyvholm/.koda/routing-quality/calibration-v2/verifier-mechanics-results/report.json and /Users/madsflyvholm/.koda/routing-quality/calibration-v2/public-verifier-results/report.json. Preflight: /Users/madsflyvholm/.koda/routing-quality/calibration-v2/public-verifier-final/preflight.json.

## F–G. Discovery and diversity

Public metadata snapshot /Users/madsflyvholm/.koda/routing-quality/calibration-v2/public-models.json, fetched 2026-10-06T14:02:17.001Z: **465 discovered, 290 eligible, 24 selected**. Eligibility requires text/tool/tool_choice, sufficient context/output, known nonnegative prices and availability; excludes batch, virtual/composite and restricted identities. Prices use the ceiling across pricing tiers/overrides. Exact raw metadata remains in public-models.json, linked by digest 10155a516148bb144a98354b5d3f584b9e45a331a6db46fd2569b4ac0b00ae15; normalized snapshots retain canonical slug, capabilities, price ceiling and fetch time. Missing latency/revision/provider evidence stays unknown.

Selection uses seeded provider/family, price quartile, context, raw coding declaration, reasoning capability, age and observed-latency coverage. Price extremes/median are experimental anchors, not frontier-quality claims. There are 24 author/provider prefixes and 24 families in the selected set. A prefix is not proof of the actual serving endpoint. Input ceilings span $0–$60/M tokens, output $0–$270/M. Served model/provider and actual cost are recorded per request when returned.

Exact selected canonical IDs:

- apodex/apodex-1.1-mini:free
- openai/gpt-5.5-pro
- z-ai/glm-4.5v
- mistralai/mistral-medium-3
- qwen/qwen-plus
- meta/muse-spark-1.1
- meta-llama/llama-3.1-8b-instruct
- bytedance-seed/seed-1.6-flash
- anthropic/claude-haiku-4.5
- perceptron/perceptron-mk1.5
- rekaai/reka-edge
- nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free
- google/gemini-2.5-flash
- cohere/command-r-08-2024
- upstage/solar-pro-3
- moonshotai/kimi-k2
- inclusionai/ling-3.0-flash-sante:free
- tencent/hy3
- sakana/sakana-namazu
- aion-labs/aion-2.0
- deepseek/deepseek-v4-pro
- xiaomi/mimo-v2.5-pro
- poolside/laguna-s-2.1
- meituan/longcat-2.0

## H. Task selection

75 development candidates available; 20 small / 60 broad selected by seeded task-family/language/framework/complexity/risk/scope/proof coverage. Holdout is excluded and duplicate identities fail closed. Original task text is preserved. This available corpus is **all debugging/Python SWE tasks**: small complexity 19 low/1 medium; broad 59 low/1 medium; risk unknown and proof weak throughout. It is not a balanced frontend/backend/security benchmark. Repositories and independent oracle directories: **0 prepared**.

## I–J. Actual frozen dry runs

| Plan | Models | Tasks | Dense cells | Sparse cells | Total cells | One-call estimate | Hard maximum | Estimated over-cap cells |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Small | 8 | 20 | 80 (10×8) | 40 (10×4) | 120 | $29.87857119 | $12 | 19 |
| Broad | 24 | 60 | 480 (20×24) | 320 (40×8) | 800 | $53.57011957 | $80 | 31 |

Small uses the first eight IDs above. Estimated **complete multi-call task cost and runtime are unknown** until pilot measurements. One-call estimates are not full-task forecasts and do not replace caps. A $0.10 cell cap deliberately prevents expensive anchors from making an unaffordable request; do not interpret cap failures as quality failures.

Small artifact directory: /Users/madsflyvholm/.koda/routing-quality/calibration-v2/small-finalized; digest 1dcadb9f5f6234d0ab37a4e55e673352e999c64e79fb96491ed14bf1a310e5d6.
Broad artifact directory: /Users/madsflyvholm/.koda/routing-quality/calibration-v2/broad-finalized; digest 622e6988d5351679a2f4bbb2df6192191637c65370ec3d76985ccbda14cf1de7.
Each contains immutable experiment.json/model-snapshot.json/task-snapshot.json, plan.jsonl, budget-ledger.jsonl, results.jsonl, summary.json and report.md. Frozen models/tasks/config/engine/seed/harness/cost assumptions cannot change on resume.

## K. Budget safety

All billable child requests pass through a per-cell local transport sharing one serialized ledger. Before dispatch, exact payload UTF-8 bytes plus 1024 framing conservatively bound input tokens; explicit output cap and frozen price ceilings bound maximum dollars. Plugins, priced native tools, multimodal payloads, streaming, multiple completions and unknown parameter shapes are rejected. Provider price preferences are overwritten with frozen ceilings and fallbacks disabled. Append+fsync reservation occurs atomically before fetch. Integer nanodollar global and per-cell checks include every unsettled call, including parallel calls. Thus admitted outstanding liability plus settled charge cannot exceed the cap **under the enforced pricing/output contract**. Forecasts do not authorize dispatch.

Known actual usage replaces the reservation once; unknown/error/interrupted calls retain the full ceiling. Provider-reported cost/tokens exceeding the reservation halt/censor the cell and prevent additional scheduled work. No local program can guarantee external billing against an upstream provider violating its own enforced ceilings; that limitation is explicit, not hidden by a success claim.

## L. Resume safety

One experiment coordinator lock rejects competing processes. A hash-chained fsynced ledger prevents budget reset or corrupted/truncated replay. Unique call IDs/idempotent settlement avoid double charge. Completed cells are skipped; interrupted reserved cells are conservatively retained and not automatically re-billed. Crash between a published result and completion-state update can leave a cell marked interrupted; its artifacts remain inspectable and automatic replay stays blocked. New-model probes use their own immutable directory and fixed anchor task prefix, never rewrite the old experiment.

## M. Validation

- Final affected focused run: **89/89 passed**; final safety-only run **28/28 passed** (included in the 89). The earlier broader affected run passed **177/177**.
- Full `pnpm test`: **1,068 total; 1,067 passed; 1 skipped; 0 failed**, 136.86 seconds.
- `pnpm typecheck`: passed. `pnpm build`: passed.
- Changed-module formatting: passed for 13 selected source/test/config files. No repo-wide formatter was run; inherited formatting in `src/run.ts` was retained.

An intermediate full run timed out in the existing real Python/LiteLLM backend test under concurrent machine load. The final full rerun passed without changing that test or its timeout.

Deterministic tests cover discovery, budget concurrency/reconciliation/replay, provider identity and failure receipts, holdout/leakage, Stage A/B freeze/resume, container preflight, fixture censorship, experimental fixed engine and quality-prior independence. Mock upstreams are local; integration containers make zero model calls. Logs: `/tmp/koda-calibration-{focused,safety,full,typecheck,build}-final.log` and `/tmp/koda-calibration-format-check.log`.

## N. Paid calls

**PAID MODEL CALLS EXECUTED: 0**

Public metadata and image-manifest inspection only. No production routing activation; no claim of Codex superiority or frontier parity.

## O. Exact next commands

These commands are documentation only. Paid execution requires both --execute and KODA_ALLOW_PAID_CALIBRATION=1. First use Node 22 and set local paths:

```zsh
cd /Users/madsflyvholm/Desktop/Koda.ai
nvm use 22
CAL="$HOME/.koda/routing-quality/calibration-v2"
```

Verifier mechanics replay (zero paid calls):

```zsh
pnpm routing:verifier:pilot --source "$CAL/verifier-fixture/source.json" \
  --output "$CAL/verifier-mechanics-results" --max-candidates 4 --seed 20261006 --resume
```

Real public pilot preflight, then actual checks after explicitly preparing its task images:

```zsh
pnpm routing:verifier:preflight --source "$CAL/verifier-fixture/public-source.json" \
  --output "$CAL/public-preflight-next" --max-candidates 2 --seed 20261006
pnpm routing:verifier:pilot --source "$CAL/verifier-fixture/public-source.json" \
  --output "$CAL/public-pilot-next" --max-candidates 2 --seed 20261006
```

Small paid calibration (maximum $12, currently blocked by unprepared inputs):

```zsh
KODA_ALLOW_PAID_CALIBRATION=1 KODA_PROVIDER_MODE=backend KODA_API_URL=http://127.0.0.1:8787 \
pnpm routing:calibrate --manifest "$CAL/development-tasks.json" \
  --config koda.config.example.json --catalog "$CAL/public-models.json" \
  --models auto --max-models 8 --tasks 20 \
  --dense-core-tasks 10 --sparse-models-per-task 4 --seed 20261006 \
  --budget-usd 12 --per-attempt-budget-usd 0.10 --parallel 4 \
  --output "$CAL/small-finalized" --execute --resume
```

Broad paid calibration (maximum $80, **not recommended yet**):

```zsh
KODA_ALLOW_PAID_CALIBRATION=1 KODA_PROVIDER_MODE=backend KODA_API_URL=http://127.0.0.1:8787 \
pnpm routing:calibrate --manifest "$CAL/development-tasks.json" \
  --config koda.config.example.json --catalog "$CAL/public-models.json" \
  --models auto --max-models 24 --tasks 60 \
  --dense-core-tasks 20 --sparse-models-per-task 8 --seed 20261006 \
  --budget-usd 80 --per-attempt-budget-usd 0.10 --parallel 4 \
  --output "$CAL/broad-finalized" --execute --resume
```

New model probe: exact canonical ID from the frozen catalog, maximum $2 = 20 anchor cells × $0.10. Dry-run first; command will validate capabilities and create an immutable probe subdirectory. Paid follow-up uses identical options and adds the explicit environment opt-in:

```zsh
PROBE_MODEL='openai/gpt-6.1-sol'
pnpm routing:calibrate --manifest "$CAL/development-tasks.json" --config koda.config.example.json \
  --catalog "$CAL/public-models.json" --models auto --max-models 24 --tasks 60 \
  --probe "$PROBE_MODEL" --anchor-tasks 20 --seed 20261006 \
  --budget-usd 2 --per-attempt-budget-usd 0.10 --parallel 1 --output "$CAL/new-model-probes" --dry-run
KODA_ALLOW_PAID_CALIBRATION=1 KODA_PROVIDER_MODE=backend KODA_API_URL=http://127.0.0.1:8787 \
pnpm routing:calibrate --manifest "$CAL/development-tasks.json" --config koda.config.example.json \
  --catalog "$CAL/public-models.json" --models auto --max-models 24 --tasks 60 \
  --probe "$PROBE_MODEL" --anchor-tasks 20 --seed 20261006 \
  --budget-usd 2 --per-attempt-budget-usd 0.10 --parallel 1 --output "$CAL/new-model-probes" --execute --resume
```

## P. Recommendation

**Fix preparation first.** Pin and prepare actual repository/task runtimes and independent acceptance oracles, run the public zero-paid verifier pilot, add task-family coverage and review per-cell caps for expensive anchors. Changed manifest/config/caps require a fresh dry-run/digest. Then run a small paid pilot, measure actual calls/cost/latency, and only afterwards approve a broad run. Infrastructure mechanics are proven; empirical verifier support and complete native task preparation are not yet established.

## Runtime follow-up: actual local paid-smoke launch

Two startup failures were found before any upstream model dispatch: `--import tsx` resolved from the target repository, and the relocated calibration config inherited a relative `modelsFile` that both required a nonexistent file and could overwrite the frozen inline pool. The launcher now resolves Koda's loader to an absolute module URL; calibration-generated configs omit `modelsFile`. Production config semantics remain unchanged.

Regressions load the runtime from an empty target directory and load a generated cell config outside Koda without the source model file. A zero-paid integration run through the actual worker reached a local mock upstream, which intentionally returned HTTP 400. This proves dispatch, not a paid verified solve. The new prepared one-cell smoke plan is under `$HOME/.koda/routing-quality/paid-infra-smoke-1791297963122/run-v3`, with a $0.50 maximum. No new paid model call was executed by the assistant.

Harness changes intentionally invalidate the older approved digests above: regenerate their dry-run plans in new directories before attempting execution. Preserve prior results/ledgers; do not erase completed failure state to force automatic re-billing.

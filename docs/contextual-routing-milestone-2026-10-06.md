# Contextual routing milestone — implementation and measured limits

Production remains LegacyProductionRouter. ContextualRouterVNext remains shadow and cannot dispatch, change production recovery, or write production quality history. No paid model calls or native calibration were executed. This is a substantial implementation milestone, **not a completed frontier-parity validation**.

## Architecture and quality evidence

The canonical adapter admits raw task/model outcomes with source/revision/harness/split provenance. It excludes synthetic, holdout, operational and unproven local outcomes. VNext does not import legacy quality estimators, qualityPrior, specialist posteriors, attainable-reference scores, tier rankings or fixed legacy uncertainty penalties. The boundary has recursive dependency and production-shadow invariance tests.

Original task text is preserved. Structured assessment and verification contract are reused when available; indivisible oversized source task literals remain intact with unknown structured assessment. Optional outcome-blind lexical-hash vectors support task similarity. These are **not pretrained semantic embeddings**. No gold patch, hidden tests or ground-truth label enter task features.

Quality estimation compares empirical neighborhoods, logistic regression and a small tree on grouped development data. Missing models, uncertain versions and different harnesses retain broad uncertainty. Exact source IDs are not silently treated as current serving revisions. Native independently proven outcomes can override external evidence as support grows. Runtime records append to the canonical ledger; an explicit offline rebuild incorporates this ledger. Merely collecting new rows does not silently refit or activate the router.

Plan selection uses paired posterior task differences to estimate P(reference − candidate > 0.02), with default maximum risk 0.05 and an independent false-accept gate. Sparse pairs abstain. Reference versus itself has zero relative regret; that does **not** establish absolute task correctness. Conditional cross-model rescue uses only A-failure/B-outcome matched observations from the same task population, engine and harness. Same-model retries are separate. Unknown latency is unavailable, not a invented favorable latency estimate.

## Public sources and actual ingestion

- CodeRouterBench probing: 56,640 records / 7,080 task IDs / eight source model labels, reused from the existing normalized knowledge artifact. Coarse descriptors, not original task text. Previously viewed ID-test is excluded; it cannot be called pristine again.
- SWE-bench Verified: 500 original problem statements, pinned repository/base commits, 3,983 available submission outcomes, six raw model labels, five harnesses, eight configurations. Missing generations/logs are unavailable, never silently failures. Raw download cache may contain benchmark labels/gold fields; the normalized task packet never does.
- Eight admitted submissions: OpenHands Devstral Small 2505 (492), Claude 4 Sonnet dated 20250514 (499), Kimi K2 0711-preview (499), GPT-5 dated 2025-08-07 (499); Refact Claude-4-Sonnet (499, unresolved revision alias); Moatless dated Claude (497); TRAE Claude dated 20250522 (499); Lingxi dated Claude 20250514 (499). Harness/configuration identities stay separate.
- Three inspected submissions excluded for missing/ambiguous machine-readable model identity. No inferred multi-attempt aggregate is converted into a first-attempt result.
- CodeStruct inspected: patch predictions lack resolved labels, and CC BY-NC 4.0 is unsuitable for commercial quality priors. Excluded, not counted as ingested evidence.
- Repeated SWE-rebench/OpenHands trajectory source inspected (publisher advertises 67,074 rows; retained-study figures are not ingestion counts). First 100 rows had 100 distinct tasks. Three bounded repeat-anchor filter requests failed with dataset-index-loading HTTP 500. **Zero usable repeated task groups, zero sequential retry pairs**. A pilot artifact records this external blocker.
- SWE-Critix/CoderForge was not ingested. Single-family corpora do not supply unmeasured cross-model ranking evidence.

Sources: [SWE-bench experiments](https://github.com/SWE-bench/experiments), [SWE-bench Verified](https://huggingface.co/datasets/SWE-bench/SWE-bench_Verified), [agent subset metadata](https://github.com/SAILResearch/swe-agent-subset-selection), [CodeStruct](https://github.com/amazon-science/CodeStruct), [repeated trajectories](https://huggingface.co/datasets/nebius/SWE-rebench-openhands-trajectories).

## Splits and freezing

Task-hash grouping assigns 70% fit, 15% calibration, 15% development; all model rows of a task share the role. Synthetic and final-holdout rows are rejected before estimator selection. Source/task/model mapping/policy/split digests are frozen in immutable envelopes. Final evaluation claims are one-shot before reading labels; an interrupted reveal consumes the claim. No new final holdout was evaluated.

This split is a development protocol for the public source population, not a claim that benchmark public test labels are an untouched Koda holdout. The current native manifest is development-only; a separately prepared final holdout is still needed.

## Development results

Total admitted rows: **60,623**; original rich tasks: **500**; development observations: **9,020**.

| Estimator |    Brier | Log loss |      ECE |
| --------- | -------: | -------: | -------: |
| empirical | 0.135209 | 0.407535 | 0.025688 |
| logistic  | 0.140454 | 0.431243 | 0.045828 |
| tree      | 0.137855 | 0.425137 | 0.026301 |

Selected empirical on DEV. Pairwise ranking accuracy: 0.774572. Detailed source/category metrics are in the JSON report.

The previous lower-versus-upper gate selected 0% of 1,385 development task/harness groups. The new relative gate covers 100% because the reference itself is permitted. This number is **not** affordable-plan coverage, verified solve rate or proof of preserved Koda quality. Koda native coverage, regret calibration, false-accept calibration and cost/time per verified solve remain unavailable. Public SWE outcomes do not include measured per-attempt Koda cost/latency.

Twelve ordered OpenHands rescue comparisons have paired source support. Example: Devstral failure → Claude has 93 rescues / 187 matched failed first attempts, approximately 0.497. These are source-harness conditional outcomes, not evidence that Koda obtains the same rescue uplift. Real sequential same-model retry support is zero. Independently drawn marginal success rates never fabricate cascade quality.

## Real verifier pilot

Two public GPT-5 candidate patches were restored into actual pinned Requests repositories and sent through the normal verifier subprocess. Stage A has only runtime-visible task, patch, commands and proof class. Its immutable candidate/code/environment/check/decision digest is written before Stage B opens the external correctness label. The official incorrect candidate and correct candidate both returned UNRESOLVED because this environment has no pytest.

Counts: 2 restored candidates, 1 incorrect, 1 correct, 2 unresolved; detected failures 0/1, false accepts 0/1, false rejects 0/1. Wilson interval for each 0/1 event count is [0, 0.793457]. These wide intervals do not establish low false-accept risk. The displayed smoothed mean in the statistics helper is not an observed success rate. No paid completion reviewer was executed; runtime project tests plus explicit proof checks are the offline calibration boundary. A full normal model-review pilot remains outstanding. Missing pytest is infrastructure, not negative model-quality evidence.

## Cold-start examples

The following six categories were fixed before observing outcomes. They illustrate uncertainty handling, not model solve claims or a cherry-picked recommendation list. Candidate names are taken from the discovery dry-run, not a hardcoded production ranking.

| Category     | Candidate                        | Mean / interval        | Decision |
| ------------ | -------------------------------- | ---------------------- | -------- |
| small_edit   | aion-labs/aion-3.0-mini          | 0.500 / [0.000, 1.000] | ABSTAIN  |
| debugging    | amazon/nova-2-lite-v1            | 0.500 / [0.000, 1.000] | ABSTAIN  |
| backend      | anthropic/claude-haiku-4.5:batch | 0.500 / [0.000, 1.000] | ABSTAIN  |
| frontend     | apodex/apodex-1.1-mini:free      | 0.500 / [0.000, 1.000] | ABSTAIN  |
| security     | arcee-ai/trinity-large-thinking  | 0.500 / [0.000, 1.000] | ABSTAIN  |
| architecture | bytedance-seed/seed-1.6-flash    | 0.500 / [0.000, 1.000] | ABSTAIN  |

All lack measured current-model/Koda-harness/verifier evidence. A conservative neutral mean of 0.5 with [0,1] is unknown, not a quality promise. Unsupported security/architecture evidence does not fall back to legacy model rankings.

## Native calibration runner

Dynamic capability/price/context catalog selection; automatic model IDs are not hardcoded. Current pool selection round-robins vendors ordered by price within each vendor. This provides broad vendors but is **not yet a complete stratified mid/high-cost, reasoning/style pool design**. It is a calibration sampling rule, not inferred quality ranking.

The actual dry-run plans 30 models × 75 tasks = 2,250 independent jobs, maximum budget $225 at $0.10/job; expected cost and runtime are unavailable. Pinned repositories and independent acceptance oracles are **0/75 prepared** in this generated source-derived manifest. Execution refuses until preparation is complete. Do not describe this manifest as a ready real benchmark.

Budget and compatibility are checked before dispatch; reservations are persisted before each independent job; append-only results and frozen plan identity support resume. Interrupted reserved jobs are not silently billed twice. A probe can restrict the same deterministic task anchors to one new model. Independent ground-truth validation and actual serving revision feed the native canonical adapter; fake executors and operational failures cannot train quality.

## Commands

All commands below are explicit. Building/evaluating public data and dry-run cost $0 in model calls. Native execution is paid and was not run.

```zsh
cd /Users/madsflyvholm/Desktop/Koda.ai
nvm use 22

# Public source rebuild; model calls: $0
pnpm routing:build-public --output "$HOME/.koda/routing-quality/public-rebuild"

# DEV comparison, never a viewed holdout rerun
PUBLIC="$HOME/.koda/routing-quality/public-vnext/public-b8a5984998788a56327043de433a24b0f927b1566ccd4939ec441a5f459a2228.json"
pnpm routing:eval-contextual --public "$PUBLIC"   --coarse "$HOME/.koda/routing-quality/routing-knowledge-v2.json"   --output "$HOME/.koda/routing-quality/vnext-rebuild"
# Add --native-ledger /path/to/quality-local.jsonl to incorporate proven native outcomes.
# This writes a new offline artifact; it does not activate production routing.

# Inspection only: 2,250 runs, maximum paid execution ceiling $225
MANIFEST="$HOME/.koda/routing-quality/public-vnext/native-development-manifest.json"
pnpm routing:calibrate --manifest "$MANIFEST"   --config koda.config.example.json --models auto --max-models 30 --tasks 75   --budget-usd 225 --per-attempt-budget-usd 0.10 --parallel 4   --output "$HOME/.koda/routing-quality/native-calibration" --dry-run

# PAID: only after preparing every pinned repo and independent oracle.
# This is intentionally not run automatically. Same maximum $225.
KODA_PROVIDER_MODE=backend KODA_API_URL=http://127.0.0.1:8787 pnpm routing:calibrate --manifest "$MANIFEST"   --config koda.config.example.json --models auto --max-models 30 --tasks 75   --budget-usd 225 --per-attempt-budget-usd 0.10 --parallel 4   --output "$HOME/.koda/routing-quality/native-calibration" --execute
# Resume adds --resume; use a frozen --catalog file to preserve model metadata/plan identity.
# Single-model probing adds --probe EXACT_MODEL_ID and a separate output directory.
```

## Changed files for this milestone

Core: `src/router/canonicalTask.ts`, `lexicalTask.ts`, `contextualQuality.ts`, `pairedEvidence.ts`, `contextualPlans.ts`, `contextualRouterVNext.ts`, `contextualShadow.ts`, `modelRouter.ts`.

Evidence: `src/router/knowledge/canonical.ts`, `evidenceRegistry.ts`, `nativeCalibrationAdapter.ts`.

Offline runners: `src/dev/publicRoutingEvidence.ts`, `repeatedPublicEvidence.ts`, `verifierCalibration.ts`, `nativeCalibration.ts`, `contextualMilestoneEval.ts`; reused benchmark edits in `realBenchmark.ts`, `realBenchmarkWorker.ts`.

Runtime proof/learning: `src/run.ts`, `src/agent/codingExecutor.ts`, `src/verifier/verifier.ts`. Package scripts: `package.json`. Regression tests: `tests/contextualMilestone.test.ts`. This document. Earlier dirty worktree changes are not all changes of this milestone.

## Outstanding gates before activation

Measured public-to-Koda transfer; adequate native independently graded task/model calibration; more real verifier candidates with reproducible dependencies and completion review; calibrated paired-regret probabilities; separate prepared untouched holdout; richer legitimate semantic features; native pool cost/style strata; usable repeated runs; automatic explicit artifact rebuild/promotion governance. No frontier parity, automatic activation or complete all-domain calibration is claimed.

## Validation

- Focused affected routing/evidence/verification tests: 158/158 passed.
- Complete `pnpm test`: 1,040 tests, 1,039 passed, one skipped, zero failed (110.665 seconds).
- `pnpm typecheck`: passed.
- `pnpm build`: passed.
- Prettier check of the 22 milestone implementation/test files: passed.
- Global `pnpm format:check`: failed on 151 other existing files. Those were not reformatted as an unrelated refactor.
- Actual source DEV rebuild and native dry-run: passed, zero paid model calls.
- Public verifier pilot: both persisted decisions UNRESOLVED; not counted as successful coding or verifier calibration.

Final development artifact directory: `/Users/madsflyvholm/.koda/routing-quality/vnext-final/`. Actual verifier decisions and report: `/Users/madsflyvholm/.koda/routing-quality/verifier-vnext-final/`. Immutable public evidence: `/Users/madsflyvholm/.koda/routing-quality/public-vnext/`. Local test logs: `/tmp/koda-vnext-full-final.log`, `/tmp/koda-vnext-focused.log`, `/tmp/koda-vnext-typecheck-final.log`, `/tmp/koda-vnext-build-final.log`.

The offline artifact is available but production authority remains legacy. The existing default shadow artifact is not silently overwritten by an evaluation run. An explicit validated promotion of a frozen artifact is a separate operational step; no production activation occurred.

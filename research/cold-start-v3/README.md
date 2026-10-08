# COLD START V3 — SWE-FIRST RESULT

Isolated offline research. Production, ContextualRouterVNext, dispatch authority and production thresholds are unchanged. This experiment predicts six **public benchmark outcomes**, not verified Koda customer outcomes. No provider calls, native calibration or production history are used.

**Decision: NO_IMPROVEMENT.** SWE final: V3 24%, frozen-parameter V2 replay 23%, strongest static Sonnet 33%. Repository-held-out: V3 29.4%, V2 19.2%, strongest static 34.6%. No candidate exported.

Full numerical tables, calibration, complementarity and error analysis: [RESULTS.md](RESULTS.md).

## Reproduce

From the Koda repository root:

```sh
python3 -m venv research/cold-start-v3/.venv
research/cold-start-v3/.venv/bin/pip install -r research/cold-start-v3/requirements.txt
pnpm cold-start-v3:unit
pnpm cold-start-v3:smoke --output /tmp/koda-v3-mechanics
```

Real data reuses the existing fingerprinted V2 public cache; it does not fetch a new outcomes snapshot. `data` downloads only pinned official SWE metadata if absent. Every output directory must be new. Commands are offline after metadata acquisition:

```sh
pnpm cold-start-v3:data --output /tmp/koda-v3/data
pnpm cold-start-v3:validate --plan /tmp/koda-v3/data/data-plan.json --limit 100 --output /tmp/koda-v3/quick
pnpm cold-start-v3:validate --plan /tmp/koda-v3/data/data-plan.json --output /tmp/koda-v3/validation
pnpm cold-start-v3:freeze --validation /tmp/koda-v3/validation --output /tmp/koda-v3/frozen
pnpm cold-start-v3:test --frozen /tmp/koda-v3/frozen/frozen.json --output /tmp/koda-v3/final
pnpm cold-start-v3:stress --frozen /tmp/koda-v3/frozen/frozen.json --final /tmp/koda-v3/final --output /tmp/koda-v3/stress
```

`--limit 100` selects SWE validation groups first; it never fits on validation labels and cannot produce a formal freeze. One `final-holdout.claim` permits exactly one final evaluation per freeze. Config, implementation, metadata, split and serialized model fingerprints are checked. Do not delete the claim and retune on the holdout. Thread counts are pinned to one in package scripts.

Optional research export, **only if the frozen decision is PROMISING or STRONG_SIGNAL**:

```sh
pnpm cold-start-v3:export --frozen /tmp/koda-v3/frozen/frozen.json --stress /tmp/koda-v3/stress --output /tmp/koda-v3/candidate
```

The export is never installed into Koda. Joblib files require the pinned Python environment and must only be loaded from trusted locally generated artifacts. Validation metrics remain in the fingerprinted validation directory referenced by the frozen configuration. No production import or activation command exists. Remove `research/cold-start-v3/` and its eight package scripts to remove this experiment.

## Data and metadata audit

Exactly the V2 model pool: `claude-sonnet-4`, `gemini-2.5-flash`, `gpt-5` (GPT-5-medium), `qwen3-235b`, `deepseek-v3.1`, `glm-4.6`. No other model outcomes are loaded.

Outcome source: LLMRouterBench revision `0e5af1b84bf73437a01a1849c0f1d2468baa93fc`, archive SHA256 `b79f8cde1a6f029c2efa663a3a3b6f7748defb22341fe59f328cebef6648c8f1`. Canonical rows are the same 1,055 LiveCodeBench and 500 SWE-bench tasks used by V2, with their original task IDs and outcomes preserved for provenance/evaluation only.

Official [SWE-bench Verified](https://huggingface.co/datasets/princeton-nlp/SWE-bench_Verified) metadata is pinned to revision `c104f840cc67f8b6eec6f759ebc8b2693d585d4a`. PyArrow reads only `instance_id`, `problem_statement`, `repo`, `base_commit`, `version`, `environment_setup_commit`. Patch, test patch, gold tests and evaluator fields are not loaded into sanitized metadata, task profiles or training features. The original public parquet physically contains excluded columns; its bytes are hashed for provenance, not features.

All **500/500** SWE rows joined uniquely using exact whitespace-normalized problem-statement hashes extracted from the original `<issue>` block. Missing joins: **0**. Ambiguous joins: **0**. No fuzzy, positional or outcome-based joins. Twelve repositories: django 231, sympy 75, sphinx 44, matplotlib 34, scikit-learn 32, astropy 22, xarray 22, pytest 19, pylint 10, requests 8, seaborn 2, flask 1.

A new seed-20261007 split was saved before real fitting. TRAIN: 633 LCB + 300 SWE; VALIDATION: 211 LCB + 100 SWE; FINAL: 211 LCB + 100 SWE. Normalized issue groups are globally disjoint across partitions. Data-plan fingerprint: `19459c22a2022a9db6bd48a4a0f3f37174b1c9714b8c3fb80aa2fd24b0767d28`.

The public corpus and older V2 outcomes have already been observed. This is a newly frozen experimental split, **not a previously unseen public corpus** or proof of customer-task generalization.

## Predictor and leakage boundary

`TaskInput` contains only pre-execution text/context and whitelisted metadata, never outcomes, costs or task IDs. Structured features describe task kinds, error/stack-trace/command signals, prompt length/shape, identifiers, constraints, technical concepts, scope proxies, language and ecosystem mentions. Vocabularies/scalers fit TRAIN only. Semantic text uses issue text, not benchmark harness instructions; original context supplies pre-execution syntax/language signals.

Three independent six-model success predictors use regularized logistic regression: structured-only, TF-IDF text-only and combined. TRAIN is the only outcome-fitting partition. Regularization choices 0.1, 1, 10 are fixed in advance. A structured histogram-gradient-boosting baseline uses fixed depth/iterations with the same validation protocol. Raw repository identity is a separate ablation and is excluded from primary selection. Repository IDs, commit hashes, instance IDs and dataset names are not predictive features in the primary router.

The pairwise model trains 15 binary preferences on discordant TRAIN outcomes only. Ties supply no preference label. Pairwise ranking scores are ordinal, **not success probabilities**; separately reported absolute success estimates come from the combined success predictor. Missing pair evidence is neutral. Historical mean costs are TRAIN-only and used after quality prediction in the analysis policies.

Validation chooses calibration using five-fold out-of-fold predictions, SWE Brier first when SWE is available. None and sigmoid are always considered; isotonic requires at least 200 primary-gate examples and 30 examples of each class, so ordinary SWE validation does not qualify. Family/hyperparameter selection uses SWE cross-fitted calibrated solve first (pairwise uses its discordance ranking), then SWE OOF Brier and deterministic tie-breaks. The selected calibrator is subsequently fitted on full VALIDATION. Therefore validation scores are development scores, not unbiased final estimates.

Support uses TRAIN-neighbor similarity and VALIDATION cross-fitted residual buckets. Sparse buckets, unseen language/ecosystem and weak similarity produce LOW_EVIDENCE. Empirical 90th-percentile residual lower bounds are diagnostics, **not formal coverage guarantees**. A zero lower bound trivially covers binary outcomes; positive-bound coverage/rate are reported separately. Predeclared selective coverage cuts and quality-gap cost policies are never optimized on final labels.

## Baselines, generalization and decision

V2 is replayed with **its original frozen hyperparameters**, refitted on V3 TRAIN only and residual-calibrated on V3 VALIDATION only. The literal old trained V2 artifact contains labels overlapping the new holdout and would contaminate a comparison; it is not used. Original V2 source, artifacts and results remain unchanged. Tables label this fair replay `Frozen V2`; this does not mean original fitted weights.

Baselines include TRAIN-best static, dataset-aware TRAIN-static (analysis only), every fixed model and oracle (evaluation only). The strongest static reference is the best observed single SWE model; its paired CI is conditional on that selected reference, not a multiple-selection-adjusted CI. Paired bootstrap uses 2,000 fixed-seed draws, with additional repository-cluster intervals for SWE.

Repository stress holds each of the twelve SWE repositories out once in five frozen folds, excluding it and duplicate issue text from both TRAIN and VALIDATION. LCB remains in the source as in ordinary fitting. All 500 SWE tasks receive out-of-repository predictions; this has a different sample size from the 100-task ordinary SWE holdout. Cross-benchmark stress fits/calibrates only the source TRAIN/VALIDATION and evaluates the target FINAL; unavailable dataset-static baselines are explicitly marked unavailable.

The frozen protocol defines STRONG_SIGNAL, PROMISING and NO_IMPROVEMENT before final evaluation. PROMISING needs at least +5 percentage points SWE versus V2, paired lower difference >= -2 points, fewer catastrophic misses and at least +2 points versus V2 under repo-held-out stress. STRONG additionally requires positive paired lower versus V2, matching strongest static with paired lower >= -3 points, >=3 points fewer catastrophic misses, >=2 points lower ECE, >=50% supported coverage with near-static conditional quality, a cost/quality gain and no material repository-generalization collapse. Anything failing the promising gate is NO_IMPROVEMENT. Full machine-readable criteria are in `configs/protocol.json`; no post-holdout threshold changes.

## Implementation map

- `src/source.py`: pinned metadata, exact joins, frozen split and provenance.
- `src/features.py`: pre-execution structured profiles and TRAIN-only representations.
- `src/models.py`: independent model success, pairwise and nonlinear predictors.
- `src/calibration.py`: VAL OOF calibration, empirical support/bounds.
- `src/evaluation.py`: hidden-label metrics, complementarity, recall, paired CIs and fixed-category errors.
- `src/experiment.py`: validation, frozen serialized artifacts, single-use final holdout.
- `src/stress.py`: repository/cross stress and guarded research export.
- `src/v2bridge.py`: read-only reuse of V2 data/types/retrieval baseline.
- `src/cli.py`, `fixtures/fixture.py`, `tests/test_v3.py`: explicit offline commands and deterministic mechanics tests.
- `requirements.txt`, `.gitignore`, `configs/protocol.json`, `package.json`: isolated environment, frozen protocol and eight commands.

Embeddings, CodeRouterBench priors and repository cloning were deliberately omitted; no invented evidence or additional models. Optional repository-state features are not available from this frozen source.

# Cold Start V2: isolated public unseen-task routing experiment

This research experiment asks whether text from an unseen coding task can select among **six known models**, using only their previously collected public outcomes. It does not execute models, establish Koda harness parity, predict unseen models, or change production routing. A negative result is valid.

## Isolation

| Question | Answer |
|---|---|
| Production routing files modified | NO |
| Routing authority modified | NO |
| Production thresholds modified | NO |
| Paid API calls | NO — zero inference calls |
| Production history read by the experiment | NO |
| Production cold-start artifact replaced | NO |

The only repository file changed outside this directory is `package.json`, adding isolated convenience scripts. The implementation uses Python 3 standard-library dataclasses and JSON schemas rather than adding dependencies to production TypeScript. Candidate JSON retains the requested interoperable task/outcome fields. No production imports point here; no research module imports Koda.

Inspected and left untouched: `src/router/contextualRouterVNext.ts`, `contextualQuality.ts`, `contextualShadow.ts`, `canonicalTask.ts`, `knowledge/canonical.ts`, `knowledge/coldStart.ts`, `taskFingerprint.ts`, `taskAssessment.ts`, `routingAuthority.ts`, and the previous `research/cold-start/` experiment. The requested `src/router/canonical.ts` does not exist; its current counterparts are `canonicalTask.ts` and `knowledge/canonical.ts`. Production model router, legacy router, providers, agent execution and verification are unchanged.

## Source and audit

The [official project](https://github.com/ynulihao/LLMRouterBench) publishes its precollected archive through [NPULH/LLMRouterBench](https://huggingface.co/datasets/NPULH/LLMRouterBench). `ynulihao` identifies the GitHub project, rather than the actual Hugging Face release repository.

Downloaded immutable release revision: `0e5af1b84bf73437a01a1849c0f1d2468baa93fc`.
Archive SHA256: `b79f8cde1a6f029c2efa663a3a3b6f7748defb22341fe59f328cebef6648c8f1`.
Actual layout: `bench-release/<dataset>/<split>/<model>/<result>.json`.

The immutable six-model mapping is in `src/core.py`; exact source mapping provenance is in `fixtures/model-map-provenance.json`. The release directory `gpt-5` maps to the requested **GPT-5-medium**, justified by the [official collector configuration](https://github.com/ynulihao/LLMRouterBench/blob/c77cb0506949d8f959e97967d2fefca0e8ff1b05/config/data_collector_proprietary_model_config.yaml) specifying `reasoning_effort: medium`, and the SWE filename explicitly containing `gpt-5-medium`. GPT-5-chat is excluded. All other models and all other benchmarks are ignored during acquisition; unexpected routing candidates fail.

Scores observed in all twelve selected files are exactly `{0,1}`. Pass@1 complete solve is `score == 1`; no threshold was tuned. Fractional future observations remain continuous and cannot silently become complete solves.

| Benchmark | Actual raw tasks | Complete six-model tasks | Excluded | Source split |
|---|---:|---:|---:|---|
| LiveCodeBench | 1,055 | 1,055 | 0 | test |
| SWE-bench | 500 | 500 | 0 | verified |
| Total | 1,555 | 1,555 | 0 | separate distributions retained |

Each model has 1,055 LCB records and 500 SWE records. Every selected record has `origin_query`, `score`, `cost`, `prompt_tokens`, and `completion_tokens`; duplicate records and conflicting records are both zero. There is one selected snapshot per benchmark/model. `dataset-audit.json` records each file, field coverage, split, raw counts, binary score values, every snapshot decision and exclusion reason. No count was hardcoded in the importer.

Important source limitation: SWE `origin_query` includes the issue **and a partial repository code listing**, averaging about 69,562 characters (maximum 962,265); LCB averages about 1,408. We preserve the exact available pre-execution text, not model output or solutions. Similarity may therefore reflect shared repository context, not just an issue description. These results are not evidence of routing from a short customer prompt, unseen-repository generalization or public→Koda transfer.

## Methods and leakage controls

- Globally group identical whitespace-normalized queries before seeded, benchmark-stratified 70/15/15 TRAIN/VALIDATION/SEALED TEST assignment. All six outcomes stay together. Query hash plus dataset, split and source index defines identity.
- Predictor constructor accepts only `TrainingEvidence`. Prediction accepts only `RoutingTask(origin_query)`. Dataset/task IDs, model output, ground truth, scores and hidden costs cannot enter TF-IDF features.
- TRAIN-only document frequency and vocabulary; word unigrams, word uni/bigrams, or character 3–5 grams. Local inverted-index cosine retrieval; shared text-only index/cache avoids repeated work across parameters.
- Collapse duplicated TRAIN query groups before model-prior estimation. Shrink local similarity-weighted outcomes toward the TRAIN model mean. No self-neighbors.
- Twelve predetermined parameter combinations: feature type/ngrams, k 5/15/25, minimum similarity .05/.10, weight power 1/2, prior strength 1/5/10. Select on VALIDATION solve rate, then Brier, simplicity and deterministic fingerprint. Full search is saved.
- Baselines: always each model, best static TRAIN, dataset-aware static TRAIN (analysis only), and evaluator-only oracle. Best static posthoc is also reported as a stronger evaluation comparator; it never informs predictions.
- Quality-max, conservative-bound and cost-aware gaps 0/.01/.025/.05 are all reported, not selected after TEST. Expected selection cost is **TRAIN mean recorded cost**, never the hidden task's observed cost. Actual cost is evaluated afterward. These are recorded historical public benchmark costs, not current OpenRouter quotes or fresh Koda execution costs. Missing cost disables affected cost metrics/policies rather than inventing prices.
- Model-specific validation residual buckets depend on predicted probability, nearest similarity and neighbor mass. Lower bound = max(0, p − empirical 90th-percentile positive residual). This bounds individual observed score empirically; it is **not** a guaranteed confidence interval for latent success probability. Unsupported buckets use a flagged global fallback; insufficient global support yields zero bound and LOW_EVIDENCE.
- LOW_EVIDENCE also covers nearest similarity < .05 or effective mass < .5. The research still emits diagnostic rankings; selection coverage is not a claim that those tasks are safely dispatchable.
- Final TEST loads frozen parameters and error tables. Predictions are written and validated before releasing hidden outcomes to the evaluator. An exclusive `sealed-test.claim` prevents repeating the formal test from the same freeze. No automatic retuning follows TEST.
- Cross-benchmark tests fit on the source benchmark TRAIN, calibrate on source VALIDATION, and evaluate only target SEALED TEST. No target labels enter fit or tuning; exact target query duplicates are removed from source evidence.
- No optional learned baseline: retrieval is the minimum interpretable implementation, with no new numerical dependencies or neural/LLM classifier.

### Predeclared decision rule

These criteria are stored in the full-validation frozen config **before** opening TEST:

- **STRONG_SIGNAL:** text retrieval beats best static posthoc by ≥2 percentage points on **both** benchmarks, catastrophe ≤5%, ECE ≤.10, positive lower bounds on ≥20% of model/task predictions, and ≥90% coverage among positive bounds.
- **PROMISING_BUT_NOT_READY:** otherwise, overall text-retrieval solve rate beats best static posthoc by ≥1 percentage point.
- **NO_USEFUL_SIGNAL:** neither condition is met.

This is a research decision rule, not a change to Koda routing thresholds. Overall pooling weights benchmarks by actual task count; each benchmark is reported independently.

## Commands

Run from the Koda repository. Python 3 is required; no API key, paid provider or production history is needed. Every output directory must be fresh.

```zsh
cd /Users/madsflyvholm/Desktop/Koda.ai
nvm use 22
pnpm cold-start-v2:unit
pnpm cold-start-v2:smoke --output "research/cold-start-v2/artifacts/smoke-$(date +%s)"

# Official precollected data only; no model inference.
pnpm cold-start-v2:data --revision 0e5af1b84bf73437a01a1849c0f1d2468baa93fc \
  --output research/cold-start-v2/.cache/public-new

# Or import a separately downloaded archive and record its pinned revision.
pnpm cold-start-v2:data --archive /path/to/bench-release.tar.gz \
  --revision 0e5af1b84bf73437a01a1849c0f1d2468baa93fc \
  --output research/cold-start-v2/.cache/public-local

# Existing imported real release defaults to .cache/public.
pnpm cold-start-v2:validate --limit 100 \
  --output "research/cold-start-v2/artifacts/validation-100-$(date +%s)"

RUN="research/cold-start-v2/artifacts/replay-$(date +%s)"
pnpm cold-start-v2:validate --output "$RUN/validation"
pnpm cold-start-v2:test --frozen "$RUN/validation/frozen.json" --output "$RUN/test"
pnpm cold-start-v2:cross-eval --frozen "$RUN/validation/frozen.json" --output "$RUN/cross"
pnpm cold-start-v2:export --frozen "$RUN/validation/frozen.json" --output "$RUN/export"
```

A 100-task development freeze cannot be used for formal TEST/export. `--limit` limits complete VALIDATION query groups, never individual model rows; TRAIN remains intact. Real-data mode never falls back to the synthetic fixture. Archived raw predictions exist only for audit and are never prediction features.

Every evaluation directory saves config/source fingerprints, immutable model map, audit, splits, features, hyperparameter search, calibration, predictions, released ground truth, metrics, complementarity and summary. Export contains the provenance/configuration plus the research-only gzip candidate. The candidate includes TRAIN corpus, vocabulary/IDF, priors, expected costs, calibration and OOD settings. It is **not installed**, and VNext cannot read it through this experiment.

## Removal

Delete `research/cold-start-v2/` and the seven `cold-start-v2:*` entries in `package.json`. No dependencies, production data, routing authority or environment variables need restoring.

## Recorded results

See the completed experiment results below and the immutable evaluation directories for machine-readable metrics and every paired outcome.

### Execution and freeze

All stages completed offline: synthetic mechanics smoke, 100-real-task validation, full validation, frozen configuration, one formal sealed test, both cross-benchmark evaluations and research-only export.

Frozen fingerprint: `57a6756ba38f61033b10bfe0954ed4dcaf9a1bd74a030b1c3b13ba9b5a7210ac`.

| Partition | LCB | SWE | Total |
|---|---:|---:|---:|
| test | 159 | 75 | 234 |
| train | 738 | 350 | 1088 |
| validation | 158 | 75 | 233 |

Selected parameters: word unigrams; k=25; cosine minimum=.05; squared similarity weights; prior strength=10; maximum vocabulary=12,000; TRAIN minimum document frequency=2. These were chosen on VALIDATION before any formal TEST evaluation.

Development smoke: 100 VALIDATION tasks, 69.00% text retrieval solve. Full VALIDATION: 233 tasks, 68.24%. These are tuning diagnostics, not sealed-test estimates.

### Whole-source model rates (descriptive only)

These summarize the downloaded release after the formal experiment; they did not select parameters. Formal held-out comparisons follow separately.

| Canonical model | LCB solve | SWE solve | Overall solve |
|---|---:|---:|---:|
| claude-sonnet-4 | 58.104% | 34.600% | 50.547% |
| gemini-2.5-flash | 60.000% | 18.200% | 46.559% |
| gpt-5 | 86.445% | 15.800% | 63.730% |
| qwen3-235b | 64.171% | 16.200% | 48.746% |
| deepseek-v3.1 | 67.299% | 25.400% | 53.826% |
| glm-4.6 | 63.128% | 21.800% | 49.839% |

### Primary held-out result

The predeclared decision is **PROMISING_BUT_NOT_READY**. Retrieval improves on one overall static model, but it loses to the dataset-aware static baseline and fails the SWE-specific quality/calibration conditions. This does not justify production connection or authority activation.

### Formal test comparison

One sealed test only, 234 held-out tasks; recorded public replay costs, not newly incurred API spend. All individual model/task bins and per-policy distributions are available in metrics.json.

Decision: **PROMISING_BUT_NOT_READY**. No claim of public→Koda harness transfer or unseen-model prediction.

## Routing headroom (posthoc evaluation only)

| Benchmark | Tasks | Best static | Oracle | Oracle uplift | Mixed | All pass | All fail |
|---|---:|---:|---:|---:|---:|---:|---:|
| livecodebench | 159 | 86.164% | 89.937% | 3.774% | 48.428% | 41.509% | 10.063% |
| overall | 234 | 63.675% | 79.060% | 15.385% | 50.855% | 28.205% | 20.940% |
| swe-bench | 75 | 38.667% | 56.000% | 17.333% | 56.000% | 0.000% | 44.000% |

## livecodebench: model and router comparison

| Policy | Solve | Mean regret | p95 regret | Catastrophic miss | Cost/solve |
|---|---:|---:|---:|---:|---:|
| Always claude-sonnet-4 | 0.56604 | 0.33333 | 1.00000 | 0.33333 | 0.02562 |
| Always deepseek-v3.1 | 0.66667 | 0.23270 | 1.00000 | 0.23270 | 0.00181 |
| Always gemini-2.5-flash | 0.60377 | 0.29560 | 1.00000 | 0.29560 | 0.01032 |
| Always glm-4.6 | 0.62893 | 0.27044 | 1.00000 | 0.27044 | 0.00373 |
| Always gpt-5 | 0.86164 | 0.03774 | 0.00000 | 0.03774 | 0.06504 |
| Always qwen3-235b | 0.62893 | 0.27044 | 1.00000 | 0.27044 | 0.00169 |
| Best static TRAIN | 0.86164 | 0.03774 | 0.00000 | 0.03774 | 0.06504 |
| Conservative text retrieval | 0.74214 | 0.15723 | 1.00000 | 0.15723 | 0.05341 |
| Cost-aware gap=0.0 | 0.86164 | 0.03774 | 0.00000 | 0.03774 | 0.06504 |
| Cost-aware gap=0.01 | 0.86164 | 0.03774 | 0.00000 | 0.03774 | 0.06504 |
| Cost-aware gap=0.025 | 0.86164 | 0.03774 | 0.00000 | 0.03774 | 0.06504 |
| Cost-aware gap=0.05 | 0.86164 | 0.03774 | 0.00000 | 0.03774 | 0.06504 |
| Dataset-aware static ANALYSIS | 0.86164 | 0.03774 | 0.00000 | 0.03774 | 0.06504 |
| Oracle POSTHOC | 0.89937 | 0.00000 | 0.00000 | 0.00000 | 0.02657 |
| Text retrieval | 0.86164 | 0.03774 | 0.00000 | 0.03774 | 0.06504 |

### livecodebench: calibration

| Model | Brier | Log loss | ECE | Bound coverage | Positive-bound rate | Positive-bound coverage | LOW_EVIDENCE |
|---|---:|---:|---:|---:|---:|---:|---:|
| claude-sonnet-4 | 0.22903 | 0.65093 | 0.15844 | 0.91195 | 0.27044 | 0.67442 | 0.03774 |
| deepseek-v3.1 | 0.22299 | 0.63828 | 0.12345 | 0.84906 | 0.51572 | 0.70732 | 0.01258 |
| gemini-2.5-flash | 0.23758 | 0.66812 | 0.12052 | 0.83648 | 0.52201 | 0.68675 | 0.20755 |
| glm-4.6 | 0.23120 | 0.65534 | 0.14791 | 0.91824 | 0.35849 | 0.77193 | 0.04403 |
| gpt-5 | 0.13862 | 0.45713 | 0.15742 | 0.93711 | 0.67296 | 0.90654 | 0.08805 |
| overall | 0.21526 | 0.62116 | 0.12864 | 0.89518 | 0.44759 | 0.76581 | 0.07338 |
| qwen3-235b | 0.23216 | 0.65713 | 0.10304 | 0.91824 | 0.34591 | 0.76364 | 0.05031 |

Bound coverage can be vacuous when all lower bounds are zero. Positive-bound coverage is reported separately. These empirical residual envelopes are NOT guaranteed confidence intervals for model success probability.

### livecodebench: complementarity

| A | B | Both pass | A only | B only | Both fail | Disagreement |
|---|---|---:|---:|---:|---:|---:|
| claude-sonnet-4 | gemini-2.5-flash | 80 | 10 | 16 | 53 | 16.352% |
| claude-sonnet-4 | gpt-5 | 89 | 1 | 48 | 21 | 30.818% |
| claude-sonnet-4 | qwen3-235b | 83 | 7 | 17 | 52 | 15.094% |
| claude-sonnet-4 | deepseek-v3.1 | 83 | 7 | 23 | 46 | 18.868% |
| claude-sonnet-4 | glm-4.6 | 81 | 9 | 19 | 50 | 17.610% |
| gemini-2.5-flash | gpt-5 | 94 | 2 | 43 | 20 | 28.302% |
| gemini-2.5-flash | qwen3-235b | 84 | 12 | 16 | 47 | 17.610% |
| gemini-2.5-flash | deepseek-v3.1 | 88 | 8 | 18 | 45 | 16.352% |
| gemini-2.5-flash | glm-4.6 | 82 | 14 | 18 | 45 | 20.126% |
| gpt-5 | qwen3-235b | 98 | 39 | 2 | 20 | 25.786% |
| gpt-5 | deepseek-v3.1 | 100 | 37 | 6 | 16 | 27.044% |
| gpt-5 | glm-4.6 | 99 | 38 | 1 | 21 | 24.528% |
| qwen3-235b | deepseek-v3.1 | 88 | 12 | 18 | 41 | 18.868% |
| qwen3-235b | glm-4.6 | 83 | 17 | 17 | 42 | 21.384% |
| deepseek-v3.1 | glm-4.6 | 87 | 19 | 13 | 40 | 20.126% |

## overall: model and router comparison

| Policy | Solve | Mean regret | p95 regret | Catastrophic miss | Cost/solve |
|---|---:|---:|---:|---:|---:|
| Always claude-sonnet-4 | 0.50855 | 0.28205 | 1.00000 | 0.28205 | 0.06281 |
| Always deepseek-v3.1 | 0.55983 | 0.23077 | 1.00000 | 0.23077 | 0.00397 |
| Always gemini-2.5-flash | 0.47436 | 0.31624 | 1.00000 | 0.31624 | 0.01370 |
| Always glm-4.6 | 0.52137 | 0.26923 | 1.00000 | 0.26923 | 0.00892 |
| Always gpt-5 | 0.63675 | 0.15385 | 1.00000 | 0.15385 | 0.08350 |
| Always qwen3-235b | 0.49145 | 0.29915 | 1.00000 | 0.29915 | 0.00319 |
| Best static TRAIN | 0.63675 | 0.15385 | 1.00000 | 0.15385 | 0.08350 |
| Conservative text retrieval | 0.59402 | 0.19658 | 1.00000 | 0.19658 | 0.06755 |
| Cost-aware gap=0.0 | 0.67949 | 0.11111 | 1.00000 | 0.11111 | 0.07560 |
| Cost-aware gap=0.01 | 0.68803 | 0.10256 | 1.00000 | 0.10256 | 0.07236 |
| Cost-aware gap=0.025 | 0.69231 | 0.09829 | 1.00000 | 0.09829 | 0.07127 |
| Cost-aware gap=0.05 | 0.69231 | 0.09829 | 1.00000 | 0.09829 | 0.06816 |
| Dataset-aware static ANALYSIS | 0.70940 | 0.08120 | 1.00000 | 0.08120 | 0.08482 |
| Oracle POSTHOC | 0.79060 | 0.00000 | 0.00000 | 0.00000 | 0.04530 |
| Text retrieval | 0.67949 | 0.11111 | 1.00000 | 0.11111 | 0.07560 |

### overall: calibration

| Model | Brier | Log loss | ECE | Bound coverage | Positive-bound rate | Positive-bound coverage | LOW_EVIDENCE |
|---|---:|---:|---:|---:|---:|---:|---:|
| claude-sonnet-4 | 0.23260 | 0.65813 | 0.11388 | 0.92735 | 0.20085 | 0.63830 | 0.02564 |
| deepseek-v3.1 | 0.22327 | 0.63876 | 0.10682 | 0.88034 | 0.38034 | 0.68539 | 0.01282 |
| gemini-2.5-flash | 0.21679 | 0.62422 | 0.11174 | 0.88889 | 0.35470 | 0.68675 | 0.14530 |
| glm-4.6 | 0.22424 | 0.64064 | 0.11537 | 0.94444 | 0.24359 | 0.77193 | 0.05128 |
| gpt-5 | 0.16084 | 0.50555 | 0.18910 | 0.94017 | 0.47863 | 0.87500 | 0.05983 |
| overall | 0.21151 | 0.61336 | 0.12045 | 0.92094 | 0.31553 | 0.74944 | 0.05556 |
| qwen3-235b | 0.21132 | 0.61288 | 0.09801 | 0.94444 | 0.23504 | 0.76364 | 0.03846 |

Bound coverage can be vacuous when all lower bounds are zero. Positive-bound coverage is reported separately. These empirical residual envelopes are NOT guaranteed confidence intervals for model success probability.

### overall: complementarity

| A | B | Both pass | A only | B only | Both fail | Disagreement |
|---|---|---:|---:|---:|---:|---:|
| claude-sonnet-4 | gemini-2.5-flash | 91 | 28 | 20 | 95 | 20.513% |
| claude-sonnet-4 | gpt-5 | 98 | 21 | 51 | 64 | 30.769% |
| claude-sonnet-4 | qwen3-235b | 95 | 24 | 20 | 95 | 18.803% |
| claude-sonnet-4 | deepseek-v3.1 | 104 | 15 | 27 | 88 | 17.949% |
| claude-sonnet-4 | glm-4.6 | 96 | 23 | 26 | 89 | 20.940% |
| gemini-2.5-flash | gpt-5 | 96 | 15 | 53 | 70 | 29.060% |
| gemini-2.5-flash | qwen3-235b | 90 | 21 | 25 | 98 | 19.658% |
| gemini-2.5-flash | deepseek-v3.1 | 98 | 13 | 33 | 90 | 19.658% |
| gemini-2.5-flash | glm-4.6 | 90 | 21 | 32 | 91 | 22.650% |
| gpt-5 | qwen3-235b | 101 | 48 | 14 | 71 | 26.496% |
| gpt-5 | deepseek-v3.1 | 107 | 42 | 24 | 61 | 28.205% |
| gpt-5 | glm-4.6 | 104 | 45 | 18 | 67 | 26.923% |
| qwen3-235b | deepseek-v3.1 | 100 | 15 | 31 | 88 | 19.658% |
| qwen3-235b | glm-4.6 | 95 | 20 | 27 | 92 | 20.085% |
| deepseek-v3.1 | glm-4.6 | 103 | 28 | 19 | 84 | 20.085% |

## swe-bench: model and router comparison

| Policy | Solve | Mean regret | p95 regret | Catastrophic miss | Cost/solve |
|---|---:|---:|---:|---:|---:|
| Always claude-sonnet-4 | 0.38667 | 0.17333 | 1.00000 | 0.17333 | 0.17825 |
| Always deepseek-v3.1 | 0.33333 | 0.22667 | 1.00000 | 0.22667 | 0.01312 |
| Always gemini-2.5-flash | 0.20000 | 0.36000 | 1.00000 | 0.36000 | 0.03528 |
| Always glm-4.6 | 0.29333 | 0.26667 | 1.00000 | 0.26667 | 0.03254 |
| Always gpt-5 | 0.16000 | 0.40000 | 1.00000 | 0.40000 | 0.29423 |
| Always qwen3-235b | 0.20000 | 0.36000 | 1.00000 | 0.36000 | 0.01322 |
| Best static TRAIN | 0.16000 | 0.40000 | 1.00000 | 0.40000 | 0.29423 |
| Conservative text retrieval | 0.28000 | 0.28000 | 1.00000 | 0.28000 | 0.14704 |
| Cost-aware gap=0.0 | 0.29333 | 0.26667 | 1.00000 | 0.26667 | 0.14138 |
| Cost-aware gap=0.01 | 0.32000 | 0.24000 | 1.00000 | 0.24000 | 0.11419 |
| Cost-aware gap=0.025 | 0.33333 | 0.22667 | 1.00000 | 0.22667 | 0.10541 |
| Cost-aware gap=0.05 | 0.33333 | 0.22667 | 1.00000 | 0.22667 | 0.08526 |
| Dataset-aware static ANALYSIS | 0.38667 | 0.17333 | 1.00000 | 0.17333 | 0.17825 |
| Oracle POSTHOC | 0.56000 | 0.00000 | 0.00000 | 0.00000 | 0.10909 |
| Text retrieval | 0.29333 | 0.26667 | 1.00000 | 0.26667 | 0.14138 |

### swe-bench: calibration

| Model | Brier | Log loss | ECE | Bound coverage | Positive-bound rate | Positive-bound coverage | LOW_EVIDENCE |
|---|---:|---:|---:|---:|---:|---:|---:|
| claude-sonnet-4 | 0.24018 | 0.67340 | 0.05278 | 0.96000 | 0.05333 | 0.25000 | 0.00000 |
| deepseek-v3.1 | 0.22388 | 0.63978 | 0.07162 | 0.94667 | 0.09333 | 0.42857 | 0.01333 |
| gemini-2.5-flash | 0.17270 | 0.53115 | 0.12093 | 1.00000 | 0.00000 | N/A | 0.01333 |
| glm-4.6 | 0.20949 | 0.60947 | 0.05242 | 1.00000 | 0.00000 | N/A | 0.06667 |
| gpt-5 | 0.20795 | 0.60818 | 0.25625 | 0.94667 | 0.06667 | 0.20000 | 0.00000 |
| overall | 0.20356 | 0.59684 | 0.11147 | 0.97556 | 0.03556 | 0.31250 | 0.01778 |
| qwen3-235b | 0.16714 | 0.51908 | 0.12943 | 1.00000 | 0.00000 | N/A | 0.01333 |

Bound coverage can be vacuous when all lower bounds are zero. Positive-bound coverage is reported separately. These empirical residual envelopes are NOT guaranteed confidence intervals for model success probability.

### swe-bench: complementarity

| A | B | Both pass | A only | B only | Both fail | Disagreement |
|---|---|---:|---:|---:|---:|---:|
| claude-sonnet-4 | gemini-2.5-flash | 11 | 18 | 4 | 42 | 29.333% |
| claude-sonnet-4 | gpt-5 | 9 | 20 | 3 | 43 | 30.667% |
| claude-sonnet-4 | qwen3-235b | 12 | 17 | 3 | 43 | 26.667% |
| claude-sonnet-4 | deepseek-v3.1 | 21 | 8 | 4 | 42 | 16.000% |
| claude-sonnet-4 | glm-4.6 | 15 | 14 | 7 | 39 | 28.000% |
| gemini-2.5-flash | gpt-5 | 2 | 13 | 10 | 50 | 30.667% |
| gemini-2.5-flash | qwen3-235b | 6 | 9 | 9 | 51 | 24.000% |
| gemini-2.5-flash | deepseek-v3.1 | 10 | 5 | 15 | 45 | 26.667% |
| gemini-2.5-flash | glm-4.6 | 8 | 7 | 14 | 46 | 28.000% |
| gpt-5 | qwen3-235b | 3 | 9 | 12 | 51 | 28.000% |
| gpt-5 | deepseek-v3.1 | 7 | 5 | 18 | 45 | 30.667% |
| gpt-5 | glm-4.6 | 5 | 7 | 17 | 46 | 32.000% |
| qwen3-235b | deepseek-v3.1 | 12 | 3 | 13 | 47 | 21.333% |
| qwen3-235b | glm-4.6 | 12 | 3 | 10 | 50 | 17.333% |
| deepseek-v3.1 | glm-4.6 | 16 | 9 | 6 | 44 | 20.000% |


### Quantitative answers

1. **Complete matrix:** 1,555 tasks × six models = 9,330 actual public observations; no exclusions.
2. **Held-out headroom:** overall best static 63.675%, oracle 79.060%, uplift 15.385pp; LCB uplift 3.774pp; SWE uplift 17.333pp.
3. **Text prediction signal:** retrieval solves 159/234 (67.949%), +4.274pp over overall static GPT-5. It is below the dataset-aware static result, 166/234 (70.940%). Gains do not establish finer task reasoning beyond benchmark/repository distribution.
4. **Best static:** no gain on LCB (both 86.164%); worse than best static SWE (29.333% vs 38.667%).
5. **Cost:** retrieval public cost/solve $0.075600 vs static $0.083495, about 9.46% lower. Gap=.05 gives $0.068157 and 69.231% overall solve, but SWE remains below its best static. These are descriptive operating points, not a selected production threshold or a verified universal quality-preserving policy.
6. **Catastrophic misses:** retrieval 26/234 = 11.111%; LCB 6/159 = 3.774%; SWE 20/75 = 26.667%.
7. **Calibration:** overall Brier .211511, log loss .613364, ECE .120447; LCB ECE .128642; SWE ECE .111469. Calibration is insufficient for confident quality gating.
8. **Bounds:** overall coverage 92.094% but only 31.553% of bounds are positive, with 74.944% coverage on that positive subset. SWE positive-bound rate is only 3.556%, positive-bound coverage 31.25%. The high all-bound coverage is largely vacuous; it does not meet the predeclared nonvacuous criterion.
9. **Task-level LOW_EVIDENCE:** overall 52/234 (22.222%), livecodebench 47/159 (29.560%), swe-bench 5/75 (6.667%). A task is flagged if any model bucket is unsupported; the separate model/task observation LOW_EVIDENCE rate is 5.556% overall.
10. **LCB:** quality-max chooses GPT-5 on all 159 tasks, reproducing best static; no per-task routing uplift.
11. **SWE:** choices are Claude 32, DeepSeek 22, GPT-5 21; 22/75 solved vs Claude static 29/75. Cheaper replay cost does not erase this quality loss.

### Cross-benchmark generalization

No cross results were used to tune. Target SEALED TEST only; source TRAIN and source VALIDATION only for fitting and calibration.

| Direction | Target tasks | Text solve | Source-trained static solve | Target best static (posthoc) | Oracle | Catastrophic miss | Task LOW_EVIDENCE |
|---|---:|---:|---:|---:|---:|---:|---:|
| livecodebench-to-swe-bench | 75 | 16.000% | 16.000% | 38.667% | 56.000% | 40.000% | 0.000% |
| swe-bench-to-livecodebench | 159 | 56.604% | 56.604% | 86.164% | 89.937% | 33.333% | 100.000% |

12. **LCB→SWE:** 16.00% solve; no useful cross-domain improvement.
13. **SWE→LCB:** 56.604% solve vs target best static 86.164%; no useful cross-domain improvement.
14. **Complementarity:** full 6×6 matrices and each off-diagonal paired count are above and in complementarity.json. On held-out SWE, GPT-5 and Claude are genuinely complementary: 9 tasks pass both, 3 pass only GPT-5, 20 pass only Claude, and 43 fail both (30.667% disagreement). This is observed public-harness complementarity, not a calibrated recovery policy.
15. **Future integration:** not ready. Dataset-aware static outperforms retrieval, SWE quality is weaker, empirical positive bounds miss their coverage target, and cross-benchmark transfer is poor. Keep this candidate in research only. No parameters were changed after TEST.

### Output locations

- `artifacts/mechanics-final/`: explicit synthetic mechanics fixture and all four evaluations.
- `artifacts/real-100/`: 100-task real validation.
- `artifacts/full-validation/`: full search, split manifest, frozen config and exclusive sealed-test claim.
- `artifacts/sealed-test/`: the one formal test, all predictions/ground truth, metrics and complementarity.
- `artifacts/cross-benchmark/livecodebench-to-swe-bench/` and `swe-bench-to-livecodebench/`: separate complete cross-evaluation artifacts.
- `artifacts/export/contextual-cold-start-v2-candidate.json.gz`: ~13 MiB research-only export; not a production artifact.
- `artifacts/report/final-summary.json`: consolidated pointers, outcome and task-level LOW_EVIDENCE diagnostics.

Every raw archive/cache and experiment result is gitignored. This README preserves the actual findings; the local machine-readable artifacts remain inspectable.

### Files and verification

Modified: `package.json` (seven research convenience scripts only; pre-existing changes preserved).

Added:

- `.gitignore`
- `README.md`
- `src/core.py`
- `src/data.py`
- `src/routing.py`
- `src/evaluate.py`
- `src/cli.py`
- `fixtures/build_fixture.py`
- `fixtures/model-map-provenance.json`
- `tests/test_research.py`

All added paths above are under `research/cold-start-v2/`.

Checks completed: 44/44 new research unit tests; synthetic smoke complete; 100-real-task and full validation complete; one formal sealed test; both cross-tests; export generated; `pnpm typecheck` passed; 123/123 routing/backend focused tests; 68/68 verification/provider focused tests; full `pnpm test`: 1,079 total, 1,078 passed, one skipped, zero failed. Protected production/VNext/authority/previous-experiment file hashes match the before-implementation snapshot. No inference or paid provider calls were made.

# Cold Start V4 — near-frontier cost experiment

**Result: 40% saving is mathematically available, but V4 does not capture it.** No methodology, production routing or V2/V3 artifacts were changed after evaluation.

## Primary table: identical 100 SWE holdout tasks

| Policy | Solve rate | % frontier retained | Cost/resolved | Saving vs frontier | Harmful downgrade |
|---|---:|---:|---:|---:|---:|
| Frontier (Sonnet) | 33.0% | 100.0% | $0.2490 | 0.0% | 0.0% |
| Cheapest always (Qwen) | 11.0% | 33.3% | $0.0287 | 88.5% | 25.0% |
| Cheapest always + frontier rescue | 36.0% | 109.1% | $0.2103 | 15.6% | 0.0% |
| V3 | 24.0% | 72.7% | $0.1976 | 20.6% | 9.0% |
| V4 0pp | 33.0% | 100.0% | $0.2490 | 0.0% | 0.0% |
| V4 1pp | 33.0% | 100.0% | $0.2490 | 0.0% | 0.0% |
| V4 2pp | 33.0% | 100.0% | $0.2490 | 0.0% | 0.0% |
| V4 3pp | 33.0% | 100.0% | $0.2490 | 0.0% | 0.0% |
| V4 3pp + frontier rescue | 33.0% | 100.0% | $0.2490 | 0.0% | 0.0% |
| Cheapest-successful oracle | 45.0% | 136.4% | $0.0164 | 93.4% | 0.0% |

All V4 points route **0%** away from frontier. All four rescue policies are identical because no cheap first attempt is authorized. Cascade first-attempt harmful rate is recorded separately from final harmful rate. Perfect benchmark-failure detection is assumed; verifier costs and false accepts are not included.

## Feasibility bound calculated before training

Reference selected solely from 300 SWE TRAIN tasks: **claude-sonnet-4**. On the full 500-task public SWE corpus, frontier solves 34.6%, at $0.2065/solve. Cheapest-successful oracle solves 52.6%, at $0.0178/solve, saving 91.4%.

| Allowed regret | Fractional oracle solve | Cost/solve | Maximum saving | Cheapest eligible static |
|---|---:|---:|---:|---|
| 0pp | 49.2% | $0.0154 | 92.5% | claude-sonnet-4 |
| 1pp | 48.2% | $0.0133 | 93.6% | claude-sonnet-4 |
| 2pp | 47.0% | $0.0120 | 94.2% | claude-sonnet-4 |
| 3pp | 46.0% | $0.0109 | 94.7% | claude-sonnet-4 |

The oracle is optimized for **cost per solved task**, not just minimum total spend. It retains at least frontier solve rate minus allowed regret and also caps harmful events. It uses exact actual outcomes and receipts; it cannot be dispatched at runtime. No cheaper fixed model satisfies the 0–3pp quality constraint on this corpus. Thus substantial saving requires task-dependent choices or successful recovery.

Fractional-oracle operating points on the same final 100 SWE tasks:

| Regret | Solve | Cost/solve | Saving | Harmful loss |
|---|---:|---:|---:|---:|
| 0pp | 44.0% | $0.0162 | 93.5% | 0.0% |
| 1pp | 43.0% | $0.0139 | 94.4% | 1.0% |
| 2pp | 42.0% | $0.0128 | 94.9% | 2.0% |
| 3pp | 41.0% | $0.0117 | 95.3% | 3.0% |

## What prevents V4 from capturing the saving?

Grouped TRAIN CV selected `{'C': 0.1, 'brier': 0.17710371659066454, 'mode': 'text'}`. Fixed sigmoid calibration used TRAIN-OOF probabilities, never final labels; independent VALIDATION supplied confidence bounds. All five candidates occupy the >=15% risk bin on VALIDATION, with 13–25 harmful events out of 100. The low-risk bins contain **zero examples**. It is therefore unsupported to declare any candidate safe at 1–3pp.

| Candidate | Test harmful rate | Calibrated risk min–max | Test AUC | Brier | TRAIN-prior Brier | Lowest upper risk |
|---|---:|---:|---:|---:|---:|---:|
| deepseek-v3.1 | 18.0% | 16.9%–18.1% | 0.533 | 0.1476 | 0.1476 | 19.5% |
| gemini-2.5-flash | 19.0% | 22.0%–22.7% | 0.600 | 0.1549 | 0.1550 | 28.4% |
| glm-4.6 | 16.0% | 23.4%–23.8% | 0.595 | 0.1401 | 0.1398 | 20.7% |
| gpt-5 | 22.0% | 26.6%–26.9% | 0.516 | 0.1739 | 0.1735 | 32.7% |
| qwen3-235b | 25.0% | 23.8%–24.1% | 0.406 | 0.1877 | 0.1877 | 24.0% |

The calibrated risks are nearly constant per model and already exceed the quality thresholds before upper bounds are applied. Their Brier scores are essentially those of a TRAIN-frequency prior. This supports **weak task-conditioned risk discrimination with these features/data/model**, rather than blaming only conservative confidence bounds. Calibration does not create evidence for a low-risk task stratum. It does not prove that every possible feature/predictor would fail.

The separate always-Qwen → Sonnet-on-failure simulation solves 36%, retains 109.1% of frontier solve rate and saves 15.6% at $0.2103/solve; this assumes perfect failure detection and free verification. It is not the learned V4 policy.

The pool itself is not the limiting factor: cheapest-successful oracle has zero harmful losses and strong savings, while Qwen always sacrifices 25 percentage points of frontier successes. The missing information is **which task** is safe to downgrade. Genuine localization/verification strength are absent from this public snapshot, and 300 paired training plus 100 validation SWE tasks provide little evidence for very low conditional risk. With zero observed events, a one-sided 95% Wilson bound alone needs at least 88 independent tasks in a stratum to fall below 3%, 133 for 2%, and 268 for 1%; any harmful events raise that requirement. These are bound diagnostics, not a proposed V5 or a new calibration run.

## Answers

1. **Is 40% mathematically available? Yes.** Full-corpus zero-harm fractional oracle saves about 92.5%; cheapest-successful saves about 91.4%. Both require impossible hindsight.
2. **Can this V4 capture it near frontier? No.** It retains 100% frontier quality but saves 0%.
3. **Best operating point? All four tie.** The 0pp policy is the most restrictive equivalent choice in this experiment; no nontrivial quality/cost frontier is learned.
4. **Bottleneck? Weak task-conditioned harmful-risk discrimination and no validated low-risk regions.** Not a lack of model complementarity; confidence bounds correctly refuse unsupported cheap dispatch. No thresholds were adjusted to produce savings.

## Validation and isolation

- V4 deterministic tests: **28 passed** (labels, leakage guards, grouping, deterministic folds, reference selection, cost/cascade accounting, routing fallback, brute-force fractional oracle, missing receipts and artifact overwrite).
- V2 regression tests: **44 passed**. V3 regression tests: **47 passed**.
- `pnpm typecheck`: PASS. Focused Koda routing tests: **79 passed**. Full `pnpm test`: **1,079 tests; 1,078 passed, 1 skipped, 0 failed**.
- SHA256 integrity audit: **669 existing production/V2/V3 source and artifact files unchanged**.
- All new files are under `research/cold-start-v4/`; no production/package files changed.
- Source snapshot, six-model pool and V3 artifacts reused unchanged. No provider/network calls, paid inference, production history, VNext/authority/threshold/verification modifications.
- Existing V3 holdout was previously observed; this is a retrospective experiment with fixed methodology, not new untouched evidence.

Offline research runtime: 57.5s. This is not model/agent wall time. Inspectable outputs: `artifacts/evaluation/protocol.json`, `feasibility.json`, `frozen.json`, `predictions.jsonl`, `results.json` and local research model serialization.

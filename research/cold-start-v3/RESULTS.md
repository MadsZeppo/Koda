# COLD START V3 — SWE-FIRST RESULT

**Decision: NO_IMPROVEMENT.** Production remains unchanged.

## Frozen final results

Selected family: **text**, configuration `{'C': 10.0, 'kind': 'logistic', 'mode': 'text', 'repo_identity': False}`. Freeze fingerprint: `b992f2498af99ea77f2226f073f1eeaaf04f426a10e5b0a1521b5370b51232f3`. Final predictions were written before hidden labels were released. No refitting or parameter changes followed the final evaluation.

### SWE primary

Tasks: 100. Strongest fixed model: **claude-sonnet-4**, 33.0%. Oracle: 45.0%. All fail: 55.0%; mixed outcomes: 45.0%.

| Method | Solve | Catastrophic miss | Miss on disagreements | Cost/solve¹ | LOW_EVIDENCE | Supported solve |
|---|---:|---:|---:|---:|---:|---:|
| Frozen V2 | 23.0% | 22.0% | 48.9% | 0.1852 | 2.0% | 23.5% |
| Best static TRAIN | 14.0% | 31.0% | 68.9% | 0.3623 | 0.0% | 14.0% |
| Dataset-aware static | 33.0% | 12.0% | 26.7% | 0.2490 | 0.0% | 33.0% |
| Structured | 28.0% | 17.0% | 37.8% | 0.1147 | 46.0% | 29.6% |
| Text | 24.0% | 21.0% | 46.7% | 0.1976 | 42.0% | 24.1% |
| Text + structured | 24.0% | 21.0% | 46.7% | 0.1418 | 39.0% | 21.3% |
| Pairwise | 24.0% | 21.0% | 46.7% | 0.1892 | 39.0% | 27.9% |
| Nonlinear structured | 27.0% | 18.0% | 40.0% | 0.1962 | 37.0% | 28.6% |
| Repo identity ablation | 27.0% | 18.0% | 40.0% | 0.1181 | 50.0% | 30.0% |
| Selected V3 | 24.0% | 21.0% | 46.7% | 0.1976 | 42.0% | 24.1% |
| V3 conservative | 23.0% | 22.0% | 48.9% | 0.1568 | 42.0% | 25.9% |
| V3 cost gap=0.0 | 24.0% | 21.0% | 46.7% | 0.1976 | 42.0% | 24.1% |
| V3 cost gap=0.01 | 24.0% | 21.0% | 46.7% | 0.1948 | 42.0% | 24.1% |
| V3 cost gap=0.025 | 23.0% | 22.0% | 48.9% | 0.1890 | 42.0% | 22.4% |
| V3 cost gap=0.05 | 23.0% | 22.0% | 48.9% | 0.1509 | 42.0% | 24.1% |
| Oracle | 45.0% | 0.0% | 0.0% | 0.1708 | 0.0% | 45.0% |
| Always claude-sonnet-4 | 33.0% | 12.0% | 26.7% | 0.2490 | 0.0% | 33.0% |

Paired 95% bootstrap intervals for Selected V3:

| Reference | Difference | Lower | Upper |
|---|---:|---:|---:|
| Best static TRAIN | 10.0% | 2.0% | 18.0% |
| Best static posthoc | -9.0% | -15.0% | -4.0% |
| Dataset-aware static | -9.0% | -15.0% | -4.0% |
| Frozen V2 | 1.0% | -6.0% | 8.0% |
| Oracle | -21.0% | -29.0% | -13.0% |

Repository-cluster interval versus V2: 1.0% [-10.3%, 7.1%].

Selected model counts: `{'claude-sonnet-4': 49, 'deepseek-v3.1': 19, 'gemini-2.5-flash': 1, 'glm-4.6': 26, 'gpt-5': 3, 'qwen3-235b': 2}`. Remaining oracle gap: **21.0%**.

### LCB secondary

Tasks: 211. Strongest fixed model: **gpt-5**, 85.8%. Oracle: 90.5%. All fail: 9.5%; mixed outcomes: 48.8%.

| Method | Solve | Catastrophic miss | Miss on disagreements | Cost/solve¹ | LOW_EVIDENCE | Supported solve |
|---|---:|---:|---:|---:|---:|---:|
| Frozen V2 | 85.8% | 4.7% | 9.7% | 0.0574 | 8.1% | 85.6% |
| Best static TRAIN | 85.8% | 4.7% | 9.7% | 0.0574 | 0.0% | 85.8% |
| Dataset-aware static | 85.8% | 4.7% | 9.7% | 0.0574 | 0.0% | 85.8% |
| Structured | 85.3% | 5.2% | 10.7% | 0.0569 | 3.8% | 85.7% |
| Text | 82.9% | 7.6% | 15.5% | 0.0540 | 9.5% | 85.3% |
| Text + structured | 83.9% | 6.6% | 13.6% | 0.0554 | 0.9% | 83.7% |
| Pairwise | 84.4% | 6.2% | 12.6% | 0.0567 | 0.9% | 84.2% |
| Nonlinear structured | 85.3% | 5.2% | 10.7% | 0.0537 | 0.5% | 85.2% |
| Repo identity ablation | 84.8% | 5.7% | 11.7% | 0.0564 | 5.2% | 85.0% |
| Selected V3 | 82.9% | 7.6% | 15.5% | 0.0540 | 9.5% | 85.3% |
| V3 conservative | 82.9% | 7.6% | 15.5% | 0.0554 | 9.5% | 84.3% |
| V3 cost gap=0.0 | 82.9% | 7.6% | 15.5% | 0.0540 | 9.5% | 85.3% |
| V3 cost gap=0.01 | 82.5% | 8.1% | 16.5% | 0.0537 | 9.5% | 84.8% |
| V3 cost gap=0.025 | 81.5% | 9.0% | 18.4% | 0.0512 | 9.5% | 83.8% |
| V3 cost gap=0.05 | 80.1% | 10.4% | 21.4% | 0.0481 | 9.5% | 82.2% |
| Oracle | 90.5% | 0.0% | 0.0% | 0.0280 | 0.0% | 90.5% |
| Always gpt-5 | 85.8% | 4.7% | 9.7% | 0.0574 | 0.0% | 85.8% |

Paired 95% bootstrap intervals for Selected V3:

| Reference | Difference | Lower | Upper |
|---|---:|---:|---:|
| Best static TRAIN | -2.8% | -5.7% | -0.5% |
| Best static posthoc | -2.8% | -5.7% | -0.5% |
| Dataset-aware static | -2.8% | -5.7% | -0.5% |
| Frozen V2 | -2.8% | -5.7% | -0.5% |
| Oracle | -7.6% | -10.9% | -4.3% |

Selected model counts: `{'claude-sonnet-4': 5, 'deepseek-v3.1': 9, 'gemini-2.5-flash': 9, 'glm-4.6': 2, 'gpt-5': 185, 'qwen3-235b': 1}`. Remaining oracle gap: **7.6%**.

### Overall (never the primary gate)

Tasks: 311. Strongest fixed model: **gpt-5**, 62.7%. Oracle: 75.9%. All fail: 24.1%; mixed outcomes: 47.6%.

| Method | Solve | Catastrophic miss | Miss on disagreements | Cost/solve¹ | LOW_EVIDENCE | Supported solve |
|---|---:|---:|---:|---:|---:|---:|
| Frozen V2 | 65.6% | 10.3% | 21.6% | 0.0718 | 6.1% | 64.7% |
| Best static TRAIN | 62.7% | 13.2% | 27.7% | 0.0793 | 0.0% | 62.7% |
| Dataset-aware static | 68.8% | 7.1% | 14.9% | 0.0869 | 0.0% | 68.8% |
| Structured | 66.9% | 9.0% | 18.9% | 0.0646 | 17.4% | 73.9% |
| Text | 64.0% | 11.9% | 25.0% | 0.0713 | 19.9% | 71.1% |
| Text + structured | 64.6% | 11.3% | 23.6% | 0.0657 | 13.2% | 69.6% |
| Pairwise | 65.0% | 10.9% | 23.0% | 0.0725 | 13.2% | 71.5% |
| Nonlinear structured | 66.6% | 9.3% | 19.6% | 0.0722 | 12.2% | 72.2% |
| Repo identity ablation | 66.2% | 9.6% | 20.3% | 0.0645 | 19.6% | 74.0% |
| Selected V3 | 64.0% | 11.9% | 25.0% | 0.0713 | 19.9% | 71.1% |
| V3 conservative | 63.7% | 12.2% | 25.7% | 0.0672 | 19.9% | 70.7% |
| V3 cost gap=0.0 | 64.0% | 11.9% | 25.0% | 0.0713 | 19.9% | 71.1% |
| V3 cost gap=0.01 | 63.7% | 12.2% | 25.7% | 0.0708 | 19.9% | 70.7% |
| V3 cost gap=0.025 | 62.7% | 13.2% | 27.7% | 0.0674 | 19.9% | 69.5% |
| V3 cost gap=0.05 | 61.7% | 14.1% | 29.7% | 0.0604 | 19.9% | 68.7% |
| Oracle | 75.9% | 0.0% | 0.0% | 0.0553 | 0.0% | 75.9% |
| Always gpt-5 | 62.7% | 13.2% | 27.7% | 0.0793 | 0.0% | 62.7% |

Paired 95% bootstrap intervals for Selected V3:

| Reference | Difference | Lower | Upper |
|---|---:|---:|---:|
| Best static TRAIN | 1.3% | -1.9% | 4.5% |
| Best static posthoc | 1.3% | -1.9% | 4.5% |
| Dataset-aware static | -4.8% | -7.4% | -2.3% |
| Frozen V2 | -1.6% | -4.5% | 1.0% |
| Oracle | -11.9% | -15.4% | -8.4% |

Selected model counts: `{'claude-sonnet-4': 54, 'deepseek-v3.1': 28, 'gemini-2.5-flash': 10, 'glm-4.6': 28, 'gpt-5': 188, 'qwen3-235b': 3}`. Remaining oracle gap: **11.9%**.

¹ Costs are historical source receipts in USD, not measured Koda production costs. No runtime latency claim can be made from these outcomes. Oracle picks a successful canonical model, not the cheapest successful model.

### Calibration and ablations (SWE)

| Method | Solve | Brier | ECE | Bound coverage | Positive bound rate | Positive bound coverage |
|---|---:|---:|---:|---:|---:|---:|
| Frozen V2 | 23.0% | 0.1935 | 0.1887 | 95.7% | 6.2% | 29.7% |
| Structured uncalibrated | 32.0% | 0.1874 | 0.1284 | 100.0% | 0.0% | n/a |
| Structured | 28.0% | 0.1851 | 0.1240 | 89.8% | 13.3% | 23.8% |
| Text uncalibrated | 24.0% | 0.1717 | 0.0748 | 100.0% | 0.0% | n/a |
| Text | 24.0% | 0.1705 | 0.0936 | 92.0% | 10.0% | 20.0% |
| Text + structured uncalibrated | 23.0% | 0.2010 | 0.1630 | 100.0% | 0.0% | n/a |
| Text + structured | 24.0% | 0.1874 | 0.1086 | 89.2% | 13.2% | 17.7% |
| Pairwise | 24.0% | 0.1874 | 0.1086 | 89.2% | 13.2% | 17.7% |
| Nonlinear structured | 27.0% | 0.1649 | 0.0944 | 91.0% | 12.7% | 28.9% |
| Repo identity ablation | 27.0% | 0.1870 | 0.1245 | 87.2% | 16.7% | 23.0% |
| Selected V3 | 24.0% | 0.1705 | 0.0936 | 92.0% | 10.0% | 20.0% |

Bounds covering zero are vacuous; use positive-bound coverage/rate and supported solve together. Per-model calibration bins, log loss and bounds are retained in `artifacts/final-holdout/metrics.json`. Pairwise absolute calibration belongs to the accompanying combined success predictor, not its ordinal rank scores.

| Validation coverage target | Actual SWE coverage | Conditional solve | Conditional catastrophic miss |
|---|---:|---:|---:|
| 0.5 | 39.0% | 28.2% | 20.5% |
| 0.75 | 62.0% | 22.6% | 21.0% |
| 0.9 | 78.0% | 24.4% | 21.8% |
| 1.0 | 99.0% | 23.2% | 21.2% |

### Model complementarity and recall (SWE)

| Pair | Both pass | A only | B only | Both fail | Ranking resolves disagreement |
|---|---:|---:|---:|---:|---:|
| claude-sonnet-4|deepseek-v3.1 | 15 | 18 | 7 | 60 | 48.0% |
| claude-sonnet-4|gemini-2.5-flash | 14 | 19 | 4 | 63 | 78.3% |
| claude-sonnet-4|glm-4.6 | 17 | 16 | 4 | 63 | 65.0% |
| claude-sonnet-4|gpt-5 | 11 | 22 | 3 | 64 | 76.0% |
| claude-sonnet-4|qwen3-235b | 8 | 25 | 3 | 64 | 82.1% |
| deepseek-v3.1|glm-4.6 | 12 | 10 | 9 | 69 | 52.6% |
| gemini-2.5-flash|deepseek-v3.1 | 8 | 10 | 14 | 68 | 62.5% |
| gemini-2.5-flash|glm-4.6 | 8 | 10 | 13 | 69 | 60.9% |
| gemini-2.5-flash|gpt-5 | 6 | 12 | 8 | 74 | 60.0% |
| gemini-2.5-flash|qwen3-235b | 5 | 13 | 6 | 76 | 42.1% |
| gpt-5|deepseek-v3.1 | 7 | 7 | 15 | 71 | 54.5% |
| gpt-5|glm-4.6 | 7 | 7 | 14 | 72 | 47.6% |
| gpt-5|qwen3-235b | 2 | 12 | 9 | 77 | 42.9% |
| qwen3-235b|deepseek-v3.1 | 6 | 5 | 16 | 73 | 85.7% |
| qwen3-235b|glm-4.6 | 7 | 4 | 14 | 75 | 72.2% |

Weighted pairwise disagreement resolution: **62.6%**. Winner-set recall conditional on at least one successful model: `{'top1': 0.5333333333333333, 'top2': 0.8, 'top3': 0.8666666666666667}`.

| Model | Successful alternatives | In top 1 | In top 2 | In top 3 |
|---|---:|---:|---:|---:|
| claude-sonnet-4 | 33 | 15 | 23 | 27 |
| deepseek-v3.1 | 22 | 1 | 13 | 16 |
| gemini-2.5-flash | 18 | 1 | 3 | 5 |
| glm-4.6 | 21 | 6 | 13 | 18 |
| gpt-5 | 14 | 0 | 0 | 2 |
| qwen3-235b | 11 | 1 | 2 | 3 |

### Remaining errors

Catastrophic misses: **21**. Largest fixed feature/repository categories (overlapping, descriptive counts; no post-hoc relabeling):

- ecosystem:django: 8
- ecosystem:numpy: 6
- ecosystem:pandas: 3
- ecosystem:pytest: 1
- ecosystem:scikit: 2
- ecosystem:scipy: 3
- ecosystem:sphinx: 3
- ecosystem:sympy: 4
- kind:bug_fix: 17
- kind:build: 1
- kind:configuration: 5
- kind:dependency: 14
- kind:documentation: 9
- kind:feature: 3
- kind:refactor: 1

Full inspectable error records include issue reference/hash, predicted probabilities, successful alternatives, pairwise scores, nearest TRAIN evidence and support flags in `artifacts/final-holdout/error-analysis.json`.

### Interpretation before repository stress

The validation-selected text predictor improves SWE by only **1 percentage point** over V2 replay, with a paired 95% interval of **-6 to +8 points**. It is **9 points below** the strongest fixed model. Structured-only solves 28%, nonlinear 27%, combined/pairwise 24%, raw-repository ablation 27%; none beats fixed Sonnet's 33%. These are final ablation descriptions, not a reason to reselect the winner after observing holdout labels.

Calibration improves (Selected V3 ECE 0.0936 versus V2 0.1887), but this does not demonstrate better model selection. LOW_EVIDENCE rejects 42% of SWE tasks; solve on the remaining 58% is only 24.1%, below the 33% fixed-model baseline. The remaining oracle gap is 21 percentage points. The strong-signal routing/coverage gates are not met. Pooled overall or LCB scores must not override this result.

### Every fixed-model baseline (SWE)

| Model | Solve | Cost per resolved |
|---|---:|---:|
| claude-sonnet-4 | 33.0% | 0.2490 |
| deepseek-v3.1 | 22.0% | 0.0242 |
| gemini-2.5-flash | 18.0% | 0.0466 |
| glm-4.6 | 21.0% | 0.0566 |
| gpt-5 | 14.0% | 0.3623 |
| qwen3-235b | 11.0% | 0.0287 |

Development score of the selected text configuration was 33% SWE on VALIDATION; frozen final score is 24%. This gap is consistent with limited evidence/selection variance. It does not authorize refitting on final outcomes.

### Generalization — frozen parameters, no stress selection

| Evaluation | Tasks | V2 replay | Selected V3 | Strongest fixed | Oracle |
|---|---:|---:|---:|---:|---:|
| Ordinary SWE | 100 | 23.0% | 24.0% | 33.0% | 45.0% |
| Repo-held-out SWE | 500 | 19.2% | 29.4% | 34.6% | 52.6% |
| Ordinary LCB | 211 | 85.8% | 82.9% | 85.8% | 90.5% |
| LCB → SWE | 100 | 14.0% | 17.0% | 33.0% | 45.0% |
| SWE → LCB | 211 | 59.2% | 61.6% | 85.8% | 90.5% |

| Repo-held-out ablation | Solve | LOW_EVIDENCE | Supported solve |
|---|---:|---:|---:|
| Frozen V2 | 19.2% | 0.0% | 19.2% |
| Structured | 28.6% | 90.8% | 32.6% |
| Text | 29.4% | 80.4% | 32.7% |
| Text + structured | 25.6% | 85.8% | 23.9% |
| Pairwise | 24.4% | 85.8% | 26.8% |
| Nonlinear structured | 29.2% | 85.8% | 28.2% |
| Repo identity ablation | 24.4% | 94.2% | 17.2% |
| Selected V3 | 29.4% | 80.4% | 32.7% |

Repo-held-out difference versus V2: 10.2%, paired task CI [6.0%, 14.4%], repository-cluster CI [3.5%, 13.7%]. Ordinary and repo-stress sample sizes differ, so compare methods within each evaluation rather than treating their difference as a matched causal effect.

Raw repo identity is not necessary for the primary prediction. Its ordinary/repo-held-out ablation is reported rather than used to select the winning family. Unknown held-out repo values cannot map to learned identity coefficients. Any apparent gain on ordinary splits must be checked against held-out repositories.

### Predeclared final decision

**NO_IMPROVEMENT**.

There is genuine improvement versus the weak V2 replay in out-of-repository stress, but the primary 100-task SWE holdout does not show a material or statistically credible gain and remains below strongest static. Better probability calibration alone cannot satisfy the quality gate. No candidate is exported or activated. This is not evidence that Koda achieves frontier verified quality; public→Koda transfer calibration is explicitly a future experiment.

### Validation and safety

- V3 unit tests: **47 passed**.
- Synthetic end-to-end mechanics: validation → freeze → one final evaluation → five repository folds → both cross-benchmark directions completed. Synthetic performance is not empirical evidence.
- Existing V2 tests: **44 passed**; no V2 implementation/artifact modifications.
- Focused existing routing/verification tests: **90 passed, 0 failed**.
- `pnpm typecheck`: **PASS**.
- Full `pnpm test`: **1,079 tests; 1,078 passed, 1 skipped, 0 failed**. The skipped test is the real OpenHands exploration integration test.
- Final holdout repeat guard: **PASS**; repeat rejected with `FileExistsError` before creating another output directory.
- Integrity check: **337 existing V2/router files unchanged** by SHA256.

| Safety invariant | Result |
|---|---|
| Production router changed | NO |
| VNext changed | NO |
| Authority changed | NO |
| Production thresholds changed | NO |
| Production history read | NO |
| Paid API calls | NO |
| Existing V2 results modified | NO |

Machine-readable outputs are under `artifacts/data-plan`, `full-validation`, `frozen`, `final-holdout`, and `stress`. Predictions precede label release; error records and per-model calibration/complementarity are saved. Artifacts, metadata cache and Python venv are intentionally ignored by Git. All implementation files are under this research directory; only eight isolated package scripts were added outside it.

- Research export guard: **PASS**; NO_IMPROVEMENT explicitly refuses candidate export before creating files.

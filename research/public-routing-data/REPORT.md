# Results: licensed public-data bootstrap

Usable task/model outcomes: **6710**; unique tasks: **6463**; trajectories: **6877**; prefix states: **337783**.

Unknown outcomes excluded: 1136; conflicting task/model outcomes excluded: 11. Frozen task IDs excluded: 100. Public paired tasks: 247.

## Frozen100 comparison (historical public outcomes, not Koda verification)

| Policy | Solve rate | Frontier retained | $ / solve | Savings | Harmful downgrade | Cheap starts |
|---|---:|---:|---:|---:|---:|---:|
| Strongest static (TRAIN-selected) | 33.0% | 100.0% | 0.24902 | 0.0% | 0.0% | 0.0% |
| V3 | 24.0% | 72.7% | 0.19762 | 20.6% | 9.0% | 50.0% |
| Old V6 | 33.0% | 100.0% | 0.24902 | 0.0% | 0.0% | 0.0% |
| Pareto 1pp | 28.0% | 84.8% | 0.32233 | -29.4% | 12.0% | 30.0% |
| Pareto 2pp | 27.0% | 81.8% | 0.31136 | -25.0% | 13.0% | 32.0% |
| Pareto 3pp | 30.0% | 90.9% | 0.26104 | -4.8% | 10.0% | 35.0% |
| Oracle new pool | 63.0% | 190.9% | 0.02289 | 90.8% | 0.0% | 92.0% |
| New public StartRouter | unavailable (100 ABSTAIN) | unavailable | unavailable | unavailable | unavailable | 0% |

The new frozen cohort replay has zero supported exact-model candidates. No legacy fallback is counted as the new policy. Existing aggregate results are retained; unlicensed raw benchmark data are not new training inputs. No oracle-gap closure demonstrated.

## Public Start heldout (new labels; Koda transfer unknown)

| Exact model | Test n | AUROC | Brier | Constant Brier | Repo-holdout AUROC |
|---|---:|---:|---:|---:|---:|
| claude-3-5-sonnet-20241022 | 55 | 0.738 | 0.201 | 0.230 | 0.861 |
| claude-3-7-sonnet-20250219 | 231 | 0.718 | 0.213 | 0.248 | 0.651 |
| minimax-m2.5 | 185 | 0.534 | 0.252 | 0.251 | 0.389 |
| qwen3.5-122b-a10b | 181 | 0.621 | 0.211 | 0.218 | 0.699 |

Heldout discordant pair ranking: 85.7%, only 7 pairs. This is too small and differently modeled to validate V6.2 routing.

## Agent signal

| Next-event proxy | AUROC | Brier | Balanced accuracy | Repo-holdout AUROC |
|---|---:|---:|---:|---:|
| next_progress | 0.645 | 0.184 | 0.504 | 0.602 |
| next_stuck | 0.865 | 0.110 | 0.686 | 0.836 |

Agent task-holdout n=539. Model-agnostic current-prefix features predict the next observation, not an intervention effect. Earlier Twin tier-label balanced accuracy 0.419 is not directly comparable. Escalation usefulness and required capability are unknown. No live savings claimed.

## Decision

**STOP / no paid pilot.** Obtain licensed paired outcomes for exact Koda candidate versions with cost receipts or validated cross-version/cross-harness transfer before testing economic routing. Architecture, thresholds and production authority remain frozen. Paid calls: **0**.

## Engineering verification

Typecheck PASS. Focused TypeScript 13/13; Python 8/8. Full suite: 1,109 passed, 1 failed, 1 skipped (1,111 total), same existing planner worker-overlap assertion on two full runs. Isolated recheck passes 1/1. Production and tests were not altered to conceal this failure. Frozen baseline: all 15 recorded SHA256 hashes unchanged.

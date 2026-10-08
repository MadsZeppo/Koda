# Cold Start V5 — fixed LLM routing judge

Judge: **openai/gpt-5-2025-08-07**, reasoning medium, seed 20261007, temperature omitted, strict JSON schema. Exact requested version, returned aliases/providers, usage and raw responses are stored per call.

Pilot gate: **STOP**. Stability: True. Successful cheap selections at 3pp: 0. Tasks: 10.

| Policy | Solve rate | Frontier retained | Total cost/solve | Saving vs frontier | Harmful downgrade |
|---|---:|---:|---:|---:|---:|
| Frontier | 40.0% | 100.0% | $0.2163 | 0.0% | 0.0% |
| V3 | 40.0% | 100.0% | $0.0727 | 66.4% | 0.0% |
| V4 | 40.0% | 100.0% | $0.2163 | 0.0% | 0.0% |
| LLM 0pp | 40.0% | 100.0% | $0.3125 | -44.5% | 0.0% |
| LLM 1pp | 40.0% | 100.0% | $0.3125 | -44.5% | 0.0% |
| LLM 2pp | 40.0% | 100.0% | $0.3125 | -44.5% | 0.0% |
| LLM 3pp | 40.0% | 100.0% | $0.3125 | -44.5% | 0.0% |
| Oracle | 60.0% | 150.0% | $0.0068 | 96.9% | 0.0% |

Total actual judge cost: **$0.384962**. All calls, including the two stability repeats, are included in each LLM policy's economics. Coding costs are the unchanged historical task receipts, not new coding inference. Oracle is cheapest-successful hindsight, with no judge fee.

## Model selections

- 0pp: `{'claude-sonnet-4': 10, 'deepseek-v3.1': 0, 'gemini-2.5-flash': 0, 'glm-4.6': 0, 'gpt-5': 0, 'qwen3-235b': 0}`; routed away from frontier: 0.0%.
- 1pp: `{'claude-sonnet-4': 10, 'deepseek-v3.1': 0, 'gemini-2.5-flash': 0, 'glm-4.6': 0, 'gpt-5': 0, 'qwen3-235b': 0}`; routed away from frontier: 0.0%.
- 2pp: `{'claude-sonnet-4': 10, 'deepseek-v3.1': 0, 'gemini-2.5-flash': 0, 'glm-4.6': 0, 'gpt-5': 0, 'qwen3-235b': 0}`; routed away from frontier: 0.0%.
- 3pp: `{'claude-sonnet-4': 10, 'deepseek-v3.1': 0, 'gemini-2.5-flash': 0, 'glm-4.6': 0, 'gpt-5': 0, 'qwen3-235b': 0}`; routed away from frontier: 0.0%.

## Harmful and successful cheap decisions

### 0pp

Harmful cheap downgrades: **0**. Successful cheap selections: **0**.
### 1pp

Harmful cheap downgrades: **0**. Successful cheap selections: **0**.
### 2pp

Harmful cheap downgrades: **0**. Successful cheap selections: **0**.
### 3pp

Harmful cheap downgrades: **0**. Successful cheap selections: **0**.

## Gap calibration (pilot descriptive only)

| Model | Mean predicted gap pp | Actual signed gap pp | Gap MSE |
|---|---:|---:|---:|
| claude-sonnet-4 | 0.00 | 0.00 | 0.0000 |
| gemini-2.5-flash | 17.14 | 20.00 | 0.3636 |
| gpt-5 | 17.93 | 30.00 | 0.2228 |
| qwen3-235b | 19.86 | 20.00 | 0.1632 |
| deepseek-v3.1 | 9.78 | -20.00 | 0.2488 |
| glm-4.6 | 15.45 | -10.00 | 0.3567 |

Actual signed gap is frontier-success minus candidate-success. Confidence is not P(success); bin-level comparisons are saved in calibration.json. With ten tasks each single-event rate changes by ten percentage points, so this does not validate 2–3pp probability calibration.

## Diagnosis

The judge is **too conservative for the product objective**: it chose frontier for every pilot task, reproducing V4 selections while adding judge cost. It supplied differentiated model gaps but identified no validated cheap task stratum. This pilot does not prove inability to understand task difficulty; it shows that supplied task signals and TRAIN/public profiles did not lead this fixed judge to useful task-conditioned downgrades. No harmful cheap selection occurred because no cheap selection occurred.

Judge reasons (unmodified):

- 1: Ranking based on TRAIN solve rates with adjustments for task fingerprint emphasizing documentation and dependency buckets; Claude leads, DeepSeek next, GLM third, GPT-5 narrowly ahead of Gemini due to stronger dependency performance, Qwen last.
- 2: Task appears as a small Python/Flask bug-fix-style change; TRAIN bug-fix evidence places Claude clearly ahead, DeepSeek next, with the rest trailing by larger margins. Under <=3pp regret, only the frontier qualifies.
- 3: Bug-fix in Python/scikit-learn; TRAIN bug-fix solve rates place Claude first, DeepSeek next, then GLM, Gemini, GPT-5, Qwen. Only frontier is within 3pp regret, so it is selected.
- 4: Bug-fix/dependency-heavy task; TRAIN bucketed rates strongly favor Claude, then DeepSeek, GLM, GPT-5, Gemini, Qwen. No non-frontier model within 3pp regret; select frontier.
- 5: TRAIN shows Claude leading strongly overall and in dependency/test buckets; task is Python/pytest and dependency-heavy. No cheaper model estimated within 3pp of frontier for this task.
- 6: Python feature addition in a large, multi-component Matplotlib backend context. TRAIN shows strong feature-bucket advantage for Claude, next best DeepSeek, then GLM≈Gemini, with GPT-5 and Qwen trailing. Gaps reflect bucket-weighted expectations for feature-heavy, multi-file changes.
- 7: Ranking follows TRAIN solve-rate differentials relative to the frontier, with language/task fit consistent with Python/Django. Frontier retains clear lead; no non-frontier model falls within 3pp gap.
- 8: Ranked by task-conditioned weighting of TRAIN bucket solve rates (bug_fix, dependency, documentation) per the task fingerprint; Claude clearly leads, DeepSeek next; GPT-5 narrowly edges Gemini on dependency; Qwen trails. Selected under 3pp policy follows from these gaps.
- 9: TRAIN shows Claude leading, especially on bug-fix/docs; DeepSeek next with a notable gap; others trail similarly across relevant buckets. No cheaper model within 3pp of frontier.
- 10: Bucketed TRAIN solve-rates for bug-fix/dependency/docs/feature strongly favor Claude, then DeepSeek, followed by GLM, Gemini, GPT-5, and Qwen. Only frontier lies within 3pp; thus select frontier.

## Costs, limitations and safety

Pre-call estimate: pilot up to $0.7354; all 100 plus repeats up to $6.0668. Both include maximum reasoning/completion reserve and input bounds. No coding models were rerun.

Public SWE tasks can exist in the judge's pretraining. No hidden task outcomes/patches were provided, but benchmark familiarity cannot be ruled out. The V4 holdout was previously observed. Profiles use TRAIN and frozen public catalog evidence only. These results are retrospective research, not measured Koda verified customer performance.

Only research/cold-start-v5 contains new files. Production routing, VNext, authority, thresholds, verification, recovery, production history and V2/V3/V4 source/results are unchanged. Judge requests use the existing shared backend transport without a local provider key.

**Usage:** 41,461 input tokens; 35,632 output tokens including 32,640 reasoning tokens. Twelve actual judge calls; returned model alias `['openai/gpt-5']`. Summed provider wait: 293.1s, excluding Python/Node setup. No full evaluation or coding-model calls.

**Tests:** V5 27 passed; V4 28 passed; V3 47 passed; V2 44 passed. Focused routing/backend tests: 123 passed. `pnpm typecheck` and standalone request.ts typecheck: PASS. Full suite final run: 1,079 tests; 1,078 passed, 1 skipped, 0 failed. Initial full run hit the existing planner worker-overlap assertion; its isolated rerun passed, and a full rerun passed without code/test changes.

**Integrity:** 688 existing production/V2/V3/V4/package files unchanged by SHA256. Frozen V5 source and packets remain unchanged. STOP gate is saved; no full phase was dispatched. Pilot performance of V3 is not a reversal of its weaker 100-task result: ten tasks are too few for general quality claims.

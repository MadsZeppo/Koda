# Cold Start V4: cheapest model under harmful-downgrade risk

Isolated public-data experiment. It does not predict the best model, change Koda routing or establish verified customer-task quality. All code and outputs live here. V2/V3 are read-only dependencies; the existing V3 Python environment supplies the pinned research libraries.

Results: [RESULTS.md](RESULTS.md).

## Run

From the repository root, after the V3 environment and frozen public artifacts exist:

```sh
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 research/cold-start-v3/.venv/bin/python -m unittest discover -s research/cold-start-v4/tests -v
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 research/cold-start-v3/.venv/bin/python research/cold-start-v4/src/experiment.py --output /tmp/koda-v4-experiment
```

Output must be a new directory. No paid API calls, network requests, model-outcome downloads, production imports or production-history reads. Dependencies are recorded in `requirements.txt`. Existing V3 artifacts must be present for exact same-task comparison.

## Frozen methodology

Six models, unchanged: Claude Sonnet 4, Gemini 2.5 Flash, GPT-5 medium, Qwen3 235B A22B 2507, DeepSeek V3.1 Terminus, GLM 4.6. Canonical aliases are those of V2/V3.

The exact fingerprinted V2 LLMRouterBench snapshot and V3's grouped 300/100/100 SWE TRAIN/VALIDATION/FINAL partition are reused. The V3 holdout was previously observed: **this is a retrospective frozen-method experiment, not a new pristine holdout**. Full-corpus oracle diagnostics are explicitly requested, computed before training, and cannot enter predictors. No methodology changes follow evaluation.

The frontier is selected solely by highest SWE TRAIN solve rate, with TRAIN mean cost and canonical model identity as tie-breaks. Expected candidate costs are SWE TRAIN mean receipts. Only models cheaper than the frontier by these estimates are eligible. Actual evaluation costs never affect policy dispatch.

Labels are asymmetric paired events: `candidate fails AND frontier succeeds`. Candidate wins when frontier fails do not cancel harmful labels. Targets are not absolute success or winner accuracy. Five-fold GroupKFold keeps every semantic task group and all six outcomes together. Feature vocabularies/scalers fit each training fold independently.

Regularized logistic candidates use the unchanged V3 structured, TF-IDF text and combined representations; C = 0.1, 1, 10. Configuration selection minimizes grouped TRAIN-OOF harmful-risk Brier. No winner-selection objective or final-outcome tuning. Sigmoid calibration is fixed and fitted to selected TRAIN-OOF risks. Independent VALIDATION supplies harmful-event counts within fixed calibrated-risk bins [0, .05, .15, 1]. Bins require at least 20 tasks; otherwise upper risk is 1 and dispatch rejects the candidate. One-sided 95% Wilson upper bounds represent **bin-average empirical risk**, not guaranteed individual-task risk or simultaneous coverage across all candidates.

For each fixed 0/1/2/3 pp regret setting, reject candidates with upper harmful probability above that setting and choose the lowest TRAIN-estimated cost among the survivors; otherwise use frontier. Net solve rate may improve through candidate-only successes, but harmful events are reported separately. There is no forced selection, output-dependent fallback or production threshold change.

V3's existing pre-execution task profiles supply language/framework, task kind, error/file/test signals, coupling/scope/complexity proxies and semantic text. Genuine localization certainty and actual verification strength are unavailable in this public snapshot; they are not invented. Patches, evaluator results, model outputs, outcomes, IDs and receipt costs never become predictive features. Repository identity is excluded.

The protocol is written before any fitting; selected configuration, source split fingerprint, TRAIN costs/reference and VALIDATION calibration audit are frozen before final decisions. All holdout predictions are persisted and checked by V2's sealed-evaluation boundary before labels are released. An initial implementation run failed before training on a zero-gap dictionary key; its inspectable feasibility output remains under `artifacts/final`. The completed evaluation is under `artifacts/evaluation`.

## Oracle feasibility and cost accounting

Before training, compute full-corpus frontier cost/solve, cheapest successful oracle, quality-eligible static models and fractional cost-per-solved optimum for each regret setting. The fractional oracle uses MILP plus Dinkelbach iterations, with one model per task, a minimum frontier-relative solve count **and** a maximum harmful-event count. It must prove optimality; optimizer failure aborts rather than fabricates a ceiling. This prevents minimizing total spend while silently optimizing a different cost/solve objective.

Oracles use hidden actual receipts and outcomes only as hindsight evaluation. They are unattainable dispatch baselines. Cheapest-successful picks the cheapest actual successful model, otherwise the cheapest failure; the fractional oracle can skip some expensive non-frontier-only successes while respecting frontier quality/harm constraints. Static feasible baselines show whether context-free cheap routing is enough.

Cascade costs include the cheap attempt plus frontier only if the cheap model failed. Already-failed frontier requests are not retried. Successful cheap attempts are not charged a rescue. Failure detection is perfect benchmark knowledge: verifier cost, false accepts and runtime are not measured. This is an optimistic simulation, not Koda production verification. The primary cascade table distinguishes initial harmful events from final harmful losses.

Historical public USD receipts provide cost measurements; no production or present-day price guarantee. Wall-clock for this experiment is offline analysis runtime, not coding-agent latency.

## Files and removal

`src/experiment.py`, `report.py`, `tests/test_v4.py`, `requirements.txt`, `.gitignore`, this README and RESULTS.md. No package scripts or production files are changed. Delete this directory to remove V4. Numerical artifacts are ignored by Git but saved locally as protocol, feasibility, frozen configuration, research model serialization, predictions and results.

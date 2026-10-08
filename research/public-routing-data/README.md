# Public-data bootstrap of frozen V6/V6.2

Research only. Production routing, routing authority, thresholds, verification,
recovery and the existing capped live-pilot files are unchanged. No paid calls.

## Reproduce

From the Koda repository, with the existing scientific Python environment:

```sh
research/cold-start-v3/.venv/bin/python research/public-routing-data/src/acquire.py
OPENBLAS_NUM_THREADS=1 research/cold-start-v3/.venv/bin/python research/public-routing-data/src/normalize.py
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 research/cold-start-v3/.venv/bin/python research/public-routing-data/src/train.py
research/cold-start-v3/.venv/bin/python -m unittest discover -s research/public-routing-data/src -p 'test_*.py'
node --import tsx --test tests/publicRoutingResearch.test.ts tests/paretoResearchV62.test.ts
pnpm typecheck
```

`acquire.py` downloads only the predeclared first shard of each of two NVIDIA
teachers and SWE-smith's tool subset. Dataset downloads are not model calls.
`sources.json` records immutable revisions, URLs, checksums, sizes and exclusions;
normalization verifies the checksums. Downloaded and normalized rows remain in
ignored `.cache/`; compact fit, audit and results are committed research artifacts.

## Licensed sources and exclusions

- NVIDIA Open-SWE-Traces: CC-BY-4.0, revision
  `f8fb5b3d2c787f85f8a00f5fe04fe3f1a11088ef`; v1.0 OpenHands MiniMax-M2.5
  and Qwen3.5-122B-A10B, SWE-rebench-v2. Each underlying repository license is
  checked too. Attribution: NVIDIA, Open-SWE-Traces; see pinned dataset card.
- SWE-smith trajectories: MIT, data revision
  `08e109b4a59eaeebf80e4675cd125d42e7ac99a4`; original tool-format trajectories,
  code revision `9b74ac08118a85c39c356802f7961893af73e07f`. Actual model field
  contains Claude 3.5 and 3.7; those identities are preserved separately.
- SAIL bundled data: excluded; license placeholder. Provenance inspection only.
- Original SWE-bench/experiments source identified by SAIL: excluded; explicit
  data license not established. No S3 trajectories ingested.
- LLMRouterBench: excluded from new training; dataset license not established.
  MIT licensing of router code does not license its data.
- CodeRouterBench: excluded from new training pending verified exact data license.

This is a pinned subset, not a claim to ingest all 151k NVIDIA trajectories.

## Normalization and causality

Task view: original first-user issue, repo, language, framework (unknown if absent),
harness, exact model/family, separate outcome label, cost/tokens (unknown), provenance.
States: task key, model, step, action/tool, prefix-only counters, observed error,
infrastructure/test signals and discovered paths. Raw observations are summarized
rather than copying patches. Final outcome is a separate label, never a feature.
Gold/reference/test patch columns and reasoning are never selected from parquet.

All 100 frozen SWE IDs and normalized original issue-text hashes are excluded.
Task/model duplicates are deduplicated; conflicting duplicate outcomes are excluded
from Start training. All trajectories for a task stay in one task-group split.
A stricter repo-group split is separately evaluated. Splits use a deterministic
70/20/10 hash allocation. Unknown outcomes are not failures.

Start uses fixed hashed task representation, separate L2 logistic estimates per
actual model, with sigmoid calibration on validation only. No winner labels.
The interface-compatible research `.score()` adapter returns public estimates,
explicit unknown Koda transfer uncertainty, and ABSTAIN for unsupported versions.
No legacy quality priors, inferred version equivalence or invented prices.

Agent training takes one seeded prefix per deduplicated task, predicts the next
observable progress/stuck event from the current prefix, and calibrates on separate
tasks. This prevents long trajectories acting as thousands of independent samples.
These are weak observable proxies, not proof of capability requirements or success.
Counterfactual escalation usefulness and capability labels remain unknown.
The isolated adapter returns advisory signals alongside existing Weave `planAction`;
it cannot turn these proxies into invented switch EV or alter existing safety/pins.

## Frozen evaluation limitation / stop decision

None of the four licensed teacher versions is an exact candidate in the frozen
V6.2 model pool. Cross-version/public-to-Koda transfer is not calibrated, and these
shards provide no cost receipts. All 100 frozen task decisions therefore ABSTAIN.
A solve rate or cost saving for that abstaining policy is unavailable, not zero
and not the legacy fallback's success. `results.json` retains old frozen aggregate
metrics for comparison without reloading unlicensed raw outcomes into training.

Public classification is not a live Koda VERIFIED_SUCCESS measurement. Previous
TwinRouter's weak tier-label balanced accuracy (.419) is a different target and
cannot establish an apples-to-apples improvement over next-event classification.
No live pilot is warranted yet: acquire explicitly licensed paired exact-model
outcomes/costs or independently validated transfer evidence first. The old capped
live-pilot harness is preserved, not executed or certified by this experiment.

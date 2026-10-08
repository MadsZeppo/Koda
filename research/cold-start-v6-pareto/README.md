# V6.2 — Pareto + Weave isolated research

Production authority, VNext, verification, recovery, apply and workspace code are unchanged. Nothing imports this experiment into production.

## Sources

* Pareto Router MIT: commit `4648cdcec71e3a7398b4485549e0850fe2812554`. Per-model multi-output Ridge quality prediction; model-agnostic cost/quality selection adapted independently.
* Weave Apache-2.0: `router-v0.2.29`, commit `25a10d8a01e7baf1e14ef84297284b7118be94ba`. Action classification, session pin, fresh scorer, corrected switching economics and bounded handoff mechanics adapted independently. No earlier/GPL version imported.
* Local pinned LLMRouterBench release and frozen V3 split reused; exact original task IDs and source file SHA256s saved in coverage.json.

## Data audit FIRST

All 12 requested identities have 100/100 exact paired evaluation outcomes and 300/300 TRAIN outcomes. No models excluded. GPT-5 remains the documented medium-reasoning release entry, separate from GPT-5-chat. Qwen thinking folder is resolved only because filename and payload both explicitly identify thinking-2507. No model substitutions, fuzzy task joins or fabricated records.

## Frozen methodology

TRAIN-only TF-IDF plus existing TaskCapabilityProfile feature encoder, multi-output Ridge alpha=10 from upstream methodology. Predict every model, clip to [0,1], select the cheapest model within 1/2/3pp of predicted best quality. Forecast costs use TRAIN mean actual receipts. Actual evaluation receipts only enter scoring after decisions are frozen. No evaluation outcome feeds features or predictions. These are public-harness expected scores, **not calibrated probabilities of Koda VERIFIED_SUCCESS**.

Capability domains are soft features. Hard exclusions require explicitly attested serious risk and allowed models; keyword/domain proxies do not establish serious risk. Public data lack those attestations, so no invented deterministic exclusions are applied to this replay.

Strongest static is selected from TRAIN and recalculated across all twelve; ex-post strongest static on evaluation is also disclosed. Both are Sonnet here, which was not assumed. Oracle maximizes solved tasks and then minimizes receipt cost per task; it is an unavailable-outcome upper bound, not an executable policy.

Old V6 decisions/fallbacks and V3 selections are loaded from their frozen artifacts. No V2/V3/V4/V6 files are edited. The same final100 has already been repeatedly observed: this is a retrospective replay, not a fresh holdout.

## Action mechanics

`router.ts` uses fresh caller-provided action scores, defaults to STAY, subtracts switch/cache-loss/handover/router/expected-recovery expenses, enforces remaining budget, two-switch cap and no revisiting models. Quality improvement is valued only via explicit supplied economics, never tier labels. Same worktree identity is retained. Handover reuses Koda bounded packet and digest; omitted evidence requires its inspectable attachment. Twin labels are unused.

**No dynamic execution is proven.** Source pricing/economics and unit tests alone do not estimate action-conditioned success or real cache recovery. No live dispatch hook is installed.

## Result and mandatory stop

The broader pool improves theoretical oracle solve rate from 45% to 63%. The frozen predictor fails to exploit it safely: 27–30% solve vs 33% reference, 10–13 harmful downgrades per100, and negative cost savings per solve. Therefore stop; no live pilot or paid harness activation. A new live harness/dispatch integration is deferred under the explicit stop condition, rather than running a harmful policy. Existing Koda live benchmark infrastructure is preserved.

Primary product metric remains total cost per VERIFIED solve. This replay cannot measure it; reported historical receipt cost/solve excludes unmeasured verification, handover and local compute. No claim of Koda improvement or real dynamic savings.

## Reproduce without paid calls

```sh
cd /Users/madsflyvholm/Desktop/Koda.ai
nvm use 22
python3 research/cold-start-v6-pareto/src/audit.py
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 research/cold-start-v3/.venv/bin/python research/cold-start-v6-pareto/src/experiment.py
python3 -m unittest discover -s research/cold-start-v6-pareto/src -p "test_*.py" -v
pnpm exec tsx --test tests/paretoResearchV62.test.ts tests/capabilityRoutingV6.test.ts
pnpm typecheck
```

Source audit streams the already-downloaded archive once. Runtime selection does not scan benchmark dumps. `predictor.json` freezes vocabulary/IDF/weights/costs; JSON is inspectable, with no unsafe pickle loading. Tests and replay make zero provider requests.

See [evaluation](artifacts/REPORT.md), [coverage](artifacts/coverage.json), [results](artifacts/results.json) and [pins/licenses](sources.json).

## Validation

Typecheck and standalone research TypeScript: PASS. Focused TS 28/28; Python 4/4. Full suite: 1107 total, 1106 passed, 1 skipped, 0 failed. Evaluation: unchanged100 ×12 public outcomes; zero paid calls. See validation.json for the exact file list.

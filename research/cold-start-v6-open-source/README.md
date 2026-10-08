# Koda V6 — isolated open-source falsification

**STOP / shadow-only.** The fixed experiment has completed. No paid calls, live coding-model reruns, production authority switch or threshold changes.

Architecture: existing Koda assessment/fingerprint/contract → `TaskCapabilityProfile` → six-output TRAIN-fitted small MLP `StartRouterV6` → independent canonical-evidence `capabilityFloor` → `costAwareSelector` → existing coding engine → bounded `ExecutionState` at meaningful boundaries → deterministic `stepRouterV6` → existing verification/recovery/completion/apply. Production continues to dispatch through its existing router; shadow results cannot change a model, write scope, history or apply status.

The MLP reimplements the small learned-router methodology (hashed task text + task dimensions; six expected-success heads). It is **not** the external pretrained router and does not import their pool. Model identities are exactly Claude-sonnet-4, Gemini-2.5-flash, GPT-5-medium, Qwen3-235b-a22b-2507, Deepseek-v3.1-terminus, GLM-4.6. The internal provider ID for GPT-5 is `openai/gpt-5`; historical labels refer specifically to medium reasoning. This experiment does not dispatch any inference settings. A future live pilot must lock that configuration, versions and prices.

The selector minimizes `firstCost + (1 − estimatedFirstSuccess) × referenceCost` only among floor-eligible candidates. It funds the worst-case reference recovery within the task budget. That expected spend is not independent-rescue quality credit. Risk/visual/domain evidence can reject cheap candidates or yield ABSTAIN. Model suitability is learned; no hand-written model/domain strengths exist.

The StepRouter uses explicit regression/progress/complexity evidence, keeps successful progress on the current compatible model, permits same-model repair, and limits research escalation to two. Operational provider/verifier failures take an infrastructure path. Tier advice alone cannot authorize a switch. Shadow observers preserve per-subtask state and aggregate ordinary reads; routing is not invoked for every trivial tool result. Bounded handoff preserves original evidence by digest, with explicit attachment requirements if text/diff exceeds the packet. Existing checkpoint/handoff owns actual continuation; **no V6 model switch is activated**.

## External provenance and licenses

Exact commits, assets, SHA256 and use are in `sources.json`. Full license notices are retained in `licenses/`.

| Project | Commit | License | Use |
|---|---|---|---|
| [ACRouter](https://github.com/LanceZPF/agent-as-a-router) | `e43839edb0d5d0a9feec2f7078019406ab4d64bd` | MIT | `src/routing/trained_routers.py`, `data_manager.py`, README methodology only; independently reimplemented, no pretrained weights or model labels copied |
| [TwinRouterBench](https://github.com/CommonstackAI/TwinRouterBench) | `7cbb0deac8f697b5faa8489c309560e53d2ef088` | Apache-2.0 | `data/static/question_bank.jsonl`, `manifest.json`; SWE prefix-state/tier weak supervision; router interface methodological reference |
| [SWE-smith](https://github.com/SWE-bench/SWE-smith) | `9b74ac08118a85c39c356802f7961893af73e07f` | MIT | License inspected; trajectories deferred |
| [LLMRouter](https://github.com/ulab-uiuc/LLMRouter) | `338335d24e29c26f66b0f11dc9a3b50fe3e742c1` | MIT | License inspected; optional baseline deferred; no dependency |

External source code stays in ignored inspection cache; nothing is vendored as a production dependency. CodeRouterBench methodology is reused, not its different model pool/outcomes. Existing Koda paired LLMRouterBench evidence is reused unchanged. Original split/source audits remain in V2/V3.

Twin's SWE records explicitly say `degradation_search_done` / weak labels, not strict ground truth. Its four tiers (`low`, `mid`, `mid_high`, `high`) are preserved as-is and never renamed into Koda model IDs. Prefix features exclude target tier, future `total_steps`, gold patches and evaluator outcomes. State mapping: commands/results → observed reads/search/mutations/checks/repetition/failures/scope/diff. The static records are real collected prefixes with weak counterfactual labels; they are not six-model next-step measurements.

## Reproduction (offline, no paid APIs)

Node 22, existing V3 Python environment, existing public source cache:

```sh
nvm use 22
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 \
research/cold-start-v3/.venv/bin/python research/cold-start-v6-open-source/src/sources.py

OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 \
research/cold-start-v3/.venv/bin/python research/cold-start-v6-open-source/src/experiment.py \
  --output /tmp/koda-v6-replay
```

A new output directory is required. `--resume` finishes scoring **already frozen decisions** without retraining. No paid/provider CLI exists here.

Optional observational runtime:

```sh
KODA_CAPABILITY_ROUTING=shadow KODA_PROVIDER_MODE=backend \
koda run --repo /path/to/project --task 'Your task'
```

That normal coding command may incur the existing coding-provider cost. V6 itself adds no model calls and never receives production authority. With the flag unset, no V6 artifact is loaded, no observer is registered and selection is unchanged. Do not use this as promotion to V6 authority.

## Evaluation limits and stop

See `artifacts/pilot/REPORT.md` and `results.json`. Same 300 SWE TRAIN and 100 SWE FINAL tasks as V3/V4, no new labels/inference. FINAL was previously observed by earlier experiments: this is retrospective, not pristine prospective validation. Decisions were frozen before the scoring stage. We did not tune on final outcomes.

Twin: grouped instance holdout, zero group overlap, zero SWE FINAL-instance overlap in Twin training. 336 coding states / 40 instances; 205 training states; 67 heldout states / 9 instances. Balanced accuracy 0.419 vs 0.250 majority. This shows a weak tier signal, **not** improved Koda escalation correctness. 296 states have observable tool prefixes. Proxy output is retained for research, not shipped as calibrated Koda adequacy.

Constrained V6 selected Sonnet on 37 tasks and ABSTAINED on 63 (missing domain evidence). The evaluation's explicit reference fallback produces 100 Sonnet starts; these are not 100 V6 selections. Unconstrained learned suggestions select cheaper models on 71 tasks but sacrifice frontier outcomes. No real StepRouter coding experiment was run after the stop condition. Real escalation rate, unnecessary escalation and end-to-end Koda verified solve rate remain unknown.

Historical benchmark solve rates are real outcomes. `simulatedPerfectVerifierRecovery` is separate, perfect-detection/free-verification counterfactual replay; it is not real agent performance. Router provider spend is $0. Local compute and verifier dollar cost are unmeasured; cost/solve is a lower bound, with CPU routing overhead reported in milliseconds. No invented zero-cost compute is used to claim the 40% target.

## Files changed in this work

- `src/router/capabilityRoutingV6.ts`: task/model profiles, safety floor, total-cost selector, execution state, bounded handoff.
- `src/router/startRouterV6.ts`: frozen six-output learned router and explicit start/floor/selection boundary.
- `src/router/stepRouterV6.ts`: trajectory decisions, evidence-only escalation, two-escalation/budget guardrails.
- `src/router/capabilityShadowV6.ts`: isolated event observer and bounded step telemetry.
- `src/router/knowledge/data/capability-start-v6.json.gz`: compact public-TRAIN learned weights; no runtime raw scan.
- `src/router/modelRouter.ts`: opt-in V6 observation after the legacy decision; decision not mutated.
- `src/telemetry/logger.ts`: detached, exception-isolated append-only observers.
- `tests/capabilityRoutingV6.test.ts`: deterministic regressions, actual production shadow on/off isolation.
- `research/cold-start-v6-open-source/`: `src/{sources.py,twin.py,experiment.py,encode.ts,replay.ts,test_v6.py}`, licenses/source manifest, frozen artifacts and this report.

No V2/V3/V4/V5 implementation or artifact, production thresholds, routing authority, verification gates, recovery engine, parallel worker architecture or apply safety was changed.

## Validation completed

- Focused TypeScript: **46/46 passed**, including **19 new V6 tests**.
- Research Python: **8/8 passed**, including TRAIN/FINAL separation, Twin group isolation, no label/future leakage, frozen six-model output and sklearn/TypeScript inference parity.
- `pnpm typecheck`: PASS. Standalone research TypeScript typecheck: PASS.
- Full `pnpm test`: **1,098 tests; 1,097 passed, 1 skipped, 0 failed**; 139.17 seconds.
- SHA256 comparison against the existing 688-file baseline: **686 unchanged**; only `src/router/modelRouter.ts` and `src/telemetry/logger.ts` changed among existing files. New V6 files are listed above. V2/V3/V4/V5 remain unchanged.
- No paid provider calls. No production promotion. No false claim of real Koda verified solve rate or measured six-model StepRouter improvement.

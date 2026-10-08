# Contextual routing implementation and evidence report — 2026-10-06

**Status: incremental shadow foundation, not completion of all twelve phases or a recommendation to activate.** Production dispatch and its frozen recovery policies are unchanged. No paid model calls or paid benchmarks were run.

## Root cause and reproducibility

Quality state was keyed by provider base URL, while the backend and direct transport used different namespaces. Production, V1 and imported benchmark knowledge also had different statistical assumptions. Local support could determine the reference; generic verification strength did not establish measured detection/false-accept probabilities.

`attemptPolicy.ts` was empty. Git HEAD and the valid backup contained the exact same 11,800-byte implementation, SHA-256 `ca06d3eb6ef56da03e2029ab12af7be752fd3e9d0baa1d7dd486b40726976e26`. HEAD was restored byte-for-byte, not recreated. The file now matches HEAD, so it does not appear as a new Git diff. Baseline: typecheck passed; 26 focused tests passed; full baseline 988 tests, 987 passed, one skipped, zero failures.

A second blocker is now measured: **all 7,080 upstream probing task descriptors contain category/split/ID metadata, not task prompts, languages, or semantic embeddings.** The normalized local evidence was not accidentally dropping available probing prompt text. Public [ID task metadata](https://huggingface.co/datasets/Lance1573/CodeRouterBench/blob/main/id_probing_tasks.jsonl) and the [upstream data layout](https://github.com/LanceZPF/agent-as-a-router/blob/main/data/README.md) confirm the published compact data boundary. OOD prompts must not be borrowed to fill that training gap.

## Architecture before/after

Before: provider-scoped quality state, lossy binary task cases, fixed external transfer coefficients, configured quality anchors, separate V1 ledger.

Added: an extension of `RoutingKnowledgeStore` with a transport-independent `~/.koda/routing-quality` namespace; lossless dense observations; explicit split/training policy; proof- and attribution-gated local recording; canonical task representation; empirical and regularized logistic estimators; development-only calibration; frozen artifact/digest; one-shot evaluation; constrained shadow plan selection and observational production logging.

The canonical task retains Assessment, Contract and fingerprint. Contract proof strength wins over generic legacy check strength. It includes structured complexity, localization, scope, languages/frameworks, context, risks, visual/browser needs, blast radius and engine/harness. It accepts a provenance-tagged semantic vector, but **does not generate one or pretend category terms are semantic embeddings**. Missing fields are explicit.

New shadow predictions distinguish source-exact identities from exact Koda observations, family transfer and ignorance. Engine/harness transfer without calibration retains `[0,1]` uncertainty and cannot create an eligible plan. This intentionally prevents the public matrix from being represented as exact success probability on a current Koda endpoint.

Plan selection gates compatibility, calibrated support, confidence, false accepts and worst-case budget before economics. Two-stage rescue requires paired conditional outcomes and measured verifier properties. No independent-failure rescue uplift. Safe exploration is opt-in, constrained to eligible plans with sufficient proof/detection and records its propensity. It does not run in production.

## Changed files

New:

- `src/router/canonicalTask.ts`
- `src/router/contextualQuality.ts`
- `src/router/contextualPlans.ts`
- `src/router/contextualShadow.ts`
- `src/router/knowledge/canonical.ts`
- `src/dev/contextualRoutingEval.ts`
- `tests/contextualRouting.test.ts`
- `docs/contextual-routing-shadow-report-2026-10-06.md`

Modified:

- `src/router/knowledge/schema.ts` — optional dense canonical observations in the existing snapshot.
- `src/router/knowledge/ingest.ts` — descriptor/split metadata and exclusion of explicitly evaluation-only/synthetic runtime inputs.
- `src/router/knowledge/bootstrap.ts` — preserve available descriptor text/split; explicitly mark probing versus ID test; use a consistent benchmark harness identity.
- `src/router/modelRouter.ts` — isolated contextual shadow logging alongside V1; never replaces the selected production plan.

Restored: `src/agent/attemptPolicy.ts`, exactly as above.

Existing files also received requested formatting. Unrelated pre-existing working-tree changes were preserved.

## Data boundaries and real experiment

Only the local CodeRouterBench probing source supplied supervision. Its 7,080 task IDs were matched exactly against public upstream probing metadata; every task belonged to `probing`. The metadata file SHA-256 was `9bb46d1da2520766a4e7dbaf2e027f17febbf7977370b50bbdacdadb7219f515`.

| Partition             | Tasks | Task-model observations | Use                                |
| --------------------- | ----: | ----------------------: | ---------------------------------- |
| Probing / fit         | 4,981 |                  39,848 | Estimator fitting                  |
| Probing / calibration | 1,036 |                   8,288 | Temperature and calibration drift  |
| Probing / development | 1,063 |                   8,504 | Estimator comparison               |
| ID test               | 2,919 |                  23,352 | One evaluation after policy freeze |

All models of the same task are assigned to the same deterministic hash partition. There are eight benchmark model identities. Full 56,640 probing outcomes are retained; partial scores are not discarded. The prediction target is explicitly **complete benchmark solve (`score == 1`)**, not average fractional score and not Koda VERIFIED_SUCCESS. Original scores, revision, provenance, timestamp and economics remain available.

The probing and ID-test task sets are disjoint. Source IDs are not model features; task IDs are used only for partitioning/deduplication. Prices/cost forecasts used to choose a benchmark baseline are estimated from fit data; observed evaluation costs are only used to report results. Evaluation success labels are used only for scoring and the explicitly labeled offline oracle.

## Calibration and development result

| Candidate                       | DEV Brier | DEV log loss |  DEV ECE |
| ------------------------------- | --------: | -----------: | -------: |
| Hierarchical empirical          |  0.131075 |     0.395863 | 0.023346 |
| Regularized logistic contextual |  0.136842 |     0.421063 | 0.043529 |

Empirical was selected on DEV, before ID-test evaluation. Temperature was fitted only on calibration data. Confidence combines Wilson support intervals with a simultaneous empirical calibration-drift bound; ECE is reported as a metric, not treated as a confidence interval. The frozen artifact digest is:

`f5d3364ea0143a50922a838e8d5d0cddad7cf28c5cb2c3e899485fa4302d548f`

DEV: both constrained routers abstain on all 1,063 tasks. This fails the requested activation success conditions. No cost improvement or frontier-call reduction has been established. Mean interval width for the selected estimator is approximately 0.508.

**The current heuristic estimator and complete production/V1 execution policies were not replayed in this experiment.** Their configured current model endpoints do not have exact outcomes in this older benchmark matrix, and the source lacks repository/task text required for a faithful pipeline replay. The two-estimator experiment is not advertised as the requested three-estimator / six-router comparison.

## ID-test result — evaluated once

The frozen empirical artifact was evaluated exactly once against ID test. No estimator/policy changes followed that result. The evaluation source digest is `01e4b5b5672a9ed99c5e9cef21c7d88c2a4a6634fffd7a6258b13a18d60696c2`.

- Brier: **0.128582**
- Log loss: **0.390283**
- ECE: **0.012992**
- Supported source-domain predictions: 23,352/23,352
- Constrained plan selections: **0/2,919**; abstentions: **2,919/2,919**

| Source-domain baseline             | Complete solve rate | USD/task | USD/complete solve | Mean recorded latency |
| ---------------------------------- | ------------------: | -------: | -----------------: | --------------------: |
| Globally strongest on fit data     |            24.7688% | 0.011655 |           0.047054 |            7,396.9 ms |
| Cheapest expected cost on fit data |            23.1244% | 0.000398 |           0.001720 |            9,500.6 ms |
| Offline oracle                     |            40.6646% | 0.000923 |           0.002271 |           10,078.8 ms |

These are benchmark source-domain outcomes, **not independently verified Koda runs**. Regret vs oracle/strongest for the new selected plans is undefined because no plan was selected. Critical false accepts and frontier-call rate are also undefined: the source contains no Koda verifier outcomes or calibrated current-endpoint identity equivalence. OOD was not evaluated.

Estimator overhead measured separately: 10,000 rounds × eight source-model predictions took 38.83 ms, approximately **0.0039 ms per eight-model prediction**. This excludes disk loading, compatibility discovery, telemetry and agent execution.

## Evidence source policy

| Source                         | Allowed lesson                                                         | Disallowed claim/use                                         |
| ------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------ |
| CodeRouterBench probing        | Dense source-task/model cold-start supervision; development partitions | Exact current Koda endpoint/engine solve probability         |
| CodeRouterBench ID test        | Frozen evaluation only                                                 | Training/runtime priors                                      |
| OOD                            | Frozen generalization evaluation only                                  | Fill missing probing semantics or tune policy                |
| SWE-rebench                    | Existing global harness-specific capability/economics priors           | Exact Koda requirement-level verification probability        |
| SWE-bench public submissions   | Optional provenance-normalized outcomes                                | Unidentified model/version/harness equivalence               |
| OpenRouter/Artificial Analysis | Discovery, compatibility, weak global information                      | Verified coding-quality labels                               |
| Local Koda                     | Independently verified requirement proof, attributable MODEL_FAILURE   | Generic PASS, operational/censored failures, synthetic tests |

The new canonical local store preserves selection propensity. It does **not** yet apply inverse-propensity corrections, integrate automatic requirement-proof adjudication into the run ledger, or make local data dominate external priors. Legacy production/V1 state remains readable during this migration.

## Validation

- New deterministic regressions: **17/17 passed**.
- Focused routing/evidence/V1/modelRouter tests: **106/106 passed**.
- Planner recheck: **39/39 passed**.
- Typecheck: passed.
- Build: passed.
- Formatting: changed implementation/test files formatted.
- Unrestricted `pnpm test`: **1,005 tests; 1,003 passed, one skipped, one failed**. Failure: existing planner worker-overlap assertion, whose mock delay is 75 ms. It passes in the isolated 39-test planner run. Tests were not weakened.
- Final ordinary `pnpm test` rerun: **1,005 tests; 1,004 passed, one skipped, zero failures** (116.72 seconds). The initial overlap failure remains recorded above; no assertion or scheduler change was made to obtain this result.
- Full bounded-concurrency rerun: **1,005 tests; 1,004 passed, one skipped, zero failures** (172.99 seconds). Command: `pnpm exec tsx --test --test-concurrency=2 tests/*.test.ts`.

## Commands

Rebuild development evidence using explicit upstream split metadata (free downloads, no model calls):

```zsh
cd /Users/madsflyvholm/Desktop/Koda.ai
nvm use 22
mkdir -p /tmp/koda-contextual-evidence
node --import tsx src/cli.ts routing-prepare-coderouterbench \
  --output /tmp/koda-contextual-evidence/probing.json
node --import tsx src/dev/contextualRoutingEval.ts \
  --source /tmp/koda-contextual-evidence/probing.json \
  --output /tmp/koda-contextual-evidence/development
```

The actual experiment's artifacts are in `~/.koda/routing-quality/`: `routing-knowledge-v2.json`, `contextual-quality-v1.json`, `development-report.json`, `id-test-report.json` and the one-shot ID-test marker. Existing unmarked sources must be re-prepared/validated; the new importer deliberately does not infer split from filenames.

The already-used frozen artifact refuses another ID-test evaluation, even with a different output filename. For a future separately frozen experiment, the syntax is:

```zsh
node --import tsx src/dev/contextualRoutingEval.ts \
  --artifact /path/to/frozen/contextual-quality-v1.json \
  --holdout /path/to/explicit-evaluation-only.json \
  --output /path/to/holdout-report.json
```

Tiny real smoke command, **user-run only; paid provider usage may occur**. This tests the existing production pipeline with new shadow logging, not activation of the contextual router:

```zsh
KODA_PROVIDER_MODE=backend KODA_API_URL=http://127.0.0.1:8787 \
node --import tsx src/dev/realBenchmark.ts \
  --manifest /absolute/path/to/real-tasks.json \
  --priors /absolute/path/to/frozen-routing-v1-priors.json \
  --config koda.config.example.json --split development --limit 2 \
  --budget-usd 0.30 --output /tmp/koda-contextual-real-smoke
```

Requires genuine existing manifest/priors; placeholder paths are not runnable inputs. No paid smoke was run. Free existing end-to-end smoke: `node --import tsx src/dev/fakeSmoke.ts multi`.

## Recommendation and remaining work

**Keep shadow mode.** The architecture requested by the user is not fully implemented or empirically proven. Specifically outstanding: recover a legitimate probing semantic descriptor source/encoder; implement faithful current/heuristic/V1 replay; measured Koda verifier detection/false accepts and conditional recovery; complete semantic neighborhood/version/global hierarchy; connect independent local proof ingestion and selection-bias learning; three-stage/parallel expected-value plan analysis; immutable-candidate verification reuse; frozen OOD evaluation; full namespace migration after validation.

There is no evidence here that the new router matches frontier verified outcomes at lower cost/time. Those claims must not be made from passing tests or these calibration numbers. No production activation is recommended.

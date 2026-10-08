# Routing V1 — shadow only

Implemented 2026-10-06. Current PoolRouter, joint selection and frozen recovery
continue to control execution. Task Assessment V1, Verification Contract V1 and
Failure Attribution V1 semantics are unchanged.

## Architecture

`PoolRouter.selectExecutionPlan` performs its existing production selection.
An isolated observational branch then uses the same discovered/cached model
registry and calls `optimizeRoutingV1`. The latter adapts canonical assessment
and verification facts into the existing `optimizeSpecialists` plan generator.
Legacy tier labels are neutralized in this isolated copy; production models are
not modified. V1 applies its own evidence-based quality constraint and ranks
eligible complete plans by normalized cost per verified completion and latency.

The shortlist includes a credible reference, quality candidates and economical
compatible candidates. Its configurable size uses existing `routing.shortlistSize`
with a V1 range of 5–10; smaller available pools remain smaller. Expensive plan
enumeration operates only on this shortlist. Compatibility checks cover availability,
prices, endpoint parameter co-support, vision, input-plus-output context and output
capacity. Unknown critical capability/capacity metadata is rejected, not guessed.

`selectJointExecutionPlan` additionally records a joint shadow comparison, charging
existing planning prerequisite estimates and comparing quality across strategies.
No shadow decision dispatches a provider request or changes budgets, write scope,
verification, execution strategy, actual selected model or frozen rescue policy.

Reports:

- `routing_v1_shadow_decision`: canonical features, normalized candidates,
  uncertainties, provenance, rejections, reference, regret, complete plans and
  selected shadow plan (or explicit abstention).
- `routing_v1_shadow_joint_decision`: cross-strategy comparison including prerequisites.
- `routing_v1_learning`: positive/negative/censored disposition.
- `summary.json.routingV1`: the observational reports for the run.

`RunOptions.routingV1Shadow=false` disables observation. It does not select a
new production policy. Shadow failures are caught and logged.

## Evidence and cold start

`routingEvidenceSchema` stores independently observed successes/failures, model,
explicit model family, canonical routing category, complexity, execution engine,
cost, elapsed time and provenance. Categories are derived from the existing task
fingerprint and canonical assessment flags, without another prompt keyword parser.

Evidence backs off through global coding, model family, model × task category,
model × category × complexity, then attributed local observations. Ancestor
observations are disjoint from descendants to avoid duplicate counting. Broad
ancestors contribute at most 12 effective observations each. External observations
receive 0.1 weight and an additional per-level cap of 1 effective observation.
Granular controlled and local observations retain their sample counts. Evidence
IDs are deduplicated. Without explicit family evidence the registry provider
namespace is a coarse family fallback; it is not a model architecture claim.

A Beta(1,1) regularizer represents ignorance, not an invented empirical model
success rate. The posterior mean and a conservative mean-minus-1.64-standard-
deviations bound are reported. This approximation must be calibrated against
real benchmark data; it is not a guaranteed confidence interval.

A reference requires at least three effective model/category observations and
three total effective observations. Zero local history works with independent
controlled priors. Zero evidence everywhere produces `selected=null`, rather
than manufactured frontier-quality evidence. A new model gets broad backoff and
may enter a bounded exploration plan when the safeguards and proven rescue exist.

Real priors are read from `<routing.stateDirectory>/routing-v1-priors.json`:

```json
{ "priors": [], "rescueEvidence": [] }
```

The entries follow the exported evidence schema. Conditional rescue evidence
includes initial/rescue model, category, engine, success/failure counts and
provenance from tasks whose initial attempt failed. Never install the scripted
fixture matrices as real model priors. Synthetic evidence is ignored in normal
runs. Existing configured scalar quality priors are not empirical V1 evidence.

## Quality and recovery

Final quality is a constraint before economic ranking. Strong, available
requirement-level proof, low false-accept risk, low consequence risk, no risk flags,
bounded easy localization and confident assessment allow first-attempt exploration.
Otherwise exploration is rejected, even if lint/typecheck/build pass.

Allowed final regret is 0.02 for the safe deterministic case and 0.005 otherwise.
Security, architecture, subjective UI, unresolved/manual proof and other risky
work therefore receive the tighter gate. Reference plan quality also considers
credible eligible rescue trajectories; the best attainable plan can tighten the
constraint beyond the strongest standalone model.

Plans contain one initial model and at most one quality rescue. Conditional rescue
posteriors use paired outcomes when at least three are available. Without them,
the final-quality backoff is a conservative Fréchet bound (`max` of marginal
quality), never independent-success multiplication. Budget checks reserve both
legs, not merely expected expenditure. Expected cost and time include failure-
weighted rescue work, using existing optimizer efficiency/operational evidence.
Provider reliability is exposed separately and does not change coding-quality
posterior observations. V1 does not add a new operational recovery mechanism;
production's frozen optional peer remains unchanged.

## Learning gate

The shadow ledger is `routing-v1-evidence.jsonl`, separate from production
`attempts.jsonl`. Only real verified successes and Failure Attribution-approved
MODEL_FAILURE/NEGATIVE_MODEL_EVIDENCE failures become quality observations.
Provider, scope, context, verification infrastructure, baseline, Koda-internal and
unknown failures are censored. Contradictory positive checks are excluded.
Ambiguous repeated invocations are censored rather than guessed. A run-level
failure removes provisional positive labels. Cost/latency/operational observations
continue through the existing separate production efficiency ledger.

Local imported observations must also satisfy the gate: positive outcomes require
VERIFIED_SUCCESS; negatives require the canonical model-failure disposition.
Synthetic/fake runs never write real shadow quality observations.

## Offline evaluation

```sh
pnpm eval:routing-v1 --dataset benchmarks/routing-v1/development.json \
  --output /tmp/koda-routing-v1-development.json
pnpm eval:routing-v1 --dataset benchmarks/routing-v1/holdout.json \
  --output /tmp/koda-routing-v1-holdout.json
pnpm eval:routing-v1 --dataset benchmarks/routing-v1/development.json --learned \
  --output /tmp/koda-routing-v1-learned.json
pnpm eval:routing-v1 --dataset benchmarks/routing-v1/holdout.json \
  --families frontend_visual --output /tmp/koda-routing-v1-ui.json
pnpm eval:routing-v1 --dataset benchmarks/routing-v1/holdout.json \
  --families security,architecture --output /tmp/koda-routing-v1-risk.json
```

Arbitrary JSON matrices use `routingDatasetSchema`: version, provenance, synthetic
flag, normalized models, disjoint priors/localHistory/rescueEvidence, and tasks
with canonical assessment/contract/fingerprint/features and all model outcomes.
Each outcome records `verified`, independent `groundTruthPass`, cost and elapsed
time. Duplicate task/model IDs, incomplete matrices and training/evaluation task
ID overlap are rejected. Routing receives only inputs and allowed prior evidence;
held-out outcomes are accessed afterward for scoring/oracles.

Comparators are strongest relevant reference, cheapest compatible, unchanged
current optimizer with empty legacy history, V1, and offline cheapest successful
oracle. The current comparator is an optimizer simulation, not a replay of every
production scaffold. The oracle alone may inspect results. Cost/latency regret
is calculated on solved comparisons; unsolved tasks with an available oracle
are reported separately. A false accepted artifact never counts as a solve; all
independently false accepted results are conservatively counted as critical.

Reports include per-category solve rates, false accepts, whole-plan cost/time per
solve, attempts, reference calls, quality regret, oracle regret, unnecessary
reference calls, failed cheap trials, Brier score, ECE, prediction buckets and
routing-computation p50/p95. The measured routing overhead includes shadow plan
generation; it excludes catalog acquisition, file I/O and event serialization.

## Explicit live collection

This command may incur provider charges and is never run automatically:

```sh
KODA_PROVIDER_MODE=backend KODA_API_URL=http://127.0.0.1:8787 \
pnpm eval:routing-v1 --collect --config /path/to/koda-config.json \
  --models '<configured-model-id>,<another-configured-model-id>' \
  --tasks clamp,sum --budget-usd 0.50 \
  --output /tmp/koda-routing-v1-live-collection
```

The collector reuses the existing basic/hard/expert/stress coding benchmark
fixtures and real CLI, with isolated target repos and routing state, forced
configured models and independent acceptance outside the candidate repo. It sends
only task/source fixture inputs, never the fixture implementation or oracle script.
A fresh output directory is required. There are 1–100 explicitly selected pairs,
run sequentially. Aggregate budget is divided into fixed per-run allocations;
unknown/partial accounting consumes its allocation and is never recycled.
An observed allocation overrun stops collection. The underlying gateway must
still enforce its existing provider reservations and actual-usage accounting.

`collection.json` retains per-run outcomes, actual attempt records, canonical
assessment/contract/features where available, raw stage provider calls, latency
breakdown, Failure Attribution, verification, cost completeness, tokens and report
paths. These records are collection output, not automatically trusted quality
priors. Assemble independent training and evaluation matrices from fully observed
records; censored operational failures must not become coding failure priors.

## Validation and limitations

The shipped development and holdout matrices each contain 88 scripted policy
cases, eight per category. They have distinct IDs, but use the same controlled
fixture generator. Costs and latencies are simulated. These are policy regressions,
not genuine unseen vendor coding evaluations, visual assessments or business-metric
proof. No paid calls were made for this implementation.

On these fixtures V1 and strongest both solve 88/88; cheapest/current solve 82/88.
V1 solves 8/8 each for visual UI, security and architecture. False accepts are zero.
V1 costs $0.034545 simulated per solve and takes 2.0909 simulated seconds per solve;
strongest has the same result. Oracle cost/time are $0.016136 and 1.2727 seconds.
V1's total oracle cost regret is $1.62 and latency regret is 72 seconds.
The fixture therefore does **not** demonstrate savings against strongest.
Cold-start Brier is 0.000500 and ECE is 0.022356. Learned-fixture Brier is 0.000687
and ECE is 0.026031; learning does not magically improve this fixture's calibration.

Real-world quality, cost advantage, calibrated uncertainty, correlated rescue
behavior, visual quality and large-catalog overhead still require bounded real
model matrices. The live fixture collector currently emphasizes functional code;
real UI/security/architecture matrices need independent task-appropriate proof.
Stage recommendations remain observational: this task does not make production
planner/exploration calls faster. Sparse/absent prior evidence can yield an explicit
shadow abstention. Production routing stays unchanged until results are reviewed.

## Files changed in this phase

| File                                     | Change                                                                                                                              |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `src/router/routingV1.ts`                | Canonical feature adapter, hierarchical estimates, compatibility, bounded plans, final-quality/economic gates and joint comparison. |
| `src/router/routingV1History.ts`         | Separate validated shadow evidence ledger and prior loading.                                                                        |
| `src/router/routingV1Evaluation.ts`      | Outcome matrix validation, leak prevention, baselines/oracle and calibration/metrics.                                               |
| `src/router/modelRouter.ts`              | Observational hooks around existing execution and joint selection.                                                                  |
| `src/run.ts`                             | Shadow toggle, canonical attribution learning gate and report fields.                                                               |
| `src/dev/fakeProvider.ts`                | Optional shadow toggle in the existing test seam.                                                                                   |
| `src/dev/routingV1Eval.ts`               | Offline/live evaluation command.                                                                                                    |
| `src/dev/routingV1Collect.ts`            | Explicit bounded real-CLI benchmark collector and attempt/stage records.                                                            |
| `src/dev/routingV1Fixtures.ts`           | Shared deterministic policy-test fixtures.                                                                                          |
| `src/dev/routingV1FixtureDataset.ts`     | Explicitly synthetic matrix generator.                                                                                              |
| `tests/routingV1.test.ts`                | 39 regressions, including actual PoolRouter shadow on/off invariance.                                                               |
| `benchmarks/routing-v1/development.json` | 88 controlled development cases.                                                                                                    |
| `benchmarks/routing-v1/holdout.json`     | 88 separately identified controlled holdout cases.                                                                                  |
| `package.json`                           | Adds `eval:routing-v1`.                                                                                                             |
| `docs/routing-v1.md`                     | Architecture, commands, measured results and limitations.                                                                           |

Final validation: affected tests **198/198 pass**. Full suite **972 tests:
971 pass, 1 skip, 0 fail**, 177.36 seconds. `pnpm typecheck` and `pnpm build`
pass. New modules, tests, datasets, package configuration and this document pass
Prettier. Global `pnpm format:check` still reports **158 pre-existing files**;
there is no package lint script. Those unrelated formatting changes were not made.

Measured cold-start development computation overhead: p50 **4.18 ms**, p95
**14.23 ms**. Holdout: p50 **3.38 ms**, p95 **9.98 ms**, during concurrent local
validation. These are two-model fixture measurements, not a large-catalog SLA.

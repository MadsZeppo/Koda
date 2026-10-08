# Isolated offline CodeRouterBench task-routing experiment (Phase 1)

This disposable research harness tests **unseen-task routing among observed models**, not unseen-model quality, production Koda routing, public→Koda transfer, or actual agent execution. It makes no inference calls. It downloads only the public [CodeRouterBench dataset](https://huggingface.co/datasets/Lance1573/CodeRouterBench).

## Isolation

- Production routing files changed: **no**.
- Routing authority, gates or thresholds changed: **no**.
- Production runtime behavior changed: **no**.
- Paid model calls: **0**.

Production-critical code inspected and left untouched by this task: `src/run.ts`, `src/router/modelRouter.ts`, `legacyProductionRouter.ts`, `routeOptimizer.ts`, `contextualRouterVNext.ts`, `contextualQuality.ts`, `contextualShadow.ts`, knowledge/authority modules, agent/provider/workspace/verifier code. No production import points into this directory. Only three package scripts expose the research CLI. The separately requested `docs/koda-prompt-routing-verification-current.md` is documentation, not experiment integration.

## Important dataset limitation

At the downloaded revision, **all 9,999 ID tasks have no prompt/text**. Their task exports contain ID, split and dimension only. All 176 OOD tasks have prompts. Missing text is `null` and reported prominently; IDs are never turned into proxy prompt tokens. Thus the real runs below use **dimension-only similarity**. They establish, at most, routing signal conditional on available task-category metadata, not lexical nearest-task retrieval. The fixture exercises the text/TF-IDF path. OOD text cannot help lexical training when ID training text is absent.

Do not promote these results to production or claim calibrated Koda quality. A next research step would need genuine ID prompt joins from a trustworthy released source, then a predeclared text-based experiment and independent confirmation. No additional dataset was invented or merged here.

## Commands

Use Node 22 and run from the Koda repository. Every `--output` must be a new directory; collisions fail instead of overwriting a prior experiment. No provider key is needed.

```zsh
nvm use 22
pnpm cold-start:test
pnpm typecheck

# Download immutable public snapshot once; this is not paid inference.
pnpm cold-start:data --output research/cold-start/.cache/coderouterbench

# Audit files, joins, discovered model list and fingerprints without routing.
node --import tsx research/cold-start/src/cli.ts validate \
  --dataset research/cold-start/.cache/coderouterbench
pnpm cold-start:eval --list-models

# Tiny synthetic mechanics fixture (not performance evidence).
pnpm cold-start:eval --dataset research/cold-start/fixtures \
  --k 3 --minimum-neighbors 3 \
  --output "research/cold-start/artifacts/fixture-$(date +%s)"

# Deterministic 100 held-out published ID test tasks.
pnpm cold-start:eval --mode task-holdout --features dimension \
  --seed 42 --k 25 --minimum-neighbors 3 --limit 100 \
  --output "research/cold-start/artifacts/id-100-$(date +%s)"

# Same predeclared parameters, all 2,919 published ID test tasks.
pnpm cold-start:eval --mode task-holdout --features dimension \
  --seed 42 --k 25 --minimum-neighbors 3 \
  --output "research/cold-start/artifacts/id-full-$(date +%s)"

# Completely separate OOD evaluation, still only probing/ID training evidence.
pnpm cold-start:eval --mode ood --features dimension \
  --seed 42 --k 25 --minimum-neighbors 3 \
  --output "research/cold-start/artifacts/ood-$(date +%s)"

# Architectural model holdout, not an unseen-model prediction claim.
# Replace the model ID with any ID discovered from the actual snapshot.
pnpm cold-start:eval --mode model-holdout --holdout-model claude-opus-4-6 \
  --features dimension --seed 42 --limit 100 \
  --output "research/cold-start/artifacts/model-holdout-$(date +%s)"

# Optional reproducible probing task holdout; published test/OOD labels stay unused.
pnpm cold-start:eval --task-holdout 0.2 --features dimension --seed 42 \
  --output "research/cold-start/artifacts/probing-holdout-$(date +%s)"
```

To pin acquisition explicitly, add `--revision <HF-commit>` to `cold-start:data` and choose a fresh cache destination. Default `main` is resolved once to an immutable SHA before any dataset file is fetched. Re-evaluation uses that local snapshot, not the network. `--models id,id`, `--metric cosine|jaccard`, `--features text|dimension|text-dimension`, `--k`, `--minimum-neighbors`, seed and limit are recorded. There is no `--router oracle` dispatch option.

## Data normalization and audit

`data.ts` validates RFC4180 CSV and task/model joins. The combined ID result table must match the probing/test exports exactly; it is checked, not counted twice. Split-specific task metadata must agree with the canonical task table. Duplicates, conflicting observations, unknown models, invalid/nonfinite outcomes and inconsistent splits fail loudly. Incomplete candidate matrices are excluded from paired evaluation with explicit task/reason lists. Text/cost/latency/token/revision missingness remains null.

Canonical outcomes retain dataset, harness, source file/revision or SHA256, task text/split/dimension/metadata, model ID/revision/metadata, actual source outcome, optional source cost/latency/tokens and raw row reference. Raw downloaded bytes stay separate and unchanged in `.cache`; normalized evaluation observations are stored separately in `ground-truth.jsonl`. No current price/cost or unknown model revision is manufactured. OOD input/output token columns are mapped; absent total/latency fields remain null.

Source costs are dataset-reported **computed historical estimates**, not invoices for these runs. Some ID rows report zero-token legacy cost; the adapter preserves and exposes their source provenance without inventing replacement values. Model revisions are unknown in the published model metadata.

## Leakage boundary

`partition()` constructs a deeply frozen, branded `RoutingEvidence` containing only probing/training tasks and admissible observations. A held-out model's labels are entirely absent. Evaluation tasks are disjoint by task ID. Routers receive no evaluation outcome matrix, oracle or arbitrary metadata features. Attempts to pass a structurally forged evidence object or ground truth are rejected by the runtime evidence brand.

The hidden `EvaluationGroundTruth` is evaluator-owned and released only after the complete, byte-identical `predictions.jsonl` exists. Scoring and the oracle happen afterwards in `evaluate.ts`. The CLI writes the whole prediction artifact first. Hidden outcome edits cannot change splits, training evidence, predictions or neighbors. Tests explicitly check these properties.

Source task-holdout means probing trains, published ID test evaluates. `--task-holdout fraction` instead holds out a deterministic seeded subset of probing; published test labels are never added to training. OOD always trains on probing only. Task/model filters and `--limit` are outcome-blind. Model holdout keeps static Always baselines as evaluation references, but kNN exposes a null held-out-model estimate and cannot select it from hidden evidence. Status is `UNSEEN_MODEL_SELECTION_NOT_SUPPORTED_IN_PHASE_1`.

## Simple policies and metrics

- Always: every discovered candidate separately, no model-quality prediction.
- Global best: greatest **training mean continuous score**, deterministic model-ID tie break.
- Global cheapest: lowest training mean recorded cost only when every candidate has complete training cost coverage. Otherwise explicitly unavailable.
- kNN: train-only local TF-IDF, cosine or Jaccard, replaceable feature/similarity interfaces, positive-similarity neighbors, weighted mean score per model. No task ID/outcome/solution is a feature. Missing sufficient neighbors yields null/abstention, never an implicit fallback. **All similarity ties at rank k are included** so outcomes or task IDs do not choose among indistinguishable features; effective neighbor count can exceed k. Dimension-only data consequently pools all matching-category neighbors.
- Oracle: evaluator-only maximum actual task score, model-ID quality tie break; not the cheapest possible oracle and not part of the normal Router interface.

Complete solve means source `score === 1` (OOD `resolved === 1`). Continuous scores below 1 remain partial outcomes. Regret is max candidate score minus selected score; nearest-rank p50/p90/p95 are computed on routed tasks. Catastrophic miss means selected incomplete outcome with some candidate completely solving that task. Top1 accepts any maximum-score tie. Abstentions count as unresolved in solve rate; conditional regret/miss/top1 coverage is reported, not fabricated.

Any missing selected cost makes whole-router cost/task and cost/solve N/A; no extrapolation. Latency likewise requires complete comparable coverage. Cost/solve is total recorded selected cost divided by complete solves. Relative cost compares against the **posthoc best static by evaluation solve rate**, clearly distinct from the training-only Global best. Every policy reports routed count, abstentions, model distribution and cost/latency coverage.

## Artifacts and reproducibility

Each exclusive output directory contains `config.json`, `dataset-summary.json`, `dataset-fingerprint.json`, `split.json`, `predictions.jsonl`, `ground-truth.jsonl`, `metrics.json`, `execution.json`, `summary.md`. Config records experiment version, Git commit, seed/options/features/policy, timestamp and source fingerprint. A dirty source tree is not uniquely identified by its Git commit; retain the research source alongside artifacts to reproduce uncommitted work. Prediction/scoring artifact bytes are deterministic for identical source/data/options; timestamps, paths and measured routing time are naturally different.

`.cache/` and `artifacts/` are gitignored locally. No raw benchmark dump or large result artifact is committed.

## Exact files added/modified

| File | Purpose |
|---|---|
| `package.json` | Only `cold-start:test`, `cold-start:data`, `cold-start:eval` scripts added by this task; existing scripts preserved |
| `research/cold-start/.gitignore` | Exclude downloaded data/results/partial downloads |
| `research/cold-start/tsconfig.json` | Independently typecheck research without altering production tsconfig |
| `research/cold-start/src/types.ts` | Canonical records and preexecution-only feature input |
| `research/cold-start/src/data.ts` | Revision-pinned acquisition, parsing, joins, fingerprinting/audit |
| `research/cold-start/src/split.ts` | Frozen branded evidence, deterministic partitions, persisted-prediction gate |
| `research/cold-start/src/features.ts` | Local train-only TF-IDF, cosine/Jaccard interfaces |
| `research/cold-start/src/routers.ts` | Always, training Global best/cheapest, kNN; no oracle |
| `research/cold-start/src/evaluate.ts` | Posthoc oracle and exact metrics/report |
| `research/cold-start/src/cli.ts` | Offline data/validate/eval command and exclusive artifacts |
| `research/cold-start/tests/coldStart.test.ts` | 28 deterministic tests for data/splits/leakage/policies/metrics/artifacts |
| `research/cold-start/fixtures/README.md` | Explicit synthetic-only fixture provenance |
| `research/cold-start/fixtures/models.json` | Three invented fixture model aliases |
| `research/cold-start/fixtures/id_tasks.jsonl` | Canonical fixture ID tasks |
| `research/cold-start/fixtures/id_probing_tasks.jsonl` | Fixture train join validation |
| `research/cold-start/fixtures/id_test_tasks.jsonl` | Fixture test join validation |
| `research/cold-start/fixtures/id_results_long.csv` | Combined fixture consistency table |
| `research/cold-start/fixtures/id_probing_results_long.csv` | Fixture training labels |
| `research/cold-start/fixtures/id_test_results_long.csv` | Hidden fixture test labels |
| `research/cold-start/fixtures/ood176_tasks.jsonl` | Two fixture OOD tasks (not 176 real tasks) |
| `research/cold-start/fixtures/ood176_results_long.csv` | Hidden fixture OOD labels |
| `research/cold-start/README.md` | Methodology, limitations, commands and actual results |

No dependency added; lockfile was not changed by this task.

## Removal

Remove only this experiment and its three scripts. Do not restore the entire dirty package.json or clean unrelated work:

```zsh
rm -rf research/cold-start
node --input-type=module -e 'import fs from "node:fs"; const p="package.json"; const x=JSON.parse(fs.readFileSync(p,"utf8")); for (const k of ["cold-start:test","cold-start:data","cold-start:eval"]) delete x.scripts[k]; fs.writeFileSync(p,JSON.stringify(x,null,2)+"\n");'
```

Nothing in production depends on the experiment. The separate architecture documentation can be retained.

## Actual audit and checks (6 October 2026)

Resolved HF revision: `e567d89bdd569c9c74ffc7c7118e50d15e46b886`. Snapshot SHA256: `effc0025fa967b116cb50e3293343fc6eb79d31807b64d88271ab9ea1fef96c1`. Every per-file SHA256 is in the output `dataset-fingerprint.json`.

```json
{
  "dataset": "Lance1573/CodeRouterBench",
  "tasks": 10175,
  "models": 8,
  "modelIds": [
    "MiniMax-M2.7",
    "Qwen3-Max",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "glm-5",
    "gpt-5.4",
    "kimi-k2.5",
    "qwen3.5-plus"
  ],
  "outcomes": 81400,
  "completeMatrices": 10175,
  "missingOutcomes": 0,
  "missingTaskText": 9999,
  "splits": {
    "id_test": 2919,
    "ood": 176,
    "probing": 7080
  },
  "dimensions": {
    "algorithm": 1111,
    "bug_fixing": 1273,
    "code_completion": 1111,
    "code_generation": 1125,
    "code_refactoring": 1111,
    "code_understanding": 1111,
    "data_science": 1111,
    "multi_language": 1111,
    "test_generation": 1111
  },
  "costCoverage": 1,
  "latencyCoverage": 0.9827027027027027,
  "modelRevisionCoverage": 0,
  "warnings": [
    "ID_TASK_TEXT_UNAVAILABLE: no ID text retrieval claims; dimension-only features are available"
  ]
}
```

- Research typecheck + tests: **28/28 pass**, 0 skipped/failures.
- `pnpm typecheck`: **PASS**.
- Existing contextual cold-start/routing/milestone/authority tests: **56/56 pass**.
- Full `pnpm test`: **1,079 total, 1,078 passed, 1 skipped, 0 failed**.
- Fixture, data validation, 100-task ID, full ID, OOD and model-holdout runs completed.
- Paid inference calls: **0**.

## Fixture mechanics comparison

| Policy | Solve | Mean regret | p95 regret | Catastrophic miss | Cost/solve |
|---|---:|---:|---:|---:|---:|
| Always(model-a) | 0.5000 | 0.5000 | 1.0000 | 0.5000 | 0.0200 |
| Always(model-b) | 0.5000 | 0.5000 | 1.0000 | 0.5000 | 0.0400 |
| Always(model-c) | 0.5000 | 0.5000 | 1.0000 | 0.5000 | 0.0800 |
| Global best | 0.5000 | 0.5000 | 1.0000 | 0.5000 | 0.0800 |
| Global cheapest | 0.5000 | 0.5000 | 1.0000 | 0.5000 | 0.0200 |
| kNN | 1.0000 | 0.0000 | 0.0000 | 0.0000 | 0.0150 |
| Oracle (posthoc) | 1.0000 | 0.0000 | 0.0000 | 0.0000 | 0.0150 |

Routing prediction time (all policies): **0.2 ms**; this excludes acquisition/normalization/artifact I/O, and measures no model latency. Best static is posthoc `Always(model-a)`.

## 100-task public ID comparison

| Policy | Solve | Mean regret | p95 regret | Catastrophic miss | Cost/solve |
|---|---:|---:|---:|---:|---:|
| Always(MiniMax-M2.7) | 0.1700 | 0.2644 | 1.0000 | 0.2500 | 0.0291 |
| Always(Qwen3-Max) | 0.2300 | 0.2078 | 1.0000 | 0.1900 | 0.0024 |
| Always(claude-opus-4-6) | 0.3100 | 0.1149 | 1.0000 | 0.1100 | 0.0360 |
| Always(claude-sonnet-4-6) | 0.2000 | 0.1772 | 1.0000 | 0.2200 | 0.0422 |
| Always(glm-5) | 0.1600 | 0.2729 | 1.0000 | 0.2600 | 0.0350 |
| Always(gpt-5.4) | 0.2300 | 0.1955 | 1.0000 | 0.1900 | 0.0243 |
| Always(kimi-k2.5) | 0.1600 | 0.2229 | 1.0000 | 0.2600 | 0.0053 |
| Always(qwen3.5-plus) | 0.2000 | 0.2394 | 1.0000 | 0.2200 | 0.0087 |
| Global best | 0.3100 | 0.1149 | 1.0000 | 0.1100 | 0.0360 |
| Global cheapest | 0.2300 | 0.2078 | 1.0000 | 0.1900 | 0.0024 |
| kNN | 0.3700 | 0.0593 | 0.3004 | 0.0500 | 0.0118 |
| Oracle (posthoc) | 0.4200 | 0.0000 | 0.0000 | 0.0000 | 0.0118 |

Routing prediction time (all policies): **150.3 ms**; this excludes acquisition/normalization/artifact I/O, and measures no model latency. Best static is posthoc `Always(claude-opus-4-6)`.

## Full 2,919-task ID comparison

| Policy | Solve | Mean regret | p95 regret | Catastrophic miss | Cost/solve |
|---|---:|---:|---:|---:|---:|
| Always(MiniMax-M2.7) | 0.1788 | 0.2440 | 1.0000 | 0.2278 | 0.0287 |
| Always(Qwen3-Max) | 0.2203 | 0.2035 | 1.0000 | 0.1864 | 0.0024 |
| Always(claude-opus-4-6) | 0.2477 | 0.1619 | 1.0000 | 0.1590 | 0.0471 |
| Always(claude-sonnet-4-6) | 0.1816 | 0.1871 | 1.0000 | 0.2251 | 0.0472 |
| Always(glm-5) | 0.2165 | 0.2199 | 1.0000 | 0.1901 | 0.0264 |
| Always(gpt-5.4) | 0.2306 | 0.1781 | 1.0000 | 0.1761 | 0.0246 |
| Always(kimi-k2.5) | 0.1662 | 0.2337 | 1.0000 | 0.2405 | 0.0048 |
| Always(qwen3.5-plus) | 0.2100 | 0.2287 | 1.0000 | 0.1966 | 0.0081 |
| Global best | 0.2477 | 0.1619 | 1.0000 | 0.1590 | 0.0471 |
| Global cheapest | 0.2203 | 0.2035 | 1.0000 | 0.1864 | 0.0024 |
| kNN | 0.3265 | 0.0835 | 1.0000 | 0.0802 | 0.0137 |
| Oracle (posthoc) | 0.4066 | 0.0000 | 0.0000 | 0.0000 | 0.0113 |

Routing prediction time (all policies): **6466.0 ms**; this excludes acquisition/normalization/artifact I/O, and measures no model latency. Best static is posthoc `Always(claude-opus-4-6)`.

## Separate 176-task OOD comparison

| Policy | Solve | Mean regret | p95 regret | Catastrophic miss | Cost/solve |
|---|---:|---:|---:|---:|---:|
| Always(MiniMax-M2.7) | 0.3523 | 0.4375 | 1.0000 | 0.4375 | 0.2973 |
| Always(Qwen3-Max) | 0.3295 | 0.4602 | 1.0000 | 0.4602 | 0.0725 |
| Always(claude-opus-4-6) | 0.6364 | 0.1534 | 1.0000 | 0.1534 | 1.7403 |
| Always(claude-sonnet-4-6) | 0.4318 | 0.3580 | 1.0000 | 0.3580 | 1.8476 |
| Always(glm-5) | 0.4489 | 0.3409 | 1.0000 | 0.3409 | 0.4841 |
| Always(gpt-5.4) | 0.6420 | 0.1477 | 1.0000 | 0.1477 | 0.1617 |
| Always(kimi-k2.5) | 0.1989 | 0.5909 | 1.0000 | 0.5909 | 0.0418 |
| Always(qwen3.5-plus) | 0.2727 | 0.5170 | 1.0000 | 0.5170 | 0.1294 |
| Global best | 0.6364 | 0.1534 | 1.0000 | 0.1534 | 1.7403 |
| Global cheapest | 0.3295 | 0.4602 | 1.0000 | 0.4602 | 0.0725 |
| kNN | 0.6364 | 0.1534 | 1.0000 | 0.1534 | 1.7403 |
| Oracle (posthoc) | 0.7898 | 0.0000 | 0.0000 | 0.0000 | 0.4529 |

Routing prediction time (all policies): **225.9 ms**; this excludes acquisition/normalization/artifact I/O, and measures no model latency. Best static is posthoc `Always(gpt-5.4)`.

## Interpretation and Phase 2 limits

The 100-task run showed kNN 37% vs static Opus 31%, with 42% oracle: +6 percentage points, 5-point oracle gap. Recorded cost per complete solve was about $0.0118 vs $0.0360 (roughly 67% lower). Mean regret 0.0593, p95 0.3004, catastrophic misses 5%. No configuration was tuned after seeing these outcomes.

Full ID confirmed a **category-conditioned** signal: kNN 32.65% vs best static 24.77%, oracle 40.66%. This is positive offline evidence for exploiting task buckets among known public models, not evidence that rich prompt-similarity retrieval works or that Koda can select a new model.

OOD weakened that result: kNN 63.64% vs best static GPT-5.4 64.20%, oracle 78.98%. Quality did not beat the strongest static baseline under distribution shift. Cheaper recorded costs alone cannot justify production activation; quality matters first. No significance/confidence claim was computed.

The model-holdout demonstration removed all Opus training labels. Every Opus kNN estimate remained null and the run reported `UNSEEN_MODEL_SELECTION_NOT_SUPPORTED_IN_PHASE_1`. kNN solved 28/100; static references may still be scored posthoc, but this does not predict the held-out model. Hidden-label isolation tests also change held-out labels and prove unchanged predictions.

The most defensible next step is acquiring genuine ID task text and confirming a frozen task-feature experiment across independent holdouts. These findings do not by themselves justify public→Koda transfer correction, unseen-model profiles or production routing changes. Missing exact model revisions, absent ID text, cross-harness generalization, correlated/publicly visible outcomes, category-label availability and incomplete OOD latency limit the conclusions. OOD uses only available source outcomes; it is not a fresh rerun of those agents.

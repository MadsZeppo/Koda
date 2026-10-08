# Opt-in evidence-backed cold-start routing

Default production routing stays `legacy`. Enable the separate authority in a copy of your normal config:

```json
{
  "routing": {
    "authority": "cold-start",
    "coldStart": {
      "models": ["YOUR_CHEAP_MODEL_ID", "YOUR_REFERENCE_MODEL_ID"],
      "referenceModel": "YOUR_REFERENCE_MODEL_ID",
      "completionReserveFraction": 0.1
    }
  }
}
```

Replace the IDs with exact IDs already present in `modelPool.models`. The pool accepts one through six unique models; the explicit reference must be included. Merge this fragment into your existing configuration, preserving backend/provider and budget settings. Run with `koda run --repo /path/to/project --config /path/to/your-config.json --task 'Your task' --apply`. Preview remains available by omitting `--apply`.

## Decision and execution

1. Existing task understanding supplies the fingerprint, scope, risk and verification strength.
2. Raw model capabilities, context capacity, output capacity, prices and availability filter the configured pool.
3. The existing canonical contextual estimator supplies exact-model quality intervals. Legacy qualityPrior, specialist posterior and tier labels are not quality inputs.
4. Among sufficiently supported, calibrated candidates, select the cheapest estimated request whose conservative success bound is within the existing allowed regret of the strongest credible upper bound.
5. High-risk tasks and insufficient evidence start on the explicitly configured reference. This fallback is a policy choice, not a fabricated quality estimate.
6. A cheap start reserves dollars and tokens for the reference attempt plus a separate completion reserve. Its worker budget is capped; it cannot consume the rescue allocation.
7. An attributable verification regression bypasses the same-model repair and escalates through the frozen reference leg. Existing infrastructure/provider classification is preserved. Escalation is bounded by the frozen plan and run budgets.
8. Existing deterministic verification, completion review, baseline comparison, isolation, write restrictions and safe apply remain authoritative. A failure cannot become success merely because routing predicts success.

`cold_start_route` records each candidate's provenance, support, bounds, eligibility, selected model and budget reservation. Unknown quality is logged as null. Default legacy routing does not use this selector.

## Evidence and honest limitations

Without `evidenceFile`, load eligible verified local canonical evidence from `quality-local.jsonl`. Positive observations require independent requirement-level proof; attributable model failures may supply negative observations. Operational failures are excluded. Repeated observations of the same model/task/harness/engine are deduplicated. The artifact is cached until the file changes, and files over 16 MB require offline compaction.

An optional `evidenceFile` is a compact envelope:

```json
{
  "version": 1,
  "artifact": "EXISTING_CANONICAL_CONTEXTUAL_ARTIFACT_OBJECT",
  "sources": [{
    "provenance": "SOURCE_IDENTIFIER_USED_BY_ARTIFACT",
    "license": "CC-BY-4.0",
    "revision": "PINNED_SOURCE_REVISION",
    "url": "SOURCE_URL"
  }]
}
```

Use an actual validated artifact object, not the illustrative string above. Sources must have declared compatible rights and match artifact provenance. Version transfer is rejected. Synthetic and holdout exclusions remain owned by the canonical fitting pipeline. Declaring a license does not independently establish that a dataset has that license: the artifact producer must audit it.

The available public research does not establish Koda-harness quality for every current model/version. This implementation does not manufacture that evidence or activate a failed research fit. A fresh installation with no credible exact-model evidence therefore starts on its reference. Cheap starts require relevant calibrated support; the deterministic tests use synthetic fixtures only to verify execution behavior, never to populate production evidence.

No paid calls are necessary for the regression tests:

```sh
node --import tsx --test tests/coldStartPolicy.test.ts tests/coldStartFlow.test.ts
```

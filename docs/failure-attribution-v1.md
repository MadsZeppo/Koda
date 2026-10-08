# Failure Attribution V1 (shadow)

Failure attribution consumes evidence per coding-worker invocation, including that invocation's verification and completion review. Parallel subtasks have separate attempt IDs; subsequent invocations of the same model/subtask have different IDs. Pre-worker provider/preflight failures are separate observations. `failure-attribution.json`, `failure_attribution` events and `summary.json.failureAttribution` contain the canonical serializable results. `RunOptions.failureAttributionShadow=false` disables reporting.

The resolver has no provider dependency, never reads learned model history, and never feeds its recommendations into execution. Existing routing, quality history, budgets, scope, retry, recovery, acceptance and apply policies are unchanged. Task Assessment V1 and Verification Contract V1 remain frozen. Production comparisons use the existing differential verifier, including exact failure identities, changed paths and comparable command/cwd.

## Evidence boundary

`failureAttribution.ts` defines validated normalized observations: provider response, opportunity audit, candidate proof, concrete subsystem fault, required scope block, necessary context gap and unresolved evidence. The runtime adapter consumes existing structured events plus minimal provider-origin and final authoritative verification observations. Errors' text is recorded for inspection, never used as the canonical causal predicate.

A MODEL_FAILURE requires all of: usable provider response, independent valid-opportunity audit, all required write scope available, necessary facts supplied/retrievable, valid strong candidate-specific proof, and a comparable baseline establishing a new regression. Compile, test, behavioral, independently proved missing mutation and independently audited unusable output can qualify. A weak Verification Contract requirement cannot qualify just because a caller labels its observation strong. Missing or contradictory facts lead to UNKNOWN/CENSORED; localized paths, test names, model difficulty and absence of edits do not prove these prerequisites.

**Runtime limitation:** current production telemetry often cannot establish that localization captured _all_ necessary scope/context. Those attempts deliberately remain UNKNOWN rather than acquiring fabricated negative evidence. The eval opportunity audits are explicit controlled facts; their precision numbers do not establish precision/recall on arbitrary production tasks. Scope rejection without independently established necessity is also UNKNOWN. A future independently implemented scope/context audit may emit a `failure_evidence` observation using the same schema; a semantic opinion alone must not supply negative-learning prerequisites.

Concrete provider faults, verifier/protocol failures, unchanged baseline failures, necessary Koda-blocked paths, withheld context and internal faults are censored. User-authorized write restrictions never generate EXPAND_SCOPE just because a worker tried another path. Retry recommendations are descriptive only. Resolved transport retries and superseded authoritative check results do not establish stale failure. An independently proved regression can remain primary if an unrelated internal fault follows; a verifier/internal fault before proof prevents that proof from establishing model blame.

The runtime integration adds a provider-origin observation at the actual Agentic dispatch catch, separates successful HTTP response receipt from Gateway response validation, records compact authoritative baseline/candidate observations after retries, and records a checkpoint restoration mismatch at its source. Generic worker/preflight errors without a trustworthy origin stay UNKNOWN.

## Reproduction

```sh
pnpm eval:failure-attribution --dataset benchmarks/failure-attribution/development.jsonl --output /tmp/koda-failure-dev.json
pnpm eval:failure-attribution --dataset benchmarks/failure-attribution/holdout.jsonl --output /tmp/koda-failure-holdout.json
pnpm exec tsx --test tests/failureAttribution.test.ts
```

The CLI accepts an arbitrary JSON array or JSONL of `{id,critical?,trace:{attemptId,events,verificationContract?},expected:{primaryCause,contributingCauses,learningDisposition,retryRecommendation}}`. Input schemas are exported. Development and holdout have distinct fixed domains/sequences/IDs; holdout is not used by the resolver or to tune rules.

Reports include primary/contributor accuracy, macro/per-cause F1, disposition/retry accuracy, full confusion matrix, abstention rate, model precision/recall, false blame counts (including critical cases), per-cause censoring and p50/p95 resolver execution time. Parsing, disk writes and provider time are excluded from resolver timing. Runtime artifacts additionally record total collection time. Datasets are controlled structured trace fixtures, not paid live runs or an estimate of production incidence.

All eight causes are supported: MODEL_FAILURE, SCOPE_FAILURE, CONTEXT_FAILURE, PROVIDER_FAILURE, VERIFICATION_INFRA_FAILURE, REPO_BASELINE_FAILURE, KODA_INTERNAL_FAILURE, UNKNOWN. Only independently proven MODEL_FAILURE is NEGATIVE_MODEL_EVIDENCE. Every other outcome is CENSORED.

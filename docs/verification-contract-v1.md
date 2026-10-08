# Verification Contract V1

V1 is a shadow verification **plan**, not an acceptance decision or a new
verification executor. It answers how each user requirement could be proved.
`src/verifier/contract.ts` reuses `taskRequirementChecklist` and TaskSpec, keeps
existing requirement IDs when supplied, and records methods, planned strength,
false-accept risk, blocking status, criticality, proof availability and evidence.
Overall strength is the weakest requirement and overall risk is the highest risk.

The plan separates required project checks from requirement-specific proof.
Generic lint/typecheck/build evidence cannot discharge behavioral requirements.
A requirement can have a strong _planned_ targeted test without that test
existing yet: `proofAvailability=planned` and the evidence explicitly say so.
This must never be mistaken for an observed PASS. Related tests alone do not
prove coverage; direct proof must be bound to the requirement ID. Concrete
abstraction reuse has medium static/semantic proof; subjective UI and architectural
quality remain weak. Critical requirements retain explicit blocking proof needs.

No tests are created, checks executed or models called during contract generation.
Task Assessment V1 is consumed only as reporting evidence and is unchanged.
`src/run.ts` emits `verification_contract` and serializes `verificationContract`
in `summary.json`. Operational generation failures are logged without influencing
the existing pipeline. `verificationContractShadow=false` is a programmatic
regression seam, not a new routing or verification policy.

## Reproducible evaluation

```zsh
cd /Users/madsflyvholm/Desktop/Koda.ai
pnpm eval:verification-contract --dataset benchmarks/verification-contract/development.jsonl --output /tmp/koda-contract-dev.json
pnpm eval:verification-contract --dataset benchmarks/verification-contract/holdout.jsonl --output /tmp/koda-contract-holdout.json
```

An external JSON array or JSONL dataset works without source changes:

```zsh
pnpm eval:verification-contract --dataset /absolute/path/unseen.jsonl --output /tmp/koda-contract-unseen.json
```

Datasets contain executable code and commands. Use trusted benchmark files.
Fixtures contain task/language/category, stable requirements, planning gold,
project checks, requirement-bound proof metadata, independent proof files,
base files and GOOD/BAD candidate file changes. `null` deletes a candidate file.
Absolute/escaping paths and candidate overwrites of independent proof files are
rejected. Duplicate IDs, incomplete gold and unknown proof requirements fail
validation. See the committed datasets for complete examples.

Planning eval measures exact method-set accuracy, strength/risk confusion
matrices, accuracy and macro-F1. Generation-only p50/p95 overhead excludes file
materialization and check execution.

Discrimination uses the existing `verify()` executor on isolated temporary
repositories. Every candidate executes actual project and independent proof
checks. GOOD/BAD labels are used only to measure results, never to decide them.
Fixtures use dependency-free Node behavior tests and Node syntax health checks.
The test-writing fixture executes candidate-owned tests against both the real
module and an in-memory mutant; deleting, skipping or omitting assertions fails.
Its nested runner clears inherited `NODE_TEST_CONTEXT` so the child emits its
own authoritative TAP output. No provider or paid semantic call is involved.

The eval observation is ACCEPT only after existing verification passes, every
requirement has executed independent adequate proof and the plan is not weak.
Behavioral failures are REJECT. Infrastructure failures or absent/weak proof are
UNRESOLVED. This eval observation is never consumed by production acceptance.
Results include raw verifier status and check output: project health may say
VERIFIED_SUCCESS while the requirement observation remains UNRESOLVED.

Metrics use all GOOD/BAD candidates as denominators. UNRESOLVED is neither a
false accept nor a false reject; unresolved counts are shown so low acceptance
coverage cannot be hidden. Results are also stratified by strength and category.
Critical false accepts cover benchmark-declared critical behavior and detected
security/concurrency/integrity/destructive requirements.

## Measured results

- Development: 15 tasks, 60 candidates. Planning method-set, strength and risk
  accuracy 100%. GOOD accept 86.7%, BAD reject 86.7%, false accept 0%, false
  reject 0%, critical false accepts 0. Two GOOD and six BAD remain unresolved.
- Holdout: 12 separate tasks, 47 candidates. Planning method-set, strength and
  risk accuracy 100%. GOOD accept 91.7%, BAD reject 94.3%, false accept 0%, false
  reject 0%, critical false accepts 0. One GOOD and two BAD remain unresolved.
- Strong/medium candidates: GOOD accept and BAD reject 100% on both sets.
  Weak candidates remain unresolved. All 45 development and 35 holdout BAD
  candidates pass their syntax health check; behavioral proof rejects all BAD
  candidates with adequate executable proof.

Overall 95% acceptance and 98% rejection targets are **not achieved** because
subjective/architectural-quality proof is unavailable. The safe result is to
report that gap, not substitute project-health PASS or synthetic reviewer labels.

## Limits and unchanged behavior

These small synthetic fixtures are not production-accuracy evidence. Frontend
proof covers rendered markup behavior, not a browser's CSS cascade, screenshots
or design quality. Concurrency fixtures test deterministic event-loop races, not
distributed or load-dependent races. Proof metadata and independent assertions
are trusted dataset evidence; V1 does not automatically establish test coverage
or generate tests. Method mapping is deterministic and cannot interpret every
requirement paraphrase. Semantic/visual/manual methods are proposed but not
executed by this offline harness; weak cases stay unresolved.

Routing, model selection, execution plans, write scopes, quality gates, budgets,
completion review, recovery and escalation remain unchanged. Regression tests
compare real fake-provider runs with contract reporting off/on, including provider
payloads (excluding only the run-specific session ID), scope and check outcomes.

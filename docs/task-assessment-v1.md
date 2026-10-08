# Task Assessment V1

V1 is a **shadow assessment**, not a routing policy. It collects existing task,
repository, localization, baseline and optional semantic evidence into one
validated `TaskAssessmentV1`. `src/run.ts` logs `task_assessment` and includes it
in `summary.json`. The original task is retained. Assessment errors are logged
as operational failures and do not block the existing pipeline.

## Architecture

- `src/router/taskAssessment.ts`: pure assessment and semantic merge. Dimensions
  are implementation complexity, localization difficulty, scope, consequence
  risk and verification strength. Separate flags describe security, concurrency,
  database, public API, configuration, architecture and destructive changes.
  Artifact requirements describe new files and tests. Evidence records its
  dimension and provenance; dimension confidence and overall confidence are
  recorded, together with disagreements and `semanticRecommended`.
- Existing TaskSpec and localized paths feed the assessment. Quoted labels alone
  do not establish security or concurrency requirements. Unresolved security
  vocabulary lowers confidence rather than claiming a concrete security change.
- Existing semantic assessment is reused when available. No additional provider
  call is made by production shadow assessment. Grounded scope and literal-edit
  evidence take precedence over conflicting semantic guesses. An optional
  security-specific semantic resolution is available in the existing interpreter
  when explicit assessment context is provided by the eval flow. Other risk
  flags retain deterministic evidence.
- Generic lint, build and typecheck outcomes are project-health evidence, not
  strong behavioral verification. Related tests or structural evidence provide
  medium verification strength; task-specific targeted checks or grounded exact
  literal requirements can provide strong strength. This label describes the
  available verification evidence, **not** final verification PASS.
- `src/router/taskAssessmentEvaluation.ts` validates fixtures, computes metrics
  and optionally joins real outcomes. `src/dev/taskAssessmentEval.ts` provides
  the CLI. No classifier depends on dataset IDs or benchmark solutions.

Shadow assessment never changes model selection, execution strategy, write
scope, budgets, quality thresholds, recovery, escalation or final verification.
An integration regression runs the real fake-provider pipeline with shadow
assessment enabled and disabled and compares model requests, scope and status.

## Deterministic evaluation (no provider calls)

```zsh
cd /Users/madsflyvholm/Desktop/Koda.ai
pnpm eval:task-assessment --dataset benchmarks/task-assessment/development.jsonl --output /tmp/task-assessment-development.json
pnpm eval:task-assessment --dataset benchmarks/task-assessment/holdout.jsonl --output /tmp/task-assessment-holdout.json
pnpm eval:task-assessment --dataset benchmarks/task-assessment/security-holdout.jsonl --output /tmp/task-assessment-security.json
```

Evaluate an unseen dataset without changing code:

```zsh
pnpm eval:task-assessment --dataset /absolute/path/unseen.jsonl --output /tmp/task-assessment-unseen.json
```

Input accepts a JSON array or JSONL. See the committed datasets for complete
examples. Each case requires `id`, `task`, `language` (`en`/`da`), `category`,
`tags`, `facts` and `expected`. Facts include files, resolved paths, related tests,
components, localization confidence and checks. Expected labels cover all five
dimensions, all seven risk flags and both artifact requirements. Duplicate IDs
and invalid labels are rejected. Gold labels are fixtures, not generated from
the assessor's predictions.

Optional semantic evaluation reuses the existing interpreter, bounded repository
metadata and provider transport. It requires an existing config with
`semanticRouter.enabled=true`, and may cost money:

```zsh
pnpm eval:task-assessment --dataset /absolute/path/unseen.jsonl --semantic --config /absolute/path/koda.toml --budget-usd 0.10 --output /tmp/task-assessment-semantic.json
```

Oversized semantic tasks are reported without silently truncating the original.
Malformed or unavailable semantic output retains the deterministic assessment
and appears in `semanticFailures`. Low confidence does not automatically trigger
a production semantic call in this phase.

## Metrics and real outcomes

Reports contain accuracy, confusion matrices and macro-F1 per field; ordinal
fields also contain within-one-category accuracy and mean absolute error. Binary
fields contain precision, recall and false-negative counts. Undefined precision
or recall is `null`, not perfect performance. Macro-F1 uses labels present in
gold or predictions; `macroF1Labels` records that set.

Metrics are stratified by language, category, small/broader scope,
deterministic/semantic mode and confidence. Overall confidence below 0.7 is
reported as uncertain, with case IDs and confidence values.

To join actual observations, add `--outcomes /absolute/path/outcomes.jsonl`.
Each observation requires `taskId`, `model`, `costUsd`, `wallClockMs` and exactly
one true label: `verifiedSuccess`, `modelFailure`, or `censored`; `failureReason`
is optional. Use genuine run results, not synthetic success labels. Known
operational failures (provider, timeout, infrastructure, scope, environment,
dependency and discovery failures) are censored rather than model-quality
failures. Predictive-validity groups report success rate among attributable
outcomes plus censored counts, cost and time; unmatched task IDs are reported.
No real-outcome claims are made by the supplied synthetic assessment fixtures.

## Initial results (before security evidence improvement)

Development: 32 cases, all field accuracies and macro-F1 scores 1.0.
Holdout: 22 separate cases. Complexity accuracy 0.955, macro-F1 0.971;
consequence-risk accuracy 0.955, macro-F1 0.955; security accuracy 0.955,
precision 1.0, recall 0.5, one false negative. Other field accuracies and macro-F1
are 1.0. Complexity within-one accuracy is 1.0 (MAE 0.045); consequence risk
within-one accuracy is 0.955 (MAE 0.091). Three holdout cases are uncertain.

## Security evidence improvement

The original security miss was caused by isolated phrase matching: a validation
action, an authenticity boundary and a shared secret were not combined into
proof. The merge could not resolve the security flag independently of generic
consequence risk. The debugging miss came from defaulting to low complexity
without accounting for investigation and unresolved localization.

`src/router/securityEvidence.ts` now collects clause-level implementation actions
and security boundaries independently. Authentication/authorization, roles,
permissions, credentials, signatures, authenticity/integrity, sessions and
password handling are boundary families. Intrinsic cryptographic requirements
provide strong evidence. Vocabulary alone creates a candidate, not proof.
Documentation, copy, symbol renames and preserved behavior suppress proof in
their own clause, without suppressing another clause's security requirement.
Localized auth/security paths corroborate an unresolved behavioral change;
paths alone never establish a security mutation.

`securityAssessment` records candidate, resolution (`security`, `non_security`,
`unresolved`) and confidence. Unresolved candidates lower consequence confidence
and recommend semantics. The existing interpreter's optional shadow-context
question returns a validated security resolution. Confidence at least 0.8 and
an unresolved candidate are required to accept it. Semantics cannot override
concrete security behavior or concrete copy/documentation evidence. Conflicts
and accepted/rejected semantic evidence remain inspectable. Generic semantic
consequence risk cannot set the security flag. Production interpreter requests
and routing outputs remain unchanged unless explicit assessment context is
supplied; production does not supply that context or make an extra model call.

Debugging with an unresolved target and investigation intent now has medium
complexity. Grounded local fixes remain low despite dramatic wording.

## Updated measured results and limits

- Expanded development: 62 cases. Security precision/recall 1.0, FP=0, FN=0.
  Complexity accuracy 61/62 (0.984), macro-F1 0.981; other fields 1.0.
- Existing holdout: 22 cases, all field accuracies and macro-F1 scores 1.0.
  The previously missed security and debugging cases now classify correctly.
- Separate security holdout: 36 cases, 24 positives and 12 negatives in English
  and Danish. Security precision/recall 1.0, FP=0, FN=0; all field accuracies 1.0.
  This set covers security behavior and adversarial presentation/documentation
  tasks. Labels were written before running the resolver. One config label was
  corrected after inspection: rotating a secret in deployment configuration is
  also a config change. Its security label was never changed.
- Original development labels are retained, including `dev-unknown`: its gold
  complexity is low, while the improved investigation rule predicts medium for
  an unresolved disappearing-invoices bug. This is an explicit disagreement,
  not a hidden perfect-score claim. Six new debugging cases and the old ambiguous
  debugging holdout classify as expected.

These remain small manually labeled synthetic datasets, not production-accuracy
proof. Clause patterns cannot understand every paraphrase, negation or mixed
presentation/security requirement. Overall confidence may still be low because
task-specific verification is weak even when security confidence is high.
Provided behavioral evidence must be trustworthy; assessment does not execute
or prove checks. Semantic merge and decision parsing are tested deterministically;
no paid semantic evaluation was run. Routing must remain shadow-only until
broader independent evaluation supports consuming these signals.

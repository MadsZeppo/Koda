We have frozen for now:

- Task Assessment V1
- Verification Contract V1
- Failure Attribution V1

The next phase is **Routing V1**.

Do NOT replace Koda's routing architecture from scratch.

Koda already has:

- model-pool routing
- execution plans
- `PoolRouter.selectExecutionPlan`
- `optimizeSpecialists`
- `selectJointExecutionPlan`
- quality/cost/latency estimates
- recovery plans
- frozen execution policy
- task fingerprint/history

Build Routing V1 on top of these existing mechanisms.

# Product objective

Koda must choose:

> The lowest-cost / lowest-latency execution plan that is expected to preserve approximately frontier-level VERIFIED final quality for the specific task.

NOT:

> choose the cheapest model.

NOT:

> always choose the strongest model.

NOT:

> use fixed Cheap → Luna → Sol tiers.

The router must support the broad OpenRouter model pool, including models from OpenAI, Anthropic, Google, DeepSeek, xAI, Qwen, Mistral and future compatible models without hardcoded vendor-specific routing branches.

---

# Core routing rule

Quality is a constraint.

Cost and latency are optimization objectives only AFTER quality is acceptable.

Conceptually:

```text
task
↓
Task Assessment V1
↓
Verification Contract V1
↓
compatible model pool
↓
predict task-specific quality per model
↓
identify strongest relevant reference quality
↓
generate eligible execution plans
↓
reject plans whose predicted FINAL quality is too far below reference
↓
among remaining plans:
optimize expected cost per verified completion + latency
```

Do not optimize first-attempt cost in isolation.

Optimize the full execution plan.

---

# 1. Activate the new signals for shadow Routing V1

Routing V1 must consume the canonical outputs from:

## Task Assessment V1

Use relevant dimensions such as:

- task family
- complexity
- consequence risk
- security
- architecture
- localization confidence
- expected change size
- repo/framework evidence

Do not duplicate the old lexical task classifier inside Routing V1.

## Verification Contract V1

Use:

- overall verification strength
- requirement-level strength
- false accept risk
- available proof
- weak/unresolved requirements

This is essential.

A cheap model may be safe to try when:

```text
strong verification
low false-accept risk
bounded scope
safe rescue
```

But weakly verifiable work must require much stronger quality evidence.

Example:

```text
"Return 401 on invalid signature"
```

with strong deterministic verification may allow economical exploration.

But:

```text
"Make this dashboard visually excellent and premium"
```

must NOT route to the cheapest model simply because it compiles.

Weak visual/semantic verification means the quality gate becomes STRICTER.

---

# 2. No fixed model tiers

Do NOT implement:

```text
cheap
luna
sol
```

as the routing architecture.

Models should be evaluated individually.

Conceptually estimate:

```text
P(success | model, task features, execution strategy)
```

for all compatible shortlisted models.

The router should be able to produce plans like:

```text
Qwen → Claude
DeepSeek → Gemini
Grok → Claude
Gemini alone
Claude → OpenAI
Qwen alone
```

depending on evidence.

No vendor gets privileged hardcoded behavior.

---

# 3. Dynamic model registry

Build or extend the existing model registry so the router works with the OpenRouter catalog/configured model pool.

Each model should expose normalized metadata where available:

```text
model id
provider/family
input price
output price
context capacity
output capacity
tool support
structured/tool compatibility
known operational reliability
latency evidence
coding benchmark evidence
Koda local evidence
```

Capability filtering happens BEFORE quality ranking.

Do not attempt to route to models that cannot satisfy the required tool/context/output constraints.

Do not benchmark or score every OpenRouter model on every run.

Use a bounded shortlist after compatibility and quality/cost prefiltering.

Target something like 5–10 serious candidates per task, configurable rather than hardcoded.

---

# 4. Cold start is a first-class requirement

Routing V1 must work well with ZERO local Koda history.

This is mandatory.

A model with no Koda history must NOT become unusable merely because uncertainty is high.

Implement hierarchical cold-start priors.

Conceptually:

```text
global coding evidence
↓
model-family evidence
↓
model × task-family evidence
↓
model × task-family × complexity evidence
↓
local Koda outcomes
```

Use shrinkage/backoff when granular evidence is sparse.

Example:

If there are only 2 observations for:

```text
model X × React UI × medium
```

do not pretend the estimate is precise.

Back off toward broader model/UI/model-family evidence.

---

# 5. Cold-start priors must come from evidence

Do NOT invent quality probabilities manually.

Create a benchmark/evidence format capable of storing task-specific evidence.

At minimum distinguish:

```text
small localized edit
bug fixing/debugging
backend/API
security-sensitive behavior
frontend functional work
frontend visual/UI work
refactor
multi-file change
architecture
tests-only
config/tooling
```

Reuse Task Assessment dimensions where possible rather than creating an unrelated taxonomy.

Cold-start priors should primarily come from Koda-controlled model evals.

External/general benchmark scores may be supported as weaker evidence, but they must not dominate Koda's own coding-task evidence.

Record provenance for every prior.

---

# 6. Uncertainty must NOT automatically block economical first attempts

This is a core change.

The router currently uses conservative quality estimates.

Keep uncertainty.

But distinguish:

```text
first-attempt eligibility
```

from:

```text
final execution-plan quality
```

A cheap/less-proven model may be allowed first when:

```text
verification is strong
false-accept risk is low
task risk is low
scope/localization is safe
a proven rescue exists
```

even when the model's lower confidence bound alone would not pass frontier-quality gating.

The FINAL execution plan must still satisfy the required quality threshold.

This enables safe exploration without weakening final quality.

---

# 7. Frontier-relative quality

For each task, identify the strongest relevant reference model/plan from the compatible pool.

Conceptually:

```text
referenceQuality = max credible predicted quality
```

Then calculate allowed quality regret.

Do NOT use one universal regret.

Make it task-aware.

Examples:

## Tight regret

Use tighter quality regret for:

```text
weak verification
subjective visual/UI work
architecture
public API
schema/data integrity
high consequence risk
security
poor recovery detectability
```

## More permissive first-attempt exploration

Allow more exploration for:

```text
strong deterministic verification
low risk
localized scope
high recovery detectability
safe rescue
```

Important:

A permissive first attempt must NOT imply permissive final quality.

---

# 8. UI must preserve quality

Explicitly test this.

For visual/UI tasks, Routing V1 must not systematically choose cheap weak models because:

```text
lint passes
typecheck passes
build passes
```

Those checks do not establish visual quality.

Example:

```text
Reference model predicted visual-task quality: 0.96

Model A:
0.95
$0.08
eligible

Model B:
0.84
$0.01
not eligible
```

Koda should choose Model A, not B.

Do not hardcode a specific model for UI.

Let task-specific evidence determine which models are good at UI.

---

# 9. Failure Attribution becomes the quality-learning gate

Integrate Failure Attribution V1 into model-quality history.

This is critical.

For completed real attempts:

```text
VERIFIED_SUCCESS
→ positive quality evidence
```

For:

```text
MODEL_FAILURE
+
learningDisposition = NEGATIVE_MODEL_EVIDENCE
```

→ negative quality evidence.

For:

```text
PROVIDER_FAILURE
SCOPE_FAILURE
CONTEXT_FAILURE
VERIFICATION_INFRA_FAILURE
REPO_BASELINE_FAILURE
KODA_INTERNAL_FAILURE
UNKNOWN
```

→ CENSORED.

They must NOT reduce model-quality estimates.

Operational reliability may continue to be tracked separately.

Do not merge provider reliability with coding quality.

Add regression tests proving this.

---

# 10. Preserve existing recovery architecture

Do not create unlimited cascades.

For Routing V1, retaining:

```text
initial model
+
one quality rescue
+
optional operational peer
```

is acceptable and preferable if it keeps execution bounded.

But model choice must be dynamic.

Example plans may be:

```text
Qwen → Claude
DeepSeek → Gemini
Claude alone
Grok → OpenAI
```

The optimizer should estimate:

```text
initial success probability
conditional rescue success probability
expected total cost
expected total latency
conservative final success
```

Do not assume rescue success is independent of the first failure.

Use conditional evidence when available.

Back off conservatively when it is not.

---

# 11. Optimize expected total work

For eligible plans calculate at minimum:

```text
expected total model cost
expected total latency
expected cost per verified completion
conservative final success probability
```

Conceptually:

```text
expectedCost =
initialCost
+
P(initialFailure) * rescueCost
```

but use the existing richer optimizer where appropriate.

A $0.01 model that fails 60% of the time and triggers a slow frontier rescue may be WORSE than a $0.06 model that usually succeeds immediately.

Routing must understand this.

---

# 12. Latency is a first-class objective

Koda should have a realistic path to being faster than heavyweight coding agents.

Track total routing-relevant latency, not only model token speed.

Prefer fast plans when final quality is effectively equivalent.

For eligible plans within negligible expected-quality difference, prefer:

```text
lower expected wall-clock
lower expected cost
fewer model attempts
```

Do not sacrifice meaningful quality merely for latency.

---

# 13. Avoid unnecessary expensive stages

Use Task Assessment to help preserve/extend fast execution paths.

For simple, confidently localized tasks:

```text
no planner
minimal context
one coding attempt
targeted verification
completion
```

Do not invoke expensive planner/exploration stages when evidence says they are unnecessary.

For complex tasks, retain planned/stable paths.

Measure the cost and latency of:

```text
exploration
planning
coding
verification
review
recovery
```

separately.

This is necessary to learn whether Koda can actually beat alternatives on wall-clock time.

---

# 14. Routing V1 must start in SHADOW mode

Do not immediately replace production routing.

During normal runs:

```text
CURRENT ROUTER
→ controls the actual run

ROUTING V1
→ independently records what it would have selected
```

Store a structured event such as:

```text
routing_v1_shadow_decision
```

including:

```text
task features used
verification features used
candidate shortlist
predicted quality per candidate
uncertainty
reference model
reference quality
allowed regret
rejected candidates and reasons
candidate plans
expected cost
expected latency
predicted final quality
selected shadow plan
```

This must be inspectable.

---

# 15. Build a real routing evaluation harness

This phase is NOT complete just because unit tests pass.

Create:

```bash
pnpm eval:routing-v1 ...
```

The evaluation must support TWO modes.

## A. Offline routing evaluation

Given a matrix of known model outcomes for benchmark tasks:

```text
task × model → success/failure/cost/latency
```

simulate Routing V1 without leaking the task's result into the routing decision.

Compare selected plan against baselines.

## B. Live model benchmark collection

Provide a controlled command that can run selected configured/OpenRouter models on a reproducible coding benchmark and store:

```text
task
model
attempt
outcome
Failure Attribution result
verification result
cost
token usage
wall-clock
```

Do not automatically run an unlimited expensive matrix.

Support explicit budgets and bounded model/task selection.

---

# 16. Cold-start benchmark

This is mandatory.

Run evaluation with:

```text
local Koda model history = EMPTY
```

The router may use only allowed cold-start evidence.

Compare:

```text
Always strongest relevant model
Always cheapest compatible model
Current Koda router
Routing V1 cold start
Offline oracle
```

If feasible, also support a simple generic benchmark-prior baseline.

Measure:

```text
verified solve rate
critical false accepts
cost per verified solve
wall-clock per verified solve
frontier/reference call rate
number of attempts
quality regret vs strongest
routing regret vs oracle
```

---

# 17. Evaluate per task family

Overall averages can hide bad routing.

Report metrics separately for at least:

```text
small/localized
backend/API
debugging
security
frontend functional
frontend visual/UI
refactor
architecture
multi-file
```

Especially inspect:

```text
frontend visual/UI
security
architecture
```

Koda must not save money by destroying quality on these categories.

---

# 18. Calibration evaluation

Quality predictions must be calibrated.

Bucket predictions, e.g.:

```text
0.70–0.80
0.80–0.90
0.90–0.95
0.95–1.00
```

Compare predicted success with observed verified success.

Report:

```text
Brier score
calibration error
predicted vs observed by bucket
```

A router cannot make good economic decisions if its probabilities are meaningless.

---

# 19. Counterfactual/oracle evaluation

Because the benchmark runs multiple models on the same task, calculate an offline oracle:

```text
cheapest model/plan that actually solved each task
```

Do NOT use oracle information for routing.

Only use it afterwards to calculate routing regret.

Report:

```text
cost regret vs oracle
latency regret vs oracle
unnecessary frontier calls
failed cheap trials
```

---

# 20. Exploration policy for unseen models

An unseen model must be able to earn evidence.

But exploration must be safe.

Allow bounded exploration only where:

```text
verification strong
false-accept risk low
risk low
scope controlled
rescue available
budget available
```

Never explore a poorly evidenced model merely because it is cheap on:

```text
weakly verified UI
security-critical work
high-impact architecture
destructive/data-integrity work
```

Record exploration separately from exploitation.

---

# 21. Model retirement and new models

Routing V1 must tolerate OpenRouter catalog changes.

New model:

```text
use hierarchical cold-start prior
high uncertainty
bounded exploration
```

Old/unavailable model:

```text
remove from executable candidate set
preserve historical evidence
```

Do not require source-code edits for every new model.

---

# 22. Do not benchmark-hack

Hard invariants:

- no task IDs in routing rules
- no benchmark-specific model choices
- no model-name special casing for expected benchmark winners
- no weakening verification
- no reading held-out outcomes during routing
- no using candidate result data to choose that same candidate
- no marking unresolved subjective work as verified just to improve metrics

---

# 23. Development and holdout

Create separate routing datasets.

Do not tune against holdout results and call them unseen.

Support arbitrary compatible datasets:

```bash
pnpm eval:routing-v1 --dataset <path>
```

---

# 24. Success criteria

Do not force metrics to pass dishonestly.

But Routing V1 should aim for:

```text
critical false accepts = 0

verified solve rate statistically close to strongest baseline

substantially lower cost per verified solve than always-strongest

lower or competitive wall-clock latency

no severe quality collapse in UI/security/architecture

cold-start behavior materially better than current routing

MODEL_FAILURE learning only from Failure Attribution-approved evidence
```

For tasks where Routing V1 cannot confidently preserve quality:

```text
choose the stronger plan
```

Quality outranks savings.

---

# 25. Tests

Add focused tests for:

1. zero-history cold start
2. new unseen model
3. hierarchical prior backoff
4. model-specific task-family performance
5. UI weak-verification quality gating
6. strong-verification economical exploration
7. high-risk task rejects cheap low-confidence model
8. Failure Attribution censorship
9. positive VERIFIED_SUCCESS learning
10. model failure negative learning
11. provider failure does not hurt coding quality
12. scope/context failure does not hurt coding quality
13. capability filtering
14. cost-per-verified-completion ranking
15. latency tie-breaking
16. conditional rescue probability
17. reference-quality calculation
18. quality regret
19. shadow mode does not alter actual route
20. no-history vs learned-history transition
21. dynamic model addition/removal
22. calibration report calculations

---

# 26. Validation

Run:

```text
focused routing tests
cold-start development eval
cold-start holdout eval
learned-history eval
UI-specific eval
security/high-risk eval
full test suite
typecheck
build
format/lint where available
```

Do not stop after implementation.

Actually evaluate the router.

---

# 27. IMPORTANT: Do not activate production routing yet

At the end of this task:

```text
Routing V1 = shadow
Current routing = production
```

We will activate Routing V1 only after reviewing the benchmark results.

---

# Final response

Report only:

1. architecture implemented
2. files changed
3. how cold-start priors work
4. how Task Assessment V1 is consumed
5. how Verification Contract V1 changes routing strictness
6. how Failure Attribution V1 controls learning
7. how models are dynamically shortlisted
8. how reference quality / allowed regret works
9. development cold-start results
10. holdout cold-start results
11. per-category results, especially UI/security/architecture
12. strongest-baseline comparison
13. current-Koda comparison
14. offline-oracle regret
15. cost per verified solve
16. wall-clock per verified solve
17. verified solve rate
18. critical false accepts
19. frontier/reference model call rate
20. calibration metrics
21. routing overhead p50/p95
22. tests/typecheck/build
23. known weaknesses
24. confirmation that production routing is still unchanged
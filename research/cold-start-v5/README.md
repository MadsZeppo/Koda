# Cold Start V5 — fixed LLM routing judge

Research-only experiment: asks one fixed reasoning judge to select the cheapest model expected to remain near a TRAIN-selected frontier. It never executes the coding models, changes production or reads production history.

Pilot result: **STOP — 10/10 tasks chose Sonnet, $0.384962 judge cost, 44.5% higher cost/solve than V4/frontier.** See [RESULTS.md](RESULTS.md). Full evaluation was not run.

## Frozen design

Judge: `openai/gpt-5-2025-08-07`, reasoning medium, seed 20261007, maximum 4096 completion tokens inclusive of reasoning; temperature omitted because this model does not advertise support. This is GPT-5-medium from the existing six-model pool, not an extra coding candidate. Requested dated model ID, returned model/provider, response ID and all usage receipts are recorded. Catalog identifies GPT-5 canonical slug as this dated release; upstream aliases may be reported in responses.

The only six candidates are the V2/V3/V4 canonical identities. A compact profile uses 300 SWE TRAIN outcomes, TRAIN-average costs, supported TRAIN feature-bucket rates and frozen public model catalog descriptions/capabilities/prices. No VALIDATION or FINAL outcomes contribute to profiles. Current public catalog facts are available at routing time; historical coding costs come from the unchanged paired public snapshot. This is not a rerun at today's coding prices.

Task input contains the entire official problem statement, the unchanged V3 deterministic pre-execution fingerprint, repository name/version and explicit unavailable-signal markers. It excludes task IDs, gold patches, test patches, actual model outcomes, evaluator results and hidden solutions. No repo checkout or coding model call occurs. Input is capped at 40,000 serialized UTF8 bytes with no silent task truncation. Profiles have compact supported buckets and bounded descriptions, not raw benchmark dumps.

A strict provider JSON schema requires the six-model ranking, expected frontier gaps in percentage points, confidence and a short reason. Local validation additionally rejects duplicates, non-finite numbers, inconsistent ranking, nonzero frontier gap and selection that is not cheapest eligible. Malformed output is an infrastructure/protocol STOP, not a fabricated coding-quality result. There are no automatic paid retries or prompt repairs.

One ranking per task is returned with selected_model at 3pp. The other 0/1/2pp policies select deterministically from the **same judge estimates** and TRAIN costs. This measures a common quality/cost frontier without fourfold judge calls. The full judge cost is charged to each hypothetical policy, not divided by four. Confidence is confidence in gap estimation, not P(success).

The same 100 SWE FINAL tasks and exact receipts/outcomes as V4 are used. This public holdout was previously inspected; it is a retrospective comparison, not a fresh prospective holdout. Judge pretraining familiarity with public SWE issues cannot be excluded. The supplied packets contain no solution or current-task model outcome, and the prompt instructs the judge not to recall answers.

## Pilot and immutable gate

Ten tasks are selected before outcomes by seeded round-robin repositories and seeded issue-text hashes within repositories. Two tasks are independently judged again with the same settings. All four derived model selections must match on repeats. Output must be valid and stable.

The predeclared primary pilot point is 3pp. Continue only if it chooses a cheaper model on at least two tasks, identifies at least one successful cheap attempt, retains at least 97% of frontier solve count and yields strictly lower **total cost/solve including every judge call and stability repeat**. Frontier must solve at least one task; otherwise evidence is inconclusive and full evaluation stops. No best-point selection or prompt tuning after seeing pilot outcomes.

The estimate is computed before any inference: pilot up to $0.7355 for 12 calls; full up to $6.0668 for 102 calls including the pilot/repeats. It uses full serialized UTF8 byte token bounds plus 2048 tokens for message/schema serialization, reserved maximum completion output and provider price caps ($1.25/M input, $10/M output). It is an admission estimate under documented provider caps, not a promised provider billing guarantee. Pilot budget cap $1, full including pilot cap $9. Missing receipts retain reservations and STOP; actual receipts replace reservations.

Full evaluation reuses the ten cached pilot decisions and receipts, and makes only 90 new calls. Pilot output, prompts, raw provider responses, actual cost/token details and the immutable manifest remain inspectable. Protocol, source code, profiles and packet fingerprints prevent changes between preparation and dispatch.

## Transport and economics

`src/request.ts` reuses Koda's existing shared `providerTransport` in backend mode. Python strips local OpenRouter/OpenAI/Codex keys and forces backend mode in the judge subprocess. Only the fixed dated judge model may be called. The real server-side key is not read, copied or logged. The local backend endpoint is configured with `KODA_API_URL`.

Actual provider `usage.cost` is required; there is no fabricated dollar estimate in scoring. Reasoning is included in completion-token accounting and actual receipt cost. Error status/timeout/429/5xx/malformed responses remain operational. Budget reservations are retained when billing cannot be established. Raw response files may contain task content but do not contain credentials.

Metrics use the same exact tasks for frontier, V3, V4, each judge-gap policy and cheapest-successful oracle. Judge cost is added to total coding receipts before division by solved tasks. Frontier-retained is solve-count ratio and can exceed 100%; harmful downgrade separately counts frontier-pass/candidate-fail events. Gap calibration compares predicted signed expected solve-probability differences with observed signed binary differences, in aggregate bins; one task cannot reveal its true success probability.

## Commands

From the repository root with Node 22 and the existing V3 Python environment:

```sh
nvm use 22
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 research/cold-start-v3/.venv/bin/python -m unittest discover -s research/cold-start-v5/tests -v
```

Preparation makes no paid calls. Supply a current saved OpenRouter public `/models` response, not new coding outcomes:

```sh
research/cold-start-v3/.venv/bin/python research/cold-start-v5/src/experiment.py prepare \
  --catalog /path/to/public-models.json --output /tmp/koda-v5-run
```

Explicit paid pilot:

```sh
KODA_API_URL=http://127.0.0.1:8787 OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 \
research/cold-start-v3/.venv/bin/python research/cold-start-v5/src/experiment.py pilot \
  --output /tmp/koda-v5-run --execute
```

Only if `pilot/gate.json` permits continuation:

```sh
KODA_API_URL=http://127.0.0.1:8787 OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 \
research/cold-start-v3/.venv/bin/python research/cold-start-v5/src/experiment.py full \
  --output /tmp/koda-v5-run --execute
```

New directories and phase claims prevent accidental repeated paid runs. This is a single frozen experiment, not production routing or a new benchmark framework. Source, tests, reports and all artifacts are under this V5 directory. V2/V3/V4, package scripts and production files remain unchanged.

## Sources

- [GPT-5 pricing/model information](https://openrouter.ai/openai/gpt-5/api): current $1.25/M input, $10/M output and structured-output support.
- [Provider-selection price caps](https://github.com/OpenRouterTeam/docs/blob/main/guides/routing/provider-selection.mdx): max_price units are USD per million tokens.
- [Structured output documentation](https://openrouter.ai/docs/guides/features/structured-outputs): compatible model schema enforcement.
- Local source/profile/packet fingerprints and real receipts are stored under `artifacts/run/`.

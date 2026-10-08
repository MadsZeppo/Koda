# Thirty-prompt coding suite

Use Node 22 or newer. Run from the Koda development checkout.

Free scripted-provider suite:

```sh
pnpm smoke:suite:fake --parallel 4 --output /tmp/koda-fake-30
```

Live suite through your running Koda backend (no local OpenRouter key):

```sh
KODA_PROVIDER_MODE=backend KODA_API_URL=http://127.0.0.1:8787 \
pnpm smoke:suite:live --parallel 4 --budget-usd 3 --output /tmp/koda-live-30
```

The live command makes paid model calls. The total Koda budget is divided into
fixed per-task shares (3 USD / 30 tasks = 0.10 USD per task). This is an execution
budget, not an upstream billing guarantee. There is no automatic budget increase.
The backend owns the provider credential; child CLI processes receive no local
OpenRouter key. Live routing history is isolated inside each scenario folder.

Each task gets its own disposable non-Git repository. Both modes use the real
installed CLI entry, routing/handoff, worker, verification, review and `--apply`.
Apply targets only those fixture folders. Neither suite modifies Zeppobridg.
Use a fresh output directory for each run; existing directories are rejected.

Run a subset while diagnosing a shared failure:

```sh
pnpm smoke:suite:fake --only sum,deduplicate,extension --output /tmp/koda-subset
```

Thirty prompts cover creating modules, editing existing modules, source + test
changes, progressive search/read, and varied data processing, encoding and input
validation behaviors. The small Node/CommonJS fixtures require no dependency
installation. Their `typecheck` command is a JavaScript syntax check; this suite
does not measure browser rendering, Next.js builds or TypeScript type semantics.
Use the existing operational-failure/recovery suite as well:

```sh
pnpm smoke:fake
```

Fake responses are scripted inputs, so fake success proves pipeline behavior,
not model coding quality. Live uses the same behavioral tasks and acceptance
checks with actual model responses.

A scenario only passes when the CLI returns VERIFIED_SUCCESS, changes are applied,
a mutation exists, real final test verification passed, independent behavior
assertions against the applied repo pass, and unrelated files are preserved.
Acceptance assertions remain outside the candidate repo and are never part of
the model's writable scope. Every scenario keeps its CLI log, Koda report,
fixture repo and `result.json`, even when it fails. The suite exits nonzero if
any scenario fails. `suite-summary.json` lists status, apply outcome, independent
acceptance failure, wall time, model cost and whether cost accounting is complete.

### Hard suite (30 additional scenarios)

Select `--suite hard` to run thirty longer algorithm/data-processing contracts.
Each explicitly names its argument order and return shape, requires regression
 tests, preserves inputs, and uses an independent acceptance oracle outside the
candidate repository. Five scenarios create files; all change source and tests.
These fixtures assess Node coding behavior, not browser appearance or arbitrary
repository tasks. A fake pass validates the harness, not live model capability.

```sh
pnpm smoke:suite:fake --suite hard --parallel 4 --output "/tmp/koda-hard-fake-$(date +%s)"
KODA_PROVIDER_MODE=backend KODA_API_URL=http://127.0.0.1:8787 \
  pnpm smoke:suite:live --suite hard --parallel 4 --budget-usd 3 \
  --output "/tmp/koda-hard-live-$(date +%s)"
```

Live budget is divided across scenarios. Failures remain in the final report;
the runner continues the other independent scenarios. A spending cap can prevent
a task from completing; distinguish that from implementation failure.

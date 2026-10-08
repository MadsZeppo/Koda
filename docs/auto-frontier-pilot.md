# Five-task Auto vs frontier pilot

Manually paid only. Reuses existing clamp, chunk, median, pagination and safe-json
suite fixtures, independent acceptance assertions, isolated repos and apply checks.
These are utility tasks, not a representative SWE/backend/UI benchmark.

Both arms get the exact same prompt/start files/checks. Auto uses the current
experimental Auto policy. Frontier uses an isolated single-model cold-start pool,
so every coding attempt uses the requested concrete model. Auxiliary review uses
the same configuration on both sides. Production routing is unchanged.

Run with Node 22 and a running funded backend:

```zsh
cd /Users/madsflyvholm/Desktop/Koda.ai
nvm use 22
KODA_PROVIDER_MODE=backend KODA_API_URL=http://127.0.0.1:8787 \
pnpm benchmark:auto-frontier \
  --frontier-model openai/gpt-5.6-sol \
  --budget-usd 5 \
  --output "/tmp/koda-auto-frontier-$(date +%s)"
```

Ten runs, sequentially. Each receives $0.50 of the $5 total cap; unused budgets
are not redistributed. This is a maximum, not an expected charge. A missing or
incompatible model or insufficient reservation may fail before a call.

Reports include models and provider-receipt costs (including reviews/recovery),
wall time, independent acceptance results and cost per verified solve. Missing
receipts remain unknown. Savings are only printed for equal nonzero solve counts
and complete costs. Fixtures and logs live below the output directory; comparison.json
contains machine-readable results. Existing output directories are never overwritten.

Recalculate an existing report without any provider calls:

```zsh
pnpm benchmark:auto-frontier --report-only --output /tmp/koda-auto-frontier-1791376839
```

This writes comparison.md and updates comparison.json. Older Agentic v1 receipts
are accepted only when their per-call costs and tokens reconcile exactly with the
worker's recorded totals. Missing or estimated costs remain unknown. New Agentic
calls retain raw provider usage and explicit provider-reported cost provenance.

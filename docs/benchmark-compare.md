# One-task Koda vs Codex

`pnpm benchmark:compare` runs one manually supplied task. No routing override,
VNext activation, benchmark manifest or model priors are involved.

Prerequisites: Node 22, installed `codex`, existing ChatGPT login (`codex login
status`), and a working Koda backend or explicitly configured normal provider.
The command refuses API-key Codex login. It strips API-key environment variables,
forces ChatGPT authentication and ignores custom Codex provider configuration;
no Codex model is forced. These settings use the installed CLI and the official
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

The command freezes a filesystem copy including dirty/untracked files and local
dependencies, then makes two byte/mode-identical copies. Git internals and `.koda`
run metadata are omitted. Symlinks are dereferenced so dependency writes cannot
change the original. Copy/hash preparation may take time for large dependencies;
it is recorded separately from agent/check time. Output must be a new directory
outside the source repo; its parent must exist.

Codex and normal Koda run sequentially to avoid contention. Koda receives `--apply`
only against its copy, with a default $0.50 inference budget. After both finish,
the identical supplied `/bin/sh -c` check runs in each copy. Check exit status alone
determines pass/fail, including when an agent exits unsuccessfully.

Use a check that actually proves the requested behavior. A generic typecheck or a
test modified by the agent is not an independent proof of a new feature; prefer
a literal external check as below or an immutable external acceptance script.

```zsh
cd /Users/madsflyvholm/Desktop/Koda.ai
nvm use 22

KODA_PROVIDER_MODE=backend KODA_API_URL=http://127.0.0.1:8787 \
pnpm benchmark:compare \
  --repo /Users/madsflyvholm/Desktop/Zeppobridg \
  --task 'Tilføj src/lib/clamp.ts med en navngiven export clamp(value: number, min: number, max: number): number. For min <= max skal den returnere min under intervallet, max over intervallet og value indenfor. Bevar resten af appen.' \
  --check "node --experimental-strip-types --input-type=module -e \"import assert from 'node:assert/strict'; import {clamp} from './src/lib/clamp.ts'; for (const [v,lo,hi] of [[-2,0,10],[12,0,10],[4,0,10],[-5,-10,-2],[0.5,0,1],[4,4,4]]) assert.equal(clamp(v,lo,hi),Math.max(lo,Math.min(v,hi)));\"" \
  --budget-usd 0.50 \
  --output "/tmp/koda-vs-codex-$(date +%s)"
```

Optional: `--config /absolute/path/to/koda.config.json`, `--timeout-ms 600000`.
The normal Koda router remains authoritative; `--budget-usd` is a run budget,
not a new per-request global spending guard.

Results: `comparison.md`, `comparison.json`, `inputs.json`, each arm's `repo/`,
raw stdout/stderr, independent check stdout/stderr and agent exit status. JSON
includes observed Codex usage and all observed Koda models/call receipts.
Codex cost is always `subscription`; no API-equivalent dollar estimate is made.
Koda cost sums reported provider/worker usage receipts, never forecast/reservation
events. Explicit token-price estimates or missing usage produce
`unknown/incomplete`, with known partial receipt cost retained separately.
The original repo remains unchanged. Neither arm is run by deterministic tests.

# Real execution validation preparation

The validation harness reuses realBenchmark version-1 manifests and current
production routing. No model calls are made without an explicit execute flag and budget.

`tools/prepare.py` consumes existing official SWE-bench artifacts, exports repositories
from digest-pinned official images, preserves their commits, copies test patches
into external oracles, and builds isolated Node/agent runtimes alongside historical
Python environments. Test containers have no network access. Provider keys are
never copied into images or passed to execution containers.

Preparation requires a negative control (required regression reproduced,
all required preservation tests passing, no required tests missing) and a positive
control (the official reference patch passes). Reference patches are used only in
disposable external control clones; never in candidate repositories or agent input.

```zsh
python3 benchmarks/execution-validation/tools/prepare.py \
  --manifest benchmarks/execution-validation/tasks.json \
  --artifacts /Users/madsflyvholm/Desktop/koda-bench/swe-bench-tasks \
  --swebench /Users/madsflyvholm/Desktop/SWE-bench \
  --koda "$PWD" --tasks 3 \
  --output "$HOME/.koda/validation-pilot"
```

The three local pilot tasks are prepared. Django's original dataset test mapping
was unrelated to its unmodified official validators test patch. The reviewed local
pilot instead requires the complete validators module: six reproduced regressions
and 365 preservation tests, all 371 passing with the official reference patch.
Original metadata is retained alongside explicit mapping provenance. This is an
adapted independent pilot, not an official SWE-bench score. The two Astropy tasks
retain their official required-test mappings. Frozen official leap-second data
repairs an expired environment dependency without disabling tests or warnings.

Native build artifacts are copied into disposable coding checkouts with tracked
source hashes checked before/after. Git metadata is archived outside native
checkouts so existing filesystem isolation preserves these runtime dependencies.
The actual Koda worker/sandbox imports each project from its isolated checkout.
On ARM Docker hosts, the historical amd64 runtimes use host-native Bubblewrap.
Nested sandbox execution requires SYS_ADMIN/NET_ADMIN and unconfined seccomp/system
paths in the outer container; inner Koda process/filesystem/network isolation remains
active. No privileged container is used.

Preparation logs, oracle metadata, positive controls and proof.json live in the
output directory. The ready tasks.json is written only after all controls pass.
Preflight rejects missing environments and unreproduced regressions before payment.
The checked-in 12-task manifest is Python-only; only the three local pilot tasks
have been prepared and proven ready.

Free worker/sandbox probes:

```zsh
python3 benchmarks/execution-validation/tools/probe_runtimes.py "$HOME/.koda/validation-pilot"
```

Free preflight:

```zsh
pnpm benchmark:validation \
  --manifest "$HOME/.koda/validation-pilot/tasks.json" \
  --tasks 3 --output /tmp/koda-validation-preflight
```

Explicit paid execution (backend must already be running):

```zsh
KODA_PROVIDER_MODE=backend KODA_API_URL=http://127.0.0.1:8787 \
pnpm benchmark:validation \
  --manifest "$HOME/.koda/validation-pilot/tasks.json" \
  --tasks 3 --execute --budget-usd 2.40 \
  --output "/tmp/koda-validation-three-$(date +%s)"
```

Readiness proves the environments/checks work; it does not guarantee model solves.

Aider recovery runtime is also checked inside the actual Koda command sandbox
with `tools/aiderRuntimeProbe.ts`, without provider calls. Managed Python aliases
from pyvenv.cfg must remain readable alongside canonical interpreter roots.

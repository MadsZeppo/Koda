# Aider coding execution

The production path is `router → selected OpenRouter model → AiderExecutor →
isolated candidate → Koda verification`. `codingExecutor.ts` retains the existing
routing, parallel scheduling, recovery and verification. Mini-SWE is not imported
or provisioned by the production path; its old export is a compatibility shim.

Install `aider-chat` in a separate Python environment, outside target repositories:

```sh
python3 -m venv "$HOME/.cache/koda/aider"
"$HOME/.cache/koda/aider/bin/python" -m pip install aider-chat
export KODA_AIDER_PYTHON="$HOME/.cache/koda/aider/bin/python"
```

Alternatively, install the `aider` executable on PATH or set `AIDER_BIN` to its
entry point. Koda discovers and checks the owning interpreter. Missing or
incompatible runtimes return `AIDER_UNAVAILABLE`, without model-quality evidence.
Set `OPENROUTER_API_KEY` in the environment. It is never put in arguments,
request files or telemetry. Captured diagnostics redact it.

## Invocation

For the first attempt, Koda runs this command in a disposable, scope-checked Git
snapshot (paths and numeric values are filled from the attempt):

```sh
<PYTHON> -I <TEMP>/bridge.py <TEMP>/request-0.json \
  --model openrouter/<SELECTED_ID> \
  --weak-model openrouter/<SELECTED_ID> \
  --editor-model openrouter/<SELECTED_ID> \
  --message-file <TEMP>/task.txt \
  --model-metadata-file <TEMP>/metadata.json \
  --config <TEMP>/config.yml \
  --map-tokens <1024..4096> \
  --max-chat-history-tokens <CONTEXT_BOUND> \
  --timeout <REQUEST_TIMEOUT_SECONDS> \
  --chat-history-file <TEMP>/chat.md \
  --input-history-file <TEMP>/history \
  --yes-always --no-auto-commits --no-dirty-commits --no-gitignore \
  --no-pretty --no-stream --no-check-update --no-show-release-notes \
  --no-auto-lint --no-auto-test --no-suggest-shell-commands \
  --no-detect-urls --no-fancy-input --analytics-disable \
  --cache-keepalive-pings 0
```

The thin launcher calls `aider.main.main(args, return_coder=True)` and
`coder.run(with_message=task)`. It keeps Aider's repository map and file discovery.
It moves the map cache and history into temporary storage, disables local/user
configuration and dotenv overrides, and instruments the LiteLLM completion
boundary. This is necessary to enforce Koda's limits before each provider call;
Aider's own displayed cost is not used for enforcement.

`foo/bar` becomes exactly `openrouter/foo/bar`. The prefix is always added to the exact catalog ID, so a catalog ID
`openrouter/future-route` becomes `openrouter/openrouter/future-route`. No model allowlist or provider-specific exception exists. LiteLLM uses
its native OpenRouter provider, with Koda's configured base URL.

## Settings and bounded recovery

Bundled Aider settings for the exact identifier are preserved. Unknown models
receive a temporary `--model-settings-file` with `diff`, repo-map support and
no temperature parameter unless Koda metadata supports it. Context/output limits
and catalog prices are supplied through temporary model metadata. Nothing is
written to the user's repo for configuration.

Without local compatibility evidence, no `--edit-format` override is passed for
a known model. Verified format history can choose `diff` or `whole`. An explicit
malformed-edit failure with no mutation permits one retry: `whole → diff`, or
any other native format (including `diff`) → `whole`. Both attempts share one
USD/token/step/deadline ledger. Plain no-mutation responses and provider failures
do not count as edit-format failures. A partial mutation ends format retries and
returns the candidate for Koda verification.

Weak/editor slots explicitly use the same selected model. Every completion is
checked against that model before dispatch; alternate routes and multiple
completion options are removed. Aider may use the same model for summarization
or native architect editing, but cannot silently invoke a different model.

Koda reserves the attempt budget globally and bounds each completion using
catalog prices, a conservative UTF-8 byte input bound and bounded output tokens.
Known provider token usage releases unused reservation; uncertain calls consume
the reservation. Missing prices stop before a paid call as infrastructure evidence.
This favors budget safety and can reject a request whose actual tokenizer would
have fit a smaller budget.

Git diffs and untracked-file inventory identify actual edits. Koda then performs
its own checks. Exit code zero and Aider prose never establish VERIFIED_SUCCESS.
Failed/incomplete candidates cannot auto-apply. Existing partial mutations are
preserved on provider/runtime failure.

`aider_execution`, `coding_worker_stop` and `aider_attempt_verification` events
record model, actual format, exit status, changed paths, mutation, wall time and
failure category. Persistent operation history joins format results to Koda's
verification. Time to first mutation is an end-of-process upper bound. Provider,
runtime and verification-infrastructure errors do not establish incompatibility.

Tests mock Aider/provider execution; no paid model calls are required. The
launcher depends on Aider's Python API; incompatible installed versions fail the
runtime check or return an operational failure.

References: [Aider options](https://aider.chat/docs/config/options.html),
[model settings](https://aider.chat/docs/config/adv-model-settings.html).

## Files changed for this integration

- Execution: `src/agent/aiderExecutor.ts`, `src/agent/aiderRuntime.ts`,
  `workers/aider/bridge.py`, `src/agent/codingExecutor.ts`,
  `src/agent/miniSweExecutor.ts` (compatibility export),
  `src/agent/codingWorker.ts`, `src/run.ts`.
- Routing and telemetry: `src/router/history.ts`, `src/router/modelRouter.ts`,
  `src/router/routeOptimizer.ts`, `src/router/knowledge/contextual.ts`,
  `src/router/knowledge/efficiency.ts`, `src/router/knowledge/schema.ts`.
- Tests: `tests/aiderExecutor.test.ts`, `workers/aider/test_bridge.py`,
  `tests/discoveryOwnership.test.ts`, `tests/miniSweWorker.test.ts`,
  `tests/executionPlanRouting.test.ts`, `tests/modelRouter.e2e.test.ts`,
  `tests/routingColdStart.test.ts`, `tests/routingKnowledge.test.ts`,
  `tests/routingV2.test.ts`, `tests/specialistRouting.test.ts`,
  `tests/stableMutation.test.ts`.
- Documentation: `README.md`, `docs/aider.md`.

Other pre-existing working-tree edits were preserved.

# Deterministic local coding smoke

Run all scenarios through the real CLI, isolated workspaces, Agentic tools,
verification and completion review:

```sh
pnpm smoke:fake
```

Run one scenario:

```sh
pnpm smoke:fake repair
```

Scenarios: `create`, `edit`, `multi`, `progressive`, `repair`,
`provider-failure`, `malformed-review`, `review-failure`, `token-preflight`,
`regression`. Failure scenarios PASS when Koda rejects the run as expected.
Every run prints its report directory. Original fixture files remain unchanged.
The harness creates temporary repositories; it never uses OpenRouter credits.

For your own repository and response script:

```sh
NODE_ENV=development pnpm agent dev-run \
  --repo /absolute/path/to/repo \
  --task 'Modify src/value.cjs to export value=2' \
  --script /absolute/path/to/responses.json \
  --output /tmp/koda-fake-custom
```

The output must be outside the repository. `dev-run` defaults to preview;
add `--apply` only when you intend to apply verified scripted changes to that
folder. Production or unset `NODE_ENV` rejects it before work.
There is no fake-provider option on normal `agent run` and no fake catalog entry.

Example `responses.json`:

```json
{
  "steps": [
    {"stage":"worker","toolCalls":[{"name":"read_file","arguments":{"path":"src/value.cjs"}}]},
    {"stage":"worker","toolCalls":[{"name":"edit_file","arguments":{"path":"src/value.cjs","oldText":"value=1","newText":"value=2"}}]},
    {"stage":"worker","content":"Implementation complete"},
    {"stage":"review","review":{"passed":true,"evidence":"Requested export is present and focused checks pass"}}
  ]
}
```

Steps are consumed independently by stage (`worker`, `review`, `planner`,
`inspection`). Optional `subtaskId` selects one parallel worker. Tool arguments
are passed to real tools and remain subject to normal write-scope enforcement.
Use `write_file` for new files. Multiple tool calls or worker responses support
multiple mutations. A localized fast path may return before the scripted finish
step; unused steps are listed in the transcript.

Use `content` for arbitrary/malformed text, `json` for planner or inspector JSON,
`error: {"status":503,"message":"Unavailable"}` for provider errors,
`failure: "token_preflight"` for a provider admission rejection, or
`failure: "output_limit"` for a length-limited response.
An explicit failed review requires `missingIds` and concrete `evidence`.
Unscripted requests fail closed; the provider has no upstream forwarding.

The transport binds only to loopback and temporarily replaces the provider key
and model-role environment values inside the dev process. Real routing history,
model catalogs and learned performance are disabled. All events and the summary
are marked `synthetic`. `fake-provider.json` records every local request.

Scripted semantic reviews are test inputs, not real model evaluations. Real
verification still runs: a scripted PASS cannot certify a failing candidate.

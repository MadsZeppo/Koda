# Local Koda provider backend

The normal transport is **CLI → Koda backend → OpenRouter → CLI**. Routing,
model selection, messages, tool protocol, reasoning settings, provider preferences,
budgets and verification remain in Koda. The backend forwards the selected request
without selecting another model. It adds its own upstream authorization and
never forwards client authorization to OpenRouter.

Start the backend in its own terminal, with Node.js 22+ active:

```sh
cd /Users/madsflyvholm/Desktop/Koda.ai
read -rs 'KODA_SERVER_KEY?Paste the COMPLETE backend OpenRouter key: '; echo
OPENROUTER_API_KEY="$KODA_SERVER_KEY" pnpm backend
```

This keeps the key on the backend side and out of shell command history. The
backend requires `OPENROUTER_API_KEY`; it does not read a key from CLI requests.
Startup validates the server credential using OpenRouter's read-only `auth/key`
endpoint, without invoking a model or spending credits. A rejected credential
stops startup with `BACKEND_AUTH_FAILURE`, rather than failing during planning.
Paste the complete key; the public CLI placeholder is never a server credential.
Responses identify the backend transport with `x-koda-provider-transport: backend`.
The `x-koda-error-origin` header distinguishes an upstream rejection from a local
proxy failure. Gateway error telemetry records that origin as `errorOrigin`;
401 remains an operational failure, never model-quality evidence.

It binds to `127.0.0.1:8787` by default. `PORT`, `KODA_BACKEND_HOST` and
`KODA_BACKEND_TIMEOUT_MS` configure the listener and upstream deadline.
For deployment use the server's secret environment configuration, not CLI/package
configuration. There are no login, account or authentication endpoints.

In a separate client terminal:

```sh
unset OPENROUTER_API_KEY
export KODA_PROVIDER_MODE=backend
export KODA_API_URL=http://127.0.0.1:8787
cd ~/Desktop/some-other-project
koda agent run --repo . --task "Fix the failing tests" --apply
```

`backend` is the default mode, and localhost is the default API URL. Replace
`KODA_API_URL` with the deployed backend origin later. The URL may end in `/v1`;
otherwise the client appends `/v1`. Omitting `--apply` previews the candidate.
The previously documented local CLI link still works.

Explicit direct-provider development mode:

```sh
export KODA_PROVIDER_MODE=direct-openrouter
read -s 'OPENROUTER_API_KEY?Local development OpenRouter key: '; echo
export OPENROUTER_API_KEY
koda agent run --repo . --task "Fix the failing tests"
```

Only this opt-in mode reads the local OpenRouter key. In backend mode,
`KODA_API_URL` overrides every legacy `baseUrl` and provider setting. When that
variable is absent, an explicit loopback `baseUrl` can identify a local test/dev
backend; external provider URLs always resolve to the default Koda backend.
OpenHands and Aider use LiteLLM's generic OpenAI-compatible transport to the
backend, preserving the selected model ID in the request body. They do not use
LiteLLM's direct OpenRouter provider inference. Pricing metadata comes from
Koda and LiteLLM's bundled local map, without implicit remote metadata fetches.
Aider's main, weak and editor model arguments and metadata all use
`openai/<routed-model-id>` in backend mode. Its bridge supplies
`OPENAI_API_BASE=<KODA_API_URL>/v1`, `OPENAI_API_KEY=koda-backend-client` and
`KODA_PROVIDER_API_KEY=koda-backend-client`; `OPENROUTER_API_KEY` is unset.
The original routed ID is retained separately for the request body. The bridge
blocks Aider's OpenRouter onboarding/OAuth functions and browser launch functions
before calling Aider's main entry point. It never searches for a local key.
Neither mode bundles a real provider key. The public `koda-backend-client` value
exists only because provider SDKs require a nonempty credential; it grants no
access by itself, and the backend ignores it.

The backend proxies chat completions, model/endpoint metadata, classifications,
benchmarks and semantic decisions. It retains upstream 4xx/5xx statuses and
`Retry-After`, reports upstream timeout as HTTP 504, and rejects malformed successful
responses as HTTP 502 protocol failures. These retain operational failure handling.
SSE streams remain streams. Response bodies and allowed response headers redact
the server key, including keys split across streaming chunks. Credentials and
cookies from upstream response headers are never sent to clients. The backend
does not log request headers or provider credentials.

`KODA_OPENROUTER_URL` is a **server-only** upstream override for local mocks.
Client requests cannot choose an upstream URL. Deterministic tests run without
any paid OpenRouter calls:

```sh
pnpm exec tsx --test tests/backendProxy.test.ts tests/fakeProvider.test.ts
```

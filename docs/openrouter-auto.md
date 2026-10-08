# OpenRouter Auto experiment

Opt in with `koda.auto.example.json`; default configuration remains legacy. No API calls or model-quality claims are made by merely loading the configuration.

## Run

Start your usual Koda backend with its server-side OpenRouter key. No backend code changed for this feature; a running current backend can forward the plugin unchanged. In a second terminal:

```sh
cd /Users/madsflyvholm/Desktop/Koda.ai
nvm use 22
KODA_PROVIDER_MODE=backend KODA_API_URL=http://127.0.0.1:8787 \
pnpm agent run --repo /Users/madsflyvholm/Desktop/Zeppobridg \
  --config /Users/madsflyvholm/Desktop/Koda.ai/koda.auto.example.json \
  --task 'Tilføj src/lib/clamp.ts med en navngiven export clamp(value: number, min: number, max: number): number. For min <= max skal den returnere min under intervallet, max over intervallet og value indenfor. Tilføj relevante tests efter projektets eksisterende testkonvention. Bevar resten af appen.' \
  --budget-usd 1 --output /tmp/koda-auto-smoke
```

This is a paid command with a $1 run budget. Omit `--apply` to inspect the candidate first; append `--apply` to enable the existing verified-only, conflict-safe apply flow. Use a fresh output directory for each comparison. Availability and current endpoint prices remain checked at runtime; unavailable or incompatible reference models stop safely.

The example discovers all models from the existing catalog, with `openai/gpt-5.6-sol` as explicit reference. Omit `routing.openRouterAuto.models` to use open discovery, or supply any number of exact IDs as an optional restriction. Wildcards, virtual router IDs, duplicates and a reference outside an explicit restricted pool are rejected. Concrete candidates must satisfy raw capability, context, output and price bounds. Legacy quality scores are not used for this experiment.

## Execution

The implementation start requests `openrouter/auto` with:

```json
{"plugins":[{"id":"auto-router","allowed_models":["EXACT_COMPATIBLE_MODEL_IDS"],"cost_tier":"RESOLVED_TASK_TIER"}]}
```

The actual configured exact list replaces the illustrative value. Native Agentic execution is used so the configuration reaches the real provider payload. The first response must identify an allowed concrete model. Remaining turns call that concrete model directly. An unexpected, omitted or changed concrete identity is an operational protocol failure and cannot execute that response's tool calls. Response receipts remain charged.

With `costTier: "auto"`, a bounded simple nonvisual edit uses low; cross-file or uncertain work uses medium; complex architecture uses high; serious risk resolves max (the existing high-risk reference gate remains authoritative). Eligible endpoint prices are bounded relative to the explicit reference: low 5%, medium 25%, high 100%, xhigh 200%, max 400%, separately for input and output. These configurable `priceRatio` limits are economic experiment settings, not model-quality evidence.

Auto reserves against the worst eligible per-token prices and smallest allowed context/output capacities. A reference attempt and completion budget remain reserved. Actual verification regressions skip same-model repair and escalate to the fixed reference; provider errors are operational, not model-quality evidence. High-risk work, no candidates inside the task price bound, or insufficient budget/attempts starts on the reference without Auto.

Planning, exploration and completion review continue through their existing configured models and shared backend transport. Auto controls the coding start, not every auxiliary model call. Verification, baseline comparisons, write restrictions, isolation, parallel scheduling and safe apply are unchanged.

Inspect `openrouter_auto_route`, `model_call.modelRequested`, `model_call.modelReturned`, `adaptive_recovery_decision` and the normal summary cost/verification/apply fields in the report. Auto is a market-based recommendation; it does not supply a calibrated probability of frontier-level verified success.

## Deterministic validation

```sh
node --import tsx --test tests/openRouterAuto.test.ts tests/coldStartFlow.test.ts
```

The local fake-provider flow exercises Auto → concrete model pin → failing source mutation → authoritative test rejection → reference recovery → passed verification/review → safe apply. It unsets the client OpenRouter key. Synthetic outcomes remain excluded from real model telemetry. These tests establish mechanics; live quality and economics require the explicit paid experiment above.

## Latency and behavioral proof

Auto defers the redundant pre-edit structural baseline for high-confidence bounded source work, including new files. Candidate failures still trigger the existing on-demand baseline comparison. Required candidate and final checks remain intact. The example allows 4096 reviewer output tokens so small requirement lists fit the existing single-review batching rule; implementation turns remain bounded independently. No arbitrary algorithm-specific acceptance test is synthesized from natural language. Supply an independent `--verify` check or repository tests for behavioral proof; lint/typecheck alone do not establish behavioral correctness. Existing byte-identical final-check reuse and destination behavior/structural re-verification remain intact.

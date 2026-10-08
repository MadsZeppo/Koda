# Real coding-agent benchmark

This is an explicitly invoked, paid evaluation harness. Nothing launches on import,
startup, `pnpm test`, or normal Koda use. Production Routing V1 remains shadow.
Only the dedicated benchmark child process installs an evaluation policy override.
`current-koda` returns the original frozen production policy unchanged.

Claude invocation was checked against installed Claude Code **2.1.285**, using
`claude --help` and `claude --version` only. Each invocation uses stdin for the
exact common task prompt, its own clean pinned clone as cwd, and:

```
-p --model ALIAS --output-format stream-json --verbose
--max-budget-usd ALLOCATION --no-session-persistence --safe-mode
--permission-mode acceptEdits --allowedTools Read,Glob,Grep,Edit,Write,Bash
```

Safe mode disables personal/project customizations and hooks, while preserving
normal installed authentication. No key is read, copied or printed by the harness.
These are isolated checkouts, not an OS sandbox: Bash can execute project code.
Use trusted benchmark repositories and validators.

## Required inputs

The interrupted first implementation did not supply a curated real-task manifest
or real learned priors. Synthetic policy matrices and the old algorithm fixtures
are **not** real benchmark tasks. Supply a reviewed task manifest and independently
maintained validators; do not point this runner at `development.json` from the
synthetic routing evaluation.

Manifest schema (1–50 tasks; recommend 30 development + 10 separate holdout):

```json
{
  "version": 1,
  "tasks": [
    {
      "id": "project-issue-123",
      "category": "debugging",
      "split": "development",
      "repo": "/absolute/path/to/local/repo",
      "commit": "FULL_40_CHARACTER_COMMIT_SHA",
      "task": "The exact real issue description and requirements",
      "writeScope": ["src/module.ts", "tests/module.test.ts"],
      "oracleDirectory": "/absolute/path/to/independent/validators/issue-123",
      "acceptance": { "argv": ["node", "acceptance.mjs"] },
      "verification": [{ "argv": ["npm", "test"] }]
    }
  ]
}
```

Categories: `small-edit`, `debugging`, `backend`, `frontend-ui`, `refactor`,
`security`, `architecture`. The oracle receives the candidate repo path as its
last argument. It lives outside the candidate checkout and must return nonzero
when requirements are missing. UI tasks need a browser/render validator; lint
alone cannot prove appearance. Verification commands must work in fresh clones;
prepare dependencies using your check wrapper without changing candidate source.

Frozen priors use the existing `routing-v1-priors.json` schema: `priors` and
`rescueEvidence`. Synthetic rows and evaluation task IDs are rejected. Genuine
historical evidence is required for evidence-backed V1 selection. Empty priors
can cause V1 to abstain; the harness never substitutes current routing and labels
it V1. Strongest/cheapest are optionally selectable from the existing compatible
candidate estimates, not hardcoded model names.

## Commands

From the Koda repository, set your actual input paths once:

```zsh
TASKS=/absolute/path/to/real-tasks.json
PRIORS=/absolute/path/to/frozen-routing-v1-priors.json
```

Three-task smoke, five arms (15 independent runs), total configured API budget $3:

```zsh
KODA_PROVIDER_MODE=backend KODA_API_URL=http://127.0.0.1:8787 \
node --import tsx src/dev/realBenchmark.ts \
  --manifest "$TASKS" --priors "$PRIORS" --config koda.config.example.json \
  --split development --limit 3 --claude-models opus,sonnet,haiku \
  --budget-usd 3 --output /tmp/koda-claude-smoke
```

Full selected development set, total configured API budget $30:

```zsh
KODA_PROVIDER_MODE=backend KODA_API_URL=http://127.0.0.1:8787 \
node --import tsx src/dev/realBenchmark.ts \
  --manifest "$TASKS" --priors "$PRIORS" --config koda.config.example.json \
  --split development --claude-models opus,sonnet,haiku \
  --budget-usd 30 --output /tmp/koda-claude-full
```

For 30 tasks this is 150 runs, $0.20 per run. This is a spending ceiling policy,
not a claim that difficult tasks can be solved for $0.20. Increase the explicitly
chosen budget if needed. Claude's own CLI enforces `--max-budget-usd`; already
in-flight API calls may overshoot the configured cap. An absolute billing maximum
requires a provider/account spending limit. Reported overruns stop the harness;
unknown or interrupted runs consume their whole reservation, including on resume.

Append `--resume` to the identical command to continue. Completed runs are never
repeated. Interrupted reservations become censored interrupted rows rather than
being silently rebilled. A forcibly killed process may leave `.lock`; remove it
only after confirming no harness/child is still running. Use a new output folder
when changing tasks, priors, models, config, split, limit or budget.

`--claude-models opus,sonnet,haiku,fable,opusplan` adds separate baselines; aliases
and full model IDs are arbitrary. Unsupported aliases become explicit failures,
not substitutions. `--arms routing-v1,current-koda,strongest,cheapest` adds optional
Koda arms. Without `--claude-models`, the original four-arm selection is preserved.
Holdout runs use `--split holdout` and a separate output folder and budget.

## Results

Each arm gets the same prompt plus identical authoritative write restriction,
same commit, fresh clone, independent oracle and baseline checks. Results contain
served models (unknown if absent), requested alias, exit code, mutations, Claude
assistant/tool activity, aggregate and per-model usage, actual reported API cost,
wall-clock time and existing Koda Failure Attribution/Verification Contract data.
Operational and ambiguous failures remain censored for model-quality learning.
The runner never writes this experiment into shared production routing history.

An independent validator runs after each child finishes, even when it exits with
an error. An agent's success claim alone cannot count as a solved task. The oracle,
write scope, genuine mutation and regression checks must all agree. A verifier
source mutation prevents acceptance. Existing identical baseline failures are
not new regressions. Missing accounting stays unknown, never zero.

Outputs: `state.json` (resumable ledger), `comparison.json` (machine-readable),
`comparison.md` (tables), and per-arm stdout/stderr, baseline and independent
verification artifacts. Tables include solve rate, false accepts, total cost per
independently verified solve, wall-clock per solve, and category breakdowns.
Failed attempts count toward cost/time per solve. Codex API-equivalent estimates
remain distinguished from actual Claude API billing.

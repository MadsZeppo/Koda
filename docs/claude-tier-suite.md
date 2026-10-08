# 25-task Koda Auto vs Claude Code pilot

5 easy local utilities, 10 medium single-module algorithms, 10 hard multi-module
workflows (three operations plus a public batch API). Generated temporary repos,
not real customer repos or SWE-bench. Difficulty labels are suite labels.

Uses the existing compareTask harness: identical initial copies/prompts and the
same independent external acceptance check. No gold implementations are sent to
agents. Existing contracts supply test expectations. Claude API-only bare mode
uses the CLI default model (not a prompt-aware cheapest-model router). Koda uses
the supplied config. Production routing is not changed.

Prepare without payment:

```zsh
pnpm benchmark:claude-suite --output /tmp/koda-25-preview
```

Paid execution requires --execute and BOTH explicit total budgets. Each arm's
budget is divided equally over the selected tasks; unused caps are not recycled.
Claude's --max-budget-usd is a CLI control, not a prepaid billing guarantee.
For the full suite, $5 Claude / $12.50 Koda means $0.20/$0.50 per task.
Do not confuse caps with expected spend. $1 Claude credits may be insufficient,
especially for hard tasks; budget-exhausted tasks are not quality conclusions.

```zsh
KODA_PROVIDER_MODE=backend KODA_API_URL=http://127.0.0.1:8787 \
pnpm benchmark:claude-suite --execute \
  --claude-budget-usd 5 --koda-budget-usd 12.50 \
  --output /tmp/koda-25-paid
```

Keep ANTHROPIC_API_KEY local. The backend holds OPENROUTER_API_KEY. The harness
never writes keys into reports. Run with Node 22 and a running backend.

--limit 5 runs easy tasks only. A fresh directory is required when changing the
selection, configuration or budget. Repeating the identical command resumes
completed comparisons without new calls. Interrupted comparisons stop with an
explicit message; inspect them or use a new directory.

suite.md and suite.json include per-task pass/fail/prices and aggregate prices
and cost/solve by tier. Claims of savings require complete receipts and equal,
nonzero solve counts. Raw model usage, timing and outputs are in each result
folder. Independent check syntax is validated before any task's paid invocation.

Ten-task balanced subset (5 medium + 5 hard, no easy tasks):

```zsh
KODA_PROVIDER_MODE=backend KODA_API_URL=http://127.0.0.1:8787 \
pnpm benchmark:claude-suite --execute --profile medium-hard --limit 10 \
  --claude-budget-usd 0.75 --koda-budget-usd 5 \
  --output /tmp/koda-ten-medium-hard
```

Claude gets $0.075 per task. Some hard tasks may hit that small budget, which is
not evidence that the model cannot solve them. Koda's $5 is a reservation ceiling
($0.50/run), not expected spend; it is separate OpenRouter credit. Claude's CLI
budget is not a guarantee against an individual request overshooting the cap.

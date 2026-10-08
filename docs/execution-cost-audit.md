# Execution cost audit and validation gate

Production routing is unchanged. This audit uses existing local runs; no model calls were made to prepare it.

## Observed costs

Source: `/tmp/koda-three-hard-timed-1791407521` (three generated multi-module tasks, not real SWE repositories).

| Component | USD | Share of recorded total |
|---|---:|---:|
| Cheap coding calls | 0.023132 | 10.7% |
| Reference coding/repair | 0.115602 | 53.3% |
| Reference completion review | 0.068350 | 31.5% |
| Other recorded usage | 0.009687 | 4.5% |

All three tasks required reference recovery. Four deterministic completion rejections reported missing requested test mutations. These runs recorded no `Tool error:` tool results. Tool repair is therefore not established as their cost driver.

Source: `/tmp/koda-auto-vs-claude-openrouter-1791409180` (five utility tasks per arm).

Three scout review calls aborted after approximately ten seconds. The prior retry rule treated transport failures like malformed review output and selected a stronger reviewer. Missing usage for dispatched aborted requests makes total cost unknown; absence of a receipt must never become zero cost.

## Implementation changes

- A premature worker finish with requested tests absent receives one same-session reminder. The transcript, model pin, original task and candidate remain available. Existing attempt token/time limits still apply. First-mutation handoff for tiny tasks remains intact.
- Review begins with the configured scout independent of requirement count.
- A transient transport failure gets at most one structured retry with the same scout, within existing budget enforcement. A malformed/incomplete review or verification contradiction can select a stronger reviewer on the existing single retry.
- Review retry uses the actual concrete served model as capability evidence, never the virtual Auto route.
- Both failed reviews remain an operational failure; they do not establish missing requirements or authorize coding repair.
- Candidate verification and apply gates are unchanged.

## Next measurement

Freeze this execution behavior before another paid run. Use the same independent checks and clean starting state for both arms. Include failed attempts, repair, review and all other model calls in cost per solve. Do not claim savings when receipts are incomplete or solve rates differ. Use fresh holdout tasks before claiming general quality parity.

This change does not establish that cheap-first is economically superior. It removes an unsupported escalation trigger. The configured scout must itself be inexpensive; no model names or quality thresholds are changed here.

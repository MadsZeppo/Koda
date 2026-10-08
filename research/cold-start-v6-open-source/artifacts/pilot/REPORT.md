# V6 open-source falsification

Retrospective replay of the same 100 previously observed SWE tasks. Historical benchmark outcomes are real; no live Koda verification or trajectory evaluation was performed.

| Policy | Solve | Frontier retained | Cost/solve | Saving | Harmful loss |
|---|---:|---:|---:|---:|---:|
| Frontier only | 33.0% | 100.0% | $0.2490 | 0.0% | 0.0% |
| V3 | 24.0% | 72.7% | $0.1976 | 20.6% | 9.0% |
| V4 | 33.0% | 100.0% | $0.2490 | 0.0% | 0.0% |
| Current V6 baseline | 33.0% | 100.0% | $0.2490 | 0.0% | 0.0% |
| ACRouter-style StartRouter + floor | 33.0% | 100.0% | $0.2490 | 0.0% | 0.0% |
| StartRouter without floor (diagnostic) | 23.0% | 69.7% | $0.1469 | 41.0% | 12.0% |
| Oracle | 45.0% | 136.4% | $0.0164 | 93.4% | 0.0% |

Constrained cheap starts: 0.0%; abstentions: 63.0%. Reference fallback after ABSTAIN is an **evaluation baseline**, not a V6-selected model.
Router mean/max: 76.86/116.12 ms. Provider router cost $0. Local compute/verifier dollar costs are unknown, so reported cost/solve is a lower bound.
Twin grouped heldout balanced accuracy: 0.419; majority baseline: 0.250; states with tool prefixes: 296/336.
Twin tiers are weak labels from another pool. They do not prove Koda stay/escalate improvements. Combined policy not evaluated; real escalation and unnecessary escalation are UNKNOWN. Perfect-verifier recovery simulations are separately nested in JSON, exclude verifier cost, and are not end-to-end results.
**STOP. Remain shadow-only.** Missing signal: task-conditioned low-regret adequacy plus aligned Koda six-model step outcomes. No final-outcome tuning, paid inference, new routing generation, or production promotion.
SWE-smith trajectories and optional LLMRouter baseline deferred. Existing isolation, verifier, recovery, write scope and apply authority unchanged.

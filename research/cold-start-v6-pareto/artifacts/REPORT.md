# V6.2 Pareto SWE replay

Exact same previously observed 100 tasks. Historical benchmark solves are not live Koda VERIFIED_SUCCESS. No coding or judge calls.

Effective pool: 12/12. TRAIN-selected strongest static: claude-sonnet-4. Ex-post best static: claude-sonnet-4.

| Policy | Solve rate | Frontier retained | Cost/solve | Saving | Harmful downgrade |
|---|---:|---:|---:|---:|---:|
| Strongest static (TRAIN-selected) | 33.0% | 100.0% | $0.24902 | 0.0% | 0.0% |
| V3 | 24.0% | 72.7% | $0.19762 | 20.6% | 9.0% |
| Old V6 | 33.0% | 100.0% | $0.24902 | 0.0% | 0.0% |
| Pareto 1pp | 28.0% | 84.8% | $0.32233 | -29.4% | 12.0% |
| Pareto 2pp | 27.0% | 81.8% | $0.31136 | -25.0% | 13.0% |
| Pareto 3pp | 30.0% | 90.9% | $0.26104 | -4.8% | 10.0% |
| Oracle new pool | 63.0% | 190.9% | $0.02289 | 90.8% | 0.0% |

Broader-pool oracle headroom improved: True. Safe cheaper starts demonstrated: False.
Old-pool oracle: 45.0%. New oracle: 63.0%.
Selection mean latency: 0.011 ms (excludes feature encoding/predictor fit).
Costs are actual historical model receipts; forecast uses TRAIN mean receipts. Local router compute, verifier and handover cost are unmeasured, so these are lower bounds on cost per VERIFIED solve.
Public SWE is single-patch generation, not aligned Koda multi-action trajectories. Weave economics are tested deterministically, not validated by this replay. No actual dynamic or production routing changed.
STOP: no acceptable retained-quality cost saving; no production promotion

## Forecast cheap starts and distance to oracle

| Policy | Cheaper than reference (TRAIN forecast) | Oracle solve gap | Cost/solve vs oracle |
|---|---:|---:|---:|
| Pareto 1pp | 26.0% | 35.0% | 14.08x |
| Pareto 2pp | 28.0% | 36.0% | 13.60x |
| Pareto 3pp | 33.0% | 33.0% | 11.40x |

## Start-model distribution

| Model | 1pp | 2pp | 3pp |
|---|---:|---:|---:|
| gpt-5 | 1 | 1 | 1 |
| gpt-5-chat | 0 | 0 | 0 |
| claude-sonnet-4 | 45 | 50 | 50 |
| gemini-2.5-pro | 29 | 22 | 17 |
| gemini-2.5-flash | 0 | 0 | 0 |
| qwen3-235b-a22b-2507 | 0 | 0 | 0 |
| qwen3-235b-a22b-thinking-2507 | 0 | 0 | 0 |
| deepseek-v3.1-terminus | 3 | 4 | 4 |
| deepseek-r1-0528 | 12 | 11 | 13 |
| deepseek-v3-0324 | 6 | 6 | 8 |
| kimi-k2-0905 | 4 | 6 | 6 |
| glm-4.6 | 0 | 0 | 1 |

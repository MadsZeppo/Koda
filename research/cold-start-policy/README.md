# Frozen oracle comparison

Run from the Koda root, with Node 22:

```sh
node --import tsx research/cold-start-policy/replay.ts
```

Uses the same previously observed FINAL100 as V6.2 and its frozen TRAIN-selected reference. Does not change production, call providers, fit on evaluation labels or rerun coding models. The six-model oracle and the old twelve-model oracle are shown separately; increasing the oracle pool must not be presented as a router improvement.

This is an evidence audit plus a mathematically determined fallback replay of the actual cold-start policy. If even one candidate has credible exact Koda-domain support, it stops rather than inventing old models' provider capability/price metadata or making a new offline selector. With no credible candidate the production cold-start function always falls back to its configured reference, independently of prices. Outcome labels enter only after those decisions freeze. Frozen task metadata and text enter the canonical estimator; no task outcomes enter it.

Historical receipt cost per solved task excludes Koda execution, routing/provider overhead, verification and recovery. Live VERIFIED_SUCCESS and live escalation performance remain unknown. Public outcomes are reused for evaluation only, not imported as licensed native quality evidence.

See `results/REPORT.md`, `results/results.json` and `results/decisions.json`.

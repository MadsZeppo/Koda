# Benchmarking verified task success

For a no-network, no-paid-inference execution smoke benchmark, run
`pnpm exec tsx benchmarks/run-deterministic.ts`. It runs three existing mocked
end-to-end fixtures (DIRECT, STABLE, PLANNED) and prints runtime metrics from
their actual event logs. The STABLE fixture exercises failed exact mutation,
locked-file reread, missing regression-test completion, provider fallback, and
final-check repair. Model token counts and prices are fixture-supplied synthetic
values; wall clock includes local sandbox setup and verification. Do not treat
these numbers as live provider latency or a live cost comparison.

The successful 2026-09-16 Stable dogfood run used 14 Luna calls, 91,404 tokens,
$0.020427, and 86.7 seconds. Its call breakdown (prompt + completion tokens) was:

| Phase | Calls | Tokens |
| --- | ---: | ---: |
| Inspection | 3 | 24,905 |
| Scope finalization | 1 | 13,075 |
| Initial implementation | 3 | 21,104 |
| Mutation recovery before missing-test detection | 2 | 8,641 |
| Remaining implementation and test completion | 5 | 23,679 |

The implementation worker received 15,998 bytes of compiled context, including
unrelated search hits. Stable now filters that preloaded context to locked and
evidence-backed files and compacts failed-mutation recovery to the handoff and
exact command failure. The deterministic fixture reports the before/after
context bytes; only a future manual live run can establish live token savings.

Copy `example-tasks.json` to `tasks.json`; set real repository paths, exact commit SHAs, tasks, and independent verification commands. Run:

```sh
pnpm agent benchmark --manifest ./benchmarks/tasks.json --output ./benchmark-results
```

Each entry starts a new worktree at its exact base commit, including when the original checkout is dirty. No `reset --hard` runs on the user's checkout. The planner and workers never receive `verify` commands from the manifest. They execute only after integration alongside public checks. Exit codes determine the outcome. Results are written incrementally to `results.json`, plus `summary.md`.

Commands execute inside the integration sandbox. Keep independent tests in the fixture's base commit, or use inline test programs in `verify`. Existing in-repository files can still be read by workers; withholding a command is not a cryptographic hidden-test boundary. For stronger evaluation, use independent assertions in the manifest and protect the test runner from changes to repository scripts. Network-dependent tests are not supported in V0.

The included `tests/fixtures/math` has intentionally broken addition and multiplication plus a report function that depends on both. `tests/e2e.test.ts` initializes it as a temporary Git repository and uses a mock inference server to prove concurrency, dependency visibility, escalation, integration, accounting, and hidden-check failure. The fixture's tests intentionally fail before implementation.

To evaluate the thesis, run a fixed task suite repeatedly with Koda and a baseline coding agent at identical commits, using identical hidden checks, time limits, and initial dependencies. Record independent success rate, total billed cost, and end-to-end wall time (including dependency copies, scouting, retries, integration and final checks). Report uncertainty and failures, not only successful examples. Distinguish provider latency from summed concurrent request time. Compare cost per verified success as well as cost per run. The mock fixture establishes runtime behavior, not coding quality or benchmark parity.

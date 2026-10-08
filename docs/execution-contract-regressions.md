# Execution contract and recovery regression gate

Routing is unchanged. These checks test execution behavior, not general model quality.

For a failed candidate, use the original task/API contract and fresh reads of both
implementation and failing assertions. Passing candidate-authored tests alone is
not independent behavioral proof. Completion review must inspect public return
shape and meaning, as well as names and paths.

Verification repair retains the candidate and original baseline. Native Agentic repair uses the
normal bounded attempt step, token, dollar and time limits rather than a single
forced-mutation turn. Other execution modes retain their existing step bound. A newly authored expectation may be corrected only with
contract evidence; pre-existing tests and requirements must not be weakened.
Every repaired candidate must pass authoritative verification and completion.

Provider interruption is operational, not quality evidence. Unknown usage consumes
the bounded reservation. If partial implementation passes checks but lacks required
work, use reserved recovery instead of reopening a spent cheap leg. Verification
infrastructure failures must not launch coding repair. Failed/unverified candidates
must not apply. Existing scope and isolation rules remain authoritative.

Run the existing deterministic regressions before paid evaluation:

```sh
pnpm typecheck
pnpm exec tsx --test tests/coldStartFlow.test.ts tests/agenticCodingWorker.test.ts tests/completionRepairScope.test.ts tests/completionReview.test.ts tests/openRouterAuto.test.ts tests/codingSuite.test.ts
pnpm test
```

Coverage includes search versus real reads, multiple mutations, independent return
contracts, implementation versus newly authored assertion repair, protocol failures,
provider interruption after mutation, preserved recovery reserves and original-repo
apply safety. Scripted providers validate the mechanics without proving live model
reasoning accuracy. Keep external acceptance checks independent and report false
accepts, unknown receipts and all failed-attempt costs. Do not tune on an evaluation
set and then claim that same set measures generalization.

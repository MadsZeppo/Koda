import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveFailureAttribution,
  failureAttributionSchema,
  type AttributionEvent,
  type FailureTrace,
} from "../src/agent/failureAttribution.js";
import {
  readFailureDataset,
  evaluateFailureAttributions,
} from "../src/agent/failureAttributionEvaluation.js";
import {
  collectFailureAttributions,
  normalizeAttemptEvidence,
} from "../src/agent/failureAttributionRuntime.js";
import { buildVerificationContract } from "../src/verifier/contract.js";
import { runFakeProvider } from "../src/dev/fakeProvider.js";
import { fakeSmokeFixtures } from "../src/dev/fakeSmokeFixtures.js";
const base = {
  source: "audit",
  description: "Independent subsystem observation",
  stage: "coding" as const,
};
const opportunity: AttributionEvent[] = [
  { ...base, type: "provider_response", successful: true },
  {
    ...base,
    type: "opportunity",
    valid: true,
    scopeAvailable: true,
    contextAvailable: true,
  },
];
const proof: AttributionEvent = {
  ...base,
  type: "candidate_proof",
  stage: "verification",
  valid: true,
  candidateFailed: true,
  baseline: "regression",
  strength: "strong",
  proofKind: "behavior",
  checkId: "proof",
};
const resolve = (events: AttributionEvent[]) =>
  resolveFailureAttribution({ attemptId: "a", events });
const censored = (events: AttributionEvent[], cause: string) => {
  const result = resolve(events);
  assert.equal(result.primaryCause, cause);
  assert.equal(result.learningDisposition, "CENSORED");
  failureAttributionSchema.parse(result);
};
for (const cause of [
  "PROVIDER_FAILURE",
  "VERIFICATION_INFRA_FAILURE",
  "KODA_INTERNAL_FAILURE",
] as const)
  test(`${cause} before proof always censors model blame`, () =>
    censored(
      [
        ...opportunity,
        { ...base, type: "fault", cause, established: true },
        proof,
      ],
      cause,
    ));
test("required scope rejection never becomes model evidence, including contradictory earlier audit", () =>
  censored(
    [
      ...opportunity,
      proof,
      {
        ...base,
        type: "scope_block",
        path: "src/required.ts",
        required: true,
        blockedByKoda: true,
      },
    ],
    "SCOPE_FAILURE",
  ));
test("withheld necessary context is censored, available ignored context is not a context failure", () => {
  censored(
    [
      {
        ...base,
        type: "context_gap",
        necessary: true,
        withheldByKoda: true,
        suppliedOrRetrievable: false,
        fact: "schema",
      },
    ],
    "CONTEXT_FAILURE",
  );
  const result = resolve([
    ...opportunity,
    {
      ...base,
      type: "context_gap",
      necessary: true,
      withheldByKoda: false,
      suppliedOrRetrievable: true,
      fact: "schema",
    },
    proof,
  ]);
  assert.equal(result.primaryCause, "MODEL_FAILURE");
});
test("exact pre-existing failure is baseline evidence without blaming candidate", () =>
  censored(
    [...opportunity, { ...proof, baseline: "same_failure" }],
    "REPO_BASELINE_FAILURE",
  ));
test("UNKNOWN is censored and missing prerequisites are explicit", () => {
  const result = resolve([proof]);
  assert.equal(result.primaryCause, "UNKNOWN");
  assert.equal(result.learningDisposition, "CENSORED");
  for (const key of [
    "successfulProviderResponse",
    "requiredScopeAvailable",
    "necessaryContextAvailable",
    "validOpportunity",
  ])
    assert.ok(result.explanation.includes(key));
});
for (const proofKind of [
  "behavior",
  "compile",
  "test",
  "required_mutation",
  "output_protocol",
] as const)
  test(`proven candidate ${proofKind} failure can be negative evidence`, () => {
    const result = resolve([...opportunity, { ...proof, proofKind }]);
    assert.equal(result.primaryCause, "MODEL_FAILURE");
    assert.equal(result.learningDisposition, "NEGATIVE_MODEL_EVIDENCE");
    assert.equal(result.retryRecommendation, "ESCALATE_MODEL");
  });
for (const missing of ["valid", "scopeAvailable", "contextAvailable"] as const)
  test(`missing ${missing} cannot silently assume valid opportunity`, () => {
    const events = structuredClone(opportunity);
    const audit = events[1]!;
    if (audit.type === "opportunity") delete audit[missing];
    censored([...events, proof], "UNKNOWN");
  });
test("weak subjective contract does not produce model blame even if caller overstates proof strength", () => {
  const contract = buildVerificationContract({ task: "Make the UI beautiful" });
  const result = resolveFailureAttribution({
    attemptId: "a",
    events: [
      ...opportunity,
      { ...proof, requirementId: contract.requirements[0]!.requirementId },
    ],
    verificationContract: contract,
  });
  assert.equal(result.primaryCause, "UNKNOWN");
});
test("independently proven failure remains primary before later internal crash", () => {
  const result = resolve([
    ...opportunity,
    proof,
    {
      ...base,
      type: "fault",
      cause: "KODA_INTERNAL_FAILURE",
      established: true,
      stage: "integration",
    },
  ]);
  assert.equal(result.primaryCause, "MODEL_FAILURE");
  assert.deepEqual(result.contributingCauses, ["KODA_INTERNAL_FAILURE"]);
});
test("latest authoritative proof PASS supersedes stale failure", () =>
  censored(
    [...opportunity, proof, { ...proof, candidateFailed: false }],
    "UNKNOWN",
  ));
test("resolved provider retry is not unresolved failure", () =>
  assert.equal(
    resolve([
      {
        ...base,
        type: "fault",
        cause: "PROVIDER_FAILURE",
        established: true,
        resolved: true,
      },
      ...opportunity,
      proof,
    ]).primaryCause,
    "MODEL_FAILURE",
  ));
test("keywords do not establish cause", () => {
  censored(
    [
      {
        ...base,
        type: "unresolved",
        description: "timeout auth failure network crash",
        missing: ["typed origin"],
      },
    ],
    "UNKNOWN",
  );
  assert.equal(
    resolve([
      ...opportunity,
      { ...proof, description: "timeout auth failure assertion" },
    ]).primaryCause,
    "MODEL_FAILURE",
  );
});
const check = (outcome: string, stdout = "") => ({
  command: "node --test tests/value.test.cjs",
  kind: "test",
  cwd: ".",
  outcome,
  exitCode: outcome === "CHECK_PASS" ? 0 : 1,
  stdout,
  stderr: "",
  wallClockMs: 1,
  timedOut: false,
});
const verified = (checks: any[]) => ({
  status: "FAILED",
  checks,
  failedChecks: [],
  failingTests: [],
  buildErrors: [],
});
test("runtime uses final aggregate result, not transient retry failure or error text", () => {
  const trace = normalizeAttemptEvidence("a", [
    { type: "verification", ...check("INFRA_FAILURE") },
    {
      type: "attempt_verification_evidence",
      baseline: verified([check("CHECK_PASS")]),
      candidate: verified([check("CHECK_PASS")]),
      changedPaths: ["src/value.cjs"],
    },
  ]);
  assert.ok(!trace.events.some((e) => e.type === "fault"));
  assert.equal(resolveFailureAttribution(trace).primaryCause, "UNKNOWN");
});
test("runtime concrete provider transport events censor 429/timeouts/5xx", () => {
  for (const error of ["429", "timeout", "503"]) {
    const trace = normalizeAttemptEvidence("a", [
      { type: "model_error", failureOrigin: "provider", error },
    ]);
    assert.equal(
      resolveFailureAttribution(trace).primaryCause,
      "PROVIDER_FAILURE",
    );
    assert.equal(
      resolveFailureAttribution(trace).learningDisposition,
      "CENSORED",
    );
  }
});
test("runtime response validation and ambiguous scope errors are not guessed as provider/model faults", () => {
  for (const event of [
    {
      type: "model_error",
      failureOrigin: "response_validation",
      error: "timeout",
    },
    { type: "write_scope_violation", attempted_write_paths: ["unrelated.ts"] },
  ])
    assert.equal(
      resolveFailureAttribution(normalizeAttemptEvidence("a", [event]))
        .primaryCause,
      "UNKNOWN",
    );
});
test("runtime candidate regressions require actual scope/context audit, unchanged baseline censors", () => {
  const failed = check(
    "CHECK_FAIL",
    "# Subtest: value\nnot ok 1 - value\n  error: expected 2 actual 99\n",
  );
  const raw = [
    { type: "model_call", stage: "implement", modelReturned: "test/model" },
    {
      type: "attempt_verification_evidence",
      baseline: verified([check("CHECK_PASS")]),
      candidate: verified([failed]),
      changedPaths: ["src/value.cjs"],
    },
  ];
  assert.equal(
    resolveFailureAttribution(normalizeAttemptEvidence("a", raw)).primaryCause,
    "UNKNOWN",
  );
  raw[1]!.baseline = verified([failed]);
  assert.equal(
    resolveFailureAttribution(normalizeAttemptEvidence("a", raw)).primaryCause,
    "REPO_BASELINE_FAILURE",
  );
});
test("per-attempt grouping preserves parallel subtasks and repeated models", () => {
  const events = [
    { type: "coding_worker_start", subtaskId: "A" },
    { type: "coding_worker_start", subtaskId: "B" },
    { type: "model_error", subtaskId: "A", failureOrigin: "provider" },
    {
      type: "coding_worker_stop",
      subtaskId: "A",
      exit_status: "infra_failure",
    },
    { type: "coding_worker_start", subtaskId: "A" },
    { type: "completion_review_failure", subtaskId: "B" },
    { type: "model_attempt", subtaskId: "A", verification: "VERIFIED_SUCCESS" },
  ];
  const report = collectFailureAttributions(events, "run");
  assert.equal(report.attributions.length, 2);
  assert.equal(new Set(report.attributions.map((a) => a.attemptId)).size, 2);
  assert.deepEqual(report.attributions.map((a) => a.primaryCause).sort(), [
    "PROVIDER_FAILURE",
    "VERIFICATION_INFRA_FAILURE",
  ]);
});
test("development and held-out traces exercise the real resolver; external JSON dataset accepted", async (t) => {
  const development = await readFailureDataset(
      "benchmarks/failure-attribution/development.jsonl",
    ),
    holdout = await readFailureDataset(
      "benchmarks/failure-attribution/holdout.jsonl",
    );
  assert.ok(holdout.every((h) => !development.some((d) => d.id === h.id)));
  for (const rows of [development, holdout]) {
    const report = evaluateFailureAttributions(rows);
    assert.equal(report.falseModelBlameCount, 0);
    assert.equal(report.criticalFalseModelBlameCount, 0);
    assert.equal(report.learningDispositionAccuracy, 1);
    assert.ok(report.modelFailure.precision! >= 0.99);
  }
  const root = await mkdtemp(join(tmpdir(), "failure-external-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "dataset.json");
  await writeFile(path, JSON.stringify([development[0]]));
  assert.equal(
    evaluateFailureAttributions(await readFailureDataset(path)).caseCount,
    1,
  );
});
test("shadow on/off leaves actual fake pipeline routing, repair, provider requests, write scopes and verification identical", async (t) => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  t.after(() => {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  });
  const root = await mkdtemp(join(tmpdir(), "koda-attribution-shadow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const scenario of ["edit", "repair", "provider-failure", "regression"]) {
    const fixture = fakeSmokeFixtures[scenario]!,
      snapshots = [];
    for (const enabled of [false, true]) {
      const directory = join(root, scenario, String(enabled)),
        repo = join(directory, "repo"),
        output = join(directory, "report");
      for (const [path, content] of Object.entries(fixture.files)) {
        await mkdir(dirname(join(repo, path)), { recursive: true });
        await writeFile(join(repo, path), content);
      }
      const script = join(directory, "script.json");
      await writeFile(script, JSON.stringify(fixture.script));
      await runFakeProvider({
        repo,
        task: fixture.task,
        script,
        output,
        failureAttributionShadow: enabled,
      });
      const summary = JSON.parse(
        await readFile(join(output, "summary.json"), "utf8"),
      );
      const events = (await readFile(join(output, "events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const transcript = JSON.parse(
        await readFile(join(output, "fake-provider.json"), "utf8"),
      );
      assert.equal(summary.failureAttribution !== null, enabled);
      if (enabled) {
        assert.deepEqual(
          JSON.parse(
            await readFile(join(output, "failure-attribution.json"), "utf8"),
          ),
          summary.failureAttribution,
        );
        if (scenario === "provider-failure")
          assert.ok(
            summary.failureAttribution.attributions.some(
              (a: any) => a.primaryCause === "PROVIDER_FAILURE",
            ),
          );
      }
      snapshots.push({
        status: summary.status,
        strategy: summary.execution_strategy,
        requests: transcript.requests.map((r: any) => {
          const { session_id, ...payload } = r.payload;
          return {
            ...r,
            payload: JSON.parse(
              JSON.stringify(payload)
                .replace(/koda-command-[A-Za-z0-9_-]+/g, "koda-command-TEMP")
                .replace(/duration_ms: ?[0-9.]+/g, "duration_ms: TIME")
                .replace(/duration_ms [0-9.]+/g, "duration_ms TIME"),
            ),
          };
        }),
        scopes: events
          .filter((e) => e.type === "worker_scope")
          .map((e) => e.allowed_write_paths),
        recovery: events
          .filter((e) =>
            [
              "completion_continuation",
              "verification_repair",
              "model_fallback",
              "coding_route_escalation",
              "provider_transient_retry",
              "aider_fallback",
            ].includes(e.type),
          )
          .map((e) => {
            const { timestamp, runId, worktree, path, ...rest } = e;
            return rest;
          }),
        checks: summary.verification?.checks?.map((c: any) => ({
          command: c.command,
          outcome: c.outcome,
        })),
      });
    }
    assert.deepEqual(snapshots[1], snapshots[0], scenario);
    if (scenario === "repair") assert.ok(snapshots[0]!.recovery.length > 0);
  }
});

test("runtime carries frozen contract and real event positions into attempt evidence", () => {
  const contract = buildVerificationContract({ task: "Make the UI beautiful" });
  const report = collectFailureAttributions(
    [
      { type: "verification_contract", contract },
      { type: "coding_worker_start", subtaskId: "A" },
      ...opportunity.map((observation) => ({
        type: "failure_evidence",
        subtaskId: "A",
        observation,
      })),
      {
        type: "failure_evidence",
        subtaskId: "A",
        observation: {
          ...proof,
          requirementId: contract.requirements[0]!.requirementId,
        },
      },
      { type: "attempt_failed", subtaskId: "A" },
    ],
    "run",
  );
  assert.equal(report.attributions[0]?.primaryCause, "UNKNOWN");
  assert.deepEqual(report.traces[0]?.verificationContract, contract);
  assert.equal(report.attributions[0]?.evidence[0]?.eventId, "run:event:2");
});
test("unstructured worker throws and pre-worker exceptions still get censored attribution", () => {
  for (const events of [
    [
      { type: "coding_worker_start", subtaskId: "A" },
      { type: "attempt_failed", subtaskId: "A", error: "unexpected exception" },
    ],
    [{ type: "run_error", error: "unspecified crash before worker" }],
  ]) {
    const report = collectFailureAttributions(events, "run");
    assert.equal(report.attributions.length, 1);
    assert.equal(report.attributions[0]?.primaryCause, "UNKNOWN");
    assert.equal(report.attributions[0]?.learningDisposition, "CENSORED");
  }
});

test("worker envelope timeout is not guessed to be provider timeout", () => {
  const trace = normalizeAttemptEvidence("a", [
    {
      type: "coding_worker_stop",
      exit_status: "infra_failure",
      limit_kind: "timeout",
      termination_reason: "attempt deadline",
    },
  ]);
  const result = resolveFailureAttribution(trace);
  assert.equal(result.primaryCause, "UNKNOWN");
  assert.equal(result.learningDisposition, "CENSORED");
});
test("runtime successful provider retry resolves a previous transport fault", () => {
  const trace = normalizeAttemptEvidence("a", [
    {
      type: "model_error",
      stage: "implement",
      modelRequested: "test/model",
      failureOrigin: "provider",
      error: "429",
    },
    {
      type: "model_call",
      stage: "implement",
      modelRequested: "test/model",
      modelReturned: "test/model",
    },
    { type: "failure_evidence", observation: opportunity[1] },
    { type: "failure_evidence", observation: proof },
  ]);
  assert.equal(resolveFailureAttribution(trace).primaryCause, "MODEL_FAILURE");
});

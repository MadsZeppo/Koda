import { test } from "node:test";
import assert from "node:assert/strict";
import {
  completionReviewMessages,
  completionReviewGate,
  missingRequirementDiagnostics,
  parseCompletionReview,
  taskRequirementChecklist,
  unresolvedCompletionReviews,
} from "../src/agent/completionReview.js";
import { verificationResult } from "../src/verifier/verifier.js";

test("task completion checklist preserves distinct implementation, integration and test requirements", () => {
  const requirements = taskRequirementChecklist({
    task: "Create the outcome module\n- Wire it into telemetry\n- Add focused regression tests",
    objective: "Implement telemetry outcomes",
    integrationContract: "Existing callers use the new module",
    acceptanceCriteria: ["Focused tests cover the integration"],
  });
  assert.ok(requirements.some((item) => /Create the outcome module/.test(item.text)));
  assert.ok(requirements.some((item) => /Wire it into telemetry/.test(item.text)));
  assert.ok(requirements.some((item) => /regression tests/.test(item.text)));
  assert.ok(requirements.length <= 8);
});

test("completion review rejects partial implementation and identifies missing integration and tests", () => {
  const requirements = [
    { id: "R1", text: "Create module" },
    { id: "R2", text: "Wire module" },
    { id: "R3", text: "Add tests" },
  ];
  const review = parseCompletionReview(JSON.stringify({
    passed: true,
    requirements: [
      { id: "R1", satisfied: true, evidence: "new file in diff" },
      { id: "R2", satisfied: false, evidence: "no caller changed" },
    ],
    summary: "partial",
  }), requirements);
  assert.equal(review.passed, false);
  assert.deepEqual(review.requirements.filter((item) => !item.satisfied).map((item) => item.id), ["R2", "R3"]);
  assert.match(missingRequirementDiagnostics(requirements, review), /Wire module/);
  assert.match(missingRequirementDiagnostics(requirements, review), /Add tests/);
});

test("completion review accepts only an explicit assessment for every requirement", () => {
  const requirements = [{ id: "R1", text: "Implement" }, { id: "R2", text: "Test" }];
  const review = parseCompletionReview(JSON.stringify({
    passed: true,
    requirements: requirements.map((item) => ({ id: item.id, satisfied: true, evidence: "diff and focused check" })),
    summary: "complete",
  }), requirements);
  assert.equal(review.passed, true);
});

test("independent review receives fresh task, diff, worker and verification evidence", () => {
  const messages = completionReviewMessages({
    task: "Implement and test feature",
    requirements: [{ id: "R1", text: "Implement" }],
    diff: "diff --git a/a b/a",
    changedPaths: ["a"],
    changedSymbols: ["run"],
    toolEvidence: "read a: existing implementation",
    workerExitStatus: "completed",
    verification: verificationResult([]),
  });
  assert.equal(messages.length, 2);
  assert.match(messages[0]!.content, /Passing tests alone never prove/);
  assert.match(messages[1]!.content, /diff --git/);
  assert.match(messages[1]!.content, /existing implementation/);
});

test("rejected completion remains unresolved after failed continuation and green final checks", () => {
  const events = [
    {
      type: "completion_review",
      subtaskId: "implementation",
      passed: false,
      requirements: [
        { id: "R1", satisfied: true, evidence: "module exists" },
        { id: "R2", satisfied: false, evidence: "integration missing" },
      ],
    },
    {
      type: "completion_continuation",
      subtaskId: "implementation",
      unresolved: ["R2"],
    },
    {
      type: "model_attempt",
      subtaskId: "implementation",
      verification: "NOT_FULLY_VERIFIED",
      terminationReason: "attempt_budget_exhausted",
    },
    { type: "final_verification", command: "typecheck", outcome: "CHECK_PASS" },
    { type: "final_verification", command: "test", outcome: "CHECK_PASS" },
  ];

  assert.deepEqual(unresolvedCompletionReviews(events), [{
    subtaskId: "implementation",
    requirementIds: ["R2"],
  }]);
  assert.equal(completionReviewGate("VERIFIED_SUCCESS", events).status,
    "NOT_FULLY_VERIFIED");
});

test("a later explicit complete review clears the unresolved completion latch", () => {
  const events = [
    {
      type: "completion_review",
      subtaskId: "implementation",
      passed: false,
      requirements: [{ id: "R1", satisfied: false, evidence: "missing" }],
    },
    { type: "completion_review_failure", subtaskId: "implementation" },
    {
      type: "completion_review",
      subtaskId: "implementation",
      passed: true,
      requirements: [{ id: "R1", satisfied: true, evidence: "diff proves it" }],
    },
  ];

  assert.deepEqual(unresolvedCompletionReviews(events), []);
});

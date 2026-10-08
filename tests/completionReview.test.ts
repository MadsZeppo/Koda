import { test } from "node:test";
import assert from "node:assert/strict";
import {
  completionReviewMessages,
  completionReviewModel,
  completionReviewBatches,
  completionReviewOutputTokens,
  completionReviewContradictsVerification,
  deterministicLiteralCompletionReview,
  completionReviewGate,
  missingRequirementDiagnostics,
  parseCompletionReview,
  requiredTestMutationGap,
  missingRequestedTestVerification,
  taskRequirementChecklist,
  visualCascadeConflict,
  unresolvedCompletionReviews,
} from "../src/agent/completionReview.js";
import { verificationResult } from "../src/verifier/verifier.js";

test("completion review uses a cheap first pass and a distinct strict retry", () => {
  const registry = {
    SCOUT_MODEL: "cheap/reviewer",
    STRONG_MODEL: "strong/reviewer",
    FRONTIER_MODEL: "frontier/reviewer",
  };
  assert.equal(completionReviewModel(registry), "cheap/reviewer");
  assert.equal(completionReviewModel(registry, true), "strong/reviewer");
  assert.equal(completionReviewModel(registry, true, "proven/tool-model"), "proven/tool-model");
  assert.equal(completionReviewModel({
    SCOUT_MODEL: "same/reviewer",
    STRONG_MODEL: "same/reviewer",
    FRONTIER_MODEL: "frontier/reviewer",
  }, true), "frontier/reviewer");
});

test("large requirement sets are reviewed in bounded batches with enough response budget", () => {
  const requirements = Array.from({ length: 31 }, (_, index) => ({ id: `R${index + 1}`, text: `Requirement ${index + 1}` }));
  const batches = completionReviewBatches(requirements, 4_096);
  assert.ok(batches.length > 1);
  assert.deepEqual(batches.flat(), requirements);
  assert.ok(batches.every((batch) => 1_344 + batch.length * 160 <= 4_096));
  assert.ok(completionReviewOutputTokens(batches[0]!.length, 4_096, true) > 1_600);
  assert.ok(completionReviewOutputTokens(1, 1_000, true) <= 1_000);
  assert.deepEqual(completionReviewBatches(requirements, 1_000).flat(), requirements);
});
test("a complete seventeen-requirement review fits one bounded call without dropping requirements", () => {
  const requirements = Array.from({length:17},(_,i)=>({id:`R${i}`,text:`Required behavior ${i}`}));
  assert.deepEqual(completionReviewBatches(requirements,4096),[requirements]);
  assert.ok(completionReviewOutputTokens(requirements.length,4096,true)<=4096);
  assert.equal(completionReviewBatches(requirements,2048).flat().length,17);
});

test("explicit requested tests cannot be accepted from a source-only diff", () => {
  const input = {
    task: "Implementér endpointet og tilføj relevante tests.",
    requirements: [
      { id: "R1", text: "Implementér endpointet" },
      { id: "R2", text: "Tilføj relevante tests" },
    ],
    diff: "+export const POST = () => Response.json({ok:true});",
    changedPaths: ["src/app/api/webhooks/events/route.ts"],
    changedSymbols: ["POST"], workerExitStatus: "completed",
    verification: verificationResult([]),
  };
  const gap = requiredTestMutationGap(input);
  assert.equal(gap?.passed, false);
  assert.deepEqual(gap?.requirements.map(({ id }) => id), ["R2"]);
  assert.equal(requiredTestMutationGap({ ...input,
    changedPaths: [...input.changedPaths, "docs/BRIDGE_PRODUCTION_LIVE_TEST.md", "supabase/migrations/bridge_micro_test.sql"],
  })?.passed, false, "test-named documentation and migrations do not prove a runnable test mutation");
  assert.equal(requiredTestMutationGap({ ...input,
    changedPaths: [...input.changedPaths, "tests/events.test.ts"] }), undefined);
  assert.match(missingRequestedTestVerification(input.task, input.changedPaths,
    verificationResult([])) ?? "", /did not change a test/i);
  assert.match(missingRequestedTestVerification(input.task,
    [...input.changedPaths, "tests/events.test.ts"], verificationResult([])) ?? "",
  /no repository test command/i);
  assert.equal(missingRequestedTestVerification(input.task,
    [...input.changedPaths, "tests/events.test.ts"], verificationResult([{
      command: "node --test tests/events.test.ts", exitCode: 0, stdout: "", stderr: "",
      wallClockMs: 1, timedOut: false, outcome: "CHECK_PASS", kind: "test",
    }]), "node --test tests/*.test.ts"), undefined);
  assert.match(missingRequestedTestVerification(input.task,
    [...input.changedPaths, "src/events.test.ts"], verificationResult([{
      command: "node --test tests/*.test.ts", exitCode: 0, stdout: "", stderr: "",
      wallClockMs: 1, timedOut: false, outcome: "CHECK_PASS", kind: "test",
    }]), "node --test tests/*.test.ts") ?? "", /outside.*glob/i);
});

test("completion review bounds large diffs while preserving both ends and the complete task", () => {
  const task = "Implement the complete requested behavior without dropping any requirement";
  const diff = `BEGIN\n${"x".repeat(30_000)}\nEND`;
  const messages = completionReviewMessages({
    task,
    requirements: [{ id: "R1", text: task }],
    diff,
    changedPaths: ["src/large.ts"],
    changedSymbols: [],
    workerExitStatus: "completed",
    verification: verificationResult([{
      command: "pnpm typecheck", exitCode: 0, stdout: "", stderr: "",
      wallClockMs: 1, timedOut: false, outcome: "CHECK_PASS",
    }]),
  });
  const payload = JSON.parse(messages[1]!.content as string);
  assert.equal(payload.originalTask, task);
  assert.match(payload.diff, /^BEGIN/);
  assert.match(payload.diff, /END$/);
  assert.match(payload.diff, /diff characters omitted from the bounded review packet/);
  assert.ok(payload.diff.length < 12_200);
});

test("exact one-file literal replacement is proved without a model reviewer", () => {
  const requirements = [
    { id: "R1", text: "Logo says yeppo instead of zeppo" },
    { id: "R2", text: "Preserve existing public interfaces" },
  ];
  const review = deterministicLiteralCompletionReview({
    task: "Gør så der på logoet i hjørnet står yeppo i stedet for zeppo",
    requirements,
    diff: "diff --git a/src/logo.tsx b/src/logo.tsx\n--- a/src/logo.tsx\n+++ b/src/logo.tsx\n@@ -1 +1 @@\n-export const logo = 'zeppo'\n+export const logo = 'yeppo'\n",
    changedPaths: ["src/logo.tsx"], changedSymbols: [], workerExitStatus: "completed",
    verification: verificationResult([{ command: "pnpm typecheck", exitCode: 0, stdout: "", stderr: "", wallClockMs: 1, timedOut: false, outcome: "CHECK_PASS" }]),
  });
  assert.equal(review?.passed, true);
  assert.ok(review?.requirements.every((item) => item.satisfied));
});

test("literal completion proof refuses extra edits, missing checks, and compound tasks", () => {
  const base = {
    task: "Replace old with new", requirements: [{ id: "R1", text: "Replace old with new" }],
    diff: "--- a/a.ts\n+++ b/a.ts\n-old\n+new\n", changedPaths: ["a.ts"], changedSymbols: [], workerExitStatus: "completed",
    verification: verificationResult([{ command: "test", exitCode: 0, stdout: "", stderr: "", wallClockMs: 1, timedOut: false, outcome: "CHECK_PASS" }]),
  };
  assert.equal(deterministicLiteralCompletionReview({ ...base, diff: `${base.diff}+extra\n` }), undefined);
  assert.equal(deterministicLiteralCompletionReview({ ...base, verification: verificationResult([]) }), undefined);
  assert.equal(deterministicLiteralCompletionReview({ ...base, task: "Replace old with new and add a test" }), undefined);
});

test("localized quoted copy change is proved when the complete diff changes only that copy", () => {
  const review = deterministicLiteralCompletionReview({
    task: "På forsiden: ændr teksten på den primære knap til 'Kom i gang'. Bevar link og design.",
    requirements: [{ id: "R1", text: "Change button text and preserve link and design" }],
    diff: "--- a/src/page.tsx\n+++ b/src/page.tsx\n-<a href='/start' className='primary'>Start nu</a>\n+<a href='/start' className='primary'>Kom i gang</a>\n",
    changedPaths: ["src/page.tsx"], changedSymbols: [], workerExitStatus: "completed",
    verification: verificationResult([{ command: "test", exitCode: 0, stdout: "", stderr: "", wallClockMs: 1, timedOut: false, outcome: "CHECK_PASS" }]),
  });
  assert.equal(review?.passed, true);
  assert.equal(deterministicLiteralCompletionReview({
    ...({
      task: "På forsiden: ændr teksten på den primære knap til 'Kom i gang'. Bevar link og design.",
      requirements: [{ id: "R1", text: "Change" }], changedPaths: ["src/page.tsx"], changedSymbols: [], workerExitStatus: "completed",
      verification: verificationResult([{ command: "test", exitCode: 0, stdout: "", stderr: "", wallClockMs: 1, timedOut: false, outcome: "CHECK_PASS" }]),
    }),
    diff: "--- a/src/page.tsx\n+++ b/src/page.tsx\n-<a href='/start'>Start</a>\n+<a href='/changed'>Kom i gang</a>\n",
  }), undefined, "changing the link as well must not be deterministically accepted");
});

test("localized copy proof uses attempt-local contents when the repository file is untracked", () => {
  const before = "export default()=> <p>jeg elsker betalinger</p>\n";
  const after = "export default()=> <p>hej jeg hedder y</p>\n";
  const review = deterministicLiteralCompletionReview({
    task: "ændrer teksten inde på den side man kommer til fra how it works til 'hej jeg hedder y'",
    requirements: [{ id: "R1", text: "Change the destination page text" }],
    // Git represents a pre-existing untracked file as a whole new file. The
    // attempt checkpoint is the authoritative candidate-local comparison.
    diff: `NEW FILE src/app/how-it-works/page.tsx\n${after}`,
    changedPaths: ["src/app/how-it-works/page.tsx"], changedSymbols: [],
    workerExitStatus: "completed",
    fileChanges: [{ path: "src/app/how-it-works/page.tsx", before, after }],
    verification: verificationResult([{ command: "npm run typecheck", exitCode: 0,
      stdout: "", stderr: "", wallClockMs: 1, timedOut: false, outcome: "CHECK_PASS" }]),
  });
  assert.equal(review?.passed, true);
  assert.match(review?.summary ?? "", /attempt-local/);
});

test("completion review includes bounded repository evidence for requirements already present", () => {
  const messages = completionReviewMessages({
    task: "Update the existing navigation and page",
    requirements: [{ id: "R1", text: "Navigation already targets /how-it-works" }],
    diff: "+body { background: black }", changedPaths: ["src/app/globals.css"],
    changedSymbols: [], workerExitStatus: "completed",
    repositoryEvidence: [{ path: "src/header.tsx", snippet: "<a href='/how-it-works'>How it works</a>" }],
    verification: verificationResult([{ command: "test", exitCode: 0, stdout: "",
      stderr: "", wallClockMs: 1, timedOut: false, outcome: "CHECK_PASS" }]),
  });
  const payload = JSON.parse(messages[1]!.content as string);
  assert.equal(payload.repositoryEvidence[0].path, "src/header.tsx");
  assert.match(payload.repositoryEvidence[0].snippet, /how-it-works/);
});

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

test("verification commands stay out of the coding completion checklist", () => {
  const requirements = taskRequirementChecklist({
    task: [
      "Redesign the landing page so the result is visibly different.",
      "Kør lint, typecheck og build.",
    ].join("\n"),
    objective: "Implement the visible landing page redesign",
    integrationContract: "npm run build passes",
    acceptanceCriteria: [
      "Add a focused regression test for the navigation link",
      "Ensure tests cover the preserved navigation behavior",
      "Lint and typecheck must pass",
    ],
  });
  assert.ok(requirements.some((item) => /visibly different/.test(item.text)));
  assert.ok(requirements.some((item) => /Add a focused regression test/.test(item.text)));
  assert.ok(requirements.some((item) => /Ensure tests cover/.test(item.text)));
  assert.equal(requirements.some((item) => /Kør lint|build passes|must pass/.test(item.text)), false);
});

test("one-line tasks separate implementation from a trailing verification command", () => {
  const requirements = taskRequirementChecklist({
    task: "Redesign the landing page so it is visibly different. Kør lint, typecheck og build.",
    objective: "",
    integrationContract: "",
    acceptanceCriteria: [],
  });
  assert.deepEqual(requirements.map((item) => item.text), [
    "Redesign the landing page so it is visibly different.",
  ]);
});

test("mixed preservation and generic verification stays a coding requirement only for preservation", () => {
  const requirements = taskRequirementChecklist({
    task: "Opret en side på /kontakt. Tilføj et link i navigationen. Bevar de øvrige links og verificér ændringen.",
    objective: "Bevar de øvrige links og verificér ændringen",
    integrationContract: "Verificér ændringen",
    acceptanceCriteria: ["Verify the change"],
  });
  assert.ok(requirements.some((item) => /Bevar de øvrige links/.test(item.text)));
  assert.equal(requirements.some((item) => /verific[eé]r|verify the change/i.test(item.text)), false);
  assert.ok(requirements.some((item) => /link i navigationen/.test(item.text)));
});

test("a tiny implementation request keeps the minimal edit requirement but defers its trailing verification instruction", () => {
  for (const suffix of ["og verificér den", "ogverificér den", "and verify it"]) {
    const requirements = taskRequirementChecklist({
      task: `Change the visible heading to Skriv til Zeppo. Lav den mindste nødvendige ændring ${suffix}.`,
      objective: "Change the visible heading",
      integrationContract: "Preserve the form",
      acceptanceCriteria: [],
    });
    assert.ok(requirements.some((item) => item.text === "Lav den mindste nødvendige ændring."));
    assert.equal(requirements.some((item) => /verific[eé]r|verify it/i.test(item.text)), false);
    assert.ok(requirements.some((item) => /visible heading/.test(item.text)));
  }
  assert.deepEqual(taskRequirementChecklist({ task: "Verificér den.", objective: "",
    integrationContract: "", acceptanceCriteria: [] }), []);
});

test("completion review labels deferred final checks as pending instead of failed", () => {
  const messages = completionReviewMessages({
    task: "Change a heading and verify it",
    requirements: [{ id: "R1", text: "Change a heading" }],
    diff: "-Old\n+New", changedPaths: ["src/page.tsx"], changedSymbols: [],
    workerExitStatus: "completed", verificationDeferred: true,
    verification: verificationResult([]),
  });
  const payload = JSON.parse(messages[1]!.content as string);
  assert.equal(payload.verification.status, "PENDING_FINAL_VERIFICATION");
  assert.deepEqual(payload.verification.checks, []);
  assert.match(messages[0]!.content, /final results independently gate VERIFIED_SUCCESS/);
  const complete = [{ type: "completion_review", subtaskId: "direct", passed: true,
    requirements: [{ id: "R1", satisfied: true, evidence: "diff changes the heading" }] }];
  assert.equal(completionReviewGate("VERIFIED_SUCCESS", complete).status, "VERIFIED_SUCCESS");
  assert.equal(completionReviewGate("FAILED", complete).status, "FAILED",
    "a review of the code cannot override a final verification regression");
});

test("broad important CSS prevents claiming an ordinary color-class edit is visible", () => {
  const base = {
    task: "Give the hero a dark navy background, light text, and a green CTA visible in the browser.",
    diff: "+ <section className=\"bg-[#071A2B]\"><h1 className=\"text-white\" /></section>\n+ <PrimaryCTA tone=\"bright\" />",
    changedPaths: ["src/app/page.tsx"],
    stylesheets: [{ path: "src/app/globals.css", content:
      "html, body, body *, body *::before { background-color: #fff !important; color: #111 !important; }" }],
  };
  assert.match(visualCascadeConflict(base) ?? "", /globals\.css.*!important/);
  assert.equal(visualCascadeConflict({ ...base, changedPaths: [...base.changedPaths, "src/app/globals.css"] }), undefined);
  assert.equal(visualCascadeConflict({ ...base, stylesheets: [{ path: "src/app/globals.css", content: "body { color: #111; }" }] }), undefined);
});

test("verification-only baseline rejection requests reassessment instead of coding repair", () => {
  const input = {
    task: "Replace the heading with the requested text",
    requirements: [{ id: "R1", text: "Replace heading" }, { id: "R2", text: "Build passes" }],
    diff: "- old heading\n+ requested heading", changedPaths: ["src/page.tsx"], changedSymbols: [],
    workerExitStatus: "completed",
    verification: verificationResult([{
      command: "npm run build", exitCode: 1, stdout: "", stderr: "baseline failure",
      wallClockMs: 1, timedOut: false, outcome: "CHECK_FAIL", source: "build:baseline_unchanged",
    }]),
  };
  const review = { passed: false, summary: "build failed", requirements: [
    { id: "R1", satisfied: true, evidence: "diff proves requested heading" },
    { id: "R2", satisfied: false, evidence: "npm run build failed due to unchanged baseline" },
  ] };
  assert.equal(completionReviewContradictsVerification(input, review), true);
  assert.equal(completionReviewContradictsVerification({ ...input, task: "Fix npm run build" }, review), false,
    "explicit user requirements to fix that command remain authoritative");
  assert.equal(completionReviewContradictsVerification(input, { ...review, requirements: [
    { id: "R1", satisfied: false, evidence: "src/page.tsx still contains the old heading" },
    review.requirements[1]!,
  ] }), false, "concrete missing implementation still permits repair");
  assert.equal(completionReviewContradictsVerification({ ...input, verification: verificationResult([
    { ...input.verification.checks[0]!, source: "build" },
  ]) }, review), false, "new failures remain authoritative");
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

test("completion review parses fenced JSON without failing the coding run", () => {
  const requirements = [{ id: "R1", text: "Implement" }];
  const review = parseCompletionReview([
    "```json",
    JSON.stringify({
      passed: true,
      requirements: [{ id: "R1", satisfied: true, evidence: "diff proves it" }],
      summary: "complete",
    }),
    "```",
  ].join("\n"), requirements);
  assert.equal(review.passed, true);
  assert.equal(review.requirements[0]?.satisfied, true);
});

test("completion review recovers requirement-labelled prose from providers", () => {
  const requirements = [
    { id: "R1", text: "Implement" },
    { id: "R2", text: "Test" },
  ];
  const review = parseCompletionReview([
    "R1: satisfied - implementation is present in the diff",
    "R2: satisfied - focused deterministic tests are present",
    "Overall: passed",
  ].join("\n"), requirements);
  assert.equal(review.passed, true);
  assert.ok(review.requirements.every((item) => item.satisfied));
});

test("truncated JSON review cannot become false missing-requirement evidence", () => {
  const requirements = [
    { id: "R1", text: "Create endpoint" },
    { id: "R2", text: "Verify signature" },
    { id: "R3", text: "Add tests" },
  ];
  const truncated = '{"passed":false,"requirements":[{"id":"R1","satisfied":false,"evidence":"missing"},{"id":"R2","satisfied":false,"evidence":"missing"},{"id":"R3","satisfied":false,"evidence":"missing"}';
  const review = parseCompletionReview(truncated, requirements);
  assert.equal(review.protocolFailure, true);
  assert.equal(review.passed, false);
  assert.match(review.summary, /not parseable/i);
});

test("unstructured completion review becomes unresolved instead of throwing", () => {
  const requirements = [{ id: "R1", text: "Implement" }];
  const review = parseCompletionReview("Looks good to me.", requirements);
  assert.equal(review.passed, false);
  assert.equal(review.requirements[0]?.satisfied, false);
  assert.match(review.summary, /not parseable/i);
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
  assert.match(messages[0]!.content, /dispatch keys.*original task exactly/);
  assert.match(messages[0]!.content, /candidate-invented names are not evidence/);
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

test("malformed and incomplete review assessments are protocol failures, not missing implementation", () => {
  const requirements = [{ id: "R1", text: "Implement" }, { id: "R2", text: "Test" }];
  assert.equal(parseCompletionReview("Looks good.", requirements).protocolFailure, true);
  assert.equal(parseCompletionReview(JSON.stringify({ passed: true, requirements: [
    { id: "R1", satisfied: true, evidence: "diff" },
  ] }), requirements).protocolFailure, true);
  assert.equal(parseCompletionReview(JSON.stringify({ passed: false, requirements: [
    { id: "R1", satisfied: true, evidence: "diff" },
    { id: "R2", satisfied: false, evidence: "No test imports the changed implementation" },
  ] }), requirements).protocolFailure, undefined);
});

test("review infrastructure failure blocks success without inventing unsatisfied requirements", () => {
  const events = [{ type: "completion_review_failure", subtaskId: "task", classification: "OPERATIONAL_FAILURE" }];
  assert.equal(completionReviewGate("VERIFIED_SUCCESS", events).status, "NOT_FULLY_VERIFIED");
  assert.deepEqual(unresolvedCompletionReviews(events), [{ subtaskId: "task", requirementIds: ["review_unavailable"] }]);
});

test("completion checklist preserves requirements after the former eight-item boundary", () => {
  const clauses = Array.from({ length: 100 }, (_, index) => `Preserve distinct behavior ${index}`);
  const requirements = taskRequirementChecklist({ task: clauses.join("\n"), objective: "", integrationContract: "", acceptanceCriteria: [] });
  assert.equal(requirements.length, 100);
  assert.equal(requirements[0]!.text, clauses[0]);
  assert.equal(requirements.at(-1)!.text, clauses.at(-1));
});

test("completion review schema and tool decoding require explicit per-requirement assessments", async () => {
  const {completionReviewTool,completionReviewPayload}=await import('../src/agent/completionReview.js');
  const requirements=[{id:'R1',text:'Change the label'},{id:'R2',text:'Preserve the link'}];
  const tool=completionReviewTool(requirements);
  assert.equal(tool.type,'function');
  if(tool.type!=='function')throw Error('wrong tool');
  assert.equal(tool.function.strict,true);
  assert.deepEqual(tool.function.parameters?.required,['passed','requirements','summary']);
  const assessment={passed:true,requirements:requirements.map(({id})=>({id,satisfied:true,evidence:'Actual diff preserves requested constraints'})),summary:'complete'};
  const payload=completionReviewPayload({content:null,tool_calls:[{id:'review',type:'function',function:{name:'submit_completion_review',arguments:JSON.stringify(assessment)}}]});
  assert.equal(parseCompletionReview(payload,requirements).passed,true);
  assert.equal(parseCompletionReview(JSON.stringify({...assessment,requirements:assessment.requirements.slice(0,1)}),requirements).protocolFailure,true);
});

test('review gets authoritative script output and syntax instructions stay with deterministic verification',()=>{
 const messages=completionReviewMessages({task:'Implement behavior and run syntax checks.',requirements:[{id:'R1',text:'Implement behavior'}],diff:'diff',changedPaths:['src/a.cjs'],changedSymbols:[],workerExitStatus:'completed',verification:verificationResult([{command:'npm run typecheck',stdout:'> node --check src/a.cjs',stderr:'',exitCode:0,wallClockMs:1,timedOut:false,outcome:'CHECK_PASS',kind:'typecheck'}])});
 assert.ok(JSON.stringify(messages).includes('node --check src/a.cjs'));
 const checklist=taskRequirementChecklist({task:'Make the smallest change and run the relevant tests and syntax check.',objective:'Run syntax checks.',integrationContract:'',acceptanceCriteria:[]});
 assert.equal(checklist.length,1);assert.match(checklist[0]!.text,/smallest change/);
 assert.ok(!checklist.some(r=>/syntax check/i.test(r.text)));
});

test('verification timing noise does not change review evidence',()=>{
 const input:any={task:'Implement behavior',requirements:[{id:'R1',text:'Implement behavior'}],diff:'diff',changedPaths:['src/a.cjs'],changedSymbols:[],workerExitStatus:'completed'};
 const make=(duration:number)=>completionReviewMessages({...input,verification:verificationResult([{command:'npm run typecheck',stdout:`> node --check src/a.cjs\n# duration_ms: ${duration}\n# duration_ms ${duration}\n`,stderr:'',exitCode:0,wallClockMs:duration,timedOut:false,outcome:'CHECK_PASS',kind:'typecheck'}])});
 assert.deepEqual(make(1),make(999));
 assert.ok(JSON.stringify(make(1)).includes('node --check src/a.cjs'));
});

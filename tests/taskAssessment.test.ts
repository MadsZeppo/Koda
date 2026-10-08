import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  assessTask,
  taskAssessmentSchema,
  type AssessmentFacts,
} from "../src/router/taskAssessment.js";
import {
  assessmentReport,
  evaluateCases,
  fieldMetrics,
  outcomeSchema,
} from "../src/router/taskAssessmentEvaluation.js";
import { readAssessmentDataset } from "../src/dev/taskAssessmentEval.js";
import { runFakeProvider } from "../src/dev/fakeProvider.js";
import { fakeSmokeFixtures } from "../src/dev/fakeSmokeFixtures.js";
import {
  assessmentFromDecisionPayload,
  semanticTaskAssessmentSchema,
} from "../src/router/taskInterpreter.js";
const facts: AssessmentFacts = {
  files: ["src/label.tsx"],
  resolvedPaths: ["src/label.tsx"],
  relatedTests: [],
  components: ["ui"],
  localizationConfidence: "high",
  checks: [{ command: "npm run lint", kind: "lint", outcome: "CHECK_PASS" }],
};
const semantic = {
  semanticDifficulty: "hard",
  repoReasoning: "high",
  localizationDifficulty: "high",
  verificationStrength: "strong",
  consequenceRisk: "high",
  expectedChangeSize: "multi-component",
  startingTier: "strong",
  frontierJustified: false,
  confidence: 0.99,
  reason: "Semantic hypothesis",
} as const;
test("concrete requirements are separate from copied vocabulary and synchronous execution", () => {
  const copy = assessTask({
    task: "Replace 'Continue' with 'Secure synchronous database checkout'",
    facts,
  });
  assert.equal(copy.implementationComplexity, "trivial");
  assert.equal(copy.riskFlags.security, false);
  assert.equal(copy.riskFlags.database, false);
  assert.equal(copy.riskFlags.concurrency, false);
  assert.equal(
    assessTask({ task: "Convert this API to synchronous execution", facts })
      .riskFlags.concurrency,
    false,
  );
  const security = assessTask({
    task: "Verify an HMAC-SHA256 signature using a secret",
    facts,
  });
  assert.equal(security.riskFlags.security, true);
  assert.equal(security.consequenceRisk, "high");
  assert.ok(
    security.evidence.some(
      (e) =>
        e.dimension === "riskFlags.security" && e.description.includes("hmac"),
    ),
  );
  assert.equal(
    assessTask({
      task: "Prevent two simultaneous requests processing the same event",
      facts,
    }).riskFlags.concurrency,
    true,
  );
});
test("Danish replacement and concurrency/security requirements are recognized", () => {
  assert.equal(
    assessTask({
      task: "Ændrer navnet på headeren fra sample. til andet",
      facts,
    }).implementationComplexity,
    "trivial",
  );
  assert.equal(
    assessTask({
      task: "Undgå samtidige requests der behandler samme event",
      facts,
    }).riskFlags.concurrency,
    true,
  );
  assert.equal(
    assessTask({ task: "Verificér HMAC med en hemmelig nøgle", facts })
      .riskFlags.security,
    true,
  );
});
test("baseline health PASS does not upgrade feature/design verifiability", () => {
  assert.equal(
    assessTask({ task: "Add validation to the form", facts })
      .verificationStrength,
    "weak",
  );
  const ui = assessTask({ task: "Make the UI beautiful", facts });
  assert.equal(ui.verificationStrength, "weak");
  assert.equal(ui.projectHealthEvidence[0]?.outcome, "CHECK_PASS");
  assert.equal(
    assessTask({
      task: "Add validation",
      facts: { ...facts, behavioralEvidence: "structural" },
    }).verificationStrength,
    "medium",
  );
  assert.equal(
    assessTask({
      task: "Add validation",
      facts: {
        ...facts,
        checks: [
          {
            command: "node --test tests/validation.test.js",
            kind: "test",
            outcome: "CHECK_FAIL",
            taskSpecific: true,
          },
        ],
      },
    }).verificationStrength,
    "strong",
  );
  assert.equal(
    assessTask({
      task: "Add validation",
      facts: {
        ...facts,
        checks: [
          {
            command: "node --test tests/*.js",
            kind: "test",
            outcome: "CHECK_PASS",
          },
        ],
      },
    }).verificationStrength,
    "weak",
  );
});
test("new files, empty repositories and requested tests remain independent artifacts", () => {
  const created = assessTask({
    task: "Create a module and write tests for it",
    facts: {
      ...facts,
      files: [],
      resolvedPaths: ["sum.js"],
      components: [],
      localizationConfidence: "low",
    },
  });
  assert.deepEqual(created.artifactRequirements, {
    requiresNewFiles: true,
    requiresTests: true,
  });
  assert.equal(created.localizationDifficulty, "easy");
  const tested = assessTask({
    task: "Run tests after changing the label",
    facts,
  });
  assert.equal(tested.artifactRequirements.requiresTests, false);
});
test("semantic parsing rejects malformed labels, unjustified frontier and invalid confidence", () => {
  assert.throws(() =>
    semanticTaskAssessmentSchema.parse({ ...semantic, confidence: 2 }),
  );
  assert.throws(() =>
    semanticTaskAssessmentSchema.parse({
      ...semantic,
      semanticDifficulty: "impossible",
    }),
  );
  assert.throws(() =>
    semanticTaskAssessmentSchema.parse({
      ...semantic,
      startingTier: "frontier",
    }),
  );
});
test("grounded mechanical evidence beats unsupported semantic guesses and preserves conflicts", () => {
  const result = assessTask({
    task: "Change text from 'Old' to 'New'",
    facts,
    semantic,
  });
  assert.equal(result.scope, "tiny");
  assert.equal(result.implementationComplexity, "trivial");
  assert.equal(result.consequenceRisk, "low");
  assert.equal(result.localizationDifficulty, "easy");
  assert.ok(result.disagreements.length >= 3);
  assert.equal(result.mode, "semantic-assisted");
  assert.deepEqual(
    taskAssessmentSchema.parse(JSON.parse(JSON.stringify(result))),
    result,
  );
});
test("semantic confidence can refine uncertain implementation but cannot invent verification proof", () => {
  const result = assessTask({
    task: "Find the intermittent export bug",
    facts: {
      ...facts,
      resolvedPaths: [],
      components: [],
      localizationConfidence: "low",
    },
    semantic,
  });
  assert.equal(result.implementationComplexity, "high");
  assert.equal(result.verificationStrength, "weak");
  assert.ok(result.semanticRecommended);
  const untrusted = assessTask({
    task: "Find the intermittent export bug",
    facts: {
      ...facts,
      resolvedPaths: [],
      components: [],
      localizationConfidence: "low",
    },
    semantic: { ...semantic, confidence: 0.2 },
  });
  assert.equal(untrusted.implementationComplexity, "low");
  assert.ok(untrusted.confidence.overall < 0.7);
});
test("metrics calculate confusion, ordinal error, macro F1 and critical false negatives", () => {
  const binary = fieldMetrics(
    ["true", "true", "false", "false"],
    ["true", "false", "true", "false"],
    ["false", "true"],
  );
  assert.equal(binary.accuracy, 0.5);
  assert.equal(binary.macroF1, 0.5);
  assert.equal(binary.precision, 0.5);
  assert.equal(binary.recall, 0.5);
  assert.equal(binary.falseNegativeCount, 1);
  assert.equal(binary.falsePositiveCount, 1);
  const ordinal = fieldMetrics(
    ["trivial", "high"],
    ["low", "low"],
    ["trivial", "low", "medium", "high"],
    true,
  );
  assert.equal(ordinal.withinOneCategoryAccuracy, 0.5);
  assert.equal(ordinal.meanAbsoluteOrdinalError, 1.5);
  assert.equal(fieldMetrics([], [], ["false", "true"]).accuracy, null);
});
test("datasets are disjoint, bilingual and evaluable without changing source", async () => {
  const development = await readAssessmentDataset(
    "benchmarks/task-assessment/development.jsonl",
  );
  const holdout = await readAssessmentDataset(
    "benchmarks/task-assessment/holdout.jsonl",
  );
  assert.ok(development.length >= 30 && holdout.length >= 15);
  assert.ok(
    holdout.every(
      (row) =>
        !development.some(
          (other) => other.id === row.id || other.task === row.task,
        ),
    ),
  );
  for (const set of [development, holdout]) {
    assert.ok(
      set.some((row) => row.language === "da") &&
        set.some((row) => row.language === "en"),
    );
    const report = assessmentReport(await evaluateCases(set));
    assert.equal(report.caseCount, set.length);
    assert.ok(report.byStratum["language:da"]);
    assert.ok(report.fields["riskFlags.security"]);
    assert.ok(report.fields.implementationComplexity?.confusionMatrix);
  }
  const directory = await mkdtemp(join(tmpdir(), "koda-unseen-assessment-"));
  try {
    const file = join(directory, "unseen.jsonl");
    await writeFile(
      file,
      JSON.stringify({
        ...development[0],
        id: "external-new-id",
        task: "Change text from 'Hello' to 'Welcome'",
      }) + "\n",
    );
    assert.equal(
      (await evaluateCases(await readAssessmentDataset(file)))[0]?.assessment
        .implementationComplexity,
      "trivial",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("semantic evaluation reports protocol failures and outcomes exclude censored infrastructure from quality rates", async () => {
  const row = (
    await readAssessmentDataset("benchmarks/task-assessment/development.jsonl")
  )[0]!;
  const predictions = await evaluateCases([row], async () => {
    throw Error("malformed protocol");
  });
  const report = assessmentReport(predictions, [
    {
      taskId: row.id,
      model: "model",
      verifiedSuccess: true,
      modelFailure: false,
      censored: false,
      costUsd: 0.1,
      wallClockMs: 10,
    },
    {
      taskId: row.id,
      model: "model",
      verifiedSuccess: false,
      modelFailure: true,
      censored: false,
      failureReason: "provider timeout",
      costUsd: 0.2,
      wallClockMs: 20,
    },
  ]);
  assert.equal(report.semanticFailures.length, 1);
  assert.equal(
    report.predictiveValidity["model:trivial"]?.verifiedSuccessRate,
    1,
  );
  assert.equal(report.predictiveValidity["model:trivial"]?.censored, 1);
  assert.throws(() =>
    outcomeSchema.parse({
      taskId: "x",
      model: "m",
      verifiedSuccess: true,
      modelFailure: true,
      censored: false,
      costUsd: 0,
      wallClockMs: 0,
    }),
  );
});
test("shadow event/summary serialize assessment without changing real pipeline model, plan, scope or requests", async (t) => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  t.after(() => {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  });
  const directory = await mkdtemp(join(tmpdir(), "koda-assessment-shadow-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = fakeSmokeFixtures.edit!;
  const snapshots = [];
  for (const enabled of [false, true]) {
    const root = join(directory, String(enabled)),
      repo = join(root, "repo"),
      output = join(root, "report");
    for (const [path, content] of Object.entries(fixture.files)) {
      await mkdir(dirname(join(repo, path)), { recursive: true });
      await writeFile(join(repo, path), content);
    }
    const script = join(root, "script.json");
    await writeFile(script, JSON.stringify(fixture.script));
    await runFakeProvider({
      repo,
      task: fixture.task,
      script,
      output,
      taskAssessmentShadow: enabled,
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
    assert.equal(
      events.some((event) => event.type === "task_assessment"),
      enabled,
    );
    if (enabled)
      assert.deepEqual(
        taskAssessmentSchema.parse(summary.taskAssessment),
        events.find((event) => event.type === "task_assessment").assessment,
      );
    else assert.equal(summary.taskAssessment, null);
    snapshots.push({
      status: summary.status,
      strategy: summary.execution_strategy,
      scopes: events
        .filter((event) => event.type === "worker_scope")
        .map((event) => event.allowed_write_paths),
      calls: transcript.requests.map((request: any) => request.model),
    });
  }
  assert.equal(snapshots[0]?.status, "VERIFIED_SUCCESS");
  assert.deepEqual(snapshots[1], snapshots[0]);
});

test("unsupported risk vocabulary lowers confidence instead of silently becoming a confident negative", () => {
  const result = assessTask({
    task: "Review the credential handler",
    facts,
  });
  assert.ok(result.confidence.consequenceRisk < 0.7);
  assert.equal(result.semanticRecommended, true);
  assert.ok(
    result.evidence.some(
      (item) =>
        item.strength === "weak" &&
        item.description.includes("Possible security boundary"),
    ),
  );
});

test("security combines implementation actions and boundaries, not vocabulary or paths alone", () => {
  for (const task of [
    "Validate callback authenticity",
    "Check session expiry",
    "Require authentication in middleware",
    "Enforce caller permissions",
    "Prevent administrator privileges being granted to guests",
    "Rotér den hemmelige nøgle",
    "Validér nulstillingstoken til adgangskode",
  ]) {
    const result = assessTask({ task, facts });
    assert.equal(result.riskFlags.security, true, task);
    assert.equal(result.consequenceRisk, "high", task);
    assert.equal(result.securityAssessment.resolution, "security");
    assert.ok(
      result.evidence.some(
        (e) => e.dimension === "riskFlags.security" && e.strength === "strong",
      ),
    );
  }
  for (const task of [
    "Change text to Secure checkout",
    "Rename authStatus",
    "Document how to verify HMAC signatures",
    "Change the Login button copy",
    "Display a token count",
    "Ret teksten i adgangskodefeltets label",
    "Use asynchronous iteration",
    "Do not change authentication. Change the button label.",
  ]) {
    const result = assessTask({
      task,
      facts: { ...facts, resolvedPaths: ["src/auth/middleware.ts"] },
    });
    assert.equal(result.riskFlags.security, false, task);
    assert.equal(result.securityAssessment.resolution, "non_security", task);
  }
  const vagueToken = assessTask({ task: "Validate this token", facts });
  assert.equal(vagueToken.securityAssessment.resolution, "unresolved");
  assert.equal(vagueToken.riskFlags.security, false);
  assert.ok(vagueToken.confidence.consequenceRisk < 0.7);
  const mixed = assessTask({
    task: "Document authentication. Enforce permissions in the handler.",
    facts,
  });
  assert.equal(mixed.riskFlags.security, true);
  const ambiguous = assessTask({
    task: "Fix unexpected failures in this handler",
    facts: { ...facts, resolvedPaths: ["src/auth/middleware.ts"] },
  });
  assert.equal(ambiguous.securityAssessment.resolution, "unresolved");
  assert.equal(ambiguous.riskFlags.security, false);
  assert.ok(ambiguous.confidence.consequenceRisk < 0.7);
  assert.ok(
    ambiguous.evidence.some(
      (e) =>
        e.source === "localization" && e.dimension === "riskFlags.security",
    ),
  );
});

test("semantic security resolution is candidate-gated and cannot override concrete implementation or copy evidence", () => {
  const uncertainFacts = {
    ...facts,
    resolvedPaths: ["src/auth/middleware.ts"],
  };
  const securityAssessment = {
    resolution: "security",
    confidence: 0.95,
    evidence:
      "Handler checks caller identity at the localized authentication boundary.",
  } as const;
  const resolved = assessTask({
    task: "Fix unexpected failures in this handler",
    facts: uncertainFacts,
    semantic: { ...semantic, securityAssessment },
  });
  assert.equal(resolved.riskFlags.security, true);
  assert.equal(resolved.securityAssessment.resolution, "security");
  assert.equal(resolved.consequenceRisk, "high");
  assert.ok(
    resolved.evidence.some(
      (e) => e.source === "semantic" && e.dimension === "riskFlags.security",
    ),
  );
  const weak = assessTask({
    task: "Fix unexpected failures in this handler",
    facts: uncertainFacts,
    semantic: {
      ...semantic,
      securityAssessment: { ...securityAssessment, confidence: 0.5 },
    },
  });
  assert.equal(weak.riskFlags.security, false);
  assert.equal(weak.securityAssessment.resolution, "unresolved");
  const negative = assessTask({
    task: "Fix unexpected failures in this handler",
    facts: uncertainFacts,
    semantic: {
      ...semantic,
      securityAssessment: { ...securityAssessment, resolution: "non_security" },
    },
  });
  assert.equal(negative.securityAssessment.resolution, "non_security");
  for (const task of [
    "Rename authStatus",
    "Change text to Secure checkout",
    "Display a token count",
  ]) {
    const result = assessTask({
      task,
      facts,
      semantic: { ...semantic, securityAssessment },
    });
    assert.equal(result.riskFlags.security, false, task);
  }
  const positive = assessTask({
    task: "Verify signed requests",
    facts,
    semantic: {
      ...semantic,
      securityAssessment: { ...securityAssessment, resolution: "non_security" },
    },
  });
  assert.equal(positive.riskFlags.security, true);
  assert.ok(
    positive.disagreements.some((d) => d.dimension === "riskFlags.security"),
  );
  assert.throws(() =>
    assessTask({
      task: "Review credentials",
      facts,
      semantic: {
        ...semantic,
        securityAssessment: { ...securityAssessment, evidence: "" },
      },
    }),
  );
});

test("unresolved debugging entails investigation; dramatic wording does not raise a grounded local implementation", () => {
  const unknown = {
    ...facts,
    resolvedPaths: [],
    components: [],
    localizationConfidence: "low" as const,
  };
  for (const task of [
    "Investigate intermittent missing responses",
    "Track down random navigation failures",
    "Find why results occasionally disappear",
    "Undersøg hvorfor opdateringer forsvinder",
  ]) {
    const result = assessTask({ task, facts: unknown });
    assert.equal(result.implementationComplexity, "medium", task);
    assert.equal(result.localizationDifficulty, "hard");
    assert.ok(
      result.evidence.some(
        (e) =>
          e.dimension === "implementationComplexity" &&
          e.source === "localization",
      ),
    );
  }
  for (const task of [
    "Fix a catastrophic typo in this footer",
    "Debug the terrifying off-by-one in this helper",
  ]) {
    assert.equal(
      assessTask({ task, facts }).implementationComplexity,
      "low",
      task,
    );
  }
});

test("security holdout is independent, bilingual and includes meaningful positive/negative counts", async () => {
  const holdout = await readAssessmentDataset(
    "benchmarks/task-assessment/security-holdout.jsonl",
  );
  const dev = await readAssessmentDataset(
    "benchmarks/task-assessment/development.jsonl",
  );
  const old = await readAssessmentDataset(
    "benchmarks/task-assessment/holdout.jsonl",
  );
  const known = new Set([...dev, ...old].map((c) => c.task));
  assert.ok(holdout.length >= 30);
  assert.ok(holdout.filter((c) => c.expected.riskFlags.security).length >= 20);
  assert.ok(holdout.filter((c) => !c.expected.riskFlags.security).length >= 10);
  assert.ok(holdout.some((c) => c.language === "da"));
  assert.ok(holdout.every((c) => !known.has(c.task)));
  // Targets are measurements, not a reason to change gold labels or hide misses.
  const report = assessmentReport(await evaluateCases(holdout));
  assert.equal(report.caseCount, holdout.length);
  assert.ok(
    typeof report.fields["riskFlags.security"]?.falsePositiveCount === "number",
  );
});

test("existing semantic decision adapter resolves security only with explicit shadow context", () => {
  const answers = {
    semanticDifficulty: { type: "choice", choice: "normal", confidence: 0.9 },
    repoReasoning: { type: "choice", choice: "medium", confidence: 0.9 },
    localizationDifficulty: {
      type: "choice",
      choice: "medium",
      confidence: 0.9,
    },
    verificationStrength: { type: "choice", choice: "weak", confidence: 0.9 },
    consequenceRisk: { type: "choice", choice: "high", confidence: 0.9 },
    expectedChangeSize: {
      type: "choice",
      choice: "single-file",
      confidence: 0.9,
    },
    startingTier: { type: "choice", choice: "strong", confidence: 0.9 },
    frontierJustified: { type: "noul", noul: 0.02 },
    securityBoundary: { type: "choice", choice: "security", confidence: 0.95 },
  };
  const ordinary = assessmentFromDecisionPayload({ answers });
  assert.equal(ordinary.securityAssessment, undefined);
  const shadow = assessmentFromDecisionPayload({ answers }, 0.9, true);
  assert.equal(shadow.securityAssessment?.resolution, "security");
  assert.equal(shadow.securityAssessment?.confidence, 0.95);
  assert.deepEqual(
    { ...shadow, securityAssessment: undefined },
    { ...ordinary, securityAssessment: undefined },
  );
  assert.throws(() =>
    assessmentFromDecisionPayload(
      {
        answers: {
          ...answers,
          securityBoundary: {
            type: "choice",
            choice: "made-up",
            confidence: 1,
          },
        },
      },
      0.9,
      true,
    ),
  );
});

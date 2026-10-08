import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildVerificationContract,
  verificationContractSchema,
} from "../src/verifier/contract.js";
import {
  discriminationMetrics,
  executeContractCandidate,
  readContractDataset,
  evaluateVerificationContracts,
  type CandidateObservation,
} from "../src/verifier/contractEvaluation.js";
import { taskRequirementChecklist } from "../src/agent/completionReview.js";
import { runFakeProvider } from "../src/dev/fakeProvider.js";
import { fakeSmokeFixtures } from "../src/dev/fakeSmokeFixtures.js";

const requirement = (text: string) => [{ id: "stable-id", text }];
test("contract reuses completion checklist IDs and preserves provided planner requirements", () => {
  const task = "Change the label. Preserve the link. Run lint and typecheck.";
  const expected = taskRequirementChecklist({
    task,
    objective: "",
    integrationContract: "",
    acceptanceCriteria: [],
  });
  const contract = buildVerificationContract({ task });
  assert.deepEqual(
    contract.requirements.map((r) => ({
      id: r.requirementId,
      text: r.requirement,
    })),
    expected,
  );
  assert.deepEqual(contract.requiredProjectChecks.sort(), [
    "lint",
    "typecheck",
  ]);
  assert.equal(
    buildVerificationContract({
      task: "Do work",
      requirements: requirement("Function returns 42"),
    }).requirements[0]?.requirementId,
    "stable-id",
  );
  assert.throws(() =>
    buildVerificationContract({
      task,
      requirements: [...requirement("one"), ...requirement("two")],
    }),
  );
});
test("behavioral requirements propose targeted proof, not a passing observation", () => {
  const result = buildVerificationContract({
    task: "Invalid signature returns 401",
  }).requirements[0]!;
  assert.deepEqual(result.methods, ["targeted_test"]);
  assert.equal(result.strength, "strong");
  assert.equal(result.critical, true);
  assert.equal(result.blocking, true);
  assert.equal(
    buildVerificationContract({ task: "Delete only expired records" })
      .requirements[0]?.critical,
    true,
  );
  assert.equal(result.proofAvailability, "planned");
  assert.equal(result.falseAcceptRisk, "medium");
});
test("generic project-health evidence never discharges a behavioral requirement", () => {
  const text = "Function returns 42";
  const result = buildVerificationContract({
    task: text,
    requirements: requirement(text),
    projectChecks: [
      { command: "tsc --noEmit", kind: "typecheck" },
      { command: "npm run lint", kind: "lint" },
      { command: "npm run build", kind: "build" },
    ],
    proofs: [
      {
        requirementId: "stable-id",
        method: "typecheck",
        command: "tsc --noEmit",
        description: "Generic health passed",
        available: true,
      },
    ],
  });
  assert.equal(result.requirements[0]?.proofAvailability, "planned");
  assert.equal(result.requirements[0]?.falseAcceptRisk, "medium");
  assert.ok(
    result.requirements[0]?.evidence.some((e) => e.source === "project_health"),
  );
  assert.deepEqual(result.requiredProjectChecks.sort(), [
    "build",
    "lint",
    "typecheck",
  ]);
  const unknown = buildVerificationContract({
    task: "Improve unspecified behavior",
    projectChecks: [{ command: "tsc", kind: "typecheck" }],
  });
  assert.equal(unknown.overallStrength, "weak");
  assert.equal(unknown.overallFalseAcceptRisk, "high");
});
test("requirement-bound behavioral coverage and repository inspection have distinct strengths", () => {
  const text = "Function returns 42";
  const strong = buildVerificationContract({
    task: text,
    requirements: requirement(text),
    proofs: [
      {
        requirementId: "stable-id",
        method: "targeted_test",
        description: "Asserts requested input and output",
        available: true,
        command: "node --test tests/value.test.cjs",
      },
    ],
  });
  assert.equal(strong.overallStrength, "strong");
  assert.equal(strong.overallFalseAcceptRisk, "low");
  assert.equal(strong.requirements[0]?.proofAvailability, "available");
  const medium = buildVerificationContract({
    task: "Reuse the repository abstraction",
  });
  assert.equal(medium.overallStrength, "medium");
  assert.deepEqual(medium.requirements[0]?.methods, [
    "static_check",
    "semantic_review",
  ]);
  assert.throws(() =>
    buildVerificationContract({
      task: text,
      proofs: [
        {
          requirementId: "unknown",
          method: "targeted_test",
          description: "wrong requirement",
          available: true,
        },
      ],
    }),
  );
});
test("subjective and architectural quality stay weak despite available health checks", () => {
  const visual = buildVerificationContract({
    task: "Make the landing page feel premium",
  });
  assert.equal(visual.overallStrength, "weak");
  assert.equal(visual.overallFalseAcceptRisk, "high");
  assert.deepEqual(visual.requirements[0]?.methods.sort(), [
    "semantic_review",
    "visual_review",
  ]);
  const architecture = buildVerificationContract({
    task: "Improve architectural quality",
  });
  assert.deepEqual(architecture.requirements[0]?.methods.sort(), [
    "manual_only",
    "semantic_review",
  ]);
  const mixed = buildVerificationContract({
    task: "Make the page premium. Function returns 42.",
  });
  assert.equal(mixed.overallStrength, "weak");
  assert.equal(mixed.overallFalseAcceptRisk, "high");
});
test("Danish behavior, critical duplicates and explicit project commands are retained", () => {
  const result = buildVerificationContract({
    task: "Afvis ugyldige sessioner. Samtidige dubletter må ikke accepteres. Kør tests, lint og build.",
  });
  assert.ok(result.requirements.every((r) => r.critical && r.blocking));
  assert.deepEqual(result.requiredProjectChecks.sort(), [
    "build",
    "lint",
    "tests",
  ]);
  assert.deepEqual(
    verificationContractSchema.parse(JSON.parse(JSON.stringify(result))),
    result,
  );
});
test("eval counts false accepts and critical false accepts; unresolved is never fake acceptance", () => {
  const row = (
    expected: "GOOD" | "BAD",
    observed: CandidateObservation["observed"],
    critical = false,
  ): CandidateObservation => ({
    caseId: "task",
    candidateId: "candidate",
    expected,
    observed,
    critical,
    strength: "strong",
    healthPassed: true,
    status: "VERIFIED_SUCCESS",
    checks: [],
    reason: "fixture",
  });
  const m = discriminationMetrics([
    row("GOOD", "ACCEPT"),
    row("GOOD", "REJECT"),
    row("BAD", "ACCEPT", true),
    row("BAD", "REJECT"),
    row("BAD", "UNRESOLVED"),
  ]);
  assert.equal(m.correctCandidateAcceptRate, 0.5);
  assert.equal(m.falseRejectRate, 0.5);
  assert.equal(m.incorrectCandidateRejectRate, 1 / 3);
  assert.equal(m.falseAcceptRate, 1 / 3);
  assert.equal(m.criticalFalseAccepts, 1);
  assert.equal(m.unresolvedBad, 1);
  assert.equal(discriminationMetrics([]).falseAcceptRate, null);
});
test("real verifier accepts GOOD and rejects compiling wrong behavior with immutable independent proof", async () => {
  const row = (
    await readContractDataset(
      "benchmarks/verification-contract/development.jsonl",
    )
  )[0]!;
  const contract = buildVerificationContract(row);
  const good = await executeContractCandidate(
    row,
    row.candidates[0]!,
    contract,
  );
  const bad = await executeContractCandidate(row, row.candidates[1]!, contract);
  assert.equal(good.observed, "ACCEPT");
  assert.equal(bad.observed, "REJECT");
  assert.equal(bad.healthPassed, true);
  assert.ok(bad.checks.length > 1);
  await assert.rejects(
    executeContractCandidate(
      row,
      {
        ...row.candidates[0]!,
        files: { "proof/contract.test.cjs": "process.exit(0)" },
      },
      contract,
    ),
    /overwrite independent proof/,
  );
  await assert.rejects(
    executeContractCandidate(
      row,
      { ...row.candidates[0]!, files: { "../escape.cjs": "" } },
      contract,
    ),
    /Unsafe fixture path/,
  );
});
test("weak requirements and absent proof remain unresolved even when the real verifier passes health", async () => {
  const row = (
    await readContractDataset(
      "benchmarks/verification-contract/development.jsonl",
    )
  ).find((r) => r.category === "subjective_ui")!;
  const observed = await executeContractCandidate(
    row,
    row.candidates[0]!,
    buildVerificationContract(row),
  );
  assert.equal(observed.healthPassed, true);
  assert.equal(observed.status, "VERIFIED_SUCCESS");
  assert.equal(observed.observed, "UNRESOLVED");
});
test("new external dataset works without source changes and holdout remains separate", async (t) => {
  const dev = await readContractDataset(
      "benchmarks/verification-contract/development.jsonl",
    ),
    hold = await readContractDataset(
      "benchmarks/verification-contract/holdout.jsonl",
    );
  assert.ok(
    hold.every((h) => !dev.some((d) => d.id === h.id || d.task === h.task)),
  );
  assert.ok([...dev, ...hold].some((r) => r.language === "da"));
  assert.ok([...dev, ...hold].some((r) => r.critical));
  const root = await mkdtemp(join(tmpdir(), "koda-contract-external-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "external.json");
  await writeFile(
    path,
    JSON.stringify([{ ...dev[0], id: "externally-provided-task" }]),
  );
  const report = await evaluateVerificationContracts(
    await readContractDataset(path),
  );
  assert.equal(report.discrimination.falseAcceptRate, 0);
  assert.equal(report.discrimination.correctCandidateAcceptRate, 1);
  assert.equal(report.planningQuality.exactMethodSetAccuracy, 1);
  assert.ok(report.planningOverheadMs.p95! >= 0);
});
test("shadow contract event and summary do not alter real pipeline requests, scope, verification or final status", async (t) => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  t.after(() => {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  });
  const directory = await mkdtemp(join(tmpdir(), "koda-contract-shadow-"));
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
      verificationContractShadow: enabled,
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
      events.some((event) => event.type === "verification_contract"),
      enabled,
    );
    if (enabled)
      assert.deepEqual(
        verificationContractSchema.parse(summary.verificationContract),
        events.find((e) => e.type === "verification_contract").contract,
      );
    else assert.equal(summary.verificationContract, null);
    snapshots.push({
      status: summary.status,
      strategy: summary.execution_strategy,
      requests: transcript.requests.map((request: any) => {
        const { session_id, ...payload } = request.payload;
        return { ...request, payload };
      }),
      scopes: events
        .filter((e) => e.type === "worker_scope")
        .map((e) => e.allowed_write_paths),
      checks: summary.verification?.checks?.map((c: any) => ({
        command: c.command,
        outcome: c.outcome,
      })),
    });
  }
  assert.equal(snapshots[0]?.status, "VERIFIED_SUCCESS");
  assert.deepEqual(snapshots[1], snapshots[0]);
});

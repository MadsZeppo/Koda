import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeModelBoard,
  chooseAdaptiveRecovery,
  effectiveRecoveryFailureMode,
  freezeExecutionPolicy,
  requiredQualityClass,
  type ControlCandidate,
  type FrozenExecutionPolicy,
} from "../src/router/controlPolicy.js";
import type { TaskFingerprint } from "../src/router/taskFingerprint.js";
import { impactAwareVerificationSelection } from "../src/verifier/selection.js";
import type { VerificationCandidate } from "../src/repo/ecosystem.js";
import { codingContextPacket } from "../src/agent/codingExecutor.js";

const fingerprint = (
  overrides: Partial<TaskFingerprint> = {},
): TaskFingerprint => ({
  primary: "implementation",
  secondary: [],
  languages: ["typescript"],
  frameworks: [],
  scope: "single",
  effort: "tiny",
  executionStrategy: "direct",
  visualRelevant: false,
  browserRelevant: false,
  terminalHeavy: false,
  repoReasoningHeavy: false,
  architectureHeavy: false,
  toolsRequired: true,
  visionRequired: false,
  verificationStrength: "strong",
  confidence: "high",
  reasons: [],
  difficulty: {
    technicalComplexity: "low",
    visualComplexity: "low",
    architecturalComplexity: "low",
    interactionComplexity: "low",
    repoReasoningComplexity: "low",
    changeRisk: "low",
    contextUncertainty: "low",
  },
  ...overrides,
});

const candidate = (
  id: string,
  tier: ControlCandidate["model"]["tier"],
  quality: number,
  cost: number,
  evidenceLevel: ControlCandidate["evidenceLevel"] = "SUPPORTED",
  latency = 1000,
): ControlCandidate => ({
  model: { id, tier },
  quality,
  conservativeQuality: quality,
  evidenceLevel,
  observationCount: evidenceLevel === "UNKNOWN" ? 0 : 8,
  expectedAttemptCost: cost,
  conservativeAttemptCost: cost * 1.2,
  expectedAttemptLatencyMs: latency,
  operationalErrorRate: 0,
  tokenEfficiency: { p90TotalTokens: Math.round(cost * 100_000) + 100 },
});

const policy = (
  approved: ControlCandidate[],
  maxCodingAttempts = 3,
): FrozenExecutionPolicy =>
  freezeExecutionPolicy({
    id: "policy",
    taskFingerprint: fingerprint(),
    qualityClass: "LOW",
    requiredQuality: 0.9,
    verificationStrength: "strong",
    approvedCandidateSet: approved,
    activeBoard: activeModelBoard(approved, 8).board,
    referenceModel: approved.at(-1)!.model.id,
    initialModel: approved[0]!.model.id,
    totalBudgetUsd: 0.3,
    latencyBudgetMs: 30_000,
    maxCodingAttempts,
    maxScoutCalls: 0,
    providerConstraints: { sessionSticky: true },
    writeScopes: ["src/value.ts"],
    verificationContract: { required: true },
    stopConditions: ["verified", "plan exhausted"],
  });

const check = (
  kind: VerificationCandidate["kind"],
  command: string,
  requirement?: VerificationCandidate["requirement"],
): VerificationCandidate => ({
  kind,
  command,
  cwd: ".",
  source: "fixture",
  confidence: 1,
  available: true,
  requirement,
  mutatesSource: false,
  requiresInstalledDependencies: false,
});

test("quality class follows task risk and verification strength rather than model names", () => {
  assert.equal(requiredQualityClass(fingerprint()), "LOW");
  assert.equal(
    requiredQualityClass(fingerprint({ scope: "multi-file" })),
    "MEDIUM",
  );
  assert.equal(
    requiredQualityClass(fingerprint({ verificationStrength: "weak" })),
    "HIGH",
  );
  assert.equal(
    requiredQualityClass(fingerprint({ publicApiRisk: true })),
    "HIGH",
  );
});

test("active board stays bounded and unknown models remain challengers without quality claims", () => {
  const models = Array.from({ length: 30 }, (_, index) =>
    candidate(
      `vendor/model-${index}`,
      index % 2 ? "cheap" : "strong",
      0.7 + index / 1000,
      0.001 + index / 100_000,
      index === 29 ? "UNKNOWN" : "SUPPORTED",
    ),
  );
  const board = activeModelBoard(models, 5);
  assert.ok(board.approved.length <= 5);
  assert.ok(board.approved.some((entry) => entry.model.id === "vendor/model-29"),
    "one economically promising unknown model keeps a protected evaluation slot");
  const unknown = activeModelBoard(
    [
      candidate("vendor/reference", "strong", 0.95, 0.02, "PROVEN"),
      candidate("vendor/new", "cheap", 0.94, 0.001, "UNKNOWN"),
    ],
    5,
  ).board.find((entry) => entry.candidate.model.id === "vendor/new");
  assert.equal(unknown?.lifecycle, "UNKNOWN");
});

test("frozen policy protects budget, candidate universe, quality and safety contracts", () => {
  const frozen = policy([
    candidate("a", "cheap", 0.9, 0.01),
    candidate("b", "strong", 0.96, 0.03),
  ]);
  assert.equal(Object.isFrozen(frozen), true);
  assert.equal(Object.isFrozen(frozen.approvedCandidateSet), true);
  assert.equal(Object.isFrozen(frozen.writeScopes), true);
  assert.throws(() => ((frozen as any).totalBudgetUsd = 99), TypeError);
  assert.throws(
    () =>
      (frozen.approvedCandidateSet as any[]).push(
        candidate("c", "frontier", 0.99, 0.1),
      ),
    TypeError,
  );
  assert.throws(() => (frozen.writeScopes as string[]).push("."), TypeError);
});

test("adaptive recovery uses the observed failure mode inside the frozen set", () => {
  const first = candidate("first", "cheap", 0.9, 0.01, "SUPPORTED", 800);
  const efficient = candidate(
    "efficient",
    "strong",
    0.95,
    0.012,
    "SUPPORTED",
    1200,
  );
  efficient.tokenEfficiency.p90TotalTokens = 200;
  const reliable = candidate("reliable", "cheap", 0.91, 0.02, "PROVEN", 500);
  const frozen = policy([first, efficient, reliable]);
  const noMutation = chooseAdaptiveRecovery(
    frozen,
    {
      failureMode: "no_mutation",
      failurePhase: "DISCOVERY",
      previousModel: "first",
      mutationObserved: false,
    },
    new Set(["first"]),
  );
  const provider = chooseAdaptiveRecovery(
    frozen,
    {
      failureMode: "operational",
      failurePhase: "PROVIDER",
      previousModel: "first",
      mutationObserved: false,
    },
    new Set(["first"]),
  );
  assert.equal(
    noMutation?.model.id,
    "efficient",
    "coding recovery cannot quality-downgrade",
  );
  assert.equal(
    provider?.model.id,
    "efficient",
    "operational recovery chooses the cheapest quality-safe frozen candidate",
  );
  assert.ok(
    frozen.approvedCandidateSet.some(
      (entry) => entry.model.id === noMutation?.model.id,
    ),
  );
});

test("operational recovery ignores prior tier and selects the cheapest quality-safe candidate", () => {
  const failedStrong = candidate(
    "failed-strong",
    "strong",
    0.93,
    0.03,
    "SUPPORTED",
    1400,
  );
  const cheapSafe = candidate(
    "cheap-safe",
    "cheap",
    0.91,
    0.004,
    "SUPPORTED",
    900,
  );
  const expensiveStrong = candidate(
    "expensive-strong",
    "strong",
    0.95,
    0.02,
    "PROVEN",
    700,
  );
  const frozen = policy([failedStrong, cheapSafe, expensiveStrong]);

  const selected = chooseAdaptiveRecovery(
    frozen,
    {
      failureMode: "operational",
      failurePhase: "PROVIDER",
      previousModel: failedStrong.model.id,
      mutationObserved: false,
    },
    new Set([failedStrong.model.id]),
  );

  assert.equal(selected?.model.id, cheapSafe.model.id);
});

test("discovery recovery cannot jump to an expensive model on a low-cost task", () => {
  const initial = candidate("openai/gpt-5.1-codex-mini", "cheap", .91, .002);
  const cheapRecovery = candidate("deepseek/deepseek-v3.2", "cheap", .92, .006);
  const expensive = candidate("openai/gpt-5.5", "frontier", .98, .08);
  const frozen = freezeExecutionPolicy({
    ...policy([initial, expensive, cheapRecovery]),
    qualityCascadeModelIds: [initial.model.id, expensive.model.id, cheapRecovery.model.id],
  });
  const selected = chooseAdaptiveRecovery(frozen, {
    failureMode: "discovery_limit",
    failurePhase: "DISCOVERY",
    previousModel: initial.model.id,
    mutationObserved: false,
    codingAttempts: 0,
  }, new Set([initial.model.id]));
  assert.equal(selected?.model.id, cheapRecovery.model.id);
});

test("operational recovery follows the frozen economic order before semantic escalation", () => {
  const initial = candidate("initial", "cheap", 0.91, 0.002);
  const economicalPeer = candidate("economical-peer", "fast", 0.91, 0.003);
  const secondPeer = candidate("second-peer", "strong", 0.93, 0.01);
  const semanticRescue = candidate("semantic-rescue", "frontier", 0.98, 0.08);
  const frozen = freezeExecutionPolicy({
    ...policy([initial, semanticRescue, secondPeer, economicalPeer]),
    qualityCascadeModelIds: [initial.model.id, semanticRescue.model.id],
    operationalRecoveryModelIds: [economicalPeer.model.id, secondPeer.model.id],
    orderedRecoveryModelIds: [economicalPeer.model.id, secondPeer.model.id],
  });
  const first = chooseAdaptiveRecovery(frozen, {
    failureMode: "operational",
    failurePhase: "PROVIDER",
    previousModel: initial.model.id,
    mutationObserved: false,
  }, new Set([initial.model.id]));
  const second = chooseAdaptiveRecovery(frozen, {
    failureMode: "operational",
    failurePhase: "PROVIDER",
    previousModel: economicalPeer.model.id,
    mutationObserved: false,
  }, new Set([initial.model.id, economicalPeer.model.id]));
  const semantic = chooseAdaptiveRecovery(frozen, {
    failureMode: "test_failure",
    failurePhase: "VERIFICATION",
    previousModel: initial.model.id,
    mutationObserved: true,
  }, new Set([initial.model.id]));
  assert.equal(first?.model.id, economicalPeer.model.id);
  assert.equal(second?.model.id, secondPeer.model.id);
  assert.equal(semantic?.model.id, semanticRescue.model.id);
});

test("an explicit operational peer is tried before the quality rescue but cannot receive coding recovery", () => {
  const initial = candidate("initial", "cheap", 0.78, 0.001);
  const peer = candidate("sideways", "cheap", 0.76, 0.002);
  const rescue = candidate("rescue", "frontier", 0.96, 0.08);
  const frozen = freezeExecutionPolicy({
    ...policy([initial, rescue, peer]),
    requiredQuality: 0.9,
    qualityCascadeModelIds: [initial.model.id, rescue.model.id],
    operationalRecoveryModelIds: [peer.model.id],
  });

  const operational = chooseAdaptiveRecovery(
    frozen,
    {
      failureMode: "operational",
      failurePhase: "PROVIDER",
      previousModel: initial.model.id,
      mutationObserved: false,
    },
    new Set([initial.model.id]),
  );
  const coding = chooseAdaptiveRecovery(
    frozen,
    {
      failureMode: "test_failure",
      failurePhase: "VERIFICATION",
      previousModel: initial.model.id,
      mutationObserved: true,
    },
    new Set([initial.model.id]),
  );

  assert.equal(operational?.model.id, peer.model.id);
  assert.equal(coding?.model.id, rescue.model.id);
});

test("direct edit protocol errors are operational even when the executor reports no mutation", () => {
  assert.equal(
    effectiveRecoveryFailureMode({
      failureMode: "no_mutation",
      failurePhase: "DISCOVERY",
      previousModel: "any-model",
      mutationObserved: false,
      terminationReason: "direct_edit_protocol_error",
    }),
    "operational",
  );
  assert.equal(
    effectiveRecoveryFailureMode({
      failureMode: "no_mutation",
      failurePhase: "DISCOVERY",
      previousModel: "any-model",
      mutationObserved: false,
      terminationReason: "RepeatedFormatError",
    }),
    "operational",
  );
});

test("operational retries do not consume the coding-failure attempt budget", () => {
  const first = candidate("first", "cheap", 0.94, 0.01);
  const fallback = candidate("fallback", "strong", 0.96, 0.02);
  const frozen = policy([first, fallback], 1);
  assert.equal(
    chooseAdaptiveRecovery(
      frozen,
      {
        failureMode: "operational",
        failurePhase: "PROVIDER",
        previousModel: first.model.id,
        mutationObserved: false,
        codingAttempts: 0,
        terminationReason: "provider timeout",
      },
      new Set([first.model.id]),
    )?.model.id,
    fallback.model.id,
  );
  assert.equal(
    chooseAdaptiveRecovery(
      frozen,
      {
        failureMode: "no_mutation",
        failurePhase: "DISCOVERY",
        previousModel: first.model.id,
        mutationObserved: false,
        codingAttempts: 1,
      },
      new Set([first.model.id]),
    ),
    undefined,
  );
});

test("recovery is bounded and model identifiers have no policy privilege", () => {
  const run = (firstId: string, nextId: string) => {
    const first = candidate(firstId, "cheap", 0.9, 0.01);
    const next = candidate(nextId, "strong", 0.96, 0.02);
    return chooseAdaptiveRecovery(
      policy([first, next]),
      {
        failureMode: "test_failure",
        failurePhase: "VERIFICATION_ATTEMPTED",
        previousModel: firstId,
        mutationObserved: true,
      },
      new Set([firstId]),
    )?.model.id;
  };
  assert.equal(run("arbitrary-a", "arbitrary-b"), "arbitrary-b");
  assert.equal(run("renamed-a", "renamed-b"), "renamed-b");
  const frozen = policy(
    [candidate("a", "cheap", 0.9, 0.01), candidate("b", "strong", 0.96, 0.02)],
    1,
  );
  assert.equal(
    chooseAdaptiveRecovery(
      frozen,
      {
        failureMode: "no_mutation",
        failurePhase: "DISCOVERY",
        previousModel: "a",
        mutationObserved: false,
      },
      new Set(["a"]),
    ),
    undefined,
  );
});

test("safe test-only impact selects exact tests while retaining non-test dimensions", () => {
  const result = impactAwareVerificationSelection({
    changedPaths: ["tests/route.test.ts"],
    focusedCommands: ["pnpm exec tsx --test 'tests/route.test.ts'"],
    candidates: [
      check("test", "pnpm test", "required"),
      check("typecheck", "pnpm typecheck"),
      check("build", "pnpm build"),
    ],
  });
  assert.equal(result.whyFullSuite, false);
  assert.deepEqual(result.impactedTests, ["tests/route.test.ts"]);
  assert.deepEqual(
    result.candidates.map((entry) => entry.kind),
    ["typecheck", "build"],
  );
});

test("source impact needs inspected relationships and never trusts filenames alone", () => {
  const input = {
    changedPaths: ["src/route.ts"],
    focusedCommands: ["node --test tests/route.test.ts"],
    candidates: [
      check("test", "pnpm test"),
      check("typecheck", "pnpm typecheck"),
    ],
  };
  const filenameOnly = impactAwareVerificationSelection(input);
  assert.equal(filenameOnly.whyFullSuite, true);
  assert.equal(filenameOnly.candidates.length, 2);
  const backed = impactAwareVerificationSelection({
    ...input,
    relationships: [
      {
        source: "src/route.ts",
        tests: ["tests/route.test.ts"],
        basis: "import",
      },
    ],
  });
  assert.equal(backed.whyFullSuite, false);
  assert.deepEqual(backed.impactedTests, ["tests/route.test.ts"]);
  assert.deepEqual(
    backed.candidates.map((entry) => entry.kind),
    ["typecheck"],
  );
});

test("risky changes and required failing dimensions can never be silently skipped", () => {
  const requiredTest = check("test", "pnpm test", "required");
  const risky = impactAwareVerificationSelection({
    changedPaths: ["package.json", "tests/package.test.ts"],
    focusedCommands: ["node --test tests/package.test.ts"],
    candidates: [requiredTest, check("typecheck", "pnpm typecheck")],
  });
  assert.equal(risky.whyFullSuite, true);
  assert.ok(risky.candidates.includes(requiredTest));
  const uncertain = impactAwareVerificationSelection({
    changedPaths: ["src/public.ts"],
    focusedCommands: ["node --test tests/public.test.ts"],
    candidates: [requiredTest],
    fingerprint: fingerprint({ publicApiRisk: true }),
    relationships: [
      {
        source: "src/public.ts",
        tests: ["tests/public.test.ts"],
        basis: "symbol",
      },
    ],
  });
  assert.equal(uncertain.whyFullSuite, true);
  assert.deepEqual(uncertain.candidates, [requiredTest]);
});

test("repair context keeps current definitions and errors without repeated generic evidence", () => {
  const context = {
    files: [
      { path: "src/value.ts", snippet: "export const value = 1" },
      { path: "src/dependency.ts", snippet: "export interface Dependency {}" },
      { path: "docs/irrelevant.md", snippet: "large unrelated context" },
    ],
    localDependencies: ["src/dependency.ts"],
    repoMap: [],
  };
  const evidence = {
    relevantFiles: context.files.map((file) => file.path),
    symbols: ["value"],
    reproduction: "pnpm typecheck",
    failingTests: [],
    likelyRootCause: "wrong API",
    dependencies: [],
    uncertainty: "low" as const,
    suggestedApproach: "repair",
    evidence: ["repository-derived"],
  };
  const initial = codingContextPacket({
    context,
    evidence,
    writeScope: ["src/value.ts"],
    repair: false,
  });
  const repair = codingContextPacket({
    context,
    evidence,
    writeScope: ["src/value.ts"],
    diagnostics: "src/dependency.ts: missing member",
    previousFailedDiff: "diff",
    repair: true,
  });
  assert.equal(initial.sourceFiles?.length, 3);
  assert.deepEqual(
    repair.sourceFiles?.map((file) => file.path),
    ["src/value.ts", "src/dependency.ts"],
  );
  assert.equal(repair.evidence, undefined);
  assert.equal(repair.previousFailedDiff, "diff");
});

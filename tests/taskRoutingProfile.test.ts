import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFeatures } from "../src/router/features.js";
import { taskFingerprint } from "../src/router/taskFingerprint.js";
import type { Subtask } from "../src/planner/schemas.js";
import type { RepoProfile, VerificationResult } from "../src/types.js";

const work = (objective: string, paths: string[], commands: string[] = []): Subtask => ({
  id: "change", title: objective, objective, likelyReadPaths: paths, likelyWritePaths: paths,
  dependsOn: [], integrationContract: "preserve behavior", verificationCommands: commands,
  estimatedDifficulty: "normal", parallelSafe: true,
});
const profile = (files: string[]): RepoProfile => ({
  root: "/fixture", commit: "baseline", status: "", diff: "", files,
  topLevel: [], extensions: {}, symbols: [], packageManager: "generic", scripts: {}, configs: {},
  verificationCommands: [],
});
const checked = (command: string, outcome: "CHECK_PASS" | "CHECK_FAIL" | "INFRA_FAILURE"): VerificationResult => ({
  status: outcome === "CHECK_PASS" ? "VERIFIED_SUCCESS" : "NOT_FULLY_VERIFIED",
  checks: [{ command, outcome, exitCode: outcome === "CHECK_PASS" ? 0 : 1,
    stdout: "", stderr: "", wallClockMs: 1, timedOut: false }],
  failedChecks: outcome === "CHECK_PASS" ? 0 : 1, failingTests: null, buildErrors: null,
});

test("a localized implementation plus companion test remains low-risk across source/test directories", () => {
  const paths = ["lib/calculate.py", "checks/test_calculate.py"];
  const task = work("Fix incorrect rounding and add a regression test. Do not redesign the architecture.", paths);
  const repo = profile(paths);
  const evidence = checked("python -m pytest checks/test_calculate.py::test_rounding", "CHECK_FAIL");
  const features = extractFeatures(task, repo, 1100, evidence, "stable");
  const fp = taskFingerprint(task, repo, features, "normal", evidence);
  assert.equal(features.isTestWork, false);
  assert.equal(features.requiresCrossModuleReasoning, false);
  assert.equal(features.requiresArchitectureReasoning, false);
  assert.equal(features.isLocalized, true);
  assert.equal(fp.scope, "localized");
  assert.equal(fp.verificationStrength, "strong");
  assert.equal(fp.difficulty.changeRisk, "low");
  assert.equal(fp.localizationConfidence, "high");
  assert.equal(fp.expectedFiles, 2);
  assert.equal(fp.observedCheckFailures, 1);
});

test("test intent is determined from objective and accepts deterministic unit-test wording", () => {
  const paths = ["validation/scoring.spec.ts"];
  const task = { ...work("Add a deterministic unit test that checks the response metadata.", paths), title: "Response metadata" };
  const repo = profile(paths);
  const features = extractFeatures(task, repo, 800);
  const fp = taskFingerprint(task, repo, features, "normal");
  assert.equal(features.taskKind, "test");
  assert.equal(features.taskType, "test");
  assert.equal(fp.primary, "testing");
  const feature = work("Add a cache expiration setting. Add focused regression tests.", ["lib/cache.ts"]);
  const featureRepo = profile(feature.likelyWritePaths);
  const featureFacts = extractFeatures(feature, featureRepo, 800);
  assert.equal(featureFacts.isTestWork, false);
  assert.equal(taskFingerprint(feature, featureRepo, featureFacts, "normal").primary, "implementation");
});

test("unlocalized task is uncertain even with a large context packet and a short prompt", () => {
  const task = work("Correct the behavior", []);
  const repo = profile(["lib/a.ts", "lib/b.ts"]);
  const features = extractFeatures(task, repo, 64000);
  const fp = taskFingerprint(task, repo, features, "normal");
  assert.equal(features.isLocalized, false);
  assert.equal(fp.taskType, "ambiguous");
  assert.equal(fp.localizationConfidence, "low");
  assert.equal(fp.difficulty.contextUncertainty, "high");
  assert.equal(fp.contextRequirementTokens, 16000);
});

test("genuine coupled architecture stays difficult and infrastructure does not count as coding evidence", () => {
  const paths = ["services/auth/session.go", "services/store/access.go"];
  const task = work("Migrate authorization state across services", paths);
  const repo = profile(paths);
  const evidence = checked("go test ./services/...", "INFRA_FAILURE");
  const features = extractFeatures(task, repo, 4000, evidence);
  const fp = taskFingerprint(task, repo, features, "normal", evidence);
  assert.equal(fp.taskType, "migration");
  assert.equal(fp.scope, "cross-component");
  assert.equal(fp.difficulty.technicalComplexity, "high");
  assert.equal(features.hasFailingTests, false);
  assert.equal(fp.observedCheckFailures, 0);
});

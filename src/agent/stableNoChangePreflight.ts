import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { isTestPath } from "../context/compiler.js";
import type { RepoProfile, VerificationResult } from "../types.js";
import { verificationPlan } from "../verifier/plan.js";
import { optionalUnavailableCheck } from "../verifier/recovery.js";
import { verify, verificationResult } from "../verifier/verifier.js";
import { isExplicitTestOnlyTask, testRequirementAlreadyCovered } from "./mutationInvariant.js";

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

const focusedRoutingTest = (
  profile: RepoProfile,
  paths: string[],
  candidates: ReturnType<typeof verificationPlan>,
) => {
  const tests = paths.filter((path) => isTestPath(path));
  if (!tests.length) return undefined;
  const rootTest = candidates.find((candidate) =>
    candidate.available && candidate.kind === "test" && candidate.cwd === ".");
  if (!rootTest || profile.scripts.pretest || profile.scripts.posttest)
    return undefined;
  if (/^tsx --test tests\/\*\.test\.ts$/.test(profile.scripts.test ?? "") &&
      profile.packageManager === "pnpm" &&
      tests.every((path) => /^tests\/[\w./-]+\.test\.ts$/.test(path)))
    return { ...rootTest,
      command: `pnpm exec tsx --test ${tests.map(quote).join(" ")}`,
      source: `${rootTest.source}:focused-routing` };
  if (/^node --test(?:\s+[\w./*'-]+)*$/.test(profile.scripts.test ?? "") &&
      tests.every((path) => /\.[cm]?js$/.test(path)))
    return { ...rootTest,
      command: `node --test ${tests.map(quote).join(" ")}`,
      source: `${rootTest.source}:focused-routing` };
  return undefined;
};

export interface StableNoChangePreflight {
  satisfied: boolean;
  verification: VerificationResult;
  evidencePaths: string[];
}

/**
 * One bounded repository check used as canonical routing evidence.  This is
 * deliberately deterministic and runs before a model/engine is selected.
 * It does not decide whether a mutation is needed; Stable's stricter
 * no-change proof remains separate below.
 */
export async function routingBaselinePreflight(
  root: string,
  profile: RepoProfile,
  paths: string[],
  timeoutMs: () => number,
  onCheck?: Parameters<typeof verify>[3],
): Promise<VerificationResult> {
  const candidates = verificationPlan(profile, paths).filter(
    (candidate) => candidate.available && !optionalUnavailableCheck(candidate),
  );
  const selected = focusedRoutingTest(profile, paths, candidates) ??
    candidates.find((candidate) => candidate.kind === "test") ?? candidates[0];
  if (!selected) return verificationResult([]);
  return verify(root, [selected.command], timeoutMs, onCheck, undefined, [selected]);
}

/**
 * Conservative zero-model proof for explicit test-only work.
 *
 * The proof needs executable assertion code and at least one passing,
 * repository-derived test command. An inconclusive proof simply delegates to
 * mini-SWE; it never blocks mutation work.
 */
export async function stableNoChangePreflight(
  root: string,
  task: string,
  profile: RepoProfile,
  timeoutMs: () => number,
  onCheck?: Parameters<typeof verify>[3],
  knownVerification?: VerificationResult,
  relevantPaths?: string[],
): Promise<StableNoChangePreflight> {
  if (!isExplicitTestOnlyTask(task))
    return { satisfied: false, verification: verificationResult([]), evidencePaths: [] };

  const testPaths = profile.files.filter(isTestPath).slice(0, 128);
  const files = (await Promise.all(testPaths.map(async (path) => ({
    path,
    content: await readFile(join(root, path), "utf8").catch(() => ""),
  })))).filter((file) => file.content.length > 0);

  if (!testRequirementAlreadyCovered(task, files))
    return { satisfied: false, verification: verificationResult([]), evidencePaths: [] };

  const candidates = verificationPlan(
    profile,
    relevantPaths?.length ? relevantPaths : testPaths,
    true,
  ).filter((candidate) =>
    !optionalUnavailableCheck(candidate));
  const commands = [...new Set(candidates.map((candidate) => candidate.command))];
  if (!commands.length)
    return { satisfied: false, verification: verificationResult([]), evidencePaths: [] };

  const reusable = knownVerification?.checks.filter((check) =>
    commands.includes(check.command) &&
    (check.outcome === "CHECK_PASS" || check.outcome === "CHECK_FAIL")) ?? [];
  const covered = new Set(reusable.map((check) => check.command));
  const missing = commands.filter((command) => !covered.has(command));
  const executed = missing.length
    ? await verify(root, missing, timeoutMs, onCheck, undefined, candidates)
    : verificationResult([]);
  const verification = verificationResult([...reusable, ...executed.checks]);
  return { satisfied: verification.status === "VERIFIED_SUCCESS" && verification.checks.length > 0,
    verification, evidencePaths: files.map((file) => file.path) };
}

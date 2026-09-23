import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { isTestPath } from "../context/compiler.js";
import type { RepoProfile, VerificationResult } from "../types.js";
import { verificationPlan } from "../verifier/plan.js";
import { optionalUnavailableCheck } from "../verifier/recovery.js";
import { verify, verificationResult } from "../verifier/verifier.js";
import { isExplicitTestOnlyTask, testRequirementAlreadyCovered } from "./mutationInvariant.js";

export interface StableNoChangePreflight {
  satisfied: boolean;
  verification: VerificationResult;
  evidencePaths: string[];
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

  const candidates = verificationPlan(profile, testPaths, true).filter((candidate) =>
    candidate.available && candidate.kind === "test" && !optionalUnavailableCheck(candidate));
  const commands = [...new Set(candidates.map((candidate) => candidate.command))];
  if (!commands.length)
    return { satisfied: false, verification: verificationResult([]), evidencePaths: [] };

  const verification = await verify(root, commands, timeoutMs, onCheck, undefined, candidates);
  return { satisfied: verification.status === "VERIFIED_SUCCESS" && verification.checks.length > 0,
    verification, evidencePaths: files.map((file) => file.path) };
}

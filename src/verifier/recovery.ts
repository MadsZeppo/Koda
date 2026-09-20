import { executable, quote, type VerificationCandidate } from "../repo/ecosystem.js";
import type { RepoProfile } from "../types.js";
import { readFile, lstat } from "node:fs/promises";
import { safePath } from "../agent/tools.js";
import { profileRepo } from "../repo/profiler.js";
import { verificationPlan } from "./plan.js";

const literal = (value: string) => /^(?:-?\d+(?:\.\d+)?|True|False|None|"[^"\\\n]{0,80}"|'[^'\\\n]{0,80}')$/.test(value);

export const optionalUnavailableCheck = (candidate: VerificationCandidate) =>
  !candidate.available && candidate.kind === "test" &&
  (candidate.source === "inferred:test-file convention" ||
    /(?:^|\/)requirements[^/]*\.txt$/.test(candidate.source));

/** Last resort: accept only a literal, task-supplied assertion against a real changed Python function. */
export async function focusedLocalReproduction(
  profile: RepoProfile, task: string, paths: readonly string[],
): Promise<VerificationCandidate | undefined> {
  const match = task.match(/\b([A-Za-z_]\w*)\(([^()\n]{0,160})\)\s*(?:==|should\s+(?:return|produce)|returns?)\s*(-?\d+(?:\.\d+)?|True|False|None|"[^"\\\n]{0,80}"|'[^'\\\n]{0,80}')/i);
  if (!match) return undefined;
  const [, name, rawArgs, expected] = match;
  const args = rawArgs!.trim() ? rawArgs!.split(/\s*,\s*/) : [];
  if (!literal(expected!) || args.length > 4 || !args.every(literal)) return undefined;
  const sources = paths.filter((path) => /^[\w/-]+\.py$/.test(path) && !/(?:^|\/)(?:tests?|test_)/.test(path));
  const matches: string[] = [];
  for (const source of sources.slice(0, 8)) {
    try {
      const file = await safePath(profile.root, source);
      const stat = await lstat(file);
      if (!stat.isFile() || stat.nlink > 1 || stat.size > 100000) continue;
      const text = await readFile(file, "utf8");
      if (new RegExp(`^def ${name}\\s*\\(`, "m").test(text)) matches.push(source);
    } catch {}
  }
  if (matches.length !== 1) return undefined;
  const python = await executable("python3") ? "python3" : await executable("python") ? "python" : undefined;
  if (!python) return undefined;
  const module = matches[0]!.replace(/\.py$/, "").replaceAll("/", ".");
  const script = `import importlib; actual = getattr(importlib.import_module(${JSON.stringify(module)}), ${JSON.stringify(name)})(${args.join(", ")}); assert actual == ${expected}, repr(actual)`;
  return { kind: "test", command: `${python} -B -c ${quote(script)}`, cwd: ".",
    source: "task:concrete-local-reproduction", confidence: 1, available: true,
    origin: "inferred", requirement: "required", mutatesSource: false,
    requiresInstalledDependencies: false };
}

/** Reinspect the mutated workspace once; the pre-edit profile may be stale or incomplete. */
export async function recoverPostMutationChecks(root: string, task: string, paths: readonly string[]) {
  const updated = await profileRepo(root);
  const discovered = verificationPlan(updated, [...paths]).filter((candidate) => candidate.available);
  if (discovered.length) return discovered;
  const focused = await focusedLocalReproduction(updated, task, paths);
  return focused ? [focused] : [];
}

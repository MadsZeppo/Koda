import { lstat, readFile } from "node:fs/promises";
import { posix } from "node:path";
import type { RepoProfile } from "../types.js";
import type { EvidencePacket, Subtask } from "../planner/schemas.js";
import { safePath } from "../agent/tools.js";

/** Only a locally proven, existing sibling may extend a coding worker's scope. */
export async function justifiedSiblingWrite(
  root: string,
  candidate: string,
  subtask: Subtask,
  profile: RepoProfile,
  task: string,
  evidence?: EvidencePacket,
): Promise<boolean> {
  if (!profile.files.includes(candidate) || !/\.[cm]?[jt]sx?$|\.py$/.test(candidate)) return false;
  if (/\b(?:test|spec)s?\b/i.test(candidate) && !/\b(?:add|write|update|fix|modify)\b.{0,40}\btests?\b/i.test(task)) return false;
  const siblings = subtask.likelyWritePaths.filter((path) => posix.dirname(path) === posix.dirname(candidate));
  if (!siblings.length || subtask.likelyWritePaths.includes(candidate)) return false;
  try {
    const target = await safePath(root, candidate);
    const stat = await lstat(target);
    if (!stat.isFile() || stat.nlink !== 1 || stat.isSymbolicLink()) return false;
    const candidateText = await readFile(target, "utf8");
    const named = [task, subtask.objective, ...(evidence?.evidence ?? []), evidence?.suggestedApproach ?? ""]
      .some((item) => item.includes(candidate) || item.includes(posix.basename(candidate)));
    const linked = (source: string, target: string) => source.split("\n").some((line) =>
      /^\s*(?:import|from|export)\b|\brequire\s*\(/.test(line) &&
      line.includes(posix.basename(target).replace(/\.[^.]+$/, "")));
    const referencedBySibling = (await Promise.all(siblings.map(async (path) => {
      try { return { path, text: await readFile(await safePath(root, path), "utf8") }; }
      catch { return { path, text: "" }; }
    }))).some(({ path, text }) => linked(text, candidate) || linked(candidateText, path));
    return named && referencedBySibling;
  } catch { return false; }
}

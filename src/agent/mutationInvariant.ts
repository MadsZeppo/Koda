import { isTestPath } from "../context/compiler.js";

export interface MutationPath { path: string }

export const isExplicitTestOnlyTask = (task: string) =>
  /\b(?:only|solely|exclusively)\b[^.\n]{0,50}\btests?\b|\btests?\s+only\b/i.test(task) ||
  /^\s*in\s+[\w./-]*(?:tests?|spec)[\w./-]*\.[\w]+\s*,?\s*(?:add|write|create|update|modify|fix|repair)\b/i.test(task) ||
  /^\s*(?:add|write|create|update|modify|fix|repair)\s+(?:(?:a|an|one|the|new|existing|focused|regression|unit|integration|deterministic|missing|failing|broken)\s+){0,8}tests?\b/i.test(task);

const taskConceptWords = (task: string) => (task
  .replace(/(?:^|\s)[\w./-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|rb)(?=\s|[,.:;]|$)/gi, " ")
  .replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase()
  .match(/[a-z][a-z0-9]*/g) ?? [])
  .filter((word) => !/^(?:add|write|create|update|modify|fix|repair|a|an|the|new|existing|focused|regression|unit|integration|deterministic|test|tests|that|which|verifies|verify|includes|include|contains|contain|and|or|with|for|from|into|in|proving|proves|stop|stops|when|reach|reached|make|smallest|necessary|change|run|relevant|is|are)$/.test(word));

/**
 * Prove that an explicit test-only request is already represented by actual
 * assertion code. Test names, comments and filenames cannot satisfy it.
 */
export function testRequirementAlreadyCovered(
  task: string,
  files: readonly { path: string; content: string }[],
) {
  if (!isExplicitTestOnlyTask(task) || !files.length || files.some((file) => !isTestPath(file.path)))
    return false;
  const words = taskConceptWords(task);
  if (words.length < 2) return false;
  const assertions = files.flatMap((file) => file.content
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*/g, "")
    .split("\n")
    .filter((line) => /\b(?:assert(?:\.|\s|\()|expect\s*\(|should\b|self\.assert)/i.test(line)));
  const identifiers = assertions.flatMap((line) =>
    line.match(/[A-Za-z_$][\w$]*/g) ?? []).map((identifier) =>
      identifier.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase());
  const covered = new Set(words.filter((word) =>
    identifiers.some((identifier) => identifier.split("_").includes(word))));
  const compositeAssertions = identifiers.filter((identifier) =>
    words.filter((word) => identifier.split("_").includes(word)).length >= 2);
  if (new Set(compositeAssertions).size >= 2 && covered.size >= Math.min(4, words.length))
    return true;
  return false;
}

/** Stable mutation success requires a non-test change whenever its locked scope owns implementation. */
export function taskRelevantMutationPaths(
  task: string,
  lockedPaths: readonly string[],
  changes: readonly MutationPath[],
) {
  const owns = (root: string, path: string) => {
    const normalized = root.replace(/\/$/, "");
    return normalized === "." ||
      path === normalized ||
      path.startsWith(normalized + "/");
  };

  const changed = changes.filter((change) =>
    lockedPaths.some((root) => owns(root, change.path)));

  const implementationRequired = lockedPaths.some((path) => !isTestPath(path)) &&
    !isExplicitTestOnlyTask(task);

  return implementationRequired
    ? changed.filter((change) => !isTestPath(change.path)).map((change) => change.path)
    : changed.map((change) => change.path);
}

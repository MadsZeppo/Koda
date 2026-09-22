import { compactEcosystem, projectFor } from "../repo/ecosystem.js";
import { extname, dirname } from "node:path";
import type { RepoProfile, VerificationResult } from "../types.js";
import type { Subtask } from "../planner/schemas.js";
import { isTestPath } from "../context/compiler.js";

/** Constraints exclude work; their vocabulary must not inflate task demand. */
export const routingTaskText = (subtask: Subtask) =>
  `${subtask.title}. ${subtask.objective}`.toLowerCase()
    .replace(/\b(?:do not|don't|must not|without)\b[^.!?;\n]*/g, "")
    .replace(/\bno\s+(?:refactors?|migrations?|architectural changes?)\b[^.!?;\n]*/g, "");

export type TaskType = "localized_bug" | "debugging" | "test" | "type_error" | "build_error" |
  "implementation" | "feature" | "multi_file_feature" | "refactor" | "migration" | "architecture" | "ambiguous";
export function extractFeatures(
  subtask: Subtask,
  profile: RepoProfile,
  contextBytes: number,
  verification?: VerificationResult,
  executionStrategy = "planned",
) {
  const text = routingTaskText(subtask);
  const paths = subtask.likelyWritePaths;
  // A trailing instruction to add coverage supports the primary implementation;
  // only the leading request (or an exclusively test scope) makes this test work.
  const testRequest = /^\s*(?:add|create|write|extend|update|fix|repair)\s+(?:(?:a|an|the|deterministic|focused|unit|integration|regression|existing)\s+)*tests?\b/i;
  const isBugFix = /\b(?:fix|repair|bug|debug)\w*\b/.test(text),
    isRefactor = /\brefactor\w*\b/.test(text),
    isTestWork = [subtask.title, subtask.objective].some((part) => testRequest.test(part)) ||
      (paths.length > 0 && paths.every(isTestPath) && /\b(?:tests?|specs?|coverage)\b/.test(text));
  const requiresArchitectureReasoning = /\b(?:architect\w*|migrat\w*|redesign|restructure)\b/.test(text);
  // A source file plus its regression test is not evidence of coupled
  // implementation modules merely because tests live in a different directory.
  const implementationPaths = paths.filter((path) => !isTestPath(path));
  const modulePaths = implementationPaths.length ? implementationPaths : paths;
  const requiresCrossModuleReasoning =
    /\b(?:across\s+(?:modules?|components?|packages?|services?)|cross[ -]module)\b/.test(text) ||
    new Set(modulePaths.map(dirname)).size > 1;
  const complexity =
    subtask.estimatedDifficulty === "high" || requiresArchitectureReasoning
      ? "large"
      : requiresCrossModuleReasoning || paths.length > 3
        ? "medium"
        : "small";
  const stack = compactEcosystem(profile.ecosystem, paths);
  const boundedScope = paths.length > 0 && paths.length <= 3 && !requiresCrossModuleReasoning;
  const knownTargets = paths.filter((path) => profile.files.includes(path));
  const readTargets = knownTargets.filter((path) => subtask.likelyReadPaths.includes(path));
  const localizationConfidence = !paths.length || !knownTargets.length ? "low" as const
    : boundedScope && readTargets.length === knownTargets.length && contextBytes > 0 ? "high" as const
    : "medium" as const;
  const taskType: TaskType = isTestWork ? "test"
    : /\b(?:type\s*(?:error|mismatch)|typecheck|typescript\s+error)\b/.test(text) ? "type_error"
    : /\b(?:build|compil(?:e|er|ation))\s+(?:error|fail\w*)\b/.test(text) ? "build_error"
    : /\bmigrat\w*\b/.test(text) ? "migration"
    : requiresArchitectureReasoning ? "architecture"
    : isRefactor ? "refactor"
    : isBugFix ? boundedScope ? "localized_bug" : "debugging"
    : !paths.length && !subtask.readOnly ? "ambiguous"
    : /\b(?:feature|implement|introduce)\w*\b/.test(text) ? paths.length > 1 ? "multi_file_feature" : "feature"
    : "implementation";
  return {
    ecosystem: stack?.ecosystem ?? "generic",
    frameworks: [
      ...new Set(stack?.projects.flatMap((p) => p.frameworks) ?? []),
    ].sort(),
    packageManagers: [
      ...new Set(
        stack?.projects.flatMap((p) => (p.manager ? [p.manager] : [])) ?? [],
      ),
    ].sort(),
    testRunners: [
      ...new Set(stack?.projects.flatMap((p) => p.testRunners) ?? []),
    ].sort(),
    environmentManagers: [
      ...new Set(
        stack?.projects.flatMap((p) =>
          p.environmentManager ? [p.environmentManager] : [],
        ) ?? [],
      ),
    ].sort(),
    monorepo: stack?.monorepo ?? false,
    taskScope: [
      ...new Set(
        paths.flatMap((p) => projectFor(profile.ecosystem, p)?.root ?? []),
      ),
    ],
    executionStrategy,
    taskType,
    localizationConfidence,
    readOnly: subtask.readOnly === true,
    parallelSafe: subtask.parallelSafe,
    taskKind: isTestWork ? "test" : isRefactor
      ? "refactor"
      : isBugFix
        ? "bug_fix"
        : "implementation",
    languages: [
      ...new Set(
        paths.flatMap(
          (p) =>
            ({
              ".mts": "typescript",
              ".cts": "typescript",
              ".jsx": "javascript",
              ".ts": "typescript",
              ".tsx": "typescript",
              ".js": "javascript",
              ".cjs": "javascript",
              ".mjs": "javascript",
              ".py": "python",
              ".rs": "rust",
              ".go": "go",
            })[extname(p)] ??
            projectFor(profile.ecosystem, p)?.languages ?? ["other"],
        ),
      ),
    ].sort(),
    complexity,
    estimatedFiles: paths.length,
    implementationFiles: implementationPaths.length,
    likelyWritePaths: paths,
    contextBytes,
    dependencyCount: subtask.dependsOn.length,
    acceptanceCheckCount:
      verification?.checks.length ?? subtask.verificationCommands.length,
    repoSizeBucket:
      profile.files.length < 40
        ? "small"
        : profile.files.length < 500
          ? "medium"
          : "large",
    requiresCrossModuleReasoning,
    requiresArchitectureReasoning,
    hasFailingTests: verification?.checks.some((check) => check.outcome === "CHECK_FAIL") ?? false,
    isLocalized: boundedScope && localizationConfidence !== "low",
    isFrontend: /frontend|\.tsx|\.jsx|css/.test(text + paths.join(" ")),
    isBackend: /backend|api|server|database/.test(text + paths.join(" ")),
    isTestWork,
    isRefactor,
    isBugFix,
  };
}
export type Features = ReturnType<typeof extractFeatures>;
/** Small, deterministic similarity bucket; no model call or repository scan. */
export function taskBucket(f: Features) {
  if (f.taskKind === "planning") return `planning_${f.complexity}`;
  if (f.readOnly) return "read_only_discovery";
  if (f.executionStrategy === "stable") return "inspect_fix_test";
  if (f.complexity === "large") return "complex_debugging";
  if (f.executionStrategy === "planned" && f.parallelSafe && !f.dependencyCount)
    return "parallel_independent";
  if (
    f.requiresCrossModuleReasoning ||
    f.dependencyCount ||
    f.estimatedFiles > 1
  )
    return "multi_file_coupled";
  if (f.isBugFix) return "localized_bugfix";
  return "tiny_local_edit";
}
export const featureKey = (f: Features) =>
  [
    taskBucket(f),
    f.taskKind,
    f.languages.join(","),
    f.complexity,
    f.ecosystem ?? "generic",
    (f.frameworks ?? []).join(","),
  ].join(":");

/** Legacy observations are inferred into the same deterministic task bucket. */
export const historyMatches = (record: Features, current: Features) =>
  featureKey(record) === featureKey(current) ||
  (!record.ecosystem &&
    taskBucket(record) === taskBucket(current) &&
    record.taskKind === current.taskKind &&
    record.languages.join(",") === current.languages.join(",") &&
    record.complexity === current.complexity);

import { compactEcosystem, projectFor } from "../repo/ecosystem.js";
import { extname, dirname } from "node:path";
import type { RepoProfile, VerificationResult } from "../types.js";
import type { Subtask } from "../planner/schemas.js";
export function extractFeatures(
  subtask: Subtask,
  profile: RepoProfile,
  contextBytes: number,
  verification?: VerificationResult,
  executionStrategy = "planned",
) {
  const text = subtask.objective.toLowerCase();
  const paths = subtask.likelyWritePaths;
  const isBugFix = /fix|repair|bug/.test(text),
    isRefactor = /refactor/.test(text),
    isTestWork = /\btests?\b/.test(subtask.title.toLowerCase());
  const requiresArchitectureReasoning = /architect|migrat|redesign/.test(text);
  const requiresCrossModuleReasoning =
    /across|cross.module/.test(text) || new Set(paths.map(dirname)).size > 1;
  const complexity =
    subtask.estimatedDifficulty === "high" || requiresArchitectureReasoning
      ? "large"
      : requiresCrossModuleReasoning || paths.length > 3
        ? "medium"
        : "small";
  const stack = compactEcosystem(profile.ecosystem, paths);
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
    readOnly: subtask.readOnly === true,
    parallelSafe: subtask.parallelSafe,
    taskKind: isRefactor
      ? "refactor"
      : isBugFix
        ? "bug_fix"
        : isTestWork
          ? "test"
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
    hasFailingTests: (verification?.failedChecks ?? 0) > 0,
    isLocalized: complexity === "small",
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

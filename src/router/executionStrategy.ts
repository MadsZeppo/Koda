import { posix } from "node:path";

import type { RepoProfile } from "../types.js";
import { isSourcePath, isTestPath, taskTerms } from "../context/compiler.js";

export interface ExecutionStrategy {
  execution_strategy: "direct" | "stable" | "planned";
  execution_effort: "tiny" | "normal" | "complex";
  strategy_reason: string;
  likelyFiles: string[];
  preciseTarget?: string;
}

/**
 * Keep the deterministic task assessment authoritative. Joint routing may
 * compare models inside a bounded DIRECT workstream, but must not manufacture
 * a broader agent loop merely because that loop has different economics.
 */
export function allowedJointExecutionStrategies(
  initial: ExecutionStrategy["execution_strategy"],
  plannedExecutable: boolean,
  boundedDirectAlternative: boolean,
): ExecutionStrategy["execution_strategy"][] {
  if (initial === "direct") return ["direct"];

  const candidates: ExecutionStrategy["execution_strategy"][] = [initial];
  if (initial === "planned" && !plannedExecutable) candidates.splice(0, 1, "stable");
  if (!candidates.includes("stable")) candidates.push("stable");
  if (plannedExecutable && !candidates.includes("planned")) candidates.push("planned");
  if (boundedDirectAlternative && !candidates.includes("direct")) candidates.push("direct");
  return candidates;
}

const mentionedPath = (task: string, path: string) => {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  return new RegExp(
    `(?:^|[^A-Za-z0-9_./-])${escaped}(?=$|[^A-Za-z0-9_/-])`,
  ).test(task);
};

/**
 * Extract safe repository-relative file paths named by the task, including a
 * file that does not exist yet. Existing repository paths remain authoritative
 * even when they have no extension; unknown paths must look like files so
 * ordinary prose and directory names cannot silently become write scope.
 */
export function explicitTaskPaths(task: string, profile: RepoProfile): string[] {
  const existing = profile.files.filter((path) => mentionedPath(task, path));
  const literals: string[] = [];
  const pattern = /(?:^|[^A-Za-z0-9_./-])((?:\.\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+|[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+)(?=$|[^A-Za-z0-9_/-])/g;
  for (const match of task.matchAll(pattern)) {
    const value = match[1]!.replace(/^\.\//, "").replace(/[.,;:!?]+$/, "");
    const parts = value.split("/");
    const basename = parts.at(-1) ?? "";
    if (
      !value || value.startsWith("/") ||
      parts.some((part) => !part || part === "." || part === ".." || part === ".git" || part === ".koda") ||
      (!value.includes("/") && !/^[A-Za-z_][A-Za-z0-9_.-]*\.[A-Za-z0-9]+$/.test(basename)) ||
      !/\.[A-Za-z0-9]+$/.test(basename)
    ) continue;
    const normalized = posix.normalize(value);
    const basenameMatches = profile.files.filter((path) =>
      posix.basename(path) === posix.basename(normalized));
    literals.push(
      !profile.files.includes(normalized) && basenameMatches.length === 1
        ? basenameMatches[0]!
        : normalized,
    );
  }
  return [...new Set([...existing, ...literals])];
}

/** Plan for decomposition benefit, not merely for repository size or the word 'all'. */
export function chooseExecutionStrategy(
  task: string,
  profile: RepoProfile,
): ExecutionStrategy {
  const requestedWork = task
    .replace(/\b(?:do not|don't|must not|without)\b[^.!?;\n]*/gi, "")
    .replace(
      /\bno\s+(?:refactors?|migrations?|architectural changes?)\b[^.!?;\n]*/gi,
      "",
    );
  const implementationWork = requestedWork
    .replace(/(?:\b(?:and|then|also)\s+|[.;\n]\s*|\+\s*)(?:add|write|include|create|update|change|modify|fix|repair)\s+(?:a\s+)?(?:focused\s+|regression\s+|unit\s+|integration\s+)*tests?\b[^.;\n]*/gi, "")
    .replace(/(?:\b(?:and|then|also)\s+|[.;\n]\s*|\+\s*)preserve\s+(?:existing\s+)?(?:behavior|compatibility|tests?)\b[^.;\n]*/gi, "");

  const sources = profile.files.filter(isSourcePath);
  const terms = taskTerms(task);
  const exactPaths = explicitTaskPaths(task, profile);
  const basenameMatches = profile.files.filter((f) =>
    mentionedPath(task, posix.basename(f)),
  );
  const explicit = exactPaths.length
    ? exactPaths
    : basenameMatches.length === 1
      ? basenameMatches
      : [];
  const concreteMentions = exactPaths.length ? exactPaths : basenameMatches;
  const implementationSource = (file: string) =>
    isSourcePath(file) && !isTestPath(file);
  const exactSourceMentions = exactPaths.filter(implementationSource);

  const directories = [
    ...new Set(
      profile.files.flatMap((file) => {
        const dirs: string[] = [];
        let dir = posix.dirname(file);

        while (dir !== ".") {
          dirs.push(dir);
          dir = posix.dirname(dir);
        }

        return dirs;
      }),
    ),
  ].sort((a, b) => b.length - a.length);

  const explicitDirectory = directories.find(
    (dir) => dir.includes("/") && mentionedPath(task, dir),
  );

  const stableTargets = explicit.length
    ? explicit
    : explicitDirectory
      ? profile.files.filter((file) =>
          file.startsWith(explicitDirectory + "/"),
        )
      : [];

  const matched = sources.filter(
    (f) =>
      explicit.includes(f) ||
      terms.some(
        (t) =>
          posix
            .basename(f)
            .toLowerCase()
            .replace(/\.[^.]+$/, "") === t,
      ) ||
      profile.symbols.some(
        (s) =>
          s.startsWith(f + ":") &&
          terms.some((t) =>
            new RegExp(
              `\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
              "i",
            ).test(s),
          ),
      ),
  );

  const planned = (reason: string): ExecutionStrategy => ({
    execution_strategy: "planned",
    execution_effort: "complex",
    strategy_reason: reason,
    likelyFiles: matched,
  });

  const explicitParallelWork = implementationWork
    .split(/[.!?;\n]+/)
    .some(
      (clause) =>
        /\b(?:independent(?:ly)?|separately|parallel|workstreams?)\b/i.test(
          clause,
        ) &&
        /\b(?:fix|repair|add|implement|update|change|modify|refactor|migrat\w*|build|create|remove|delete|rename|redesign|correct)\b/i.test(
          clause,
        ) &&
        (
          concreteMentions.filter((file) =>
            implementationSource(file) && mentionedPath(clause, file),
          ).length >= 2 ||
          /\band\s+(?:independently\s+|separately\s+)?(?:fix|repair|add|implement|update|change|modify|refactor|build|create|remove|delete|rename|correct)\b/i.test(
            clause,
          ) ||
          /\b(?:two|three|four|multiple)\s+(?:changes?|fixes?|tasks?|components?|files?|modules?|workstreams?)\b/i.test(
            clause,
          )
        ),
    );

  if (explicitParallelWork) return planned("Explicit independent workstreams");

  if (
    /\b(?:across|cross[- ](?:module|system)|migrat\w*|architect\w*|refactor\w*|multi[- ]component|depends? on|dependent on|schema migration|database migration)\b/i.test(
      requestedWork,
    )
  ) return planned("Cross-component work requires decomposition");

  const actionVerbs = implementationWork.match(/(?:^|[.;]\s*|\band\s+)(?:fix|repair|implement|compose|regenerate|correct|create|build|update)\b/gi) ?? [];
  if (actionVerbs.length >= 2 &&
      /\b(?:and|independently)\b|[.;]\s*(?:fix|repair|implement|compose|regenerate|correct|create|build|update)\b/i.test(implementationWork) &&
      !/\b(?:one|single|same)\s+(?:bug|issue|fix|change)\b/i.test(implementationWork))
    return planned("Separate implementation actions");

  if (
    stableTargets.length > 0 &&
    /\b(?:inspect|investigate|review|trace|find)\b/i.test(task) &&
    /\b(?:fix|repair|correct)\b/i.test(task) &&
    /\b(?:regression\s+test|add\s+(?:a\s+)?(?:focused\s+)?test|existing\s+(?:focused\s+)?test|tests?\s+pass|verify)\b/i.test(
      requestedWork,
    ) &&
    task.length <= 1200
  ) {
    return {
      execution_strategy: "stable",
      execution_effort: "normal",
      strategy_reason:
        "Bounded inspect, fix, and test task uses one stable worker",
      likelyFiles: stableTargets,
    };
  }

  if (exactSourceMentions.length >= 3) {
    return planned("Several explicit source targets require dependency-aware planning");
  }

  const boundedFeature =
    /\b(?:add|implement|introduce|support|enable|wire|fix|repair|modify)\b[^.;\n]{0,140}\b(?:flag|option|feature|command|behavior|capability|flow|logic)\b/i.test(requestedWork) &&
    /\b(?:focused|regression|unit|integration)?\s*tests?\b/i.test(requestedWork) &&
    matched.length <= 4;
  if (boundedFeature) {
    return {
      execution_strategy: "stable",
      execution_effort: "normal",
      strategy_reason: "One bounded feature and its tests share a locked Stable scope",
      likelyFiles: stableTargets.length ? stableTargets : matched,
    };
  }

  if (
    /\b(?:independent|separate|parallel)\b/i.test(implementationWork) &&
    concreteMentions.filter(implementationSource).length > 1
  ) return planned("Multiple independent implementation targets");

  if (/\bclient\b/i.test(requestedWork) && /\bserver\b/i.test(requestedWork)) {
    return planned("Client and server changes");
  }

  if (/\b(?:everything|entire|throughout)\b/i.test(requestedWork)) {
    return planned("Broad task scope");
  }

  if (explicit.length === 1) {
    return {
      execution_strategy: "direct",
      execution_effort:
        /\b(?:inspect|investigate|review|trace|find|debug|fix|repair|regression|test|architect|refactor)\b/i.test(
          requestedWork,
        )
          ? "normal"
          : /\b(?:add|change|update|replace|rename|remove|delete|correct|edit)\b/i.test(
                requestedWork,
              )
            ? "tiny"
            : "normal",
      strategy_reason: "One explicit localized file target",
      likelyFiles: explicit,
      preciseTarget: explicit[0],
    };
  }

  const component = (f: string) => posix.dirname(f);

  if (
    concreteMentions.filter(implementationSource).length >= 2 &&
    new Set(concreteMentions.filter(implementationSource).map(component)).size > 1 &&
    /\b(?:independent|separate|parallel|and)\b/i.test(implementationWork)
  ) {
    return planned("Explicit distinct requested components");
  }

  const namedSourceStems = matched.filter((file) =>
    mentionedPath(requestedWork, posix.basename(file).replace(/\.[^.]+$/, "")),
  );
  if (namedSourceStems.length >= 3 && /,.*\b(?:and|or)\b/i.test(requestedWork))
    return planned("Several separately named source repairs");

  if (matched.length > 1) {
    return {
      execution_strategy: "direct",
      execution_effort: "normal",
      strategy_reason:
        "Multiple inferred files remain one bounded workstream; joint routing decides discovery cost",
      likelyFiles: matched,
    };
  }

  if (
    explicit.some((f) => !isSourcePath(f) && !isTestPath(f)) &&
    matched.length
  ) return planned("Code and configuration changes");

  const targets = matched.length ? matched : explicit.filter(isSourcePath);

  if (!targets.length && sources.length > 8) {
    return {
      execution_strategy: "stable",
      execution_effort: "normal",
      strategy_reason:
        "Large-repo single workstream needs Stable localization, not planning",
      likelyFiles: [],
    };
  }

  return {
    execution_strategy: "direct",
    execution_effort: "normal",
    strategy_reason: targets.length
      ? "One localized or tightly coupled workstream"
      : "No demonstrated parallelism benefit; use one worker",
    likelyFiles: targets.length
      ? targets
      : sources.length <= 8
        ? sources
        : ["."],
  };
}

export function requestsTestMutation(task: string): boolean {
  return /\b(?:add|write|create|update|change|modify|fix|repair|remove|delete)\s+(?:(?:a|an|one|the|new|existing|focused|regression|deterministic|missing|unit|integration|failing|broken)\s+){0,8}tests?\b/i.test(task) ||
    /\b(?:add|implement|create)\b[^\n]{0,160}\bwith\s+(?:focused|regression)\s+tests?\b/i.test(task) ||
    /\btests?\b[^.;\n]{0,80}\b(?:is|are)\s+(?:wrong|broken|incorrect)\b/i.test(task);
}

export function directWritePaths(
  files: string[],
  profile: RepoProfile,
  task = "",
): string[] {
  const changeTests = requestsTestMutation(task);
  const implementation = files.filter((file) => !isTestPath(file));
  const stems = implementation.map((f) =>
    posix
      .basename(f)
      .replace(/\.[^.]+$/, "")
      .toLowerCase(),
  );

  return [
    ...new Set([
      ...implementation,
      ...profile.files.filter(
        (f) =>
          changeTests &&
          isTestPath(f) &&
          stems.some((stem) =>
            posix.basename(f).toLowerCase().split(/[._-]/).includes(stem),
          ),
      ),
      ...(changeTests ? files.filter(isTestPath) : []),
    ]),
  ];
}

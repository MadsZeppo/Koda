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

const mentionedPath = (task: string, path: string) => {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  return new RegExp(
    `(?:^|[^A-Za-z0-9_./-])${escaped}(?=$|[^A-Za-z0-9_/-])`,
  ).test(task);
};

/** Plan for decomposition benefit, not merely for repository size or the word 'all'. */
export function chooseExecutionStrategy(
  task: string,
  profile: RepoProfile,
): ExecutionStrategy {
  // Constraints such as "do not refactor" describe excluded work, not task
  // scope. Do not let their vocabulary manufacture decomposition pressure.
  const requestedWork = task
    .replace(/\b(?:do not|don't|must not|without)\b[^.!?;\n]*/gi, "")
    .replace(
      /\bno\s+(?:refactors?|migrations?|architectural changes?)\b[^.!?;\n]*/gi,
      "",
    );
  // Tests and compatibility are acceptance criteria for the implementation,
  // not independent workstreams just because they are separate clauses.
  const implementationWork = requestedWork
    .replace(/(?:\b(?:and|then|also)\s+|[.;\n]\s*|\+\s*)(?:add|write|include|create)\s+(?:a\s+)?(?:focused\s+|regression\s+|unit\s+|integration\s+)*tests?\b[^.;\n]*/gi, "")
    .replace(/(?:\b(?:and|then|also)\s+|[.;\n]\s*|\+\s*)preserve\s+(?:existing\s+)?(?:behavior|compatibility|tests?)\b[^.;\n]*/gi, "");

  const sources = profile.files.filter(isSourcePath);
  const terms = taskTerms(task);

  // A root path such as README.md can share its basename with nested files.
  // Prefer exact repository-relative mentions; only fall back to a basename
  // when that basename identifies one file in the repository.
  const exactPaths = profile.files.filter((f) => mentionedPath(task, f));

  const basenameMatches = profile.files.filter((f) =>
    mentionedPath(task, posix.basename(f)),
  );

  const explicit = exactPaths.length
    ? exactPaths
    : basenameMatches.length === 1
      ? basenameMatches
      : [];
  // Keep all concrete filename mentions for decomposition evidence. `explicit`
  // stays narrow for direct execution, while `concreteMentions` lets us tell
  // a genuinely multi-component request from broad lexical matches.
  const concreteMentions = exactPaths.length ? exactPaths : basenameMatches;

  // Repository profiles contain files, not directory entries. Build the
  // directory set so an explicitly named bounded directory can still act as
  // scope evidence for Stable execution.
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
          concreteMentions.filter((file) => mentionedPath(clause, file)).length >= 2 ||
          /\band\s+(?:independently\s+|separately\s+)?(?:fix|repair|add|implement|update|change|modify|refactor|build|create|remove|delete|rename|correct)\b/i.test(
            clause,
          ) ||
          /\b(?:two|three|four|multiple)\s+(?:changes?|fixes?|tasks?|components?|files?|modules?|workstreams?)\b/i.test(
            clause,
          )
        ),
    );

  if (explicitParallelWork) {
    return planned("Explicit independent workstreams");
  }

  if (
    /\b(?:across|cross[- ](?:module|system)|migrat\w*|architect\w*|refactor\w*|multi[- ]component|depends? on|dependent on|schema migration|database migration)\b/i.test(
      requestedWork,
    )
  ) {
    return planned("Cross-component work requires decomposition");
  }

  const actionVerbs = implementationWork.match(/(?:^|[.;]\s*|\band\s+)(?:fix|repair|implement|compose|regenerate|correct|create|build|update)\b/gi) ?? [];
  if (actionVerbs.length >= 2 &&
      /\b(?:and|independently)\b|[.;]\s*(?:fix|repair|implement|compose|regenerate|correct|create|build|update)\b/i.test(implementationWork) &&
      !/\b(?:one|single|same)\s+(?:bug|issue|fix|change)\b/i.test(implementationWork))
    return planned("Separate implementation actions");

  // A bounded inspect -> fix -> verify workflow is one sequential workstream,
  // even when the user scopes it to a directory rather than one exact file.
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

  // Sentences, reproduction steps and code snippets are not independent
  // mutation targets. Decompose only when the task establishes separable work.
  if (
    /\b(?:independent|separate|parallel)\b/i.test(implementationWork) &&
    concreteMentions.filter(isSourcePath).length > 1
  ) return planned("Multiple independent implementation targets");

  if (
    /\bclient\b/i.test(requestedWork) &&
    /\bserver\b/i.test(requestedWork)
  ) {
    return planned("Client and server changes");
  }

  if (/\b(?:everything|entire|throughout)\b/i.test(requestedWork)) {
    return planned("Broad task scope");
  }

  // A unique path named by the user is stronger task-scope evidence than
  // lexical matches against symbols elsewhere in a large repository.
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

  // Only concrete, user-named files are strong evidence that multiple
  // components were actually requested. Lexical repo matches (for words such
  // as "verification", "routing", or "planner") are localization hints, not
  // independent workstreams and must not summon the planner by themselves.
  if (
    concreteMentions.filter(isSourcePath).length >= 2 &&
    new Set(concreteMentions.filter(isSourcePath).map(component)).size > 1 &&
    /\b(?:independent|separate|parallel|and)\b/i.test(implementationWork)
  ) {
    return planned("Explicit distinct requested components");
  }

  // Three separately named source stems joined as a list are independent
  // repair targets even when the prompt omits their extensions/directories.
  const namedSourceStems = matched.filter((file) =>
    mentionedPath(requestedWork, posix.basename(file).replace(/\.[^.]+$/, "")),
  );
  if (namedSourceStems.length >= 3 && /,.*\b(?:and|or)\b/i.test(requestedWork))
    return planned("Several separately named source repairs");

  if (matched.length > 1) {
    return {
      execution_strategy: "stable",
      execution_effort: "normal",
      strategy_reason:
        "Multiple inferred files belong to one bounded workstream; localize with Stable",
      likelyFiles: matched,
    };
  }

  if (
    explicit.some((f) => !isSourcePath(f) && !isTestPath(f)) &&
    matched.length
  ) {
    return planned("Code and configuration changes");
  }

  const targets = matched.length ? matched : explicit.filter(isSourcePath);

  // A large-repository task with no precise file target needs localization, not
  // decomposition. Stable can inspect and lock one bounded scope without paying
  // for a planner DAG or granting a generic DIRECT worker the whole repository.
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
  return /\b(?:add|write|create|update|change|modify|fix|repair|remove|delete)\s+(?:(?:a|an|one|the|existing|focused|regression|unit|integration|failing|broken)\s+){0,5}tests?\b/i.test(task) ||
    /\b(?:add|implement|create)\b[^\n]{0,160}\bwith\s+(?:focused|regression)\s+tests?\b/i.test(task) ||
    /\btests?\b[^.;\n]{0,80}\b(?:is|are)\s+(?:wrong|broken|incorrect)\b/i.test(task);
}

export function directWritePaths(
  files: string[],
  profile: RepoProfile,
  task = "",
): string[] {
  // A matching regression test is verification context, not write permission.
  // Explicit requests to change tests retain a coupled implementation scope.
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

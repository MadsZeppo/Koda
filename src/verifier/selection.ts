import { verificationPlan } from "./plan.js";
import { posix } from "node:path";
import type { Subtask } from "../planner/schemas.js";
import type { RepoProfile } from "../types.js";
import {
  isSourcePath,
  isTestPath,
  type WorkerContext,
} from "../context/compiler.js";

const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

const normalizeCommand = (command: string) =>
  command.replace(/\b(npm|pnpm|yarn|bun)\s+run\s+/g, "$1 ").trim();

const safeTestArguments = (argumentsText: string) =>
  !/[;&|><`$\\\r\n\0]/.test(argumentsText) &&
  !/(?:^|\s)(?:\/|\.\.?(?:\/|\s|$))/.test(argumentsText) &&
  argumentsText
    .split(/\s+/)
    .some((argument) =>
      /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\.[\w*]+$/.test(
        argument.replace(/^['"]|['"]$/g, ""),
      ),
    );

/** Keep model-proposed checks subordinate to executable repository evidence. */
export function repoBackedVerificationCommands(
  commands: string[],
  profile: RepoProfile,
): string[] {
  const knownCandidates =
    profile.ecosystem?.projectUnits.flatMap((unit) => unit.verification) ?? [];

  const candidates = knownCandidates.filter((candidate) => candidate.available);

  const profiledCommands = profile.verificationCommands.filter((command) => {
    const matches = knownCandidates.filter(
      (candidate) =>
        normalizeCommand(candidate.command) === normalizeCommand(command),
    );

    return !matches.length || matches.some((candidate) => candidate.available);
  });

  const nativeNodeTest =
    /\bnode\s+--test\b/.test(profile.scripts.test ?? "") ||
    profiledCommands.some((command) =>
      normalizeCommand(command).startsWith("node --test"),
    );

  return [
    ...new Set(
      commands.filter((command) => {
        const normalized = normalizeCommand(command);

        if (
          profiledCommands.some(
            (profiled) => normalizeCommand(profiled) === normalized,
          ) ||
          candidates.some(
            (candidate) => normalizeCommand(candidate.command) === normalized,
          )
        ) {
          return true;
        }

        if (
          nativeNodeTest &&
          /^node --test(?:\s+.+)?$/.test(normalized) &&
          safeTestArguments(normalized.slice("node --test".length).trim())
        ) {
          return true;
        }

        return candidates.some((candidate) => {
          const base = normalizeCommand(candidate.command);

          if (
            candidate.kind !== "test" ||
            !/^(?:npm|pnpm|yarn|bun) test$/.test(base) ||
            !normalized.startsWith(base + " -- ")
          ) {
            return false;
          }

          return safeTestArguments(normalized.slice((base + " -- ").length));
        });
      }),
    ),
  ];
}

const relevantTests = (target: string, tests: WorkerContext["files"]) => {
  const name = posix.basename(target);
  const stem = name.replace(/\.[^.]+$/, "");

  return tests.filter(
    (test) =>
      posix.basename(test.path).split(/[._-]/).includes(stem) ||
      test.snippet.includes(name),
  );
};

function targetedNativeCheck(
  subtask: Subtask,
  profile: RepoProfile,
  context: WorkerContext,
) {
  if (
    profile.scripts.pretest ||
    profile.scripts.posttest ||
    !/^node --test(?:\s+[\w./*'-]+)*$/.test(profile.scripts.test ?? "")
  ) {
    return undefined;
  }

  const targets = subtask.likelyWritePaths.filter(isSourcePath);

  const tests = context.files.filter(
    (file) => isTestPath(file.path) && /\.[cm]?js$/.test(file.path),
  );

  return targets.length &&
    targets.every((target) => relevantTests(target, tests).length)
    ? "node --test " +
        [
          ...new Set(
            targets.flatMap((target) =>
              relevantTests(target, tests).map((file) => file.path),
            ),
          ),
        ]
          .map(quote)
          .join(" ")
    : undefined;
}

function targetedTsxCheck(subtask: Subtask, profile: RepoProfile, context: WorkerContext) {
  if (profile.scripts.pretest || profile.scripts.posttest ||
      !/^tsx --test tests\/\*\.test\.ts$/.test(profile.scripts.test ?? "") ||
      profile.packageManager !== "pnpm") return undefined;
  const tests = context.files.map((file) => file.path)
    .filter((file) => subtask.likelyWritePaths.includes(file) &&
      /^tests\/[\w./-]+\.test\.ts$/.test(file));
  return tests.length ? `pnpm exec tsx --test ${tests.map(quote).join(" ")}` : undefined;
}

export function targetedProjectUnitNativeCheck(
  subtask: Subtask,
  profile: RepoProfile,
  context: WorkerContext,
) {
  const targets = subtask.likelyWritePaths.filter(
    (path) => !/\.(?:test|spec)\.[^/]+$/i.test(path),
  );

  if (!targets.length) return undefined;

  const tests = context.files.filter(
    (file) => isTestPath(file.path) && /\.[cm]?js$/.test(file.path),
  );

  for (const unit of profile.ecosystem?.projectUnits ?? []) {
    if (
      unit.scripts.pretest ||
      unit.scripts.posttest ||
      !/^node --test(?:\s+[\w./*'-]+)*$/.test(unit.scripts.test ?? "")
    ) {
      continue;
    }

    const testCandidate = unit.verification.find(
      (candidate) => candidate.kind === "test" && candidate.available,
    );

    if (!testCandidate) continue;

    const cwd = testCandidate.cwd ?? ".";

    // Root checks retain the existing selection policy.
    // This helper only specializes nested project-unit runners.
    if (cwd === ".") continue;

    const matches = targets.map((target) =>
      relevantTests(target, tests).filter((test) =>
        test.path.startsWith(cwd + "/"),
      ),
    );

    if (matches.some((group) => group.length === 0)) {
      continue;
    }

    const testPaths = [
      ...new Set(matches.flat().map((test) => posix.relative(cwd, test.path))),
    ];

    if (!testPaths.length) continue;

    return (
      `cd ${quote(cwd)} && ` + "node --test " + testPaths.map(quote).join(" ")
    );
  }

  return undefined;
}

export function workerChecks(
  subtask: Subtask,
  profile: RepoProfile,
  context: WorkerContext,
): string[] {
  const declared = repoBackedVerificationCommands(
    subtask.verificationCommands,
    profile,
  );

  if (subtask.verificationCommands.length) {
    return declared;
  }

  // Keep existing root-runner behavior unchanged.
  // Only specialize nested project-unit runners when there is a clear
  // source -> test relationship.
  const targeted =
    targetedNativeCheck(subtask, profile, context) ??
    targetedTsxCheck(subtask, profile, context) ??
    targetedProjectUnitNativeCheck(subtask, profile, context);

  if (targeted) return [targeted];

  return profile.ecosystem?.projectUnits.some(
    (unit) => unit.verification.length,
  )
    ? verificationPlan(profile, subtask.likelyWritePaths).map(
        (candidate) => candidate.command,
      )
    : profile.verificationCommands;
}

/** Documentation checks must explicitly name the changed document or a docs runner. */
export function tinyDocumentationChecks(
  profile: RepoProfile,
  target: string,
): string[] {
  const basename = posix.basename(target).toLowerCase();

  return verificationPlan(profile, [target], true)
    .filter((candidate) => {
      const script = candidate.source.split("scripts.")[1];

      const unit = profile.ecosystem?.projectUnits.find((entry) =>
        entry.verification.includes(candidate),
      );

      const body = script ? (unit?.scripts[script] ?? "") : "";

      const evidence = `${candidate.command} ${body}`.toLowerCase();

      return (
        candidate.available &&
        (evidence.includes(target.toLowerCase()) ||
          evidence.includes(basename) ||
          /\b(?:markdown|docs?|readme)\b/.test(evidence))
      );
    })
    .map((candidate) => candidate.command);
}

export function workerChecksAreTaskSpecific(
  subtask: Subtask,
  profile: RepoProfile,
  context: WorkerContext,
) {
  if (
    targetedNativeCheck(subtask, profile, context) !== undefined ||
    targetedTsxCheck(subtask, profile, context) !== undefined ||
    targetedProjectUnitNativeCheck(subtask, profile, context) !== undefined
  ) {
    return true;
  }

  const tests = context.files.filter((file) => isTestPath(file.path));

  return repoBackedVerificationCommands(
    subtask.verificationCommands,
    profile,
  ).some((command) => {
    const mentioned = tests.filter((test) => command.includes(test.path));

    if (!mentioned.length) return false;

    return subtask.likelyWritePaths.every((target) =>
      isTestPath(target)
        ? mentioned.some((test) => test.path === target)
        : relevantTests(target, mentioned).length > 0,
    );
  });
}

export function objectiveCanBeAlreadySatisfied(subtask: Subtask) {
  const requests = [
    subtask.title,
    subtask.objective,
    subtask.integrationContract,
  ].map((value) => value.trim().toLowerCase());

  return !requests.some((request) =>
    /^(?:add|create|introduce|write|document|rename|remove|delete|refactor)\b|[,;:]\s*(?:add|create|introduce|write|document|rename|remove|delete|refactor)\b|\b(?:must|should|please|needs? to)\s+(?:add|create|introduce|write|document|rename|remove|delete|refactor)\b|\b(?:regression|new)\s+(?:test|coverage|file|command|section|bullet)\b/.test(
      request,
    ),
  );
}

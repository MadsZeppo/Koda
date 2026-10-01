#!/usr/bin/env python3
from __future__ import annotations

import shutil
import subprocess
from datetime import datetime
from pathlib import Path


ROOT = Path("/Users/madsflyvholm/Desktop/Koda.ai").resolve()

SELECTION = ROOT / "src/verifier/selection.ts"
CODING = ROOT / "src/agent/codingExecutor.ts"
RUN = ROOT / "src/run.ts"
TEST = ROOT / "tests/focusedVerificationSelection.test.ts"

REQUIRED = [SELECTION, CODING, RUN]

for path in REQUIRED:
    if not path.exists():
        raise SystemExit(f"Missing expected file: {path}")


texts = {path: path.read_text() for path in REQUIRED}


def replace_once(
    path: Path,
    old: str,
    new: str,
    label: str,
) -> None:
    text = texts[path]

    if new in text and old not in text:
        print(f"[already] {label}")
        return

    count = text.count(old)

    if count != 1:
        raise SystemExit(
            "\nSTOPPED before writing anything.\n"
            f"{label}: expected exactly 1 old block in {path}, found {count}.\n"
            "Your local file no longer matches the pushed branch."
        )

    texts[path] = text.replace(old, new, 1)
    print(f"[patch] {label}")


def insert_before_once(
    path: Path,
    marker: str,
    addition: str,
    label: str,
) -> None:
    text = texts[path]

    if addition.strip() in text:
        print(f"[already] {label}")
        return

    count = text.count(marker)

    if count != 1:
        raise SystemExit(
            "\nSTOPPED before writing anything.\n"
            f"{label}: expected exactly 1 marker in {path}, found {count}."
        )

    texts[path] = text.replace(marker, addition + marker, 1)
    print(f"[patch] {label}")


# ============================================================================
# 1. src/verifier/selection.ts
# ============================================================================

insert_before_once(
    SELECTION,
    "function targetedNativeCheck(\n",
    r'''export function verificationImpactRelationships(
  changedPaths: readonly string[],
  context: WorkerContext,
): VerificationImpactEvidence[] {
  const known = new Set(context.files.map((file) => file.path));

  const imports = new Map(
    context.files.map((file) => [
      file.path,
      resolveImports(file.path, file.snippet, known),
    ]),
  );

  const reaches = (from: string, target: string) => {
    const pending = [from];
    const seen = new Set<string>();

    while (pending.length) {
      const current = pending.pop()!;

      if (current === target) return true;
      if (seen.has(current)) continue;

      seen.add(current);
      pending.push(...(imports.get(current) ?? []));
    }

    return false;
  };

  return changedPaths
    .filter(isSourcePath)
    .flatMap((source): VerificationImpactEvidence[] => {
      const tests = [
        ...new Set(
          context.files
            .filter(
              (file) =>
                isTestPath(file.path) &&
                reaches(file.path, source),
            )
            .map((file) => file.path),
        ),
      ];

      return tests.length
        ? [
            {
              source,
              tests,
              basis: "import" as const,
            },
          ]
        : [];
    });
}

''',
    "add deterministic source->test import relationships",
)


replace_once(
    SELECTION,
    r'''function targetedTsxCheck(
  subtask: Subtask,
  profile: RepoProfile,
  context: WorkerContext,
) {
  if (
    profile.scripts.pretest ||
    profile.scripts.posttest ||
    !/^tsx --test tests\/\*\.test\.ts$/.test(profile.scripts.test ?? "") ||
    profile.packageManager !== "pnpm"
  )
    return undefined;
  const tests = context.files
    .map((file) => file.path)
    .filter(
      (file) =>
        subtask.likelyWritePaths.includes(file) &&
        /^tests\/[\w./-]+\.test\.ts$/.test(file),
    );
  return tests.length
    ? `pnpm exec tsx --test ${tests.map(quote).join(" ")}`
    : undefined;
}
''',
    r'''function targetedTsxCheck(
  subtask: Subtask,
  profile: RepoProfile,
  context: WorkerContext,
) {
  if (
    profile.scripts.pretest ||
    profile.scripts.posttest ||
    !/^tsx --test tests\/\*\.test\.ts$/.test(profile.scripts.test ?? "") ||
    profile.packageManager !== "pnpm"
  )
    return undefined;

  const directTests = subtask.likelyWritePaths.filter(
    (file) => /^tests\/[\w./-]+\.test\.ts$/.test(file),
  );

  const sourcePaths = subtask.likelyWritePaths.filter(isSourcePath);

  const relationships = verificationImpactRelationships(
    subtask.likelyWritePaths,
    context,
  );

  if (
    sourcePaths.length &&
    !sourcePaths.every((source) =>
      relationships.some(
        (relationship) =>
          relationship.source === source &&
          relationship.tests.length > 0,
      ),
    )
  )
    return undefined;

  const tests = [
    ...new Set([
      ...directTests,
      ...relationships.flatMap(
        (relationship) => relationship.tests,
      ),
    ]),
  ].filter(
    (file) => /^tests\/[\w./-]+\.test\.ts$/.test(file),
  );

  return tests.length
    ? `pnpm exec tsx --test ${tests.map(quote).join(" ")}`
    : undefined;
}
''',
    "make root tsx verification source-aware",
)


insert_before_once(
    SELECTION,
    "export function workerChecks(\n",
    r'''export function focusedVerificationCheck(
  subtask: Subtask,
  profile: RepoProfile,
  context: WorkerContext,
) {
  return (
    targetedNativeCheck(subtask, profile, context) ??
    targetedTsxCheck(subtask, profile, context) ??
    targetedProjectUnitNativeCheck(subtask, profile, context)
  );
}

''',
    "add generic focused verification selector",
)


replace_once(
    SELECTION,
    r'''  // Keep existing root-runner behavior unchanged.
  // Only specialize nested project-unit runners when there is a clear
  // source -> test relationship.
  const targeted =
    targetedNativeCheck(subtask, profile, context) ??
    targetedTsxCheck(subtask, profile, context) ??
    targetedProjectUnitNativeCheck(subtask, profile, context);

  if (targeted) return [targeted];
''',
    r'''  const targeted = focusedVerificationCheck(
    subtask,
    profile,
    context,
  );

  if (targeted) return [targeted];
''',
    "route workerChecks through focused selector",
)


replace_once(
    SELECTION,
    r'''  if (
    targetedNativeCheck(subtask, profile, context) !== undefined ||
    targetedTsxCheck(subtask, profile, context) !== undefined ||
    targetedProjectUnitNativeCheck(subtask, profile, context) !== undefined
  ) {
    return true;
  }
''',
    r'''  if (
    focusedVerificationCheck(
      subtask,
      profile,
      context,
    ) !== undefined
  ) {
    return true;
  }
''',
    "reuse focused selector for task-specific proof",
)


# ============================================================================
# 2. src/agent/codingExecutor.ts
#
# finalVerificationOnly:
# - may run a proven focused check
# - must NOT fall back to the complete repository suite
# - final verification owns the broad safety gate
# ============================================================================

replace_once(
    CODING,
    r'''  objectiveCanBeAlreadySatisfied,
  workerChecks,
  workerChecksAreTaskSpecific,
  tinyDocumentationChecks,
''',
    r'''  focusedVerificationCheck,
  objectiveCanBeAlreadySatisfied,
  workerChecks,
  workerChecksAreTaskSpecific,
  tinyDocumentationChecks,
''',
    "import focusedVerificationCheck",
)


replace_once(
    CODING,
    r'''          : options.finalVerificationOnly
            ? verificationPlan(profile, [...writeScope.paths], true)
                .filter((check) => check.available)
                .map((check) => check.command)
            : workerChecks(subtask, profile, context));
''',
    r'''          : options.finalVerificationOnly
            ? (() => {
                const focused = focusedVerificationCheck(
                  subtask,
                  profile,
                  context,
                );

                return focused ? [focused] : [];
              })()
            : workerChecks(subtask, profile, context));
''',
    "prevent broad worker verification before final verification",
)


replace_once(
    CODING,
    r'''    if (
      afterMutation &&
      !tinyDocs &&
      !selected.length &&
      !postMutationRecoveryAttempted
    ) {
''',
    r'''    if (
      afterMutation &&
      !options.finalVerificationOnly &&
      !tinyDocs &&
      !selected.length &&
      !postMutationRecoveryAttempted
    ) {
''',
    "disable full-suite recovery during final handoff",
)


replace_once(
    CODING,
    r'''    const candidateAccepted =
      relative.status === "VERIFIED_SUCCESS" ||
      relative.status === "CANDIDATE_NEUTRAL" ||
      relative.status === "CANDIDATE_IMPROVEMENT";
    if (
      candidateAccepted ||
      advisoryInfrastructureOnly(relative) ||
      (options.tinyDirect &&
        options.finalVerificationOnly &&
        candidateVerification.status !== "FAILED")
    ) {
''',
    r'''    const candidateAccepted =
      relative.status === "VERIFIED_SUCCESS" ||
      relative.status === "CANDIDATE_NEUTRAL" ||
      relative.status === "CANDIDATE_IMPROVEMENT";

    const finalVerificationHandoff =
      options.finalVerificationOnly &&
      (
        candidateVerification.checks.length === 0 ||
        candidateVerification.status === "VERIFIED_SUCCESS"
      );

    if (
      candidateAccepted ||
      finalVerificationHandoff ||
      advisoryInfrastructureOnly(relative) ||
      (options.tinyDirect &&
        options.finalVerificationOnly &&
        candidateVerification.status !== "FAILED")
    ) {
''',
    "allow candidate to proceed to immediate final verification",
)


# ============================================================================
# 3. src/run.ts
# ============================================================================

replace_once(
    RUN,
    r'''  repoBackedVerificationCommands,
  impactAwareVerificationSelection,
  tinyDocumentationChecks,
  targetedProjectUnitNativeCheck,
''',
    r'''  repoBackedVerificationCommands,
  impactAwareVerificationSelection,
  focusedVerificationCheck,
  tinyDocumentationChecks,
  verificationImpactRelationships,
''',
    "import focused verification helpers",
)


# Stable: after the exact changed files are known, include OpenHands-discovered
# tests in bounded context and use the generic root-aware selector.

replace_once(
    RUN,
    r'''        const repairContext = await compileContext(
          integration.path,
          options.task,
          actualChangedPaths,
          repairProfile,
          options.config.context,
          true,
        );

        const stableFocusedCheck = targetedProjectUnitNativeCheck(
          repairSubtask,
          repairProfile,
          repairContext,
        );
''',
    r'''        const repairContext = await compileContext(
          integration.path,
          options.task,
          [
            ...new Set([
              ...actualChangedPaths,
              ...exploration.relatedTests,
            ]),
          ],
          repairProfile,
          options.config.context,
          true,
        );

        const stableFocusedCheck = focusedVerificationCheck(
          repairSubtask,
          repairProfile,
          repairContext,
        );
''',
    "make Stable verification root-runner aware",
)


# Direct: after mutation, build bounded verification context once.
# Do not trust a broad aggregate test simply because it is in package.json.

replace_once(
    RUN,
    r'''      // Preserve the authoritative DIRECT target even when the worker returns
      // no diff. Final verification must not expand an empty change set to all
      // project units (for example unrelated fixture packages).
      directRepairContext = { subtask, context };
      const directTestTargets = subtask.likelyWritePaths.filter(isTestPath);
      const directFocusedChecks = result.verification.checks
        .filter((check) =>
          directTestTargets.some((path) => check.command.includes(path)),
        )
        .map((check) => check.command);
      if (
        directTestTargets.length === subtask.likelyWritePaths.length &&
        directFocusedChecks.length
      ) {
        taskVerificationCommands = [...new Set(directFocusedChecks)];
        taskVerificationIsFocused = true;
      }
''',
    r'''      // Preserve the authoritative DIRECT target even when the worker returns
      // no diff. Build a bounded post-mutation verification context so source
      // -> test relationships can be proven without running the aggregate suite.
      const directVerificationProfile = await profileRepo(
        integration.path,
      );

      const directVerificationContext = await compileContext(
        integration.path,
        options.task,
        [
          ...new Set([
            ...subtask.likelyWritePaths,
            ...exploration.relatedTests,
          ]),
        ],
        directVerificationProfile,
        options.config.context,
        true,
      );

      directRepairContext = {
        subtask,
        context: directVerificationContext,
      };

      const directFocusedCheck = focusedVerificationCheck(
        subtask,
        directVerificationProfile,
        directVerificationContext,
      );

      if (directFocusedCheck) {
        taskVerificationCommands = [directFocusedCheck];
        taskVerificationIsFocused = true;
      }
''',
    "make Direct verification source-aware",
)


# Final verification:
# Build a bounded impact context, recover a focused check if possible,
# then feed explicit import relationships into impactAwareVerificationSelection.

replace_once(
    RUN,
    r'''    if (!taskVerificationIsFocused)
      taskVerificationCommands = repoBackedVerificationCommands(
        taskVerificationCommands,
        finalProfile,
      );
    const impact = impactAwareVerificationSelection({
''',
    r'''    const impactContext = verificationPaths.length
      ? await compileContext(
          integration.path,
          options.task,
          [
            ...new Set([
              ...verificationPaths,
              ...exploration.relatedTests,
            ]),
          ],
          finalProfile,
          options.config.context,
          true,
        )
      : undefined;

    const verificationRelationships = impactContext
      ? verificationImpactRelationships(
          verificationPaths,
          impactContext,
        )
      : [];

    const verificationSubtask =
      stableRepairContext?.subtask ??
      directRepairContext?.subtask;

    if (
      !taskVerificationIsFocused &&
      verificationSubtask &&
      impactContext
    ) {
      const finalFocusedCheck = focusedVerificationCheck(
        {
          ...verificationSubtask,
          likelyWritePaths: [...verificationPaths],
        },
        finalProfile,
        impactContext,
      );

      if (finalFocusedCheck) {
        taskVerificationCommands = [finalFocusedCheck];
        taskVerificationIsFocused = true;
      }
    }

    if (!taskVerificationIsFocused)
      taskVerificationCommands = repoBackedVerificationCommands(
        taskVerificationCommands,
        finalProfile,
      );

    const impact = impactAwareVerificationSelection({
''',
    "build bounded final impact context",
)


replace_once(
    RUN,
    r'''      candidates: allFinalCandidates,
      focusedCommands: taskVerificationCommands,
    });
''',
    r'''      candidates: allFinalCandidates,
      focusedCommands: taskVerificationCommands,
      relationships: verificationRelationships,
    });
''',
    "feed source-to-test relationships into final selection",
)


# ============================================================================
# 4. Regression tests
# ============================================================================

TEST_CONTENT = r'''import { test } from "node:test";
import assert from "node:assert/strict";

import type { Subtask } from "../src/planner/schemas.js";
import type { RepoProfile } from "../src/types.js";
import type { VerificationCandidate } from "../src/repo/ecosystem.js";
import type { WorkerContext } from "../src/context/compiler.js";

import {
  focusedVerificationCheck,
  impactAwareVerificationSelection,
  verificationImpactRelationships,
} from "../src/verifier/selection.js";


const aggregateTest: VerificationCandidate = {
  kind: "test",
  command: "pnpm test",
  cwd: ".",
  source: "package.json:scripts.test",
  confidence: 1,
  available: true,
  mutatesSource: false,
  requiresInstalledDependencies: true,
};


const typecheck: VerificationCandidate = {
  kind: "typecheck",
  command: "pnpm typecheck",
  cwd: ".",
  source: "package.json:scripts.typecheck",
  confidence: 1,
  available: true,
  mutatesSource: false,
  requiresInstalledDependencies: true,
};


const profile = {
  scripts: {
    test: "tsx --test tests/*.test.ts",
    typecheck: "tsc --noEmit",
  },

  packageManager: "pnpm",

  verificationCommands: [
    "pnpm test",
    "pnpm typecheck",
  ],

  ecosystem: {
    projectUnits: [
      {
        root: ".",

        scripts: {
          test: "tsx --test tests/*.test.ts",
          typecheck: "tsc --noEmit",
        },

        verification: [
          aggregateTest,
          typecheck,
        ],
      },
    ],
  },
} as unknown as RepoProfile;


const makeSubtask = (
  paths: string[],
): Subtask =>
  ({
    id: "verification-test",
    title: "change source",
    objective: "change source",

    dependsOn: [],

    likelyReadPaths: [],
    likelyWritePaths: paths,

    integrationContract: "preserve behavior",
    verificationCommands: [],

    estimatedDifficulty: "normal",
    parallelSafe: false,
  }) as Subtask;


const makeContext = (
  testSource: string,
): WorkerContext => ({
  files: [
    {
      path: "src/foo.ts",
      snippet: "export const foo = () => 1;",
    },

    {
      path: "tests/foo.test.ts",
      snippet: testSource,
    },
  ],

  repoMap: [
    "src/foo.ts",
    "tests/foo.test.ts",
  ],

  localDependencies: [],
});


test(
  "source import relationship selects only the impacted root tsx test",
  () => {
    const workerContext = makeContext(
      'import { foo } from "../src/foo.js";\nvoid foo();',
    );

    const subtask = makeSubtask([
      "src/foo.ts",
    ]);

    const command = focusedVerificationCheck(
      subtask,
      profile,
      workerContext,
    );

    assert.equal(
      command,
      "pnpm exec tsx --test 'tests/foo.test.ts'",
    );

    const relationships =
      verificationImpactRelationships(
        subtask.likelyWritePaths,
        workerContext,
      );

    assert.deepEqual(
      relationships,
      [
        {
          source: "src/foo.ts",
          tests: ["tests/foo.test.ts"],
          basis: "import",
        },
      ],
    );

    const selected =
      impactAwareVerificationSelection({
        changedPaths: [
          "src/foo.ts",
        ],

        candidates: [
          aggregateTest,
          typecheck,
        ],

        focusedCommands: [
          command!,
        ],

        relationships,
      });

    assert.equal(
      selected.whyFullSuite,
      false,
    );

    assert.deepEqual(
      selected.impactedTests,
      ["tests/foo.test.ts"],
    );

    assert.deepEqual(
      selected.candidates.map(
        (candidate) => candidate.command,
      ),
      [
        "pnpm typecheck",
      ],
    );
  },
);


test(
  "unknown source to test relationship keeps aggregate suite",
  () => {
    const workerContext = makeContext(
      'import { other } from "../src/other.js";\nvoid other;',
    );

    const subtask = makeSubtask([
      "src/foo.ts",
    ]);

    assert.equal(
      focusedVerificationCheck(
        subtask,
        profile,
        workerContext,
      ),
      undefined,
    );

    const selected =
      impactAwareVerificationSelection({
        changedPaths: [
          "src/foo.ts",
        ],

        candidates: [
          aggregateTest,
          typecheck,
        ],

        focusedCommands: [],

        relationships:
          verificationImpactRelationships(
            subtask.likelyWritePaths,
            workerContext,
          ),
      });

    assert.equal(
      selected.whyFullSuite,
      true,
    );

    assert.deepEqual(
      selected.candidates.map(
        (candidate) => candidate.command,
      ),
      [
        "pnpm test",
        "pnpm typecheck",
      ],
    );
  },
);


test(
  "exact changed tsx test can be run directly",
  () => {
    const workerContext = makeContext(
      'import { foo } from "../src/foo.js";\nvoid foo();',
    );

    assert.equal(
      focusedVerificationCheck(
        makeSubtask([
          "tests/foo.test.ts",
        ]),
        profile,
        workerContext,
      ),
      "pnpm exec tsx --test 'tests/foo.test.ts'",
    );
  },
);


test(
  "risky repository contract changes still require broad verification",
  () => {
    const selected =
      impactAwareVerificationSelection({
        changedPaths: [
          "package.json",
        ],

        candidates: [
          aggregateTest,
          typecheck,
        ],

        focusedCommands: [],
        relationships: [],
      });

    assert.equal(
      selected.whyFullSuite,
      true,
    );

    assert.deepEqual(
      selected.candidates.map(
        (candidate) => candidate.command,
      ),
      [
        "pnpm test",
        "pnpm typecheck",
      ],
    );
  },
);
'''


# ============================================================================
# Validate transformations BEFORE touching the files.
# ============================================================================

for path, text in texts.items():
    if not text.strip():
        raise SystemExit(
            f"Refusing to write empty file: {path}"
        )


# ============================================================================
# Backups
# ============================================================================

stamp = datetime.now().strftime(
    "%Y%m%d-%H%M%S"
)

backup_dir = (
    ROOT
    / ".koda"
    / "backups"
    / f"verification-fix-{stamp}"
)

backup_dir.mkdir(
    parents=True,
    exist_ok=False,
)


for path in REQUIRED:
    relative = path.relative_to(ROOT)

    destination = (
        backup_dir / relative
    )

    destination.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    shutil.copy2(
        path,
        destination,
    )


if TEST.exists():
    destination = (
        backup_dir
        / TEST.relative_to(ROOT)
    )

    destination.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    shutil.copy2(
        TEST,
        destination,
    )


# ============================================================================
# Write only after every expected source block has been validated.
# ============================================================================

for path, text in texts.items():
    path.write_text(text)


TEST.write_text(
    TEST_CONTENT
)


print(
    f"\nBackups: {backup_dir}"
)

print(
    "\nPatched:"
)

for path in [
    SELECTION,
    CODING,
    RUN,
    TEST,
]:
    print(
        "  -",
        path.relative_to(ROOT),
    )


# ============================================================================
# Verification
# ============================================================================

def run_command(
    command: list[str],
) -> None:
    print(
        "\n$",
        " ".join(command),
    )

    result = subprocess.run(
        command,
        cwd=ROOT,
    )

    if result.returncode != 0:
        raise SystemExit(
            "\nFAILED: "
            + " ".join(command)
            + "\n\nFiles ARE patched."
            + "\nBackups are here:\n"
            + str(backup_dir)
        )


run_command([
    "git",
    "diff",
    "--check",
])


run_command([
    "pnpm",
    "exec",
    "tsx",
    "--test",
    "tests/focusedVerificationSelection.test.ts",
    "tests/verificationDifferential.test.ts",
])


run_command([
    "pnpm",
    "typecheck",
])


print(
    "\n========================================"
)

print(
    "OK"
)

print(
    "Focused verification regression tests passed."
)

print(
    "Typecheck passed."
)

print(
    "Full pnpm test was NOT run automatically."
)

print(
    "========================================\n"
)
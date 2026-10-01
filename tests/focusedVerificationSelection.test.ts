import { test } from "node:test";
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

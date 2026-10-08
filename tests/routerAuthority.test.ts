import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import ts from "typescript";
import { config } from "../src/config.js";
import { PoolRouter } from "../src/router/modelRouter.js";
import { Logger } from "../src/telemetry/logger.js";
import { modelSchema } from "../src/router/pool.js";
import { extractFeatures } from "../src/router/features.js";
import { taskFingerprint } from "../src/router/taskFingerprint.js";
import { assessTask } from "../src/router/taskAssessment.js";
import { buildVerificationContract } from "../src/verifier/contract.js";
import {
  ContextualRouterVNext,
  type ContextualModelFacts,
} from "../src/router/contextualRouterVNext.js";
import { authoritativeRoutingDecision } from "../src/router/routingAuthority.js";
import { canonicalRoutingTask } from "../src/router/canonicalTask.js";
import { fitContextualQuality } from "../src/router/contextualQuality.js";
import { adaptHistoricalQualityOutcome } from "../src/router/knowledge/canonicalHistoryAdapter.js";
import type { Attempt } from "../src/router/history.js";
import type { CanonicalQualityObservation } from "../src/router/knowledge/canonical.js";

const task = canonicalRoutingTask({
  family: "debugging",
  engine: "direct",
  harness: "koda",
});
function artifact() {
  const rows: CanonicalQualityObservation[] = Array.from(
    { length: 150 },
    (_, i) => ({
      id: `observation-${i}`,
      taskId: `public-task-${i}`,
      task,
      model: "test/model-v1",
      revision: "test/model-v1",
      identity: "EXACT",
      source: "public-fixture",
      split: "development",
      origin: "external",
      provenance: "public-fixture:v1",
      timestamp: "2026-10-06",
      success: i % 10 !== 0,
      trainingAllowed: true,
    }),
  );
  return fitContextualQuality(rows, "empirical", "2026-10-06");
}
const facts: ContextualModelFacts = {
  id: "test/model-v1",
  compatible: true,
  inputPrice: 1,
  outputPrice: 1,
  latencyMs: 10,
  p90Ms: 15,
};
const input = {
  task,
  models: [facts],
  inputTokens: 100,
  outputTokens: 100,
  budgetUsd: 1,
  allowedRegret: 0.02,
  maxFalseAccept: 0.01,
};

test("VNext quality and decision are independent of qualityPrior, tiers and legacy posterior", () => {
  const router = new ContextualRouterVNext(artifact());
  const a = router.decide({
    ...input,
    models: [
      {
        ...facts,
        qualityPrior: 0.01,
        tier: "cheap",
        specialistQuality: 0,
      } as ContextualModelFacts,
    ],
  });
  const b = router.decide({
    ...input,
    models: [
      {
        ...facts,
        qualityPrior: 0.99,
        tier: "frontier",
        specialistQuality: 1,
      } as ContextualModelFacts,
    ],
  });
  assert.ok("candidates" in a && "candidates" in b);
  assert.deepEqual(
    a.candidates.map((c) => c.quality),
    b.candidates.map((c) => c.quality),
  );
  const normalize = (x: typeof a) => {
    const { elapsedMs, ...rest } = x as typeof a & { elapsedMs?: number };
    return rest;
  };
  assert.deepEqual(normalize(a), normalize(b));
  const poisoned = { ...facts };
  for (const key of [
    "qualityPrior",
    "tier",
    "legacyPosterior",
    "legacyReference",
    "legacyFallbackRanking",
  ])
    Object.defineProperty(poisoned, key, {
      get() {
        throw Error(`Forbidden legacy quality access ${key}`);
      },
    });
  assert.doesNotThrow(() => router.decide({ ...input, models: [poisoned] }));
});

test("VNext abstention cannot become the legacy selection, including future explicit activation", () => {
  const legacy = { model: "legacy-winner" };
  const router = new ContextualRouterVNext();
  const abstain = () => router.decide(input);
  assert.deepEqual(
    authoritativeRoutingDecision("shadow", () => legacy, abstain),
    { authority: "legacy", decision: legacy },
  );
  const result = authoritativeRoutingDecision(
    "contextual-vnext",
    () => {
      throw Error("Legacy must not be consulted");
    },
    abstain,
  );
  assert.equal(result.authority, "contextual-vnext");
  assert.equal(result.decision.status, "ABSTAIN");
  assert.ok(!("selected" in result.decision));
  assert.equal(
    authoritativeRoutingDecision(
      "legacy",
      () => legacy,
      () => {
        throw Error("No VNext dispatch");
      },
    ).decision,
    legacy,
  );
});

test("VNext rejects a legacy-quality object masquerading as an artifact", () => {
  assert.throws(
    () => new ContextualRouterVNext({ qualityPrior: 0.99 } as never),
  );
});

test("legacy history contributes only through canonical outcome normalization and independent proof", () => {
  const row: Attempt = {
    timestamp: "2026-10-06",
    runId: "r",
    subtaskId: "s",
    modelRequested: facts.id,
    modelServed: facts.id,
    features: {} as never,
    verification: "VERIFIED_SUCCESS",
    wallClockMs: 20,
    inputTokens: 30,
    outputTokens: 40,
    costUsd: null,
    escalated: false,
    predictedQuality: 0.99,
    predictedCostUsd: 1,
  };
  const evidence = {
    task,
    provenance: "independent-validator.json",
    exactRevision: facts.id,
  };
  assert.equal(adaptHistoricalQualityOutcome(row, evidence), undefined);
  const converted = adaptHistoricalQualityOutcome(row, {
    ...evidence,
    proof: { independent: true, requirementLevel: true },
  })!;
  assert.equal(converted.costUsd, undefined);
  assert.equal(converted.success, true);
  assert.ok(!("predictedQuality" in converted));
  assert.ok(!("features" in converted));
  assert.equal(
    adaptHistoricalQualityOutcome(row, {
      ...evidence,
      proof: { independent: true, requirementLevel: true },
      synthetic: true,
    }),
    undefined,
  );
  assert.equal(
    adaptHistoricalQualityOutcome(
      { ...row, verification: "FAILED" },
      {
        ...evidence,
        attribution: {
          primaryCause: "PROVIDER_FAILURE",
          learningDisposition: "CENSORED",
        },
      },
    ),
    undefined,
  );
  assert.equal(
    adaptHistoricalQualityOutcome(
      { ...row, verification: "FAILED" },
      {
        ...evidence,
        attribution: {
          primaryCause: "MODEL_FAILURE",
          learningDisposition: "NEGATIVE_MODEL_EVIDENCE",
        },
      },
    )?.success,
    false,
  );
});

test("VNext runtime dependency graph cannot call legacy quality estimation or ranking", async () => {
  const forbidden = new Set([
    "routeOptimizer.ts",
    "legacyProductionRouter.ts",
    "routingV1.ts",
    "controlPolicy.ts",
    "estimator.ts",
    "capabilityRegistry.ts",
    "history.ts",
  ]);
  const visited = new Set<string>();
  async function visit(path: string) {
    if (visited.has(path)) return;
    visited.add(path);
    const source = ts.createSourceFile(
      path,
      await readFile(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const statement of source.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        statement.importClause?.isTypeOnly ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      )
        continue;
      if (
        statement.importClause?.namedBindings &&
        ts.isNamedImports(statement.importClause.namedBindings) &&
        statement.importClause.namedBindings.elements.every((e) => e.isTypeOnly)
      )
        continue;
      const spec = statement.moduleSpecifier.text;
      if (!spec.startsWith(".")) continue;
      const child = resolve(dirname(path), spec.replace(/\.js$/, ".ts"));
      assert.ok(
        !forbidden.has(child.split("/").at(-1)!),
        `Forbidden VNext dependency: ${path} -> ${child}`,
      );
      await visit(child);
    }
  }
  await visit(resolve("src/router/contextualRouterVNext.ts"));
  assert.ok(visited.size > 1);
});

test("actual PoolRouter shadow on/off preserves complete production policy and history bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "authority-"));
  try {
    const subtask = {
      id: "task",
      title: "Fix arithmetic helper",
      objective: "Fix arithmetic helper",
      likelyWritePaths: ["src/value.ts"],
      likelyReadPaths: [],
      dependsOn: [],
      integrationContract: "",
      verificationCommands: [],
      estimatedDifficulty: "normal" as const,
      parallelSafe: true,
    };
    const profile = {
      files: ["src/value.ts"],
      languages: ["typescript"],
      frameworks: [],
      verificationCommands: [],
    } as never;
    const features = extractFeatures(subtask, profile, 1000);
    const fp = taskFingerprint(subtask, profile, features, "normal");
    const assessment = assessTask({
      task: subtask.objective,
      facts: {
        files: ["src/value.ts"],
        resolvedPaths: ["src/value.ts"],
        relatedTests: [],
        components: ["src"],
        localizationConfidence: "high",
        checks: [],
      },
    });
    const contract = buildVerificationContract({
      task: subtask.objective,
      assessment,
    });
    const pool = [
      modelSchema.parse({
        id: "test/model-v1",
        tier: "fast",
        qualityPrior: 0.99,
        latencyPriorMs: 20,
        fallback: {
          inputPrice: 0.01,
          outputPrice: 0.02,
          contextLength: 100000,
          maxOutputTokens: 10000,
          supportedParameters: ["tools", "tool_choice"],
          available: true,
        },
      }),
    ];
    const c = await config(undefined, {
      modelPool: { provider: "openrouter", models: pool },
      routing: { stateDirectory: join(root, "history") },
      budgetUsd: 1,
    });
    const shared = pool.map((model) => ({
      model,
      metadata: model.fallback!,
      vision: false,
      configured: true,
      evidence: [],
    }));
    await writeFile(join(root, "unchanged"), "untouched");
    const decisions = [];
    for (const enabled of [false, true]) {
      const logger = new Logger(join(root, `log-${enabled}`), "same-run", true);
      logger.log("task_assessment", { assessment });
      logger.log("verification_contract", { contract });
      if (!enabled) logger.log("routing_contextual_shadow_disabled");
      const router = new PoolRouter(c, logger);
      if (!enabled)
        await writeFile(
          router.history.path,
          ' {"type":"preexisting-marker"}\n',
        );
      router.capabilities.forTask = async () => shared;
      router.catalog.get = async () => new Map();
      decisions.push(await router.selectExecutionPlan(fp, features, "task", 1));
      assert.equal(
        logger.events.some(
          (e) => e.type === "routing_contextual_shadow_decision",
        ),
        enabled,
      );
      assert.deepEqual(router.history.read(), []);
      assert.deepEqual(router.history.readOperations(), []);
      assert.equal(
        await readFile(router.history.path, "utf8"),
        ' {"type":"preexisting-marker"}\n',
      );
      assert.equal(
        await readFile(join(root, "unchanged"), "utf8"),
        "untouched",
      );
    }
    assert.deepEqual(decisions[0], decisions[1]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import { readFile, access } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import {
  digest,
  freezeEvidence,
  writeImmutable,
} from "../router/knowledge/evidenceRegistry.js";
import { realBenchmarkSchema } from "./realBenchmark.js";
import type {
  CalibrationModel,
  CalibrationOptions,
} from "./nativeCalibration.js";
export async function calibrationHarnessDigest() {
  const paths = [
    "./nativeCalibration.ts",
    "./calibrationBudget.ts",
    "./calibrationTransport.ts",
    "./realBenchmark.ts",
    "./realBenchmarkWorker.ts",
    "../run.ts",
    "../agent/codingExecutor.ts",
    "../agent/agenticCodingWorker.ts",
    "../openrouter/client.ts",
    "../verifier/verifier.ts",
  ];
  return digest(
    await Promise.all(
      paths.map(async (path) => [
        path,
        digest(await readFile(new URL(path, import.meta.url), "utf8")),
      ]),
    ),
  );
}
export const eligibleCalibrationModel = (m: CalibrationModel) =>
  !m.id.startsWith("~") &&
  m.identityKind !== "composite" &&
  m.purposeRestricted !== true &&
  m.parameters.includes("tools") &&
  m.parameters.includes("tool_choice") &&
  m.context >= 16000 &&
  m.output >= 2000 &&
  [m.inputPrice, m.outputPrice].every((p) => Number.isFinite(p) && p >= 0) &&
  m.available !== false &&
  m.deprecated !== true &&
  m.endpointMode !== "batch" &&
  (!m.outputModalities || m.outputModalities.includes("text"));
/** Experimental diversity uses raw capabilities/price/age, never treats price or a vendor name as quality. */
export function diverseModels(
  models: CalibrationModel[],
  max: number,
  seed = "20261006",
) {
  if (!Number.isInteger(max) || max < 1 || max > 100)
    throw Error("Invalid model count");
  const pool = [
    ...new Map(
      models.filter(eligibleCalibrationModel).map((m) => [m.id, m]),
    ).values(),
  ].sort(
    (a, b) =>
      a.inputPrice + a.outputPrice - b.inputPrice - b.outputPrice ||
      a.id.localeCompare(b.id),
  );
  const selected: CalibrationModel[] = [];
  const reasons: Record<string, string[]> = {};
  const bucket = (m: CalibrationModel) =>
    Math.min(3, Math.floor((pool.indexOf(m) * 4) / Math.max(1, pool.length)));
  const features = (m: CalibrationModel) => [
    `provider:${m.provider}`,
    `family:${m.family}`,
    `price-quartile:${bucket(m)}`,
    `context:${Math.floor(Math.log2(m.context))}`,
    `reasoning:${m.parameters.includes("reasoning")}`,
    `coding-declared:${m.codingRelevance ?? "unknown"}`,
    `latency:${m.latencyMs === undefined ? "unknown" : Math.floor(Math.log2(Math.max(1, m.latencyMs)))}`,
    `age:${m.created === undefined ? "unknown" : Math.floor(m.created / (86400 * 90))}`,
  ];
  const covered = new Set<string>();
  // Price extremes and center are experimental anchors, NOT quality/frontier assertions.
  for (const index of [0, pool.length - 1, Math.floor(pool.length / 2)]) {
    const m = pool[index];
    if (m && selected.length < max && !selected.includes(m)) {
      selected.push(m);
      reasons[m.id] = ["price-range anchor; quality unknown"];
      features(m).forEach((f) => covered.add(f));
    }
  }
  while (selected.length < Math.min(max, pool.length)) {
    const weight = (f: string) =>
      f.startsWith("provider:") ? 8 : f.startsWith("family:") ? 4 : 1;
    const remaining = pool.filter((m) => !selected.includes(m));
    remaining.sort(
      (a, b) =>
        features(b)
          .filter((f) => !covered.has(f))
          .reduce((s, f) => s + weight(f), 0) -
          features(a)
            .filter((f) => !covered.has(f))
            .reduce((s, f) => s + weight(f), 0) ||
        digest([seed, a.id]).localeCompare(digest([seed, b.id])),
    );
    const m = remaining[0]!;
    reasons[m.id] = features(m).filter((f) => !covered.has(f));
    if (!reasons[m.id]!.length)
      reasons[m.id] = ["seeded sparse-evidence exploration"];
    selected.push(m);
    features(m).forEach((f) => covered.add(f));
  }
  return {
    selected,
    reasons,
    eligible: pool.length,
    discovered: models.length,
  };
}
export function stratifiedTasks(raw: any[], count: number, seed: string) {
  const candidates = raw.filter(
    (t) =>
      t.split === "development" &&
      (!t.role || ["DEVELOPMENT", "CALIBRATION"].includes(t.role)),
  );
  if (new Set(raw.map((t) => t.id)).size !== raw.length)
    throw Error("Duplicate task IDs / holdout leakage");
  const selected: any[] = [];
  const covered = new Set<string>();
  const features = (t: any) => [
    "family:" + t.category,
    "language:" + (t.language ?? "unknown"),
    "complexity:" + (t.complexity ?? "unknown"),
    "risk:" + (t.risk ?? "unknown"),
    "scope:" + (t.writeScope?.length > 1 ? "multi" : "localized-or-unknown"),
    "proof:" + (t.proofStrength ?? "unknown"),
    "framework:" + (t.framework ?? "unknown"),
  ];
  const score = (t: any) => features(t).filter((f) => !covered.has(f)).length;
  while (selected.length < Math.min(count, candidates.length)) {
    const remaining = candidates
      .filter((t) => !selected.includes(t))
      .sort(
        (a, b) =>
          score(b) - score(a) ||
          digest([seed, a.id]).localeCompare(digest([seed, b.id])),
      );
    const t = remaining[0]!;
    selected.push(t);
    features(t).forEach((f) => covered.add(f));
  }
  return selected.map((t) => ({
    ...realBenchmarkSchema.parse({ version: 1, tasks: [t] }).tasks[0]!,
    language: t.language ?? "unknown",
    complexity: t.complexity ?? "unknown",
    risk: t.risk ?? "unknown",
    framework: t.framework ?? "unknown",
    proofStrength: t.proofStrength ?? "unknown",
    estimatedPromptTokens: t.estimatedPromptTokens,
    estimatedOutputTokens: t.estimatedOutputTokens,
  }));
}
export async function makeCalibrationPlan(
  o: CalibrationOptions,
  all: CalibrationModel[],
  catalogSource: string,
  rawCatalogDigest: string,
) {
  if (
    ![o.budgetUsd, o.perAttemptBudgetUsd].every(
      (n) => Number.isFinite(n) && n > 0,
    ) ||
    !Number.isInteger(o.tasks) ||
    o.tasks < 1 ||
    o.tasks > 100 ||
    !Number.isInteger(o.parallel) ||
    o.parallel < 1 ||
    o.parallel > 32
  )
    throw Error("Explicit valid limits required");
  const raw = JSON.parse(await readFile(resolve(o.manifest), "utf8"));
  const seed = o.seed ?? "20261006";
  const selection = diverseModels(all, o.maxModels, seed);
  const models = o.probe
    ? ([all.find((m) => m.id === o.probe)].filter(
        Boolean,
      ) as CalibrationModel[])
    : o.models === "auto"
      ? selection.selected
      : o.models.split(",").map((id) => {
          const m = all.find((m) => m.id === id);
          if (!m) throw Error("Unknown model " + id);
          return m;
        });
  if (
    !models.length ||
    models.some((m) => !eligibleCalibrationModel(m)) ||
    new Set(models.map((m) => m.id)).size !== models.length
  )
    throw Error("Duplicate or incompatible calibration model");
  const tasks = stratifiedTasks(raw.tasks, o.anchorTasks ?? o.tasks, seed);
  if (!tasks.length) throw Error("No development/calibration tasks");
  const core = o.probe
    ? tasks.length
    : Math.min(o.denseCoreTasks ?? 20, tasks.length);
  const sparse = Math.min(o.sparseModelsPerTask ?? 8, models.length);
  if (
    !Number.isInteger(core) ||
    core < 0 ||
    !Number.isInteger(sparse) ||
    sparse < 1
  )
    throw Error("Invalid dense/sparse design");
  const configText = await readFile(resolve(o.config), "utf8");
  const configDigest = digest(configText);
  const executionHarnessDigest = await calibrationHarnessDigest();
  const cfg = JSON.parse(configText);
  const cells = tasks.flatMap((task, i) => {
    const assigned =
      i < core
        ? models
        : [...models]
            .sort((a, b) =>
              digest([seed, task.id, a.id]).localeCompare(
                digest([seed, task.id, b.id]),
              ),
            )
            .slice(0, sparse);
    return assigned.map((model) => {
      // Context/output defaults are explicitly estimates, never provider safety bounds.
      const prompt =
        task.estimatedPromptTokens ??
        Math.ceil(
          (Buffer.byteLength(task.task) + (cfg.context?.maxBytes ?? 16000)) / 3,
        ) + 1024;
      const output =
        task.estimatedOutputTokens ??
        Math.min(cfg.maxOutputTokens ?? 4096, model.output);
      const estimate =
        (prompt * model.inputPrice + output * model.outputPrice) / 1e6;
      return {
        id: digest([seed, task.id, digest(task), model.id, configDigest]),
        taskId: task.id,
        taskDigest: digest(task),
        modelId: model.id,
        modelMetadataDigest: digest(model),
        engine: o.engine ?? "agentic",
        executionConfigDigest: configDigest,
        seed,
        split: task.split,
        designation: i < core ? "dense-core" : "sparse",
        maximumUsd: o.perAttemptBudgetUsd,
        estimatedPromptTokens: prompt,
        estimatedOutputTokens: output,
        estimatedUsd: estimate,
        estimateBasis:
          "one request, original task + configured context allowance; actual multi-call usage unknown",
        attempts: 1,
        retries: 0,
        status: "PENDING",
      };
    });
  });
  const maximumUsd = cells.length * o.perAttemptBudgetUsd;
  if (maximumUsd > o.budgetUsd + 1e-9)
    throw Error(
      `Matrix maximum $${maximumUsd} exceeds explicit budget $${o.budgetUsd}`,
    );
  const preparedTasks = (
    await Promise.all(
      tasks.map(async (t) => {
        try {
          await access(resolve(dirname(resolve(o.manifest)), t.repo));
          await access(
            resolve(dirname(resolve(o.manifest)), t.oracleDirectory),
          );
          return true;
        } catch {
          return false;
        }
      }),
    )
  ).filter(Boolean).length;
  const base = {
    version: 2,
    seed,
    models,
    eligibleModels: all.filter(eligibleCalibrationModel),
    tasks,
    cells,
    modelSelectionReasons: Object.fromEntries(
      models.map((m) => [
        m.id,
        selection.reasons[m.id] ?? ["explicit model probe"],
      ]),
    ),
    discovered: selection.discovered,
    eligible: selection.eligible,
    availableTasks: raw.tasks.filter((t: any) => t.split === "development")
      .length,
    preparedTasks,
    runs: cells.length,
    denseCoreTasks: core,
    denseCoreCells: cells.filter((c) => c.designation === "dense-core").length,
    sparseCells: cells.filter((c) => c.designation === "sparse").length,
    maximumUsd,
    estimatedOverCapCells: cells.filter((c) => c.estimatedUsd > c.maximumUsd)
      .length,
    budgetUsd: o.budgetUsd,
    perAttemptBudgetUsd: o.perAttemptBudgetUsd,
    expectedUsd: cells.reduce((s, c) => s + c.estimatedUsd, 0),
    expectedCostBasis:
      "sum of one-call estimates, not a forecast of complete multi-call Koda tasks",
    estimatedCostRange: [0, maximumUsd],
    estimatedRuntimeMs: null,
    providers: [...new Set(models.map((m) => m.provider))],
    families: [...new Set(models.map((m) => m.family))],
    output: resolve(o.output),
    catalogSource,
    rawCatalogDigest,
    normalizedCatalogDigest: digest(all),
    configDigest,
    executionHarnessDigest,
    configText,
    manifestDigest: digest(await readFile(resolve(o.manifest), "utf8")),
    manifestPath: resolve(o.manifest),
    paidCalls: 0,
  };
  return { ...base, identity: digest(base) };
}
export async function persistCalibrationPlan(
  plan: Awaited<ReturnType<typeof makeCalibrationPlan>>,
) {
  const metadata = {
    sourceDigests: {
      catalog: plan.rawCatalogDigest,
      manifest: plan.manifestDigest,
    },
    modelMappingDigest: plan.normalizedCatalogDigest,
    taskVersion: 1,
    splitDigest: digest(plan.tasks.map((t) => [t.id, t.split])),
    estimatorVersion: "not-fitted",
    calibrationVersion: "native-controlled-v2",
    policyDigest: digest({
      engine: plan.cells[0]?.engine,
      budget: plan.budgetUsd,
      cellCap: plan.perAttemptBudgetUsd,
    }),
    timestamp: "frozen-plan",
    provenance: [plan.catalogSource, plan.manifestPath],
  };
  await writeImmutable(
    join(plan.output, "experiment.json"),
    freezeEvidence(plan, metadata),
  );
  await writeImmutable(
    join(plan.output, "model-snapshot.json"),
    freezeEvidence(
      {
        models: plan.eligibleModels,
        selectedIds: plan.models.map((m) => m.id),
        source: plan.catalogSource,
        rawDigest: plan.rawCatalogDigest,
        normalizedDigest: plan.normalizedCatalogDigest,
        fetchedAt: plan.models[0]?.fetchedAt ?? "unknown",
      },
      metadata,
    ),
  );
  await writeImmutable(
    join(plan.output, "task-snapshot.json"),
    freezeEvidence(plan.tasks, metadata),
  );
}

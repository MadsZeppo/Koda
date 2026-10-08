import {
  readFile,
  writeFile,
  mkdir,
  open,
  appendFile,
  rename,
  rm,
  access,
} from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { digest } from "../router/knowledge/evidenceRegistry.js";
import { runRealBenchmark, realBenchmarkSchema } from "./realBenchmark.js";
import { CanonicalRoutingKnowledgeStore } from "../router/knowledge/canonical.js";
import { nativeCalibrationObservation } from "../router/knowledge/nativeCalibrationAdapter.js";
import { canonicalRoutingTask } from "../router/canonicalTask.js";
import {
  makeCalibrationPlan,
  persistCalibrationPlan,
  diverseModels,
  calibrationHarnessDigest,
} from "./calibrationPlan.js";
import { CalibrationBudget } from "./calibrationBudget.js";
import { calibrationTransport } from "./calibrationTransport.js";
import { backendBaseUrl } from "../provider/transport.js";
import { validateEvidence } from "../router/knowledge/evidenceRegistry.js";
async function immutableText(path: string, text: string) {
  try {
    await writeFile(path, text, { flag: "wx" });
  } catch (e) {
    if (
      (e as NodeJS.ErrnoException).code !== "EEXIST" ||
      (await readFile(path, "utf8")) !== text
    )
      throw Error("Frozen plan cell mismatch");
  }
}
function calibrationSummary(
  p: Awaited<ReturnType<typeof makeCalibrationPlan>>,
) {
  return `# CALIBRATION PLAN\n\nModels: ${p.models.length}; tasks: ${p.tasks.length}; dense core: ${p.denseCoreCells}; sparse: ${p.sparseCells}; attempts: ${p.runs}.\n\nOne-request estimate: $${p.expectedUsd.toFixed(4)} (multi-call total unknown). Hard maximum: $${p.maximumUsd.toFixed(2)}; configured budget: $${p.budgetUsd}. Runtime UNKNOWN. Prepared tasks: ${p.preparedTasks}/${p.tasks.length}.\n\nExperiment digest: ${p.identity}\n\nPAID MODEL CALLS MADE: ${p.paidCalls}\n`;
}
import { lexicalTask } from "../router/lexicalTask.js";
export interface CalibrationModel {
  id: string;
  provider: string;
  family: string;
  inputPrice: number;
  outputPrice: number;
  context: number;
  output: number;
  parameters: string[];
  latencyMs?: number;
  available?: boolean;
  deprecated?: boolean;
  endpointMode?: string;
  outputModalities?: string[];
  created?: number;
  fetchedAt?: string;
  canonicalSlug?: string;
  codingRelevance?: boolean;
  identityKind?: string;
  purposeRestricted?: boolean;
}
export const selectCalibrationModels = (
  models: CalibrationModel[],
  max: number,
) => diverseModels(models, max).selected;
export async function discoverCalibrationModels(
  catalog?: string,
): Promise<CalibrationModel[]> {
  const data = catalog
    ? JSON.parse(await readFile(catalog, "utf8"))
    : await fetch("https://openrouter.ai/api/v1/models").then((r) => {
        if (!r.ok) throw Error("Public metadata unavailable");
        return r.json();
      });
  if (Array.isArray(data)) return data;
  return data.data.map((m: any) => ({
    id: m.id,
    provider: m.id.split("/")[0].replace(/^~/, ""),
    family: m.id.split("/")[1].split("-")[0],
    inputPrice:
      m.pricing?.request && Number(m.pricing.request) !== 0
        ? NaN
        : Math.max(
            ...[m.pricing, ...(m.pricing?.overrides ?? [])].map((p) =>
              Number(p?.prompt),
            ),
          ) * 1e6,
    outputPrice:
      Math.max(
        ...[m.pricing, ...(m.pricing?.overrides ?? [])].map((p) =>
          Number(p?.completion),
        ),
      ) * 1e6,
    context: m.context_length,
    output: m.top_provider?.max_completion_tokens ?? 0,
    parameters: m.supported_parameters ?? [],
    outputModalities: m.architecture?.output_modalities,
    created: m.created,
    fetchedAt: data.fetchedAt ?? "unknown",
    available: m.available,
    deprecated: m.deprecated,
    endpointMode: m.id.endsWith(":batch") ? "batch" : "chat",
    canonicalSlug: m.canonical_slug,
    codingRelevance: /\b(?:coding|code|programming|software|agentic)\b/i.test(
      m.description ?? "",
    ),
    identityKind:
      m.is_router === true ||
      /\b(?:composite model|model router)\b/i.test(m.description ?? "")
        ? "composite"
        : "model",
    purposeRestricted:
      /\b(?:roleplay|role-play|erotic)\b/i.test(m.description ?? "") &&
      !/\b(?:coding|programming|software|agentic)\b/i.test(m.description ?? ""),
  }));
}
export interface CalibrationOptions {
  manifest: string;
  config: string;
  output: string;
  models: string;
  maxModels: number;
  tasks: number;
  budgetUsd: number;
  perAttemptBudgetUsd: number;
  parallel: number;
  resume?: boolean;
  execute?: boolean;
  catalog?: string;
  seed?: string;
  probe?: string;
  denseCoreTasks?: number;
  sparseModelsPerTask?: number;
  anchorTasks?: number;
  engine?: "agentic";
}
export async function planCalibration(o: CalibrationOptions) {
  const all = await discoverCalibrationModels(o.catalog);
  const source = o.catalog ?? "https://openrouter.ai/api/v1/models";
  const raw = o.catalog
    ? digest(await readFile(o.catalog, "utf8"))
    : digest(all);
  return makeCalibrationPlan(o, all, source, raw);
}
export async function runNativeCalibration(
  o: CalibrationOptions,
  executeJob?: typeof runRealBenchmark,
) {
  if (o.execute && process.env.KODA_ALLOW_PAID_CALIBRATION !== "1")
    throw Error(
      "Paid execution requires --execute AND KODA_ALLOW_PAID_CALIBRATION=1",
    );
  if (o.probe)
    o = {
      ...o,
      output: join(resolve(o.output), "probes", digest(o.probe).slice(0, 16)),
    };
  const output = resolve(o.output);
  await mkdir(output, { recursive: true });
  let plan: Awaited<ReturnType<typeof planCalibration>>;
  if (o.execute && !executeJob) {
    const frozen = validateEvidence<any>(
      JSON.parse(await readFile(join(output, "experiment.json"), "utf8")),
    );
    plan = frozen.payload;
    if (plan.executionHarnessDigest !== (await calibrationHarnessDigest()))
      throw Error("Execution harness changed; explicitly create a new plan");
    if (
      o.catalog &&
      digest(await readFile(resolve(o.catalog), "utf8")) !==
        plan.rawCatalogDigest
    )
      throw Error(
        "Catalog changed since approval; explicitly create a new dry-run",
      );
    console.warn(
      "Using approved frozen prices/capabilities; runtime enforces their price ceiling. Catalog availability may have changed.",
    );
    const { identity, ...body } = plan;
    if (
      identity !== digest(body) ||
      plan.configDigest !== digest(await readFile(resolve(o.config), "utf8")) ||
      plan.manifestDigest !==
        digest(await readFile(resolve(o.manifest), "utf8")) ||
      plan.budgetUsd !== o.budgetUsd ||
      plan.perAttemptBudgetUsd !== o.perAttemptBudgetUsd
    )
      throw Error("Approved frozen experiment mismatch; create a new dry-run");
  } else plan = await planCalibration(o);
  await persistCalibrationPlan(plan);
  for (const name of ["budget-ledger.jsonl", "results.jsonl"]) {
    const f = await open(join(output, name), "a");
    await f.close();
  }
  await immutableText(
    join(output, "plan.jsonl"),
    plan.cells.map((c) => JSON.stringify(c)).join("\n") + "\n",
  );
  if (!o.execute) {
    const result = { mode: "dry-run", ...plan };
    await writeFile(
      join(output, "summary.json"),
      JSON.stringify(result, null, 2),
    );
    await writeFile(join(output, "report.md"), calibrationSummary(plan));
    return result;
  }
  if (plan.estimatedOverCapCells > 0)
    console.warn(
      `${plan.estimatedOverCapCells} cells exceed the one-call estimate cap; actual payload reservation remains authoritative.`,
    );
  if (!executeJob && plan.preparedTasks !== plan.tasks.length)
    throw Error(
      "Prepare all pinned repositories and independent acceptance oracles before paid execution",
    );
  const lockPath = join(output, ".lock");
  let lock;
  try {
    lock = await open(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !o.resume)
      throw error;
    const owner = JSON.parse(await readFile(lockPath, "utf8"));
    if (!Number.isInteger(owner.pid) || owner.identity !== plan.identity)
      throw Error("Unknown calibration lock owner");
    let alive = true;
    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
      else throw error;
    }
    if (alive) throw Error("Calibration is still running");
    await rm(lockPath);
    lock = await open(lockPath, "wx");
  }
  await lock.writeFile(
    JSON.stringify({ pid: process.pid, identity: plan.identity }),
  );
  try {
    let state: {
      identity: string;
      reserved: string[];
      completed: string[];
      statuses?: Record<string, string>;
    };
    try {
      state = JSON.parse(await readFile(join(output, "state.json"), "utf8"));
      if (!o.resume || state.identity !== plan.identity)
        throw Error("Resume requires identical frozen plan");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      state = { identity: plan.identity, reserved: [], completed: [] };
    }
    state.statuses ??= {};
    for (const id of state.reserved)
      if (!state.completed.includes(id)) state.statuses[id] = "INTERRUPTED";
    let queue = Promise.resolve();
    const save = () =>
      (queue = queue.then(async () => {
        await writeFile(join(output, "state.tmp"), JSON.stringify(state));
        await rename(join(output, "state.tmp"), join(output, "state.json"));
      }));
    const base = JSON.parse(plan.configText);
    const budgetLedger = await CalibrationBudget.load(
      join(output, "budget-ledger.jsonl"),
      plan.budgetUsd,
      plan.perAttemptBudgetUsd,
    );
    await writeFile(
      join(output, "empty-priors.json"),
      JSON.stringify({ priors: [] }),
    );
    const jobs = plan.cells.map((cell) => ({
      cell,
      task: plan.tasks.find((t) => t.id === cell.taskId)!,
      model: plan.models.find((m) => m.id === cell.modelId)!,
      id: cell.id,
    }));
    let cursor = 0;
    let halted = false;
    await Promise.all(
      Array.from({ length: o.parallel }, async () => {
        while (!halted && cursor < jobs.length) {
          const job = jobs[cursor++]!;
          if (
            state.completed.includes(job.id) ||
            state.reserved.includes(job.id)
          )
            continue;
          state.reserved.push(job.id);
          state.statuses![job.id] = "RESERVED";
          await save();
          const root = join(output, job.id);
          await mkdir(root, { recursive: true });
          const task = {
            ...job.task,
            repo: resolve(dirname(resolve(o.manifest)), job.task.repo),
            oracleDirectory: resolve(
              dirname(resolve(o.manifest)),
              job.task.oracleDirectory,
            ),
          };
          await writeFile(
            join(root, "manifest.json"),
            JSON.stringify({ version: 1, tasks: [task] }),
          );
          const cfg = {
            ...base,
            // The frozen inline pool is authoritative. A relative modelsFile
            // would resolve in the relocated cell and overwrite this pool.
            modelsFile: undefined,
            forceModel: job.model.id,
            models: Object.fromEntries(
              [
                "planner",
                "scout",
                "worker",
                "reviewer",
                "frontier",
                "strong",
                "fast",
              ].map((stage) => [stage, job.model.id]),
            ),
            semanticRouter: { ...base.semanticRouter, enabled: false },
            modelPool: {
              provider: "openrouter",
              models: [
                {
                  id: job.model.id,
                  tier: "strong",
                  enabled: true,
                  qualityPrior: 0.5,
                  fallback: {
                    inputPrice: job.model.inputPrice,
                    outputPrice: job.model.outputPrice,
                    contextLength: job.model.context,
                    maxOutputTokens: job.model.output,
                    supportedParameters: job.model.parameters,
                    available: true,
                  },
                },
              ],
            },
          };
          await writeFile(join(root, "config.json"), JSON.stringify(cfg));
          const transport = executeJob
            ? undefined
            : await calibrationTransport({
                model: job.model,
                cell: job.id,
                ledger: budgetLedger,
                upstream: backendBaseUrl(),
              });
          state.statuses![job.id] = "RUNNING";
          await save();
          let result: unknown;
          const cellStarted = Date.now();
          try {
            result = await (executeJob ?? runRealBenchmark)({
              manifest: join(root, "manifest.json"),
              config: join(root, "config.json"),
              priors: join(output, "empty-priors.json"),
              output: join(root, "report"),
              split: "development",
              selectedArms: ["calibration:" + job.model.id],
              budgetUsd: plan.perAttemptBudgetUsd,
              childEnv: transport
                ? {
                    KODA_PROVIDER_MODE: "backend",
                    KODA_API_URL: transport.url,
                    OPENROUTER_API_KEY: "",
                    KODA_MODEL_API_KEY: "",
                    KODA_CALIBRATION_ENGINE: job.cell.engine,
                    KODA_ALLOW_PAID_CALIBRATION: "1",
                  }
                : undefined,
            });
            if (!executeJob)
              result = JSON.parse(
                await readFile(join(root, "report", "state.json"), "utf8"),
              ).rows;
          } catch (error) {
            result = { error: String(error), operational: true };
          }
          const receipts = transport?.receipts ?? [];
          if (transport?.breached) halted = true;
          await transport?.close();
          const crossModel = receipts.some(
            (r) => r.servedModel && r.servedModel !== job.model.id,
          );
          const modelFailure =
            Array.isArray(result) &&
            result.some(
              (r) =>
                r.failureAttribution?.primaryCause === "MODEL_FAILURE" ||
                r.failureAttribution?.attributions?.some(
                  (a: any) =>
                    a.primaryCause === "MODEL_FAILURE" &&
                    a.learningDisposition === "NEGATIVE_MODEL_EVIDENCE",
                ),
            );
          const success =
            Array.isArray(result) &&
            result.some((r) => r.verified && r.groundTruthSolve === true);
          const cellStatus = crossModel
            ? "CENSORED"
            : success
              ? "VERIFIED_SUCCESS"
              : modelFailure
                ? "MODEL_FAILURE"
                : "INFRA_FAILURE";
          state.statuses![job.id] = cellStatus;
          await appendFile(
            join(output, "results.jsonl"),
            JSON.stringify({
              id: job.id,
              model: job.model.id,
              taskId: task.id,
              planDigest: plan.identity,
              status: cellStatus,
              receipts,
              fullTaskWallMs: Date.now() - cellStarted,
              crossModel,
              latencyMs: {
                queuePreflight: null,
                contextBuilding: null,
                timeToFirstResponse: receipts
                  .filter((r) => typeof r.responseHeadersMs === "number")
                  .map((r) => r.responseHeadersMs),
                modelWall: receipts
                  .filter((r) => typeof r.modelWallMs === "number")
                  .map((r) => r.modelWallMs),
                verification: Array.isArray(result)
                  ? result.map((r) => r.latency?.verification_ms ?? null)
                  : null,
                fullTask: Date.now() - cellStarted,
              },
              result,
            }) + "\n",
          );
          if (!executeJob && !crossModel && Array.isArray(result))
            for (const row of result) {
              const usage = row.modelUsage as
                | {
                    servedModels?: Array<{ requested: string; served: string }>;
                  }
                | undefined;
              const served = [
                ...new Set(
                  usage?.servedModels
                    ?.filter((e) => e.requested === job.model.id)
                    .map((e) => e.served) ?? [],
                ),
              ];
              const engines = [
                ...new Set(
                  (row.attempts ?? [])
                    .filter((e: any) => e.type === "real_benchmark_route")
                    .map((e: any) => e.engine)
                    .filter(Boolean),
                ),
              ];
              const observation = nativeCalibrationObservation(row, {
                task: {
                  ...canonicalRoutingTask({
                    family: task.category,
                    text: task.task,
                    semantic: lexicalTask(task.task),
                    harness: "koda",
                    engine:
                      engines.length === 1 ? String(engines[0]) : "unknown",
                  }),
                  repo: task.repo,
                  baseCommit: task.commit,
                  paths: task.writeScope,
                },
                model: job.model.id,
                servedRevision: served.length === 1 ? served[0] : undefined,
                provenance: join(root, "report", "state.json"),
                planDigest: plan.identity,
              });
              if (observation)
                new CanonicalRoutingKnowledgeStore(
                  join(output, "canonical-quality"),
                ).record(observation);
            }
          state.completed.push(job.id);
          await save();
        }
      }),
    );
    await queue;
    const result = {
      mode: "executed",
      ...plan,
      completed: state.completed.length,
      paidCalls: budgetLedger.snapshot().calls,
      budget: budgetLedger.snapshot(),
      statuses: state.statuses,
    };
    await writeFile(
      join(output, "summary.json"),
      JSON.stringify(result, null, 2),
    );
    return result;
  } finally {
    await lock.close();
    await rm(join(output, ".lock"), { force: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values: v } = parseArgs({
    options: {
      manifest: { type: "string" },
      config: { type: "string" },
      output: { type: "string" },
      models: { type: "string", default: "auto" },
      "max-models": { type: "string", default: "24" },
      tasks: { type: "string", default: "60" },
      "budget-usd": { type: "string" },
      "per-attempt-budget-usd": { type: "string" },
      parallel: { type: "string", default: "4" },
      resume: { type: "boolean" },
      execute: { type: "boolean" },
      "dry-run": { type: "boolean" },
      catalog: { type: "string" },
      probe: { type: "string" },
      "dense-core-tasks": { type: "string", default: "20" },
      "sparse-models-per-task": { type: "string", default: "8" },
      seed: { type: "string", default: "20261006" },
      "anchor-tasks": { type: "string" },
    },
  });
  if (
    !v.manifest ||
    !v.config ||
    !v.output ||
    !v["budget-usd"] ||
    !v["per-attempt-budget-usd"]
  )
    throw Error(
      "--manifest --config --output --budget-usd --per-attempt-budget-usd required",
    );
  if (v.execute && v["dry-run"]) throw Error("Choose execute or dry-run");
  const result = await runNativeCalibration({
    manifest: v.manifest,
    config: v.config,
    output: v.output,
    models: v.models!,
    maxModels: Number(v["max-models"]),
    denseCoreTasks: Number(v["dense-core-tasks"]),
    sparseModelsPerTask: Number(v["sparse-models-per-task"]),
    seed: v.seed,
    anchorTasks: v["anchor-tasks"] ? Number(v["anchor-tasks"]) : undefined,
    tasks: Number(v.tasks),
    budgetUsd: Number(v["budget-usd"]),
    perAttemptBudgetUsd: Number(v["per-attempt-budget-usd"]),
    parallel: Number(v.parallel),
    resume: v.resume,
    execute: v.execute,
    catalog: v.catalog,
    probe: v.probe,
  });
  console.log(calibrationSummary(result));
  console.log(
    JSON.stringify(
      {
        mode: result.mode,
        discovered: result.discovered,
        eligible: result.eligible,
        models: result.models.map((m) => m.id),
        providers: result.providers,
        families: result.families,
        selectedTasks: result.tasks.map((t) => t.id),
        estimatedOverCapCells: result.estimatedOverCapCells,
        artifacts: result.output,
      },
      null,
      2,
    ),
  );
}

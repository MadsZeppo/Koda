import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Config } from "./config.js";
import { run } from "./run.js";
import {
  changesBetween,
  copySnapshot,
  snapshotTree,
} from "./workspace/files.js";

export interface CalibrationOptions {
  repo: string;
  task: string;
  models: string[];
  config: Config;
  output?: string;
  taskId?: string;
}

export async function calibrateModels(options: CalibrationOptions) {
  const repo = await realpath(resolve(options.repo));
  const models = options.models.map((model) => model.trim());
  if (!options.task.trim() || !models.length || models.some((model) => !model))
    throw Error("Calibration requires a task and at least one model");
  if (new Set(models).size !== models.length)
    throw Error("Calibration models must be unique");
  if (
    !options.config.modelPool ||
    models.some(
      (model) =>
        !options.config.modelPool!.models.some(
          (candidate) => candidate.id === model,
        ),
    )
  )
    throw Error("Every calibration model must be in the configured model pool");

  const taskId =
    options.taskId ??
    createHash("sha256").update(options.task).digest("hex").slice(0, 12);
  const output = resolve(
    options.output ??
      join(
        homedir(),
        ".koda",
        "calibrations",
        `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 6)}`,
      ),
  );
  if (output === repo || output.startsWith(repo + "/"))
    throw Error("Calibration output must be outside the original repository");
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  const staging = await mkdtemp(join(tmpdir(), "koda-calibration-"));
  const frozen = join(staging, "baseline");
  const rows: Record<string, unknown>[] = [];
  try {
    const baseline = await copySnapshot(repo, frozen);
    const baselineHash = createHash("sha256")
      .update(JSON.stringify(baseline.files))
      .digest("hex");
    for (const [index, model] of models.entries()) {
      if (changesBetween(baseline, await snapshotTree(frozen)).length)
        throw Error("Frozen calibration baseline changed");
      const report = join(output, "runs", String(index));
      const result = await run({
        repo: frozen,
        dependencyRoot: repo,
        task: options.task,
        config: {
          ...options.config,
          forceModel: model,
          race: false,
          routing: {
            ...options.config.routing,
            stateDirectory: join(output, "routing-state", String(index)),
          },
        },
        output: report,
        quiet: true,
        apply: false,
      });
      if (changesBetween(baseline, await snapshotTree(frozen)).length)
        throw Error("Calibration run mutated the frozen baseline");
      const events = (await readFile(join(report, "events.jsonl"), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const servedModels = result.modelCalls.map((call) => call.modelServed);
      const modelMismatch = result.modelCalls.some(
        (call) => call.modelRequested !== model || call.modelServed !== model,
      );
      const firstFailedCheck = result.verification.checks.find(
        (check) => check.outcome !== "CHECK_PASS",
      );
      const status = modelMismatch ? "FAILED" : result.status;
      rows.push({
        taskId,
        taskFeatureBucket:
          events.findLast(
            (event) =>
              event.type === "model_router" &&
              event.task_bucket !== "read_only_discovery",
          )?.task_bucket ?? null,
        executionStrategy: result.execution_strategy,
        forcedModel: model,
        servedModels,
        baselineHash,
        status,
        finalVerificationStatus: result.finalVerificationStatus,
        verified:
          status === "VERIFIED_SUCCESS" &&
          result.finalVerificationStatus === "VERIFIED_SUCCESS",
        wallClockMs: result.wallClockMs,
        inputTokens: result.modelCalls.reduce(
          (sum, call) => sum + call.inputTokens,
          0,
        ),
        outputTokens: result.modelCalls.reduce(
          (sum, call) => sum + call.outputTokens,
          0,
        ),
        totalTokens: result.totalTokens,
        costUsd: result.costComplete ? result.costUsd : null,
        knownCostUsd: result.costUsd,
        costComplete: result.costComplete,
        modelCalls: result.totalModelCalls,
        fallbacks: result.fallbacks,
        escalations: result.escalations,
        verificationCalls: events.filter((event) =>
          [
            "verification",
            "final_verification",
            "stable_repair_verification",
          ].includes(event.type),
        ).length,
        failureClass: modelMismatch
          ? "MODEL_MISMATCH"
          : (firstFailedCheck?.outcome ??
            (status === "VERIFIED_SUCCESS" ? null : "RUN_ERROR")),
        failureReason: modelMismatch
          ? `Requested ${model}; served ${servedModels.join(", ")}`
          : (result.error ??
            firstFailedCheck?.stderr ??
            firstFailedCheck?.stdout ??
            null),
        report,
      });
      await writeFile(
        join(output, "comparison.json"),
        JSON.stringify(
          {
            taskId,
            task: options.task,
            baselineHash,
            mode: "strict",
            results: rows,
          },
          null,
          2,
        ),
      );
    }
    if (changesBetween(baseline, await snapshotTree(repo)).length)
      throw Error("Original repository changed during calibration");
    const table = [
      "model | verified | cost USD | tokens | wall clock | model calls | fallbacks",
      "--- | --- | ---: | ---: | ---: | ---: | ---:",
      ...rows.map((row) =>
        [
          row.forcedModel,
          row.verified,
          row.costUsd === null ? "unknown" : Number(row.costUsd).toFixed(6),
          row.totalTokens,
          `${(Number(row.wallClockMs) / 1000).toFixed(2)}s`,
          row.modelCalls,
          row.fallbacks,
        ].join(" | "),
      ),
    ].join("\n");
    await writeFile(join(output, "comparison.md"), table + "\n");
    return { output, taskId, baselineHash, results: rows, table };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

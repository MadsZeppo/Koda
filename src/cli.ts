#!/usr/bin/env node
import { Command } from "commander";
import { resolve, join } from "node:path";
import { config } from "./config.js";
import { run } from "./run.js";
import { benchmark } from "./benchmark.js";
import { calibrateModels } from "./calibration.js";
import { applyWorkspaceRun, revertWorkspaceRun } from "./workspace/backend.js";
import { syncRoutingEvidence } from "./router/knowledge/sync.js";
import { routerStateDirectory } from "./router/modelRouter.js";
import { PoolRouter } from "./router/modelRouter.js";
import { Logger } from "./telemetry/logger.js";
import { currentIdentityCatalog, currentPricingFromState, evidenceInputPaths, prepareCodeRouterBench,
  prepareSWERebench } from "./router/knowledge/bootstrap.js";
import { routingEvidenceReport } from "./router/knowledge/report.js";
const cli = new Command()
  .name("agent")
  .description("Parallel, evidence-driven local coding agent");
cli.command("routing-prepare-coderouterbench")
  .option("--config <path>")
  .option("--output <path>")
  .action(async (o) => {
    const c = await config(o.config), directory = routerStateDirectory(c);
    const output = resolve(o.output ?? evidenceInputPaths(directory).codeRouterBench);
    console.log(JSON.stringify(await prepareCodeRouterBench(output), null, 2));
  });
cli.command("routing-prepare-swe-rebench")
  .option("--config <path>")
  .option("--output <path>")
  .action(async (o) => {
    const c = await config(o.config), directory = routerStateDirectory(c);
    const output = resolve(o.output ?? evidenceInputPaths(directory).sweRebench);
    console.log(JSON.stringify(await prepareSWERebench(output), null, 2));
  });
cli.command("routing-refresh-catalog")
  .option("--config <path>")
  .action(async (o) => {
    const c = await config(o.config), directory = routerStateDirectory(c);
    const router = new PoolRouter(c, new Logger(join(directory, "catalog-refresh"),
      `catalog-refresh-${Date.now()}`, true));
    const catalog = await router.catalog.refresh();
    const specialists = await router.capabilities.refresh();
    console.log(JSON.stringify({ directory, catalogModels: catalog.size,
      specialistModels: specialists.length, refreshedAt: new Date().toISOString() }, null, 2));
  });
cli.command("routing-build-knowledge")
  .option("--config <path>")
  .option("--output <path>")
  .action(async (o) => {
    const c = await config(o.config), directory = routerStateDirectory(c);
    const inputs = evidenceInputPaths(directory);
    const output = resolve(o.output ?? join(directory, "routing-knowledge-v2.json"));
    const snapshot = await syncRoutingEvidence([inputs.codeRouterBench, inputs.sweRebench],
      output, fetch, new Date().toISOString(), await currentPricingFromState(directory),
      await currentIdentityCatalog(directory));
    console.log(JSON.stringify({ output, snapshotId: snapshot.snapshotId,
      observations: snapshot.observations.length,
      pairwiseEvidence: snapshot.pairwiseEvidence?.length ?? 0,
      sources: snapshot.sources }, null, 2));
  });
cli.command("routing-evidence-report")
  .option("--config <path>")
  .action(async (o) => {
    const c = await config(o.config);
    console.log(JSON.stringify(await routingEvidenceReport(routerStateDirectory(c)), null, 2));
  });
cli
  .command("routing-sync-evidence")
  .requiredOption("--source <locations...>", "local JSON or HTTP evidence source documents")
  .option("--config <path>")
  .option("--output <path>")
  .action(async (o) => {
    const c = await config(o.config);
    const output = resolve(o.output ?? join(routerStateDirectory(c), "routing-knowledge-v2.json"));
    const snapshot = await syncRoutingEvidence(o.source, output);
    console.log(JSON.stringify({ output, snapshotId: snapshot.snapshotId,
      observations: snapshot.observations.length,
      pairwiseEvidence: snapshot.pairwiseEvidence?.length ?? 0,
      sources: snapshot.sources }, null, 2));
  });
cli
  .command("run")
  .requiredOption("--repo <path>")
  .requiredOption("--task <task>")
  .option("--max-parallel <n>", "concurrent workers", Number)
  .option("--budget-usd <usd>", "maximum inference budget", Number)
  .option("--max-tokens <n>", "total model tokens", Number)
  .option("--max-minutes <n>", "run time budget", Number)
  .option("--max-iterations <n>", "iterations per worker", Number)
  .option("--race", "explicitly race two eligible models on difficult tasks")
  .option("--config <path>")
  .option("--output <path>")
  .option("--apply", "apply verified changes back to the original workspace")
  .option("--models-file <path>", "model pool JSON")
  .option("--routing <mode>", "routing mode (auto)", "auto")
  .option(
    "--force-model <id>",
    "evaluate a configured candidate without switching models",
  )
  .action(async (o) => {
    if (!process.env.OPENROUTER_API_KEY) throw Error("Set OPENROUTER_API_KEY");
    if (o.routing !== "auto")
      throw Error(
        "Only --routing auto is supported; use --force-model for evaluation",
      );
    const c = await config(o.config, {
      modelsFile: o.modelsFile ? resolve(o.modelsFile) : undefined,
      forceModel: o.forceModel,
      maxParallel: o.maxParallel,
      budgetUsd: o.budgetUsd,
      maxTokens: o.maxTokens,
      maxMinutes: o.maxMinutes,
      maxIterations: o.maxIterations,
      race: o.race,
    });
    const result = await run({
      repo: o.repo,
      task: o.task,
      config: c,
      output: o.output,
      apply: o.apply,
    });
    if (
      result.status !== "VERIFIED_SUCCESS" ||
      (o.apply && result.applyResult !== "applied")
    )
      process.exitCode = 1;
  });
cli
  .command("apply")
  .requiredOption("--run <path>", "verified preview run output directory")
  .action(async (o) => {
    const result = await applyWorkspaceRun(resolve(o.run));
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "APPLIED") process.exitCode = 1;
  });
cli
  .command("revert")
  .requiredOption("--run <path>", "completed run output directory")
  .action(async (o) => {
    const result = await revertWorkspaceRun(resolve(o.run));
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "REVERTED") process.exitCode = 1;
  });
cli
  .command("calibrate-model")
  .requiredOption("--repo <path>")
  .requiredOption("--task <task>")
  .requiredOption("--models <ids>", "comma-separated configured model IDs")
  .option("--config <path>")
  .option("--models-file <path>")
  .option("--output <path>")
  .action(async (o) => {
    if (!process.env.OPENROUTER_API_KEY) throw Error("Set OPENROUTER_API_KEY");
    const result = await calibrateModels({
      repo: o.repo,
      task: o.task,
      models: o.models.split(","),
      config: await config(o.config, {
        modelsFile: o.modelsFile ? resolve(o.modelsFile) : undefined,
      }),
      output: o.output,
    });
    console.log(result.table);
    console.log(`Results: ${result.output}/comparison.json`);
    if (result.results.some((row) => !row.verified)) process.exitCode = 1;
  });
cli
  .command("benchmark")
  .requiredOption("--manifest <path>")
  .option("--config <path>")
  .option("--output <path>", "results directory", ".koda/benchmarks")
  .action(async (o) => {
    if (!process.env.OPENROUTER_API_KEY) throw Error("Set OPENROUTER_API_KEY");
    const results = await benchmark(
      resolve(o.manifest),
      await config(o.config),
      resolve(o.output),
    );
    if (results.some((r) => r.status !== "VERIFIED_SUCCESS"))
      process.exitCode = 1;
  });
cli.parseAsync().catch((e) => {
  console.error(String(e));
  process.exitCode = 1;
});

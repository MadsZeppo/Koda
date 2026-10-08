import { Command } from "commander";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { config } from "../config.js";
import {
  evaluateRoutingV1,
  routingDatasetSchema,
} from "../router/routingV1Evaluation.js";
import { collectRoutingBenchmarks } from "./routingV1Collect.js";
const options = new Command()
  .option(
    "--dataset <path>",
    "Versioned outcome matrix",
    "benchmarks/routing-v1/development.json",
  )
  .option("--output <path>", "Report", "/tmp/koda-routing-v1.json")
  .option("--split <split>", "development or holdout")
  .option("--learned", "Use separately recorded local evidence")
  .option("--families <list>", "Canonical routing families")
  .option("--collect", "Explicit paid benchmark collection")
  .option("--config <path>", "Existing Koda config")
  .option("--models <list>", "Explicit configured models")
  .option("--tasks <list>", "Explicit benchmark tasks")
  .option("--budget-usd <amount>", "Aggregate collection cap")
  .parse()
  .opts();
if (options.collect) {
  if (!options.models || !options.tasks || !options["budgetUsd"])
    throw Error("Collection requires --models, --tasks and --budget-usd");
  await collectRoutingBenchmarks({
    config: await config(options.config),
    models: options.models.split(","),
    tasks: options.tasks.split(","),
    budgetUsd: Number(options.budgetUsd),
    output: resolve(options.output),
  });
} else {
  if (options.split && !["development", "holdout"].includes(options.split))
    throw Error("Invalid split");
  const data = routingDatasetSchema.parse(
    JSON.parse(await readFile(options.dataset, "utf8")),
  );
  const report = evaluateRoutingV1(data, await config(options.config), {
    split: options.split,
    learned: options.learned,
    families: options.families?.split(","),
  });
  await mkdir(dirname(resolve(options.output)), { recursive: true });
  await writeFile(options.output, JSON.stringify(report, null, 2));
  const { rows, ...metrics } = report;
  console.log(JSON.stringify(metrics, null, 2));
  console.log(`Report: ${resolve(options.output)}`);
}

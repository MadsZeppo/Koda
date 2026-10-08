import { Command } from "commander";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  evaluateFailureAttributions,
  readFailureDataset,
} from "../agent/failureAttributionEvaluation.js";
const options = new Command()
  .option(
    "--dataset <path>",
    "Structured attempt trace JSON/JSONL",
    "benchmarks/failure-attribution/development.jsonl",
  )
  .option("--output <path>", "JSON report", "/tmp/koda-failure-dev.json")
  .parse()
  .opts();
const report = evaluateFailureAttributions(
  await readFailureDataset(options.dataset),
);
await mkdir(dirname(resolve(options.output)), { recursive: true });
await writeFile(options.output, JSON.stringify(report, null, 2));
const { results, ...metrics } = report;
console.log(JSON.stringify(metrics, null, 2));
console.log(`Report: ${resolve(options.output)}`);

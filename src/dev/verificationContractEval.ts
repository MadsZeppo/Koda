import { Command } from "commander";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readContractDataset,
  evaluateVerificationContracts,
} from "../verifier/contractEvaluation.js";
export async function main() {
  const options = new Command()
    .option(
      "--dataset <path>",
      "JSON/JSONL dataset containing independent proof and candidates",
      fileURLToPath(
        new URL(
          "../../benchmarks/verification-contract/development.jsonl",
          import.meta.url,
        ),
      ),
    )
    .option(
      "--output <path>",
      "JSON report",
      "/tmp/koda-verification-contract.json",
    )
    .parse()
    .opts();
  const report = await evaluateVerificationContracts(
    await readContractDataset(options.dataset),
  );
  await mkdir(dirname(resolve(options.output)), { recursive: true });
  await writeFile(options.output, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        caseCount: report.caseCount,
        planningQuality: report.planningQuality,
        discrimination: report.discrimination,
        byStrength: report.byStrength,
        planningOverheadMs: report.planningOverheadMs,
      },
      null,
      2,
    ),
  );
  console.log(`Report: ${resolve(options.output)}`);
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();

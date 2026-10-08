import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import {
  assessmentCaseSchema,
  assessmentReport,
  evaluateCases,
  type AssessmentCase,
} from "../router/taskAssessmentEvaluation.js";
import { assessTask } from "../router/taskAssessment.js";
import { interpretTask } from "../router/taskInterpreter.js";
import { profileTask } from "../router/taskProfiler.js";
import { chooseExecutionStrategy } from "../router/executionStrategy.js";
import { compileTaskSpec } from "../planner/taskSpec.js";
import { MAX_TASK_SPEC_BYTES } from "../context/packetPolicy.js";
import { config } from "../config.js";
import { Gateway } from "../openrouter/client.js";
import { Budget } from "../openrouter/usage.js";
import { Logger } from "../telemetry/logger.js";
import type { RepoProfile } from "../types.js";
export async function readAssessmentDataset(path: string) {
  const text = await readFile(path, "utf8");
  const values = text.trimStart().startsWith("[")
    ? JSON.parse(text)
    : text
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));
  if (!Array.isArray(values) || !values.length)
    throw Error("Assessment dataset must contain at least one case");
  return values.map((value) => assessmentCaseSchema.parse(value));
}
export function syntheticAssessmentRepo(item: AssessmentCase): RepoProfile {
  return {
    root: ".",
    commit: "",
    status: "",
    diff: "",
    files: item.facts.files,
    topLevel: [],
    extensions: {},
    symbols: [],
    packageManager: "unknown",
    scripts: {},
    configs: {},
    verificationCommands: item.facts.checks.map((check) => check.command),
  };
}
async function main() {
  const options = new Command()
    .option(
      "--dataset <path>",
      "development, holdout, or unseen JSON/JSONL file",
      fileURLToPath(
        new URL(
          "../../benchmarks/task-assessment/development.jsonl",
          import.meta.url,
        ),
      ),
    )
    .option("--outcomes <path>", "real model outcomes JSON or JSONL")
    .option(
      "--output <path>",
      "machine-readable report",
      "/tmp/koda-task-assessment.json",
    )
    .option(
      "--semantic",
      "explicitly exercise the existing semantic provider; may incur charges",
    )
    .option(
      "--config <path>",
      "existing Koda config; semanticRouter.enabled must be true",
    )
    .option("--budget-usd <value>", "semantic evaluation budget", Number, 0.1)
    .parse()
    .opts();
  const cases = await readAssessmentDataset(options.dataset);
  let semantic;
  if (options.semantic) {
    const settings = await config(options.config);
    if (!settings.semanticRouter.enabled)
      throw Error(
        "Semantic evaluation requires semanticRouter.enabled=true in the existing config",
      );
    if (!Number.isFinite(options.budgetUsd) || options.budgetUsd <= 0)
      throw Error("Invalid semantic evaluation budget");
    const gateway = new Gateway(
      settings,
      new Logger(
        resolve(`${options.output}.events`),
        "task-assessment-eval",
        true,
      ),
      new Budget(options.budgetUsd, 100000, 300000),
    );
    semantic = async (item: AssessmentCase) => {
      if (Buffer.byteLength(item.task) > MAX_TASK_SPEC_BYTES)
        throw Error(
          "Semantic evaluation task exceeds bound; original task is not silently truncated",
        );
      const assessment = assessTask({ task: item.task, facts: item.facts });
      const repo = syntheticAssessmentRepo(item);
      const profile = profileTask(
        item.task,
        repo,
        chooseExecutionStrategy(item.task, repo),
      );
      profile.likelyPaths = item.facts.resolvedPaths.slice(0, 12);
      profile.likelyTests = item.facts.relatedTests.slice(0, 12);
      profile.scopeConfidence = item.facts.localizationConfidence;
      profile.likelyComponents = item.facts.components.slice(0, 12);
      profile.securitySensitive = assessment.riskFlags.security;
      profile.concurrencyRisk = assessment.riskFlags.concurrency;
      profile.schemaRisk = assessment.riskFlags.database;
      profile.publicApiRisk = assessment.riskFlags.publicApi;
      profile.architectureRisk = assessment.riskFlags.architecture;
      profile.verificationStrength = assessment.verificationStrength;
      const spec = compileTaskSpec(item.task);
      return interpretTask(
        gateway,
        item.task,
        repo,
        profile,
        {
          status: "NOT_FULLY_VERIFIED",
          checks: [],
          failedChecks: 0,
          failingTests: null,
          buildErrors: null,
        },
        {
          taskSpec: {
            goal: spec.goal,
            requirements: spec.requirements,
            constraints: spec.constraints,
            acceptanceCriteria: spec.acceptanceCriteria,
            exactLiterals: spec.exactLiterals,
            explicitPaths: spec.explicitPaths,
          },
          localizationEvidence: assessment.evidence
            .filter((e) => e.source === "localization")
            .map((e) => e.description.slice(0, 500)),
          deterministicRiskEvidence: assessment.evidence
            .filter((e) => e.dimension.startsWith("riskFlags."))
            .map((e) => e.description.slice(0, 500)),
        },
      );
    };
  }
  const predictions = await evaluateCases(cases, semantic);
  const outcomes = options.outcomes
    ? (await readFile(options.outcomes, "utf8")).trim()
    : "";
  const report = assessmentReport(
    predictions,
    outcomes
      ? outcomes.startsWith("[")
        ? JSON.parse(outcomes)
        : outcomes
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => JSON.parse(line))
      : [],
  );
  await mkdir(dirname(resolve(options.output)), { recursive: true });
  await writeFile(options.output, JSON.stringify(report, null, 2));
  console.log(
    `Task Assessment V1: ${report.caseCount} cases; ${options.semantic ? "semantic requested" : "deterministic only"}; uncertain=${report.uncertainCases.length}`,
  );
  for (const [name, metric] of Object.entries(report.fields))
    console.log(
      `${name}: accuracy=${metric.accuracy?.toFixed(3)} macroF1=${metric.macroF1?.toFixed(3)}${"falseNegativeCount" in metric ? ` precision=${metric.precision?.toFixed(3) ?? "undefined"} recall=${metric.recall?.toFixed(3) ?? "undefined"} FP=${metric.falsePositiveCount} FN=${metric.falseNegativeCount}` : ""}${"meanAbsoluteOrdinalError" in metric ? ` within-one=${metric.withinOneCategoryAccuracy?.toFixed(3)} MAE=${metric.meanAbsoluteOrdinalError?.toFixed(3)}` : ""}`,
    );
  for (const [stratum, fields] of Object.entries(report.byStratum))
    console.log(
      `${stratum}: n=${fields.implementationComplexity?.count} implementation=${fields.implementationComplexity?.accuracy?.toFixed(3)} verification=${fields.verificationStrength?.accuracy?.toFixed(3)}`,
    );
  for (const item of report.uncertainCases)
    console.log(
      `UNCERTAIN ${item.id}: overall=${item.confidence.overall.toFixed(2)} semanticRecommended=${item.semanticRecommended}`,
    );
  console.log(
    `Semantic failures=${report.semanticFailures.length}; report: ${resolve(options.output)}`,
  );
  // Classification disagreements are measurements, not a hidden pass/fail threshold.
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();

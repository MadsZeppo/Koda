import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import type { Config } from "../config.js";
import { codingScenarios, scenarioFixture } from "./codingSuiteFixtures.js";
import { hardCodingScenarios } from "./hardCodingSuiteFixtures.js";
import { expertCodingScenarios } from "./expertCodingSuiteFixtures.js";
import { stressCodingScenarios } from "./stressCodingSuiteFixtures.js";
export async function collectRoutingBenchmarks(options: {
  config: Config;
  models: string[];
  tasks: string[];
  budgetUsd: number;
  output: string;
}) {
  if (
    !Number.isFinite(options.budgetUsd) ||
    options.budgetUsd <= 0 ||
    options.models.length * options.tasks.length > 100 ||
    !options.models.length ||
    !options.tasks.length
  )
    throw Error("Explicit positive budget and 1–100 model/task pairs required");
  if (
    new Set(options.models).size !== options.models.length ||
    new Set(options.tasks).size !== options.tasks.length
  )
    throw Error("Duplicate selection");
  for (const model of options.models)
    if (
      !options.config.modelPool?.models.some((m) => m.id === model && m.enabled)
    )
      throw Error(`Model not configured: ${model}`);
  const scenarios = [
    ...codingScenarios,
    ...hardCodingScenarios,
    ...expertCodingScenarios,
    ...stressCodingScenarios,
  ];
  for (const task of options.tasks)
    if (!scenarios.some((s) => s.id === task))
      throw Error(`Unknown task ${task}`);
  await mkdir(options.output, { recursive: false });
  const allocation =
      options.budgetUsd / (options.models.length * options.tasks.length),
    records: any[] = [];
  for (const taskId of options.tasks)
    for (const model of options.models) {
      const root = join(options.output, `${records.length}`),
        repo = join(root, "repo"),
        report = join(root, "report");
      await mkdir(repo, { recursive: true });
      const fixture = scenarioFixture(scenarios.find((s) => s.id === taskId)!);
      for (const [path, content] of Object.entries(fixture.files)) {
        await mkdir(dirname(join(repo, path)), { recursive: true });
        await writeFile(join(repo, path), content);
      }
      const configuration = join(root, "config.json");
      await writeFile(
        configuration,
        JSON.stringify({
          ...options.config,
          forceModel: model,
          budgetUsd: allocation,
          maxParallel: 1,
          routing: {
            ...options.config.routing,
            stateDirectory: join(root, "routing"),
          },
        }),
      );
      let child: { all?: string; exitCode?: number } = {};
      let processError: string | undefined;
      try {
        child = await execa(
          process.execPath,
          [
            fileURLToPath(new URL("../../bin/koda.mjs", import.meta.url)),
            "run",
            "--config",
            configuration,
            "--repo",
            repo,
            "--task",
            fixture.task,
            "--output",
            report,
            "--apply",
          ],
          {
            reject: false,
            all: true,
            timeout: Math.ceil(options.config.maxMinutes * 60_000) + 30_000,
            env: { OPENROUTER_API_KEY: "" },
          },
        );
      } catch (error) {
        processError = String(error);
      }
      await writeFile(join(root, "cli.log"), child.all ?? "");
      let summary: any = null;
      try {
        summary = JSON.parse(
          await readFile(join(report, "summary.json"), "utf8"),
        );
      } catch {}
      const acceptance = await execa(
        process.execPath,
        ["-e", fixture.acceptance, join(repo, fixture.source)],
        { reject: false, timeout: 10_000 },
      );
      let events: any[] = [];
      let attempts: any[] = [];
      try {
        events = (await readFile(join(report, "events.jsonl"), "utf8"))
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      } catch {}
      try {
        attempts = (
          await readFile(join(root, "routing", "attempts.jsonl"), "utf8")
        )
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .filter(
            (row) => row.features && row.features.taskKind !== "planning",
          );
      } catch {}
      const record = {
        taskId,
        model,
        processError,
        taskAssessment: summary?.taskAssessment ?? null,
        verificationContract: summary?.verificationContract ?? null,
        taskFeatures: attempts[0]
          ? {
              features: attempts[0].features,
              fingerprint: attempts[0].fingerprint,
            }
          : null,
        attempts,
        providerCalls: events.filter((event) => event.type === "model_call"),
        latencyBreakdown: summary?.latencyBreakdown ?? null,
        attempt: records.length + 1,
        provenance: report,
        status: summary?.status ?? "HARNESS_FAILURE",
        verified:
          summary?.status === "VERIFIED_SUCCESS" &&
          summary?.candidateProduced &&
          summary?.applyResult === "applied" &&
          child.exitCode === 0,
        groundTruthPass: acceptance.exitCode === 0,
        failureAttribution: summary?.failureAttribution ?? null,
        verification: summary?.verification ?? null,
        costUsd: summary?.costUsd ?? null,
        costComplete: summary?.costComplete ?? false,
        tokens: summary?.totalTokens ?? null,
        wallClockMs: summary?.wallClockMs ?? null,
        chargedReservationUsd: allocation,
      };
      records.push(record);
      await writeFile(
        join(options.output, "collection.json"),
        JSON.stringify(
          { version: 1, budgetUsd: options.budgetUsd, allocation, records },
          null,
          2,
        ),
      );
      // Each invocation is independently capped. Unknown usage consumes its entire
      // allocation; never recycle missing/partial accounting into more calls.
      if (summary?.costComplete && summary.costUsd > allocation)
        throw Error("Attempt exceeded allocation; collection stopped");
    }
  return records;
}

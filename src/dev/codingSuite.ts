import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { execa } from "execa";
import {
  codingScenarios,
  scenarioFixture,
  type CodingScenario,
} from "./codingSuiteFixtures.js";
import { expertCodingScenarios } from "./expertCodingSuiteFixtures.js";
import { stressCodingScenarios } from "./stressCodingSuiteFixtures.js";
import { hardCodingScenarios } from "./hardCodingSuiteFixtures.js";

export interface SuiteOptions {
  mode: "fake" | "live";
  output: string;
  concurrency: number;
  budgetUsd?: number;
  /** Optional isolated benchmark configuration; normal suites keep their defaults. */
  config?: Record<string, any>;
  names?: string[];
  timeoutMs?: number;
  suite?: "basic" | "hard" | "expert" | "stress";
}
export async function boundedMap<T, R>(
  items: T[],
  concurrency: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 30)
    throw Error("parallel must be an integer between 1 and 30");
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await work(items[index]!, index);
      }
    }),
  );
  return results;
}
async function repoFiles(root: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, prefix), {
    withFileTypes: true,
  })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await repoFiles(root, path)));
    else files.push(path);
  }
  return files.sort();
}
export async function runCodingSuite(options: SuiteOptions) {
  const available = options.suite === "stress" ? stressCodingScenarios : options.suite === "expert" ? expertCodingScenarios : options.suite === "hard" ? hardCodingScenarios : codingScenarios;
  const scenarios = options.names?.length
    ? options.names.map((id) => {
        const found = available.find((s) => s.id === id);
        if (!found) throw Error(`Unknown scenario ${id}`);
        return found;
      })
    : available;
  if (new Set(scenarios.map((s) => s.id)).size !== scenarios.length)
    throw Error("Duplicate scenario selection");
  if (
    options.mode === "live" &&
    (!Number.isFinite(options.budgetUsd) || options.budgetUsd! <= 0)
  )
    throw Error("live requires a positive --budget-usd");
  const root = resolve(options.output);
  // Fail if a previous suite exists: never overwrite a report or fixture.
  await mkdir(root, { recursive: false });
  const started = Date.now();
  const results = await boundedMap(
    scenarios,
    options.concurrency,
    async (s: CodingScenario) => {
      const fixture = scenarioFixture(s),
        parent = join(root, s.id),
        repo = join(parent, "repo"),
        report = join(parent, "report");
      await mkdir(repo, { recursive: true });
      for (const [path, content] of Object.entries(fixture.files)) {
        await mkdir(dirname(join(repo, path)), { recursive: true });
        await writeFile(join(repo, path), content);
      }
      const script = join(parent, "script.json");
      await writeFile(script, JSON.stringify(fixture.script));
      const config = join(parent, "config.json");
      await writeFile(
        config,
        JSON.stringify({
          ...options.config,
          routing: { ...options.config?.routing, stateDirectory: join(parent, "routing") },
        }),
      );
      const cli = fileURLToPath(new URL("../../bin/koda.mjs", import.meta.url));
      const args =
        options.mode === "fake"
          ? ["dev-run", "--script", script]
          : [
              "run",
              "--config",
              config,
              "--budget-usd",
              String(options.budgetUsd! / scenarios.length),
              "--max-parallel",
              "1",
              "--max-minutes",
              "3",
            ];
      const taskStarted = Date.now();
      let summary: any,
        passed = false,
        error: string | undefined,
        exitCode: number | undefined;
      try {
        const child = await execa(
          process.execPath,
          [
            cli,
            ...args,
            "--repo",
            repo,
            "--task",
            fixture.task,
            "--output",
            report,
            "--apply",
          ],
          {
            env: {
              NODE_ENV: options.mode === "fake" ? "test" : process.env.NODE_ENV,
              KODA_PROVIDER_MODE:
                options.mode === "live"
                  ? "backend"
                  : process.env.KODA_PROVIDER_MODE,
              OPENROUTER_API_KEY: "",
            },
            reject: false,
            timeout: options.timeoutMs ?? 240_000,
            all: true,
          },
        );
        exitCode = child.exitCode;
        await writeFile(join(parent, "cli.log"), child.all ?? "");
        summary = JSON.parse(
          await readFile(join(report, "summary.json"), "utf8"),
        );
        if (
          exitCode !== 0 ||
          summary.status !== "VERIFIED_SUCCESS" ||
          summary.applyResult !== "applied"
        )
          throw Error(
            `CLI=${exitCode}, status=${summary.status}, apply=${summary.applyResult}`,
          );
        if (!summary.candidateProduced) throw Error("No candidate mutation");
        const acceptance = await execa(
          process.execPath,
          ["-e", fixture.acceptance, join(repo, fixture.source)],
          { reject: false, timeout: 10_000 },
        );
        if (acceptance.exitCode !== 0)
          throw Error(`Independent acceptance failed: ${acceptance.stderr}`);
        if (
          s.addTests &&
          (await readFile(join(repo, fixture.testPath), "utf8")) ===
            fixture.files[fixture.testPath]
        )
          throw Error("Requested test file was not changed");
        const allowed = new Set([
          fixture.source,
          ...(s.addTests ? [fixture.testPath] : []),
        ]);
        for (const path of await repoFiles(repo)) {
          if (allowed.has(path)) continue;
          if (
            !(path in fixture.files) ||
            (await readFile(join(repo, path), "utf8")) !== fixture.files[path]
          )
            throw Error(`Unexpected mutation: ${path}`);
        }
        for (const path of Object.keys(fixture.files))
          if (!allowed.has(path)) await readFile(join(repo, path));
        const events = (await readFile(join(report, "events.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        if (
          !events.some(
            (e) =>
              e.type === "final_verification" &&
              e.kind === "test" &&
              e.outcome === "CHECK_PASS",
          )
        )
          throw Error("No passing final test verification");
        if (options.mode === "fake") {
          const transcript = JSON.parse(
            await readFile(join(report, "fake-provider.json"), "utf8"),
          );
          if (transcript.externalCalls !== 0 || !summary.synthetic)
            throw Error("Fake provider isolation failed");
        }
        passed = true;
      } catch (failure) {
        error = String(failure);
        if (failure && typeof failure === "object" && "all" in failure)
          await writeFile(join(parent, "cli.log"), String(failure.all ?? ""));
      }
      const result = {
        id: s.id,
        passed,
        status: summary?.status ?? "HARNESS_FAILURE",
        apply: summary?.applyResult,
        exitCode,
        error,
        wallClockMs: Date.now() - taskStarted,
        costUsd: summary?.costUsd ?? null,
        costComplete: summary?.costComplete ?? false,
        report,
      };
      await writeFile(
        join(parent, "result.json"),
        JSON.stringify(result, null, 2),
      );
      console.log(
        `${passed ? "PASS" : "FAIL"} ${s.id}: ${result.status}${error ? ` — ${error}` : ""}`,
      );
      return result;
    },
  );
  const summary = {
    mode: options.mode,
    suite: options.suite ?? "basic",
    scenarioCount: results.length,
    parallel: options.concurrency,
    budgetUsd: options.budgetUsd ?? 0,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    wallClockMs: Date.now() - started,
    costUsd: results.reduce((n, r) => n + (r.costUsd ?? 0), 0),
    costComplete: results.every((r) => r.costComplete),
    results,
  };
  await writeFile(
    join(root, "suite-summary.json"),
    JSON.stringify(summary, null, 2),
  );
  console.log(
    `\n${summary.passed}/${results.length} passed; report: ${join(root, "suite-summary.json")}`,
  );
  return summary;
}
export async function suiteMain(mode: "fake" | "live") {
  const { values } = parseArgs({
    options: {
      output: { type: "string" },
      parallel: { type: "string", default: "4" },
      "budget-usd": { type: "string" },
      only: { type: "string" },
      suite: { type: "string", default: "basic" },
    },
  });
  if (mode === "live" && !process.env.KODA_API_URL)
    throw Error("Set KODA_API_URL to your running backend");
  if (values.suite !== "basic" && values.suite !== "hard" && values.suite !== "expert" && values.suite !== "stress")
    throw Error("suite must be basic, hard, expert or stress");
  const output = values.output ?? resolve(`koda-${mode}-suite-${Date.now()}`);
  const result = await runCodingSuite({
    mode,
    output,
    concurrency: Number(values.parallel),
    budgetUsd: values["budget-usd"] ? Number(values["budget-usd"]) : undefined,
    names: values.only?.split(","),
    suite: values.suite,
  });
  if (result.failed) process.exitCode = 1;
}

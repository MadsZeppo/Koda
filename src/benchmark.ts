import { readFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { run, type RunOptions } from "./run.js";
import type { Config } from "./config.js";
import { git } from "./repo/commands.js";
const manifestSchema = z
  .array(
    z.object({
      name: z.string(),
      repo: z.string(),
      baseCommit: z.string().regex(/^[a-f0-9]{7,40}$/),
      task: z.string(),
      verify: z.array(z.string()).min(1),
    }),
  )
  .min(1);
export async function benchmark(
  manifest: string,
  config: Config,
  output: string,
  runOverrides: Pick<RunOptions, "codingWorkerFactory"> = {},
) {
  const tasks = manifestSchema.parse(
    JSON.parse(await readFile(manifest, "utf8")),
  );
  await mkdir(output, { recursive: true });
  const results = [];
  for (const [index, entry] of tasks.entries()) {
    const start = Date.now();
    let result;
    const source = resolve(dirname(manifest), entry.repo);
    const staging = await mkdtemp(join(tmpdir(), "koda-benchmark-source-"));
    const checkout = join(staging, "repo");
    try {
      // Benchmarks describe an exact historical commit. Materialize that commit
      // as a clean input so ordinary dirty-workspace runs can always preserve
      // the user's current filesystem as their baseline.
      await git(source, "worktree", "add", "--detach", checkout, entry.baseCommit);
      result = await run({
        repo: checkout,
        task: entry.task,
        baseCommit: entry.baseCommit,
        verify: entry.verify,
        config,
        output: join(output, String(index)),
        ...runOverrides,
      });
    } catch (error) {
      result = {
        status: "FAILED" as const,
        costUsd: 0,
        costComplete: false,
        wallClockMs: Date.now() - start,
        error: String(error),
        verification: {
          status: "NOT_FULLY_VERIFIED" as const,
          checks: [],
          failedChecks: 0,
          failingTests: null,
          buildErrors: null,
        },
      };
    } finally {
      await git(source, "worktree", "remove", "--force", checkout).catch(
        () => undefined,
      );
      await rm(staging, { recursive: true, force: true });
    }
    results.push({ name: entry.name, baseCommit: entry.baseCommit, ...result });
    await writeFile(
      join(output, "results.json"),
      JSON.stringify(results, null, 2),
    );
  }
  const md = [
    "# Benchmark results",
    "",
    "| Task | Status | Cost USD | Seconds |",
    "| --- | --- | ---: | ---: |",
    ...results.map(
      (r) =>
        `| ${r.name.replaceAll("|", "\\|")} | ${r.status} | ${r.costUsd.toFixed(6)} | ${(r.wallClockMs / 1000).toFixed(2)} |`,
    ),
  ];
  await writeFile(join(output, "summary.md"), md.join("\n") + "\n");
  return results;
}

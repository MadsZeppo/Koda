import { readFile, writeFile, mkdir, rename, cp, rm } from "node:fs/promises";
import { join, resolve, dirname, isAbsolute, relative } from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { execa } from "execa";
import { z } from "zod";
import { codexArguments, reportedModel } from "./codexComparison.js";
import {
  claudeArguments,
  parseClaudeOutput,
  benchmarkArms,
} from "./claudeBenchmark.js";
import { runtimeInfrastructureFailure } from "../verifier/verifier.js";
import { snapshotTree } from "../workspace/files.js";
import { codexCost } from "./codexCost.js";

export const arms = ["routing-v1", "codex", "strongest", "cheapest"] as const;
// Resolve Koda's runtime dependency here, never relative to the target repo.
export const benchmarkTsxLoader = import.meta.resolve("tsx");
const check = z.object({
  argv: z.array(z.string()).min(1),
  timeoutMs: z.number().positive().default(120000),
});
export const realBenchmarkSchema = z
  .object({
    version: z.literal(1),
    tasks: z
      .array(
        z.object({
          id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
          category: z.enum([
            "small-edit",
            "debugging",
            "backend",
            "frontend-ui",
            "refactor",
            "security",
            "architecture",
          ]),
          split: z.enum(["development", "holdout"]),
          repo: z.string().min(1),
          commit: z.string().regex(/^[a-f0-9]{40}$/),
          task: z.string().min(1),
          writeScope: z.array(z.string()).min(1),
          // Immutable external oracle copied outside the candidate repository. It receives
          // candidate path as its final argument; no gold patches are exposed to workers.
          oracleDirectory: z.string().min(1),
          acceptance: check,
          verification: z.array(check).min(1),
        }),
      )
      .min(1)
      .max(50),
  })
  .superRefine((data, ctx) => {
    if (new Set(data.tasks.map((t) => t.id)).size !== data.tasks.length)
      ctx.addIssue({
        code: "custom",
        message: "Duplicate task IDs / split leakage",
      });
    for (const t of data.tasks)
      for (const p of t.writeScope)
        if (isAbsolute(p) || p.split(/[\\/]/).includes(".."))
          ctx.addIssue({
            code: "custom",
            message: "Write scope must be repository-relative",
          });
  });
export interface BenchmarkRow {
  synthetic?: boolean;
  taskId: string;
  category: string;
  arm: string;
  status: string;
  verified: boolean;
  groundTruthSolve?: boolean | null;
  falseAccept: boolean | null;
  oraclePass: boolean | null;
  mutation: boolean;
  models: string[];
  attempts: unknown[];
  costUsd: number | null;
  costComplete: boolean;
  costBasis: string;
  tokens: unknown;
  wallClockMs: number;
  failureAttribution: unknown;
  referenceCalls: number | null;
  error?: string;
  reservationUsd: number;
  exitCode?: number;
  changedFiles?: string[];
  requestedModel?: string;
  toolResults?: unknown[];
  modelUsage?: unknown;
}
export function comparisonReport(
  rows: BenchmarkRow[],
  expected: number,
  selectedArms: readonly string[] = arms,
) {
  const summarize = (items: BenchmarkRow[]) => {
    const solved = items.filter(
      (r) => r.groundTruthSolve ?? (r.verified && r.oraclePass === true),
    );
    const complete = items.every((r) => r.costComplete && r.costUsd !== null);
    return {
      completed: items.length,
      verifiedSolves: items.filter((r) => r.verified && r.oraclePass === true)
        .length,
      groundTruthSolves: solved.length,
      solveRate: items.length ? solved.length / items.length : null,
      criticalFalseAccepts: items.filter((r) => r.falseAccept).length,
      unknownAcceptance: items.filter((r) => r.oraclePass === null).length,
      totalCostUsd: complete ? items.reduce((n, r) => n + r.costUsd!, 0) : null,
      costPerVerifiedSolve:
        complete && solved.length
          ? items.reduce((n, r) => n + r.costUsd!, 0) / solved.length
          : null,
      wallClockPerVerifiedSolveMs: solved.length
        ? items.reduce((n, r) => n + r.wallClockMs, 0) / solved.length
        : null,
      referenceCallRate:
        items.length && items.every((r) => r.referenceCalls !== null)
          ? items.filter((r) => r.referenceCalls! > 0).length / items.length
          : null,
    };
  };
  const paired = rows
    .filter((r) => r.arm === "routing-v1")
    .flatMap((r) => {
      const peers = rows.filter((p) => p.taskId === r.taskId),
        strongest = peers.find((p) => p.arm === "strongest");
      if (peers.length !== selectedArms.length || !strongest) return [];
      const successful = peers.filter(
        (p) => p.verified && p.oraclePass === true,
      );
      const known =
        successful.every((p) => p.costComplete && p.costUsd !== null) &&
        r.costComplete &&
        r.costUsd !== null;
      return [
        {
          taskId: r.taskId,
          solveRegretVsStrongest:
            Number(strongest.verified && strongest.oraclePass === true) -
            Number(r.verified && r.oraclePass === true),
          oracleSolved: successful.length > 0,
          routingSolved: r.verified && r.oraclePass === true,
          costRegretVsOracleUsd:
            known && successful.length && r.verified && r.oraclePass
              ? r.costUsd! - Math.min(...successful.map((p) => p.costUsd!))
              : null,
          wallClockRegretVsOracleMs:
            successful.length && r.verified && r.oraclePass
              ? r.wallClockMs -
                Math.min(...successful.map((p) => p.wallClockMs))
              : null,
        },
      ];
    });
  return {
    expectedRuns: expected,
    completedRuns: rows.length,
    complete: rows.length === expected,
    arms: Object.fromEntries(
      selectedArms.map((a) => [a, summarize(rows.filter((r) => r.arm === a))]),
    ),
    byCategory: Object.fromEntries(
      [...new Set(rows.map((r) => r.category))].map((c) => [
        c,
        Object.fromEntries(
          selectedArms.map((a) => [
            a,
            summarize(rows.filter((r) => r.category === c && r.arm === a)),
          ]),
        ),
      ]),
    ),
    pairedRegret: paired,
    caveat:
      "Codex subscription cost is unknown; API-equivalent estimates must not be compared as actual spend. Oracle regret uses only observed, independently accepted arms. Incomplete results are not quality conclusions.",
  };
}
export function comparisonMarkdown(
  report: ReturnType<typeof comparisonReport>,
) {
  const table = (items: typeof report.arms) =>
    "| Arm | Solved/runs | Solve rate | Cost/solve USD | Wall-clock/solve ms | False accepts |\n|---|---:|---:|---:|---:|---:|\n" +
    Object.entries(items)
      .map(
        ([arm, m]) =>
          `| ${arm.replaceAll("|", "\\|")} | ${m.groundTruthSolves}/${m.completed} | ${m.solveRate ?? "unknown"} | ${m.costPerVerifiedSolve ?? "unknown"} | ${m.wallClockPerVerifiedSolveMs ?? "unknown"} | ${m.criticalFalseAccepts} |`,
      )
      .join("\n");
  return (
    `# Real benchmark comparison\n\n${table(report.arms)}\n\n` +
    Object.entries(report.byCategory)
      .map(([c, items]) => `## ${c}\n\n${table(items)}`)
      .join("\n\n") +
    `\n\n${report.caveat}\n`
  );
}
async function json(path: string) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}
async function atomic(path: string, value: unknown) {
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2));
  await rename(`${path}.tmp`, path);
}
async function command(
  c: z.infer<typeof check>,
  cwd: string,
  extra: string[] = [],
) {
  try {
    const p = await execa(c.argv[0]!, [...c.argv.slice(1), ...extra], {
      cwd,
      reject: false,
      timeout: c.timeoutMs,
    });
    return {
      pass: p.exitCode === 0,
      output: p.all ?? `${p.stdout}\n${p.stderr}`,
      infrastructureError: !!runtimeInfrastructureFailure({
        command: c.argv.join(" "),
        exitCode: p.exitCode ?? 1,
        stdout: p.stdout,
        stderr: p.stderr,
        wallClockMs: 0,
        timedOut: false,
      }),
    };
  } catch (e) {
    return { pass: false, output: String(e), infrastructureError: true };
  }
}
export async function runRealBenchmark(options: {
  childEnv?: Record<string, string>;
  manifest: string;
  output: string;
  config: string;
  budgetUsd: number;
  split: string;
  resume?: boolean;
  codexModel?: string;
  priors: string;
  timeoutMs?: number;
  claudeModels?: string[];
  selectedArms?: string[];
  limit?: number;
  execute?: (job: {
    arm: string;
    repo: string;
    report: string;
    prompt: string;
    budgetUsd: number;
    argv: string[];
    command: string;
  }) => Promise<{ stdout: string; stderr: string; exitCode?: number }>;
}) {
  if (!(Number.isFinite(options.budgetUsd) && options.budgetUsd > 0))
    throw Error("Explicit positive --budget-usd is mandatory; no paid default");
  if (!["development", "holdout"].includes(options.split))
    throw Error("Select development or holdout explicitly");
  const manifestPath = resolve(options.manifest),
    manifest = realBenchmarkSchema.parse(await json(manifestPath));
  if (
    options.limit !== undefined &&
    (!Number.isSafeInteger(options.limit) || options.limit < 1)
  )
    throw Error("Invalid --limit");
  const tasks = manifest.tasks
    .filter((t) => t.split === options.split)
    .slice(0, options.limit);
  const selectedArms = options.claudeModels
    ? benchmarkArms(options.claudeModels, options.selectedArms)
    : (options.selectedArms ?? [...arms]);
  if (
    !selectedArms.length ||
    new Set(selectedArms).size !== selectedArms.length ||
    selectedArms.some(
      (a) =>
        !a.startsWith("claude:") &&
        !a.startsWith("calibration:") &&
        ![...arms, "current-koda"].includes(a as any),
    )
  )
    throw Error("Invalid benchmark arms");
  const billedArms = selectedArms.filter((a) => a !== "codex");
  if (!billedArms.length)
    throw Error("Select at least one budget-capped API arm");
  if (!tasks.length) throw Error("Empty selected split");
  const output = resolve(options.output),
    cfgPath = resolve(options.config);
  const priorsText = await readFile(resolve(options.priors), "utf8");
  const priors = JSON.parse(priorsText);
  const evidence = priors.priors ?? [];
  if (
    evidence.some(
      (e: any) =>
        e.source === "synthetic" ||
        manifest.tasks.some((t) => t.id === e.taskId),
    )
  )
    throw Error(
      "Synthetic or evaluation-task evidence leaks into frozen priors",
    );
  const oracleHashes = Object.fromEntries(
    await Promise.all(
      tasks.map(async (task) => [
        task.id,
        (
          await snapshotTree(
            resolve(dirname(manifestPath), task.oracleDirectory),
          )
        ).files,
      ]),
    ),
  );
  const identity = createHash("sha256")
    .update(
      JSON.stringify({
        manifest,
        oracleHashes,
        priors: priorsText,
        config: await readFile(cfgPath, "utf8"),
        budget: options.budgetUsd,
        split: options.split,
        selectedArms,
        limit: options.limit ?? null,
        codexModel: options.codexModel ?? null,
      }),
    )
    .digest("hex");
  await mkdir(output, { recursive: true });
  let state = await json(join(output, "state.json"));
  if (state && (!options.resume || state.identity !== identity))
    throw Error(
      "Existing output requires --resume and identical frozen inputs/budget",
    );
  state ??= {
    identity,
    budgetUsd: options.budgetUsd,
    rows: [],
    reservations: [],
  };
  const lock = await import("node:fs/promises").then((fs) =>
    fs.open(join(output, ".lock"), "wx"),
  );
  try {
    const allocation = options.budgetUsd / (tasks.length * billedArms.length);
    for (const task of tasks)
      for (const arm of selectedArms) {
        if (
          state.rows.some(
            (r: BenchmarkRow) => r.taskId === task.id && r.arm === arm,
          )
        )
          continue;
        const id = `${task.id}-${createHash("sha256").update(arm).digest("hex").slice(0, 16)}`,
          root = join(output, id),
          repo = join(root, "repo"),
          oracle = join(root, "oracle"),
          report = join(root, "report");
        if (state.reservations.includes(id)) {
          // An interrupted child may have spent money. Never silently rerun it.
          state.rows.push({
            taskId: task.id,
            category: task.category,
            arm,
            status: "INTERRUPTED",
            verified: false,
            falseAccept: null,
            oraclePass: null,
            mutation: false,
            models: [],
            attempts: [],
            costUsd: null,
            costComplete: false,
            costBasis: "unknown",
            tokens: null,
            wallClockMs: 0,
            failureAttribution: null,
            referenceCalls: null,
            reservationUsd: arm === "codex" ? 0 : allocation,
          });
          await atomic(join(output, "state.json"), state);
          continue;
        }
        if (arm !== "codex") {
          const codexIds = new Set(
            tasks.map(
              (t) =>
                `${t.id}-${createHash("sha256").update("codex").digest("hex").slice(0, 16)}`,
            ),
          );
          const reservedSpend = state.reservations
            .filter((key: string) => !codexIds.has(key))
            .reduce((total: number, key: string) => {
              const finished = state.rows.find(
                (r: BenchmarkRow) =>
                  `${r.taskId}-${createHash("sha256").update(r.arm).digest("hex").slice(0, 16)}` ===
                  key,
              );
              return (
                total + Math.max(allocation, finished?.costUsd ?? allocation)
              );
            }, 0);
          if (reservedSpend + allocation > options.budgetUsd + 1e-9)
            throw Error(
              "Aggregate budget exhausted, including incomplete reservations",
            );
        }
        await mkdir(root, { recursive: true });
        const source = resolve(dirname(manifestPath), task.repo),
          oracleSource = resolve(dirname(manifestPath), task.oracleDirectory);
        if (
          !relative(source, oracleSource).startsWith("..") &&
          !isAbsolute(relative(source, oracleSource))
        )
          throw Error("Oracle must reside outside the target repository");
        // Local, pinned, tracked snapshot: never operate on the user's checkout.
        await execa("git", [
          "clone",
          "--no-hardlinks",
          "--no-checkout",
          "--",
          source,
          repo,
        ]);
        await execa("git", ["checkout", "--detach", task.commit], {
          cwd: repo,
        });
        if (arm.startsWith("calibration:")) {
          // Remove future/gold repository history from the worker snapshot. Only checked-out base files remain.
          await rm(join(repo, ".git"), { recursive: true, force: true });
          await execa("git", ["init"], { cwd: repo });
          await execa("git", ["add", "."], { cwd: repo });
          await execa(
            "git",
            [
              "-c",
              "user.name=Koda calibration",
              "-c",
              "user.email=calibration@localhost",
              "commit",
              "-m",
              "Isolated pinned base snapshot",
            ],
            { cwd: repo },
          );
        }
        await cp(oracleSource, oracle, { recursive: true });
        if (
          JSON.stringify((await snapshotTree(oracle)).files) !==
          JSON.stringify(oracleHashes[task.id])
        )
          throw Error("Oracle changed after benchmark inputs were frozen");
        const baseline: Awaited<ReturnType<typeof command>>[] = [];
        for (const c of task.verification)
          baseline.push(await command(c, repo));
        const baselineOracle = await command(task.acceptance, oracle, [repo]);
        await atomic(join(root, "baseline.json"), {
          checks: baseline,
          oracle: baselineOracle,
        });
        if (baseline.some((c) => c.infrastructureError))
          throw Error(
            `Baseline environment unavailable: ${task.id}; prepare dependencies/check commands before spending`,
          );
        state.reservations.push(id);
        await atomic(join(output, "state.json"), state);
        const start = Date.now();
        let transcript = "",
          exitCode: number | undefined,
          error: string | undefined;
        const prompt = `${task.task}\n\nAuthoritative write restriction: modify only ${task.writeScope.join(", ")}. Preserve other files. Run repository verification.`;
        try {
          const job = join(root, "job.json");
          await mkdir(join(root, "routing"), { recursive: true });
          await writeFile(
            join(root, "routing", "routing-v1-priors.json"),
            priorsText,
          );
          await atomic(job, {
            kind: "koda-real-benchmark",
            arm,
            config: cfgPath,
            budgetUsd: allocation,
            repo,
            task: prompt,
            report,
            stateDirectory: join(root, "routing"),
          });
          const commandName = arm.startsWith("claude:")
            ? "claude"
            : arm === "codex"
              ? "codex"
              : process.execPath;
          const argv = arm.startsWith("claude:")
            ? claudeArguments(arm.slice(7), allocation)
            : arm === "codex"
              ? codexArguments(repo, options.codexModel)
              : [
                  "--import",
                  benchmarkTsxLoader,
                  new URL("./realBenchmarkWorker.ts", import.meta.url).pathname,
                  job,
                ];
          const child = options.execute
            ? await options.execute({
                arm,
                repo,
                report,
                prompt,
                budgetUsd: allocation,
                argv,
                command: commandName,
              })
            : await execa(commandName, argv, {
                cwd: repo,
                env: options.childEnv,
                input:
                  arm.startsWith("claude:") || arm === "codex"
                    ? prompt
                    : undefined,
                reject: false,
                timeout: options.timeoutMs ?? 600000,
              });
          transcript = child.stdout;
          exitCode = child.exitCode;
          await writeFile(join(root, "stderr.log"), child.stderr);
        } catch (e) {
          error = String(e);
          const failure = e as {
            stdout?: string;
            stderr?: string;
            exitCode?: number;
          };
          transcript = failure.stdout ?? "";
          exitCode = failure.exitCode;
          await writeFile(join(root, "stderr.log"), failure.stderr ?? error);
        }
        await writeFile(join(root, "stdout.log"), transcript);
        const summary = await json(join(report, "summary.json"));
        let events: any[] = [];
        try {
          events = (await readFile(join(report, "events.jsonl"), "utf8"))
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l));
        } catch {}
        const candidateSnapshot = await snapshotTree(repo);
        const after = [];
        for (const c of task.verification) after.push(await command(c, repo));
        const accepted = await command(task.acceptance, oracle, [repo]);
        const diff = await execa(
          "git",
          ["status", "--porcelain", "-z", "--untracked-files=all"],
          { cwd: repo },
        );
        const paths = diff.stdout
          .split("\0")
          .filter(Boolean)
          .map((p) => p.slice(3));
        const scopeOk = paths.every((p) =>
          task.writeScope.some(
            (s) =>
              s === "." || p === s || p.startsWith(`${s.replace(/\/$/, "")}/`),
          ),
        );
        const mutation = paths.length > 0;
        const verificationSnapshot = await snapshotTree(repo);
        const verifierMutated =
          JSON.stringify(candidateSnapshot.files) !==
          JSON.stringify(verificationSnapshot.files);
        const checkPass =
          !verifierMutated &&
          after.every(
            (c, i) =>
              c.pass ||
              (!baseline[i]!.pass &&
                !c.infrastructureError &&
                c.output === baseline[i]!.output),
          );
        const claude = arm.startsWith("claude:")
          ? parseClaudeOutput(transcript)
          : null;
        const claimed = claude
          ? exitCode === 0 && claude.claimedSuccess
          : arm === "codex"
            ? exitCode === 0 && checkPass && mutation && scopeOk
            : summary?.status === "VERIFIED_SUCCESS" &&
              summary?.applyResult === "applied";
        const oraclePass = accepted.infrastructureError ? null : accepted.pass;
        const cost =
          arm === "codex"
            ? codexCost(
                transcript,
                options.codexModel ?? reportedModel(transcript),
                exitCode === 0,
              )
            : null;
        const calls = events.filter((e) => e.type === "model_call");
        const row: BenchmarkRow = {
          synthetic: summary?.synthetic === true,
          taskId: task.id,
          category: task.category,
          arm,
          status:
            summary?.status ??
            (claimed ? "VERIFIED_SUCCESS" : "NOT_FULLY_VERIFIED"),
          verified: claimed && checkPass && scopeOk && mutation,
          falseAccept: claimed
            ? oraclePass === null
              ? null
              : !oraclePass || !checkPass || !scopeOk || !mutation
            : false,
          oraclePass,
          groundTruthSolve:
            oraclePass === null
              ? null
              : oraclePass && checkPass && scopeOk && mutation,
          mutation,
          models: claude
            ? claude.models
            : arm === "codex"
              ? [reportedModel(transcript)]
              : ([
                  ...new Set(
                    calls
                      .map((e) => e.model ?? e.modelRequested)
                      .filter(Boolean),
                  ),
                ] as string[]),
          attempts: claude
            ? claude.attempts
            : events.filter(
                (e) =>
                  e.type === "model_attempt" ||
                  e.type === "real_benchmark_route",
              ),
          costUsd: claude
            ? claude.costUsd
            : (cost?.costUsd ?? summary?.costUsd ?? null),
          costComplete: claude
            ? !error && claude.costComplete
            : (cost?.costComplete ?? summary?.costComplete ?? false),
          costBasis: claude
            ? "claude_code_reported_api_cost"
            : (cost?.costBasis ?? "reported_provider_usage"),
          tokens: claude
            ? claude.tokens
            : (cost?.tokens ?? summary?.totalTokens ?? null),
          wallClockMs: Date.now() - start,
          failureAttribution: summary?.failureAttribution ?? {
            primaryCause: "UNKNOWN_FAILURE",
            learningDisposition: "CENSORED",
          },
          referenceCalls:
            claude || arm === "codex"
              ? null
              : calls.filter((e) =>
                  events.some(
                    (route) =>
                      route.type === "real_benchmark_route" &&
                      route.reference === (e.model ?? e.modelRequested),
                  ),
                ).length,
          error,
          exitCode,
          changedFiles: paths,
          requestedModel: arm.startsWith("claude:") ? arm.slice(7) : undefined,
          toolResults: claude?.toolResults,
          modelUsage: claude?.modelUsage ?? {
            servedModels: calls
              .map((e) => ({
                requested: e.modelRequested,
                served: e.modelServed,
              }))
              .filter((e) => e.served),
          },
          reservationUsd: arm === "codex" ? 0 : allocation,
        };
        await atomic(join(root, "independent-verification.json"), {
          after,
          accepted,
          scopeOk,
          paths,
          baselineOracle,
          verifierMutated,
        });
        state.rows.push(row);
        await atomic(join(output, "state.json"), state);
        await atomic(
          join(output, "comparison.json"),
          comparisonReport(
            state.rows,
            tasks.length * selectedArms.length,
            selectedArms,
          ),
        );
        console.log(
          `${arm} ${task.id}: ${row.verified && oraclePass ? "PASS" : "FAIL"}`,
        );
        if (arm !== "codex" && row.costUsd !== null && row.costUsd > allocation)
          throw Error("Run exceeded its reservation; stop benchmark");
      }
    await atomic(
      join(output, "comparison.json"),
      comparisonReport(
        state.rows,
        tasks.length * selectedArms.length,
        selectedArms,
      ),
    );
    await writeFile(
      join(output, "comparison.md"),
      comparisonMarkdown(
        comparisonReport(
          state.rows,
          tasks.length * selectedArms.length,
          selectedArms,
        ),
      ),
    );
  } finally {
    await lock.close();
    await rm(join(output, ".lock"));
  }
}
if (process.argv[1]?.endsWith("realBenchmark.ts")) {
  const { values } = parseArgs({
    options: {
      manifest: { type: "string" },
      priors: { type: "string" },
      config: { type: "string" },
      output: { type: "string" },
      "budget-usd": { type: "string" },
      split: { type: "string" },
      resume: { type: "boolean" },
      "codex-model": { type: "string" },
      "claude-models": { type: "string" },
      arms: { type: "string" },
      limit: { type: "string" },
    },
  });
  if (
    !values.priors ||
    !values.manifest ||
    !values.config ||
    !values.output ||
    !values["budget-usd"] ||
    !values.split
  )
    throw Error(
      "Requires --manifest --priors --config --output --budget-usd --split; this command makes real calls",
    );
  await runRealBenchmark({
    manifest: values.manifest,
    priors: values.priors,
    config: values.config,
    output: values.output,
    budgetUsd: Number(values["budget-usd"]),
    split: values.split,
    resume: values.resume,
    codexModel: values["codex-model"],
    claudeModels: values["claude-models"]?.split(","),
    selectedArms: values.arms?.split(","),
    limit: values.limit ? Number(values.limit) : undefined,
  });
}

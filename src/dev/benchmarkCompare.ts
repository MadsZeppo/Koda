/** One manually invoked task, normal Koda routing, no benchmark policy override. */
import {
  cp,
  mkdir,
  readFile,
  readdir,
  lstat,
  writeFile,
  realpath,
  readlink,
  symlink,
  unlink,
} from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import {
  join,
  resolve,
  relative,
  isAbsolute,
  dirname,
  basename,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { execa } from "execa";
import { parseClaudeOutput } from "./claudeBenchmark.js";
import { codexArguments, reportedModel } from "./codexComparison.js";

type Arm = "codex" | "koda";
export interface Invocation {
  command: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  input?: string;
  timeoutMs: number;
}
type Execute = (
  command: Invocation,
) => Promise<{ stdout: string; stderr: string; exitCode?: number }>;
const execute: Execute = async (c) => {
  try {
    return await execa(c.command, c.argv, {
      cwd: c.cwd,
      env: c.env,
      extendEnv: false,
      input: c.input,
      reject: false,
      timeout: c.timeoutMs,
    });
  } catch (e) {
    const error = e as { stdout?: string; stderr?: string; exitCode?: number };
    return {
      stdout: error.stdout ?? "",
      stderr: (error.stderr ?? "") + "\n" + String(e),
      exitCode: error.exitCode,
    };
  }
};
export function subscriptionEnv(env: NodeJS.ProcessEnv) {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([k, v]) =>
        v !== undefined &&
        ![
          "OPENAI_API_KEY",
          "CODEX_API_KEY",
          "OPENAI_BASE_URL",
          "CODEX_ACCESS_TOKEN",
          "CODEX_AUTH_TOKEN",
          "OPENROUTER_API_KEY",
          "ANTHROPIC_API_KEY",
        ].includes(k),
    ),
  ) as Record<string, string>;
}
export function subscriptionArguments(repo: string) {
  return [
    ...codexArguments(repo).slice(0, -1),
    "--ignore-user-config",
    "-c",
    'forced_login_method="chatgpt"',
    "-c",
    'model_provider="openai"',
    "-",
  ];
}
// Include dependency bytes/modes in identity, not just tracked source files.
async function identity(root: string) {
  const hash = createHash("sha256");
  async function visit(path: string) {
    for (const name of (await readdir(join(root, path))).sort()) {
      if (name === ".git" || name === ".koda") continue;
      const child = join(path, name),
        stat = await lstat(join(root, child));
      hash.update(JSON.stringify([child, stat.mode]));
      if (stat.isDirectory()) await visit(child);
      else if (stat.isFile()) hash.update(await readFile(join(root, child)));
      else if (stat.isSymbolicLink())
        hash.update(await readlink(join(root, child)));
      else throw Error(`Unsupported file in comparison snapshot: ${child}`);
    }
  }
  await visit("");
  return hash.digest("hex");
}
// Preserve executable link topology: flattening .bin scripts breaks their relative imports.
// Links outside the snapshot are materialized so neither agent can edit the source repo.
export async function copyComparisonSnapshot(
  from: string,
  to: string,
  ancestors: string[] = [],
) {
  const root = await realpath(from);
  if (ancestors.includes(root))
    throw Error(`Cyclic external snapshot link: ${from}`);
  await cp(from, to, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
    filter: (p) => ![".git", ".koda"].includes(basename(p)),
  });
  async function visit(path: string) {
    for (const name of await readdir(join(root, path))) {
      if ([".git", ".koda"].includes(name)) continue;
      const child = join(path, name);
      const source = join(root, child),
        destination = join(to, child);
      const stat = await lstat(source);
      if (stat.isDirectory()) await visit(child);
      else if (stat.isSymbolicLink()) {
        const target = await realpath(source);
        const within = relative(root, target);
        await unlink(destination);
        if (
          within !== ".." &&
          !within.startsWith("../") &&
          !isAbsolute(within)
        ) {
          await symlink(
            relative(dirname(destination), join(to, within)),
            destination,
          );
        } else if ((await lstat(target)).isDirectory()) {
          await copyComparisonSnapshot(target, destination, [
            ...ancestors,
            root,
          ]);
        } else {
          await cp(target, destination, { mode: constants.COPYFILE_FICLONE });
        }
      }
    }
  }
  await visit("");
}
export function kodaUsage(events: any[], summary: any) {
  const calls = events.filter((e) => e.type === "model_call");
  const valid = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0;
  // Older Agentic v1 logged parseUsage(provider.usage).cost without its raw provenance.
  // Recover only groups reconciled against a completed Agentic worker receipt.
  const legacyAgentic = new Set<any>();
  for (const stop of events.filter(e => e.type === "coding_worker_stop" && e.worker_engine === "agentic" && e.worker_version === "1")) {
    const group = calls.filter(e => e.stage === "implement" && e.subtaskId === stop.subtaskId);
    if (group.length && group.every(e => e.costSource === undefined && valid(e.costUsd) && valid(e.promptTokens) && valid(e.completionTokens)) &&
        valid(stop.cost_usd) && Math.abs(group.reduce((n,e) => n + e.costUsd, 0) - stop.cost_usd) < 1e-10 &&
        group.reduce((n,e) => n + e.promptTokens, 0) === stop.input_tokens && group.reduce((n,e) => n + e.completionTokens, 0) === stop.output_tokens)
      for (const e of group) legacyAgentic.add(e);
  }
  const receiptCost = (e: any) => {
    if (e.synthetic === true) return null;
    if (valid(e.providerReportedCostUsd)) return e.providerReportedCostUsd;
    if (valid(e.raw?.cost)) return e.raw.cost;
    if (legacyAgentic.has(e)) return e.costUsd;
    // Existing Python workers report their settled usage in model_call.
    if (
      e.workerEngine &&
      e.costSource !== "estimated_from_tokens" &&
      valid(e.promptTokens) &&
      valid(e.completionTokens) &&
      valid(e.costUsd)
    )
      return e.costUsd;
    return null;
  };
  const costs = calls.map(receiptCost);
  const complete =
    summary?.synthetic !== true &&
    summary?.costComplete === true &&
    (calls.length > 0 || summary?.costUsd === 0) &&
    costs.every((c) => c !== null);
  return {
    costUsd: complete ? costs.reduce<number>((n, c) => n + (c ?? 0), 0) : null,
    costComplete: complete,
    knownReceiptCostUsd: costs.reduce<number>((n, c) => n + (c ?? 0), 0),
    missingReceipts: calls.filter((_, index) => costs[index] === null).map(e => ({
      stage: e.stage, model: e.modelReturned ?? e.modelRequested ?? e.model,
      responseId: e.responseId ?? null, outcome: e.outcome ?? null,
      error: e.error ?? null,
    })),
    models: [
      ...new Set(
        calls
          .flatMap((e) => [e.modelReturned ?? e.modelRequested ?? e.model])
          .filter((m): m is string => typeof m === "string"),
      ),
    ],
    selectedModels: [
      ...new Set(
        events
          .flatMap((e) =>
            e.type === "model_attempt" ? [e.modelRequested] : [],
          )
          .filter((m): m is string => typeof m === "string"),
      ),
    ],
    receipts: calls,
  };
}
function codexUsage(transcript: string) {
  const usage: unknown[] = [];
  for (const line of transcript.split("\n")) {
    try {
      const e = JSON.parse(line);
      if (e.type === "turn.completed" && e.usage) usage.push(e.usage);
    } catch {
      /* Keep raw output; no invented usage. */
    }
  }
  return {
    model: reportedModel(transcript),
    usage,
    cost: "subscription" as const,
  };
}
async function optionalJson(path: string) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}
export interface CompareOptions {
  repo: string;
  task: string;
  check: string;
  output: string;
  config?: string;
  budgetUsd?: number;
  timeoutMs?: number;
  baseline?: "codex" | "claude";
  claudeBudgetUsd?: number;
  claudeModel?: string;
}
export async function compareTask(
  o: CompareOptions,
  runCommand: Execute = execute,
) {
  if (!o.task.trim() || !o.check.trim())
    throw Error("Nonempty --task and --check required");
  const budgetUsd = o.budgetUsd ?? 0.5,
    timeoutMs = o.timeoutMs ?? 600000;
  if (
    !Number.isFinite(budgetUsd) ||
    budgetUsd <= 0 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  )
    throw Error("Invalid budget/timeout");
  const source = await realpath(resolve(o.repo)),
    output = join(
      await realpath(dirname(resolve(o.output))),
      basename(resolve(o.output)),
    );
  const rel = relative(source, output);
  if (!rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../")))
    throw Error("Output must be outside the source repository");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => v !== undefined),
  ) as Record<string, string>;
  const external = o.baseline ?? "codex";
  const claudeCap = o.claudeBudgetUsd ?? .20;
  if (external === "claude" && (!env.ANTHROPIC_API_KEY?.trim() || !Number.isFinite(claudeCap) || claudeCap <= 0)) throw Error("Claude requires local ANTHROPIC_API_KEY and a positive Claude budget");
  const claudeEnv = { ...subscriptionEnv(env), ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY };
  const codexEnv = subscriptionEnv(env);
  if (external === "codex") {
  const auth = await runCommand({
    command: "codex",
    argv: ["login", "status"],
    cwd: source,
    env: codexEnv,
    timeoutMs: 15000,
  });
  if (
    auth.exitCode !== 0 ||
    !/logged in using chatgpt/i.test(auth.stdout + auth.stderr)
  )
    throw Error(
      "Codex must already be logged in using ChatGPT. Run codex login; API-key login is not accepted.",
    );
  }
  await mkdir(output, { recursive: false }); // Never overwrite a previous comparison.
  const started = Date.now(),
    seed = join(output, "starting-repo");
  const copy = copyComparisonSnapshot;
  await copy(source, seed);
  const startingDigest = await identity(seed);
  for (const arm of [external, "koda"]) {
    await copy(seed, join(output, arm, "repo"));
    if ((await identity(join(output, arm, "repo"))) !== startingDigest)
      throw Error("Comparison copies are not identical");
  }
  await writeFile(
    join(output, "inputs.json"),
    JSON.stringify(
      { source, task: o.task, check: o.check, startingDigest, budgetUsd },
      null,
      2,
    ),
  );
  const setupMs = Date.now() - started;
  const results: Record<string, any> = {};
  // Sequential arms avoid resource contention. Neither can write the source repo.
  for (const arm of [external, "koda"] as const) {
    const root = join(output, arm),
      repo = join(root, "repo"),
      report = join(root, "report");
    const armStart = Date.now();
    const args =
      arm === "claude"
        ? ["-p", "--bare", "--output-format", "json", "--max-budget-usd", String(claudeCap), "--no-session-persistence", "--permission-mode", "acceptEdits", "--allowedTools", "Read,Glob,Grep,Edit,Write,Bash", ...(o.claudeModel ? ["--model", o.claudeModel] : [])]
        : arm === "codex"
        ? subscriptionArguments(repo)
        : [
            fileURLToPath(new URL("../../bin/koda.mjs", import.meta.url)),
            "run",
            "--repo",
            repo,
            "--task",
            o.task,
            "--apply",
            "--budget-usd",
            String(budgetUsd),
            "--output",
            report,
            ...(o.config ? ["--config", resolve(o.config)] : []),
          ];
    const child = await runCommand({
      command: arm === "koda" ? process.execPath : arm,
      argv: args,
      cwd: repo,
      env: arm === "claude" ? claudeEnv as Record<string,string> : arm === "codex" ? codexEnv : Object.fromEntries(Object.entries(env).filter(([k]) => k !== "ANTHROPIC_API_KEY")),
      ...(arm !== "koda" ? { input: o.task } : {}),
      timeoutMs,
    });
    const agentWallMs = Date.now() - armStart;
    await writeFile(join(root, "stdout.log"), child.stdout);
    await writeFile(join(root, "stderr.log"), child.stderr);
    results[arm] = {
      repo,
      agentExitCode: child.exitCode ?? null,
      agentWallMs,
      ...(arm === "codex" ? codexUsage(child.stdout) : arm === "claude" ? (() => {
        const parsed = parseClaudeOutput(child.stdout);
        return { model: parsed.models.join(", ") || "unknown-default", usage: parsed.tokens ? [parsed.tokens] : [], costUsd: parsed.costUsd, costComplete: parsed.costComplete };
      })() : {}),
    };
    await writeFile(
      join(root, "agent.json"),
      JSON.stringify(results[arm], null, 2),
    );
  }
  // Run after BOTH agents finish, even when an agent exits unsuccessfully.
  for (const arm of [external, "koda"] as const) {
    const root = join(output, arm),
      start = Date.now();
    const check = await runCommand({
      command: "/bin/sh",
      argv: ["-c", o.check],
      cwd: results[arm].repo,
      env,
      timeoutMs,
    });
    await writeFile(join(root, "check.stdout.log"), check.stdout);
    await writeFile(join(root, "check.stderr.log"), check.stderr);
    Object.assign(results[arm], {
      passed: check.exitCode === 0,
      checkExitCode: check.exitCode ?? null,
      checkWallMs: Date.now() - start,
      check: o.check,
    });
    results[arm].wallClockMs =
      results[arm].agentWallMs + results[arm].checkWallMs;
  }
  const report = join(output, "koda", "report");
  let events: any[] = [];
  let eventsAvailable = false;
  try {
    events = (await readFile(join(report, "events.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((s) => JSON.parse(s));
    eventsAvailable = true;
  } catch {
    /* Unknown accounting is explicit. */
  }
  Object.assign(
    results.koda,
    kodaUsage(
      events,
      eventsAvailable ? await optionalJson(join(report, "summary.json")) : null,
    ),
  );
  const summary = {
    source,
    task: o.task,
    check: o.check,
    startingDigest,
    setupMs,
    totalWallMs: Date.now() - started,
    results,
    caveat:
      external === "claude" ? "Pass means the same independent check passed. Claude uses API-key-only bare mode and reports total_cost_usd; no model is forced unless explicitly requested. Runtime default is not task-based cheapest-model routing. Koda has a separate budget. CLI budget enforcement is not a prepaid billing limit." : "Pass means only the supplied check passed. Use an independent check that actually covers the requirement; agent claims are ignored. Subscription usage has no invented dollar value. Copies include dependencies; setup time is separate. Codex uses its built-in default model and ignores custom provider config to enforce subscription auth.",
  };
  await writeFile(
    join(output, "comparison.json"),
    JSON.stringify(summary, null, 2),
  );
  const table = `| | ${external === "claude" ? "Claude Code" : "Codex"} | Koda |\n|---|---:|---:|\n| Passed | ${results[external].passed ? "yes" : "no"} | ${results.koda.passed ? "yes" : "no"} |\n| Wall time (agent + check) | ${(results[external].wallClockMs / 1000).toFixed(1)}s | ${(results.koda.wallClockMs / 1000).toFixed(1)}s |\n| Cost | ${external === "codex" ? "subscription" : results[external].costUsd === null ? "unknown" : "$" + results[external].costUsd.toFixed(6)} | ${results.koda.costUsd === null ? "unknown/incomplete" : "$" + results.koda.costUsd.toFixed(6)} |\n| Model | ${results[external].model} | ${(results.koda.selectedModels.length ? results.koda.selectedModels : results.koda.models).join(", ") || "unknown"} |\n`;
  await writeFile(
    join(output, "comparison.md"),
    table + "\n" + summary.caveat + "\n",
  );
  return { ...summary, table };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values: v } = parseArgs({
    options: {
      repo: { type: "string" },
      task: { type: "string" },
      check: { type: "string" },
      output: { type: "string" },
      config: { type: "string" },
      baseline: { type: "string", default: "codex" },
      "claude-budget-usd": { type: "string", default: "0.20" },
      "claude-model": { type: "string" },
      "budget-usd": { type: "string", default: "0.50" },
      "timeout-ms": { type: "string", default: "600000" },
    },
  });
  if (!v.repo || !v.task || !v.check || !v.output)
    throw Error("--repo --task --check --output required");
  if (v.baseline !== "codex" && v.baseline !== "claude") throw Error("baseline must be codex or claude");
  console.log(
    "Copying one starting repo, then running the external agent and Koda sequentially...",
  );
  const result = await compareTask({
    baseline: v.baseline as "codex" | "claude",
    claudeBudgetUsd: Number(v["claude-budget-usd"]),
    claudeModel: v["claude-model"],
    repo: v.repo,
    task: v.task,
    check: v.check,
    output: v.output,
    config: v.config,
    budgetUsd: Number(v["budget-usd"]),
    timeoutMs: Number(v["timeout-ms"]),
  });
  console.log(result.table + "\nReports: " + resolve(v.output));
  if (result.results[v.baseline!].usage.length)
    console.log(
      v.baseline + " reported usage: " + JSON.stringify(result.results[v.baseline!].usage),
    );
  if (!result.results[v.baseline!].passed || !result.results.koda.passed)
    process.exitCode = 1;
}

import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { z } from "zod";

import type { Gateway } from "../openrouter/client.js";
import type { RepoProfile, Usage } from "../types.js";
import { explicitTaskPaths, type ExecutionStrategy } from "../router/executionStrategy.js";
import { extractFeatures } from "../router/features.js";
import { snapshotTree, changesBetween } from "../workspace/files.js";
import { isSourcePath, isTestPath } from "../context/compiler.js";
import { ensureOpenHandsRuntime, OPENHANDS_SDK_VERSION } from "./openHandsRuntime.js";
import { AttemptCheckpoint } from "./attemptCheckpoint.js";
import { WriteScope } from "../repo/writeScope.js";

const fileReasonSchema = z.object({ path: z.string(), reason: z.string() });
const dependencySchema = z.object({
  from: z.string(),
  to: z.string(),
  kind: z.string(),
});
const evidenceSchema = z.object({ path: z.string(), detail: z.string() });

export const repositoryExplorationSchema = z.object({
  confidence: z.enum(["high", "medium", "low"]),
  editableCandidates: z.array(fileReasonSchema).max(12),
  readonlyFiles: z.array(fileReasonSchema).max(16),
  relatedTests: z.array(z.string()).max(12),
  dependencies: z.array(dependencySchema).max(24),
  evidence: z.array(evidenceSchema).max(24),
  unresolvedQuestions: z.array(z.string()).max(12),
});
export type RepositoryExploration = z.infer<typeof repositoryExplorationSchema>;

export interface OpenHandsInvocation {
  repoPath: string;
  task: string;
  model: string;
  llmModel: string;
  baseUrl: string;
  provider: string;
  budgetUsd: number;
  maxTokens: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxIterations: number;
  maxFilesRead: number;
  timeoutMs: number;
  requestTimeoutMs: number;
  inputCostPerToken: number;
  outputCostPerToken: number;
  previousExploration?: RepositoryExploration;
  continuationReason?: string;
}

export interface OpenHandsReport {
  status: "completed" | "infra_failure";
  sdkVersion: string;
  providerDispatched: boolean;
  result?: RepositoryExploration;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
  modelCalls: number;
  toolCalls: number;
  filesInspected: string[];
  wallClockMs: number;
  error?: string;
}

export interface RepositoryExplorer {
  explore(input: {
    repoPath: string;
    task: string;
    profile: RepoProfile;
    previousExploration?: RepositoryExploration;
    continuationReason?: string;
  }): Promise<RepositoryExploration>;
}

export class OpenHandsOperationalError extends Error {
  readonly operational = true;
  constructor(message: string, readonly providerDispatched = false) {
    super(message);
    this.name = "OpenHandsOperationalError";
  }
}

interface ExplorerOptions {
  ensureRuntime?: () => Promise<string>;
  runner?: (invocation: OpenHandsInvocation) => Promise<OpenHandsReport>;
}

const bridgePath = fileURLToPath(new URL("../../workers/openhands/bridge.py", import.meta.url));

function fromBridge(raw: any): OpenHandsReport {
  const result = raw?.result && {
    confidence: raw.result.confidence,
    editableCandidates: raw.result.editable_candidates,
    readonlyFiles: raw.result.readonly_files,
    relatedTests: raw.result.related_tests,
    dependencies: raw.result.dependencies,
    evidence: raw.result.evidence,
    unresolvedQuestions: raw.result.unresolved_questions,
  };
  return {
    status: raw?.status,
    sdkVersion: raw?.sdk_version ?? "unknown",
    providerDispatched: raw?.provider_dispatched === true,
    result: result ? repositoryExplorationSchema.parse(result) : undefined,
    inputTokens: raw?.input_tokens ?? 0,
    outputTokens: raw?.output_tokens ?? 0,
    cachedInputTokens: raw?.cached_input_tokens ?? 0,
    cacheWriteTokens: raw?.cache_write_tokens ?? 0,
    costUsd: typeof raw?.cost_usd === "number" ? raw.cost_usd : undefined,
    modelCalls: raw?.model_calls ?? 0,
    toolCalls: raw?.tool_calls ?? 0,
    filesInspected: Array.isArray(raw?.files_inspected) ? raw.files_inspected : [],
    wallClockMs: raw?.wall_clock_ms ?? 0,
    error: typeof raw?.error === "string" ? raw.error : undefined,
  };
}

async function defaultRunner(python: string, invocation: OpenHandsInvocation) {
  const scratch = await mkdtemp(join(tmpdir(), "koda-openhands-"));
  const requestPath = join(scratch, "request.json");
  const reportPath = join(scratch, "report.json");
  try {
    await writeFile(requestPath, JSON.stringify({
      repo_path: invocation.repoPath,
      task: invocation.task,
      llm_model: invocation.llmModel,
      base_url: invocation.baseUrl,
      budget_usd: invocation.budgetUsd,
      max_tokens: invocation.maxTokens,
      max_input_tokens: invocation.maxInputTokens,
      max_output_tokens: invocation.maxOutputTokens,
      max_iterations: invocation.maxIterations,
      max_files_read: invocation.maxFilesRead,
      request_timeout_ms: invocation.requestTimeoutMs,
      input_cost_per_token: invocation.inputCostPerToken,
      output_cost_per_token: invocation.outputCostPerToken,
      previous_exploration: invocation.previousExploration,
      continuation_reason: invocation.continuationReason,
    }));
    const key = (invocation.provider === "openrouter"
      ? process.env.OPENROUTER_API_KEY
      : process.env.KODA_MODEL_API_KEY) ?? "missing";
    const processResult = await execa(python, [bridgePath, requestPath, reportPath], {
      cwd: invocation.repoPath,
      reject: false,
      timeout: invocation.timeoutMs,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: process.env.LANG ?? "C.UTF-8",
        KODA_EXPLORER_API_KEY: key,
        OPENHANDS_SUPPRESS_BANNER: "1",
        PYTHONDONTWRITEBYTECODE: "1",
        NO_COLOR: "1",
      },
    });
    let report: OpenHandsReport;
    try {
      report = fromBridge(JSON.parse(await readFile(reportPath, "utf8")));
    } catch {
      throw new OpenHandsOperationalError(
        `OpenHands bridge did not produce a valid report: ${processResult.stderr || processResult.stdout || `exit ${processResult.exitCode}`}`,
      );
    }
    return report;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** The only no-agent fast path: one exact safe file path and an isolated task. */
export function fastPathExploration(
  task: string,
  profile: RepoProfile,
  strategy: ExecutionStrategy,
): RepositoryExploration | undefined {
  const exact = explicitTaskPaths(task, profile);
  const broad = /\b(?:across|multiple|multi[- ]component|throughout|entire|refactor|migrat|architecture|client and server|independent|parallel)\b/i.test(task);
  if (
    broad ||
    exact.length !== 1 ||
    strategy.execution_strategy !== "direct"
  ) return undefined;
  const path = exact[0]!;
  return {
    confidence: "high",
    editableCandidates: [{ path, reason: "The task explicitly names this exact repository-relative file path." }],
    readonlyFiles: [],
    relatedTests: [],
    dependencies: [],
    evidence: [{ path, detail: profile.files.includes(path)
      ? "Exact path supplied by the user and validated against the repository profile."
      : "Exact new file path supplied by the user and validated as a safe repository-relative path." }],
    unresolvedQuestions: [],
  };
}

async function validatePath(
  root: string,
  known: ReadonlySet<string>,
  value: string,
  allowMissing = false,
) {
  if (!value || value.includes("\0") || value.startsWith("/") || /^[A-Za-z]:\//.test(value))
    throw new OpenHandsOperationalError(`OpenHands returned invalid repository path: ${value}`);
  const normalized = value.replaceAll("\\", "/").split("/").filter((part) => part && part !== ".");
  if (!normalized.length || normalized.some((part) => part === "..") || normalized[0] === ".git")
    throw new OpenHandsOperationalError(`OpenHands returned invalid repository path: ${value}`);
  const path = normalized.join("/");
  if (!known.has(path) && !allowMissing)
    throw new OpenHandsOperationalError(`OpenHands returned unknown repository path: ${path}`);
  const canonicalRoot = await realpath(root);
  let candidate = join(root, path);
  try {
    await realpath(candidate);
  } catch {
    if (!allowMissing)
      throw new OpenHandsOperationalError(`OpenHands returned unknown repository path: ${path}`);
    candidate = dirname(candidate);
    while (candidate !== root) {
      try {
        await realpath(candidate);
        break;
      } catch {
        candidate = dirname(candidate);
      }
    }
  }
  const canonical = await realpath(candidate);
  const rel = relative(canonicalRoot, canonical);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new OpenHandsOperationalError(`OpenHands path escapes repository: ${path}`);
  return path;
}

async function validateExploration(root: string, profile: RepoProfile, raw: RepositoryExploration) {
  const known = new Set(profile.files);
  const validateReasons = async (
    values: RepositoryExploration["editableCandidates"],
    allowMissing = false,
  ) => {
    const result: typeof values = [];
    const seen = new Set<string>();
    for (const item of values) {
      const path = await validatePath(root, known, item.path, allowMissing);
      if (!seen.has(path)) result.push({ path, reason: item.reason.slice(0, 600) });
      seen.add(path);
    }
    return result;
  };
  const editableCandidates = await validateReasons(raw.editableCandidates, true);
  const authorized = new Set([
    ...known,
    ...editableCandidates.map(({ path }) => path),
  ]);

  // Do not infer write scope from files inspected by OpenHands.
  // OpenHands owns repository scope discovery; this layer only validates
  // the scope it explicitly submitted.

  const editable = new Set(editableCandidates.map(({ path }) => path));
  const validateAuthorizedPath = (path: string) => {
    const normalized = path.replaceAll("\\", "/").split("/")
      .filter((part) => part && part !== ".").join("/");
    if (!authorized.has(normalized))
      throw new OpenHandsOperationalError(`OpenHands returned unknown repository path: ${normalized}`);
    return validatePath(root, authorized, path, true);
  };
  const validateAuthorizedReasons = async (
    values: RepositoryExploration["editableCandidates"],
  ) => {
    const result: typeof values = [];
    const seen = new Set<string>();
    for (const item of values) {
      const path = await validateAuthorizedPath(item.path);
      if (!seen.has(path)) result.push({ path, reason: item.reason.slice(0, 600) });
      seen.add(path);
    }
    return result;
  };
  const readonlyFiles = (await validateAuthorizedReasons(raw.readonlyFiles)).filter(({ path }) => !editable.has(path));
  const relatedTests = [...new Set(await Promise.all(raw.relatedTests.map(validateAuthorizedPath)))]
    .filter((path) => !editable.has(path));
  const dependencies = [];
  for (const edge of raw.dependencies) dependencies.push({
    from: await validateAuthorizedPath(edge.from),
    to: await validateAuthorizedPath(edge.to),
    kind: edge.kind.slice(0, 120),
  });
  const evidence = [];
  for (const item of raw.evidence) evidence.push({
    path: await validateAuthorizedPath(item.path),
    detail: item.detail.slice(0, 800),
  });
  return repositoryExplorationSchema.parse({
    ...raw,
    editableCandidates,
    readonlyFiles,
    relatedTests,
    dependencies,
    evidence,
  });
}

export function strategyWithExploration(
  task: string,
  initial: ExecutionStrategy,
  exploration: RepositoryExploration,
): ExecutionStrategy {
  const proposedEditable = exploration.editableCandidates.map(({ path }) => path);
  const editable = proposedEditable
    .filter((path) => isSourcePath(path) && !isTestPath(path));
  const all = [...new Set([...proposedEditable, ...exploration.relatedTests,
    ...exploration.readonlyFiles.map(({ path }) => path)])];
  if (initial.preciseTarget && proposedEditable.length === 1 &&
      proposedEditable[0] === initial.preciseTarget && exploration.confidence === "high")
    return { ...initial, likelyFiles: all };
  const broad = /\b(?:across|multiple|multi[- ]component|throughout|entire|refactor|migrat|architecture|independent|parallel)\b/i.test(task);
  if (initial.execution_strategy === "planned" || broad || editable.length > 3)
    return { ...initial, execution_strategy: "planned", execution_effort: "complex", likelyFiles: all,
      strategy_reason: "OpenHands evidence identifies work requiring dependency-aware planning" };
  if (initial.execution_strategy === "stable") return {
    ...initial,
    likelyFiles: all,
    preciseTarget: editable.length === 1 ? editable[0] : undefined,
    strategy_reason: "OpenHands resolved the Stable workstream to evidence-backed files",
  };
  if (editable.length) return {
    execution_strategy: "direct",
    execution_effort: initial.execution_effort === "tiny" && editable.length === 1 ? "tiny" : "normal",
    strategy_reason: "OpenHands supplied evidence-backed implementation scope",
    likelyFiles: all,
    preciseTarget: editable.length === 1 ? editable[0] : undefined,
  };
  return { ...initial, likelyFiles: all, strategy_reason: "OpenHands did not establish editable repository evidence" };
}

export class OpenHandsExplorer implements RepositoryExplorer {
  constructor(private readonly gateway: Gateway, private readonly options: ExplorerOptions = {}) {}

  async explore(input: Parameters<RepositoryExplorer["explore"]>[0]) {
    const started = Date.now();
    const continuation = !!input.previousExploration;
    this.gateway.logger.log(continuation ? "repo_exploration_continuation" : "repo_exploration_start", {
      reason: input.continuationReason ?? null,
    });
    const subtask = {
      id: continuation ? "repository-exploration-continuation" : "repository-exploration",
      title: input.task,
      objective: input.task,
      dependsOn: [],
      likelyReadPaths: [],
      likelyWritePaths: [],
      readOnly: true as const,
      integrationContract: "Return read-only repository evidence",
      verificationCommands: [],
      estimatedDifficulty: "normal" as const,
      parallelSafe: false,
    };
    const features = extractFeatures(subtask, input.profile, 2_000);
    features.taskKind = "repository_exploration";
    const maxOutputTokens = Math.min(1_600, this.gateway.config.maxOutputTokens);
    const tokenCapacity = Math.min(
      12_000,
      this.gateway.config.stageMaxTokens,
      this.gateway.budget.availableTokens(this.gateway.config.phaseBudget.implementationReserveFraction),
    );
    const usdCapacity = Math.min(
      this.gateway.config.stageMaxUsd,
      this.gateway.config.budgetUsd * this.gateway.config.phaseBudget.discoveryMaxFraction,
      this.gateway.budget.availableUsd(this.gateway.config.phaseBudget.implementationReserveFraction),
    );
    if (tokenCapacity < 2_000 || usdCapacity <= 0)
      throw new OpenHandsOperationalError("OpenHands exploration budget is unavailable");
    let model = this.gateway.config.registry.SCOUT_MODEL;
    let inputPrice = this.gateway.config.maxInputPrice;
    let outputPrice = this.gateway.config.maxOutputPrice;
    let contextLength = this.gateway.config.maxTokens;
    if (this.gateway.modelRouter) {
      const selected = await this.gateway.modelRouter.select(features, subtask.id, [], undefined, false, undefined, {
        budgetUsd: usdCapacity,
        inputTokens: 2_000,
        outputTokens: maxOutputTokens,
      });
      model = selected.model.id;
      inputPrice = selected.metadata.inputPrice ?? inputPrice;
      outputPrice = selected.metadata.outputPrice ?? outputPrice;
      contextLength = selected.metadata.contextLength ?? contextLength;
    }
    // OpenHands exploration is iterative and may issue several model calls.
    // usdCapacity is already bounded by Koda's stage, discovery and global
    // implementation-reserve budgets, so reserve that cumulative capacity
    // instead of estimating exploration as a single LLM call.
    const budgetUsd = usdCapacity;
    if (budgetUsd <= 0) throw new OpenHandsOperationalError("Selected exploration model has no usable budget");
    const reserve = this.gateway.budget.reserve(budgetUsd, tokenCapacity);
    const provider = this.gateway.config.modelPool?.provider ?? "openrouter";
    const invocation: OpenHandsInvocation = {
      repoPath: input.repoPath,
      task: input.task,
      model,
      llmModel: provider === "openrouter" && !model.startsWith("openrouter/") ? `openrouter/${model}` : model,
      baseUrl: this.gateway.config.baseUrl,
      provider,
      budgetUsd,
      maxTokens: tokenCapacity,
      // OpenHands enforces a 16k context-window minimum. This is per-call
      // capacity; Koda's separate 12k reservation remains the cumulative run
      // budget and the bridge never preloads repository contents.
      maxInputTokens: Math.min(
        contextLength - maxOutputTokens,
        Math.max(16_384, tokenCapacity - maxOutputTokens),
      ),
      maxOutputTokens,
      // OpenHands is a fallback for genuinely uncertain work.
      // Bound exploration so it cannot consume the whole run.
      maxIterations: 6,

      maxFilesRead: Math.min(24, this.gateway.config.context.scanFiles),

      timeoutMs: Math.min(
        this.gateway.config.stageMaxMinutes * 60_000,
        this.gateway.budget.remainingMs(),
        30_000,
      ),

      requestTimeoutMs: this.gateway.config.modelTimeoutMs.inspection,
      inputCostPerToken: inputPrice / 1e6,
      outputCostPerToken: outputPrice / 1e6,
      previousExploration: input.previousExploration,
      continuationReason: input.continuationReason,
    };
    if (invocation.maxInputTokens < 16_384)
      throw new OpenHandsOperationalError("Selected exploration model context is below OpenHands' 16k minimum");
    const before = await snapshotTree(input.repoPath);
    const readOnlyCheckpoint = await AttemptCheckpoint.capture(
      input.repoPath,
      new WriteScope(["."], this.gateway.logger, subtask.id),
    );
    try {
      const report = this.options.runner
        ? await this.options.runner(invocation)
        : await defaultRunner(await (this.options.ensureRuntime ?? ensureOpenHandsRuntime)(), invocation);
      const after = await snapshotTree(input.repoPath);
      const mutations = changesBetween(before, after);
      if (mutations.length) {
        await readOnlyCheckpoint.restore(
          input.repoPath,
          new WriteScope(["."], this.gateway.logger, subtask.id),
        );
        throw new OpenHandsOperationalError(`OpenHands read-only violation: ${mutations.map(({ path }) => path).join(", ")}`, report.providerDispatched);
      }
      if (report.status !== "completed" || !report.result) {
        if (report.providerDispatched) reserve.settleUncertain(); else reserve.cancel();
        this.gateway.logger.log("repo_exploration_failure", {
          model, operational: true, provider_dispatched: report.providerDispatched,
          error: report.error ?? "OpenHands did not return structured evidence",
        });
        throw new OpenHandsOperationalError(report.error ?? "OpenHands exploration failed", report.providerDispatched);
      }
      const usage: Usage = {
        promptTokens: report.inputTokens,
        completionTokens: report.outputTokens,
        reasoningTokens: 0,
        cachedTokens: report.cachedInputTokens,
        cacheWriteTokens: report.cacheWriteTokens,
        costUsd: report.costUsd ?? null,
        raw: { prompt_tokens: report.inputTokens, completion_tokens: report.outputTokens },
      };
      reserve.settle(usage);
      const result = await validateExploration(input.repoPath, input.profile, report.result);
      this.gateway.logger.log("repo_exploration_finish", {
        model,
        sdk_version: report.sdkVersion,
        confidence: result.confidence,
        model_calls: report.modelCalls,
        tool_calls: report.toolCalls,
        files_inspected: report.filesInspected,
        editable_files: result.editableCandidates.map(({ path }) => path),
        readonly_files: result.readonlyFiles.map(({ path }) => path),
        related_tests: result.relatedTests,
        input_tokens: report.inputTokens,
        output_tokens: report.outputTokens,
        cost_usd: report.costUsd ?? null,
        wall_clock_ms: report.wallClockMs || Date.now() - started,
      });
      return result;
    } catch (error) {
      // A settled/cancelled reservation ignores duplicate settlement.
      if (error instanceof OpenHandsOperationalError && error.providerDispatched)
        reserve.settleUncertain();
      else reserve.cancel();
      if (!(error instanceof OpenHandsOperationalError))
        this.gateway.logger.log("repo_exploration_failure", { model, operational: true, error: String(error) });
      throw error instanceof OpenHandsOperationalError
        ? error
        : new OpenHandsOperationalError(`OpenHands infrastructure failure: ${String(error)}`);
    }
  }
}

export { OPENHANDS_SDK_VERSION };

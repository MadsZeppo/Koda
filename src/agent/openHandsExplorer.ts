import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { z } from "zod";

import type { Gateway } from "../openrouter/client.js";
import type { RepoProfile, Usage } from "../types.js";
import {
  explicitTaskPaths,
  requestsTestMutation,
  type ExecutionStrategy,
} from "../router/executionStrategy.js";
import { extractFeatures } from "../router/features.js";
import { snapshotTree, changesBetween } from "../workspace/files.js";
import { isSourcePath, isTestPath, taskTerms } from "../context/compiler.js";
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
    try {
      return fromBridge(JSON.parse(await readFile(reportPath, "utf8")));
    } catch {
      throw new OpenHandsOperationalError(
        `OpenHands bridge did not produce a valid report: ${processResult.stderr || processResult.stdout || `exit ${processResult.exitCode}`}`,
      );
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const normalizeRepoPath = (value: string) =>
  value.replaceAll("\\", "/").split("/").filter((part) => part && part !== ".").join("/");

export function fastPathExploration(
  task: string,
  profile: RepoProfile,
  strategy: ExecutionStrategy,
): RepositoryExploration | undefined {
  const exact = explicitTaskPaths(task, profile);
  const broad = /\b(?:across|multiple|multi[- ]component|throughout|entire|refactor|migrat|architecture|client and server|independent|parallel)\b/i.test(task);
  if (broad || exact.length < 1 || exact.length > 4 || strategy.execution_strategy !== "direct")
    return undefined;

  const changeTests = requestsTestMutation(task);
  const editablePaths = exact.filter((path) => !isTestPath(path) || changeTests);
  const relatedTests = exact.filter((path) => isTestPath(path) && !changeTests);
  if (!editablePaths.length) return undefined;

  return {
    confidence: "high",
    editableCandidates: editablePaths.map((path) => ({
      path,
      reason: isTestPath(path)
        ? "The task explicitly names this test file and explicitly requests test mutation."
        : "The task explicitly names this exact repository-relative file path.",
    })),
    readonlyFiles: [],
    relatedTests,
    dependencies: [],
    evidence: exact.map((path) => ({
      path,
      detail: profile.files.includes(path)
        ? "Exact path supplied by the user and validated against the repository profile."
        : "Exact new file path supplied by the user and validated as a safe repository-relative path.",
    })),
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
  const normalized = normalizeRepoPath(value);
  const parts = normalized.split("/");
  if (!normalized || parts.some((part) => part === "..") || parts[0] === ".git")
    throw new OpenHandsOperationalError(`OpenHands returned invalid repository path: ${value}`);
  if (!known.has(normalized) && !allowMissing)
    throw new OpenHandsOperationalError(`OpenHands returned unknown repository path: ${normalized}`);

  const canonicalRoot = await realpath(root);
  let candidate = join(root, normalized);
  try {
    await realpath(candidate);
  } catch {
    if (!allowMissing)
      throw new OpenHandsOperationalError(`OpenHands returned unknown repository path: ${normalized}`);
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
    throw new OpenHandsOperationalError(`OpenHands path escapes repository: ${normalized}`);
  return normalized;
}

async function validateExploration(
  root: string,
  profile: RepoProfile,
  task: string,
  raw: RepositoryExploration,
) {
  const known = new Set(profile.files);
  const explicit = new Set(explicitTaskPaths(task, profile));
  const editableCandidates: RepositoryExploration["editableCandidates"] = [];
  const seenEditable = new Set<string>();

  for (const item of raw.editableCandidates) {
    const normalized = normalizeRepoPath(item.path);
    const exists = known.has(normalized);
    const allowMissing = raw.confidence === "high" || explicit.has(normalized);
    if (!exists && !allowMissing) continue;
    const path = await validatePath(root, known, normalized, allowMissing);
    if (!seenEditable.has(path)) {
      editableCandidates.push({ path, reason: item.reason.slice(0, 600) });
      seenEditable.add(path);
    }
  }

  const authorized = new Set([...known, ...editableCandidates.map(({ path }) => path)]);
  const editable = new Set(editableCandidates.map(({ path }) => path));
  const validateAuthorizedPath = async (value: string) => {
    const normalized = normalizeRepoPath(value);
    if (!authorized.has(normalized))
      throw new OpenHandsOperationalError(`OpenHands returned unknown repository path: ${normalized}`);
    return validatePath(root, authorized, normalized, true);
  };

  const readonlyFiles: RepositoryExploration["readonlyFiles"] = [];
  const seenReadonly = new Set<string>();
  for (const item of raw.readonlyFiles) {
    const path = await validateAuthorizedPath(item.path);
    if (!editable.has(path) && !seenReadonly.has(path)) {
      readonlyFiles.push({ path, reason: item.reason.slice(0, 600) });
      seenReadonly.add(path);
    }
  }

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

export async function deterministicRepositoryExploration(
  root: string,
  task: string,
  profile: RepoProfile,
): Promise<RepositoryExploration> {
  const terms = taskTerms(task).filter((term) => term.length >= 3).slice(0, 20);
  const files = profile.files
    .filter((path) => (isSourcePath(path) || isTestPath(path)) && !/(?:^|\/)(?:node_modules|dist|build|coverage)(?:\/|$)/.test(path))
    .slice(0, 220);

  const ranked: { path: string; score: number; text: string }[] = [];
  for (const path of files) {
    let text = "";
    try {
      text = (await readFile(join(root, path), "utf8")).slice(0, 64_000).toLowerCase();
    } catch {
      continue;
    }
    const normalizedPath = path.toLowerCase().replace(/[^a-z0-9]+/g, " ");
    let score = 0;
    for (const term of terms) {
      const pieces = term.toLowerCase().split(/[^a-z0-9]+/).filter((piece) => piece.length >= 3);
      for (const piece of pieces) {
        if (normalizedPath.includes(piece)) score += 6;
        if (text.includes(piece)) score += 1;
      }
    }
    if (/planner|compiler|router|executor|worker|handler|service|controller|model/.test(normalizedPath)) score += 1;
    if (score > 0) ranked.push({ path, score, text });
  }
  ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const sources = ranked.filter((item) => isSourcePath(item.path) && !isTestPath(item.path));
  const top = sources[0];
  if (!top || top.score < 4) {
    return {
      confidence: "low",
      editableCandidates: [],
      readonlyFiles: [],
      relatedTests: [],
      dependencies: [],
      evidence: [],
      unresolvedQuestions: ["Local deterministic localization found no bounded implementation candidate."],
    };
  }

  const second = sources[1];
  const dominant = !second || top.score >= second.score + 3;
  const selected = dominant
    ? [top]
    : sources.filter((item) => item.score >= Math.max(4, Math.floor(top.score * 0.75))).slice(0, 3);
  const selectedStems = selected.map((item) =>
    item.path.split("/").pop()!.replace(/\.[^.]+$/, "").toLowerCase());

  const relatedTests = ranked
    .filter((item) => isTestPath(item.path))
    .filter((item) => selectedStems.some((stem) =>
      item.path.toLowerCase().includes(stem) || item.text.includes(stem)))
    .slice(0, 4)
    .map((item) => item.path);

  return {
    confidence: dominant ? "medium" : "low",
    editableCandidates: selected.map((item) => ({
      path: item.path,
      reason: `Local deterministic fallback ranked this existing source file highest for the task (score ${item.score}).`,
    })),
    readonlyFiles: [],
    relatedTests,
    dependencies: [],
    evidence: selected.map((item) => ({
      path: item.path,
      detail: `Existing-file lexical/path evidence score ${item.score}; no model call used.`,
    })),
    unresolvedQuestions: dominant ? [] : ["Several existing source files had similar local evidence scores."],
  };
}

export function strategyWithExploration(
  task: string,
  initial: ExecutionStrategy,
  exploration: RepositoryExploration,
): ExecutionStrategy {
  if (requestsTestMutation(task) && exploration.relatedTests.length) {
    const existing = new Set(exploration.editableCandidates.map(({ path }) => path));
    const promoted = exploration.relatedTests.filter((path) => !existing.has(path));
    exploration.editableCandidates = [
      ...exploration.editableCandidates,
      ...promoted.map((path) => ({
        path,
        reason: "The task explicitly requires test mutation and repository exploration identified this related test.",
      })),
    ];
    const promotedSet = new Set(promoted);
    exploration.relatedTests = exploration.relatedTests.filter((path) => !promotedSet.has(path));
  }

  const proposedEditable = exploration.editableCandidates.map(({ path }) => path);
  const editable = proposedEditable.filter((path) => isSourcePath(path) && !isTestPath(path));
  const all = [...new Set([
    ...proposedEditable,
    ...exploration.relatedTests,
    ...exploration.readonlyFiles.map(({ path }) => path),
  ])];

  if (initial.preciseTarget && proposedEditable.length === 1 && proposedEditable[0] === initial.preciseTarget && exploration.confidence === "high")
    return { ...initial, likelyFiles: all };
  const broad = /\b(?:across|multiple|multi[- ]component|throughout|entire|refactor|migrat|architecture|independent|parallel)\b/i.test(task);
  if (initial.execution_strategy === "planned" || broad || editable.length > 3)
    return {
      ...initial,
      execution_strategy: "planned",
      execution_effort: "complex",
      likelyFiles: all,
      strategy_reason: "Repository evidence identifies work requiring dependency-aware planning",
    };
  if (initial.execution_strategy === "stable") return {
    ...initial,
    likelyFiles: all,
    preciseTarget: proposedEditable.length === 1 && editable.length === 1 ? editable[0] : undefined,
    strategy_reason: "Repository exploration resolved the Stable workstream to evidence-backed files",
  };
  if (editable.length) return {
    execution_strategy: "direct",
    execution_effort: initial.execution_effort === "tiny" && proposedEditable.length === 1 && editable.length === 1 ? "tiny" : "normal",
    strategy_reason: "Repository exploration supplied evidence-backed implementation scope",
    likelyFiles: all,
    preciseTarget: proposedEditable.length === 1 && editable.length === 1 ? editable[0] : undefined,
  };
  return { ...initial, likelyFiles: all, strategy_reason: "Repository exploration did not establish editable repository evidence" };
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

    const reserve = this.gateway.budget.reserve(usdCapacity, tokenCapacity);
    const provider = this.gateway.config.modelPool?.provider ?? "openrouter";
    const invocation: OpenHandsInvocation = {
      repoPath: input.repoPath,
      task: input.task,
      model,
      llmModel: provider === "openrouter" && !model.startsWith("openrouter/") ? `openrouter/${model}` : model,
      baseUrl: this.gateway.config.baseUrl,
      provider,
      budgetUsd: usdCapacity,
      maxTokens: tokenCapacity,
      maxInputTokens: Math.min(
        contextLength - maxOutputTokens,
        Math.max(16_384, tokenCapacity - maxOutputTokens),
      ),
      maxOutputTokens,
      maxIterations: 12,
      maxFilesRead: Math.min(32, this.gateway.config.context.scanFiles),
      timeoutMs: Math.min(
        this.gateway.config.stageMaxMinutes * 60_000,
        this.gateway.budget.remainingMs(),
        90_000,
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
        throw new OpenHandsOperationalError(
          `OpenHands read-only violation: ${mutations.map(({ path }) => path).join(", ")}`,
          report.providerDispatched,
        );
      }
      if (report.status !== "completed" || !report.result)
        throw new OpenHandsOperationalError(
          report.error ?? "OpenHands exploration failed",
          report.providerDispatched,
        );

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
      const result = await validateExploration(input.repoPath, input.profile, input.task, report.result);
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
      if (error instanceof OpenHandsOperationalError && error.providerDispatched)
        reserve.settleUncertain();
      else reserve.cancel();

      this.gateway.logger.log("repo_exploration_failure", {
        model,
        operational: true,
        error: String(error),
      });

      // Injected runners are deterministic test seams and preserve the old
      // rejection contract. Production/default OpenHands gets a zero-credit,
      // existing-files-only localization fallback instead of write scope '.'.
      if (this.options.runner)
        throw error instanceof OpenHandsOperationalError
          ? error
          : new OpenHandsOperationalError(`OpenHands infrastructure failure: ${String(error)}`);

      const fallback = await deterministicRepositoryExploration(
        input.repoPath,
        input.task,
        input.profile,
      );
      this.gateway.logger.log("repo_exploration_local_fallback", {
        confidence: fallback.confidence,
        editable_files: fallback.editableCandidates.map(({ path }) => path),
        related_tests: fallback.relatedTests,
        model_calls: 0,
        cost_usd: 0,
        reason: String(error),
      });
      return fallback;
    }
  }
}

export { OPENHANDS_SDK_VERSION };

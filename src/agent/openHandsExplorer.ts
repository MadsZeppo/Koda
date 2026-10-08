import { mkdtemp, readFile, realpath, rm, writeFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { z } from "zod";
import { liteLLMTransport } from '../provider/transport.js';

import type { Gateway } from "../openrouter/client.js";
import type { RepoProfile, Usage } from "../types.js";
import {
  explicitTaskPaths,
  requestsTestMutation,
  type ExecutionStrategy,
} from "../router/executionStrategy.js";
import { extractFeatures } from "../router/features.js";
import { snapshotTree, changesBetween } from "../workspace/files.js";
import { isSourcePath, isTestPath, taskTerms, resolveImports } from "../context/compiler.js";
import { ensureOpenHandsRuntime, OPENHANDS_SDK_VERSION } from "./openHandsRuntime.js";
import { AttemptCheckpoint } from "./attemptCheckpoint.js";
import { WriteScope } from "../repo/writeScope.js";
import { explicitLiteralReplacement, isOnlyLocalizedCopyTask } from "./literalEdit.js";
import { broadVisualDesignTask, visualDesignTask } from "../router/taskFingerprint.js";

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
    const transport = liteLLMTransport(invocation.model, invocation.baseUrl, invocation.provider);
    await writeFile(requestPath, JSON.stringify({
      repo_path: invocation.repoPath,
      task: invocation.task,
      llm_model: transport.model,
      routed_model: invocation.model,
      provider_mode: transport.mode,
      base_url: transport.baseUrl,
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
    const processResult = await execa(python, [bridgePath, requestPath, reportPath], {
      cwd: invocation.repoPath,
      reject: false,
      timeout: invocation.timeoutMs,
      env: {
        OPENROUTER_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: process.env.LANG ?? "C.UTF-8",
        KODA_EXPLORER_API_KEY: transport.apiKey,
        OPENHANDS_SUPPRESS_BANNER: "1",
        LITELLM_LOCAL_MODEL_COST_MAP: "True",
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

const explicitWriteRestriction = (task: string) =>
  /\b(?:only|exclusively)\s+(?:modify|edit|change|write|touch)\b|\b(?:modify|edit|change|write|touch)\s+only\b|\b(?:do not|don.t|never)\s+(?:modify|edit|change|write|touch)\b|\bkun\s+(?:ændr|rediger|skriv|rør)\b|\b(?:ændr|rediger|skriv|rør)\s+kun\b|\b(?:ændr|rediger|skriv|rør)\s+ikke\b/i.test(task);

function requestedStaticUiRoutes(task: string) {
  const routes = new Set<string>();
  for (const clause of task.split(/[.!?;\n]+/)) {
    const creates = /\b(?:add|create|introduce|make|build)\b|\bnew\b|opret|tilføj|lav\s+en\s+ny/i.test(clause);
    const uiRoute = /\b(?:page|route|screen|view)\b|\b(?:side|rute|visning|routen|ruten)\b/i.test(clause);
    if (!creates || !uiRoute) continue;
    for (const match of clause.matchAll(/(?:^|[\s("'`])\/(?!\/)([A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)(?=$|[\s),"'`])/g))
      if (!match[1]!.startsWith("api/")) routes.add(`/${match[1]}`);
  }
  return [...routes];
}

function requestedApiRoutes(task: string) {
  const routes = new Set<string>();
  for (const clause of task.split(/[.!?;\n]+/)) {
    if (!/\b(?:add|create|introduce|implement|build|expose)\b|opret|tilføj|implement[eé]r|byg/i.test(clause) ||
        !/\b(?:api|endpoint|webhook|route)\b|rute|routen|ruten/i.test(clause)) continue;
    for (const match of clause.matchAll(/(?:^|[\s("'`])\/(api\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)(?=$|[\s),"'`])/g))
      routes.add(`/${match[1]}`);
  }
  return [...routes];
}

/** When the user requests a new page without naming its URL, derive one
 * bounded route from the page topic. A generic "new page" has no safe slug. */
function requestedTopicUiRoute(task: string) {
  const clauses = task.split(/[.!?;\n]+/).filter((part) =>
    /\b(?:new|ny)\b[^.;\n]{0,80}\b(?:page|side)\b|\b(?:create|add|build|make|opret|lav)\b[^.;\n]{0,80}\b(?:page|side)\b/i.test(part));
  if (clauses.length !== 1 || /\b(?:pages|sider)\b/i.test(clauses[0]!) ||
      [...clauses[0]!.matchAll(/\b(?:page|side)\b/gi)].length !== 1)
    return undefined;
  const clause = clauses[0]!;
  const before = clause.match(/\b(?:new|ny)\s+(.{2,70}?)\s+(?:page|side)\b/i)?.[1];
  const after = clause.match(/\b(?:page|side)\s+(?:about|om|where\s+(?:you\s+)?(?:write|explain)\s+about|hvor\s+(?:du\s+)?(?:skriver|fortæller)\s+om)\s+(.+)/i)?.[1];
  const topic = (before ?? after)?.split(/\b(?:and|og)\s+(?:add|link|update|tilføj|opdat|forbind)\b/i)[0]?.trim();
  if (!topic || /^(?:a|an|en|et|another|new|ny|real|rigtig)$/i.test(topic)) return undefined;
  const slug = topic.toLowerCase().replace(/æ/g, "ae").replace(/ø/g, "oe").replace(/å/g, "aa")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!slug || slug.length > 64 || !/[a-z]{3}/.test(slug)) return undefined;
  return `/${slug}`;
}

/** Navigation edits need the component that renders the existing menu, not a
 * source file that merely contains the words "link" or the new label. */
export function requestsNavigationMutation(task: string) {
  return task.split(/[.!?;\n]+/).some((clause) =>
    /\b(?:add|create|update|change|modify|edit|connect|wire|fix|replace|remove|link)\b|tilføj|ændr|opdat|forbind|fjern|l[æa]nk/i.test(clause) &&
    /\b(?:navigation|nav|menu|header)\b|navigations|menuen|headeren/i.test(clause));
}

export async function discoverExistingNavigationOwner(
  root: string,
  profile: RepoProfile,
): Promise<string | undefined> {
  const uiFiles = profile.files.filter((path) =>
    /\.(?:[jt]sx?|svelte|vue|html)$/i.test(path) && !isTestPath(path) &&
    !/(?:^|\/)(?:node_modules|dist|build|coverage)(?:\/|$)/.test(path)).slice(0, 300);
  const entries = uiFiles.filter((path) =>
    /(?:^|\/)(?:page|layout|app|index)\.[jt]sx?$/i.test(path));
  const entryImports = new Map<string, number>();
  const known = new Set(profile.files);
  for (const path of entries.slice(0, 24)) {
    try {
      const code = (await readFile(join(root,
        await validatePath(root, known, path)), "utf8")).slice(0, 32_000);
      const rootEntry = /^(?:src\/)?app\/(?:page|layout)\.[jt]sx?$|^(?:src\/)?pages\/index\.[jt]sx?$|^(?:src\/)?(?:App|app|index)\.[jt]sx?$/.test(path);
      const weight = rootEntry ? 8 : 2;
      for (const match of code.matchAll(/\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/g)) {
        const specifier = (match[1] ?? match[2]!).replace(/\.[cm]?[jt]sx?$/, "");
        entryImports.set(specifier, Math.max(entryImports.get(specifier) ?? 0, weight));
      }
      for (const imported of resolveImports(path, code, known)) {
        const stem = imported.replace(/\.[^.]+$/, "");
        entryImports.set(stem, Math.max(entryImports.get(stem) ?? 0, weight));
      }
    } catch { /* A disappearing file is not localization evidence. */ }
  }
  const owners: { path: string; score: number }[] = [];
  for (const path of uiFiles) {
    let code: string;
    try { code = (await readFile(join(root,
      await validatePath(root, known, path)), "utf8")).slice(0, 32_000); }
    catch { continue; }
    if (!/<nav(?:\s|>)|role=["']navigation["']|aria-label=["'][^"']*navig/i.test(code))
      continue;
    const stem = path.replace(/\.[^.]+$/, "");
    const importScore = [...entryImports].filter(([specifier]) =>
      specifier.length >= 8 && (stem === specifier ||
        stem.endsWith(specifier.replace(/^[@~]\//, "")) ||
        stem.endsWith(specifier.replace(/^@\//, "src/"))))
      .reduce((max, [, score]) => Math.max(max, score), 0);
    const score = 8 +
      (/(?:^|\/)(?:[^/]*(?:nav|header|menu)[^/]*)\.[jt]sx?$/i.test(path) ? 5 : 0) +
      importScore;
    owners.push({ path, score });
  }
  owners.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return owners[0] && owners[0].score >= 13 &&
    owners[0].score >= (owners[1]?.score ?? 0) + 4
    ? owners[0].path : undefined;
}

function appRouterRoots(profile: RepoProfile) {
  const roots = new Map<string, string>();
  for (const path of profile.files) {
    const match = path.match(/^(.*(?:^|\/)app)\/(page|layout)\.([cm]?[jt]sx?)$/);
    if (!match) continue;
    const root = match[1]!;
    const extension = match[3]!;
    if (match[2] === "page" || !roots.has(root)) roots.set(root, extension);
  }
  return roots;
}

function selectAppRouterRoot(
  roots: ReadonlyMap<string, string>,
  exploration: RepositoryExploration,
) {
  if (roots.size === 1) return [...roots.entries()][0];
  const evidencePaths = [
    ...exploration.editableCandidates.map(({ path }) => path),
    ...exploration.readonlyFiles.map(({ path }) => path),
    ...exploration.evidence.map(({ path }) => path),
  ];
  const ranked = [...roots.entries()].map(([root, extension]) => {
    const projectPrefix = root.replace(/(?:^|\/)src\/app$|(?:^|\/)app$/, "");
    const score = evidencePaths.reduce((total, path) => total +
      (path === root || path.startsWith(`${root}/`) ? 3
        : projectPrefix && (path === projectPrefix || path.startsWith(`${projectPrefix}/`)) ? 1 : 0), 0);
    return { root, extension, score };
  }).sort((left, right) => right.score - left.score);
  return ranked[0]!.score > 0 && ranked[0]!.score > (ranked[1]?.score ?? -1)
    ? [ranked[0]!.root, ranked[0]!.extension] as const
    : undefined;
}

/**
 * Turn an explicit new App Router page or API endpoint into a bounded initial write target
 * when the repository itself proves the Next.js App Router convention. This
 * runs after localization so the first coding attempt receives the required
 * new file; it never grants a broad directory or overrides a user restriction.
 */
export function withInferredFrameworkCreationTargets(
  task: string,
  profile: RepoProfile,
  exploration: RepositoryExploration,
): RepositoryExploration {
  if (!profile.ecosystem?.frameworks.includes("nextjs") ||
      exploration.editableCandidates.length >= 12)
    return exploration;
  const writeRestricted = explicitWriteRestriction(task);
  const selected = selectAppRouterRoot(appRouterRoots(profile), exploration);
  if (!selected) return exploration;
  const [root, extension] = selected;
  const additions: RepositoryExploration["editableCandidates"] = [];
  const readonlyAdditions: RepositoryExploration["readonlyFiles"] = [];
  const knownEditable = new Set(exploration.editableCandidates.map(({ path }) => path));
  const inferredApplicationPaths = new Set<string>();
  let inferredApiTarget: string | undefined;

  const apiRoutes = requestedApiRoutes(task);
  if (!writeRestricted && apiRoutes.length === 1) {
    const existingApiExtensions = new Set(profile.files.flatMap((path) => {
      const match = path.startsWith(`${root}/api/`)
        ? path.match(/\/route\.(ts|js)$/)
        : undefined;
      return match ? [match[1]!] : [];
    }));
    const routeExtension = existingApiExtensions.size === 1
      ? [...existingApiExtensions][0]
      : existingApiExtensions.size === 0
        ? (extension.startsWith("t") ? "ts" : "js")
        : undefined;
    if (routeExtension) {
      const target = posix.join(root, apiRoutes[0]!.slice(1), `route.${routeExtension}`);
      if (!profile.files.includes(target) && !knownEditable.has(target)) {
        inferredApiTarget = target;
        additions.push({
          path: target,
          reason: `The task explicitly requests the API endpoint ${apiRoutes[0]}; the repository proves the ${root}/api App Router convention.`,
        });
        knownEditable.add(target);
      }
    }
  }

  const globalUiChange = broadVisualDesignTask(task);
  const visualThemeChange = visualDesignTask(task);
  const globalStylesheet = posix.join(root, "globals.css");
  const rootPage = posix.join(root, `page.${extension}`);
  // Even a one-section color change is governed by the imported global CSS
  // cascade. Expose that stylesheet as context without authorizing a write
  // unless the task is app-wide or a later review proves a concrete blocker.
  if (visualThemeChange && (!globalUiChange || writeRestricted) &&
      profile.files.includes(globalStylesheet) &&
      !knownEditable.has(globalStylesheet) &&
      !exploration.readonlyFiles.some(({ path }) => path === globalStylesheet))
    readonlyAdditions.push({
      path: globalStylesheet,
      reason: "Global stylesheet governs the rendered visual result; read-only cascade evidence.",
    });
  if (!writeRestricted && globalUiChange && visualThemeChange && profile.files.includes(globalStylesheet)) {
    inferredApplicationPaths.add(globalStylesheet);
    if (!knownEditable.has(globalStylesheet)) {
      additions.push({
        path: globalStylesheet,
        reason: `The task explicitly requests a broad visual change and the existing App Router root imports the conventional ${globalStylesheet} stylesheet.`,
      });
      knownEditable.add(globalStylesheet);
    }
  }
  // Global theme variables do not override component-level utility classes or
  // inline colors. The rendered entry page is therefore part of the required
  // implementation contract for an app-wide visual change, rather than mere
  // readonly context. This prevents a variable-only diff from falsely claiming
  // that a hard-coded light UI was converted.
  if (!writeRestricted && globalUiChange && visualThemeChange && profile.files.includes(rootPage) &&
      !inferredApplicationPaths.has(rootPage)) {
    inferredApplicationPaths.add(rootPage);
    if (!knownEditable.has(rootPage)) {
      additions.push({
        path: rootPage,
        reason: `The task requests a broad visual change and the rendered App Router entry page ${rootPage} may contain component-level styles that override global theme variables.`,
      });
      knownEditable.add(rootPage);
    }
  }

  const explicitRoutes = requestedStaticUiRoutes(task);
  const routes = explicitRoutes.length ? explicitRoutes :
    [requestedTopicUiRoute(task)].filter((route): route is string => !!route);
  if (!writeRestricted && routes.length === 1) {
    const routePath = routes[0]!.slice(1);
    const target = posix.join(root, routePath, `page.${extension}`);
    if (!profile.files.includes(target) && !knownEditable.has(target)) additions.push({
      path: target,
      reason: explicitRoutes.length
        ? `The task explicitly requests the new static route ${routes[0]}; the repository proves the ${root}/page.${extension} App Router convention.`
        : `The task requests a new page about ${routes[0]}; the repository proves the ${root}/page.${extension} App Router convention.`,
    });
  }
  const boundedAdditions = additions.slice(0, 12 - exploration.editableCandidates.length);
  const existingEvidence = new Set(exploration.evidence.map(({ path, detail }) => `${path}\0${detail}`));
  const inferredEvidence = [...inferredApplicationPaths].map((path) => ({
    path,
    detail: path === globalStylesheet
      ? `Deterministically inferred from the broad visual requirement and existing Next.js global stylesheet ${globalStylesheet}.`
      : `Deterministically inferred from the broad visual requirement and rendered Next.js entry page ${rootPage}.`,
  })).filter(({ path, detail }) => !existingEvidence.has(`${path}\0${detail}`));
  if (!boundedAdditions.length && !inferredEvidence.length && !readonlyAdditions.length) return exploration;
  return repositoryExplorationSchema.parse({
    ...exploration,
    readonlyFiles: [...exploration.readonlyFiles, ...readonlyAdditions]
      .filter(({ path }) => !knownEditable.has(path)).slice(0, 16),
    editableCandidates: [
      ...exploration.editableCandidates,
      ...boundedAdditions,
    ],
    evidence: [
      ...exploration.evidence,
      ...boundedAdditions.filter(({ path }) => !inferredApplicationPaths.has(path)).map(({ path }) => ({
        path,
        detail: path === inferredApiTarget
          ? `Deterministically inferred from explicit API endpoint ${apiRoutes[0]} and the existing Next.js App Router root ${root}.`
          : explicitRoutes.length
          ? `Deterministically inferred from explicit route ${routes[0]} and the existing Next.js App Router root ${root}.`
          : `Deterministically inferred from the new page topic ${routes[0]} and the existing Next.js App Router root ${root}.`,
      })),
      ...inferredEvidence,
    ].slice(0, 24),
  });
}

/**
 * A model call cannot improve a scope that is already proved by repository
 * content plus an unambiguous framework convention. Keep this deliberately
 * narrow: ordinary behavioral work still goes through semantic exploration.
 */
export function modelFreeExplorationIsSufficient(
  exploration: RepositoryExploration,
  task?: string,
): boolean {
  const inferredApplicationPaths = new Set(exploration.evidence
    .filter(({ detail }) =>
      /deterministically inferred from the broad visual requirement/i.test(detail))
    .map(({ path }) => path));
  const completeApplicationConvention = !!task &&
    broadVisualDesignTask(task) &&
    inferredApplicationPaths.size > 0 &&
    exploration.editableCandidates.every(({ path }) => inferredApplicationPaths.has(path));
  const topicRoutePaths = new Set(exploration.evidence
    .filter(({ detail }) => /deterministically inferred from the new page topic/i.test(detail))
    .map(({ path }) => path));
  const navigationOwnerPaths = new Set(exploration.evidence
    .filter(({ detail }) => /existing rendered navigation owner proven/i.test(detail))
    .map(({ path }) => path));
  const completeTopicConvention = !!task && requestsNavigationMutation(task) &&
    topicRoutePaths.size === 1 && navigationOwnerPaths.size === 1 &&
    exploration.editableCandidates.every(({ path }) =>
      topicRoutePaths.has(path) || navigationOwnerPaths.has(path));

  if (
    (exploration.confidence === "low" && !completeApplicationConvention && !completeTopicConvention) ||
    (exploration.unresolvedQuestions.length && !completeApplicationConvention && !completeTopicConvention) ||
    exploration.editableCandidates.length < 1 ||
    exploration.editableCandidates.length > 4 ||
    exploration.editableCandidates.some(({ path }) => path === ".")
  ) return false;

  const details = exploration.evidence.map(({ detail }) => detail);
  return completeApplicationConvention || completeTopicConvention || details.some((detail) =>
    /deterministically inferred from explicit route/i.test(detail)) ||
    (details.some((detail) =>
      /deterministically inferred from the broad visual requirement/i.test(detail)) &&
      details.some((detail) => /exact quoted task literal/i.test(detail))) ||
    (!!task && isOnlyLocalizedCopyTask(task) &&
      exploration.editableCandidates.length === 1 &&
      details.some((detail) => /existing-file lexical\/path evidence score/i.test(detail)));
}

/**
 * Recognize a requested visual change whose scope is explicitly the complete
 * application/site. This is language-level intent detection only; callers
 * must still prove a framework-owned global stylesheet before granting write
 * scope or skipping semantic exploration.
 */
export function applicationWideVisualTask(task: string): boolean {
  const globalScope =
    /\b(?:whole|entire|all)\s+(?:app|application|site|website|ui|pages?)\b|\b(?:site|app)[- ]wide\b|\bglobal(?:ly)?\b[^.\n]{0,40}\b(?:ui|style|theme|color|background)\b|\b(?:hele\s+(?:appen|appens|sitet|websitet|hjemmesiden|sidens|ui)|alle\s+sider|på\s+tværs\s+af\s+(?:appen|sitet|hjemmesiden)|overalt)\b/i.test(task);
  return globalScope && visualDesignTask(task);
}

export function fastPathExploration(
  task: string,
  profile: RepoProfile,
  strategy: ExecutionStrategy,
): RepositoryExploration | undefined {
  const exact = explicitTaskPaths(task, profile);
  const broad = /\b(?:across|multiple|multi[- ]component|throughout|entire|refactor|migrat|architecture|client and server)\b/i.test(task);
  // Algorithmic complexity and independent invocations do not make an
  // explicitly named existing edit scope ambiguous. Keep new-file inference
  // and genuinely broad repository work on the discovery path.
  const existingScope = exact.length > 0 && exact.every(path => profile.files.includes(path));
  if (broad || exact.length < 1 || exact.length > 4 ||
      (strategy.execution_strategy !== "direct" &&
        (strategy.execution_strategy !== "stable" || !existingScope)))
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

/** Only bounded copy edits with a unique, actually-read UI target bypass exploration. */
export async function boundedTextEditExploration(
  root: string, task: string, profile: RepoProfile,
): Promise<RepositoryExploration | undefined> {
  const directories = [...new Set(profile.files.flatMap((path) => {
    const parts = path.split("/");
    return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
  }))];
  if (task.length > 1500 || explicitTaskPaths(task, profile).length ||
      explicitTaskPaths(task, { files: directories } as RepoProfile).length ||
      !simpleTextEdit(task)) return undefined;
  const header = /\b(?:header(?:en)?|navbar|navigation)\b|sidehoved/i.test(task);
  const home = /(?:\b(?:home(?:page)?|front[ -]page|landing page)\b|forsid)/i.test(task);
  const replacement = explicitLiteralReplacement(task);
  const literals = [...task.matchAll(/["'“‘]([^"'”’\n]{2,100})["'”’]/g)].map((match) => match[1]!);
  if (replacement) literals.push(replacement.oldLiteral);
  if (!literals.length) return undefined;
  const entries = profile.files.filter((path) => !isTestPath(path) &&
    /(?:^|\/)(?:app\/(?:\([^/]+\)\/)?page\.[jt]sx?|pages\/index\.[jt]sx?|routes\/(?:\+page\.svelte|_index\.[jt]sx?)|index\.html)$/.test(path));
  const candidates = header ? profile.files.filter(path => /(?:header|navbar|navigation|layout)\.[jt]sx?$/.test(path) && !isTestPath(path)) : home ? entries : profile.files.filter((path) => /\.(?:[jt]sx|svelte|vue|html)$/.test(path) && !isTestPath(path));
  // Do not turn a bounded local probe into another repository-wide read.
  if (!candidates.length || candidates.length > (home ? 4 : 12)) return undefined;
  const inspected: { path: string; text: string }[] = [];
  let bytes = 0;
  // Follow only aliases explicitly declared by this repository, never guess @/.
  let aliases: Record<string, string[]> = {};
  let aliasBase = ".";
  if (header) for (const configPath of ["tsconfig.json", "jsconfig.json"]) {
    if (!profile.files.includes(configPath)) continue;
    const safe = await validatePath(root, new Set(profile.files), configPath);
    if ((await stat(join(root, safe))).size > 16_000) continue;
    try {
      const parsed = JSON.parse(await readFile(join(root, safe), "utf8"));
      aliases = parsed.compilerOptions?.paths ?? {};
      aliasBase = parsed.compilerOptions?.baseUrl ?? ".";
      break;
    } catch { /* Unproven aliases do not authorize paths. */ }
  }
  const uiImports = (path: string, text: string) => {
    const dependencies = new Set(resolveImports(path, text, new Set(profile.files)));
    for (const match of text.matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)) {
      for (const [pattern, targets] of Object.entries(aliases)) {
        if (!Array.isArray(targets)) continue;
        const [prefix, suffix = ""] = pattern.split("*");
        const specifier = match[1]!;
        const wildcard = pattern.includes("*");
        if (wildcard ? !specifier.startsWith(prefix!) || !specifier.endsWith(suffix) : specifier !== pattern) continue;
        const captured = wildcard ? specifier.slice(prefix!.length, suffix ? -suffix.length : undefined) : "";
        for (const target of targets) {
          if (typeof target !== "string") continue;
          const relativeImport = posix.relative(posix.dirname(path), posix.join(aliasBase, target.replace("*", captured)));
          for (const dependency of resolveImports(path, `import "./${relativeImport}"`, new Set(profile.files))) dependencies.add(dependency);
        }
      }
    }
    return [...dependencies];
  };
  const queue = candidates.map(path => ({ path, depth: 0 }));
  const visited = new Set<string>();
  const headerOwners: string[] = [];
  for (const { path, depth } of queue) {
    if (visited.has(path)) continue;
    visited.add(path);
    if (visited.size > 12) return undefined;
    const safe = await validatePath(root, new Set(profile.files), path);
    const size = (await stat(join(root, safe))).size;
    if (size > 32_000 || bytes + size > 48_000) return undefined;
    bytes += size;
    const text = await readFile(join(root, safe), "utf8");
    if (header) {
      if (depth === 0 && !/<(?:header|nav)\b/.test(text)) continue;
      if (depth === 0) headerOwners.push(path);
      if (depth < 2) for (const dependency of uiImports(path, text)) {
        if (/\.(?:[jt]sx|svelte|vue|html)$/.test(dependency) && !isTestPath(dependency)) queue.push({ path: dependency, depth: depth + 1 });
      }
    }
    if (home && !header ? /<(?:button|a|[A-Za-z]*CTA)\b/.test(text)
      : literals.some((literal) => text.includes(literal))) inspected.push({ path, text });
  }
  if (inspected.length !== 1) return undefined;
  const target = inspected[0]!;
  const imports = [...new Set([...headerOwners.filter(path => path !== target.path), ...resolveImports(target.path, target.text, new Set(profile.files))])].slice(0, 3);
  return {
    confidence: "high",
    editableCandidates: [{ path: target.path, reason: "Unique repository UI entry/text target confirmed by a bounded real file read." }],
    readonlyFiles: imports.map((path) => ({ path, reason: "Direct UI dependency; context only, no write authorization." })),
    relatedTests: [], dependencies: [],
    evidence: [{ path: target.path, detail: "Bounded text-edit localization: unique UI target inspected locally; no model exploration required." }],
    unresolvedQuestions: [],
  };
}

function simpleTextEdit(task: string) {
  return (!!explicitLiteralReplacement(task) || /(?:\b(?:change|replace|update|rename|edit)\b|ændr|ret\s)/i.test(task)) &&
    /(?:\b(?:text|label|copy|caption|heading|title|button|header(?:en)?|navbar)\b|logo\w*|tekst|knap|overskrift)/i.test(task) &&
    !/(?:\b(?:add|implement|create|fix|debug|refactor|migrat\w*|authentication|security|database|logic|behavior|across|throughout|multiple|all pages)\b|tilføj|implement|funktionalitet|alle sider)/i.test(task) &&
    !requestsTestMutation(task);
}

const normalizeExplorationPath = (value: string) =>
  normalizeRepoPath(value.replace(/:\d+(?::\d+)?$/, ""));

async function validatePath(
  root: string,
  known: ReadonlySet<string>,
  value: string,
  allowMissing = false,
) {
  if (!value || value.includes("\0") || value.startsWith("/") || /^[A-Za-z]:\//.test(value))
    throw new OpenHandsOperationalError(`OpenHands returned invalid repository path: ${value}`);
  // Models commonly cite a repository location as `path:line[:column]`.
  // Treat the numeric suffix as evidence coordinates, never as part of the
  // file name or as write authorization for a different path.
  const normalized = normalizeExplorationPath(value);
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
    const normalized = normalizeExplorationPath(item.path);
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
    const normalized = normalizeExplorationPath(value);
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

/** Positive mutation clauses only; readonly/preserve mentions are not authorization. */
export function explicitMutationPaths(task: string, profile: RepoProfile) {
  return [...new Set(task.split(/(?<=[.!?])\s+|[;\n]+/).flatMap(clause => {
    if (/\b(?:do not|never|don't|preserve|read[- ]?only|bevar)\b/i.test(clause)) return [];
    if (!/\b(?:modify|edit|change|update|create|add|delete|remove|ret|ændr|opret|tilføj)\b/i.test(clause)) return [];
    return explicitTaskPaths(clause, profile).filter(path => profile.files.includes(path) && (isSourcePath(path) || isTestPath(path)));
  }))];
}

export async function deterministicRepositoryExploration(
  root: string,
  task: string,
  profile: RepoProfile,
  preferredPaths: readonly string[] = [],
): Promise<RepositoryExploration> {
  const terms = taskTerms(task).filter((term) => term.length >= 3).slice(0, 20);
  const exactLiterals = [...new Set(
    [...task.matchAll(/["'“‘]([^"'”’\n]{3,120})["'”’]/g)]
      .map((match) => match[1]!.toLowerCase()),
  )];
  const preferred = new Set(preferredPaths.map(normalizeRepoPath));
  const explicitlyRequested = new Set(explicitTaskPaths(task, profile));
  const mutationTargets = explicitMutationPaths(task, profile);
  const files = profile.files
    .filter((path) => (isSourcePath(path) || isTestPath(path)) && !/(?:^|\/)(?:node_modules|dist|build|coverage)(?:\/|$)/.test(path))
    .slice(0, 220);

  const known = new Set(profile.files);
  const imported = new Set<string>();
  const ranked: { path: string; score: number; text: string }[] = [];
  for (const path of files) {
    let text = "";
    try {
      text = (await readFile(join(root, path), "utf8")).slice(0, 64_000);
      for (const dependency of resolveImports(path, text, known)) imported.add(dependency);
      text = text.toLowerCase();
    } catch {
      continue;
    }
    const normalizedPath = path.toLowerCase().replace(/[^a-z0-9]+/g, " ");
    let score = preferred.has(path) ? 3 : 0;
    for (const term of terms) {
      const pieces = term.toLowerCase().split(/[^a-z0-9]+/).filter((piece) => piece.length >= 3);
      for (const piece of pieces) {
        if (normalizedPath.includes(piece)) score += 6;
        if (text.includes(piece)) score += 1;
      }
    }
    // Exact UI labels, command names and symbols quoted by the user are much
    // stronger localization evidence than ordinary prose terms.
    for (const literal of exactLiterals)
      if (text.includes(literal)) score += 10;
    if (/planner|compiler|router|executor|worker|handler|service|controller|model/.test(normalizedPath)) score += 1;
    if (score > 0) ranked.push({ path, score, text });
  }
  ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const allSources = ranked.filter((item) => isSourcePath(item.path) && !isTestPath(item.path));
  const backedSources = allSources.filter((item) => imported.has(item.path) || explicitlyRequested.has(item.path));
  // Existing runtime/test imports are stronger implementation evidence than
  // filenames of standalone scripts containing copied source or patch text.
  // Standalone/empty repositories keep the lexical fallback.
  const sources = backedSources.some((item) => item.score >= 4) ? backedSources : allSources;
  // A focused existing test is executable localization evidence. Follow its
  // runtime imports rather than letting generic words select large callers.
  const testAnchors = ranked.filter((item) => isTestPath(item.path)).map((item) => {
    const name = item.path.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
    return { item, matches: terms.filter((term) => name.includes(term)).length };
  }).filter(({ matches }) => matches >= 2).sort((a, b) => b.matches - a.matches);
  const anchor = testAnchors[0]?.item;
  if (anchor) {
    const code = (await readFile(join(root, anchor.path), "utf8")).replace(/import\s+type\b[\s\S]*?;/g, "");
    const staticCode = code.replace(/\bimport\s*\([^)]*\)/g, "");
    const staticDependencies = resolveImports(anchor.path, staticCode, known);
    const dependencies = new Set(staticDependencies.length ? staticDependencies : resolveImports(anchor.path, code, known));
    const owners = allSources.filter((item) => dependencies.has(item.path) || explicitlyRequested.has(item.path));
    if (owners.length && owners.length <= 3) {
      sources.splice(0, sources.length, ...owners);
    }
  }
  const navigationOwner = requestsNavigationMutation(task) && !explicitWriteRestriction(task)
    ? await discoverExistingNavigationOwner(root, profile) : undefined;
  const top = sources[0];
  if ((!top || top.score < 4) && !navigationOwner && !mutationTargets.length) {
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
  const dominant = !!navigationOwner || !second || (!!top && top.score >= second.score + 3);
  const lexicalSelected = navigationOwner
    ? []
    : dominant
      ? (top ? [top] : [])
      : sources.filter((item) => item.score >= Math.max(4, Math.floor(top!.score * 0.75))).slice(0, 3);
  // Separate quoted UI labels/content often live in separate route and
  // navigation components. Retain one repository-backed owner for each exact
  // literal so a dominant route match cannot hide the navigation owner.
  const literalOwners = exactLiterals.flatMap((literal) =>
    allSources
      .filter((item) => item.text.includes(literal))
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
      .slice(0, 2)
      .map((item) => ({ item, literal })));
  const inferredSelected = [...new Map([
    ...(navigationOwner ? [[navigationOwner, {
      path: navigationOwner, score: 20,
      text: ranked.find((item) => item.path === navigationOwner)?.text ?? "",
    }] as const] : []),
    ...lexicalSelected.map((item) => [item.path, item] as const),
    ...literalOwners.map(({ item }) => [item.path, item] as const),
  ]).values()].slice(0, 4);
  // Explicit edits survive ranking caps and discovery failures. A write restriction
  // prevents inferred owners from expanding the authorized set.
  const selected = [...new Map([
    ...mutationTargets.map(path => [path, {path, score:20, text:ranked.find(item=>item.path===path)?.text ?? ""}] as const),
    ...(explicitWriteRestriction(task) ? [] : inferredSelected.map(item=>[item.path,item] as const)),
  ]).values()];
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
      reason: item.path === navigationOwner
        ? "This existing component renders the navigation requested by the task."
        : `Local deterministic fallback ranked this existing source file highest for the task (score ${item.score}).`,
    })),
    readonlyFiles: [],
    relatedTests,
    dependencies: [],
    evidence: [
      ...selected.map((item) => ({
        path: item.path,
        detail: `Existing-file lexical/path evidence score ${item.score}; no model call used.`,
      })),
      ...literalOwners.map(({ item, literal }) => ({
        path: item.path,
        detail: `Repository content proves this file owns the exact quoted task literal ${JSON.stringify(literal)}; no model call used.`,
      })),
      ...(navigationOwner ? [{
        path: navigationOwner,
        detail: "Existing rendered navigation owner proven by repository markup and entry imports; no model call used.",
      }] : []),
    ].slice(0, 24),
    unresolvedQuestions: dominant ? [] : ["Several existing source files had similar local evidence scores."],
  };
}

export function strategyWithExploration(
  task: string,
  initial: ExecutionStrategy,
  exploration: RepositoryExploration,
): ExecutionStrategy {
  const explorationAlreadyOwnsTest = exploration.editableCandidates.some(
    ({ path }) => isTestPath(path),
  );
  if (
    requestsTestMutation(task) &&
    exploration.relatedTests.length &&
    !explorationAlreadyOwnsTest
  ) {
    const existing = new Set(exploration.editableCandidates.map(({ path }) => path));
    const promoted = exploration.relatedTests.filter((path) => !existing.has(path) &&
      explicitTaskPaths(task, { files: exploration.relatedTests } as RepoProfile).includes(path));
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
    return { ...initial, likelyFiles: all,
      execution_effort: simpleTextEdit(task) ? "tiny" : initial.execution_effort };
  if (
    (initial.execution_strategy === "stable" || initial.execution_strategy === "planned") &&
    exploration.confidence === "high" &&
    broadVisualDesignTask(task) &&
    proposedEditable.length > 0 &&
    proposedEditable.length <= 4 &&
    proposedEditable.every((path) => path !== ".")
  ) return {
    execution_strategy: "direct",
    execution_effort: "normal",
    strategy_reason: "Repository and framework evidence fully bounded the broad visual change",
    likelyFiles: all,
  };
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
    execution_effort: (initial.execution_effort === "tiny" ||
      (exploration.confidence === "high" && simpleTextEdit(task))) && proposedEditable.length === 1 && editable.length === 1 ? "tiny" : "normal",
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
        16_384,
      ),
      maxOutputTokens,
      // Exploration establishes scope; it must not become a second coding
      // agent. Six turns are enough for list/search/read/imports/submit while
      // preserving the majority of run time and tokens for implementation,
      // review and verification.
      maxIterations: 6,
      maxFilesRead: Math.min(16, this.gateway.config.context.scanFiles),
      timeoutMs: Math.min(
        this.gateway.config.stageMaxMinutes * 60_000,
        this.gateway.budget.remainingMs(),
        45_000,
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
      let result = await validateExploration(input.repoPath, input.profile, input.task, report.result);

      if (!result.editableCandidates.length) {
        const fallback = await deterministicRepositoryExploration(
          input.repoPath,
          input.task,
          input.profile,
          report.filesInspected,
        );
        this.gateway.logger.log("repo_exploration_local_fallback", {
          confidence: fallback.confidence,
          editable_files: fallback.editableCandidates.map(({ path }) => path),
          related_tests: fallback.relatedTests,
          model_calls: 0,
          cost_usd: 0,
          reason: "OpenHands completed without an editable implementation scope",
        });
        if (fallback.editableCandidates.length) {
          result = {
            ...fallback,
            unresolvedQuestions: [...new Set([
              ...fallback.unresolvedQuestions,
              ...result.unresolvedQuestions,
            ])].slice(0, 12),
          };
        }
      }

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

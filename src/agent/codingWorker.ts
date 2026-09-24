export interface CodingWorkerContext {
  localizationSummary?: string;
  relevantFiles?: string[];
  sourceFiles?: { path: string; snippet: string }[];
  completePaths?: string[];
  diagnostics?: string;
  previousFailedDiff?: string;
  /** Bounded, repository-derived evidence supporting the selected mutation scope. */
  evidence?: unknown;
  /** Stable's bounded localization packet. mini-SWE may use it as implementation context. */
  repairPacket?: unknown;
}

export interface CodingWorkerInput {
  repoPath: string;
  attemptId: string;
  task: string;
  model: string;
  budgetUsd: number;
  maxTokens: number;
  maxSteps: number;
  timeoutMs: number;
  requestTimeoutMs: number;
  commandTimeoutMs: number;
  maxOutputTokens: number;
  maxToolOutputBytes?: number;
  contextWindowTokens?: number;
  /** Catalog prices used to enforce the attempt budget before each model call. */
  promptPricePerMillion?: number;
  completionPricePerMillion?: number;
  baseUrl: string;
  /** Stable OpenRouter affinity key for every turn inside this worker. */
  sessionId?: string;
  codingRoute?: { tier: "low" | "medium" | "high"; reason: string; attempt: number };
  writeScope: string[];
  directFullScope?: boolean;
  /** Localized attempts hand the first real mutation back to Koda for verification. */
  returnOnMutation?: boolean;
  context?: CodingWorkerContext;
}

export interface CodingWorkerResult {
  exitStatus: "completed" | "failed" | "infra_failure";
  model: string;
  engine: "mini-swe-agent";
  engineVersion: string;
  trajectoryPath?: string;
  changedPaths: string[];
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  timeToFirstMutationMs?: number;
  wallClockMs: number;
  stdout?: string;
  stderr?: string;
  terminationReason?: string;
  limitKind?: import("./attemptPolicy.js").AttemptLimitKind;
  /** Authoritative whole-attempt token ledger reported by the worker. */
  configuredTokenLimit?: number;
  consumedTokens?: number;
  remainingTokens?: number;
  exactLimitFired?: string;
  progressPhase?: import("./attemptPolicy.js").AttemptProgressPhase;
  steps?: number;
  fatalError?: string;
}

export interface CodingWorker {
  run(input: CodingWorkerInput): Promise<CodingWorkerResult>;
}

export interface CodingWorkerContext {
  localizationSummary?: string;
  /** Continue a localized attempt after an execution limit without rediscovery. */
  implementationRecovery?: { reason: string };
  relevantFiles?: string[];
  sourceFiles?: { path: string; snippet: string }[];
  completePaths?: string[];
  diagnostics?: string;
  previousFailedDiff?: string;
  /** Bounded, repository-derived evidence supporting the selected mutation scope. */
  evidence?: unknown;
  /** Stable's bounded repair packet, supplied as implementation context. */
  repairPacket?: unknown;
  /** A rejected completion review must be repaired before any new discovery. */
  completionRepair?: {
    unresolvedRequirementIds: string[];
    mutationRequiredBeforeDiscovery: boolean;
  };
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
  aiderEditFormat?: "diff" | "whole";
  /**
   * Context-admission result for Aider.
   * When present, Aider must attach exactly these already-budgeted files.
   */
  aiderFiles?: {
    editable: string[];
    readOnly: string[];
  };
  autoRouter?: import("../router/openRouterAutoPolicy.js").AutoRequestSettings;
  modelMetadata?: import("../router/pool.js").Metadata;
}

export interface CodingWorkerResult {
  exitStatus: "completed" | "failed" | "infra_failure";
  model: string;
  engine: "aider" | "direct-edit" | "agentic";
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
  /** Bounded tool-derived state used to resume productive discovery. */
  discoveryEvidence?: string;
  discoveryProgress?: number;
  fatalError?: string;
  editFormat?: string;
  formatAttempts?: {
    format: string;
    exitCode: number;
    mutation: boolean;
    wallClockMs: number;
    changedPaths: string[];
    failureKind?: string;
  }[];
}

export interface CodingWorker {
  /** Stable engine identity for telemetry before the first result exists. */
  readonly engine?: CodingWorkerResult["engine"];
  run(input: CodingWorkerInput): Promise<CodingWorkerResult>;
}

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
  commandTimeoutMs: number;
  maxOutputTokens: number;
  baseUrl: string;
  codingRoute?: { tier: "low" | "medium" | "high"; reason: string; attempt: number };
  writeScope: string[];
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
  wallClockMs: number;
  stdout?: string;
  stderr?: string;
  terminationReason?: string;
  fatalError?: string;
}

export interface CodingWorker {
  run(input: CodingWorkerInput): Promise<CodingWorkerResult>;
}

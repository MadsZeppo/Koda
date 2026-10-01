#!/usr/bin/env python3
from __future__ import annotations

import re
import shutil
import subprocess
from datetime import datetime
from pathlib import Path


ROOT = Path("/Users/madsflyvholm/Desktop/Koda.ai").resolve()

CODING_WORKER = ROOT / "src/agent/codingWorker.ts"
AIDER_EXECUTOR = ROOT / "src/agent/aiderExecutor.ts"
CODING_EXECUTOR = ROOT / "src/agent/codingExecutor.ts"

HANDOFF_PLANNER = ROOT / "src/agent/handoffPlanner.ts"
AGENTIC_WORKER = ROOT / "src/agent/agenticCodingWorker.ts"

HANDOFF_TEST = ROOT / "tests/handoffPlanner.test.ts"
AGENTIC_TEST = ROOT / "tests/agenticCodingWorker.test.ts"

EXISTING = [
    CODING_WORKER,
    AIDER_EXECUTOR,
    CODING_EXECUTOR,
]

for path in EXISTING:
    if not path.exists():
        raise SystemExit(f"Missing expected file: {path}")

texts = {path: path.read_text() for path in EXISTING}


def stop(message: str) -> None:
    raise SystemExit(f"\nSTOPPED BEFORE WRITING.\n{message}\n")


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    text = texts[path]
    if new in text and old not in text:
        print(f"[already] {label}")
        return

    count = text.count(old)
    if count != 1:
        stop(
            f"{label}\n"
            f"Expected exactly 1 match in {path}, found {count}."
        )

    texts[path] = text.replace(old, new, 1)
    print(f"[patch] {label}")


def replace_regex_once(
    path: Path,
    pattern: str,
    replacement: str,
    label: str,
    flags: int = re.S,
) -> None:
    text = texts[path]
    matches = list(re.finditer(pattern, text, flags))
    if len(matches) != 1:
        stop(
            f"{label}\n"
            f"Expected exactly 1 regex match in {path}, found {len(matches)}."
        )
    match = matches[0]
    texts[path] = text[:match.start()] + replacement + text[match.end():]
    print(f"[patch] {label}")


def insert_after_once(
    path: Path,
    marker: str,
    addition: str,
    unique: str,
    label: str,
) -> None:
    text = texts[path]
    if unique in text:
        print(f"[already] {label}")
        return

    count = text.count(marker)
    if count != 1:
        stop(
            f"{label}\n"
            f"Expected exactly 1 marker in {path}, found {count}."
        )

    texts[path] = text.replace(marker, marker + addition, 1)
    print(f"[patch] {label}")


# ============================================================
# NEW: src/agent/handoffPlanner.ts
# ============================================================

handoff_planner = r'''import { lstat } from "node:fs/promises";
import { join } from "node:path";

import type { CodingWorkerContext } from "./codingWorker.js";

export type CodingHandoffMode = "direct" | "aider" | "agentic";

export interface CodingHandoffPlan {
  mode: CodingHandoffMode;
  estimatedPromptBytes: number;
  reason: string;
  aiderFiles?: {
    editable: string[];
    readOnly: string[];
  };
}

export interface CodingHandoffInput {
  repoPath: string;
  task: string;
  writeScope: readonly string[];
  context?: CodingWorkerContext;

  /** Whole-attempt Koda token capacity. */
  attemptTokenCapacity: number;

  /** Per-provider-call context capacity. */
  modelContextTokens?: number;

  maxOutputTokens: number;

  /** Whole-attempt dollar capacity. */
  costCapacityUsd: number;

  promptPricePerMillion?: number;
  completionPricePerMillion?: number;

  /**
   * True only when Koda has already established that one concrete target is
   * sufficiently localized for DirectEdit.
   */
  directEditEligible: boolean;
}

const AIDER_FRAMING_RESERVE_TOKENS = 4_096;
const TOKEN_ESTIMATE_SAFETY = 1.4;
const PER_FILE_FRAMING_BYTES = 512;

function normalized(path: string) {
  const value = path.trim().replaceAll("\\", "/");

  if (
    !value ||
    value.startsWith("/") ||
    value.includes("\0") ||
    /[*?\[\]]/.test(value) ||
    value.split("/").some(
      (part) =>
        part === ".." ||
        part === ".git" ||
        part === ".koda",
    )
  ) {
    return undefined;
  }

  return value
    .split("/")
    .filter((part) => part && part !== ".")
    .join("/") || ".";
}

function evidenceFiles(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];

  const files = (value as {
    relevantFiles?: unknown;
  }).relevantFiles;

  return Array.isArray(files)
    ? files.filter(
        (entry): entry is string =>
          typeof entry === "string",
      )
    : [];
}

function compactPromptBytes(
  task: string,
  context?: CodingWorkerContext,
) {
  const summary = [
    task,
    context?.localizationSummary ?? "",
    context?.diagnostics?.slice(0, 4_000) ?? "",
    context?.previousFailedDiff?.slice(0, 4_000) ?? "",
    JSON.stringify({
      relevantFiles:
        context?.relevantFiles ?? [],
      completePaths:
        context?.completePaths ?? [],
      evidenceFiles:
        evidenceFiles(context?.evidence),
    }),
  ].join("\n");

  return (
    Buffer.byteLength(summary) +
    1_024
  );
}

function safeTokenEstimate(bytes: number) {
  return Math.max(
    1,
    Math.ceil(
      (bytes / 4) *
        TOKEN_ESTIMATE_SAFETY,
    ),
  );
}

async function inspectPath(
  root: string,
  path: string,
) {
  try {
    const info = await lstat(
      join(root, path),
    );

    return {
      exists: true as const,
      file: info.isFile(),
      directory: info.isDirectory(),
      size: info.size,
      hardlinked:
        info.isFile() &&
        info.nlink > 1,
    };
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return {
        exists: false as const,
        file: false,
        directory: false,
        size: 0,
        hardlinked: false,
      };
    }

    throw error;
  }
}

function filePromptTokens(
  path: string,
  size: number,
) {
  return safeTokenEstimate(
    size +
      Buffer.byteLength(path) +
      PER_FILE_FRAMING_BYTES,
  );
}

function uniqueSafe(
  values: readonly string[],
) {
  return [
    ...new Set(
      values
        .map(normalized)
        .filter(
          (value): value is string =>
            !!value,
        ),
    ),
  ];
}

function readonlyCandidates(
  input: CodingHandoffInput,
  editable: ReadonlySet<string>,
) {
  const context = input.context;

  const ordered = uniqueSafe([
    ...(context?.completePaths ?? []),
    ...evidenceFiles(context?.evidence),
    ...(context?.relevantFiles ?? []),
    ...(context?.sourceFiles ?? []).map(
      (file) => file.path,
    ),
  ]);

  return ordered.filter(
    (path) =>
      path !== "." &&
      !editable.has(path),
  );
}

function maxPromptTokensByCost(
  input: CodingHandoffInput,
  outputReserveTokens: number,
) {
  const inputPrice =
    input.promptPricePerMillion;
  const outputPrice =
    input.completionPricePerMillion;

  if (
    inputPrice === undefined ||
    outputPrice === undefined
  ) {
    return Infinity;
  }

  const outputCost =
    outputReserveTokens *
    outputPrice /
    1e6;

  const available =
    input.costCapacityUsd -
    outputCost;

  if (available <= 0) return 0;

  if (inputPrice === 0) {
    return Infinity;
  }

  return Math.max(
    0,
    Math.floor(
      available *
        1e6 /
        inputPrice,
    ),
  );
}

/**
 * Deterministically decides how coding context is admitted.
 *
 * Key invariant:
 * repo size is never allowed to become provider prompt size by accident.
 *
 * - Aider gets complete existing editable files only when they fit.
 * - Read-only files are admitted in relevance order while budget remains.
 * - A large localized single target may use DirectEdit, which sends bounded
 *   excerpts rather than the complete file.
 * - Broad, missing, directory-scoped or oversized work becomes agentic and
 *   retrieves context progressively through search/read tools.
 */
export async function planCodingHandoff(
  input: CodingHandoffInput,
): Promise<CodingHandoffPlan> {
  const capacity = Math.max(
    0,
    Math.min(
      input.attemptTokenCapacity,
      input.modelContextTokens ??
        Infinity,
    ),
  );

  const outputReserve = Math.min(
    input.maxOutputTokens,
    Math.max(
      768,
      Math.floor(
        Math.min(
          capacity,
          16_000,
        ) * 0.2,
      ),
    ),
  );

  const costPromptCapacity =
    maxPromptTokensByCost(
      input,
      outputReserve,
    );

  const admittedPromptTokens =
    Math.max(
      0,
      Math.min(
        capacity -
          outputReserve -
          AIDER_FRAMING_RESERVE_TOKENS,
        costPromptCapacity -
          AIDER_FRAMING_RESERVE_TOKENS,
      ),
    );

  const compactBytes =
    compactPromptBytes(
      input.task,
      input.context,
    );

  const compactTokens =
    safeTokenEstimate(
      compactBytes,
    );

  const scope = uniqueSafe(
    input.writeScope,
  );

  if (
    !scope.length ||
    scope.includes(".")
  ) {
    return {
      mode: "agentic",
      estimatedPromptBytes:
        compactTokens * 4,
      reason:
        "broad or unresolved write scope requires progressive repository reads",
    };
  }

  const inspected =
    await Promise.all(
      scope.map(async (path) => ({
        path,
        info:
          await inspectPath(
            input.repoPath,
            path,
          ),
      })),
    );

  const unsafeTarget =
    inspected.find(
      ({ info }) =>
        info.hardlinked,
    );

  if (unsafeTarget) {
    return {
      mode: "agentic",
      estimatedPromptBytes:
        compactTokens * 4,
      reason:
        `target ${unsafeTarget.path} cannot be admitted as a normal full-file handoff`,
    };
  }

  const directoryTarget =
    inspected.find(
      ({ info }) =>
        info.directory,
    );

  if (directoryTarget) {
    return {
      mode: "agentic",
      estimatedPromptBytes:
        compactTokens * 4,
      reason:
        "directory-level write scope requires progressive file selection",
    };
  }

  const missing =
    inspected.filter(
      ({ info }) =>
        !info.exists,
    );

  if (missing.length) {
    if (
      scope.length === 1 &&
      input.directEditEligible
    ) {
      return {
        mode: "direct",
        estimatedPromptBytes:
          compactTokens * 4,
        reason:
          "one localized missing target can be safely created by DirectEdit",
      };
    }

    return {
      mode: "agentic",
      estimatedPromptBytes:
        compactTokens * 4,
      reason:
        "new or unresolved multi-file targets require progressive create-capable execution",
    };
  }

  const editableTokens =
    inspected.reduce(
      (sum, { path, info }) =>
        sum +
        filePromptTokens(
          path,
          info.size,
        ),
      compactTokens,
    );

  if (
    editableTokens >
    admittedPromptTokens
  ) {
    if (
      scope.length === 1 &&
      input.directEditEligible
    ) {
      return {
        mode: "direct",
        estimatedPromptBytes:
          compactTokens * 4,
        reason:
          "localized target is too large for a complete Aider handoff; DirectEdit will use bounded excerpts",
      };
    }

    return {
      mode: "agentic",
      estimatedPromptBytes:
        compactTokens * 4,
      reason:
        "complete editable scope exceeds the admitted provider input budget",
    };
  }

  const editable =
    inspected.map(
      ({ path }) => path,
    );

  const editableSet =
    new Set(editable);

  const readOnly: string[] = [];
  let totalTokens =
    editableTokens;

  for (
    const candidate
    of readonlyCandidates(
      input,
      editableSet,
    )
  ) {
    const info =
      await inspectPath(
        input.repoPath,
        candidate,
      );

    if (
      !info.exists ||
      !info.file ||
      info.hardlinked
    ) {
      continue;
    }

    const tokens =
      filePromptTokens(
        candidate,
        info.size,
      );

    if (
      totalTokens + tokens >
      admittedPromptTokens
    ) {
      continue;
    }

    readOnly.push(candidate);
    totalTokens += tokens;
  }

  return {
    mode: "aider",
    estimatedPromptBytes:
      totalTokens * 4,
    aiderFiles: {
      editable,
      readOnly,
    },
    reason:
      readOnly.length
        ? "complete editable scope plus highest-value read-only evidence fits the budget"
        : "complete editable scope fits; secondary context will be retrieved only if needed",
  };
}
'''

# ============================================================
# NEW: src/agent/agenticCodingWorker.ts
# ============================================================

agentic_worker = r'''import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

import type { Budget } from "../openrouter/usage.js";
import {
  estimateUsageCost,
  parseUsage,
} from "../openrouter/usage.js";
import type { Usage } from "../types.js";
import type { Logger } from "../telemetry/logger.js";

import {
  AgentTools,
  toolDefinitions,
} from "./tools.js";
import { WriteScope } from "../repo/writeScope.js";
import { AttemptCheckpoint } from "./attemptCheckpoint.js";

import type {
  CodingWorker,
  CodingWorkerInput,
  CodingWorkerResult,
} from "./codingWorker.js";

export const AGENTIC_CODING_VERSION = "1";

export interface AgenticCodingResponse {
  model: string;
  usage: unknown;
  message: {
    content?: string | null;
    tool_calls?: Array<{
      id: string;
      type: string;
      function: {
        name: string;
        arguments: string;
      };
    }>;
  };
}

export type AgenticCodingRequester = (
  input: CodingWorkerInput,
  messages: ChatCompletionMessageParam[],
  tools: ChatCompletionTool[],
  maxOutputTokens: number,
) => Promise<AgenticCodingResponse>;

function estimatedPromptTokens(
  messages: ChatCompletionMessageParam[],
) {
  const bytes =
    Buffer.byteLength(
      JSON.stringify({
        messages,
        tools: toolDefinitions,
      }),
    );

  return Math.ceil(
    Math.max(
      256,
      bytes / 4,
    ) * 1.4,
  ) + 128;
}

function compactSeed(
  input: CodingWorkerInput,
) {
  return [
    input.context?.localizationSummary
      ? `LOCALIZATION\n${input.context.localizationSummary.slice(0, 2_000)}`
      : "",
    input.context?.diagnostics
      ? `DIAGNOSTICS\n${input.context.diagnostics.slice(0, 3_000)}`
      : "",
    input.context?.previousFailedDiff
      ? `PREVIOUS FAILED DIFF\n${input.context.previousFailedDiff.slice(0, 3_000)}`
      : "",
    `KNOWN RELEVANT PATHS\n${JSON.stringify(
      input.context?.relevantFiles ?? [],
    )}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function aggregateUsage(
  values: readonly Usage[],
  input: CodingWorkerInput,
): Usage {
  const promptTokens =
    values.reduce(
      (sum, usage) =>
        sum + usage.promptTokens,
      0,
    );

  const completionTokens =
    values.reduce(
      (sum, usage) =>
        sum + usage.completionTokens,
      0,
    );

  const reasoningTokens =
    values.reduce(
      (sum, usage) =>
        sum + usage.reasoningTokens,
      0,
    );

  const cachedTokens =
    values.reduce(
      (sum, usage) =>
        sum + usage.cachedTokens,
      0,
    );

  const cacheWriteTokens =
    values.reduce(
      (sum, usage) =>
        sum + usage.cacheWriteTokens,
      0,
    );

  const directCosts =
    values.map(
      (usage) =>
        usage.costUsd,
    );

  let costUsd: number | null = null;

  if (
    directCosts.every(
      (value): value is number =>
        typeof value === "number" &&
        Number.isFinite(value),
    )
  ) {
    costUsd =
      directCosts.reduce(
        (sum, value) =>
          sum + value,
        0,
      );
  } else if (
    input.promptPricePerMillion !== undefined &&
    input.completionPricePerMillion !== undefined
  ) {
    costUsd = estimateUsageCost(
      {
        promptTokens,
        completionTokens,
        reasoningTokens,
        cachedTokens,
        cacheWriteTokens,
        costUsd: null,
        raw: {
          prompt_tokens:
            promptTokens,
          completion_tokens:
            completionTokens,
        },
      },
      input.promptPricePerMillion,
      input.completionPricePerMillion,
    );
  }

  return {
    promptTokens,
    completionTokens,
    reasoningTokens,
    cachedTokens,
    cacheWriteTokens,
    costUsd,
    raw: {
      prompt_tokens:
        promptTokens,
      completion_tokens:
        completionTokens,
    },
  };
}

export class AgenticCodingWorker
  implements CodingWorker
{
  constructor(
    readonly budget: Budget,
    readonly logger: Logger,
    private readonly requester?: AgenticCodingRequester,
  ) {}

  private async request(
    input: CodingWorkerInput,
    messages: ChatCompletionMessageParam[],
    maxOutputTokens: number,
  ): Promise<AgenticCodingResponse> {
    if (this.requester) {
      return this.requester(
        input,
        messages,
        toolDefinitions,
        maxOutputTokens,
      );
    }

    const apiKey =
      (
        process.env.OPENROUTER_API_KEY ??
        ""
      ).trim();

    if (!apiKey) {
      throw Error(
        "INFRA_FAILURE: OPENROUTER_API_KEY is missing",
      );
    }

    const sdk = new OpenAI({
      apiKey,
      baseURL: input.baseUrl,
      maxRetries: 0,
      timeout: input.requestTimeoutMs,
    });

    const provider: Record<
      string,
      unknown
    > = {
      require_parameters: true,
      allow_fallbacks: true,
      sort: {
        by: "price",
        partition: "none",
      },
    };

    if (
      input.promptPricePerMillion !== undefined &&
      input.completionPricePerMillion !== undefined
    ) {
      provider.max_price = {
        prompt:
          input.promptPricePerMillion,
        completion:
          input.completionPricePerMillion,
      };
    }

    const response =
      await sdk.chat.completions.create(
        {
          model: input.model,
          messages,
          tools: toolDefinitions,
          tool_choice: "auto",
          max_tokens:
            maxOutputTokens,
          stream: false,
          ...({
            session_id:
              input.sessionId,
            provider,
          } as any),
        },
        {
          timeout:
            input.requestTimeoutMs,
          signal:
            AbortSignal.timeout(
              input.requestTimeoutMs,
            ),
        },
      );

    return {
      model: response.model,
      usage: response.usage,
      message:
        (response.choices[0]
          ?.message ?? {}) as any,
    };
  }

  async run(
    input: CodingWorkerInput,
  ): Promise<CodingWorkerResult> {
    const started = Date.now();

    const scope =
      new WriteScope(
        input.writeScope,
        this.logger,
        input.attemptId,
      );

    const checkpoint =
      await AttemptCheckpoint.capture(
        input.repoPath,
        scope,
      );

    const tools =
      new AgentTools(
        input.repoPath,
        false,
        input.commandTimeoutMs,
        this.logger,
        input.attemptId,
        input.maxToolOutputBytes ??
          4_000,
        scope,
        input.context
          ?.relevantFiles ??
          [],
      );

    const messages:
      ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: [
          "You are Koda's progressive coding worker.",
          "Use repository tools instead of asking for the whole repository in the prompt.",
          "Search and read only the code needed to complete the task.",
          "Never invent a repository path when search or list_files can establish the real path.",
          "Modify only paths permitted by the immutable write scope.",
          "For new files, use write_file only when the task and repository evidence justify the path.",
          "Prefer edit_file or apply_patch for small changes to existing files.",
          "Do not stop at a plan: make the code change.",
          "Use run_command only for focused checks or safe repository inspection.",
          "Koda performs authoritative verification after this worker finishes.",
        ].join(" "),
      },
      {
        role: "user",
        content: [
          `TASK\n${input.task}`,
          `WRITE SCOPE\n${JSON.stringify(
            input.writeScope,
          )}`,
          compactSeed(input),
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ];

    const reservation =
      this.budget.reserve(
        input.budgetUsd,
        input.maxTokens,
      );

    const usages: Usage[] = [];
    let modelServed =
      input.model;
    let mutationObserved = false;
    let providerDispatched = false;

    const settleKnown = () => {
      const usage =
        aggregateUsage(
          usages,
          input,
        );

      reservation.settle(
        usage,
      );

      return usage;
    };

    const currentChanges =
      async () =>
        checkpoint.changed(
          input.repoPath,
          scope,
        );

    const result = async (
      partial: Omit<
        CodingWorkerResult,
        | "model"
        | "engine"
        | "engineVersion"
        | "wallClockMs"
      >,
    ): Promise<CodingWorkerResult> => {
      const usage = settleKnown();

      return {
        ...partial,
        model: modelServed,
        engine: "agentic",
        engineVersion:
          AGENTIC_CODING_VERSION,
        wallClockMs:
          Date.now() - started,
        costUsd:
          usage.costUsd ??
          undefined,
        inputTokens:
          usage.promptTokens,
        outputTokens:
          usage.completionTokens,
        cachedInputTokens:
          usage.cachedTokens,
        cacheWriteTokens:
          usage.cacheWriteTokens,
        configuredTokenLimit:
          input.maxTokens,
        consumedTokens:
          usage.promptTokens +
          usage.completionTokens,
        remainingTokens:
          Math.max(
            0,
            input.maxTokens -
              usage.promptTokens -
              usage.completionTokens,
          ),
      };
    };

    try {
      for (
        let step = 0;
        step < input.maxSteps;
        step++
      ) {
        const usedTokens =
          usages.reduce(
            (sum, usage) =>
              sum +
              usage.promptTokens +
              usage.completionTokens,
            0,
          );

        const promptTokens =
          estimatedPromptTokens(
            messages,
          );

        const attemptRoom =
          input.maxTokens -
          usedTokens -
          promptTokens;

        const providerRoom =
          (input.contextWindowTokens ?? Infinity) -
          promptTokens;

        const tokenRoom =
          Math.min(
            attemptRoom,
            providerRoom,
          );

        if (tokenRoom < 256) {
          const changes =
            await currentChanges();

          if (changes.length) {
            mutationObserved = true;

            return result({
              exitStatus:
                "completed",
              changedPaths:
                changes.map(
                  (change) =>
                    change.path,
                ),
              terminationReason:
                "candidate_ready_for_verification",
              progressPhase:
                "MUTATION_OBSERVED",
              limitKind:
                "token_preflight",
              exactLimitFired:
                "agentic_token_preflight_after_mutation",
              steps: step,
            });
          }

          return result({
            exitStatus: "failed",
            changedPaths: [],
            terminationReason:
              "attempt_budget_exhausted",
            limitKind:
              "token_preflight",
            exactLimitFired:
              "agentic_token_preflight",
            progressPhase:
              "DISCOVERY",
            steps: step,
          });
        }

        let maxOutput =
          Math.min(
            input.maxOutputTokens,
            1_200,
            tokenRoom,
          );

        if (
          input.promptPricePerMillion !== undefined &&
          input.completionPricePerMillion !== undefined
        ) {
          const spent =
            usages.reduce(
              (sum, usage) =>
                sum +
                (usage.costUsd ??
                  estimateUsageCost(
                    usage,
                    input.promptPricePerMillion!,
                    input.completionPricePerMillion!,
                  ) ??
                  0),
              0,
            );

          const promptCost =
            promptTokens *
            input.promptPricePerMillion /
            1e6;

          const availableForOutput =
            input.budgetUsd -
            spent -
            promptCost;

          if (
            availableForOutput <=
            0
          ) {
            const changes =
              await currentChanges();

            if (changes.length) {
              return result({
                exitStatus:
                  "completed",
                changedPaths:
                  changes.map(
                    (change) =>
                      change.path,
                  ),
                terminationReason:
                  "candidate_ready_for_verification",
                progressPhase:
                  "MUTATION_OBSERVED",
                limitKind:
                  "token_preflight",
                exactLimitFired:
                  "agentic_cost_preflight_after_mutation",
                steps: step,
              });
            }

            return result({
              exitStatus:
                "failed",
              changedPaths: [],
              terminationReason:
                "attempt_budget_exhausted",
              limitKind:
                "token_preflight",
              exactLimitFired:
                "agentic_cost_preflight",
              progressPhase:
                "DISCOVERY",
              steps: step,
            });
          }

          if (
            input.completionPricePerMillion >
            0
          ) {
            maxOutput =
              Math.min(
                maxOutput,
                Math.floor(
                  availableForOutput *
                    1e6 /
                    input.completionPricePerMillion,
                ),
              );
          }
        }

        if (maxOutput < 64) {
          const changes =
            await currentChanges();

          if (changes.length) {
            return result({
              exitStatus:
                "completed",
              changedPaths:
                changes.map(
                  (change) =>
                    change.path,
                ),
              terminationReason:
                "candidate_ready_for_verification",
              progressPhase:
                "MUTATION_OBSERVED",
              limitKind:
                "token_preflight",
              exactLimitFired:
                "agentic_output_reserve_after_mutation",
              steps: step,
            });
          }

          return result({
            exitStatus: "failed",
            changedPaths: [],
            terminationReason:
              "attempt_budget_exhausted",
            limitKind:
              "token_preflight",
            exactLimitFired:
              "agentic_output_reserve",
            progressPhase:
              "DISCOVERY",
            steps: step,
          });
        }

        this.logger.log(
          "provider_policy",
          {
            subtaskId:
              input.attemptId,
            stage: "implement",
            model: input.model,
            worker_engine:
              "agentic",
            max_output_tokens:
              maxOutput,
          },
        );

        providerDispatched = true;

        const response =
          await this.request(
            input,
            messages,
            maxOutput,
          );

        modelServed =
          response.model ||
          input.model;

        const usage =
          parseUsage(
            response.usage,
          );

        usages.push(usage);

        this.logger.log(
          "model_call",
          {
            subtaskId:
              input.attemptId,
            stage: "implement",
            modelRequested:
              input.model,
            modelReturned:
              modelServed,
            promptTokens:
              usage.promptTokens,
            completionTokens:
              usage.completionTokens,
            cachedTokens:
              usage.cachedTokens,
            cacheWriteTokens:
              usage.cacheWriteTokens,
            costUsd:
              usage.costUsd,
            wallClockMs:
              Date.now() -
              started,
          },
        );

        const assistant =
          response.message as any;

        messages.push(
          assistant,
        );

        const calls =
          assistant.tool_calls ??
          [];

        if (!calls.length) {
          const changes =
            await currentChanges();

          if (changes.length) {
            mutationObserved = true;

            return result({
              exitStatus:
                "completed",
              changedPaths:
                changes.map(
                  (change) =>
                    change.path,
                ),
              terminationReason:
                "agentic_completed",
              progressPhase:
                "MUTATION_OBSERVED",
              steps: step + 1,
            });
          }

          messages.push({
            role: "user",
            content:
              "No mutation has been made yet. Continue with repository tools and implement the requested change. Do not only explain.",
          });

          continue;
        }

        for (
          const call
          of calls.slice(0, 8)
        ) {
          let content: string;

          try {
            const args =
              JSON.parse(
                call.function.arguments,
              );

            content =
              String(
                await tools.execute(
                  call.function.name,
                  args,
                ),
              );
          } catch (error) {
            content =
              `Tool error: ${String(
                error,
              )}`;
          }

          messages.push({
            role: "tool",
            tool_call_id:
              call.id,
            content,
          } as any);
        }

        const changes =
          await currentChanges();

        if (changes.length) {
          mutationObserved = true;
        }
      }

      const changes =
        await currentChanges();

      return result({
        exitStatus:
          changes.length
            ? "completed"
            : "failed",
        changedPaths:
          changes.map(
            (change) =>
              change.path,
          ),
        terminationReason:
          changes.length
            ? "candidate_ready_for_verification"
            : "agentic_step_limit",
        limitKind:
          changes.length
            ? undefined
            : "step_limit",
        progressPhase:
          changes.length
            ? "MUTATION_OBSERVED"
            : "DISCOVERY",
        steps: input.maxSteps,
      });
    } catch (error) {
      if (providerDispatched) {
        reservation.settleUncertain();
      } else {
        reservation.cancel();
      }

      const changes =
        await currentChanges()
          .catch(() => []);

      return {
        exitStatus:
          "infra_failure",
        model: modelServed,
        engine: "agentic",
        engineVersion:
          AGENTIC_CODING_VERSION,
        changedPaths:
          changes.map(
            (change) =>
              change.path,
          ),
        wallClockMs:
          Date.now() - started,
        terminationReason:
          "agentic_provider_error",
        progressPhase:
          mutationObserved ||
          changes.length
            ? "MUTATION_OBSERVED"
            : "DISCOVERY",
        fatalError:
          String(error),
        configuredTokenLimit:
          input.maxTokens,
      };
    }
  }
}
'''

# ============================================================
# NEW tests
# ============================================================

handoff_test = r'''import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  planCodingHandoff,
} from "../src/agent/handoffPlanner.js";

async function fixture() {
  const root =
    await mkdtemp(
      join(
        tmpdir(),
        "koda-handoff-",
      ),
    );

  await mkdir(
    join(root, "src"),
    { recursive: true },
  );

  return root;
}

const base = {
  task: "Make the smallest correct change.",
  attemptTokenCapacity: 30_000,
  modelContextTokens: 128_000,
  maxOutputTokens: 4_096,
  costCapacityUsd: 1,
  promptPricePerMillion: 1,
  completionPricePerMillion: 4,
  directEditEligible: false,
};

test(
  "Aider admission keeps complete editable files and drops oversized secondary context",
  async () => {
    const root = await fixture();

    await writeFile(
      join(root, "src/a.ts"),
      "export const a = 1;\n",
    );

    await writeFile(
      join(root, "src/b.ts"),
      "export const b = 2;\n",
    );

    await writeFile(
      join(root, "src/huge.ts"),
      "x".repeat(400_000),
    );

    const plan =
      await planCodingHandoff({
        ...base,
        repoPath: root,
        writeScope: [
          "src/a.ts",
          "src/b.ts",
        ],
        context: {
          relevantFiles: [
            "src/huge.ts",
          ],
          sourceFiles: [
            {
              path: "src/huge.ts",
              snippet: "x",
            },
          ],
        },
      });

    assert.equal(
      plan.mode,
      "aider",
    );

    assert.deepEqual(
      plan.aiderFiles?.editable,
      [
        "src/a.ts",
        "src/b.ts",
      ],
    );

    assert.equal(
      plan.aiderFiles?.readOnly.includes(
        "src/huge.ts",
      ),
      false,
    );
  },
);

test(
  "oversized multi-file editable scope becomes progressive instead of failing preflight",
  async () => {
    const root = await fixture();

    await writeFile(
      join(root, "src/a.ts"),
      "a".repeat(100_000),
    );

    await writeFile(
      join(root, "src/b.ts"),
      "b".repeat(100_000),
    );

    const plan =
      await planCodingHandoff({
        ...base,
        repoPath: root,
        attemptTokenCapacity:
          10_000,
        writeScope: [
          "src/a.ts",
          "src/b.ts",
        ],
      });

    assert.equal(
      plan.mode,
      "agentic",
    );
  },
);

test(
  "one localized oversized file can use bounded DirectEdit",
  async () => {
    const root = await fixture();

    await writeFile(
      join(root, "src/a.ts"),
      "a".repeat(200_000),
    );

    const plan =
      await planCodingHandoff({
        ...base,
        repoPath: root,
        attemptTokenCapacity:
          8_000,
        directEditEligible: true,
        writeScope: [
          "src/a.ts",
        ],
      });

    assert.equal(
      plan.mode,
      "direct",
    );
  },
);

test(
  "broad scope and empty repos choose create-capable progressive execution",
  async () => {
    const root = await fixture();

    const plan =
      await planCodingHandoff({
        ...base,
        repoPath: root,
        writeScope: ["."],
      });

    assert.equal(
      plan.mode,
      "agentic",
    );
  },
);
'''

agentic_test = r'''import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Budget } from "../src/openrouter/usage.js";
import {
  AgenticCodingWorker,
  type AgenticCodingResponse,
} from "../src/agent/agenticCodingWorker.js";

test(
  "agentic worker can create a file in an empty repo without preloading repository contents",
  async () => {
    const root =
      await mkdtemp(
        join(
          tmpdir(),
          "koda-agentic-",
        ),
      );

    const logger = {
      events: [] as any[],
      log(
        type: string,
        payload: any,
      ) {
        this.events.push({
          type,
          ...payload,
        });
      },
    } as any;

    const budget =
      new Budget(
        1,
        20_000,
        60_000,
      );

    let call = 0;

    const worker =
      new AgenticCodingWorker(
        budget,
        logger,
        async () => {
          call++;

          if (call === 1) {
            return {
              model: "mock/model",
              usage: {
                prompt_tokens: 50,
                completion_tokens: 20,
                cost: 0.0001,
              },
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: {
                      name: "write_file",
                      arguments:
                        JSON.stringify({
                          path: "hello.txt",
                          content:
                            "hello\n",
                        }),
                    },
                  },
                ],
              },
            } satisfies AgenticCodingResponse;
          }

          return {
            model: "mock/model",
            usage: {
              prompt_tokens: 70,
              completion_tokens: 10,
              cost: 0.0001,
            },
            message: {
              content: "done",
              tool_calls: [],
            },
          } satisfies AgenticCodingResponse;
        },
      );

    const result =
      await worker.run({
        repoPath: root,
        attemptId: "test",
        task:
          "Create hello.txt containing hello",
        model: "mock/model",
        budgetUsd: 0.1,
        maxTokens: 10_000,
        maxSteps: 4,
        timeoutMs: 30_000,
        requestTimeoutMs:
          5_000,
        commandTimeoutMs:
          5_000,
        maxOutputTokens:
          1_000,
        baseUrl:
          "http://unused",
        writeScope: ["."],
        promptPricePerMillion:
          1,
        completionPricePerMillion:
          1,
      });

    assert.equal(
      result.exitStatus,
      "completed",
    );

    assert.deepEqual(
      result.changedPaths,
      ["hello.txt"],
    );

    assert.equal(
      await readFile(
        join(
          root,
          "hello.txt",
        ),
        "utf8",
      ),
      "hello\n",
    );

    assert.ok(call >= 2);
  },
);
'''

# ============================================================
# PATCH: codingWorker.ts
# ============================================================

if '"aider" | "direct-edit" | "agentic"' not in texts[CODING_WORKER]:
    replace_once(
        CODING_WORKER,
        'engine: "aider" | "direct-edit";',
        'engine: "aider" | "direct-edit" | "agentic";',
        "allow agentic worker results",
    )

if "aiderFiles?:" not in texts[CODING_WORKER]:
    marker = '''  aiderEditFormat?: "diff" | "whole";'''
    addition = '''
  /**
   * Context-admission result for Aider.
   * When present, Aider must attach exactly these already-budgeted files.
   */
  aiderFiles?: {
    editable: string[];
    readOnly: string[];
  };'''
    insert_after_once(
        CODING_WORKER,
        marker,
        addition,
        "aiderFiles?:",
        "add admitted Aider file packet",
    )

# ============================================================
# PATCH: aiderExecutor.ts
# ============================================================

aider_text = texts[AIDER_EXECUTOR]

start = aider_text.find(
    "export function selectAiderFiles"
)
if start < 0:
    stop("selectAiderFiles was not found in aiderExecutor.ts")

signature_end_marker = (
    "): { editable: string[]; readOnly: string[] } {"
)
sig_end = aider_text.find(
    signature_end_marker,
    start,
)
if sig_end < 0:
    stop("selectAiderFiles signature end was not found")

sig_end += len(signature_end_marker)

new_signature = '''export function selectAiderFiles<
  T extends Pick<
    CodingWorkerInput,
    "task" | "writeScope" | "context" | "aiderFiles"
  >,
>(
  input: T,
): { editable: string[]; readOnly: string[] } {'''

aider_text = (
    aider_text[:start]
    + new_signature
    + aider_text[sig_end:]
)

override_marker = new_signature
override_code = '''
  if (input.aiderFiles) {
    const editable = [
      ...new Set(
        input.aiderFiles.editable
          .map(normalizeAiderPath)
          .filter(
            (value): value is string =>
              !!value,
          ),
      ),
    ];

    const editableSet =
      new Set(editable);

    const readOnly = [
      ...new Set(
        input.aiderFiles.readOnly
          .map(normalizeAiderPath)
          .filter(
            (value): value is string =>
              !!value &&
              !editableSet.has(value),
          ),
      ),
    ];

    return {
      editable,
      readOnly,
    };
  }
'''

if "if (input.aiderFiles)" not in aider_text:
    pos = aider_text.find(
        new_signature
    )
    insert_pos = pos + len(
        new_signature
    )
    aider_text = (
        aider_text[:insert_pos]
        + override_code
        + aider_text[insert_pos:]
    )

texts[AIDER_EXECUTOR] = aider_text
print("[patch] make Aider obey deterministic admitted file packet")

# ============================================================
# PATCH: codingExecutor.ts
# ============================================================

# Remove now-obsolete estimator import if the prior patch added it.
texts[CODING_EXECUTOR] = texts[CODING_EXECUTOR].replace(
    "  estimateAiderPromptBytes,\n",
    "",
)

if 'from "./directEditWorker.js"' not in texts[CODING_EXECUTOR]:
    insert_after_once(
        CODING_EXECUTOR,
        '''import { attemptLimitPolicy } from "./attemptPolicy.js";''',
        '''
import { DirectEditWorker } from "./directEditWorker.js";
import { AgenticCodingWorker } from "./agenticCodingWorker.js";
import { planCodingHandoff } from "./handoffPlanner.js";''',
        'from "./handoffPlanner.js"',
        "import universal handoff workers",
    )

# Normalize attemptPolicy import to include usesDirectEditEngine.
texts[CODING_EXECUTOR] = texts[CODING_EXECUTOR].replace(
    '''import { attemptLimitPolicy } from "./attemptPolicy.js";''',
    '''import {
  attemptLimitPolicy,
  usesDirectEditEngine,
} from "./attemptPolicy.js";''',
    1,
)

replace_regex_once(
    CODING_EXECUTOR,
    r'''  const worker =\s*
    options\.codingWorker \?\? new AiderExecutor\(gateway\.budget, gateway\.logger\);\s*
  const workerEngine = "aider";''',
    '''  const injectedWorker =
    options.codingWorker;''',
    "defer worker selection until context admission",
    flags=re.S,
)

# Remove old forecastPromptBytes block if the previous patch installed it.
texts[CODING_EXECUTOR] = re.sub(
    r'''    const forecastPromptBytes =\s*
      worker instanceof AiderExecutor[\s\S]*?
          \) \+ 1_024;\s*
''',
    "",
    texts[CODING_EXECUTOR],
    count=1,
)

limits_marker = '''    const limits = attemptLimitPolicy({'''
if texts[CODING_EXECUTOR].count(limits_marker) != 1:
    stop(
        "Expected exactly one attemptLimitPolicy call in codingExecutor.ts "
        f"but found {texts[CODING_EXECUTOR].count(limits_marker)}."
    )

handoff_block = r'''    const handoff =
      injectedWorker
        ? undefined
        : await planCodingHandoff({
            repoPath: path,
            task: workerTask,
            writeScope: [...writeScope.paths],
            context: workerContext,
            attemptTokenCapacity: Math.min(
              gateway.budget.remainingTokens(),
              gateway.config.stageMaxTokens,
            ),
            modelContextTokens:
              attemptMetadata?.contextLength,
            maxOutputTokens:
              gateway.config.maxOutputTokens,
            costCapacityUsd: Math.min(
              remaining,
              gateway.config.stageMaxUsd,
            ),
            promptPricePerMillion:
              attemptMetadata?.inputPrice,
            completionPricePerMillion:
              attemptMetadata?.outputPrice,
            directEditEligible:
              subtask.id !== "stable" &&
              usesDirectEditEngine(fingerprint) &&
              writeScope.paths.length === 1 &&
              writeScope.paths[0] !== ".",
          });

    const worker: CodingWorker =
      injectedWorker ??
      (handoff!.mode === "direct"
        ? new DirectEditWorker(
            gateway.budget,
            gateway.logger,
          )
        : handoff!.mode === "agentic"
          ? new AgenticCodingWorker(
              gateway.budget,
              gateway.logger,
            )
          : new AiderExecutor(
              gateway.budget,
              gateway.logger,
            ));

    const workerMode =
      injectedWorker
        ? "custom"
        : handoff!.mode;

    const handoffPromptBytes =
      injectedWorker
        ? Buffer.byteLength(
            JSON.stringify({
              task: workerTask,
              context: workerContext,
            }),
          ) + 1_024
        : handoff!.estimatedPromptBytes;

    gateway.logger.log(
      "coding_handoff",
      {
        subtaskId: subtask.id,
        mode: workerMode,
        reason:
          handoff?.reason ??
          "injected worker",
        estimated_prompt_bytes:
          handoffPromptBytes,
        editable_files:
          handoff?.mode === "aider"
            ? handoff.aiderFiles?.editable ?? []
            : [],
        readonly_files:
          handoff?.mode === "aider"
            ? handoff.aiderFiles?.readOnly ?? []
            : [],
      },
    );

'''

texts[CODING_EXECUTOR] = texts[CODING_EXECUTOR].replace(
    limits_marker,
    handoff_block + limits_marker,
    1,
)
print("[patch] add per-attempt context admission and worker dispatch")

# Normalize promptBytes in attempt policy call. Handles both the old JSON packet
# and the previous estimateAiderPromptBytes patch.
policy_start = texts[CODING_EXECUTOR].find(
    limits_marker
)
max_iter_marker = '''      maxIterations: gateway.config.maxIterations,'''
max_iter = texts[CODING_EXECUTOR].find(
    max_iter_marker,
    policy_start,
)
if max_iter < 0:
    stop("Could not find maxIterations inside attemptLimitPolicy call")

between = texts[CODING_EXECUTOR][
    policy_start:max_iter
]

prompt_idx = between.find(
    "      promptBytes:"
)
if prompt_idx < 0:
    stop("Could not find promptBytes inside attemptLimitPolicy call")

absolute_prompt = (
    policy_start + prompt_idx
)
absolute_after = max_iter

prefix = texts[CODING_EXECUTOR][
    :absolute_prompt
]
suffix = texts[CODING_EXECUTOR][
    absolute_after:
]

texts[CODING_EXECUTOR] = (
    prefix
    + '''      promptBytes: handoffPromptBytes,\n'''
    + suffix
)

# Direct edit is based on the actual selected engine. Replace the field
# structurally inside the attemptLimitPolicy object instead of matching its
# previous expression text.
policy_start = texts[CODING_EXECUTOR].find(limits_marker)
policy_end = texts[CODING_EXECUTOR].find("    });", policy_start)
if policy_end < 0:
    stop("Could not find the end of attemptLimitPolicy in codingExecutor.ts")

field_start = texts[CODING_EXECUTOR].find(
    "      directEditEligible:",
    policy_start,
    policy_end,
)
if field_start < 0:
    stop("Could not find directEditEligible in codingExecutor.ts")

field_tail = texts[CODING_EXECUTOR][field_start:policy_end]
next_field = re.search(r"\n      [A-Za-z_][A-Za-z0-9_]*:", field_tail[1:])
if next_field:
    field_end = field_start + 1 + next_field.start()
else:
    field_end = policy_end

texts[CODING_EXECUTOR] = (
    texts[CODING_EXECUTOR][:field_start]
    + '''      directEditEligible:
        worker instanceof DirectEditWorker,
'''
    + texts[CODING_EXECUTOR][field_end:]
)
print("[patch] bind DirectEdit policy to actual selected engine")

# Worker telemetry.
texts[CODING_EXECUTOR] = texts[CODING_EXECUTOR].replace(
    "      worker_engine: workerEngine,",
    "      worker_engine: workerMode,",
)

# Previous context-budget patch may have this telemetry field.
texts[CODING_EXECUTOR] = texts[CODING_EXECUTOR].replace(
    '''      forecast_provider_prompt_bytes:
        forecastPromptBytes,
''',
    '''      forecast_provider_prompt_bytes:
        handoffPromptBytes,
''',
)

# Pass the admitted Aider packet into the worker input.
if "aiderFiles:" not in texts[CODING_EXECUTOR]:
    replace_once(
        CODING_EXECUTOR,
        '''      context: workerContext,
      aiderEditFormat:''',
        '''      context: workerContext,
      aiderFiles:
        handoff?.mode === "aider"
          ? handoff.aiderFiles
          : undefined,
      aiderEditFormat:''',
        "pass admitted file packet to Aider",
    )

# Record agentic operational outcomes with the same neutral operational ledger
# semantics as Aider.
texts[CODING_EXECUTOR] = texts[CODING_EXECUTOR].replace(
    '''      result.engine === "aider" && pool''',
    '''      (result.engine === "aider" ||
        result.engine === "agentic") &&
      pool''',
    1,
)

# ============================================================
# Validate source invariants before any write
# ============================================================

required_fragments = {
    CODING_WORKER: [
        '"agentic"',
        "aiderFiles?:",
    ],
    AIDER_EXECUTOR: [
        "if (input.aiderFiles)",
    ],
    CODING_EXECUTOR: [
        "planCodingHandoff",
        "AgenticCodingWorker",
        "DirectEditWorker",
        "coding_handoff",
        "handoffPromptBytes",
    ],
}

for path, fragments in required_fragments.items():
    text = texts[path]
    for fragment in fragments:
        if fragment not in text:
            stop(
                f"Post-patch invariant missing in {path}: {fragment}"
            )

for path, text in texts.items():
    if not text.strip():
        stop(f"Refusing to write empty file: {path}")

# New files must not silently overwrite unrelated work.
new_files = {
    HANDOFF_PLANNER: handoff_planner,
    AGENTIC_WORKER: agentic_worker,
    HANDOFF_TEST: handoff_test,
    AGENTIC_TEST: agentic_test,
}

for path, content in new_files.items():
    if path.exists():
        current = path.read_text()
        if current != content:
            stop(
                f"{path} already exists with different content. "
                "Refusing to overwrite it."
            )

# ============================================================
# Backups
# ============================================================

stamp = datetime.now().strftime(
    "%Y%m%d-%H%M%S"
)

backup_dir = (
    ROOT
    / ".koda"
    / "backups"
    / f"universal-handoff-{stamp}"
)

backup_dir.mkdir(
    parents=True,
    exist_ok=False,
)

for path in EXISTING:
    relative = path.relative_to(ROOT)
    destination = (
        backup_dir / relative
    )
    destination.parent.mkdir(
        parents=True,
        exist_ok=True,
    )
    shutil.copy2(
        path,
        destination,
    )

# ============================================================
# Write
# ============================================================

for path, text in texts.items():
    path.write_text(text)

for path, content in new_files.items():
    path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )
    path.write_text(content)

print("\nPatched:")
for path in [
    *EXISTING,
    *new_files.keys(),
]:
    print(
        "  -",
        path.relative_to(ROOT),
    )

print(
    f"\nBackups: {backup_dir}"
)

# ============================================================
# Verification
# ============================================================

def run(command: list[str]) -> None:
    print(
        "\n$",
        " ".join(command),
    )

    result = subprocess.run(
        command,
        cwd=ROOT,
    )

    if result.returncode != 0:
        raise SystemExit(
            "\nVERIFICATION FAILED.\n"
            "The patch is still present for inspection.\n"
            f"Backups: {backup_dir}\n"
        )


run([
    "git",
    "diff",
    "--check",
])

run([
    "pnpm",
    "exec",
    "tsx",
    "--test",
    "tests/handoffPlanner.test.ts",
    "tests/agenticCodingWorker.test.ts",
    "tests/aiderExecutor.test.ts",
    "tests/attemptPolicy.test.ts",
    "tests/openHandsExplorer.test.ts",
])

run([
    "pnpm",
    "typecheck",
])

print(
    """
============================================================
TARGETED + TYPECHECK PASSED

The universal coding handoff is now:

- DIRECT:
  one safely localized target, including a missing/new target when justified.

- AIDER:
  complete editable files only when they fit the real token/$/context budget.
  Read-only files are admitted incrementally by relevance and budget.

- AGENTIC:
  broad scopes, directories, missing multi-file targets, or oversized edit
  scopes. It uses search_code/read_file/write_file/edit_file/apply_patch and
  keeps WriteScope enforcement.

Important:
- repo size no longer automatically becomes prompt size
- oversized context no longer means immediate token_limit
- new files can be created through the progressive worker
- no package manager, language, framework, test naming, or Koda task is
  hardcoded into the handoff decision
- authoritative verification remains Koda's responsibility

Now run the full suite once:
    pnpm test

If that passes, rerun the exact hard smoke.
============================================================
"""
)
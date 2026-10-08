import { MAX_CODING_PACKET_BYTES } from "../context/packetPolicy.js";
import { lstat } from "node:fs/promises";
import { join } from "node:path";

import type { CodingWorkerContext } from "./codingWorker.js";
import { AIDER_PROMPT_OVERHEAD_TOKENS } from "./attemptPolicy.js";
import { broadVisualDesignTask, visualDesignTask } from "../router/taskFingerprint.js";

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
  /** Only virtual Auto requires native execution to discover and pin its served model. */
  routedModel?: string;
  task: string;
  writeScope: readonly string[];
  context?: CodingWorkerContext;

  /** Whole-attempt Koda token capacity. */
  attemptTokenCapacity: number;

  /** Actual remaining run capacity, independent of the normal stage bound. */
  remainingRunTokens?: number;

  /** Per-provider-call context capacity. */
  modelContextTokens?: number;

  maxOutputTokens: number;

  /** Whole-attempt dollar capacity. */
  costCapacityUsd: number;

  promptPricePerMillion?: number;
  completionPricePerMillion?: number;

  /**
   * Retained for compatibility with the surrounding executor.
   * The production handoff no longer selects DirectEdit for a concrete scope:
   * OpenHands/Koda localize, Aider edits, Koda verifies.
   */
  directEditEligible: boolean;
}

const AIDER_OUTPUT_RESERVE_TOKENS = 4_096;
const ATTEMPT_POLICY_BYTES_PER_TOKEN = 4;
const PER_FILE_FRAMING_BYTES = 512;
const MAX_AIDER_READ_ONLY_FILES = 8;
const UNKNOWN_CONTEXT_INPUT_CAP_TOKENS = 64_000;

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

  return (
    value
      .split("/")
      .filter((part) => part && part !== ".")
      .join("/") || "."
  );
}

function evidenceFiles(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const files = (
    value as {
      relevantFiles?: unknown;
    }
  ).relevantFiles;

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

  return Buffer.byteLength(summary) + 1_024;
}

function promptTokensFromBytes(bytes: number) {
  return Math.max(
    1,
    Math.ceil(
      bytes /
        ATTEMPT_POLICY_BYTES_PER_TOKEN,
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
  return Math.max(
    1,
    Math.ceil(
      (
        size +
        Buffer.byteLength(path) +
        PER_FILE_FRAMING_BYTES
      ) /
        ATTEMPT_POLICY_BYTES_PER_TOKEN,
    ),
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

/**
 * Decide what repository context the coding executor receives.
 *
 * Production invariant:
 *
 *   OpenHands/Koda localize -> Koda routes a model -> Aider edits -> Koda verifies.
 *
 * Concrete scopes use Aider when the complete file packet fits the provider
 * and remaining run capacity. A packet that cannot fit uses bounded agentic
 * reads with the same authorized write scope. Model-specific preflight failures
 * remain the responsibility of attemptPolicy/model recovery.
 */
export async function planCodingHandoff(
  input: CodingHandoffInput,
): Promise<CodingHandoffPlan> {
  const compactTokens =
    promptTokensFromBytes(
      compactPromptBytes(
        input.task,
        input.context,
      ),
    );

  const scope = uniqueSafe(
    input.writeScope,
  );

  if (input.routedModel === "openrouter/auto") {
    return {
      mode: "agentic",
      estimatedPromptBytes: compactTokens * ATTEMPT_POLICY_BYTES_PER_TOKEN,
      reason: "Virtual Auto requires native tools to discover and pin its concrete served model",
    };
  }

  if (
    !scope.length ||
    scope.includes(".")
  ) {
    return {
      mode: "agentic",
      estimatedPromptBytes:
        compactTokens *
        ATTEMPT_POLICY_BYTES_PER_TOKEN,
      reason:
        "write scope is still unresolved; localization must finish before the normal Aider coding path can start",
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
        compactTokens *
        ATTEMPT_POLICY_BYTES_PER_TOKEN,
      reason:
        `target ${unsafeTarget.path} is hardlinked and cannot be handed to Aider safely`,
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
        compactTokens *
        ATTEMPT_POLICY_BYTES_PER_TOKEN,
      reason:
        "directory-level write scope is not a concrete Aider file handoff",
    };
  }

  if (input.context?.implementationRecovery) {
    return { mode: "agentic", estimatedPromptBytes: compactTokens * ATTEMPT_POLICY_BYTES_PER_TOKEN,
      reason: "localized execution-limit continuation uses bounded reads instead of resending the complete file packet" };
  }

  // A broad visual change commonly needs coordinated edits in several files.
  // Aider must emit that entire patch in one response, which can exhaust a
  // small output cap before the first mutation. Progressive Agentic execution
  // keeps the same concrete write scope and can return each mutation promptly.
  if (scope.length > 1 && visualDesignTask(input.task) &&
      (broadVisualDesignTask(input.task) || input.maxOutputTokens <= AIDER_OUTPUT_RESERVE_TOKENS)) {
    return {
      mode: "agentic",
      estimatedPromptBytes: compactTokens * ATTEMPT_POLICY_BYTES_PER_TOKEN,
      reason: "multi-file visual work exceeds a small single-response output cap; use progressive bounded mutations",
    };
  }

  const editable =
    inspected.map(
      ({ path }) => path,
    );

  const missing =
    inspected.filter(
      ({ info }) =>
        !info.exists,
    );

  if (missing.length && editable.length > 1) {
    return {
      mode: "agentic",
      estimatedPromptBytes:
        compactTokens * ATTEMPT_POLICY_BYTES_PER_TOKEN,
      reason:
        "localized multi-file creation uses bounded read/mutate turns instead of one large generated patch",
    };
  }

  const editableTokens =
    inspected.reduce(
      (
        sum,
        { path, info },
      ) =>
        sum +
        filePromptTokens(
          path,
          info.size,
        ),
      compactTokens,
    );

  const outputReserve =
    Math.min(
      input.maxOutputTokens,
      AIDER_OUTPUT_RESERVE_TOKENS,
    );

  const providerInputCapacity =
    Math.max(
      0,
      (
        input.modelContextTokens ??
        Math.max(
          UNKNOWN_CONTEXT_INPUT_CAP_TOKENS,
          input.attemptTokenCapacity,
        )
      ) -
        outputReserve -
        AIDER_PROMPT_OVERHEAD_TOKENS,
    );

  // Optional read-only context must fit provider, stage and run capacities.
  // The normal stage bound may grow for Aider, but the run capacity cannot.
  const attemptInputCapacity =
    Math.max(
      0,
      input.attemptTokenCapacity -
        outputReserve -
        AIDER_PROMPT_OVERHEAD_TOKENS,
    );

  const runInputCapacity = input.remainingRunTokens === undefined
    ? Infinity
    : Math.max(0, input.remainingRunTokens - outputReserve - AIDER_PROMPT_OVERHEAD_TOKENS);
  const optionalContextCapacity = Math.min(
    providerInputCapacity, attemptInputCapacity, runInputCapacity,
    (MAX_CODING_PACKET_BYTES - AIDER_PROMPT_OVERHEAD_TOKENS) / ATTEMPT_POLICY_BYTES_PER_TOKEN,
  );

  if (editableTokens > Math.min(providerInputCapacity, runInputCapacity) ||
      editableTokens * ATTEMPT_POLICY_BYTES_PER_TOKEN > MAX_CODING_PACKET_BYTES - AIDER_PROMPT_OVERHEAD_TOKENS) {
    return {
      mode: "agentic",
      estimatedPromptBytes: compactTokens * ATTEMPT_POLICY_BYTES_PER_TOKEN,
      reason:
        "complete editable scope exceeds the provider context or remaining run tokens; use bounded repository reads before mutation",
    };
  }

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
    ).slice(
      0,
      MAX_AIDER_READ_ONLY_FILES,
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
      optionalContextCapacity
    ) {
      continue;
    }

    readOnly.push(candidate);
    totalTokens += tokens;
  }

  return {
    mode: "aider",
    estimatedPromptBytes:
      totalTokens *
      ATTEMPT_POLICY_BYTES_PER_TOKEN,
    aiderFiles: {
      editable,
      readOnly,
    },
    reason:
      missing.length
          ? "localized scope is Aider-owned and includes authorized creation targets"
          : readOnly.length
            ? "localized scope plus highest-value read-only evidence is handed directly to Aider"
            : "localized concrete scope is handed directly to Aider",
  };
}

/** Verification repair needs fresh reads and bounded edits on the existing candidate. */
export function verificationRepairHandoff(plan: CodingHandoffPlan): CodingHandoffPlan {
  return {...plan, mode: "agentic", reason: "Read candidate and failing assertions before bounded repair"};
}

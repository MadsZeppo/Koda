import { lstat } from "node:fs/promises";
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

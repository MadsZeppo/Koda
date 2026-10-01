import { lstat } from "node:fs/promises";
import { join } from "node:path";

import type { CodingWorkerContext } from "./codingWorker.js";
import { AIDER_PROMPT_OVERHEAD_TOKENS } from "./attemptPolicy.js";

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

/**
 * Aider is currently budgeted as one provider turn by attemptPolicy.
 * Keep this reserve identical to its Aider output reservation:
 *
 *   Math.min(input.maxOutputTokens, 4_096)
 *
 * The handoff planner must be at least as conservative as the authoritative
 * attempt preflight. Otherwise it can select Aider and have attemptPolicy
 * reject the exact same packet a millisecond later.
 */
const AIDER_OUTPUT_RESERVE_TOKENS = 4_096;

const TOKEN_ESTIMATE_SAFETY = 1.4;
const PER_FILE_FRAMING_BYTES = 512;
// Repository source is materially denser than prose/JSON framing. Keeping a
// separate calibrated ratio avoids rejecting a focused Aider handoff at the
// 30k boundary while framing and output reserves remain fully enforced.
const SOURCE_BYTES_PER_TOKEN = 4.5;
// attemptPolicy converts prompt bytes back to tokens with bytes / 4.
const ATTEMPT_POLICY_BYTES_PER_TOKEN = 4;

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

function safeTokenEstimate(bytes: number) {
  return Math.max(
    1,
    Math.ceil(
      (bytes / SOURCE_BYTES_PER_TOKEN) *
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

  if (available <= 0) {
    return 0;
  }

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
 * - Aider gets complete editable files only when the complete one-turn Aider
 *   packet fits BOTH Koda's attempt budget and the provider context window.
 * - The exact Aider framing/output reserves match attemptPolicy's one-turn
 *   viability assumptions so planner admission cannot contradict preflight.
 * - Read-only files are admitted in relevance order while budget remains.
 * - A large localized single target may use DirectEdit, which sends bounded
 *   excerpts rather than the complete file.
 * - Broad, directory-scoped or oversized work becomes agentic and retrieves
 *   context progressively through search/read tools.
 * - Validated missing editable paths remain authorized creation targets.
 */
export async function planCodingHandoff(
  input: CodingHandoffInput,
): Promise<CodingHandoffPlan> {
  /**
   * Aider is a one-provider-turn worker for admission purposes.
   *
   * attemptTokenCapacity is the cumulative Koda capacity.
   * modelContextTokens is one provider request's capacity.
   *
   * For Aider the same single turn must fit both, so the admissible capacity
   * is the smaller value.
   */
  const capacity = Math.max(
    0,
    Math.min(
      input.attemptTokenCapacity,
      input.modelContextTokens ??
        Infinity,
    ),
  );

  /**
   * IMPORTANT:
   *
   * attemptPolicy reserves up to 4,096 output tokens for Aider.
   * The old planner used 20% of at most 16k (= 3,200 tokens at a 30k stage
   * budget), which made it less conservative than attemptPolicy.
   *
   * That produced the contradiction:
   *   planner => Aider fits
   *   attemptPolicy => required_tokens 30,154 > 30,000
   *
   * Use the exact same Aider output reserve here.
   */
  const outputReserve = Math.min(
    input.maxOutputTokens,
    AIDER_OUTPUT_RESERVE_TOKENS,
  );

  const costPromptCapacity =
    maxPromptTokensByCost(
      input,
      outputReserve,
    );

  /**
   * This is the maximum provider INPUT packet we are allowed to hand to
   * Aider after reserving:
   *
   * - Aider/system framing overhead
   * - Aider completion/output capacity
   *
   * The same framing constant is imported from attemptPolicy so those two
   * layers cannot silently drift on prompt overhead.
   */
  const admittedPromptTokens =
    Math.max(
      0,
      Math.min(
        capacity -
          outputReserve -
          AIDER_PROMPT_OVERHEAD_TOKENS,
        costPromptCapacity -
          AIDER_PROMPT_OVERHEAD_TOKENS,
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
        compactTokens *
        ATTEMPT_POLICY_BYTES_PER_TOKEN,
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
        compactTokens *
        ATTEMPT_POLICY_BYTES_PER_TOKEN,
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
        compactTokens *
        ATTEMPT_POLICY_BYTES_PER_TOKEN,
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
          compactTokens *
          ATTEMPT_POLICY_BYTES_PER_TOKEN,
        reason:
          "one localized missing target can be safely created by DirectEdit",
      };
    }

    /**
     * A concrete, validated missing path is an authorized creation target.
     *
     * It contributes framing/path bytes but zero source bytes to Aider's
     * initial packet. If the total one-turn packet still fits the authoritative
     * budget, Aider may create it. Otherwise the normal size gate below sends
     * the work to the progressive agentic worker.
     */
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
          compactTokens *
          ATTEMPT_POLICY_BYTES_PER_TOKEN,
        reason:
          "localized target is too large for a complete Aider handoff; DirectEdit will use bounded excerpts",
      };
    }

    return {
      mode: "agentic",
      estimatedPromptBytes:
        compactTokens *
        ATTEMPT_POLICY_BYTES_PER_TOKEN,
      reason:
        "complete editable scope exceeds the authoritative one-turn Aider budget",
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
      totalTokens *
      ATTEMPT_POLICY_BYTES_PER_TOKEN,
    aiderFiles: {
      editable,
      readOnly,
    },
    reason:
      missing.length
        ? "complete editable scope fits the authoritative Aider budget and includes authorized new files"
        : readOnly.length
          ? "complete editable scope plus highest-value read-only evidence fits the authoritative Aider budget"
          : "complete editable scope fits the authoritative Aider budget; secondary context will be retrieved only if needed",
  };
}

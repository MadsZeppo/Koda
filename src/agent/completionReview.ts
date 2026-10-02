import type { VerificationResult } from "../types.js";

export interface TaskRequirement {
  id: string;
  text: string;
}

export interface RequirementAssessment {
  id: string;
  satisfied: boolean;
  evidence: string;
}

export interface CompletionReview {
  passed: boolean;
  requirements: RequirementAssessment[];
  summary: string;
}

export interface CompletionReviewInput {
  task: string;
  requirements: TaskRequirement[];
  diff: string;
  changedPaths: string[];
  changedSymbols: string[];
  toolEvidence?: string;
  workerExitStatus: string;
  workerTerminationReason?: string;
  verification: VerificationResult;
}

const parts = (value: string) => value
  .split(/\n+/)
  .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
  .filter((line) => line.length >= 3);

/** Convert the existing task contract into a small stable checklist. */
export function taskRequirementChecklist(input: {
  task: string;
  objective: string;
  integrationContract: string;
  acceptanceCriteria: readonly string[];
}) {
  const values = [
    ...parts(input.task),
    ...parts(input.objective),
    ...parts(input.integrationContract),
    ...input.acceptanceCriteria.flatMap(parts),
  ];
  const seen = new Set<string>();
  const unique = values.filter((value) => {
    const key = value.toLocaleLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
  return unique.map((text, index) => ({ id: `R${index + 1}`, text }));
}

function normalizeAssessments(
  parsed: Partial<CompletionReview>,
  requirements: readonly TaskRequirement[],
): CompletionReview {
  const assessments = Array.isArray(parsed.requirements)
    ? parsed.requirements.filter((item): item is RequirementAssessment =>
        !!item && typeof item.id === "string" &&
        typeof item.satisfied === "boolean" && typeof item.evidence === "string")
    : [];
  const byId = new Map(assessments.map((item) => [item.id, item]));
  const normalized = requirements.map((requirement) =>
    byId.get(requirement.id) ?? {
      id: requirement.id,
      satisfied: false,
      evidence: "Reviewer supplied no assessment",
    });
  const passed = parsed.passed === true && normalized.every((item) => item.satisfied);
  return {
    passed,
    requirements: normalized,
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
  };
}

function parseJsonObject(raw: string): Partial<CompletionReview> | undefined {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  for (const candidate of [fenced, raw.trim()]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }

  // Provider wrappers sometimes prepend or append a short sentence around the
  // JSON object. Keep this bounded and deliberately non-greedy across braces.
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      const parsed = JSON.parse(raw.slice(firstBrace, lastBrace + 1));
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }
  return undefined;
}

function parseStructuredProse(
  raw: string,
  requirements: readonly TaskRequirement[],
): CompletionReview | undefined {
  const lines = raw.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const assessments: RequirementAssessment[] = [];

  for (const requirement of requirements) {
    const escaped = requirement.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const line = lines.find((value) => new RegExp(`(?:^|\\b)${escaped}\\b`, "i").test(value));
    if (!line) continue;
    const negative = /\b(?:false|unsatisfied|not satisfied|missing|incomplete|failed|fail)\b/i.test(line);
    const positive = /\b(?:true|satisfied|complete|completed|passed|pass)\b/i.test(line);
    if (!negative && !positive) continue;
    assessments.push({
      id: requirement.id,
      satisfied: positive && !negative,
      evidence: line.slice(0, 1000),
    });
  }

  if (assessments.length !== requirements.length) return undefined;
  const allSatisfied = assessments.every((item) => item.satisfied);
  const explicitOverallFailure = /\b(?:overall|result|passed?)\s*[:=-]\s*(?:false|fail(?:ed)?|no)\b/i.test(raw);
  return {
    passed: allSatisfied && !explicitOverallFailure,
    requirements: assessments,
    summary: "Recovered structured requirement assessments from non-JSON reviewer output.",
  };
}

export function parseCompletionReview(
  raw: string,
  requirements: readonly TaskRequirement[],
): CompletionReview {
  const parsed = parseJsonObject(raw);
  if (parsed) return normalizeAssessments(parsed, requirements);

  const prose = parseStructuredProse(raw, requirements);
  if (prose) return prose;

  // A reviewer formatting failure is operational evidence, not proof that the
  // candidate is wrong. Return an explicit unresolved review instead of
  // throwing; the executor can then use its normal bounded continuation /
  // recovery path without erasing deterministic verification evidence.
  return {
    passed: false,
    requirements: requirements.map((requirement) => ({
      id: requirement.id,
      satisfied: false,
      evidence: "Completion reviewer returned unstructured output; semantic assessment unavailable",
    })),
    summary: "Completion review output was not parseable as structured JSON or requirement-labelled prose.",
  };
}

const isBaselineKnownFailure = (
  check: VerificationResult["checks"][number],
) =>
  check.outcome === "CHECK_FAIL" &&
  check.source?.endsWith(":baseline_unchanged") === true;

/**
 * The deterministic verifier owns regression attribution. Completion review is
 * allowed to judge whether the requested behavior exists in the diff, but it
 * must not reinterpret a baseline-known repository failure as a new candidate
 * failure. Keep those failures visible as context while removing them from the
 * blocking verification list shown to the reviewer.
 */
export function completionReviewMessages(input: CompletionReviewInput) {
  const baselineKnownFailures = input.verification.checks
    .filter(isBaselineKnownFailure)
    .map((check) => ({
      command: check.command,
      exitCode: check.exitCode,
      attribution: "BASELINE_FAILURE_UNCHANGED" as const,
    }));

  const checks = input.verification.checks
    .filter((check) => !isBaselineKnownFailure(check))
    .map((check) => ({
      command: check.command,
      outcome: check.outcome,
      exitCode: check.exitCode,
    }));

  return [
    {
      role: "system" as const,
      content:
        "Independently review task completion from fresh evidence. Passing tests alone never prove an untested requirement. Mark a requirement satisfied only when the diff, changed paths, or a directly relevant verification result proves it. The deterministic verifier is authoritative for regression attribution: entries in baselineKnownFailures were already failing before this candidate and were not made worse by it. Do not mark a requirement unsatisfied solely because baselineKnownFailures is non-empty, unless the original task explicitly requires fixing that exact pre-existing failure. Return exactly one JSON object and no markdown: {\"passed\":boolean,\"requirements\":[{\"id\":string,\"satisfied\":boolean,\"evidence\":string}],\"summary\":string}.",
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        originalTask: input.task,
        requirements: input.requirements,
        changedPaths: input.changedPaths,
        changedSymbols: input.changedSymbols,
        toolEvidence: input.toolEvidence?.slice(0, 4_000) ?? null,
        worker: {
          exitStatus: input.workerExitStatus,
          terminationReason: input.workerTerminationReason ?? null,
        },
        verification: {
          status: input.verification.status,
          checks,
          baselineKnownFailures,
        },
        diff: input.diff.slice(0, 24_000),
      }),
    },
  ];
}

export function missingRequirementDiagnostics(
  requirements: readonly TaskRequirement[],
  review: CompletionReview,
) {
  const text = new Map(requirements.map((item) => [item.id, item.text]));
  return review.requirements
    .filter((item) => !item.satisfied)
    .map((item) => `${item.id}: ${text.get(item.id) ?? item.id}\nReviewer evidence: ${item.evidence}`)
    .join("\n\n");
}

export interface UnresolvedCompletionReview {
  subtaskId: string;
  requirementIds: string[];
}

/**
 * Keep rejected completion requirements latched across later operational
 * failures. Only a subsequent explicit, complete review for the same subtask
 * clears the rejection.
 */
export function unresolvedCompletionReviews(
  events: readonly Record<string, unknown>[],
): UnresolvedCompletionReview[] {
  const unresolved = new Map<string, string[]>();
  for (const event of events) {
    if (event.type !== "completion_review") continue;
    const subtaskId = typeof event.subtaskId === "string"
      ? event.subtaskId
      : "unknown-subtask";
    const requirements = Array.isArray(event.requirements)
      ? event.requirements
      : [];
    const explicitlyComplete = event.passed === true &&
      requirements.length > 0 &&
      requirements.every((item) =>
        !!item && typeof item === "object" &&
        (item as { satisfied?: unknown }).satisfied === true
      );
    if (explicitlyComplete) {
      unresolved.delete(subtaskId);
      continue;
    }
    if (event.passed !== false) continue;
    const requirementIds = requirements
      .filter((item) =>
        !!item && typeof item === "object" &&
        (item as { satisfied?: unknown }).satisfied !== true
      )
      .map((item) => String((item as { id?: unknown }).id ?? "unknown"));
    unresolved.set(
      subtaskId,
      requirementIds.length ? requirementIds : ["unknown"],
    );
  }
  return [...unresolved].map(([subtaskId, requirementIds]) => ({
    subtaskId,
    requirementIds,
  }));
}

export function completionReviewGate(
  finalStatus: VerificationResult["status"],
  events: readonly Record<string, unknown>[],
) {
  const unresolved = unresolvedCompletionReviews(events);
  const baselineRelativeSuccess =
    finalStatus === "CANDIDATE_NEUTRAL" ||
    finalStatus === "CANDIDATE_IMPROVEMENT";
  return {
    status: unresolved.length
      ? "NOT_FULLY_VERIFIED" as const
      : baselineRelativeSuccess
        ? "VERIFIED_SUCCESS" as const
        : finalStatus,
    unresolved,
  };
}

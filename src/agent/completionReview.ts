import type { VerificationResult } from "../types.js";
import { visualDesignTask } from "../router/taskFingerprint.js";
import { requestsTestMutation } from "../router/executionStrategy.js";
import { isRunnableTestPath } from "../context/compiler.js";
import { discoveredTestGlobs, matchesDiscoveredTestGlob } from "../verifier/selection.js";
import type { ChatCompletionTool, ChatCompletionMessage } from "openai/resources/chat/completions";
import {
  explicitDesiredLiteral,
  explicitLiteralReplacement,
  isOnlyLiteralReplacementTask,
  isOnlyLocalizedCopyTask,
} from "./literalEdit.js";

export function completionReviewModel(
  registry: Readonly<{
    SCOUT_MODEL: string;
    STRONG_MODEL?: string;
    FRONTIER_MODEL?: string;
  }>,
  strictRetry = false,
  provenToolModel?: string,
) {
  if (!strictRetry) return registry.SCOUT_MODEL;
  return [provenToolModel, registry.STRONG_MODEL, registry.FRONTIER_MODEL]
    .find((model): model is string => !!model && model !== registry.SCOUT_MODEL) ??
    registry.SCOUT_MODEL;
}

/** Leave room for concise evidence and, on reasoning-mandatory endpoints, hidden reasoning. */
export function completionReviewBatches<T>(requirements: readonly T[], providerOutputCap: number): T[][] {
  const size = Math.max(1, Math.min(24, Math.floor((providerOutputCap - 1_344) / 160)));
  const batches: T[][] = [];
  for (let index = 0; index < requirements.length; index += size)
    batches.push(requirements.slice(index, index + size));
  return batches;
}

export function completionReviewOutputTokens(requirementCount: number, providerOutputCap: number, retry: boolean) {
  return Math.min(providerOutputCap, Math.max(retry ? 1_600 : 1_000,
    320 + requirementCount * 160 + (retry ? 1_024 : 512)));
}

export function completionReviewPayload(message: Pick<ChatCompletionMessage, "content" | "tool_calls">) {
  const call = message.tool_calls?.find((call) => call.type === "function" && call.function.name === "submit_completion_review");
  return call?.type === "function" ? call.function.arguments : String(message.content ?? "");
}

export function completionReviewTool(requirements: readonly TaskRequirement[]): ChatCompletionTool {
  return { type: "function", function: {
    name: "submit_completion_review", description: "Submit the independent requirement-by-requirement completion assessment.", strict: true,
    parameters: { type: "object", additionalProperties: false,
      properties: {
        passed: { type: "boolean" }, summary: { type: "string" },
        requirements: { type: "array", minItems: requirements.length, maxItems: requirements.length,
          items: { type: "object", additionalProperties: false,
          properties: { id: { type: "string", enum: requirements.map((item) => item.id) },
            satisfied: { type: "boolean" }, evidence: { type: "string" } },
          required: ["id", "satisfied", "evidence"] } },
      }, required: ["passed", "requirements", "summary"],
    },
  } };
}

/** The protocol retry must constrain provider output, not only request JSON in prose. */
export function completionReviewResponseFormat(requirements: readonly TaskRequirement[]) {
  const tool = completionReviewTool(requirements);
  if (tool.type !== "function") throw Error("Completion review requires a function schema");
  return { type: "json_schema" as const, json_schema: {
    name: "completion_review", strict: true,
    schema: tool.function.parameters!,
  } };
}

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
  protocolFailure?: boolean;
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
  /** Required repository checks will run against the integrated candidate. */
  verificationDeferred?: boolean;
  /** Candidate-local contents, relative to the attempt checkpoint. */
  fileChanges?: { path: string; before?: string; after?: string }[];
  /** Bounded pre-attempt repository evidence for requirements already present. */
  repositoryEvidence?: { path: string; snippet: string }[];
  cascadeConflict?: string;
}

/** A requested test mutation absent from the diff is a concrete, local gap.
 * Do not spend a reviewer call to rediscover it or claim other requirements passed. */
export function requiredTestMutationGap(input: CompletionReviewInput): CompletionReview | undefined {
  if (!requestsTestMutation(input.task) || input.changedPaths.some(isRunnableTestPath)) return undefined;
  const missing = input.requirements.filter((requirement) => requestsTestMutation(requirement.text));
  if (!missing.length) return undefined;
  return {
    passed: false,
    requirements: missing.map(({ id }) => ({
      id,
      satisfied: false,
      evidence: "No test file was changed or created, although the task explicitly requires adding or changing tests.",
    })),
    summary: "Requested test mutation is absent from the candidate diff.",
  };
}

/** Final success requires a requested test edit to be executed by a real test check. */
export function missingRequestedTestVerification(
  task: string,
  changedPaths: readonly string[],
  verification: VerificationResult,
  testScript = "",
): string | undefined {
  if (!requestsTestMutation(task) || !changedPaths.length) return undefined;
  if (!changedPaths.some(isRunnableTestPath))
    return "The task requested tests, but the candidate did not change a test file.";
  const globs = discoveredTestGlobs(testScript);
  if (globs.length && changedPaths.filter(isRunnableTestPath).some((path) =>
    !matchesDiscoveredTestGlob(path, globs)))
    return "A changed test file is outside the repository runner's discovered test glob.";
  const executedTest = verification.checks.some((check) =>
    check.kind === "test" ||
    /(?:\bnode\s+--test\b|\b(?:pytest|vitest|jest)\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b)/i.test(check.command));
  if (!executedTest)
    return "The candidate changed a test file, but no repository test command executed it.";
  return undefined;
}

/** A broad important declaration beats ordinary utility classes and inline
 * styles. This is proof of a missing visual result, not a lint/build failure. */
export function visualCascadeConflict(input: {
  task: string;
  diff: string;
  changedPaths: readonly string[];
  stylesheets: readonly { path: string; content: string }[];
}): string | undefined {
  if (!visualDesignTask(input.task) ||
      input.changedPaths.some((path) => /\.css$/i.test(path)) ||
      !/^\+[^+].*(?:\bbg-|\btext-|backgroundColor|\bcolor\b)/m.test(input.diff))
    return undefined;
  const wantsBackground = /\b(?:background|baggrund|mørk|dark|marineblå|green|grøn|cta)\b/i.test(input.task);
  const wantsText = /\b(?:text|tekst|color|colour|farve|lys|light)\b/i.test(input.task);
  if (!wantsBackground && !wantsText) return undefined;
  for (const { path, content } of input.stylesheets) {
    for (const match of content.matchAll(/([^{}]+)\{([^{}]+)\}/g)) {
      const selectors = match[1]!;
      if (!/(?:^|,)\s*(?:html\s+)?(?:body\s+)?\*(?:\s|:|,|$)/i.test(selectors)) continue;
      const declarations = match[2]!;
      const blocksBackground = wantsBackground && /(?:^|;)\s*background(?:-color)?\s*:[^;]*!important\b/i.test(declarations);
      const blocksText = wantsText && /(?:^|;)\s*color\s*:[^;]*!important\b/i.test(declarations);
      if (blocksBackground || blocksText)
        return `${path} contains a broad ${selectors.trim().replace(/\s+/g, " ")} rule with ` +
          `${[blocksBackground && "background", blocksText && "text color"].filter(Boolean).join(" and ")} !important; ` +
          "the unchanged stylesheet overrides the candidate's ordinary utility/inline colors. The requested visual change is not proved.";
    }
  }
  return undefined;
}

const isBaselineKnownFailure = (
  check: VerificationResult["checks"][number],
) =>
  check.outcome === "CHECK_FAIL" &&
  check.source?.endsWith(":baseline_unchanged") === true;

function changedDiffLines(diff: string, prefix: "+" | "-") {
  return diff.split("\n")
    .filter((line) => line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}${prefix}`))
    .map((line) => line.slice(1));
}

/**
 * Prove a mechanical one-file replacement without a probabilistic reviewer.
 * No additional source delta is accepted, and deterministic checks must pass.
 */
export function deterministicLiteralCompletionReview(
  input: CompletionReviewInput,
): CompletionReview | undefined {
  const replacement = explicitLiteralReplacement(input.task);
  const desired = explicitDesiredLiteral(input.task);
  if ((!replacement || !isOnlyLiteralReplacementTask(input.task)) &&
      (!desired || !isOnlyLocalizedCopyTask(input.task))) return undefined;
  if (
      input.workerExitStatus !== "completed" || input.changedPaths.length !== 1)
    return undefined;
  if (!input.verification.checks.length || input.verification.checks.some((check) =>
    check.outcome !== "CHECK_PASS" && !isBaselineKnownFailure(check))) return undefined;

  const exact = input.fileChanges?.length === 1 ? input.fileChanges[0] : undefined;
  const removed = changedDiffLines(input.diff, "-");
  const added = changedDiffLines(input.diff, "+");
  if (exact?.before !== undefined && exact.after !== undefined) {
    let change: string | undefined;
    if (replacement && exact.before.includes(replacement.oldLiteral) &&
        exact.after === exact.before.split(replacement.oldLiteral).join(replacement.newLiteral)) {
      change = `${JSON.stringify(replacement.oldLiteral)} -> ${JSON.stringify(replacement.newLiteral)}`;
    } else if (!replacement && desired) {
      const before = exact.before;
      const after = exact.after;
      let prefix = 0;
      while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
      let suffix = 0;
      while (suffix < before.length - prefix && suffix < after.length - prefix &&
        before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
      const oldMiddle = before.slice(prefix, before.length - suffix);
      const newMiddle = after.slice(prefix, after.length - suffix);
      if (oldMiddle && newMiddle === desired)
        change = `${JSON.stringify(oldMiddle)} -> ${JSON.stringify(desired)}`;
    }
    if (change) {
      const evidence = `The exact attempt-local file contents contain only the localized copy replacement ${change} in ${exact.path}; required deterministic checks passed.`;
      return {
        passed: true,
        requirements: input.requirements.map(({ id }) => ({ id, satisfied: true, evidence })),
        summary: "Exact localized replacement proved from attempt-local contents and deterministic verification.",
      };
    }
  }
  if (!removed.length || removed.length !== added.length) return undefined;
  let change: string;
  if (replacement) {
    if (!removed.some((line) => line.includes(replacement.oldLiteral)) ||
        !added.some((line) => line.includes(replacement.newLiteral))) return undefined;
    const expected = removed
      .map((line) => line.split(replacement.oldLiteral).join(replacement.newLiteral))
      .sort();
    const actual = [...added].sort();
    if (expected.some((line, index) => line !== actual[index])) return undefined;
    change = `${JSON.stringify(replacement.oldLiteral)} -> ${JSON.stringify(replacement.newLiteral)}`;
  } else {
    if (removed.length !== 1 || added.length !== 1 || !desired) return undefined;
    const before = removed[0]!;
    const after = added[0]!;
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
    let suffix = 0;
    while (suffix < before.length - prefix && suffix < after.length - prefix &&
      before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
    const oldMiddle = before.slice(prefix, before.length - suffix);
    const newMiddle = after.slice(prefix, after.length - suffix);
    if (!oldMiddle || newMiddle !== desired) return undefined;
    change = `${JSON.stringify(oldMiddle)} -> ${JSON.stringify(desired)}`;
  }

  const evidence = `The complete source diff contains only the exact localized copy replacement ${change} in ${input.changedPaths[0]}; required deterministic checks passed.`;
  return {
    passed: true,
    requirements: input.requirements.map(({ id }) => ({ id, satisfied: true, evidence })),
    summary: "Exact localized replacement proved from the complete diff and deterministic verification.",
  };
}

const parts = (value: string) => value
  .split(/\n+|(?<=[.!?])\s+(?=[A-ZÆØÅ0-9])/)
  .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
  .filter((line) => line.length >= 3);

function withoutTrailingVerification(value: string) {
  // A common one-sentence task combines a real implementation constraint
  // with "and verify the change". Keep the constraint in completion review;
  // deterministic verification owns the trailing instruction after coding.
  return value.replace(
    /(?:\s+(?:and|og|then|samt)\s*|[,;]\s*)(?:(?:verify|validate|check|verific[eé]r|kontroll[eé]r)\s+(?:(?:the|this|den|det)\s+)?(?:changes?|implementation|result|ændringen|resultatet|løsningen|it|them|den|det|dem)|(?:run|execute|kør)\s+(?:(?:the|de|alle)\s+)?(?:(?:relevant|required|focused)\s+)?(?:tests?|lint|typecheck|build|syntax[- ]?checks?)\b)[^.!?]*([.!?]?)$/i,
    "$1",
  ).trim();
}

function isVerificationOnlyRequirement(value: string) {
  const text = value.trim().replace(/[.!]+$/, "");
  if (/^(?:verify|validate|check|verific[eé]r|kontroll[eé]r)\s+(?:(?:the|this|den|det)\s+)?(?:changes?|implementation|result|ændringen|resultatet|løsningen|it|them|den|det|dem)$/i.test(text))
    return true;
  const namesChecks =
    /\b(?:lint|type[- ]?check|syntax[- ]?checks?|node --check|build|tests?|test suite|unit tests?|integration tests?|pytest|vitest|jest|eslint|tsc|cargo test|go test)\b|\b(?:test(?:ene)?|byg(?:ning|get)?|typekontrol)\b/i.test(text);
  if (!namesChecks) return false;
  const requestsImplementation =
    /\b(?:add|create|implement|fix|repair|change|update|modify|write|remove|refactor|wire|cover(?:age|s|ed|ing)?|assert(?:s|ion)?|produce[sd]?|generate[sd]?|tilføj|opret|implementer|fiks|ret|ændr|opdater|fjern|skriv|dæk(?:ker|ning)?)\b/i.test(text);
  if (requestsImplementation) return false;
  return /^(?:run|execute|verify|validate|check|ensure|kør|koer|verificer|kontrollér)\b/i.test(text) ||
    /\b(?:must|should|skal)\s+(?:all\s+)?(?:pass|succeed|be green|bestå)\b/i.test(text) ||
    /\b(?:pass|passes|passing|succeed|succeeds|green|bestå|består)\s*$/i.test(text);
}

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
  const unique = values.map(withoutTrailingVerification).filter((value) => {
    if (!value) return false;
    // These commands remain authoritative, but deterministic verification
    // executes them. They are not missing implementation and cannot justify a
    // second coding mutation merely because final verification has not run yet.
    if (isVerificationOnlyRequirement(value)) return false;
    const key = value.toLocaleLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  const protocolFailure = typeof parsed.passed !== "boolean" || requirements.some((item) => !byId.has(item.id)) || assessments.some((item) => !item.evidence.trim()) || (parsed.passed === false && normalized.every((item) => item.satisfied));
  const passed = !protocolFailure && parsed.passed === true && normalized.every((item) => item.satisfied);
  return {
    passed,
    ...(protocolFailure ? { protocolFailure: true } : {}),
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
    ...(allSatisfied && explicitOverallFailure ? { protocolFailure: true } : {}),
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

  // A truncated JSON object can mention every requirement and contain many
  // `false` values. Treat it as a protocol failure, never as prose evidence
  // that each requirement is actually missing.
  const looksLikeJson = /^\s*(?:```(?:json)?\s*)?\{|\"requirements\"\s*:/.test(raw);
  const prose = looksLikeJson ? undefined : parseStructuredProse(raw, requirements);
  if (prose) return prose;

  // A reviewer formatting failure is operational evidence, not proof that the
  // candidate is wrong. Return an explicit unresolved review instead of
  // throwing; the executor retries the review protocol before considering repair.
  return {
    protocolFailure: true,
    passed: false,
    requirements: requirements.map((requirement) => ({
      id: requirement.id,
      satisfied: false,
      evidence: "Completion reviewer returned unstructured output; semantic assessment unavailable",
    })),
    summary: "Completion review output was not parseable as structured JSON or requirement-labelled prose.",
  };
}

/** A known baseline/environment failure is not evidence of missing code.
 * Retry the semantic assessment, never convert it to a pass automatically. */
export function completionReviewContradictsVerification(
  input: CompletionReviewInput,
  review: CompletionReview,
) {
  const rejected = review.requirements.filter((item) => !item.satisfied);
  return rejected.length > 0 && rejected.every((item) => {
    if (input.changedPaths.some((path) => item.evidence.includes(path))) return false;
    return input.verification.checks.some((check) =>
      (isBaselineKnownFailure(check) || check.outcome === "INFRA_FAILURE" ||
        check.outcome === "CHECK_UNAVAILABLE") &&
      item.evidence.includes(check.command) && !input.task.includes(check.command));
  });
}

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
      kind: check.kind,
      source: check.source,
      stdout: check.stdout?.replace(/^.*\bduration_ms(?:\s|:).*(?:\n|$)/gm, "").slice(0, 2000),
      stderr: check.stderr?.slice(0, 1000),
    }));

  const maxDiffChars = 12_000;
  const diff = input.diff.length <= maxDiffChars
    ? input.diff
    : [
        input.diff.slice(0, maxDiffChars / 2),
        `\n... ${input.diff.length - maxDiffChars} diff characters omitted from the bounded review packet ...\n`,
        input.diff.slice(-maxDiffChars / 2),
      ].join("");

  return [
    {
      role: "system" as const,
      content:
        "Independently review task completion from fresh evidence. Passing tests alone never prove an untested requirement. Independently check the public return contract: scalar versus collection, value versus selected records, units and shape. Candidate-authored assertions may encode the same mistake as the implementation; derive the expected return contract from the original task and existing API, not those assertions. If the return contract is ambiguous and no authoritative evidence resolves it, do not claim it is proved. Compare public identifiers, dispatch keys, exports and routes against the original task exactly; tests using candidate-invented names are not evidence that the requested public contract works. Trace the public entry point to the implementation, not only internal helpers. Mark a requirement satisfied only when the candidate diff, changed paths, bounded repository evidence, or a directly relevant verification result proves it. Repository evidence is pre-attempt content and may prove that a requested requirement was already present; do not demand a redundant mutation for it and do not describe unchanged evidence as candidate-authored work. For visual requirements, account for the CSS cascade: class names alone do not prove a browser-visible effect when broader rules override or hide them. The deterministic verifier is authoritative for regression attribution and for running requested lint, typecheck, build, and test commands. PENDING_FINAL_VERIFICATION means those required commands run after this implementation review; assess the code now, and do not reject solely because the commands have not run yet. Their final results independently gate VERIFIED_SUCCESS. Entries in baselineKnownFailures were already failing before this candidate and were not made worse by it. Do not mark a requirement unsatisfied solely because baselineKnownFailures is non-empty, unless the original task explicitly requires fixing that exact pre-existing failure. Planner-generated acceptance criteria do not add a requirement to fix pre-existing repository/environment failures. A coding repair requires concrete evidence of missing implementation, not just a failed or not-yet-run command. Return exactly one JSON object and no markdown: {\"passed\":boolean,\"requirements\":[{\"id\":string,\"satisfied\":boolean,\"evidence\":string}],\"summary\":string}.",
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        originalTask: input.task,
        requirements: input.requirements,
        changedPaths: input.changedPaths,
        changedSymbols: input.changedSymbols,
        toolEvidence: input.toolEvidence?.slice(0, 2_000) ?? null,
        repositoryEvidence: input.repositoryEvidence?.slice(0, 8).map((file) => ({
          path: file.path,
          snippet: file.snippet.slice(0, 2_000),
        })) ?? [],
        worker: {
          exitStatus: input.workerExitStatus,
          terminationReason: input.workerTerminationReason ?? null,
        },
        verification: {
          status: input.verificationDeferred ? "PENDING_FINAL_VERIFICATION" : input.verification.status,
          checks,
          baselineKnownFailures,
        },
        cascadeConflict: input.cascadeConflict ?? null,
        diff,
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
    if (event.type === "completion_review_failure") {
      unresolved.set(String(event.subtaskId ?? "unknown-subtask"), ["review_unavailable"]);
      continue;
    }
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
  const baselineRelativeSuccess = finalStatus === "CANDIDATE_NEUTRAL" || finalStatus === "CANDIDATE_IMPROVEMENT";
  return {
    status: unresolved.length
      ? "NOT_FULLY_VERIFIED" as const
      : baselineRelativeSuccess ? "VERIFIED_SUCCESS" as const : finalStatus,
    unresolved,
  };
}

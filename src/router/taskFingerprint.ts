import { extname } from "node:path";
import type { Subtask } from "../planner/schemas.js";
import type { RepoProfile, VerificationResult } from "../types.js";
import { routingTaskText, type Features } from "./features.js";

export type TaskKind =
  | "implementation" | "debugging" | "frontend_ui" | "backend" | "fullstack"
  | "testing" | "refactor" | "architecture" | "review" | "repo_scanning"
  | "shell" | "devops" | "sql_database" | "documentation";
export type Difficulty = "low" | "medium" | "high";
export interface TaskDifficulty {
  technicalComplexity: Difficulty;
  visualComplexity: Difficulty;
  architecturalComplexity: Difficulty;
  interactionComplexity: Difficulty;
  repoReasoningComplexity: Difficulty;
  changeRisk: Difficulty;
  contextUncertainty: Difficulty;
}
export interface TaskFingerprint {
  primary: TaskKind;
  secondary: TaskKind[];
  languages: string[];
  frameworks: string[];
  scope: "single" | "localized" | "multi-file" | "cross-component";
  effort: "tiny" | "normal" | "complex";
  executionStrategy: string;
  visualRelevant: boolean;
  browserRelevant: boolean;
  terminalHeavy: boolean;
  repoReasoningHeavy: boolean;
  architectureHeavy: boolean;
  toolsRequired: boolean;
  visionRequired: boolean;
  verificationStrength: "strong" | "medium" | "weak";
  taskType?: Features["taskType"];
  localizationConfidence?: Features["localizationConfidence"];
  expectedFiles?: number;
  repoComplexity?: Features["repoSizeBucket"];
  contextRequirementTokens?: number;
  observedCheckFailures?: number;
  difficulty: TaskDifficulty;
  confidence: "high" | "medium";
  reasons: string[];
}

/** Deterministic, per-subtask classification; no model call or history lookup. */
export function taskFingerprint(
  subtask: Subtask,
  profile: RepoProfile,
  features: Features,
  effort: "tiny" | "normal" | "complex",
  verification?: VerificationResult,
): TaskFingerprint {
  const text = routingTaskText(subtask);
  const paths = [...subtask.likelyReadPaths, ...subtask.likelyWritePaths];
  const kinds: TaskKind[] = [];
  const add = (kind: TaskKind, yes: boolean) => { if (yes) kinds.push(kind); };
  // Capability requirements describe the worker's objective, not incidental
  // filenames, parent-task context, or generic planner words like "component".
  const frontend = /\b(?:ui|ux|frontend|react|vue|svelte|css|styling|layout|responsive|browser)\b/.test(text);
  const backend = /\b(?:backend|api|server|endpoint|service|controller)\b/.test(text);
  add("architecture", /\b(?:architect|migration|schema redesign|system design)\b/.test(text));
  add("sql_database", /\b(?:sql|database|postgres|sqlite|query|migration)\b/.test(text));
  add("devops", /\b(?:deploy|docker|kubernetes|ci|pipeline|terraform|infra)\b/.test(text));
  add("fullstack", frontend && backend);
  add("frontend_ui", frontend && !backend);
  add("backend", backend && !frontend);
  add("debugging", /\b(?:debug|bug|trace|investigat|diagnos|fix|repair)\w*\b/.test(text));
  add("testing", /\b(?:test|regression|spec|coverage)\w*\b/.test(text));
  add("refactor", /\brefactor\w*\b/.test(text));
  add("review", /\breview\w*\b/.test(text));
  add("repo_scanning", /\b(?:scan|search|inspect)\w*\b/.test(text) ||
    /\bfind\b.{0,40}\b(?:files?|modules?|references?|usages?)\b/.test(text));
  add("shell", /\b(?:shell|command|script|bash)\b/.test(text));
  add("documentation", paths.some((p) => /\.(?:md|mdx|rst|txt)$/i.test(p)) || /\b(?:readme|documentation|docs)\b/.test(text));
  const primary: TaskKind = features.isTestWork ? "testing"
    : kinds.includes("debugging") ? "debugging"
    : kinds.includes("refactor") ? "refactor"
    : /\b(?:implement|add|build|create|introduce)\b/i.test(text) &&
        !/^\s*(?:add|create|write)\s+(?:focused\s+)?(?:tests?|regression\s+tests?)\b/i.test(text)
      ? "implementation"
      : kinds[0] ?? "implementation";
  const scope = features.requiresCrossModuleReasoning
    ? "cross-component"
    : features.implementationFiles === 1 && subtask.likelyWritePaths.length > 1 && subtask.likelyWritePaths.length <= 3 ? "localized"
    : subtask.likelyWritePaths.length > 1 ? "multi-file"
    : subtask.likelyWritePaths.length === 1 ? "single" : "localized";
  const visualRelevant = /\b(?:visual|design|screenshot|image|pixel|layout|spacing|styling|responsive|appearance|color)\b/.test(text);
  const visionRequired = /\b(?:inspect|compare|read|analy[sz]e)\b.{0,40}\b(?:screenshot|image|picture)\b/.test(text);
  const checks = verification?.checks ?? [];
  // Generic build/typecheck is not evidence that subjective UI or prose meets the task.
  const subjective = (visualRelevant && /\b(?:polish|redesign|design|look|feel|layout|spacing|color|visual|style|appearance|interface)\b/.test(text)) || kinds.includes("documentation");
  const focusedCheck = [...subtask.verificationCommands, ...checks.filter((check) =>
    check.outcome === "CHECK_PASS" || check.outcome === "CHECK_FAIL",
  ).map((check) => check.command)].some((command) =>
    /(?:^|\s)(?:[^\s]*\btests?\/|[^\s]+\.(?:test|spec)\.[cm]?[jt]sx?|(?:[^\s]*\/)?test_[^\s]+\.py|[^\s]+_test\.(?:py|go|rs|rb)|[^\s]+\.py::[^\s]+|[^\s]+\.spec\.rb)/.test(command) &&
    !/[\*?]/.test(command));
  const verificationStrength = subjective && !focusedCheck ? "weak"
    : focusedCheck && checks.some((c) => c.outcome === "CHECK_PASS" || c.outcome === "CHECK_FAIL") ? "strong"
    : focusedCheck || checks.length || profile.verificationCommands.length ? "medium" : "weak";
  const high = (pattern: RegExp) => pattern.test(text);
  const architecture = high(/\b(?:architect|migration|migrate|redesign|restructure|schema|cross.module)\w*\b/);
  const stateFlow = high(/\b(?:state|data.flow|concurren|race.condition|distributed|auth|transaction)\w*\b/);
  const interactions = high(/\b(?:interactive|animation|drag|workflow|form|navigation|accessibility)\w*\b/);
  const technical: Difficulty = architecture || (stateFlow && scope !== "single") || effort === "complex" ? "high"
    : stateFlow || (kinds.includes("debugging") && !(focusedCheck && scope === "single")) || scope === "multi-file" ? "medium" : "low";
  const difficulty: TaskDifficulty = {
    technicalComplexity: technical,
    visualComplexity: visualRelevant ? high(/\b(?:redesign|design.system|complex.layout|pixel.perfect)\b/) ? "high" : "medium" : "low",
    architecturalComplexity: architecture ? "high" : scope === "multi-file" ? "medium" : "low",
    interactionComplexity: interactions && architecture ? "high" : interactions || stateFlow ? "medium" : "low",
    repoReasoningComplexity: scope === "cross-component" ? "high" : scope === "multi-file" || kinds.includes("repo_scanning") ? "medium" : "low",
    changeRisk: high(/\b(?:security|auth|payment|database|migration|production|breaking)\b/) ? "high" : scope === "cross-component" ? "medium" : "low",
    contextUncertainty: features.localizationConfidence === "low" ? "high"
      : features.localizationConfidence === "medium" || kinds.includes("repo_scanning") ? "medium" : "low",
  };
  const reasons = [`${primary} from worker objective`, `${scope} write scope`, `${features.localizationConfidence} localization confidence`, `${verificationStrength} executable verification evidence`];
  return {
    primary, secondary: kinds.filter((kind) => kind !== primary),
    languages: [...new Set([...features.languages, ...paths.map(extname).filter((ext) => ext === ".sql").map(() => "sql")])],
    frameworks: features.frameworks,
    scope, effort, executionStrategy: features.executionStrategy,
    visualRelevant, browserRelevant: /\b(?:browser|playwright|puppeteer|web page)\b/.test(text),
    terminalHeavy: kinds.includes("shell") || kinds.includes("devops"),
    repoReasoningHeavy: scope === "cross-component" || kinds.includes("repo_scanning"),
    architectureHeavy: kinds.includes("architecture") || features.requiresArchitectureReasoning,
    toolsRequired: !subtask.readOnly,
    visionRequired, verificationStrength, difficulty,
    taskType: features.taskType,
    localizationConfidence: features.localizationConfidence,
    expectedFiles: features.estimatedFiles,
    repoComplexity: features.repoSizeBucket,
    contextRequirementTokens: Math.ceil(features.contextBytes / 4),
    observedCheckFailures: checks.filter((check) => check.outcome === "CHECK_FAIL").length,
    confidence: features.localizationConfidence === "high" ? "high" : "medium",
    reasons,
  };
}

import { extname } from "node:path";
import type { Subtask } from "../planner/schemas.js";
import type { RepoProfile, VerificationResult } from "../types.js";
import { routingTaskText, type Features } from "./features.js";
import { routingTerms } from "./knowledge/contextual.js";

export type TaskKind =
  | "implementation" | "debugging" | "frontend_ui" | "backend" | "fullstack"
  | "testing" | "refactor" | "architecture" | "review" | "repo_scanning"
  | "shell" | "devops" | "sql_database" | "documentation";
export type Difficulty = "low" | "medium" | "high";
export type TaskFamily = "localized_bugfix" | "debugging" | "test_change" | "refactor" |
  "frontend_ui" | "backend_api" | "database" | "architecture" | "devops" |
  "documentation" | "multi_component";
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
  taskFamily?: TaskFamily;
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
  scopeUncertainty?: Difficulty;
  focusedFailingReproduction?: boolean;
  targetedExecutableVerification?: boolean;
  broaderProjectVerification?: boolean;
  likelyComponents?: number;
  crossComponent?: boolean;
  publicApiRisk?: boolean;
  schemaRisk?: boolean;
  configRisk?: boolean;
  concurrencyRisk?: boolean;
  decompositionConfidence?: "high" | "medium" | "low";
  taskType?: Features["taskType"];
  localizationConfidence?: Features["localizationConfidence"];
  expectedFiles?: number;
  repoComplexity?: Features["repoSizeBucket"];
  contextRequirementTokens?: number;
  observedCheckFailures?: number;
  /** Semantic work required to produce the patch; consequence is separate. */
  semanticComplexity?: Difficulty;
  /** Uncertainty about where the change belongs, derived from inspected scope. */
  localizationUncertainty?: Difficulty;
  /** Expected code surface affected by the bounded repository scope. */
  blastRadius?: "single-file" | "package" | "cross-component";
  architecturalCoupling?: Difficulty;
  /** Impact if a bad patch escaped verification. */
  consequenceRisk?: Difficulty;
  /** Chance that available checks accept an incorrect solution. */
  verifierFalseAcceptRisk?: Difficulty;
  /** How reliably a failed attempt can be detected before integration. */
  recoveryDetectability?: "low" | "medium" | "high";
  toolExplorationNeed?: Difficulty;
  executionEngineComplexity?: Difficulty;
  operationalRisk?: Difficulty;
  difficulty: TaskDifficulty;
  confidence: "high" | "medium";
  reasons: string[];
  /** Bounded deterministic task signature used by the local cold-start router. */
  routingTerms?: string[];
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
  const repoRisk = (pattern: RegExp) => pattern.test(`${text} ${paths.join(" ")}`);
  const architecture = high(/\b(?:architect|migration|migrate|redesign|restructure|schema|cross.module)\w*\b/);
  const concurrency = repoRisk(/\b(?:concurren|race.condition|synchron|deadlock|atomic)\w*\b/);
  const interactions = high(/\b(?:interactive|animation|drag|workflow|form|navigation|accessibility)\w*\b/);
  const localizedEvidence = features.localizationConfidence === "high";
  const architecturalCoupling: Difficulty = scope === "cross-component" ? "high"
    : features.requiresCrossModuleReasoning || subtask.dependsOn.length > 0 ? "medium" : "low";
  // File count and words such as "transaction" describe surface/consequence,
  // not the semantic reasoning needed for a repository-grounded, localized fix.
  const technical: Difficulty = architecture ||
      (effort === "complex" && !localizedEvidence) ? "high"
    : concurrency || architecturalCoupling !== "low" ||
        (kinds.includes("debugging") && !focusedCheck && !localizedEvidence)
      ? "medium" : "low";
  // A requirement to preserve an API is a constraint against API change, not
  // evidence that the candidate is expected to alter that API. Require an
  // affirmative mutation verb near the interface vocabulary.
  const publicApiRisk = repoRisk(
    /\b(?:change|modify|add|remove|rename|replace|break|migrate|expose|publish)\w*\b.{0,48}\b(?:public\s+api|exported\s+(?:api|interface)|endpoint|contract)\b|\b(?:public\s+api|exported\s+(?:api|interface)|endpoint|contract)\b.{0,48}\b(?:change|modify|add|remove|rename|replace|break|migrate|expose|publish)\w*\b/,
  );
  const schemaRisk = repoRisk(/\b(?:schema|migration|database|protocol)\w*\b/);
  const configRisk = repoRisk(/\b(?:config|configuration|manifest)\w*\b/);
  const securityRisk = repoRisk(/\b(?:security|auth|permission|credential|secret|crypto|payment)\w*\b/);
  const consequenceRisk: Difficulty = publicApiRisk || schemaRisk || concurrency || securityRisk
    ? "high" : scope === "cross-component" ? "medium" : "low";
  const observedExecutableCheck = checks.some((check) =>
    check.outcome === "CHECK_PASS" || check.outcome === "CHECK_FAIL");
  const verifierFalseAcceptRisk: Difficulty = subjective || !focusedCheck ? "high"
    : observedExecutableCheck && profile.verificationCommands.length > 0 ? "low" : "medium";
  const recoveryDetectability = verifierFalseAcceptRisk === "low" ? "high" as const
    : focusedCheck ? "medium" as const : "low" as const;
  const blastRadius = scope === "cross-component" ? "cross-component" as const
    : scope === "single" ? "single-file" as const : "package" as const;
  const localizationUncertainty: Difficulty = features.localizationConfidence === "low" ? "high"
    : features.localizationConfidence === "medium" ? "medium" : "low";
  const toolExplorationNeed: Difficulty = localizationUncertainty === "high" ? "high"
    : (kinds.includes("repo_scanning") && !localizedEvidence) ||
        localizationUncertainty === "medium" ? "medium" : "low";
  const executionEngineComplexity: Difficulty = features.executionStrategy === "stable" ? "high"
    : scope === "cross-component" || toolExplorationNeed !== "low" ? "medium" : "low";
  const operationalRisk: Difficulty = executionEngineComplexity === "high" ? "medium" : "low";
  const difficulty: TaskDifficulty = {
    technicalComplexity: technical,
    visualComplexity: visualRelevant ? high(/\b(?:redesign|design.system|complex.layout|pixel.perfect)\b/) ? "high" : "medium" : "low",
    architecturalComplexity: architecture ? "high" : architecturalCoupling,
    interactionComplexity: interactions && architecture ? "high" : interactions || concurrency ? "medium" : "low",
    repoReasoningComplexity: scope === "cross-component" ? "high" : toolExplorationNeed,
    changeRisk: consequenceRisk,
    contextUncertainty: localizationUncertainty,
  };
  const reasons = [`${primary} from worker objective`, `${scope} write scope`, `${features.localizationConfidence} localization confidence`, `${verificationStrength} executable verification evidence`];
  const taskFamily: TaskFamily = scope === "cross-component" || kinds.includes("fullstack") ? "multi_component"
    : primary === "debugging" && scope === "single" ? "localized_bugfix"
    : primary === "debugging" ? "debugging"
    : primary === "testing" ? "test_change"
    : primary === "frontend_ui" ? "frontend_ui"
    : primary === "backend" ? "backend_api"
    : primary === "sql_database" ? "database"
    : primary === "architecture" ? "architecture"
    : primary === "devops" ? "devops"
    : primary === "documentation" ? "documentation"
    : primary === "refactor" ? "refactor" : scope === "single" ? "localized_bugfix" : "multi_component";
  return {
    taskFamily,
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
    scopeUncertainty: difficulty.contextUncertainty,
    focusedFailingReproduction: focusedCheck && checks.some((check) => check.outcome === "CHECK_FAIL"),
    targetedExecutableVerification: focusedCheck,
    broaderProjectVerification: profile.verificationCommands.length > 0,
    likelyComponents: new Set(paths.map((path) => path.includes("/")
      ? path.split("/").slice(0, -1).join("/") : ".")).size,
    crossComponent: scope === "cross-component",
    publicApiRisk,
    schemaRisk,
    configRisk,
    concurrencyRisk: concurrency,
    decompositionConfidence: features.localizationConfidence === "low" ? "low"
      : scope === "cross-component" && subtask.dependsOn.length === 0 ? "medium" : "high",
    taskType: features.taskType,
    localizationConfidence: features.localizationConfidence,
    expectedFiles: features.estimatedFiles,
    repoComplexity: features.repoSizeBucket,
    contextRequirementTokens: Math.ceil(features.contextBytes / 4),
    observedCheckFailures: checks.filter((check) => check.outcome === "CHECK_FAIL").length,
    semanticComplexity: technical,
    localizationUncertainty,
    blastRadius,
    architecturalCoupling,
    consequenceRisk,
    verifierFalseAcceptRisk,
    recoveryDetectability,
    toolExplorationNeed,
    executionEngineComplexity,
    operationalRisk,
    confidence: features.localizationConfidence === "high" ? "high" : "medium",
    // Once concrete paths are known, keep task-neighborhood lookup stable
    // across prompt paraphrases by leading with repository facts. Prompt terms
    // remain useful only while localization is uncertain.
    routingTerms: [...new Set([
      ...routingTerms(`${taskFamily} ${primary} ${paths.join(" ")} ${features.languages.join(" ")}`),
      ...(features.localizationConfidence === "high" ? [] : routingTerms(text, 24)),
    ])].slice(0, 64),
    reasons,
  };
}

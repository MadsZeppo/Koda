import { extname } from "node:path";
import type { Subtask } from "../planner/schemas.js";
import type { RepoProfile, VerificationResult } from "../types.js";
import { routingTaskText, type Features } from "./features.js";
import { routingTerms } from "./knowledge/contextual.js";
import type { DeterministicTaskProfile } from "./taskProfiler.js";

export type TaskKind =
  | "implementation" | "debugging" | "frontend_ui" | "backend" | "fullstack"
  | "testing" | "refactor" | "architecture" | "review" | "repo_scanning"
  | "shell" | "devops" | "sql_database" | "documentation";
export type Difficulty = "low" | "medium" | "high";
export type TaskFamily = "localized_bugfix" | "debugging" | "test_change" | "refactor" |
  "frontend_ui" | "backend_api" | "database" | "architecture" | "devops" |
  "documentation" | "multi_component";

/**
 * Language-level visual intent shared by routing and deterministic UI scope
 * inference. Repository evidence still decides which paths may be edited.
 */
export function visualDesignTask(task: string): boolean {
  const explicitVisual =
    /\b(?:visual|design|redesign|screenshot|image|pixel|layout|spacing|styles?|styling|responsive|appearance|colou?r|theme|dark|black|background)\b|\b(?:visuel|design|redesign|skærmbillede|billede|layout|afstand|stil|styling|udseende|farve|tema|mørk|sort|baggrund)\b/i.test(task);
  const uiQualityRequest =
    /\b(?:ui|ux|interface|frontend|pages?|screens?|home ?page|landing page|front ?page|website|site|app|forside[nr]?|hjemmeside[nr]?|landingsside[nr]?|side[nr]?|skærm(?:en)?)\b/i.test(task) &&
    /\b(?:polish(?:ed)?|professional|beautiful|modern|premium|top[- ]?level|stripe[- ]?level|flot|professionel(?:t)?|moderne|eksklusiv(?:t)?)\b/i.test(task);
  return explicitVisual || uiQualityRequest;
}

export function broadVisualDesignTask(task: string): boolean {
  const broadSurface =
    /\b(?:whole|entire|all)\s+(?:app|application|site|website|ui|pages?|home ?page|landing page|front ?page)\b|\b(?:site|app)[- ]wide\b|\bglobal(?:ly)?\b[^.\n]{0,40}\b(?:ui|style|theme|color|background)\b|\b(?:hele\s+(?:appen|appens|sitet|websitet|hjemmesiden|sidens|ui|forsiden|landingssiden)|alle\s+sider|på\s+tværs\s+af\s+(?:appen|sitet|hjemmesiden)|overalt)\b/i.test(task);
  const sharedThemeControl =
    /\b(?:dark mode|light mode|theme (?:switch|toggle)|color scheme)\b|\b(?:mørk tilstand|lys tilstand|tema(?:skift|knap)|farvetema)\b/i.test(task) &&
    /\b(?:app|application|site|website|pages?|navigation)\b|\b(?:hjemmeside[nr]?|appen|sider|navigation)\b/i.test(task);
  return (broadSurface || sharedThemeControl) && visualDesignTask(task);
}
export interface TaskDifficulty {
  technicalComplexity: Difficulty;
  visualComplexity: Difficulty;
  architecturalComplexity: Difficulty;
  interactionComplexity: Difficulty;
  repoReasoningComplexity: Difficulty;
  changeRisk: Difficulty;
  contextUncertainty: Difficulty;
}

const evidenceRank = { low: 0, medium: 1, high: 2 } as const;
const stronger = <T extends keyof typeof evidenceRank>(a: T, b: T): T =>
  evidenceRank[a] >= evidenceRank[b] ? a : b;
const verificationRank = { weak: 0, medium: 1, strong: 2 } as const;
const strongerVerification = <T extends keyof typeof verificationRank>(
  a: T,
  b: T,
): T => (verificationRank[a] >= verificationRank[b] ? a : b);

/** Engine-local routing may add evidence, but cannot erase preflight facts. */
export function preserveCanonicalTaskEvidence(
  fingerprint: TaskFingerprint,
  evidence?: DeterministicTaskProfile,
  verification?: VerificationResult,
): TaskFingerprint {
  if (!evidence && !verification) return fingerprint;
  const observedChecks = verification?.checks.filter((check) =>
    check.outcome === "CHECK_PASS" || check.outcome === "CHECK_FAIL") ?? [];
  const observedFailures = observedChecks.filter(
    (check) => check.outcome === "CHECK_FAIL",
  ).length;
  const observedExecutable = observedChecks.length > 0;
  const verificationStrength = strongerVerification(
    fingerprint.verificationStrength,
    observedExecutable ? "strong" : (evidence?.verificationStrength ?? "weak"),
  );
  const localizationConfidence = stronger(
    fingerprint.localizationConfidence ?? "low",
    evidence?.scopeConfidence ?? "low",
  );
  const crossComponent = fingerprint.crossComponent || evidence?.crossComponent === true;
  const boundedReproduction =
    observedFailures > 0 &&
    localizationConfidence === "high" &&
    !crossComponent &&
    evidence?.expectedBlastRadius !== "cross-component";
  const groundedHighConsequence =
    fingerprint.publicApiRisk || fingerprint.schemaRisk ||
    fingerprint.architectureHeavy || evidence?.securitySensitive === true;
  const semantic = evidence?.semanticAssessment;
  const semanticComplexity: Difficulty = semantic
    ? semantic.semanticDifficulty === "easy"
      ? "low"
      : semantic.semanticDifficulty === "normal"
        ? "medium"
        : "high"
    : (fingerprint.semanticComplexity ??
      fingerprint.difficulty.technicalComplexity);
  const semanticStrongVerification =
    semantic?.verificationStrength === "strong" &&
    observedFailures > 0 &&
    !crossComponent &&
    semantic.expectedChangeSize !== "multi-component";
  const deterministicFrontierJustification =
    semanticComplexity === "high" &&
    verificationStrength === "weak" &&
    (fingerprint.architectureHeavy ||
      crossComponent ||
      fingerprint.publicApiRisk ||
      fingerprint.schemaRisk);
  const frontierJustified = semantic
    ? semantic.frontierJustified || deterministicFrontierJustification
    : fingerprint.frontierJustified;
  return {
    ...fingerprint,
    verificationStrength,
    concurrencyRisk: fingerprint.concurrencyRisk || evidence?.concurrencyRisk,
    publicApiRisk: fingerprint.publicApiRisk || evidence?.publicApiRisk,
    schemaRisk: fingerprint.schemaRisk || evidence?.schemaRisk,
    architectureHeavy:
      fingerprint.architectureHeavy || evidence?.architectureRisk === true,
    crossComponent,
    localizationConfidence,
    semanticComplexity,
    startingModelTier:
      semantic?.startingTier ?? fingerprint.startingModelTier,
    frontierJustified,
    semanticAssessmentConfidence:
      semantic?.confidence ?? fingerprint.semanticAssessmentConfidence,
    difficulty: {
      ...fingerprint.difficulty,
      technicalComplexity: semanticComplexity,
      repoReasoningComplexity:
        semantic?.repoReasoning ??
        fingerprint.difficulty.repoReasoningComplexity,
      contextUncertainty:
        semantic?.localizationDifficulty ??
        fingerprint.difficulty.contextUncertainty,
      changeRisk:
        groundedHighConsequence
          ? fingerprint.difficulty.changeRisk
          : (semantic?.consequenceRisk ??
            fingerprint.difficulty.changeRisk),
    },
    localizationUncertainty:
      semantic?.localizationDifficulty ??
      (localizationConfidence === "high"
        ? "low"
        : localizationConfidence === "medium"
          ? "medium"
          : "high"),
    toolExplorationNeed:
      semantic?.repoReasoning ?? fingerprint.toolExplorationNeed,
    targetedExecutableVerification:
      fingerprint.targetedExecutableVerification ||
      observedFailures > 0 ||
      (verificationStrength === "strong" && (evidence?.likelyTests.length ?? 0) > 0),
    broaderProjectVerification:
      fingerprint.broaderProjectVerification ||
      observedExecutable || (evidence?.verificationStrength ?? "weak") !== "weak",
    focusedFailingReproduction:
      fingerprint.focusedFailingReproduction || observedFailures > 0,
    observedCheckFailures: Math.max(
      fingerprint.observedCheckFailures ?? 0,
      observedFailures,
    ),
    consequenceRisk:
      groundedHighConsequence
        ? fingerprint.consequenceRisk
        : boundedReproduction
          ? "low"
          : (semantic?.consequenceRisk ?? fingerprint.consequenceRisk),
    verifierFalseAcceptRisk:
      boundedReproduction || semanticStrongVerification
        ? "low"
        : fingerprint.verifierFalseAcceptRisk,
    recoveryDetectability:
      fingerprint.recoveryDetectability === "high" ||
      verificationStrength === "strong"
        ? "high"
        : fingerprint.recoveryDetectability,
    blastRadius:
      fingerprint.blastRadius === "cross-component" ||
      evidence?.expectedBlastRadius === "cross-component"
        ? "cross-component"
        : fingerprint.blastRadius === "package" ||
            evidence?.expectedBlastRadius === "package"
          ? "package"
          : "single-file",
    reasons: [
      ...fingerprint.reasons,
      observedExecutable
        ? `canonical baseline verification preserved (${observedFailures} failing checks)`
        : "canonical preflight task evidence preserved across execution engines",
      ...(semantic
        ? [`semantic router: ${semantic.startingTier} (${semantic.reason})`]
        : []),
    ],
  };
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
  /** Semantic router recommendation; concrete model selection remains deterministic. */
  startingModelTier?: "cheap" | "strong" | "frontier";
  /** Frontier may start only when explicitly justified by semantic or hard-risk evidence. */
  frontierJustified?: boolean;
  semanticAssessmentConfidence?: number;
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
  /** The first worker pass is only localizing an unresolved bounded task. */
  boundedDiscovery?: boolean;
  /** Whether the inspected task contains genuinely independent workstreams. */
  parallelizability?: Difficulty;
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
  add("sql_database", /\b(?:sql|database|postgres|sqlite|migration)\b/.test(text) ||
    (/\bquery\b/.test(text) && !/\bquery[- ]?parameters?\b/.test(text)));
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
  const visualRelevant = visualDesignTask(text);
  const visionRequired = /\b(?:inspect|compare|read|analy[sz]e)\b.{0,40}\b(?:screenshot|image|picture)\b/.test(text);
  const checks = verification?.checks ?? [];
  // Generic build/typecheck is not evidence that subjective UI or prose meets the task.
  const subjective = (visualRelevant && /\b(?:polish|redesign|design|look|feel|layout|spacing|colou?r|visual|style|appearance|interface|professional|beautiful|premium|top[- ]?level|stripe[- ]?level|flot|professionel(?:t)?|moderne|udseende)\b/.test(text)) || kinds.includes("documentation");
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
  const repositoryBoundaryEvidence = [
    ...paths,
    ...(profile.ecosystem?.configFiles ?? []),
    ...(profile.ecosystem?.evidence ?? []).flatMap((item) => [item.source, item.fact]),
  ].join(" ").toLowerCase();
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
  const schemaRisk =
    high(/\b(?:schema|migration|database|protocol)\w*\b/) &&
    /(?:schema|migrations?|prisma|drizzle|typeorm|sequelize|alembic|django|sql(?:ite)?|postgres|database\.yml)/.test(
      repositoryBoundaryEvidence,
    );
  // Do not classify every file named config.ts as high-risk.
  // Configuration risk requires both an actual configuration mutation and
  // evidence of a sensitive configuration boundary.
  const configMutation =
    high(
      /\b(?:change|modify|add|remove|rename|replace|migrate|rewrite|rotate|expose|publish|update)\w*\b.{0,64}\b(?:config(?:uration)?|manifest|environment|env(?:ironment)?|settings?)\b|\b(?:config(?:uration)?|manifest|environment|env(?:ironment)?|settings?)\b.{0,64}\b(?:change|modify|add|remove|rename|replace|migrate|rewrite|rotate|expose|publish|update)\w*\b/i,
    );

  const sensitiveConfigBoundary =
    /(?:^|[\/_.-])(?:\.env(?:\.[^\/]+)?|secrets?|credentials?|auth|security|deploy|deployment|terraform|kubernetes|docker|helm|github\/workflows)(?:[\/_.-]|$)/i.test(
      repositoryBoundaryEvidence,
    );

  const configRisk = configMutation && sensitiveConfigBoundary;

  const securityRisk =
    high(/\b(?:security|auth|permission|credential|secret|crypto|payment)\w*\b/) &&
    /(?:oauth|openid|jwt|crypt|credentials?|secrets?|permissions?|polic(?:y|ies)|acl|security(?:\/|\.|$)|middleware)/.test(
      repositoryBoundaryEvidence,
    );
  const hazardousConcurrency = concurrency &&
    (scope === "cross-component" || !focusedCheck);
  const consequenceRisk: Difficulty = publicApiRisk || schemaRisk || hazardousConcurrency || securityRisk
    ? "high" : scope === "cross-component" ? "medium" : "low";
  const observedExecutableCheck = checks.some((check) =>
    check.outcome === "CHECK_PASS" || check.outcome === "CHECK_FAIL");
  const hasDeterministicVerification =
    observedExecutableCheck ||
    profile.verificationCommands.length > 0 ||
    subtask.verificationCommands.length > 0;

  const verifierFalseAcceptRisk: Difficulty =
    subjective
      ? (focusedCheck || hasDeterministicVerification ? "medium" : "high")
      : hasDeterministicVerification
        ? (observedExecutableCheck && focusedCheck ? "low" : "medium")
        : "medium";

  const recoveryDetectability =
    verifierFalseAcceptRisk === "low"
      ? "high" as const
      : hasDeterministicVerification
        ? "medium" as const
        : focusedCheck
          ? "medium" as const
          : "low" as const;

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
  const parallelizability: Difficulty =
    features.executionStrategy === "planned" &&
    subtask.parallelSafe &&
    subtask.dependsOn.length === 0 &&
    (scope === "cross-component" || features.estimatedFiles > 1)
      ? "high"
      : features.executionStrategy === "planned" && scope !== "single"
        ? "medium"
        : "low";
  const boundedDiscovery =
    features.executionStrategy === "direct" &&
    subtask.likelyWritePaths.length === 1 &&
    subtask.likelyWritePaths[0] === ".";
  const difficulty: TaskDifficulty = {
    technicalComplexity: technical,
    visualComplexity: visualRelevant ? high(/\b(?:redesign|design.system|complex.layout|pixel.perfect|top[- ]?level|stripe[- ]?level|professionel(?:t)?)\b/) ? "high" : "medium" : "low",
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
    parallelizability,
    boundedDiscovery,
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

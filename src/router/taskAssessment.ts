import { z } from "zod";
import { collectSecurityEvidence } from "./securityEvidence.js";
import { compileTaskSpec } from "../planner/taskSpec.js";
import {
  explicitLiteralReplacement,
  isOnlyLiteralReplacementTask,
} from "../agent/literalEdit.js";
import { semanticTaskAssessmentSchema } from "./taskInterpreter.js";
import type { SemanticTaskAssessment } from "./taskProfiler.js";

export const assessmentLabels = {
  implementationComplexity: ["trivial", "low", "medium", "high"],
  localizationDifficulty: ["easy", "medium", "hard"],
  scope: ["tiny", "local", "multi_file", "cross_component"],
  consequenceRisk: ["low", "medium", "high"],
  verificationStrength: ["weak", "medium", "strong"],
} as const;
export const riskNames = [
  "security",
  "concurrency",
  "database",
  "publicApi",
  "config",
  "architecture",
  "destructive",
] as const;
const probability = z.number().finite().min(0).max(1);
const riskSchema = z.object(
  Object.fromEntries(riskNames.map((name) => [name, z.boolean()])) as Record<
    (typeof riskNames)[number],
    z.ZodBoolean
  >,
);
export const taskAssessmentSchema = z.object({
  version: z.literal(1),
  implementationComplexity: z.enum(assessmentLabels.implementationComplexity),
  localizationDifficulty: z.enum(assessmentLabels.localizationDifficulty),
  scope: z.enum(assessmentLabels.scope),
  consequenceRisk: z.enum(assessmentLabels.consequenceRisk),
  verificationStrength: z.enum(assessmentLabels.verificationStrength),
  riskFlags: riskSchema,
  artifactRequirements: z.object({
    requiresNewFiles: z.boolean(),
    requiresTests: z.boolean(),
  }),
  confidence: z.object({
    overall: probability,
    implementationComplexity: probability,
    localizationDifficulty: probability,
    scope: probability,
    consequenceRisk: probability,
    verificationStrength: probability,
  }),
  evidence: z.array(
    z.object({
      dimension: z.string(),
      source: z.enum([
        "prompt",
        "task_spec",
        "repo",
        "localization",
        "baseline",
        "semantic",
      ]),
      description: z.string(),
      strength: z.enum(["weak", "medium", "strong"]),
    }),
  ),
  securityAssessment: z.object({
    candidate: z.boolean(),
    resolution: z.enum(["security", "non_security", "unresolved"]),
    confidence: probability,
  }),
  projectHealthEvidence: z.array(
    z.object({ command: z.string(), kind: z.string(), outcome: z.string() }),
  ),
  disagreements: z.array(
    z.object({
      dimension: z.string(),
      deterministic: z.string(),
      semantic: z.string(),
      resolution: z.string(),
    }),
  ),
  mode: z.enum(["deterministic-only", "semantic-assisted"]),
  semanticRecommended: z.boolean(),
});
export type TaskAssessmentV1 = z.infer<typeof taskAssessmentSchema>;
export interface AssessmentFacts {
  files: string[];
  resolvedPaths: string[];
  relatedTests: string[];
  /** Repository/evidence-backed boundaries, not keyword guesses. */
  components: string[];
  localizationConfidence: "high" | "medium" | "low";
  checks: {
    command: string;
    kind: string;
    outcome: string;
    taskSpecific?: boolean;
  }[];
  behavioralEvidence?: "targeted_tests" | "exact_output" | "structural";
  /** Data facts normally obtained from repository profiling. */
  languages?: string[];
  frameworks?: string[];
}
export interface AssessmentInput {
  task: string;
  facts: AssessmentFacts;
  semantic?: SemanticTaskAssessment;
  taskSpec?: ReturnType<typeof compileTaskSpec>;
}
const stripQuotes = (text: string) =>
  text.replace(/`[^`]*`|"[^"\n]*"|'[^'\n]*'/g, " ");

/** Pure shadow assessment: no model calls, I/O, budgets or routing mutations. */
// V1 root cause: security used isolated phrase matches, so validation of an
// authenticity boundary with a shared secret became only a low-confidence hint.
// Semantic merge also had no security-specific result. Resolve action + boundary
// evidence explicitly; vocabulary or an authentication filename alone is not intent.
export function assessTask(input: AssessmentInput): TaskAssessmentV1 {
  const { facts } = input;
  const spec = input.taskSpec ?? compileTaskSpec(input.task);
  const intent = stripQuotes(input.task).toLowerCase();
  const paths = [...new Set(facts.resolvedPaths)];
  const grounded = paths.length > 0 && facts.localizationConfidence === "high";
  const local = facts.components.length <= 1;
  const literal =
    !!explicitLiteralReplacement(input.task) &&
    isOnlyLiteralReplacementTask(input.task);
  const security = collectSecurityEvidence(input.task, paths);
  const flags = {
    security: security.resolution === "security",
    concurrency:
      /\b(?:simultaneous requests|concurrent requests|race condition|atomic (?:update|transaction)|idempotency|idempotent processing|deadlock|thread.safe|lock.free)\b|requests?\s+simultaneously|samtidige\s+(?:anmodninger|requests)|race.condition|idempotens/.test(
        intent,
      ),
    database:
      /\b(?:database migration|schema migration|sql query|database schema|alter table|postgres(?:ql)?|sqlite|migrate.{0,30}(?:database|schema)|add.{0,30}(?:database column|table column))\b|databasemigration|ændr.{0,30}(?:databaseskema|tabelstruktur)|sql.forespørgsel/.test(
        intent,
      ),
    publicApi:
      /\b(?:add|change|modify|remove|rename|expose|create|update)\b[^.!?\n]{0,60}\b(?:public api|api endpoint|endpoint|response contract)\b|(?:ændr|tilføj|opret)[^.!?\n]{0,60}(?:api.endpoint|offentlig api|response.contract)/.test(
        intent,
      ),
    config:
      /\b(?:configure|configuration change|deployment configuration|rotate credentials)\b|\b(?:change|update|modify)\b[^.!?\n]{0,50}\b(?:config|configuration|docker|kubernetes|ci pipeline|environment variables)\b|(?:opdat[eé]r|ændr)[^.!?\n]{0,50}(?:konfiguration|miljøvariabl|deployment)/.test(
        intent,
      ),
    architecture:
      /\b(?:redesign|restructure)\b[^.!?\n]{0,60}\b(?:architecture|system|service boundaries)\b|\b(?:cross.component refactor|distributed transaction|replace architecture)\b|omstruktur[eé]r[^.!?\n]{0,50}(?:arkitektur|system)|på tværs af komponenter/.test(
        intent,
      ),
    destructive:
      /\b(?:drop|wipe|purge|permanently delete|delete all|irreversibly remove)\b[^.!?\n]{0,50}\b(?:data|records|tables?|database|files|backups|accounts)\b|slet[^.!?\n]{0,40}(?:alle data|permanent|databasen|sikkerhedskopier)/.test(
        intent,
      ),
  };
  // Vocabulary in copied labels is not intent. Concrete operational/security
  // requirements above are evidence even before their location is established.
  if (
    !flags.config &&
    paths.some((path) =>
      /(?:^|\/)(?:\.env|Dockerfile|docker-compose|.*\.ya?ml)$/.test(path),
    ) &&
    /\b(?:change|update|modify)\b|ændr|opdater/.test(intent)
  )
    flags.config = true;
  if (
    !flags.database &&
    paths.some((path) => /(?:migrations?\/|schema\.prisma$)/.test(path)) &&
    /\b(?:change|add|update|migrate)\b|ændr|tilføj/.test(intent)
  )
    flags.database = true;
  const requiresTests =
    /\b(?:add|write|create|extend|update)\b[^.!?\n]{0,65}\b(?:tests?|regression)\b|(?:tilføj|skriv|opret|udvid|opdater)[^.!?\n]{0,65}\btest/.test(
      intent,
    );
  const requiresNewFiles =
    paths.some((path) => !facts.files.includes(path)) ||
    /\b(?:create|add)\s+(?:a |an |new )?(?:file|page|module)\b|opret[^.!?\n]{0,35}(?:fil|side|modul)/.test(
      intent,
    );
  const complicated =
    /\b(?:distributed|consensus|deadlock|lock.free|cross.component refactor|transaction isolation|graph algorithm|dynamic programming)\b|distribueret|transaktionsisolering/.test(
      intent,
    );
  const algorithm =
    /\b(?:algorithm|parser|scheduler|pagination|retry logic|idempotency)\b|algoritme|parser|paginering|idempotens/.test(
      intent,
    );
  const subjective =
    /\b(?:beautiful|premium|polish|professional|visual design|modern design|architectural quality)\b|virkelig flot|professionel|flot|moderne design|arkitektonisk kvalitet/.test(
      intent,
    );
  const objectiveLiteral = literal && grounded;
  const taskChecks = facts.checks.filter(
    (check) =>
      check.taskSpecific &&
      check.kind === "test" &&
      /CHECK_PASS|CHECK_FAIL/.test(check.outcome),
  );
  const strong =
    taskChecks.length > 0 ||
    facts.behavioralEvidence === "targeted_tests" ||
    facts.behavioralEvidence === "exact_output" ||
    objectiveLiteral;
  const structural = facts.behavioralEvidence === "structural";
  const verificationStrength = strong
    ? "strong"
    : subjective
      ? "weak"
      : structural || facts.relatedTests.length > 0
        ? "medium"
        : "weak";
  const investigation =
    /\b(?:investigate|debug|track down|find why|find the cause|root cause)\b|undersøg|find årsag/.test(
      intent,
    );
  const unresolvedDebugging =
    investigation && !grounded && facts.files.length > 0;
  const implementationComplexity =
    objectiveLiteral && !requiresNewFiles && !requiresTests
      ? "trivial"
      : complicated
        ? "high"
        : flags.concurrency ||
            flags.architecture ||
            algorithm ||
            !local ||
            unresolvedDebugging
          ? "medium"
          : "low";
  const scope = !local
    ? "cross_component"
    : paths.length > 1
      ? "multi_file"
      : objectiveLiteral
        ? "tiny"
        : "local";
  const localizationDifficulty =
    grounded || (!facts.files.length && requiresNewFiles)
      ? "easy"
      : paths.length
        ? "medium"
        : "hard";
  const consequenceRisk =
    flags.security || flags.destructive || flags.database || flags.concurrency
      ? "high"
      : flags.publicApi || flags.config || flags.architecture || !local
        ? "medium"
        : "low";
  const evidence: TaskAssessmentV1["evidence"] = [
    {
      dimension: "scope",
      source: "localization",
      strength: grounded ? "strong" : "weak",
      description: `Resolved paths: ${JSON.stringify(paths)}; confidence: ${facts.localizationConfidence}; repository components: ${JSON.stringify(facts.components)}`,
    },
    {
      dimension: "artifactRequirements",
      source: "task_spec",
      strength: "medium",
      description: `Original requirements retained: ${spec.requirements.length}; new files: ${requiresNewFiles}; requested test edits: ${requiresTests}`,
    },
    {
      dimension: "implementationComplexity",
      source: "prompt",
      strength: objectiveLiteral ? "strong" : "medium",
      description: objectiveLiteral
        ? "Explicit mechanical old/new literal replacement with grounded target."
        : `Concrete implementation signals: algorithm=${algorithm}, complicated=${complicated}, subjective=${subjective}.`,
    },
    {
      dimension: "verificationStrength",
      source: "repo",
      strength: strong ? "strong" : structural ? "medium" : "weak",
      description: `Task-specific checks=${taskChecks.length}; behavioral evidence=${facts.behavioralEvidence ?? "none"}; related tests=${facts.relatedTests.length}; exact grounded replacement=${objectiveLiteral}. Generic health checks confer no behavioral proof.`,
    },
  ];
  for (const name of riskNames)
    evidence.push({
      dimension: `riskFlags.${name}`,
      source: "prompt",
      strength: flags[name] ? "medium" : "weak",
      description: flags[name]
        ? `Concrete ${name} requirement or boundary evidence: ${intent.slice(0, 350)}; targets=${JSON.stringify(paths)}`
        : `No concrete ${name} requirement established; absence is not proof of absence.`,
    });
  const projectHealthEvidence = facts.checks.map(
    ({ command, kind, outcome }) => ({ command, kind, outcome }),
  );
  for (const check of projectHealthEvidence)
    evidence.push({
      dimension: "projectHealthEvidence",
      source: "baseline",
      strength: "strong",
      description: `${check.command}: ${check.outcome}; kind=${check.kind}. Separate from task-specific verification.`,
    });
  for (const item of security.evidence)
    evidence.push({
      dimension: "riskFlags.security",
      source: item.source,
      description: item.description,
      strength: item.strong ? "strong" : "weak",
    });
  if (unresolvedDebugging)
    evidence.push({
      dimension: "implementationComplexity",
      source: "localization",
      strength: "medium",
      description:
        "Debugging requires investigation with an unresolved root cause and no grounded edit target; a short prompt does not establish a tiny implementation.",
    });
  const unresolvedRiskHint = security.resolution === "unresolved";
  const confidence = {
    implementationComplexity: objectiveLiteral
      ? 0.95
      : complicated || algorithm
        ? 0.8
        : grounded
          ? 0.8
          : 0.55,
    localizationDifficulty: grounded
      ? 0.95
      : paths.length
        ? 0.7
        : !facts.files.length && requiresNewFiles
          ? 0.85
          : 0.4,
    scope:
      grounded || (!facts.files.length && requiresNewFiles)
        ? 0.9
        : paths.length
          ? 0.7
          : 0.4,
    consequenceRisk: unresolvedRiskHint
      ? 0.4
      : Object.values(flags).some(Boolean)
        ? 0.8
        : grounded
          ? 0.8
          : 0.55,
    verificationStrength: strong
      ? 0.9
      : subjective
        ? 0.9
        : structural
          ? 0.8
          : 0.65,
  };
  const assessment: TaskAssessmentV1 = {
    version: 1,
    implementationComplexity,
    localizationDifficulty,
    scope,
    consequenceRisk,
    verificationStrength,
    riskFlags: flags,
    artifactRequirements: { requiresNewFiles, requiresTests },
    confidence: {
      ...confidence,
      overall: Math.min(...Object.values(confidence)),
    },
    evidence,
    securityAssessment: {
      candidate: security.candidate,
      resolution: security.resolution,
      confidence: security.confidence,
    },
    projectHealthEvidence,
    disagreements: [],
    mode: "deterministic-only",
    semanticRecommended: Math.min(...Object.values(confidence)) < 0.7,
  };
  if (input.semantic)
    mergeSemantic(
      assessment,
      semanticTaskAssessmentSchema.parse(input.semantic),
      grounded,
    );
  return taskAssessmentSchema.parse(assessment);
}

/** Explicit precedence: unsupported semantics cannot erase repository facts or
 * inflate verification. All conflicts survive in the serialized assessment. */
function mergeSemantic(
  result: TaskAssessmentV1,
  semantic: SemanticTaskAssessment,
  grounded: boolean,
) {
  result.mode = "semantic-assisted";
  const security = semantic.securityAssessment;
  if (security) {
    const before = result.riskFlags.security;
    const fixed = result.securityAssessment.resolution !== "unresolved";
    const accepted =
      !fixed &&
      result.securityAssessment.candidate &&
      security.confidence >= 0.8 &&
      security.resolution !== "unresolved";
    if (accepted) {
      result.riskFlags.security = security.resolution === "security";
      result.securityAssessment = {
        candidate: true,
        resolution: security.resolution,
        confidence: security.confidence,
      };
      result.consequenceRisk = result.riskFlags.security
        ? "high"
        : result.consequenceRisk;
      result.confidence.consequenceRisk = security.confidence;
    }
    result.disagreements.push({
      dimension: "riskFlags.security",
      deterministic: String(before),
      semantic: security.resolution,
      resolution: accepted
        ? "Semantic boundary resolution accepted for an unresolved candidate."
        : "Grounded behavioral or non-behavioral evidence retained, or insufficient semantic confidence.",
    });
    result.evidence.push({
      dimension: "riskFlags.security",
      source: "semantic",
      strength: security.confidence >= 0.8 ? "medium" : "weak",
      description: `${security.resolution}: ${security.evidence}; accepted=${accepted}`,
    });
  }
  const choices = {
    implementationComplexity: (
      { easy: "low", normal: "medium", hard: "high", frontier: "high" } as const
    )[semantic.semanticDifficulty],
    localizationDifficulty: (
      { low: "easy", medium: "medium", high: "hard" } as const
    )[semantic.localizationDifficulty],
    scope: (
      {
        "single-file": "local",
        "few-files": "multi_file",
        "multi-component": "cross_component",
      } as const
    )[semantic.expectedChangeSize],
    consequenceRisk: semantic.consequenceRisk,
    verificationStrength: semantic.verificationStrength,
  };
  for (const key of Object.keys(choices) as (keyof typeof choices)[]) {
    const proposed = choices[key];
    const old = result[key];
    const fixed =
      key === "verificationStrength" ||
      (key === "scope" && grounded) ||
      (key === "localizationDifficulty" && grounded) ||
      (key === "implementationComplexity" && old === "trivial") ||
      (key === "consequenceRisk" &&
        (Object.values(result.riskFlags).some(Boolean) ||
          result.implementationComplexity === "trivial"));
    const accepted =
      !fixed &&
      semantic.confidence >= 0.75 &&
      semantic.confidence > result.confidence[key];
    if (old !== proposed)
      result.disagreements.push({
        dimension: key,
        deterministic: old,
        semantic: proposed,
        resolution: accepted
          ? "Semantic estimate used: greater confidence, no contradictory grounded fact."
          : "Deterministic evidence retained: grounded fact, insufficient semantic confidence, or task-verification contract.",
      });
    if (accepted) {
      // Assign only the validated label belonging to this dimension.
      Object.assign(result, { [key]: proposed });
      result.confidence[key] = semantic.confidence;
    }
    result.evidence.push({
      dimension: key,
      source: "semantic",
      strength: semantic.confidence >= 0.75 ? "medium" : "weak",
      description: `${proposed}; confidence=${semantic.confidence}; ${semantic.reason}; accepted=${accepted}`,
    });
  }
  result.semanticRecommended =
    result.securityAssessment.resolution === "unresolved";
  result.confidence.overall = Math.min(
    result.confidence.implementationComplexity,
    result.confidence.localizationDifficulty,
    result.confidence.scope,
    result.confidence.consequenceRisk,
    result.confidence.verificationStrength,
  );
  result.semanticRecommended ||= result.confidence.overall < 0.7;
}

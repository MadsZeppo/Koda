import { z } from "zod";
import {
  taskRequirementChecklist,
  type TaskRequirement,
} from "../agent/completionReview.js";
import { compileTaskSpec } from "../planner/taskSpec.js";
import type { TaskAssessmentV1 } from "../router/taskAssessment.js";
import { collectSecurityEvidence } from "../router/securityEvidence.js";

export const verificationMethods = [
  "targeted_test",
  "existing_test",
  "static_check",
  "typecheck",
  "build",
  "lint",
  "semantic_review",
  "visual_review",
  "manual_only",
] as const;
export const proofSchema = z.object({
  requirementId: z.string().min(1),
  method: z.enum(verificationMethods),
  description: z.string().min(1),
  command: z.string().optional(),
  available: z.boolean(),
});
const strengthSchema = z.enum(["strong", "medium", "weak"]);
const riskSchema = z.enum(["low", "medium", "high"]);
export const verificationContractSchema = z.object({
  version: z.literal(1),
  requirements: z.array(
    z.object({
      requirementId: z.string(),
      requirement: z.string(),
      methods: z.array(z.enum(verificationMethods)).min(1),
      strength: strengthSchema,
      falseAcceptRisk: riskSchema,
      evidence: z.array(
        z.object({ source: z.string(), description: z.string() }),
      ),
      blocking: z.boolean(),
      critical: z.boolean(),
      proofAvailability: z.enum(["available", "planned", "manual"]),
    }),
  ),
  requiredProjectChecks: z.array(
    z.enum(["tests", "typecheck", "build", "lint"]),
  ),
  overallStrength: strengthSchema,
  overallFalseAcceptRisk: riskSchema,
  confidence: z.number().finite().min(0).max(1),
});
export type VerificationContractV1 = z.infer<typeof verificationContractSchema>;
export interface VerificationContractInput {
  task: string;
  requirements?: TaskRequirement[];
  acceptanceCriteria?: string[];
  relatedTests?: string[];
  resolvedPaths?: string[];
  assessment?: TaskAssessmentV1;
  proofs?: z.infer<typeof proofSchema>[];
  projectChecks?: {
    kind: string;
    command: string;
    requirement?: string;
    available?: boolean;
  }[];
}
/** Plan only: never dispatches checks, changes routing or adjudicates completion. */
export function buildVerificationContract(
  input: VerificationContractInput,
): VerificationContractV1 {
  const spec = compileTaskSpec(input.task);
  const requirements =
    input.requirements ??
    taskRequirementChecklist({
      task: spec.original,
      objective: "",
      integrationContract: "",
      acceptanceCriteria: input.acceptanceCriteria ?? [],
    });
  if (new Set(requirements.map((r) => r.id)).size !== requirements.length)
    throw Error("Duplicate requirement ID");
  const proofs = (input.proofs ?? []).map((p) => proofSchema.parse(p));
  if (proofs.some((p) => !requirements.some((r) => r.id === p.requirementId)))
    throw Error("Proof refers to unknown requirement");
  const requiredProjectChecks = new Set<
    "tests" | "typecheck" | "build" | "lint"
  >();
  for (const check of input.projectChecks ?? []) {
    if (check.requirement === "advisory") continue;
    if (check.kind === "test") requiredProjectChecks.add("tests");
    else if (["typecheck", "build", "lint"].includes(check.kind))
      requiredProjectChecks.add(check.kind as "typecheck" | "build" | "lint");
  }
  for (const name of ["tests", "typecheck", "build", "lint"] as const) {
    const pattern =
      name === "tests"
        ? /\b(?:run|execute|kør)\b.{0,40}\btests?\b/i
        : new RegExp(`\\b${name}\\b`, "i");
    if (pattern.test(input.task)) requiredProjectChecks.add(name);
  }
  const rows = requirements.map((requirement) => {
    const text = requirement.text.toLowerCase();
    const security = collectSecurityEvidence(
      requirement.text,
      input.resolvedPaths ?? [],
    );
    const critical =
      security.resolution === "security" ||
      /\b(?:delete|remove|purge|overwrite)\b.{0,50}\b(?:records|data|files|accounts)\b|(?:slet|fjern).{0,35}(?:data|poster|filer|konti)/.test(
        text,
      ) ||
      /\b(?:concurrent|simultaneous|idempotent|duplicate events?|race condition|integrity|delete all|data loss|transactions?)\b|samtidige|dublet|dobbelt|integritet|datatab|slet alle/.test(
        text,
      );
    const subjective =
      /\b(?:premium|beautiful|polish|feel|aesthetic|professional|visual design|architectural quality)\b|flot|professionel|føles|lækker/.test(
        text,
      );
    const architecture =
      /\b(?:reuse|abstraction|architectur(?:e|al)|refactor|repository pattern|service boundaries)\b|genbrug|abstraktion|arkitektur|omstruktur/.test(
        text,
      );
    const exact =
      /\b(?:returns?|reject|invalid|accept|status|throws?|input|output|constant|signature|validate|session|duplicate|count|disabled|config|environment|create|file|test|error)\b|returner|afvis|ugyldig|valider|session|dublet|knap|fil|konfiguration|miljø|fejl|opret/.test(
        text,
      );
    const copy =
      /\b(?:replace|text|label|rename)\b|tekst|omdøb|ændr.{0,30}(?:fra|til)/.test(
        text,
      );
    const matching = proofs.filter((p) => p.requirementId === requirement.id);
    const taskProofs = matching.filter(
      (p) =>
        p.available &&
        ["targeted_test", "existing_test", "static_check"].includes(p.method),
    );
    const methods = new Set<(typeof verificationMethods)[number]>();
    let strength: "strong" | "medium" | "weak" = "weak";
    let availability: "available" | "planned" | "manual" = "manual";
    if (subjective) {
      methods.add("semantic_review");
      methods.add(architecture ? "manual_only" : "visual_review");
    } else if (architecture) {
      methods.add("static_check");
      methods.add("semantic_review");
      strength = "medium";
      availability = taskProofs.length ? "available" : "planned";
    } else if (critical || exact || copy) {
      methods.add(copy && !critical ? "static_check" : "targeted_test");
      strength = "strong";
      availability = taskProofs.length ? "available" : "planned";
    } else if (taskProofs.length) {
      strength = taskProofs.some((p) => p.method === "targeted_test")
        ? "strong"
        : "medium";
      availability = "available";
    } else if (input.relatedTests?.length) {
      methods.add("existing_test");
      methods.add("semantic_review");
      strength = "medium";
      availability = "planned";
    } else {
      methods.add("semantic_review");
      methods.add("manual_only");
    }
    for (const proof of matching) methods.add(proof.method);
    const healthOnly =
      matching.length > 0 &&
      matching.every((p) => ["typecheck", "build", "lint"].includes(p.method));
    // A proof proposal is not a passing observation. Generic project checks are
    // never behavioral evidence, even when all commands have passed.
    const evidence = [
      {
        source: "requirement_checklist",
        description: `Stable completion requirement ${requirement.id}: ${requirement.text}`,
      },
      {
        source: "verification_plan",
        description: `Proof is ${availability}; strength describes the planned method, not acceptance or an observed PASS. Project health is separate.`,
      },
      ...(input.assessment
        ? [
            {
              source: "task_assessment",
              description: `Shadow assessment verification strength=${input.assessment.verificationStrength}; consequence risk=${input.assessment.consequenceRisk}. Neither label is executed requirement proof.`,
            },
          ]
        : []),
      ...matching.map((p) => ({
        source: "task_specific_evidence",
        description: `${p.method}: ${p.description}; available=${p.available}; command=${p.command ?? "not supplied"}`,
      })),
      ...(input.relatedTests?.length
        ? [
            {
              source: "repo",
              description: `Related tests: ${JSON.stringify(input.relatedTests)}; relation alone is not requirement coverage.`,
            },
          ]
        : []),
      ...security.evidence.map((e) => ({
        source: e.source,
        description: e.description,
      })),
    ];
    if (healthOnly)
      evidence.push({
        source: "project_health",
        description:
          "Only generic health proof supplied; no task-specific behavior is established.",
      });
    const falseAcceptRisk =
      strength === "weak"
        ? "high"
        : strength === "medium" || availability !== "available"
          ? "medium"
          : "low";
    return {
      requirementId: requirement.id,
      requirement: requirement.text,
      methods: [...methods],
      strength,
      falseAcceptRisk: falseAcceptRisk as "low" | "medium" | "high",
      evidence,
      blocking: true,
      critical,
      proofAvailability: availability,
    };
  });
  const overallStrength =
    rows.some((r) => r.strength === "weak") || !rows.length
      ? "weak"
      : rows.some((r) => r.strength === "medium")
        ? "medium"
        : "strong";
  const overallFalseAcceptRisk =
    rows.some((r) => r.falseAcceptRisk === "high") || !rows.length
      ? "high"
      : rows.some((r) => r.falseAcceptRisk === "medium")
        ? "medium"
        : "low";
  return verificationContractSchema.parse({
    version: 1,
    requirements: rows,
    requiredProjectChecks: [...requiredProjectChecks],
    overallStrength,
    overallFalseAcceptRisk,
    confidence: rows.length
      ? Math.min(
          ...rows.map((r) =>
            r.proofAvailability === "available"
              ? 0.9
              : r.proofAvailability === "planned"
                ? 0.65
                : 0.4,
          ),
        )
      : 0.2,
  });
}

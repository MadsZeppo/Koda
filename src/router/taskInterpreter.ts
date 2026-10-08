import { z } from "zod";
import { providerTransport } from '../provider/transport.js';

import type { Gateway } from "../openrouter/client.js";
import type { RepoProfile, Usage, VerificationResult } from "../types.js";
import type {
  DeterministicTaskProfile,
  SemanticTaskAssessment,
} from "./taskProfiler.js";

export const semanticTaskAssessmentSchema = z.object({
  securityAssessment: z
    .object({
      resolution: z.enum(["security", "non_security", "unresolved"]),
      confidence: z.number().finite().min(0).max(1),
      evidence: z.string().trim().min(1).max(500),
    })
    .optional(),
  semanticDifficulty: z.enum(["easy", "normal", "hard", "frontier"]),
  repoReasoning: z.enum(["low", "medium", "high"]),
  localizationDifficulty: z.enum(["low", "medium", "high"]),
  verificationStrength: z.enum(["strong", "medium", "weak"]),
  consequenceRisk: z.enum(["low", "medium", "high"]),
  expectedChangeSize: z.enum(["single-file", "few-files", "multi-component"]),
  startingTier: z.enum(["cheap", "strong", "frontier"]),
  frontierJustified: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().trim().min(1).max(300),
}).superRefine((value, ctx) => {
  if (value.startingTier === "frontier" && !value.frontierJustified) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "frontier starting tier requires explicit justification",
    });
  }
});

type ChoiceAnswer = {
  type: "choice";
  choice: string;
  confidence?: number;
  probabilities?: Record<string, number>;
};

type NoulAnswer = {
  type: "noul";
  noul: number;
};

type DecisionPayload = {
  model?: string;
  provider?: unknown;
  id?: string;
  answers?: Record<string, unknown>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cost?: number;
  };
};

const choice = <T extends string>(
  payload: DecisionPayload,
  key: string,
  allowed: readonly T[],
): { value: T; confidence: number } => {
  const raw = payload.answers?.[key] as Partial<ChoiceAnswer> | undefined;
  if (!raw || raw.type !== "choice" || typeof raw.choice !== "string") {
    throw Error(`Jev returned no valid choice for ${key}`);
  }
  if (!allowed.includes(raw.choice as T)) {
    throw Error(`Jev returned unsupported choice for ${key}: ${raw.choice}`);
  }
  return {
    value: raw.choice as T,
    confidence:
      typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
        ? Math.max(0, Math.min(1, raw.confidence))
        : 0.5,
  };
};

const noul = (payload: DecisionPayload, key: string): number => {
  const raw = payload.answers?.[key] as Partial<NoulAnswer> | undefined;
  if (
    !raw ||
    raw.type !== "noul" ||
    typeof raw.noul !== "number" ||
    !Number.isFinite(raw.noul)
  ) {
    throw Error(`Jev returned no valid noul for ${key}`);
  }
  return Math.max(0, Math.min(1, raw.noul));
};

export function assessmentFromDecisionPayload(
  payload: DecisionPayload,
  frontierThreshold = 0.9,
  includeSecurityAssessment = false,
): SemanticTaskAssessment {
  const semanticDifficulty = choice(
    payload,
    "semanticDifficulty",
    ["easy", "normal", "hard", "frontier"] as const,
  );
  const repoReasoning = choice(
    payload,
    "repoReasoning",
    ["low", "medium", "high"] as const,
  );
  const localizationDifficulty = choice(
    payload,
    "localizationDifficulty",
    ["low", "medium", "high"] as const,
  );
  const verificationStrength = choice(
    payload,
    "verificationStrength",
    ["strong", "medium", "weak"] as const,
  );
  const consequenceRisk = choice(
    payload,
    "consequenceRisk",
    ["low", "medium", "high"] as const,
  );
  const expectedChangeSize = choice(
    payload,
    "expectedChangeSize",
    ["single-file", "few-files", "multi-component"] as const,
  );
  const requestedStartingTier = choice(
    payload,
    "startingTier",
    ["cheap", "strong", "frontier"] as const,
  );
  const frontierProbability = noul(payload, "frontierJustified");
  const frontierJustified = frontierProbability >= frontierThreshold;

  const startingTier =
    requestedStartingTier.value === "frontier" && !frontierJustified
      ? "strong"
      : requestedStartingTier.value;

  const confidences = [
    semanticDifficulty.confidence,
    repoReasoning.confidence,
    localizationDifficulty.confidence,
    verificationStrength.confidence,
    consequenceRisk.confidence,
    expectedChangeSize.confidence,
    requestedStartingTier.confidence,
    Math.abs(frontierProbability - 0.5) * 2,
  ];
  const security =
    includeSecurityAssessment && payload.answers?.securityBoundary
      ? choice(payload, "securityBoundary", ["security", "non_security", "unresolved"] as const)
      : undefined;
  const confidence =
    confidences.reduce((sum, value) => sum + value, 0) / confidences.length;

  return semanticTaskAssessmentSchema.parse({
    ...(security
      ? {
          securityAssessment: {
            resolution: security.value,
            confidence: security.confidence,
            evidence: "Structured semantic interpretation of implementation action and security boundary using task and localization evidence.",
          },
        }
      : {}),
    semanticDifficulty: semanticDifficulty.value,
    repoReasoning: repoReasoning.value,
    localizationDifficulty: localizationDifficulty.value,
    verificationStrength: verificationStrength.value,
    consequenceRisk: consequenceRisk.value,
    expectedChangeSize: expectedChangeSize.value,
    startingTier,
    frontierJustified,
    confidence,
    reason:
      `Jev classified ${semanticDifficulty.value} coding work; ` +
      `${verificationStrength.value} verification; ${consequenceRisk.value} consequence risk; ` +
      `start ${startingTier}.`,
  });
}

const QUESTIONS = {
  semanticDifficulty: {
    type: "choice",
    instructions:
      "How difficult is the coding work itself? Do not treat generic words like 'root cause' or 'repository' as evidence of difficulty.",
    criteria: {
      easy:
        "Small bounded implementation/debugging task with straightforward logic and strong local evidence.",
      normal:
        "Ordinary software task requiring some repository reasoning or multiple related implementation steps.",
      hard:
        "Substantial semantic/repository reasoning, nontrivial interactions, architecture, concurrency, migration, or difficult debugging.",
      frontier:
        "Exceptional coding/reasoning difficulty where frontier-level reasoning is genuinely warranted by the task itself.",
    },
  },
  repoReasoning: {
    type: "choice",
    instructions:
      "How much repository-wide reasoning is genuinely required after considering the supplied likely paths and baseline evidence?",
    criteria: {
      low: "A small bounded area or obvious local implementation path is enough.",
      medium: "Several related files or dependencies must be understood.",
      high: "Broad cross-component or architecture-level repository reasoning is required.",
    },
  },
  localizationDifficulty: {
    type: "choice",
    instructions:
      "How difficult is it to localize the implementation change from the supplied task and repository facts?",
    criteria: {
      low: "Likely implementation paths are already clear.",
      medium: "Some inspection is needed, but the search space is bounded.",
      high: "The responsible component or files are genuinely uncertain across a broad repository area.",
    },
  },
  verificationStrength: {
    type: "choice",
    instructions:
      "How strongly can executable evidence determine whether the coding change is correct?",
    criteria: {
      strong: "Deterministic failing/passing tests or similarly strong executable checks directly cover the requested behavior.",
      medium: "Executable checks exist but only partially cover the requested behavior.",
      weak: "Correctness depends mainly on judgment/manual review or lacks useful executable checks.",
    },
  },
  consequenceRisk: {
    type: "choice",
    instructions:
      "What is the consequence risk of an incorrect patch? Judge concrete impact, not uncertainty wording.",
    criteria: {
      low: "Localized ordinary application behavior with limited blast radius.",
      medium: "Meaningful multi-file/public behavior where regressions would matter.",
      high: "Security, data integrity, schema/migration, public API, critical infrastructure, or similarly high-impact change.",
    },
  },
  expectedChangeSize: {
    type: "choice",
    instructions:
      "What implementation change size is most likely?",
    criteria: {
      "single-file": "One implementation file is likely sufficient.",
      "few-files": "A small number of related implementation files are likely required.",
      "multi-component": "Multiple distinct components/services/packages require implementation changes.",
    },
  },
  startingTier: {
    type: "choice",
    instructions:
      "What coding-model tier should get the FIRST semantic coding attempt? Prefer the lowest tier likely to succeed because deterministic verification can trigger escalation.",
    criteria: {
      cheap:
        "Bounded/easy/normal work with strong verification; a low-cost capable coder should try first.",
      strong:
        "Genuinely difficult reasoning or broader interactions justify a stronger coder first.",
      frontier:
        "Only exceptional tasks that genuinely require frontier-level reasoning should start here.",
    },
  },
  frontierJustified: {
    type: "noul",
    instructions:
      "Is there concrete task evidence that a frontier coding model is justified as the FIRST coding attempt, rather than trying a cheaper/strong model with verification and escalation?",
    criteria: {
      true:
        "Exceptional complexity or high-consequence weakly-verifiable work makes frontier first-attempt reasoning genuinely necessary.",
      false:
        "A cheaper or strong model can reasonably attempt the work first, especially when verification can detect mistakes.",
    },
  },
} as const;

export async function interpretTask(
  gateway: Gateway,
  task: string,
  repo: RepoProfile,
  profile: DeterministicTaskProfile,
  verification: VerificationResult,
  assessmentContext?: { taskSpec: unknown; localizationEvidence: string[]; deterministicRiskEvidence: string[] },
): Promise<SemanticTaskAssessment | undefined> {
  const config = gateway.config.semanticRouter;
  if (!config.enabled || gateway.config.forceModel) return undefined;

  const observedChecks = verification.checks
    .filter((check) =>
      check.outcome === "CHECK_PASS" || check.outcome === "CHECK_FAIL",
    )
    .map((check) => ({
      command: check.command,
      outcome: check.outcome,
    }));

  const state = {
    ...(assessmentContext ? { assessmentContext } : {}),
    task,
    repository: {
      fileCount: repo.files.length,
      languages: profile.languages,
      frameworks: profile.frameworks,
      repoScale: profile.repoScale,
      likelyPaths: profile.likelyPaths.slice(0, 12),
      likelyTests: profile.likelyTests.slice(0, 12),
      expectedBlastRadius: profile.expectedBlastRadius,
      scopeConfidence: profile.scopeConfidence,
      crossComponent: profile.crossComponent,
      publicApiRisk: profile.publicApiRisk,
      schemaRisk: profile.schemaRisk,
      concurrencyRisk: profile.concurrencyRisk,
      architectureRisk: profile.architectureRisk,
      securitySensitive: profile.securitySensitive,
      verificationCommands: repo.verificationCommands.slice(0, 8),
    },
    baseline: observedChecks,
  };

  const { apiKey, baseUrl } = providerTransport(gateway.config.baseUrl, gateway.config.modelPool?.provider);
  if (!apiKey) {
    gateway.logger.log("semantic_router_fallback", {
      subtaskId: "semantic-router",
      model: config.model,
      reason: "OPENROUTER_API_KEY is missing",
    });
    return undefined;
  }

  const body = {
    model: config.model,
    state,
    questions: assessmentContext
      ? {
          ...QUESTIONS,
          securityBoundary: {
            type: "choice",
            instructions: "Does the requested IMPLEMENTATION modify authentication, authorization, permissions, credential/secret handling, signature/authenticity/integrity verification or session/password validation? UI copy, documentation and symbol renames are not security behavior. Use localized boundaries as corroboration, never path or vocabulary alone. Return unresolved when evidence is insufficient.",
            criteria: {
              security: "Concrete security-critical implementation behavior",
              non_security: "Presentation/documentation/rename or ordinary behavior",
              unresolved: "Possible boundary with insufficient evidence",
            },
          },
        }
      : QUESTIONS,
  };
  const encoded = JSON.stringify(body);
  const tokenReservation = Buffer.byteLength(encoded) + 256;

  if (
    config.maxCostUsd > gateway.availableUsd("inspect") ||
    tokenReservation > gateway.availableTokens("inspect")
  ) {
    gateway.logger.log("semantic_router_fallback", {
      subtaskId: "semantic-router",
      model: config.model,
      reason: "semantic router would consume implementation reserve",
    });
    return undefined;
  }

  const reservation = gateway.budget.reserve(
    config.maxCostUsd,
    tokenReservation,
  );
  let reservationFinished = false;
  const start = Date.now();

  try {
    const base = new URL(baseUrl);
    const endpoint = `${base.origin}/api/alpha/decisions`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: encoded,
      signal: AbortSignal.timeout(
        Math.min(config.timeoutMs, gateway.budget.remainingMs()),
      ),
    });

    if (!response.ok) {
      if ([400, 401, 403, 404, 422].includes(response.status)) {
        reservation.cancel();
      } else {
        reservation.settleUncertain();
      }
      reservationFinished = true;
      throw Error(
        `Jev Decisions API returned HTTP ${response.status}: ${await response.text()}`,
      );
    }

    const payload = (await response.json()) as DecisionPayload;
    const inputTokens =
      typeof payload.usage?.input_tokens === "number"
        ? payload.usage.input_tokens
        : 0;
    const outputTokens =
      typeof payload.usage?.output_tokens === "number"
        ? payload.usage.output_tokens
        : 0;
    const costUsd =
      typeof payload.usage?.cost === "number" &&
      Number.isFinite(payload.usage.cost) &&
      payload.usage.cost >= 0
        ? payload.usage.cost
        : null;

    if (costUsd === null) {
      reservation.settleUncertain();
      reservationFinished = true;
      throw Error("Jev response omitted authoritative usage.cost");
    }

    const usage: Usage = {
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      reasoningTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      costUsd,
      raw: payload.usage ?? null,
    };
    reservation.settle(usage);
    reservationFinished = true;

    gateway.logger.log("model_call", {
      subtaskId: "semantic-router",
      stage: "inspect",
      role: "SCOUT_MODEL",
      modelRequested: config.model,
      modelReturned: payload.model ?? config.model,
      provider: payload.provider ?? null,
      timestampStart: new Date(start).toISOString(),
      timestampEnd: new Date().toISOString(),
      wallClockMs: Date.now() - start,
      ...usage,
      attempt: 0,
      outcome: "response",
      responseId: payload.id ?? null,
      api: "openrouter_decisions",
    });

    if (costUsd > config.maxCostUsd + 1e-9) {
      throw Error(
        `Jev semantic router exceeded configured maxCostUsd (${costUsd} > ${config.maxCostUsd})`,
      );
    }

    const assessment = assessmentFromDecisionPayload(
      payload,
      config.frontierThreshold,
      !!assessmentContext,
    );

    gateway.logger.log("semantic_task_assessment", {
      subtaskId: "semantic-router",
      model: config.model,
      assessment,
      deterministic_facts: {
        repo_files: repo.files.length,
        likely_paths: profile.likelyPaths,
        baseline_failures: observedChecks.filter(
          (check) => check.outcome === "CHECK_FAIL",
        ).length,
      },
    });
    return assessment;
  } catch (error) {
    if (!reservationFinished) {
      reservation.settleUncertain();
      reservationFinished = true;
    }
    gateway.logger.log("semantic_router_fallback", {
      subtaskId: "semantic-router",
      model: config.model,
      reason: String(error),
    });
    return undefined;
  }
}

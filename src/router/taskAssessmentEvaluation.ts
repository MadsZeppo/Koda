import { z } from "zod";
import {
  assessmentLabels,
  assessTask,
  riskNames,
  taskAssessmentSchema,
  type AssessmentFacts,
  type TaskAssessmentV1,
} from "./taskAssessment.js";
import type { SemanticTaskAssessment } from "./taskProfiler.js";
export const factsSchema = z.object({
  files: z.array(z.string()),
  resolvedPaths: z.array(z.string()),
  relatedTests: z.array(z.string()),
  components: z.array(z.string()),
  localizationConfidence: z.enum(["high", "medium", "low"]),
  checks: z.array(
    z.object({
      command: z.string(),
      kind: z.string(),
      outcome: z.string(),
      taskSpecific: z.boolean().optional(),
    }),
  ),
  behavioralEvidence: z
    .enum(["targeted_tests", "exact_output", "structural"])
    .optional(),
  languages: z.array(z.string()).optional(),
  frameworks: z.array(z.string()).optional(),
});
const expectedSchema = taskAssessmentSchema.pick({
  implementationComplexity: true,
  localizationDifficulty: true,
  scope: true,
  consequenceRisk: true,
  verificationStrength: true,
  riskFlags: true,
  artifactRequirements: true,
});
export const assessmentCaseSchema = z.object({
  id: z.string().min(1),
  task: z.string().min(1),
  language: z.enum(["en", "da"]),
  category: z.string().min(1),
  tags: z.array(z.string()),
  facts: factsSchema,
  expected: expectedSchema,
  notes: z.string().optional(),
});
export type AssessmentCase = z.infer<typeof assessmentCaseSchema>;
export interface AssessmentPrediction {
  case: AssessmentCase;
  assessment: TaskAssessmentV1;
  semanticError?: string;
}
export async function evaluateCases(
  cases: AssessmentCase[],
  semantic?: (
    item: AssessmentCase,
  ) => Promise<SemanticTaskAssessment | undefined>,
) {
  const ids = new Set<string>();
  const predictions: AssessmentPrediction[] = [];
  for (const raw of cases) {
    const item = assessmentCaseSchema.parse(raw);
    if (ids.has(item.id)) throw Error(`Duplicate case ID: ${item.id}`);
    ids.add(item.id);
    const deterministic = assessTask({ task: item.task, facts: item.facts });
    let assessment = deterministic,
      semanticError;
    if (semantic) {
      try {
        const result = await semantic(item);
        if (result)
          assessment = assessTask({
            task: item.task,
            facts: item.facts,
            semantic: result,
          });
        else
          semanticError =
            "Semantic assessment unavailable; deterministic fallback retained";
      } catch (error) {
        semanticError = String(error);
      }
    }
    predictions.push({
      case: item,
      assessment,
      ...(semanticError ? { semanticError } : {}),
    });
  }
  return predictions;
}
export function fieldMetrics(
  gold: string[],
  predicted: string[],
  labels: readonly string[],
  ordinal = false,
) {
  if (gold.length !== predicted.length) throw Error("Mismatched label counts");
  const confusion = Object.fromEntries(
    labels.map((a) => [a, Object.fromEntries(labels.map((b) => [b, 0]))]),
  ) as Record<string, Record<string, number>>;
  let exact = 0,
    withinOne = 0,
    error = 0;
  gold.forEach((value, index) => {
    const observed = predicted[index]!;
    if (!labels.includes(value) || !labels.includes(observed))
      throw Error("Unknown metric label");
    confusion[value]![observed]!++;
    const distance = Math.abs(labels.indexOf(value) - labels.indexOf(observed));
    if (!distance) exact++;
    if (distance <= 1) withinOne++;
    error += distance;
  });
  const supported = labels.filter(
    (label) => gold.includes(label) || predicted.includes(label),
  );
  const f1 = supported.map((label) => {
    const tp = confusion[label]![label]!;
    const fp = labels.reduce(
      (n, other) => n + (other === label ? 0 : confusion[other]![label]!),
      0,
    );
    const fn = labels.reduce(
      (n, other) => n + (other === label ? 0 : confusion[label]![other]!),
      0,
    );
    return (2 * tp) / Math.max(1, 2 * tp + fp + fn);
  });
  const n = gold.length;
  return {
    count: n,
    accuracy: n ? exact / n : null,
    confusionMatrix: confusion,
    macroF1: f1.length ? f1.reduce((a, b) => a + b, 0) / f1.length : null,
    macroF1Labels: supported,
    ...(ordinal
      ? {
          exactAccuracy: n ? exact / n : null,
          withinOneCategoryAccuracy: n ? withinOne / n : null,
          meanAbsoluteOrdinalError: n ? error / n : null,
        }
      : {}),
    ...(labels.includes("true")
      ? {
          precision:
            confusion.true!.true! + confusion.false!.true!
              ? confusion.true!.true! /
                (confusion.true!.true! + confusion.false!.true!)
              : null,
          recall:
            confusion.true!.true! + confusion.true!.false!
              ? confusion.true!.true! /
                (confusion.true!.true! + confusion.true!.false!)
              : null,
          falsePositiveCount: confusion.false!.true!,
          falseNegativeCount: confusion.true!.false!,
        }
      : {}),
  };
}
function metrics(rows: AssessmentPrediction[]) {
  const fields: Record<string, ReturnType<typeof fieldMetrics>> = {};
  for (const [key, labels] of Object.entries(assessmentLabels)) {
    const dimension = key as keyof typeof assessmentLabels;
    fields[key] = fieldMetrics(
      rows.map((row) => row.case.expected[dimension]),
      rows.map((row) => row.assessment[dimension]),
      labels,
      true,
    );
  }
  for (const name of riskNames)
    fields[`riskFlags.${name}`] = fieldMetrics(
      rows.map((row) => String(row.case.expected.riskFlags[name])),
      rows.map((row) => String(row.assessment.riskFlags[name])),
      ["false", "true"],
    );
  for (const name of ["requiresTests", "requiresNewFiles"] as const)
    fields[`artifactRequirements.${name}`] = fieldMetrics(
      rows.map((row) => String(row.case.expected.artifactRequirements[name])),
      rows.map((row) => String(row.assessment.artifactRequirements[name])),
      ["false", "true"],
    );
  return fields;
}
export const outcomeSchema = z
  .object({
    taskId: z.string(),
    model: z.string(),
    verifiedSuccess: z.boolean(),
    modelFailure: z.boolean(),
    censored: z.boolean(),
    costUsd: z.number().finite().nonnegative(),
    wallClockMs: z.number().finite().nonnegative(),
    failureReason: z.string().optional(),
  })
  .superRefine((row, ctx) => {
    if (
      Number(row.verifiedSuccess) +
        Number(row.modelFailure) +
        Number(row.censored) !==
      1
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Exactly one of SUCCESS, MODEL_FAILURE, CENSORED is required",
      });
  });
export function assessmentReport(
  rows: AssessmentPrediction[],
  rawOutcomes: unknown[] = [],
) {
  const strata: Record<string, AssessmentPrediction[]> = {};
  for (const row of rows)
    for (const tag of [
      `language:${row.case.language}`,
      `category:${row.case.category}`,
      `scope:${["tiny", "local"].includes(row.case.expected.scope) ? "small" : "broader"}`,
      `mode:${row.assessment.mode}`,
      `confidence:${row.assessment.confidence.overall < 0.7 ? "uncertain" : "confident"}`,
    ])
      (strata[tag] ??= []).push(row);
  const outcomes: Record<
    string,
    {
      success: number;
      modelFailure: number;
      censored: number;
      costUsd: number;
      wallClockMs: number;
    }
  > = {};
  let unmatchedOutcomes = 0;
  for (const raw of rawOutcomes) {
    const value = outcomeSchema.parse(raw);
    const row = rows.find((row) => row.case.id === value.taskId);
    if (!row) {
      unmatchedOutcomes++;
      continue;
    }
    const key = `${value.model}:${row.assessment.implementationComplexity}`;
    const tally = (outcomes[key] ??= {
      success: 0,
      modelFailure: 0,
      censored: 0,
      costUsd: 0,
      wallClockMs: 0,
    });
    const operational =
      /provider|timeout|write.scope|discovery|infra|internal.crash|environment|dependenc|\b429\b|\b5\d\d\b/i.test(
        value.failureReason ?? "",
      );
    if (value.censored || (operational && !value.verifiedSuccess))
      tally.censored++;
    else if (value.verifiedSuccess) tally.success++;
    else tally.modelFailure++;
    tally.costUsd += value.costUsd;
    tally.wallClockMs += value.wallClockMs;
  }
  return {
    version: 1,
    caseCount: rows.length,
    fields: metrics(rows),
    byStratum: Object.fromEntries(
      Object.entries(strata).map(([key, values]) => [key, metrics(values)]),
    ),
    uncertainCases: rows
      .filter((row) => row.assessment.confidence.overall < 0.7)
      .map((row) => ({
        id: row.case.id,
        confidence: row.assessment.confidence,
        semanticRecommended: row.assessment.semanticRecommended,
      })),
    semanticFailures: rows
      .filter((row) => row.semanticError)
      .map((row) => ({ id: row.case.id, error: row.semanticError })),
    predictiveValidity: Object.fromEntries(
      Object.entries(outcomes).map(([key, value]) => [
        key,
        {
          ...value,
          verifiedSuccessRate:
            value.success + value.modelFailure
              ? value.success / (value.success + value.modelFailure)
              : null,
        },
      ]),
    ),
    unmatchedOutcomes,
    predictions: rows,
  };
}

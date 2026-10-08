import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import {
  failureTraceSchema,
  failureAttributionSchema,
  failureCauses,
  resolveFailureAttribution,
} from "./failureAttribution.js";
export const failureDatasetRowSchema = z.object({
  id: z.string(),
  critical: z.boolean().default(false),
  trace: failureTraceSchema,
  expected: failureAttributionSchema.pick({
    primaryCause: true,
    contributingCauses: true,
    learningDisposition: true,
    retryRecommendation: true,
  }),
});
export type FailureDatasetRow = z.infer<typeof failureDatasetRowSchema>;
export async function readFailureDataset(path: string) {
  const text = (await readFile(path, "utf8")).trim();
  const rows = text.startsWith("[")
    ? JSON.parse(text)
    : text
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
  const parsed = z.array(failureDatasetRowSchema).min(1).parse(rows);
  if (new Set(parsed.map((row) => row.id)).size !== parsed.length)
    throw Error("Duplicate dataset IDs");
  return parsed;
}
export const percentile = (values: readonly number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))]!
    : 0;
};
export function evaluateFailureAttributions(
  rows: readonly FailureDatasetRow[],
) {
  const confusion = Object.fromEntries(
    failureCauses.map((c) => [
      c,
      Object.fromEntries(failureCauses.map((other) => [other, 0])),
    ]),
  ) as Record<string, Record<string, number>>;
  const results = rows.map((row) => {
    const start = performance.now(),
      attribution = resolveFailureAttribution(row.trace),
      overheadMs = performance.now() - start;
    confusion[row.expected.primaryCause]![attribution.primaryCause]!++;
    return {
      id: row.id,
      critical: row.critical,
      expected: row.expected,
      attribution,
      overheadMs,
    };
  });
  const fraction = (count: number, total: number) =>
    total ? count / total : null;
  const match = (
    key: "primaryCause" | "learningDisposition" | "retryRecommendation",
  ) =>
    fraction(
      results.filter((r) => r.expected[key] === r.attribution[key]).length,
      results.length,
    );
  const byCause = Object.fromEntries(
    failureCauses.map((c) => {
      const tp = confusion[c]![c]!,
        predicted = results.filter(
          (r) => r.attribution.primaryCause === c,
        ).length,
        actual = results.filter((r) => r.expected.primaryCause === c).length;
      const precision = fraction(tp, predicted),
        recall = fraction(tp, actual);
      return [
        c,
        {
          support: actual,
          precision,
          recall,
          f1: actual || predicted ? (2 * tp) / (actual + predicted) : null,
        },
      ];
    }),
  );
  const nonModel = results.filter(
      (r) => r.expected.primaryCause !== "MODEL_FAILURE",
    ),
    criticalNonModel = nonModel.filter((r) => r.critical);
  const falseBlame = nonModel.filter(
    (r) => r.attribution.learningDisposition === "NEGATIVE_MODEL_EVIDENCE",
  );
  return {
    version: 1,
    caseCount: rows.length,
    primaryCauseAccuracy: match("primaryCause"),
    macroF1:
      Object.values(byCause)
        .filter((c) => c.f1 !== null)
        .reduce((sum, c) => sum + c.f1!, 0) /
      Object.values(byCause).filter((c) => c.f1 !== null).length,
    contributingCauseAccuracy: fraction(
      results.filter(
        (r) =>
          JSON.stringify([...r.expected.contributingCauses].sort()) ===
          JSON.stringify([...r.attribution.contributingCauses].sort()),
      ).length,
      results.length,
    ),
    learningDispositionAccuracy: match("learningDisposition"),
    retryRecommendationAccuracy: match("retryRecommendation"),
    unknownRate: fraction(
      results.filter((r) => r.attribution.primaryCause === "UNKNOWN").length,
      results.length,
    ),
    modelFailure: byCause.MODEL_FAILURE!,
    falseModelBlameCount: falseBlame.length,
    criticalFalseModelBlameCount: criticalNonModel.filter(
      (r) => r.attribution.learningDisposition === "NEGATIVE_MODEL_EVIDENCE",
    ).length,
    nonModelCensorRate: fraction(
      nonModel.filter((r) => r.attribution.learningDisposition === "CENSORED")
        .length,
      nonModel.length,
    ),
    censorRateByCause: Object.fromEntries(
      failureCauses
        .filter((c) => c !== "MODEL_FAILURE")
        .map((c) => {
          const subset = nonModel.filter((r) => r.expected.primaryCause === c);
          return [
            c,
            fraction(
              subset.filter(
                (r) => r.attribution.learningDisposition === "CENSORED",
              ).length,
              subset.length,
            ),
          ];
        }),
    ),
    overheadMs: {
      p50: percentile(
        results.map((r) => r.overheadMs),
        0.5,
      ),
      p95: percentile(
        results.map((r) => r.overheadMs),
        0.95,
      ),
    },
    byCause,
    confusion,
    results,
  };
}

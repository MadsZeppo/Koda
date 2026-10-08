import type { BenchmarkRow } from "../../dev/realBenchmark.js";
import type { CanonicalRoutingTask } from "../canonicalTask.js";
import {
  trainingEligible,
  type CanonicalQualityObservation,
} from "./canonical.js";
import { digest } from "./evidenceRegistry.js";
/** Oracle success is independent evidence; a tool/build PASS alone is not. Revision proof is mandatory. */
export function nativeCalibrationObservation(
  row: BenchmarkRow,
  input: {
    task: CanonicalRoutingTask;
    model: string;
    servedRevision?: string;
    provenance: string;
    planDigest: string;
  },
): CanonicalQualityObservation | undefined {
  if (row.synthetic) return;
  if (!input.servedRevision || !row.models.includes(input.model)) return;
  const positive =
    row.mutation &&
    row.verified &&
    row.groundTruthSolve === true &&
    row.falseAccept === false;
  const failure = row.failureAttribution as
    | {
        primaryCause?: string;
        learningDisposition?: string;
        attributions?: Array<{
          primaryCause?: string;
          learningDisposition?: string;
        }>;
      }
    | undefined;
  const eligible = failure?.attributions?.filter(
    (a) =>
      a.primaryCause === "MODEL_FAILURE" &&
      a.learningDisposition === "NEGATIVE_MODEL_EVIDENCE",
  );
  const attribution = failure?.primaryCause
    ? failure
    : eligible?.length === 1
      ? eligible[0]
      : undefined;
  const negative =
    row.groundTruthSolve === false &&
    attribution?.primaryCause === "MODEL_FAILURE" &&
    attribution.learningDisposition === "NEGATIVE_MODEL_EVIDENCE";
  if (!positive && !negative) return;
  const result: CanonicalQualityObservation = {
    id: digest([
      input.planDigest,
      row.taskId,
      input.model,
      input.servedRevision,
    ]),
    taskId: row.taskId,
    task: { ...input.task, harness: "koda" },
    model: input.servedRevision,
    revision: input.servedRevision,
    identity: "EXACT",
    source: "koda-native-calibration",
    split: "local",
    role: "CALIBRATION",
    origin: "local",
    provenance: input.provenance,
    timestamp: new Date().toISOString(),
    success: positive,
    outcome: positive ? "VERIFIED_SUCCESS" : "FAILED",
    proof: positive ? { independent: true, requirementLevel: true } : undefined,
    attribution: negative
      ? {
          primaryCause: "MODEL_FAILURE",
          learningDisposition: "NEGATIVE_MODEL_EVIDENCE",
        }
      : undefined,
    costUsd: row.costComplete && row.costUsd !== null ? row.costUsd : undefined,
    latencyMs: row.wallClockMs,
    propensity: 1,
    trainingAllowed: true,
  };
  return trainingEligible(result) ? result : undefined;
}

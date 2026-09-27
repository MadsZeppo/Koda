import { readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { TaskFingerprint } from "../taskFingerprint.js";
import { contextualPairwiseRegret, contextualQuality } from "./contextual.js";
import { resolveSourceIdentities, taskCases, type EvidenceSourceInput } from "./ingest.js";
import type { ModelRoutingKnowledge, RoutingKnowledgeSnapshot,
  RoutingPolicyValidation, RoutingTaskCase } from "./schema.js";

const fingerprint = (task: RoutingTaskCase): TaskFingerprint => ({
  taskFamily: task.taskFamily as TaskFingerprint["taskFamily"],
  primary: "implementation", secondary: [], languages: task.languages ?? [], frameworks: [],
  scope: "localized", effort: "normal", executionStrategy: "stable",
  visualRelevant: false, browserRelevant: false, terminalHeavy: false,
  repoReasoningHeavy: true, architectureHeavy: false, toolsRequired: true,
  visionRequired: false, verificationStrength: "strong",
  targetedExecutableVerification: true, broaderProjectVerification: true,
  difficulty: { technicalComplexity: "medium", visualComplexity: "low",
    architecturalComplexity: "low", interactionComplexity: "low",
    repoReasoningComplexity: "medium", changeRisk: "low", contextUncertainty: "medium" },
  confidence: "medium", routingTerms: task.routingTerms, reasons: ["held-out routing replay"],
});

const priorFor = (snapshot: RoutingKnowledgeSnapshot, modelId: string) =>
  snapshot.observations.find((row) => row.canonicalModelId === modelId &&
    ["success_rate", "result_at_1"].includes(row.metric))?.value ?? 0.5;
const expectedCost = (snapshot: RoutingKnowledgeSnapshot, modelId: string) =>
  snapshot.observations.find((row) => row.canonicalModelId === modelId &&
    row.metric === "current_repriced_cost_usd")?.value ??
  snapshot.observations.find((row) => row.canonicalModelId === modelId &&
    ["historical_cost_usd", "cost_per_task_usd"].includes(row.metric))?.value ?? Infinity;
const knowledge = (snapshot: RoutingKnowledgeSnapshot): ModelRoutingKnowledge => ({
  snapshotId: snapshot.snapshotId, observations: snapshot.observations,
  pairwiseEvidence: snapshot.pairwiseEvidence, taskCases: snapshot.taskCases,
  contextualValidated: true,
});

/**
 * Replay a frozen cold-start policy against evidence never admitted to the
 * runtime snapshot. The holdout determines whether contextual evidence may be
 * activated; its outcomes never become training cases.
 */
export function validateColdStartPolicy(snapshot: RoutingKnowledgeSnapshot,
  holdout: EvidenceSourceInput, maxAllowedRegret = 0.02, minTasks = 100): RoutingPolicyValidation {
  const training = knowledge(snapshot);
  const normalizedHoldout = resolveSourceIdentities(holdout, []);
  const cases = taskCases(normalizedHoldout);
  let selectedSuccesses = 0, referenceSuccesses = 0;
  let selectedCostUsd = 0, referenceCostUsd = 0, evaluatedTasks = 0;
  const differences: number[] = [];
  for (const task of cases) {
    const fp = fingerprint(task);
    const estimates = task.outcomes.flatMap((outcome) => {
      const estimate = contextualQuality(outcome.modelId, priorFor(snapshot, outcome.modelId), fp, training);
      return estimate ? [{ modelId: outcome.modelId, estimate }] : [];
    });
    if (estimates.length < 2) continue;
    const reference = [...estimates].sort((a, b) =>
      b.estimate.lowerBound - a.estimate.lowerBound || b.estimate.mean - a.estimate.mean ||
      a.modelId.localeCompare(b.modelId))[0]!;
    const eligible = estimates.filter((candidate) => {
      if (candidate.modelId === reference.modelId) return true;
      const proof = contextualPairwiseRegret(candidate.modelId, reference.modelId, fp, training);
      return !!proof && proof.effectiveSamples >= 20 && proof.upperRegret <= maxAllowedRegret;
    });
    const selected = [...eligible].sort((a, b) =>
      expectedCost(snapshot, a.modelId) - expectedCost(snapshot, b.modelId) ||
      b.estimate.lowerBound - a.estimate.lowerBound || a.modelId.localeCompare(b.modelId))[0] ?? reference;
    const selectedOutcome = task.outcomes.find((row) => row.modelId === selected.modelId);
    const referenceOutcome = task.outcomes.find((row) => row.modelId === reference.modelId);
    if (!selectedOutcome || !referenceOutcome) continue;
    const resultCost = normalizedHoldout.records.find((row) => row.taskKey === task.taskKey &&
      row.canonicalModelId === selected.modelId)?.reportedCostUsd ?? 0;
    const referenceCost = normalizedHoldout.records.find((row) => row.taskKey === task.taskKey &&
      row.canonicalModelId === reference.modelId)?.reportedCostUsd ?? 0;
    selectedSuccesses += Number(selectedOutcome.success);
    referenceSuccesses += Number(referenceOutcome.success);
    selectedCostUsd += resultCost;
    referenceCostUsd += referenceCost;
    differences.push(Number(referenceOutcome.success) - Number(selectedOutcome.success));
    evaluatedTasks++;
  }
  const observedRegret = evaluatedTasks ? (referenceSuccesses - selectedSuccesses) / evaluatedTasks : 1;
  const variance = evaluatedTasks ? differences.reduce((sum, value) =>
    sum + (value - observedRegret) ** 2, 0) / evaluatedTasks : 1;
  const upperRegret95 = observedRegret + 1.645 * Math.sqrt((variance + 0.01) /
    Math.max(1, evaluatedTasks));
  return { sourceId: holdout.id, evaluatedTasks,
    selectedSuccessRate: evaluatedTasks ? selectedSuccesses / evaluatedTasks : 0,
    referenceSuccessRate: evaluatedTasks ? referenceSuccesses / evaluatedTasks : 0,
    observedRegret, upperRegret95, selectedCostUsd, referenceCostUsd,
    maxAllowedRegret, passed: evaluatedTasks >= minTasks && upperRegret95 <= maxAllowedRegret };
}

export async function validateAndActivateSnapshot(snapshotPath: string, holdoutPath: string,
  maxAllowedRegret = 0.02, minTasks = 100) {
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as RoutingKnowledgeSnapshot;
  const holdout = JSON.parse(await readFile(holdoutPath, "utf8")) as EvidenceSourceInput;
  snapshot.validation = validateColdStartPolicy(snapshot, holdout, maxAllowedRegret, minTasks);
  const temporary = `${snapshotPath}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(snapshot, null, 2));
  await rename(temporary, snapshotPath);
  return snapshot.validation;
}

import { canonicalRoutingTask } from "./canonicalTask.js";
import { withColdStartEvidence } from "./knowledge/coldStart.js";
import { lexicalTask } from "./lexicalTask.js";
import { modelCapabilityProfiles, taskCapabilityProfile, capabilityFloorSelector, executionStateRouter, initialExecutionState,
  type FloorPolicy } from "./capabilityRoutingV6.js";
import type { TaskFingerprint } from "./taskFingerprint.js";
import type { SpecialistModel } from "./capabilityRegistry.js";
import type { TaskAssessmentV1 } from "./taskAssessment.js";
import type { VerificationContractV1 } from "../verifier/contract.js";
import type { Logger } from "../telemetry/logger.js";
import { supportsParameters } from "./pool.js";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { StartRouterV6, routeCapabilityStart } from "./startRouterV6.js";
import { stepRouterV6 } from "./stepRouterV6.js";
let startRouter: StartRouterV6 | undefined;
const sessions = new WeakMap<Logger, Map<string, () => void>>();
const boundedPaths = (old: string[], path?: string) => path ? [...new Set([...old, path])].slice(-64) : old;
/** Observational only: no gateway, provider, production history, model setter or write-scope access. */
export function startCapabilityShadowV6(input: {
  logger: Logger; subtaskId: string; text?: string; fingerprint: TaskFingerprint; assessment?: TaskAssessmentV1;
  contract?: VerificationContractV1; models: SpecialistModel[]; inputTokens: number; outputTokens: number; budgetUsd: number;
}) {
  if (process.env.KODA_CAPABILITY_ROUTING !== "shadow") return;
  const existing = sessions.get(input.logger) ?? new Map<string, () => void>();
  existing.get(input.subtaskId)?.();
  const artifact = withColdStartEvidence();
  const task = canonicalRoutingTask({ text: input.text, semantic: input.text ? lexicalTask(input.text) : undefined,
    assessment: input.assessment, contract: input.contract, fingerprint: input.fingerprint, harness: "koda" });
  const profile = taskCapabilityProfile(task);
  const facts = input.models.map(m => ({ id: m.model.id, inputPrice: m.metadata.inputPrice, outputPrice: m.metadata.outputPrice,
    compatible: m.model.enabled && m.metadata.available !== false && (!input.fingerprint.visionRequired || m.vision) &&
      supportsParameters(m.metadata, input.fingerprint.executionStrategy === "aider" ? [] : ["tools", "tool_choice"]) &&
      (m.metadata.contextLength ?? 0) >= input.inputTokens + input.outputTokens && (m.metadata.maxOutputTokens ?? 0) >= input.outputTokens }));
  const models = modelCapabilityProfiles(profile, facts, artifact, input.inputTokens, input.outputTokens);
  const policy: FloorPolicy = { allowedRegret: 0.02, maxRegretProbability: 0.05, budgetUsd: input.budgetUsd };
  startRouter ??= new StartRouterV6(JSON.parse(gunzipSync(readFileSync(new URL("./knowledge/data/capability-start-v6.json.gz", import.meta.url))).toString("utf8")));
  const startDecision = routeCapabilityStart(profile, models, artifact, policy, startRouter);
  let state = initialExecutionState(), current = "unknown";
  let escalations = 0;
  let pending: { name: string; path?: string } | undefined;
  let floor = capabilityFloorSelector(profile, models, artifact, policy), floorKey = "";
  const telemetryProfile = { ...profile, task: { ...profile.task, text: undefined, semantic: undefined, fingerprint: undefined, assessment: undefined, contract: undefined } };
  const emit = (decision: unknown) => input.logger.log("routing_capability_v6_shadow", {
    subtaskId: input.subtaskId, authority: "observational", profile: telemetryProfile, state: structuredClone(state), decision,
    artifactDigest: artifact.digest, actualDispatchedModel: current,
  });
  emit({ stage: "START_ROUTER", ...startDecision });
  const unsubscribe = input.logger.subscribe(event => {
    if (event.type.startsWith("routing_capability_v6")) return;
    if (event.subtaskId !== input.subtaskId && !["run_error", "final_result", "apply"].includes(event.type)) return;
    if (event.type === "model_call") {
      if (Number.isFinite(event.costUsd) && event.costUsd >= 0) state.costUsd += event.costUsd;
      return;
    }
    if (event.type === "coding_route_escalation") { escalations++; return; }
    if (event.type === "coding_route_decision" || event.type === "model_attempt") {
      current = event.candidate ?? event.selected_model ?? event.modelRequested ?? current;
      if (event.verification === "OPERATIONAL_FAILURE") { state.verification = "infrastructure_failure"; emit(executionStateRouter(state,current,profile,models,artifact,policy)); }
      return;
    }
    if (event.type === "tool") { pending = { name: event.name, path: event.path }; return; }
    if (event.type === "tool_result") {
      const failed = /^Tool error:/i.test(String(event.result));
      state.progress = !failed && ["read_file", "write_file", "edit_file", "apply_patch", "create_file"].includes(event.name);
      if (failed) state.consecutiveFailures++;
      if (!failed && pending?.path) {
        if (event.name === "read_file") { state.step = "read"; state.read = boundedPaths(state.read,pending.path); state.discovered = boundedPaths(state.discovered,pending.path); }
        if (["write_file", "edit_file", "create_file", "delete_file"].includes(event.name)) { state.step = "mutation"; state.changed = boundedPaths(state.changed,pending.path); }
      }
      state.scopeGrowth = Math.max(0, state.changed.length-(profile.expectedFiles ?? state.changed.length));
      if (state.scopeGrowth > 0 && state.changed.length > 3) state.newComplexity = [...new Set([...state.newComplexity, "architecture" as const])];
      pending = undefined;
      // Aggregate discovery reads; route on phase transitions/mutations/failures, not every trivial result.
      if (!failed && !["write_file", "edit_file", "apply_patch", "create_file", "delete_file"].includes(event.name) &&
        !(event.name === "read_file" && state.read.length === 1)) return;
    } else if (event.type === "verification") {
      state.step = "verification";
      state.verification = event.outcome === "CHECK_PASS" ? "pass" : event.outcome === "CHECK_FAIL" ? "candidate_failure" : "infrastructure_failure";
      // Only regression attribution, NOT a raw pre-existing check failure, may trigger coding repair.
      if (state.verification === "candidate_failure") state.verification = "unknown";
      if (state.verification === "pass") state.consecutiveFailures = 0;
    } else if (event.type === "verification_repair" || event.type === "verification_repair_exhausted" ||
      (event.type === "attempt_rollback" && event.reason === "candidate verification regression")) {
      state.verification = "candidate_failure"; state.consecutiveFailures++;
      state.changed = boundedPaths(state.changed);
    } else if (event.type === "routing_capability_evidence") {
      const kinds = ["architecture", "database", "concurrency", "dependency", "security"] as const;
      state.newComplexity = kinds.filter(k => event.confirmedComplexity?.includes(k));
      if (event.candidateRegression === true) { state.verification = "candidate_failure"; state.consecutiveFailures++; }
    } else if (event.type === "progress") {
      state.progress = event.measurableProgress === true; state.noProgress = state.progress ? 0 : event.noProgressCycles ?? state.noProgress + 1;
    } else if (["completion_review_failure", "run_error"].includes(event.type)) {
      state.verification = "infrastructure_failure";
    } else if (["completion_review", "final_result", "task_complete", "apply"].includes(event.type)) {
      state.step = "completion"; state.finalOutcome = event.status ?? event.verification ?? "unknown";
    } else return;
    const remaining = { ...policy, budgetUsd: Math.max(0,policy.budgetUsd-state.costUsd) };
    const key = JSON.stringify([state.newComplexity, remaining.budgetUsd]);
    if (key !== floorKey) {
      // Recompute only when capability/economics changed, never per read/model token.
      floor = executionStateRouter(state,current,profile,models,artifact,remaining).floor; floorKey = key;
    }
    emit(stepRouterV6({ state, current, profile, models, evidence: artifact, policy: remaining, cachedFloor: floor,
      guardrails: { maxEscalations: 2, escalations, taskBudgetUsd: policy.budgetUsd, realizedCostUsd: state.costUsd } }));
    if (["run_error", "final_result", "apply"].includes(event.type)) { unsubscribe(); existing.delete(input.subtaskId); }
  });
  existing.set(input.subtaskId, unsubscribe); sessions.set(input.logger, existing);
}

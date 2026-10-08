import { executionStateRouter, type ExecutionState, type TaskCapabilityProfile, type ModelCapabilityProfile, type FloorPolicy, type FloorDecision } from "./capabilityRoutingV6.js";
import type { ContextualQualityArtifact } from "./contextualQuality.js";
export interface StepGuardrails { maxEscalations: number; taskBudgetUsd: number; realizedCostUsd: number; escalations: number; }
/** Twin's tiers are state-difficulty supervision, never identities/quality labels for Koda models. */
export function stepRouterV6(input: { state: ExecutionState; current: string; profile: TaskCapabilityProfile; models: readonly ModelCapabilityProfile[];
  evidence: ContextualQualityArtifact; policy: FloorPolicy; guardrails: StepGuardrails; cachedFloor?: FloorDecision; tierAdvice?: "low" | "mid" | "mid_high" | "high" }) {
  const g=input.guardrails;
  if (!Number.isInteger(g.escalations) || g.escalations<0 || !Number.isInteger(g.maxEscalations) || g.maxEscalations<0 || g.maxEscalations>2 ||
    ![g.taskBudgetUsd,g.realizedCostUsd].every(v=>Number.isFinite(v)&&v>=0)) throw Error("Invalid V6 execution guardrails");
  const decision=executionStateRouter(input.state,input.current,input.profile,input.models,input.evidence,
    {...input.policy,budgetUsd:Math.min(input.policy.budgetUsd,Math.max(0,g.taskBudgetUsd-g.realizedCostUsd))},input.cachedFloor);
  if (decision.action==="ESCALATE") {
    if (g.escalations>=g.maxEscalations) return {...decision,action:"ABSTAIN" as const,selected:undefined,reason:"maximum_two_escalations"};
    // Weak tier advice alone is never an escalation trigger. Current Koda regression/progress evidence is required.
    const justified=input.state.consecutiveFailures>=2 || input.state.noProgress>=2 || input.state.newComplexity.length>0 || input.state.verification==="candidate_failure";
    if (!justified) return {...decision,action:"ABSTAIN" as const,selected:undefined,reason:"escalation_requires_trajectory_evidence"};
  }
  return {...decision,tierAdvice:input.tierAdvice??"unknown",tierAdviceIsQualityEvidence:false as const};
}

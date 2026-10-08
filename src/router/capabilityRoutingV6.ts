import { createHash } from "node:crypto";
import { canonicalRoutingTask, type CanonicalRoutingTask } from "./canonicalTask.js";
import { predictContextualQuality, type ContextualQualityArtifact, type QualityPrediction } from "./contextualQuality.js";
import { pairedRegret } from "./pairedEvidence.js";
import type { ContextualModelFacts } from "./contextualRouterVNext.js";

/** Exact pool identities only. New versions require evidence, never alias-by-name transfer. */
export const V6_MODEL_POOL = [
  "anthropic/claude-sonnet-4", "google/gemini-2.5-flash", "openai/gpt-5",
  "qwen/qwen3-235b-a22b-2507", "deepseek/deepseek-v3.1-terminus", "z-ai/glm-4.6",
] as const;
export type CapabilityDimension = "implementation" | "frontend" | "backend" | "database" | "debugging" | "refactor" | "tests" | "infra" | "architecture" | "visual";
export interface TaskCapabilityProfile {
  version: 6;
  task: CanonicalRoutingTask;
  domains: CapabilityDimension[];
  difficulty: { implementation: string; reasoning: string; interaction: string; visual: string };
  risks: Record<string, boolean | undefined>;
  highConsequence: boolean;
  coupling: string;
  expectedFiles?: number;
  verification: CanonicalRoutingTask["proof"];
  uncertainty: string;
  requiredDimensions: CapabilityDimension[];
}
const domain: Record<string, CapabilityDimension> = {
  frontend_ui: "frontend", fullstack: "frontend", backend: "backend", backend_api: "backend",
  sql_database: "database", database: "database", debugging: "debugging", localized_bugfix: "debugging",
  refactor: "refactor", testing: "tests", test_change: "tests", devops: "infra", architecture: "architecture",
};
export function taskCapabilityProfile(task: CanonicalRoutingTask): TaskCapabilityProfile {
  const f = task.fingerprint, a = task.assessment;
  const domains = [...new Set(["implementation" as const, ...[task.family, f?.primary, ...(f?.secondary ?? [])]
    .flatMap(k => k && domain[k] ? [domain[k]!] : []), ...(task.visual ? ["frontend" as const, "visual" as const] : []),
    ...(task.risks.schema || task.risks.database ? ["database" as const] : []),
    ...(task.risks.architecture ? ["architecture" as const] : [])])];
  return { version: 6, task: { ...canonicalRoutingTask({ family: task.family, text: task.text, semantic: task.semantic, assessment: a, contract: task.contract, fingerprint: f, engine: task.engine, harness: task.harness }),
      repo: task.repo, baseCommit: task.baseCommit, paths: task.paths ? [...task.paths] : undefined, languages: [...task.languages], frameworks: [...task.frameworks], proof: { ...task.proof } }, domains,
    difficulty: { implementation: a?.implementationComplexity ?? task.complexity ?? "unknown",
      reasoning: f?.difficulty.repoReasoningComplexity ?? "unknown", interaction: f?.difficulty.interactionComplexity ?? "unknown",
      visual: task.visual ? f?.difficulty.visualComplexity ?? "high" : "low" },
    risks: { ...task.risks, concurrency: task.risks.concurrency ?? f?.concurrencyRisk },
    highConsequence: a?.consequenceRisk === "high" || f?.consequenceRisk === "high" ||
      ["security", "schema", "database", "concurrency", "destructive"].some(k => task.risks[k] === true) || f?.concurrencyRisk === true,
    coupling: f?.architecturalCoupling ?? task.scope ?? "unknown", expectedFiles: task.expectedFiles,
    verification: { ...task.proof }, uncertainty: task.localization ?? "unknown", requiredDimensions: domains };
}
const family: Record<CapabilityDimension, string> = { implementation: "implementation", frontend: "frontend_ui", backend: "backend_api",
  database: "database", debugging: "debugging", refactor: "refactor", tests: "test_change", infra: "devops", architecture: "architecture", visual: "visual_design" };
export interface ModelCapabilityProfile {
  model: string; compatible: boolean; costUsd: number; latencyMs?: number;
  quality: QualityPrediction;
  dimensions: Partial<Record<CapabilityDimension, QualityPrediction>>;
}
/** One canonical estimator. No qualityPrior, specialist posterior or tier-label input. */
export function modelCapabilityProfiles(profile: TaskCapabilityProfile, facts: readonly ContextualModelFacts[], artifact: ContextualQualityArtifact,
  inputTokens: number, outputTokens: number): ModelCapabilityProfile[] {
  if (![inputTokens, outputTokens].every(n => Number.isFinite(n) && n >= 0)) throw Error("Invalid token forecast");
  return facts.filter(f => (V6_MODEL_POOL as readonly string[]).includes(f.id)).map(f => {
    const quality = predictContextualQuality(artifact, profile.task, f.id);
    return { model: f.id, compatible: f.compatible, latencyMs: f.latencyMs,
      costUsd: (inputTokens * (f.inputPrice ?? Infinity) + outputTokens * (f.outputPrice ?? Infinity)) / 1e6, quality,
      dimensions: Object.fromEntries(profile.requiredDimensions.map(d => {
        const q = predictContextualQuality(artifact, { ...profile.task, family: family[d] }, f.id);
        // A global prediction is useful cold-start coding evidence, but cannot establish visual/DB/domain expertise.
        const native = artifact.cells.some(c => c.model === f.id && c.family === family[d] && c.local > 0);
        const publicDomain = artifact.cells.some(c => c.model === f.id && c.family === family[d] && c.count > 0);
        return [d, d === "implementation" || native || publicDomain ? q : undefined];
      })) };
  });
}
export interface FloorPolicy { allowedRegret: number; maxRegretProbability: number; budgetUsd: number; }
export interface FloorDecision {
  status: "SELECTED" | "ABSTAIN"; selected?: string; reference?: string; reason: string;
  alternatives: Array<{ model: string; eligible: boolean; reasons: string[]; regretProbability: number;
    expectedTotalCostUsd: number; firstCostUsd: number; recoveryCostUsd: number; provenance: string[] }>;
}
/** Economic ordering happens AFTER the evidence-backed floor. Recovery never gets invented quality credit. */
export function capabilityFloor(profile: TaskCapabilityProfile, models: readonly ModelCapabilityProfile[],
  artifact: ContextualQualityArtifact, policy: FloorPolicy): FloorDecision {
  if (![policy.allowedRegret, policy.maxRegretProbability].every(x => Number.isFinite(x) && x >= 0 && x <= 1) ||
    !Number.isFinite(policy.budgetUsd) || policy.budgetUsd < 0) throw Error("Invalid V6 policy");
  const usable = models.filter(m => m.compatible && m.quality.support > 0 && Number.isFinite(m.costUsd) && m.costUsd >= 0);
  const reference = [...usable].sort((a,b) => b.quality.lower-a.quality.lower || b.quality.mean-a.quality.mean || a.model.localeCompare(b.model))[0];
  if (!reference) return { status: "ABSTAIN", reason: "no_supported_compatible_reference", alternatives: [] };
  const alternatives = models.map(m => {
    const reasons: string[] = [];
    if (!usable.includes(m)) reasons.push("unsupported_or_incompatible");
    const missing = profile.requiredDimensions.filter(d => !m.dimensions[d] || !m.dimensions[d]!.support);
    if (missing.length) reasons.push(`missing_capability_evidence:${missing.join(",")}`);
    const regret = pairedRegret({ rows: artifact.paired ?? [], task: profile.task, candidate: [m.model], reference: [reference.model],
      detection: 0, allowedRegret: policy.allowedRegret });
    if (m.model !== reference.model && regret.probability > policy.maxRegretProbability) reasons.push("unsafe_regret");
    if (profile.highConsequence && m.model !== reference.model) reasons.push("high_consequence_reference_floor");
    const recoveryCostUsd = m.model === reference.model ? 0 : (1-m.quality.mean) * reference.costUsd;
    const expectedTotalCostUsd = m.costUsd + recoveryCostUsd;
    if (m.costUsd + (m.model === reference.model ? 0 : reference.costUsd) > policy.budgetUsd) reasons.push("recovery_reserve_unfunded");
    return { model: m.model, eligible: reasons.length === 0, reasons, regretProbability: regret.probability,
      expectedTotalCostUsd, firstCostUsd: m.costUsd, recoveryCostUsd, provenance: m.quality.provenance };
  });
  return { status: alternatives.some(m=>m.eligible) ? "SELECTED" : "ABSTAIN", reference: reference.model, alternatives,
    reason: "capability_and_regret_floor" };
}
/** Cost cannot admit a model rejected by the capability floor. */
export function costAwareSelector(floor: FloorDecision, models: readonly ModelCapabilityProfile[]): FloorDecision {
  const best = floor.alternatives.filter(m => m.eligible).sort((a,b) => a.expectedTotalCostUsd-b.expectedTotalCostUsd ||
    (models.find(m => m.model === a.model)?.latencyMs ?? Infinity)-(models.find(m => m.model === b.model)?.latencyMs ?? Infinity) || a.model.localeCompare(b.model))[0];
  return { ...floor, status: best ? "SELECTED" : "ABSTAIN", selected: best?.model,
    reason: best ? "capability_and_regret_floor_then_total_cost" : "required_capability_or_quality_evidence_missing" };
}
export function capabilityFloorSelector(profile: TaskCapabilityProfile, models: readonly ModelCapabilityProfile[], artifact: ContextualQualityArtifact, policy: FloorPolicy) {
  return costAwareSelector(capabilityFloor(profile,models,artifact,policy),models);
}

export interface ExecutionState {
  step: "discovery" | "read" | "mutation" | "verification" | "completion";
  discovered: string[]; read: string[]; changed: string[];
  consecutiveFailures: number; noProgress: number; progress: boolean;
  newComplexity: Array<"architecture" | "database" | "concurrency" | "dependency" | "security">;
  verification: "unknown" | "pass" | "candidate_failure" | "infrastructure_failure";
  costUsd: number; finalOutcome?: string;
  scopeGrowth?: number;
}
export const initialExecutionState = (): ExecutionState => ({ step: "discovery", discovered: [], read: [], changed: [], consecutiveFailures: 0,
  noProgress: 0, progress: false, newComplexity: [], verification: "unknown", costUsd: 0 });
export function executionStateRouter(state: ExecutionState, current: string, profile: TaskCapabilityProfile, models: readonly ModelCapabilityProfile[],
  artifact: ContextualQualityArtifact, policy: FloorPolicy, cachedFloor?: FloorDecision) {
  const elevated = structuredClone(profile);
  for (const k of state.newComplexity) { elevated.risks[k] = true; elevated.task.risks[k] = true; }
  if (state.newComplexity.length) {
    elevated.highConsequence = true;
    if (state.newComplexity.includes("database")) elevated.requiredDimensions = [...new Set([...elevated.requiredDimensions, "database" as const])];
    if (state.newComplexity.includes("architecture") || state.newComplexity.includes("dependency")) elevated.requiredDimensions = [...new Set([...elevated.requiredDimensions, "architecture" as const])];
  }
  const floor = cachedFloor ?? capabilityFloorSelector(elevated, models, artifact, policy);
  if (state.verification === "infrastructure_failure") return { action: "INFRASTRUCTURE_RECOVERY" as const, selected: current, floor, reason: "no_model_quality_failure" };
  if (state.verification === "pass" && state.step === "completion") return { action: "STAY" as const, selected: current, floor, reason: "verification_pass_pending_authoritative_completion" };
  const eligible = floor.alternatives.find(m => m.model === current)?.eligible;
  if (!eligible || state.consecutiveFailures >= 2 || state.noProgress >= 2 || state.newComplexity.length) {
    const target = floor.status === "SELECTED" ? (state.consecutiveFailures >= 2 || state.noProgress >= 2 ? floor.reference : floor.selected) : undefined;
    if (!target || !floor.alternatives.find(m => m.model === target)?.eligible) return { action: "ABSTAIN" as const, floor, reason: "raised_floor_not_supported" };
    return { action: target === current ? "REPAIR" as const : "ESCALATE" as const, selected: target, floor, reason: "failure_or_new_complexity" };
  }
  return { action: state.verification === "candidate_failure" ? "REPAIR" as const : "STAY" as const, selected: current, floor,
    reason: state.verification === "candidate_failure" ? "one_concrete_failure_repair" : "progress_preserves_trajectory" };
}
export interface HandoffEvidence { task: string; diff: string; discoveries: string[]; toolResults: string[]; failures: string[]; unresolved: string[]; }
/** Exact originals are preserved by the caller; bounded packet references omissions by digest, never pretends they were read. */
export function boundedCapabilityHandoff(evidence: HandoffEvidence, maxBytes = 16384) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1024) throw Error("Handoff bound too small");
  const digest = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
  const packet = { version: 6, evidenceDigest: digest, requiresEvidenceAttachment: false, task: evidence.task, diff: evidence.diff,
    discoveries: [...evidence.discoveries], toolResults: [...evidence.toolResults], failures: [...evidence.failures], unresolved: [...evidence.unresolved] };
  const size = () => Buffer.byteLength(JSON.stringify(packet));
  while (size() > maxBytes) {
    packet.requiresEvidenceAttachment = true;
    const arrays = [packet.toolResults, packet.discoveries, packet.failures, packet.unresolved].filter(a => a.length);
    if (arrays.length) { arrays.sort((a,b) => JSON.stringify(b).length-JSON.stringify(a).length)[0]!.shift(); continue; }
    if (packet.diff.length) { packet.diff = ""; continue; }
    packet.task = "";
    break;
  }
  if (size() > maxBytes) throw Error("Handoff metadata exceeds bound");
  return Object.freeze(packet);
}

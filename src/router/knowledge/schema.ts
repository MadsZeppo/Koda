export const ROUTING_KNOWLEDGE_VERSION = 2 as const;

export type ExternalEvidenceType = "paired_task_model" | "agentic_economics" |
  "benchmark_prior" | "task_distribution" | "trajectory_process" |
  "catalog_metadata" | "market_adoption_signal";
export type ModelIdentityLevel = "EXACT" | "FAMILY_TRANSFER" | "UNKNOWN";
export type RoutingEvidenceCategory = "agentic_swe" | "terminal_tool" |
  "coding_reasoning" | "efficiency" | "provider_capability" |
  "task_distribution" | "market_signal";
export type RoutingMetric = "result_at_1" | "pass_at_5" | "success_rate" |
  "cost_per_task_usd" | "historical_cost_usd" | "current_repriced_cost_usd" |
  "input_tokens" | "output_tokens" | "total_tokens" | "total_tokens_p75" |
  "total_tokens_p90" | "turns" | "cached_token_ratio" |
  "completion_latency_p50_ms" | "completion_latency_p90_ms" |
  "task_count" | "market_share";
export type ProviderCapabilityMetric = "tools_supported" | "tool_choice_supported" |
  "structured_output_supported" | "context_tokens" | "input_price_per_million" |
  "output_price_per_million" | "availability" | "text_modality" | "vision_modality";

export interface RoutingKnowledgeObservation {
  id: string;
  category: RoutingEvidenceCategory;
  evidenceType?: ExternalEvidenceType;
  source: string;
  sourceDate: string;
  snapshotDate: string;
  displayModel: string;
  canonicalModelId?: string;
  externalModelName?: string;
  revision?: string;
  reasoningConfig?: string;
  identityLevel?: ModelIdentityLevel;
  metric: RoutingMetric | ProviderCapabilityMetric;
  value: number;
  unit: "ratio" | "count" | "tokens" | "usd" | "milliseconds";
  taskFamilies?: string[];
  languages?: string[];
  harness?: string;
  sampleSize?: number;
  successes?: number;
  failures?: number;
  sem?: number;
  freshnessDays?: number;
  detail?: string;
}

export interface PairwiseRoutingEvidence {
  sourceId: string;
  candidateModelId: string;
  referenceModelId: string;
  taskFamily?: string;
  bothSucceed: number;
  candidateOnly: number;
  referenceOnly: number;
  bothFail: number;
  sampleSize: number;
  identityLevel: "EXACT";
}
export interface RoutingKnowledgeSource {
  id: string;
  type: ExternalEvidenceType;
  version?: string;
  date?: string;
  harness?: string;
  recordCount: number;
  status: "ok" | "partial" | "failed";
  detail?: string;
}
export interface RoutingKnowledgeSnapshot {
  /** V1 remains readable as a last-known-good snapshot. */
  schemaVersion: number;
  snapshotId: string;
  createdAt: string;
  observations: RoutingKnowledgeObservation[];
  pairwiseEvidence?: PairwiseRoutingEvidence[];
  sources?: RoutingKnowledgeSource[];
}
export interface ModelRoutingKnowledge {
  snapshotId: string;
  observations: RoutingKnowledgeObservation[];
  pairwiseEvidence?: PairwiseRoutingEvidence[];
}

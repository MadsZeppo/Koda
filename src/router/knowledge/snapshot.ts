import { ROUTING_KNOWLEDGE_VERSION, type RoutingKnowledgeObservation, type RoutingKnowledgeSnapshot } from "./schema.js";

// Public seed data is deliberately unmapped. Display-name similarity is not
// sufficient proof that a provider endpoint serves the evaluated model.
export const ROUTING_KNOWLEDGE_V1: RoutingKnowledgeSnapshot = {
  schemaVersion: ROUTING_KNOWLEDGE_VERSION,
  snapshotId: "public-routing-knowledge-v1-2026-07-01",
  createdAt: "2026-07-01T00:00:00Z",
  observations: [
    ["sol-r1", "GPT-5.6 Sol medium", "result_at_1", 0.623, "ratio"],
    ["sol-p5", "GPT-5.6 Sol medium", "pass_at_5", 0.793, "ratio"],
    ["sol-cost", "GPT-5.6 Sol medium", "cost_per_task_usd", 0.85, "usd"],
    ["sol-tokens", "GPT-5.6 Sol medium", "total_tokens", 605340, "tokens"],
    ["sol-cache", "GPT-5.6 Sol medium", "cached_token_ratio", 0.847, "ratio"],
    ["luna-r1", "GPT-5.6 Luna medium", "result_at_1", 0.436, "ratio"],
    ["luna-p5", "GPT-5.6 Luna medium", "pass_at_5", 0.595, "ratio"],
    ["luna-cost", "GPT-5.6 Luna medium", "cost_per_task_usd", 0.11, "usd"],
    ["luna-tokens", "GPT-5.6 Luna medium", "total_tokens", 395522, "tokens"],
    ["luna-cache", "GPT-5.6 Luna medium", "cached_token_ratio", 0.852, "ratio"],
  ].map<RoutingKnowledgeObservation>(([id, displayModel, metric, value, unit]) => ({
    id: String(id), category: String(metric).includes("tokens") || metric === "cost_per_task_usd" || metric === "cached_token_ratio"
      ? "efficiency" as const : "agentic_swe" as const,
    source: "SWE-rebench public snapshot", sourceDate: "2026-07-01", snapshotDate: "2026-07-01",
    displayModel: String(displayModel), metric: metric as any, value: Number(value), unit: unit as any,
    taskFamilies: ["localized_bugfix", "debugging"], harness: "111 problem agentic SWE evaluation", sampleSize: 111,
  })).concat([
    {
      id: "qwen-coder-next-total-tokens", category: "efficiency", source: "SWE-rebench public snapshot",
      sourceDate: "2026-05-15", snapshotDate: "2026-07-01", displayModel: "Qwen3-Coder-Next",
      metric: "total_tokens", value: 8_120_000, unit: "tokens", harness: "earlier agentic SWE evaluation",
      taskFamilies: ["localized_bugfix", "debugging"],
    },
    {
      id: "qwen-coder-next-turns", category: "efficiency", source: "SWE-rebench public snapshot",
      sourceDate: "2026-05-15", snapshotDate: "2026-07-01", displayModel: "Qwen3-Coder-Next",
      metric: "turns", value: 154, unit: "count", harness: "earlier agentic SWE evaluation",
      taskFamilies: ["localized_bugfix", "debugging"],
    },
  ]),
};

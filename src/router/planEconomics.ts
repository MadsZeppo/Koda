export interface DagEconomicNode {
  id: string;
  dependsOn: string[];
  expectedCostUsd: number;
  expectedLatencyMs: number;
}

/** Cost is additive; latency is the dependency DAG's critical path. */
export function estimateDagEconomics(nodes: DagEconomicNode[], integrationCostUsd = 0,
  integrationLatencyMs = 0) {
  const completion = new Map<string, number>();
  let cost = integrationCostUsd;
  for (const node of nodes) {
    cost += node.expectedCostUsd;
    const parent = Math.max(0, ...node.dependsOn.map((id) => completion.get(id) ?? 0));
    completion.set(node.id, parent + node.expectedLatencyMs);
  }
  return {
    expectedCostUsd: cost,
    expectedLatencyMs: Math.max(0, ...completion.values()) + integrationLatencyMs,
  };
}

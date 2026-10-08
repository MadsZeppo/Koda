import type { CodingScenario } from "./codingSuiteFixtures.js";
import { expertCodingScenarios } from "./expertCodingSuiteFixtures.js";

// Integrate three algorithms behind one batch API. Existing expert contracts
// supply separately checked oracles; solutions never enter the live prompt.
const workflows: [string, number, number, number][] = [
  ["graph-navigation", 0, 1, 3],
  ["graph-analysis", 0, 2, 3],
  ["transport-network", 1, 2, 27],
  ["resource-planning", 4, 5, 13],
  ["sequence-analysis", 6, 7, 8],
  ["text-search", 9, 10, 11],
  ["calendar-planning", 12, 13, 24],
  ["tree-inspection", 14, 15, 16],
  ["document-processing", 16, 17, 18],
  ["version-analysis", 19, 20, 11],
  ["payment-allocation", 21, 22, 26],
  ["request-throttling", 23, 24, 25],
  ["grid-analysis", 27, 28, 0],
  ["expression-search", 29, 10, 11],
  ["budget-optimizer", 4, 5, 21],
  ["audit-documents", 17, 18, 26],
  ["route-scheduling", 1, 12, 13],
  ["signal-analysis", 6, 8, 9],
  ["document-similarity", 7, 9, 10],
  ["catalog-search", 11, 19, 20],
  ["financial-controls", 21, 22, 25],
  ["network-health", 2, 3, 24],
  ["cache-admission", 23, 25, 29],
  ["tree-migration", 14, 16, 17],
  ["document-validation", 15, 18, 11],
  ["warehouse-routing", 27, 28, 1],
  ["capacity-management", 5, 12, 25],
  ["settlement-reporting", 22, 26, 20],
  ["dependency-inspection", 3, 14, 15],
  ["query-engine", 10, 18, 29],
];

export const stressCodingScenarios: CodingScenario[] = workflows.map(([name, ...indices], index) => {
  const components = indices.map(i => expertCodingScenarios[i]!);
  const operation = (s: CodingScenario) => s.id.replace(/^expert-/, "");
  const request = (s: CodingScenario, args: unknown[]) => ({ operation: operation(s), args });
  const cases: CodingScenario["cases"] = [
    [[[]], []],
    // All components in one batch, then in reverse order: dispatcher/state
    // mistakes cannot hide behind separate single-operation invocations.
    [[components.map(s => request(s, s.cases[0]![0]))], components.map(s => s.cases[0]![1])],
    [[[...components].reverse().map(s => request(s, s.cases[0]![0]))], [...components].reverse().map(s => s.cases[0]![1])],
    ...components.flatMap(s => s.cases.map(([args, expected]) => [[ [request(s, args)] ], [expected]] as [unknown[], unknown])),
    // Repeat one operation in the same batch, requiring independent outputs.
    [[Array.from({ length: 3 }, () => request(components[0]!, components[0]!.cases[0]![0]))],
      Array.from({ length: 3 }, () => components[0]!.cases[0]![1])],
  ];
  return {
    id: `stress-${String(index + 1).padStart(2, "0")}-${name}`,
    requirement: [
      "fn(requests): implement a synchronous batch-processing API for the following three operations. Each request is {operation:string,args:array}; dispatch using operation and spread args in the order specified below. Return one result per request in input order. This is one integrated task: implement ALL operations and their interaction, not just the first operation.",
      ...components.map((s, i) => `Requirement ${i + 1}: operation '${operation(s)}'. ${s.requirement.replace(/^fn\(/, "Arguments (")}`),
      "Integration contract: the batch may mix or repeat operations in any order. Empty requests returns []. An unknown operation must throw RangeError; do not silently return null or undefined. Only otherwise valid operation arguments are required. Each invocation must be independent: no state leakage across repeated calls or within a batch. Preserve the entire requests array and every nested input, including records, trees and matrices. Allocate fresh result containers when applicable.",
      "Testing contract: add runnable regression coverage for each operation, legal boundary cases, mixed and reversed batches, repeated operations, empty batch and unknown operation. Derive expected outputs from the stated contracts independently of the implementation. Do not invent support for omitted arguments or inputs outside these contracts. Preserve existing tests. Use built-in Node APIs only, with no new dependencies. Keep the exported CommonJS API and the repository's actual runner convention. Verify the changed source and tests before completion.",
    ].join("\n\n"),
    implementation: `requests=>{const operations={${components.map(s => `${JSON.stringify(operation(s))}:(${s.implementation})`).join(",")}};return requests.map(({operation,args})=>{if(!Object.hasOwn(operations,operation))throw new RangeError('Unknown operation');return operations[operation](...args)})}`,
    cases,
    invalidArgs: [[[ { operation: "unknown-operation", args: [] } ]]],
    create: false,
    addTests: true,
    progressive: index % 3 === 0,
  };
});

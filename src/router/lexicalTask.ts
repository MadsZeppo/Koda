import { createHash } from "node:crypto";
/** Outcome-blind lexical representation, not a claimed pretrained semantic embedding. */
export function lexicalTask(text: string) {
  const vector = Array(64).fill(0) as number[];
  for (const token of text.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) ?? []) {
    const hash = createHash("sha256").update(token).digest();
    vector[hash[0]! % 64]! += hash[1]! % 2 ? 1 : -1;
  }
  const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
  return {
    vector: vector.map((v) => (norm ? v / norm : 0)),
    encoder: "lexical-hash-v1",
    provenance: "original-task-text-only",
  };
}

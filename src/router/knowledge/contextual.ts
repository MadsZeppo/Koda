import type { TaskFingerprint } from "../taskFingerprint.js";
import { normalizeRoutingTaskFamily } from "./identity.js";
import { modelFamilyKey } from "./identity.js";
import type { ModelRoutingKnowledge, RoutingTaskCase } from "./schema.js";

const STOP = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "do", "for", "from",
  "in", "into", "is", "it", "of", "on", "or", "that", "the", "this", "to",
  "use", "using", "with", "without", "should", "must", "existing", "current",
  "file", "files", "code", "change", "changes", "make", "ensure",
]);

/** Stable, local routing features. No embedding/model call is required. */
export function routingTerms(text: string, limit = 64): string[] {
  const normalized = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .match(/[a-z][a-z0-9_.:/-]{1,63}/g) ?? [];
  const terms: string[] = [];
  for (const raw of normalized) {
    for (const part of raw.split(/[./:_-]+/)) {
      const term = part.replace(/(?:ing|ed|es)$/i, "");
      if (term.length >= 3 && !STOP.has(term) && !terms.includes(term)) terms.push(term);
      if (terms.length >= limit) return terms;
    }
  }
  return terms;
}

const jaccard = (left: string[], right: string[]) => {
  if (!left.length || !right.length) return 0;
  const a = new Set(left), b = new Set(right);
  let overlap = 0;
  for (const term of a) if (b.has(term)) overlap++;
  return overlap / (a.size + b.size - overlap);
};

const similarity = (row: RoutingTaskCase, fp: TaskFingerprint) => {
  const lexical = jaccard(row.routingTerms, fp.routingTerms ?? []);
  const family = normalizeRoutingTaskFamily(row.taskFamily) ===
    normalizeRoutingTaskFamily(fp.taskFamily ?? fp.primary) ? 1 : 0;
  const language = !row.languages?.length || !fp.languages.length ? 0.5 :
    row.languages.some((item) => fp.languages.includes(item)) ? 1 : 0;
  if (!family && lexical === 0) return 0;
  const expectedEngine = "aider";
  const engine = !row.engine || row.engine === "unknown" ? 0.65
    : row.engine === expectedEngine ? 1 : 0.25;
  const sourceQuality = Math.max(0.25, Math.min(1, row.evidenceQuality ?? 0.8));
  const contamination = Math.max(0.25,
    Math.min(1, row.contaminationConfidence ?? 0.8));
  return (0.55 * lexical + 0.35 * family + 0.10 * language) *
    engine * sourceQuality * contamination;
};

export interface ContextualQualityEvidence {
  mean: number;
  lowerBound: number;
  uncertainty: number;
  effectiveSamples: number;
  cases: number;
  sourceIds: string[];
  identityLevel: "EXACT" | "FAMILY_TRANSFER";
  sourceDiversity: number;
}

const neighbors = (knowledge: ModelRoutingKnowledge | undefined, fp: TaskFingerprint) =>
  (knowledge?.taskCases ?? []).map((row) => ({ row, weight: similarity(row, fp) }))
    .filter((item) => item.weight > 0.05)
    .sort((a, b) => b.weight - a.weight || a.row.taskKey.localeCompare(b.row.taskKey))
    .slice(0, 192);

const outcomeFor = (row: RoutingTaskCase, modelId: string) => {
  const exact = row.outcomes.find((item) => item.modelId === modelId);
  if (exact) return { outcome: exact, transferred: false };
  const family = modelFamilyKey(modelId);
  if (!family) return undefined;
  const matches = row.outcomes.filter((item) => modelFamilyKey(item.modelId) === family);
  return matches.length === 1 ? { outcome: matches[0]!, transferred: true } : undefined;
};

export function contextualQuality(modelId: string, prior: number, fp: TaskFingerprint,
  knowledge: ModelRoutingKnowledge | undefined): ContextualQualityEvidence | undefined {
  const rows = neighbors(knowledge, fp).flatMap(({ row, weight }) => {
    const matched = outcomeFor(row, modelId);
    return matched ? [{ row, weight, success: matched.outcome.success,
      transferred: matched.transferred }] : [];
  });
  if (!rows.length) return undefined;
  const sum = rows.reduce((total, row) => total + row.weight, 0);
  const squares = rows.reduce((total, row) => total + row.weight ** 2, 0);
  const effectiveSamples = squares > 0 ? sum ** 2 / squares : 0;
  const successes = rows.reduce((total, row) => total + row.weight * Number(row.success), 0);
  // Weak prior stabilizes sparse neighborhoods but cannot manufacture support.
  const alpha = successes + prior * 2;
  const beta = sum - successes + (1 - prior) * 2;
  const mean = alpha / (alpha + beta);
  const sd = Math.sqrt((alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1)));
  const transferred = rows.some((row) => row.transferred);
  const sourceDiversity = new Set(rows.map((row) =>
    `${row.row.sourceId}:${row.row.harness ?? "unknown"}`)).size;
  const uncertainty = Math.min(0.25, 1.645 * sd + (transferred ? 0.04 : 0) +
    (sourceDiversity < 2 ? 0.015 : 0));
  return { mean, lowerBound: Math.max(0.05, mean - uncertainty), uncertainty,
    effectiveSamples, cases: rows.length,
    sourceIds: [...new Set(rows.map((item) => item.row.sourceId))].sort(),
    identityLevel: transferred ? "FAMILY_TRANSFER" : "EXACT", sourceDiversity };
}

export interface PairwiseRegretProof {
  meanRegret: number;
  upperRegret: number;
  uncertainty: number;
  effectiveSamples: number;
  cases: number;
  candidateWins: number;
  referenceWins: number;
}

/** Direct paired non-inferiority evidence on similar verified tasks. */
export function contextualPairwiseRegret(candidateId: string, referenceId: string,
  fp: TaskFingerprint, knowledge: ModelRoutingKnowledge | undefined): PairwiseRegretProof | undefined {
  const rows = neighbors(knowledge, fp).flatMap(({ row, weight }) => {
    const candidate = outcomeFor(row, candidateId);
    const reference = outcomeFor(row, referenceId);
    return candidate && reference ? [{ weight,
      difference: Number(reference.outcome.success) - Number(candidate.outcome.success),
      transferred: candidate.transferred || reference.transferred }] : [];
  });
  if (!rows.length) return undefined;
  const sum = rows.reduce((total, row) => total + row.weight, 0);
  const squares = rows.reduce((total, row) => total + row.weight ** 2, 0);
  const effectiveSamples = squares > 0 ? sum ** 2 / squares : 0;
  const meanRegret = rows.reduce((total, row) => total + row.weight * row.difference, 0) / sum;
  const variance = rows.reduce((total, row) =>
    total + row.weight * (row.difference - meanRegret) ** 2, 0) / sum;
  // A small finite-sample term prevents an all-tie neighborhood from claiming
  // certainty.  It vanishes as genuinely paired evidence accumulates.
  const transferPenalty = rows.some((row) => row.transferred) ? 0.04 : 0;
  const uncertainty = Math.min(0.5, 1.645 * Math.sqrt((variance + 0.01) /
    Math.max(1, effectiveSamples)) + transferPenalty);
  return { meanRegret, upperRegret: Math.max(0, meanRegret + uncertainty), uncertainty,
    effectiveSamples, cases: rows.length,
    candidateWins: rows.filter((row) => row.difference < 0).length,
    referenceWins: rows.filter((row) => row.difference > 0).length };
}

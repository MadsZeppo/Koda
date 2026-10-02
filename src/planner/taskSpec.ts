import { createHash } from "node:crypto";
import { MAX_TASK_SPEC_BYTES } from "../context/packetPolicy.js";

function splitRequirements(original: string) {
  const result: string[] = [];
  let quote = "", start = 0;
  for (let index = 0; index < original.length; index++) {
    const character = original[index]!;
    if (original[index - 1] !== "\\" && /["'`]/.test(character) &&
      !(character === "'" && /[\w]/.test(original[index - 1] ?? "") && /[\w]/.test(original[index + 1] ?? ""))) {
      if (quote === character) quote = "";
      else if (!quote) quote = character;
    }
    if (!quote && (character === "\n" || (/[.!?]/.test(character) && /\s/.test(original[index + 1] ?? "")))) {
      const end = character === "\n" ? index : index + 1;
      const clause = original.slice(start, end).trim();
      if (clause) result.push(clause);
      start = index + 1;
    }
  }
  if (original.slice(start).trim()) result.push(original.slice(start).trim());
  return result;
}

/** Original text remains authoritative; no unique requirement is discarded. */
export function compileTaskSpec(original: string) {
  const clauses = [...new Set(splitRequirements(original))];
  const parts: string[] = [];
  let current = "";
  for (const clause of clauses) {
    // An indivisible literal/requirement needs an explicit data contract rather
    // than silent truncation. Never pretend a truncated task was implemented.
    if (Buffer.byteLength(clause) > MAX_TASK_SPEC_BYTES)
      throw Error("task_spec_requires_decomposition: indivisible requirement exceeds bounded TaskSpec");
    if (Buffer.byteLength(current + "\n" + clause) > MAX_TASK_SPEC_BYTES) {
      parts.push(current); current = "";
    }
    current += (current ? "\n" : "") + clause;
  }
  if (current) parts.push(current);
  const exactLiterals = [...new Set([...original.matchAll(/`([^`]+)`|"([^"\n]+)"|'([^'\n]+)'/g)]
    .map((match) => match[1] ?? match[2] ?? match[3]!))];
  const explicitPaths = [...new Set(original.match(/(?:[\w.-]+\/)+[\w.-]+\.[\w]+/g) ?? [])];
  const constraints = clauses.filter((clause) => /\b(?:must|never|preserve|only|without|unchanged|do not)\b/i.test(clause));
  const acceptanceCriteria = clauses.filter((clause) => /\b(?:verify|test|check|pass|cover|ensure)\w*\b/i.test(clause));
  return { original, hash: createHash("sha256").update(original).digest("hex"),
    goal: clauses[0] ?? "", requirements: clauses, constraints, acceptanceCriteria, exactLiterals, explicitPaths, parts,
    routingPrompt: parts.length === 1 ? parts[0]! :
      `${parts[0]}\nTaskSpec has ${parts.length} dependent requirement groups; execute every group through the planner.` };
}

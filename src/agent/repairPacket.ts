import { readFile, stat } from "node:fs/promises";
import type { WorkerContext } from "../context/compiler.js";
import { isTestPath, resolveImports } from "../context/compiler.js";
import type { RepoProfile } from "../types.js";
import type { EvidencePacket } from "../planner/schemas.js";
import { safePath } from "./tools.js";
import { retrieveSourceGrounding, type GroundedDefinition } from "../context/sourceGrounding.js";

export interface RepairPacket {
  objective: string;
  acceptanceRequirements: string[];
  allowedWritePaths: string[];
  files: { path: string; content: string; startLine: number; complete: boolean }[];
  relevantSymbols: string[];
  importLinks: [string, string][];
  focusedTestPaths: string[];
  verificationCommands: string[];
  evidenceSummary: string[];
  definitions: GroundedDefinition[];
}

/** Local, bounded context for every locked file; never trust a model's file inventory. */
export async function buildRepairPacket(
  root: string,
  objective: string,
  paths: readonly string[],
  profile: RepoProfile,
  verificationCommands: string[],
  maxPromptBytes: number,
  inspectionEvidence?: EvidencePacket,
  readOnlyTestPaths: readonly string[] = [],
): Promise<{ packet: RepairPacket; context: WorkerContext }> {
  const known = new Set(profile.files);
  const contextPaths = [...new Set([...paths, ...readOnlyTestPaths.filter(isTestPath)])];
  const perFile = Math.max(1200, Math.min(5000, Math.floor((maxPromptBytes - 2500) / contextPaths.length)));
  const terms = (objective.toLowerCase().match(/[a-z]{4,}/g) ?? [])
    .filter((term) => !/^(?:with|from|that|this|tests|test|focused|change|preserve|behavior|implementation)$/.test(term));
  const files: RepairPacket["files"] = [];
  const importLinks: [string, string][] = [];
  for (const file of contextPaths) {
    if (!known.has(file)) throw Error(`Stable locked path is absent from repo profile: ${file}`);
    const target = await safePath(root, file);
    if (!(await stat(target)).isFile()) throw Error(`Stable locked path is not a file: ${file}`);
    const bytes = await readFile(target);
    if (bytes.length > 1024 * 1024) throw Error(`Stable locked file exceeds 1MB: ${file}`);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) throw Error(`Stable locked path is not text: ${file}`);
    const complete = Buffer.byteLength(text) <= perFile;
    let content = text;
    let startLine = 1;
    if (!complete) {
      const lines = text.split(/(?<=\n)/);
      const identifiers = objective.match(/\b[a-zA-Z][a-zA-Z0-9]*_[a-zA-Z0-9_]+\b/g) ?? [];
      const scores = lines.map((line) => {
        const relevant = identifiers.reduce((score, symbol) => score + (line.includes(symbol) ? 10 : 0), 0) +
          terms.reduce((score, term) => score + (line.toLowerCase().includes(term) ? 1 : 0), 0);
        return /^(?:from |import |\s*#|\s*\*)/.test(line) ? 0 : relevant;
      });
      const hit = scores.indexOf(Math.max(...scores));
      const center = hit < 0 ? 0 : hit;
      let start = Math.max(0, center - 8);
      let end = Math.min(lines.length, center + 12);
      while (Buffer.byteLength(lines.slice(start, end).join("")) > perFile && end > center + 1) end--;
      while (Buffer.byteLength(lines.slice(start, end).join("")) > perFile && start < center) start++;
      content = lines.slice(start, end).join("").slice(0, perFile);
      startLine = start + 1;
    }
    files.push({ path: file, content, startLine, complete });
    for (const dependency of resolveImports(file, text, known))
      importLinks.push([file, dependency]);
  }
  const packet: RepairPacket = {
    objective,
    acceptanceRequirements: [objective,
      ...(paths.some(isTestPath) ? ["Update the focused locked test for the requested behavior"] : [])],
    allowedWritePaths: [...paths],
    files,
    relevantSymbols: profile.symbols.filter((symbol) =>
      paths.some((file) => symbol.startsWith(`${file}:`))).slice(0, 20),
    importLinks,
    focusedTestPaths: contextPaths.filter(isTestPath),
    verificationCommands,
    evidenceSummary: (inspectionEvidence?.evidence ?? []).slice(0, 8),
    definitions: await retrieveSourceGrounding(
      root, contextPaths, profile, Math.min(5000, Math.floor(maxPromptBytes * 0.28)),
      [], objective,
    ),
  };
  while (packet.definitions.length && Buffer.byteLength(JSON.stringify(packet)) > maxPromptBytes)
    packet.definitions.pop();
  if (Buffer.byteLength(JSON.stringify(packet)) > maxPromptBytes)
    throw Error("Stable RepairPacket exceeds prompt budget");
  return {
    packet,
    context: {
      files: [...files.map((file) => ({ path: file.path, snippet: file.content })),
        ...packet.definitions.filter((definition) =>
          !files.some((file) => file.path === definition.path)).map((definition) => ({
          path: definition.path, snippet: definition.content,
        }))],
      repoMap: [...new Set([...contextPaths, ...packet.definitions.map((item) => item.path)])],
      localDependencies: [...new Set(importLinks.map(([, dependency]) => dependency))]
        .filter((file) => !paths.includes(file)),
    },
  };
}

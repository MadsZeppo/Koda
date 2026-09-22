import ts from "typescript";
import { readFile } from "node:fs/promises";
import { posix, relative, resolve } from "node:path";

import type { RepoProfile, CommandResult } from "../types.js";
import { truncateBytes } from "./bounds.js";
import { isTestPath, resolveImports } from "./compiler.js";
import { safePath } from "../agent/tools.js";

export interface GroundedDefinition {
  path: string;
  symbol: string;
  startLine: number;
  content: string;
  relationship: "definition" | "import" | "reference" | "test";
}

const sourceExtension = /\.(?:[cm]?[jt]sx?|py|go|rs|java|[ch](?:pp)?|rb)$/i;
const declaration = (symbol: string) => new RegExp(
  `^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?` +
  `(?:class|interface|type|enum|function|const|let|var|def|func|struct|trait|record)\\s+${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "m");

const relativeImportTargets = (file: string, text: string, known: Set<string>) => {
  const result = new Set(resolveImports(file, text, known));
  for (const match of text.matchAll(/^\s*from\s+([.\w/]+)\s+import\s+/gm)) {
    const specifier = match[1]!;
    if (!specifier.startsWith(".")) continue;
    const dots = specifier.match(/^\.+/)?.[0].length ?? 1;
    const rest = specifier.slice(dots).replace(/\./g, "/");
    let base = posix.dirname(file);
    for (let index = 1; index < dots; index++) base = posix.dirname(base);
    const target = posix.normalize(posix.join(base, rest));
    for (const candidate of [`${target}.py`, `${target}/__init__.py`])
      if (known.has(candidate)) result.add(candidate);
  }
  return [...result];
};

const importedSymbols = (text: string) => {
  const symbols = new Set<string>();
  for (const match of text.matchAll(/import\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s+from/g))
    symbols.add(match[1]!);
  for (const match of text.matchAll(/import\s+(?:type\s+)?\{([^}]+)\}\s+from/g))
    for (const item of match[1]!.split(",")) {
      const name = item.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0];
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) symbols.add(name);
    }
  for (const match of text.matchAll(/^\s*from\s+[.\w/]+\s+import\s+([^\n#]+)/gm))
    for (const item of match[1]!.split(",")) {
      const name = item.trim().split(/\s+as\s+/)[0];
      if (name && /^[A-Za-z_][\w]*$/.test(name)) symbols.add(name);
    }
  for (const match of text.matchAll(/(?:const|let|var)\s+\{([^}]+)\}\s*=\s*require\s*\(/g))
    for (const item of match[1]!.split(",")) {
      const name = item.trim().split(/\s*:\s*/)[0];
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) symbols.add(name);
    }
  return [...symbols];
};

const declarationWindow = (text: string, symbol: string) => {
  const lines = text.split("\n");
  const match = declaration(symbol).exec(text);
  if (!match) return undefined;
  const line = text.slice(0, match.index).split("\n").length;
  const start = Math.max(0, line - 3);
  return { startLine: start + 1,
    content: truncateBytes(lines.slice(start, start + 70).join("\n"), 2400) };
};

const classApi = (node: ts.ClassDeclaration | ts.InterfaceDeclaration, source: ts.SourceFile) => {
  const header = source.text.slice(node.getStart(source), node.members.pos).trim().replace(/\s+/g, " ");
  const members = node.members.slice(0, 80).map((member) => {
    const text = member.getText(source).trim();
    const body = text.indexOf("{");
    return (body >= 0 ? text.slice(0, body).trim() : text).replace(/\s+/g, " ");
  });
  return truncateBytes(`${header}\n${members.map((member) => `  ${member}`).join("\n")}`, 3000);
};

async function typescriptDefinitions(root: string, paths: readonly string[], profile: RepoProfile) {
  const candidates = profile.files.filter((file) => /\.[cm]?[jt]sx?$/.test(file)).slice(0, 600);
  if (!paths.some((file) => /\.[cm]?[jt]sx?$/.test(file)) || !candidates.length) return [];
  const absolute = new Map(candidates.map((file) => [resolve(root, file), file]));
  const program = ts.createProgram([...absolute.keys()], {
    allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
  });
  const checker = program.getTypeChecker();
  const found = new Map<string, GroundedDefinition>();
  const add = (node: ts.Declaration, symbol: string, relationship: GroundedDefinition["relationship"]) => {
    const source = node.getSourceFile();
    const relativePath = absolute.get(source.fileName);
    // Collect a bounded pool before task-local ranking. Capping at twelve here
    // made early imports crowd out called methods later in the same test.
    if (!relativePath || paths.includes(relativePath) || found.size >= 80) return;
    let container: ts.Node = node;
    // A called method's implementation is the behavior a test must exercise.
    // Keep that bounded method body instead of replacing it with only the
    // surrounding class API. Types and constructor references still use the
    // compact class/interface surface.
    if (!ts.isMethodDeclaration(node))
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent)) {
          container = parent;
          break;
        }
        if (ts.isSourceFile(parent)) break;
      }
    const startLine = source.getLineAndCharacterOfPosition(container.getStart(source)).line + 1;
    const content = ts.isClassDeclaration(container) || ts.isInterfaceDeclaration(container)
      ? classApi(container, source)
      : truncateBytes(container.getText(source), 2400);
    const key = `${relativePath}:${startLine}`;
    found.set(key, { path: relativePath, symbol, startLine, content, relationship });
  };
  const inspect = (node: ts.Node) => {
    if (ts.isIdentifier(node) &&
        (ts.isImportSpecifier(node.parent) || ts.isTypeReferenceNode(node.parent) ||
          ts.isPropertyAccessExpression(node.parent) || ts.isCallExpression(node.parent))) {
      let symbol = checker.getSymbolAtLocation(node);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      for (const item of symbol?.declarations ?? []) add(item, node.text, "definition");
    }
    ts.forEachChild(node, inspect);
  };
  for (const path of paths) {
    const source = program.getSourceFile(resolve(root, path));
    if (source) inspect(source);
  }
  return [...found.values()];
}

/** Deterministic, bounded source definitions. No model, network, or repository-wide prompt. */
export async function retrieveSourceGrounding(
  root: string,
  paths: readonly string[],
  profile: RepoProfile,
  byteLimit = 5000,
  diagnostics: readonly CommandResult[] = [],
  query = "",
): Promise<GroundedDefinition[]> {
  const known = new Set(profile.files);
  const result = new Map<string, GroundedDefinition>();
  const add = (item: GroundedDefinition) => {
    const key = `${item.path}:${item.startLine}`;
    const current = result.get(key);
    if (!current || item.content.length > current.content.length) result.set(key, item);
  };
  for (const item of await typescriptDefinitions(root, paths, profile)) add(item);

  const requested = new Set<string>();
  for (const check of diagnostics) {
    const text = `${check.stdout}\n${check.stderr}`;
    for (const match of text.matchAll(/["'`](\w+)["'`]|\btype\s+["'`](\w+)["'`]/gi))
      requested.add(match[1] ?? match[2]!);
  }
  for (const path of paths.slice(0, 6)) {
    if (!known.has(path) || !sourceExtension.test(path)) continue;
    const text = await readFile(await safePath(root, path), "utf8").catch(() => "");
    for (const symbol of importedSymbols(text)) requested.add(symbol);
    for (const dependency of relativeImportTargets(path, text, known).slice(0, 4)) {
      const dependencyText = await readFile(await safePath(root, dependency), "utf8").catch(() => "");
      if (dependencyText) add({ path: dependency, symbol: "direct import", startLine: 1,
        content: truncateBytes(dependencyText, 1800), relationship: "import" });
      for (const symbol of requested) {
        const window = declarationWindow(dependencyText, symbol);
        if (window) add({ path: dependency, symbol, ...window, relationship: "import" });
      }
    }
  }

  const symbolFiles = profile.symbols.slice(0, 100);
  for (const symbol of [...requested].slice(0, 16)) {
    const indexed = symbolFiles.find((entry) => new RegExp(`\\b${symbol}\\b`).test(entry));
    let path = indexed?.split(":")[0];
    let text = path && known.has(path)
      ? await readFile(await safePath(root, path), "utf8").catch(() => "") : "";
    let window = text ? declarationWindow(text, symbol) : undefined;
    if (!window) {
      for (const candidate of profile.files.filter((file) => sourceExtension.test(file)).slice(0, 120)) {
        if (paths.includes(candidate)) continue;
        const candidateText = await readFile(await safePath(root, candidate), "utf8").catch(() => "");
        const candidateWindow = declarationWindow(candidateText, symbol);
        if (!candidateWindow) continue;
        path = candidate; text = candidateText; window = candidateWindow;
        break;
      }
    }
    if (path && window && !paths.includes(path))
      add({ path, symbol, ...window, relationship: "definition" });
  }

  // One nearby test is useful evidence, but only when it directly imports a target.
  for (const test of profile.files.filter(isTestPath).slice(0, 100)) {
    if (paths.includes(test)) continue;
    const text = await readFile(await safePath(root, test), "utf8").catch(() => "");
    if (!paths.some((path) => relativeImportTargets(test, text, known).includes(path))) continue;
    add({ path: test, symbol: "nearby test", startLine: 1,
      content: truncateBytes(text, 1800), relationship: "test" });
    break;
  }

  const queryWords = [...new Set(query.toLowerCase().match(/[a-z][a-z0-9]*/g) ?? [])]
    .filter((word) => word.length >= 4 &&
      !/^(?:with|from|that|this|test|tests|unit|deterministic|add|write|create|verify|verifies|include|includes)$/.test(word));
  const ranked = [...result.values()].map((item, index) => ({ item, index,
    score: queryWords.reduce((score, word) => score +
      (`${item.symbol}\n${item.content}`.toLowerCase().includes(word) ? 1 : 0), 0),
  })).sort((left, right) => right.score - left.score || left.index - right.index);
  const bounded: GroundedDefinition[] = [];
  let bytes = 2;
  for (const { item } of ranked) {
    const size = Buffer.byteLength(JSON.stringify(item));
    if (bounded.length >= 12 || bytes + size > byteLimit) continue;
    bounded.push(item);
    bytes += size;
  }
  return bounded;
}

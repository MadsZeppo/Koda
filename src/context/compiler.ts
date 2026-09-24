import { compactEcosystem, projectFor } from "../repo/ecosystem.js";
import type { Subtask, Plan } from "../planner/schemas.js";
import { open, stat } from "node:fs/promises";
import { posix } from "node:path";
import type { Config } from "../config.js";
import type { RepoProfile } from "../types.js";
import { safePath } from "../agent/tools.js";
import { truncateBytes } from "./bounds.js";

export const isTestPath = (p: string) =>
  /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|(?:^|\/)test_|[._](?:test|spec)\./i.test(
    p,
  );

export const isSourcePath = (p: string) =>
  /\.(?:[cm]?[jt]sx?|py|go|rs|java|[ch](?:pp)?|rb)$/i.test(p) &&
  !isTestPath(p);

export interface WorkerContext {
  files: { path: string; snippet: string }[];
  repoMap: string[];
  localDependencies: string[];
  completePaths?: string[];
}

/** Exact target context for an already-scoped edit; no repository search. */
export async function compileTargetContext(
  root: string,
  target: string,
  task: string,
  limits: Config["context"],
): Promise<WorkerContext> {
  const resolved = await safePath(root, target);
  const info = await stat(resolved);

  /*
   * For an already-scoped TINY edit, prefer giving the worker the entire
   * target file when it fits inside the configured bounded context.
   *
   * This matters because completePaths enables the mutation-only tool policy
   * in the worker: the model can receive write_file without needing repository
   * rediscovery tools such as read_file, search_code, or run_command.
   */
  if (info.isFile() && info.size <= limits.readBytes) {
    const fullText = await prefix(root, target, limits.readBytes);

    const completeContext: WorkerContext = {
      files: [{ path: target, snippet: fullText }],
      repoMap: [target],
      localDependencies: [],
      completePaths: [target],
    };

    /*
     * Use the serialized context size rather than only the raw file size.
     * JSON escaping can make the actual model context slightly larger than
     * the source file itself.
     */
    if (
      Buffer.byteLength(JSON.stringify(completeContext)) <= limits.maxBytes
    ) {
      return completeContext;
    }
  }

  /*
   * Large targets still receive only a bounded excerpt in the model prompt,
   * but locating that excerpt must not be limited to the first readBytes of
   * the file. Otherwise a precise edit near the middle/end of a README (or
   * other large target) is anchored to the file prefix and edit_file is given
   * irrelevant text.
   *
   * Scan a bounded amount of the target locally, score candidate lines against
   * the task, then expose only the configured excerpt budget. The scan is local
   * retrieval, not model context.
   */
  const scanBytes = Math.min(
    info.size,
    Math.max(limits.readBytes, 2 * 1024 * 1024),
  );
  const text = await prefix(root, target, scanBytes);
  const lines = text.split("\n");

  const terms = taskTerms(task).filter(
    (term) => !target.toLowerCase().includes(term),
  );
  const phrasePairs = terms
    .slice(0, 12)
    .flatMap((term, index) =>
      index + 1 < terms.length ? [[term, terms[index + 1]!] as const] : [],
    );

  let hit = -1;
  let bestScore = 0;
  for (const [index, line] of lines.entries()) {
    const lower = line.toLowerCase();
    let score = terms.reduce(
      (sum, term) => sum + (lower.includes(term) ? 2 : 0),
      0,
    );
    score += phrasePairs.reduce(
      (sum, [left, right]) =>
        sum +
        (lower.includes(`${left} ${right}`) ||
        lower.includes(`${left}-${right}`)
          ? 8
          : 0),
      0,
    );
    if (/^\s*#{1,6}\s/.test(line) && score > 0) score += 1;
    if (score > bestScore) {
      bestScore = score;
      hit = index;
    }
  }

  // Put the best anchor first so very small fileBytes budgets still include
  // the requested heading/sentence and the immediately following edit target.
  const start = hit >= 0 ? hit : 0;

  const snippet = truncateBytes(
    lines
      .slice(start, start + 100)
      .map((line, index) => `${start + index + 1}: ${line}`)
      .join("\n"),
    Math.max(1, Math.min(limits.fileBytes, limits.maxBytes - 256)),
  );

  return {
    files: [{ path: target, snippet }],
    repoMap: [target],
    localDependencies: [],
    completePaths: [],
  };
}

export function compactProfile(profile: RepoProfile) {
  return {
    ecosystem: compactEcosystem(profile.ecosystem),
    commit: profile.commit,
    packageManager: profile.packageManager,
    extensions: profile.extensions,
    verificationCommands: profile.verificationCommands,
  };
}

const stopWords = new Set(
  "fix the a an and or in of to so all tests test pass function helper broken bug with for this that implement return correct repair file source change update deterministic regression unit proving proves stop stops when reached reach make smallest necessary run relevant".split(
    " ",
  ),
);

export function taskTerms(task: string) {
  return [
    ...new Set(
      (task.toLowerCase().match(/[a-z_][a-z0-9_-]*/g) ?? []).filter(
        (t) => t.length >= 3 && !stopWords.has(t),
      ),
    ),
  ].slice(0, 24);
}

async function prefix(root: string, file: string, limit: number) {
  const handle = await open(await safePath(root, file), "r");

  try {
    if (!(await handle.stat()).isFile()) return "";

    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, limit, 0);

    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

export function resolveImports(
  file: string,
  text: string,
  files: Set<string>,
): string[] {
  const result = new Set<string>();

  for (const match of text.matchAll(
    /(?:from\s*|require\s*\(\s*|import\s*\(\s*|import\s*)["'](\.[^"']+)["']/g,
  )) {
    const target = posix.normalize(posix.join(posix.dirname(file), match[1]!));

    for (const path of [
      target,
      target.replace(/\.[cm]?js$/, ".ts"),
      ...[
        ".js",
        ".cjs",
        ".mjs",
        ".ts",
        ".tsx",
        ".jsx",
        "/index.js",
        "/index.ts",
      ].map((ext) => target + ext),
    ]) {
      if (files.has(path)) {
        result.add(path);
        break;
      }
    }
  }

  return [...result];
}

function relevantNamedTestImports(
  file: string,
  text: string,
  files: Set<string>,
  terms: string[],
) {
  const all = resolveImports(file, text, files);
  if (!all.length) return all;
  const lines = text.split("\n");
  const relevantLines = new Set<number>();
  const starts = lines.map((line, index) => /^\s*test\s*\(/.test(line) ? index : -1)
    .filter((index) => index >= 0);
  const ranges = starts.map((start, index) => ({ start,
    end: (starts[index + 1] ?? lines.length) - 1 }));
  for (const range of ranges) {
    const block = lines.slice(range.start, range.end + 1).join("\n").toLowerCase();
    if (terms.some((term) => block.includes(term)))
      for (let cursor = range.start; cursor <= range.end; cursor++) relevantLines.add(cursor);
  }
  for (const [index, line] of lines.entries()) {
    if (!terms.some((term) => line.toLowerCase().includes(term)) || relevantLines.has(index))
      continue;
    for (let cursor = Math.max(0, index - 2);
      cursor <= Math.min(lines.length - 1, index + 2); cursor++)
      relevantLines.add(cursor);
  }
  if (!relevantLines.size) return all;
  const localWindow = lines.filter((_line, index) => relevantLines.has(index))
    .join("\n").replace(/^\s*import[\s\S]*?;\s*$/gm, "");
  const selected = new Set<string>();
  for (const match of text.matchAll(
    /import\s+(?:type\s+)?([\s\S]*?)\s+from\s*["'](\.[^"']+)["']/g,
  )) {
    const resolved = resolveImports(file, match[0], files)[0];
    if (!resolved) continue;
    const clause = match[1]!;
    const bindings = [
      ...[...clause.matchAll(/(?:^|[,{}])\s*([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?/g)]
        .map((binding) => binding[2] ?? binding[1]!),
      ...[...clause.matchAll(/\*\s+as\s+([A-Za-z_$][\w$]*)/g)]
        .map((binding) => binding[1]!),
    ];
    if (bindings.some((binding) =>
      new RegExp(`\\b${binding.replace(/[$]/g, "\\$")}\\b`).test(localWindow)))
      selected.add(resolved);
  }
  return selected.size ? [...selected] : all;
}

/**
 * Read hints are advisory. Independent sibling ownership is not a reason to
 * preload its source; actual imports are still retrieved below.
 */
export function workerReadPaths(
  subtask: Subtask,
  tasks: Plan["subtasks"] = [],
) {
  const ancestors = new Set<string>();

  const visit = (id: string) => {
    if (ancestors.has(id)) return;

    ancestors.add(id);
    tasks.find((t) => t.id === id)?.dependsOn.forEach(visit);
  };

  subtask.dependsOn.forEach(visit);

  const intersects = (a: string, b: string) =>
    a === "." ||
    b === "." ||
    a === b ||
    a.startsWith(b + "/") ||
    b.startsWith(a + "/");

  const siblings = tasks
    .filter((t) => t.id !== subtask.id && !ancestors.has(t.id))
    .flatMap((t) => t.likelyWritePaths)
    .filter(
      (p) => !subtask.likelyWritePaths.some((own) => intersects(own, p)),
    );

  return subtask.likelyReadPaths.filter(
    (p) =>
      p !== "." &&
      !/[*?\[\]]/.test(p) &&
      !siblings.some((s) => intersects(p, s)),
  );
}

/** Bounded local retrieval, no model, network, embeddings, or unbounded file reads. */
export async function compileContext(
  root: string,
  task: string,
  paths: string[],
  profile: RepoProfile,
  limits: Config["context"],
  focused = false,
): Promise<WorkerContext> {
  const files = profile.files;

  const assigned = (file: string) =>
    paths.some(
      (p) =>
        p === "." ||
        file === p ||
        file.startsWith(p.replace(/\/$/, "") + "/"),
    );

  const known = new Set(files);
  const terms = taskTerms(task);
  const normalizedTask = task.toLowerCase();
  const explicitlyNamed = new Set(files.filter((file) =>
    normalizedTask.includes(file.toLowerCase())));
  const namedTests = new Set([...explicitlyNamed].filter(isTestPath));
  // An exact test path is stronger localization evidence than broad filename
  // and keyword matches. Keep its import neighborhood small and deterministic.
  const localizedTestTask = namedTests.size > 0;
  const scores = new Map<string, number>();
  const texts = new Map<string, string>();

  const add = (file: string, score: number) => {
    if (known.has(file)) {
      scores.set(file, Math.max(scores.get(file) ?? 0, score));
    }
  };

  for (const file of files) {
    const pathAssigned = paths.some(
        (p) =>
          p === "." ||
          file === p ||
          file.startsWith(p.replace(/\/$/, "") + "/"),
      );
    if (pathAssigned && (!localizedTestTask || namedTests.has(file))) {
      add(file, namedTests.has(file) ? 140 : isTestPath(file) ? 90 : 110);
    }

    if (!focused && explicitlyNamed.has(file)) {
      add(file, isTestPath(file) ? 140 : 120);
    } else if (!focused && !localizedTestTask && task.includes(posix.basename(file))) {
      add(file, 100);
    }

    if (!focused && !localizedTestTask && terms.some((t) => file.toLowerCase().includes(t))) {
      add(file, isTestPath(file) ? 85 : 70);
    }
  }

  const ordered = [...files].sort(
    (a, b) =>
      (scores.get(b) ?? 0) - (scores.get(a) ?? 0) || a.localeCompare(b),
  );

  for (const file of ordered
    .filter(
      (f) =>
        !focused ||
        assigned(f) ||
        isTestPath(f) ||
        /(?:package\.json|tsconfig\.json|pyproject\.toml|go\.mod|Cargo\.toml)$/.test(
          f,
        ),
    )
    .filter((f) => !localizedTestTask || explicitlyNamed.has(f) ||
      /(?:package\.json|tsconfig\.json|pyproject\.toml|go\.mod|Cargo\.toml)$/.test(f))
    .slice(0, limits.scanFiles)) {
    if (
      !/\.(?:[cm]?[jt]sx?|py|go|rs|java|[ch](?:pp)?|rb|json|toml|yaml|yml)$/.test(
        file,
      )
    ) {
      continue;
    }

    try {
      const text = await prefix(root, file, limits.readBytes);

      texts.set(file, text);

      const hits = terms.filter((t) =>
        text.toLowerCase().includes(t),
      ).length;

      if (hits && !focused && (!localizedTestTask || explicitlyNamed.has(file) || !isTestPath(file))) {
        add(file, Math.min(60, hits * 10));
      }
    } catch {}
  }

  const primary = [...scores]
    .filter(([f, s]) => s >= 70 && !isTestPath(f))
    .map(([f]) => f);
  const importSeeds = [...new Set([...primary, ...explicitlyNamed])];

  const dependencies = new Set<string>();

  for (const file of importSeeds) {
    let source = texts.get(file);
    if (source === undefined) {
      try {
        source = await prefix(root, file, limits.readBytes);
        texts.set(file, source);
      } catch { source = ""; }
    }
    const unit = projectFor(profile.ecosystem, file);

    if (!localizedTestTask)
      for (const config of unit?.configFiles ?? []) add(config, 80);

    const imports = namedTests.has(file)
      ? relevantNamedTestImports(file, source, known, terms)
      : resolveImports(file, source, known);
    for (const dep of imports) {
      dependencies.add(dep);
      add(dep, namedTests.has(file) ? 125 : 75);
    }

    const stem = posix.basename(file).replace(/\.[^.]+$/, "");

    for (const test of localizedTestTask ? [...namedTests] : files.filter(isTestPath)) {
      if (
        posix.basename(test).includes(stem) ||
        resolveImports(test, texts.get(test) ?? "", known).includes(file)
      ) {
        add(test, 95);
      }
    }

    if (!localizedTestTask) {
      let dir = posix.dirname(file);
      while (true) {
        const pkg = posix.join(dir, "package.json");
        if (known.has(pkg)) {
          add(pkg, 80);
          break;
        }
        if (dir === ".") break;
        dir = posix.dirname(dir);
      }
    }
  }

  for (const file of localizedTestTask ? [] : [
    "package.json",
    "pyproject.toml",
    "go.mod",
    "Cargo.toml",
    "tsconfig.json",
  ]) {
    add(file, 40);
  }

  const result: WorkerContext = {
    files: [],
    repoMap: [],
    localDependencies: [],
  };

  for (const [file] of [...scores].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )) {
    if (result.files.length >= limits.maxFiles) break;

    let text = texts.get(file);

    if (text === undefined) {
      try {
        text = await prefix(root, file, limits.readBytes);
      } catch {
        continue;
      }
    }

    const lines = text.split("\n");

    const hit = lines.findIndex((l) =>
      terms.some((t) => l.toLowerCase().includes(t)),
    );

    const start = Math.max(0, hit - 3);

    const snippet = truncateBytes(
      lines
        .slice(start, start + 100)
        .map((line, i) => `${start + i + 1}: ${line}`)
        .join("\n"),
      limits.fileBytes,
    );

    const entry = { path: file, snippet };

    result.files.push(entry);

    if (Buffer.byteLength(JSON.stringify(result)) > limits.maxBytes) {
      result.files.pop();
    }
  }

  for (const dep of dependencies) {
    result.localDependencies.push(dep);

    if (Buffer.byteLength(JSON.stringify(result)) > limits.maxBytes) {
      result.localDependencies.pop();
    }
  }

  for (const file of ordered
    .filter((f) => !focused || scores.has(f))
    .slice(0, 40)) {
    result.repoMap.push(file);

    if (Buffer.byteLength(JSON.stringify(result)) > limits.maxBytes) {
      result.repoMap.pop();
    }
  }

  return result;
}

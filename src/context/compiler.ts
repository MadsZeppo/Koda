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
  "fix the a an and or in of to so all tests test pass function helper broken bug with for this that implement return correct repair file source change update".split(
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
  const scores = new Map<string, number>();
  const texts = new Map<string, string>();

  const add = (file: string, score: number) => {
    if (known.has(file)) {
      scores.set(file, Math.max(scores.get(file) ?? 0, score));
    }
  };

  for (const file of files) {
    if (
      paths.some(
        (p) =>
          p === "." ||
          file === p ||
          file.startsWith(p.replace(/\/$/, "") + "/"),
      )
    ) {
      add(file, isTestPath(file) ? 90 : 110);
    }

    if (
      !focused &&
      (task.includes(file) || task.includes(posix.basename(file)))
    ) {
      add(file, 100);
    }

    if (!focused && terms.some((t) => file.toLowerCase().includes(t))) {
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

      if (hits && !focused) {
        add(file, Math.min(60, hits * 10));
      }
    } catch {}
  }

  const primary = [...scores]
    .filter(([f, s]) => s >= 70 && !isTestPath(f))
    .map(([f]) => f);

  const dependencies = new Set<string>();

  for (const file of primary) {
    const unit = projectFor(profile.ecosystem, file);

    for (const config of unit?.configFiles ?? []) {
      add(config, 80);
    }

    for (const dep of resolveImports(file, texts.get(file) ?? "", known)) {
      dependencies.add(dep);
      add(dep, 75);
    }

    const stem = posix.basename(file).replace(/\.[^.]+$/, "");

    for (const test of files.filter(isTestPath)) {
      if (
        posix.basename(test).includes(stem) ||
        resolveImports(test, texts.get(test) ?? "", known).includes(file)
      ) {
        add(test, 95);
      }
    }

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

  for (const file of [
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
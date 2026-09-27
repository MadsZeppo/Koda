import { compactEcosystem } from "../repo/ecosystem.js";
import { open, lstat } from "node:fs/promises";
import { posix } from "node:path";
import type { Config } from "../config.js";
import type { RepoProfile } from "../types.js";
import { safePath } from "../agent/tools.js";
import {
  isSourcePath,
  isTestPath,
  resolveImports,
} from "../context/compiler.js";
import { planSchema, type Plan } from "./schemas.js";
import { validateDag } from "../orchestrator/dag.js";
import { normalizePlan } from "../orchestrator/coalesce.js";
import { unambiguousRepoPath } from "../repo/navigation.js";
export type PlannerComplexity = "trivial" | "standard" | "complex";
export interface PlanningFile {
  path: string;
  symbols: string[];
  imports: string[];
  tests: string[];
  complete: boolean;
}
export function validatePlanningCandidate(raw: unknown): Plan {
  const plan = validateDag(planSchema.parse(raw));
  if (!plan.subtasks.some((task) => task.readOnly !== true))
    throw Error("Planner produced only discovery tasks; no mutation work");
  const normalized = normalizePlan(plan);
  for (const t of normalized.plan.subtasks) {
    if (
      !t.objective.trim() ||
      !t.integrationContract.trim() ||
      t.likelyWritePaths.some((p) => p === "." || /[\0*?\[\]]/.test(p))
    )
      throw Error("Planner did not establish executable write responsibility");
  }
  return plan; // The runtime retains its normal normalization/coalescing telemetry.
}
const mutationVerb =
  "add|write|create|modify|update|change|edit|implement|remove|delete|refactor";

/** Negative acceptance constraints are prohibitions, never mutation intent. */
const withoutNegativeMutationClauses = (task: string) =>
  task
    .replace(
      new RegExp(
        `\\b(?:do|must|should|may|can|will)\\s+not\\s+(?:${mutationVerb})\\b`,
        "gi",
      ),
      " ",
    )
    .replace(
      new RegExp(`\\bnever\\s+(?:${mutationVerb})\\b`, "gi"),
      " ",
    )
    .replace(
      /\bwithout\s+(?:adding|writing|creating|modifying|updating|changing|editing|implementing|removing|deleting|refactoring)\b/gi,
      " ",
    );

const testEditRequested = (task: string) => {
  const actionable = withoutNegativeMutationClauses(task);
  return /\b(?:add|write|create)\b.{0,35}\b(?:tests?|specs?|regression)\b|\b(?:modify|update|change|edit)\b.{0,35}\b(?:tests?|specs?)\b/i.test(
    actionable,
  );
};

const repositoryDirectories = (files: readonly string[]) => {
  const directories = new Set<string>();

  for (const file of files) {
    let directory = posix.dirname(file);

    while (directory !== ".") {
      directories.add(directory);
      directory = posix.dirname(directory);
    }
  }

  return directories;
};

/** Reconcile model-supplied ownership with the actual repository before execution. */
export async function reconcilePlannedPaths(
  plan: Plan,
  task: string,
  profile: RepoProfile,
  requiredMutationPaths: readonly string[] = [],
): Promise<Plan> {
  const known = new Set(profile.files);
  const knownDirectories = repositoryDirectories(profile.files);
  const allowTestWrites = testEditRequested(task);
  const removed = new Map<string, string[]>();
  const kept = plan.subtasks.filter((subtask) => {
    if (
      allowTestWrites ||
      subtask.readOnly === true ||
      !subtask.likelyWritePaths.length ||
      !subtask.likelyWritePaths.every(isTestPath)
    )
      return true;
    removed.set(subtask.id, subtask.dependsOn);
    return false;
  });
  const expand = (id: string): string[] =>
    removed.has(id) ? removed.get(id)!.flatMap(expand) : [id];
  for (const subtask of kept) {
    subtask.dependsOn = [...new Set(subtask.dependsOn.flatMap(expand))];
    if (!allowTestWrites && subtask.readOnly !== true)
      subtask.likelyWritePaths = subtask.likelyWritePaths.filter(
        (path) => !isTestPath(path),
      );
    const rewrite = (oldPath: string, actual: string) => {
      for (const field of [
        "title",
        "objective",
        "integrationContract",
      ] as const)
        subtask[field] = subtask[field].replaceAll(oldPath, actual);
    };
    const resolvedWrites: string[] = [];
    for (const path of subtask.likelyWritePaths) {
      if (knownDirectories.has(path)) {
        const stat = await lstat(await safePath(profile.root, path));
        if (!stat.isDirectory())
          throw Error(`Unsafe planned write directory: ${path}`);
        resolvedWrites.push(path);
        continue;
      }

      const actual = known.has(path)
        ? path
        : unambiguousRepoPath(path, profile.files);
      if (actual) {
        const stat = await lstat(await safePath(profile.root, actual));
        if (!stat.isFile() || stat.nlink > 1)
          throw Error(`Unsafe planned write path: ${actual}`);
        if (path !== actual) rewrite(path, actual);
        resolvedWrites.push(actual);
        continue;
      }

      const explicitCreation =
        task.includes(path) &&
        /\b(?:add|create|implement|introduce)\b/i.test(task);
      const supportedTestCreation = allowTestWrites && isTestPath(path);
      if (!explicitCreation && !supportedTestCreation)
        throw Error(
          `Planned write path does not exist and has no unambiguous repository match: ${path}`,
        );

      const parent = await lstat(
        posix.dirname(path) === "."
          ? profile.root
          : await safePath(profile.root, posix.dirname(path)),
      );
      if (!parent.isDirectory())
        throw Error(`Planned write parent does not exist: ${path}`);
      resolvedWrites.push(path);
    }
    subtask.likelyWritePaths = [...new Set(resolvedWrites)];
    const reads: string[] = [];
    for (const path of subtask.likelyReadPaths) {
      const actual = known.has(path)
        ? path
        : unambiguousRepoPath(path, profile.files);
      if (actual) {
        const stat = await lstat(await safePath(profile.root, actual));
        if (!stat.isFile() || stat.nlink > 1)
          throw Error(`Unsafe planned read path: ${actual}`);
        if (path !== actual) rewrite(path, actual);
        reads.push(actual);
      } else {
        try {
          const stat = await lstat(await safePath(profile.root, path));
          if (stat.isDirectory()) {
            reads.push(path);
            continue;
          }
        } catch {}
        // Read hints are advisory; discard nonexistent paths and name the
        // uncertainty so the coder does not repeatedly request them.
        subtask.objective = subtask.objective.replaceAll(
          path,
          "existing repository files",
        );
      }
    }
    subtask.likelyReadPaths = [...new Set(reads)];
  }
  const reconciled = validatePlanningCandidate({ ...plan, subtasks: kept });
  const mutationRoots = reconciled.subtasks
    .filter((subtask) => subtask.readOnly !== true)
    .flatMap((subtask) => [
      ...subtask.likelyWritePaths,
      ...subtask.likelyReadPaths,
    ]);
  const uncovered = [...new Set(requiredMutationPaths)]
    .filter(
      (path) => known.has(path) && isSourcePath(path) && !isTestPath(path),
    )
    .filter(
      (path) =>
        !mutationRoots.some(
          (root) =>
            path === root || path.startsWith(root.replace(/\/$/, "") + "/"),
        ),
    );
  if (uncovered.length)
    throw Error(
      `Planner omitted evidence-backed mutation targets: ${uncovered.join(", ")}`,
    );
  return reconciled;
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentioned = (s: string, alias: string) =>
  new RegExp(`(?<![A-Za-z0-9_/-])${escape(alias)}(?![A-Za-z0-9_/-])`, "i").test(
    s,
  );
const imports = (text: string) =>
  [
    ...text.matchAll(
      /(?:from\s*|require\s*\(\s*|import\s*\(\s*|import\s*)["']([^"']+)["']/g,
    ),
  ].map((m) => m[1]!);
async function read(root: string, path: string, limit: number) {
  try {
    const full = await safePath(root, path),
      stat = await lstat(full);
    if (!stat.isFile() || stat.nlink > 1) return { text: "", complete: false };
    const h = await open(full, "r");
    try {
      const buffer = Buffer.alloc(limit);
      const r = await h.read(buffer, 0, limit, 0);
      return {
        text: buffer.subarray(0, r.bytesRead).toString("utf8"),
        complete: stat.size <= limit,
      };
    } finally {
      await h.close();
    }
  } catch {
    return { text: "", complete: false };
  }
}
export async function planningPolicy(
  task: string,
  profile: RepoProfile,
  settings: Config["planner"],
) {
  const sources = profile.files.filter(
    (f) => isSourcePath(f) && /\.[cm]?[jt]sx?$/.test(f),
  );
  const symbols = (file: string) =>
    profile.symbols
      .filter((s) => s.startsWith(file + ":"))
      .flatMap((s) =>
        [...s.matchAll(/\b(?:function|class|const|let|var)\s+([\w$]+)/g)].map(
          (m) => m[1]!,
        ),
      )
      .slice(0, 8);
  const aliases = new Map<string, string[]>();
  for (const file of sources)
    for (const alias of new Set([
      file,
      posix.basename(file),
      ...symbols(file).filter((s) => s.length >= 3),
      ...(posix.basename(file).replace(/\.[^.]+$/, "").length >= 3
        ? [posix.basename(file).replace(/\.[^.]+$/, "")]
        : []),
    ])) {
      aliases.set(alias, [...new Set([...(aliases.get(alias) ?? []), file])]);
    }
  let remaining = task,
    ambiguous = false;
  const matched = new Set<string>();
  for (const [alias, paths] of [...aliases].sort(
    (a, b) => b[0].length - a[0].length,
  ))
    if (mentioned(remaining, alias)) {
      if (paths.length !== 1) ambiguous = true;
      paths.forEach((p) => matched.add(p));
      remaining = remaining.replace(
        new RegExp(
          `(?<![A-Za-z0-9_/-])${escape(alias)}(?![A-Za-z0-9_/-])`,
          "gi",
        ),
        " ",
      );
    }
  const independent = /\b(?:independent(?:ly)?|unrelated)\b/i.test(task);
  const coupled =
    /\b(?:depend\w*|before|after|ordering|sequence|shared|migrat\w*|schema|architect\w*|cross[- ]\w+|across|auth\w*|api|database|refactor|integrat\w*|then|not independent)\b/i.test(
      task,
    );
  let complexity: PlannerComplexity =
    coupled || ambiguous || task.length > 1000 || matched.size > 4
      ? "complex"
      : independent && matched.size >= 2 && !ambiguous
        ? "trivial"
        : "standard";
  let reason =
    complexity === "complex"
      ? "Dependencies, ordering, or cross-cutting scope require model planning"
      : "Insufficient evidence for deterministic decomposition";
  // Concrete ownership and independent focused checks establish the work;
  // wording outside the paths need not come from a small vocabulary. An
  // additional mutation request, however, has no assigned owner here.
  const actionableRemaining = withoutNegativeMutationClauses(remaining);
  const extraWork =
    /\b(?:also|add|change|update|implement|create|remove|delete|refactor)\b/i.test(
      actionableRemaining,
    );
  const targetPaths = [...matched].sort();
  const tests = profile.files.filter(isTestPath);
  const texts = new Map<string, { text: string; complete: boolean }>();
  const candidates = [...targetPaths.slice(0, 8), ...tests.slice(0, 64)];
  await Promise.all(
    candidates.map(async (p) =>
      texts.set(p, await read(profile.root, p, 32768)),
    ),
  );
  const known = new Set(profile.files);
  const info: PlanningFile[] = targetPaths.slice(0, 8).map((path) => {
    const source = texts.get(path)!;
    return {
      path,
      symbols: symbols(path),
      imports: imports(source.text),
      complete: source.complete,
      tests: tests.filter((t) => {
        const data = texts.get(t);
        return (
          data?.complete && resolveImports(t, data.text, known).includes(path)
        );
      }),
    };
  });
  if (info.some((f) => f.imports.length)) {
    complexity = "complex";
    reason =
      "Mapped components have dependencies; model must establish safe ordering and ownership";
  }
  // Native Node checks are already supported by Koda; do not infer another runner.
  const native =
    !profile.scripts.pretest &&
    !profile.scripts.posttest &&
    /^node --test(?:\s+[\w./*'-]+)*$/.test(profile.scripts.test ?? "");
  let candidate: Plan | undefined;
  const namedTargets = targetPaths.filter((file) => {
    const base = posix.basename(file);
    const stem = base.replace(/\.[^.]+$/, "");
    return [file, base, ...(stem.length >= 3 ? [stem] : [])].some((alias) =>
      mentioned(task, alias),
    );
  });
  const targetSet = new Set(targetPaths);
  const sourceDependencies = new Map(
    info.map((file) => [
      file.path,
      resolveImports(file.path, texts.get(file.path)!.text, known).filter(
        (dependency) => targetSet.has(dependency),
      ),
    ]),
  );
  const hasMappedDependencies = [...sourceDependencies.values()].some(
    (dependencies) => dependencies.length > 0,
  );
  const boundedSourceGraph = info.every((file) => {
    const source = texts.get(file.path)!;
    const localImports = imports(source.text).filter((specifier) =>
      specifier.startsWith("."),
    );
    const resolved = resolveImports(file.path, source.text, known);
    return (
      source.complete &&
      localImports.length === resolved.length &&
      resolved.every((dependency) => targetSet.has(dependency)) &&
      !/\b(?:eval|process|globalThis|global|fetch|Deno|Bun|window|document)\b/.test(
        source.text,
      )
    );
  });
  const reachableSources = (roots: string[]) => {
    const seen = new Set<string>();
    const pending = [...roots];
    while (pending.length) {
      const path = pending.pop()!;
      if (seen.has(path)) continue;
      seen.add(path);
      pending.push(...(sourceDependencies.get(path) ?? []));
    }
    return seen;
  };
  const coupledChecks = tests.filter((path) => {
    const test = texts.get(path);
    if (!test?.complete || !/node:test/.test(test.text) ||
        !/node:assert/.test(test.text) || !/\bassert(?:\.|\s*\()/.test(test.text))
      return false;
    const specs = imports(test.text);
    const resolved = resolveImports(path, test.text, known);
    if (specs.filter((specifier) => specifier.startsWith(".")).length !==
        resolved.length) return false;
    const roots = resolved.filter((dependency) => targetSet.has(dependency));
    if (!roots.length || resolved.some((dependency) => !targetSet.has(dependency)))
      return false;
    const reachable = reachableSources(roots);
    return targetPaths.every((target) => reachable.has(target));
  }).slice(0, 4);
  if (
    ((independent && !coupled && !hasMappedDependencies) ||
      hasMappedDependencies) &&
    /\b(?:fix|repair)\b/i.test(task) &&
    !ambiguous &&
    !extraWork &&
    namedTargets.length === targetPaths.length &&
    task.length <= 600 &&
    targetPaths.length >= 2 &&
    targetPaths.length <= 4 &&
    sources.length <= 40 &&
    tests.length <= 64 &&
    native
  ) {
    const checks = info.map((f) =>
      f.tests.filter((t) => {
        const test = texts.get(t)!;
        const local = resolveImports(t, test.text, known);
        const specs = imports(test.text);
        return (
          specs.filter((p) => p.startsWith(".")).length === 1 &&
          local.length === 1 &&
          local[0] === f.path &&
          imports(test.text).every(
            (p) =>
              p.startsWith(".") ||
              p === "node:test" ||
              p === "node:assert" ||
              p === "node:assert/strict",
          ) &&
          /node:test/.test(test.text) &&
          /node:assert/.test(test.text) &&
          /\bassert(?:\.|\s*\()/.test(test.text)
        );
      }),
    );
    if (
      boundedSourceGraph &&
      checks.every((c) => c.length === 1) &&
      new Set(checks.flat()).size === info.length
    ) {
      const ids = new Map(
        info.map((file, index) => [file.path, `fix-${index + 1}`]),
      );
      candidate = {
        taskSummary: task,
        acceptanceCriteria: [
          "All assigned checks and final repository verification pass",
        ],
        subtasks: info.map((f, i) => ({
          id: ids.get(f.path)!,
          title: `Fix ${f.path}`,
          objective: `Repair the failing behavior in ${f.path} so ${checks[i]![0]} passes. Only this bounded component is assigned.`,
          dependsOn: sourceDependencies
            .get(f.path)!
            .map((dependency) => ids.get(dependency)!),
          likelyReadPaths: [f.path, checks[i]![0]!],
          likelyWritePaths: [f.path],
          integrationContract: `Preserve the public interface of ${f.path}; consume imported target APIs after their dependency tasks and do not modify tests or sibling components.`,
          verificationCommands: [
            `node --test '${checks[i]![0]!.replaceAll("'", "'\\''")}'`,
          ],
          estimatedDifficulty: "normal",
          parallelSafe: true,
        })),
      };
      try {
        candidate = validatePlanningCandidate(candidate);
      } catch {
        candidate = undefined;
      }
      if (!candidate)
        reason = "Deterministic candidate failed authoritative validation";
      if (candidate)
        reason =
          hasMappedDependencies
            ? "Explicit repairs map to a bounded repository-backed source/test dependency graph"
            : "Explicit independent repairs map uniquely to disjoint leaf files and distinct native tests";
      complexity = "trivial";
    } else
      reason =
        "Missing distinct targeted tests, incomplete source, or non-leaf dependencies";
  }
  // A small, fully inspected connected source graph exercised by one focused
  // integration test is already a deterministic work unit. Keep every named
  // source available for a single non-parallel worker, but do not spend a
  // planner call trying to guess which dependency will ultimately need a diff.
  if (!candidate && hasMappedDependencies &&
      boundedSourceGraph && coupledChecks.length > 0 &&
      /\b(?:fix|repair)\b/i.test(task) && !ambiguous && !extraWork &&
      namedTargets.length === targetPaths.length && task.length <= 600 &&
      targetPaths.length >= 2 && targetPaths.length <= 4 &&
      sources.length <= 40 && tests.length <= 64 && native) {
    candidate = validatePlanningCandidate({
      taskSummary: task,
      acceptanceCriteria: [
        "The focused integration test and final repository verification pass",
      ],
      subtasks: [{
        id: "fix-coupled-flow",
        title: `Fix coupled flow through ${targetPaths.join(", ")}`,
        objective: `${task} Work only within the inspected connected source graph and preserve its public APIs.`,
        dependsOn: [],
        likelyReadPaths: [...targetPaths, ...coupledChecks],
        likelyWritePaths: targetPaths,
        integrationContract: "Preserve existing public APIs; use the focused integration test as the behavioral contract and do not modify tests.",
        verificationCommands: coupledChecks.map((path) =>
          `node --test '${path.replaceAll("'", "'\\''")}'`),
        estimatedDifficulty: "normal",
        parallelSafe: false,
      }],
    });
    complexity = "trivial";
    reason = "Connected named sources and a focused integration test establish one bounded deterministic work unit";
  }
  const context: {
    ecosystem?: ReturnType<typeof compactEcosystem>;
    files: PlanningFile[];
    repoMap: string[];
    verificationCommands: string[];
    snippets?: { path: string; snippet: string }[];
  } = { files: [], repoMap: [], verificationCommands: [] };
  context.ecosystem = compactEcosystem(profile.ecosystem, targetPaths);
  if (Buffer.byteLength(JSON.stringify(context)) > settings.contextBytes)
    delete context.ecosystem;
  const fits = () =>
    Buffer.byteLength(JSON.stringify(context)) <= settings.contextBytes;
  for (const command of profile.verificationCommands) {
    context.verificationCommands.push(command);
    if (!fits()) context.verificationCommands.pop();
  }
  for (const file of info) {
    context.files.push(file);
    if (!fits()) context.files.pop();
  }
  const repoDirectories = [...repositoryDirectories(profile.files)]
    .filter((directory) => directory.split("/").length <= 3)
    .sort((a, b) => {
      const aRelevant = targetPaths.some((path) => path.startsWith(a + "/"))
        ? 0
        : 1;
      const bRelevant = targetPaths.some((path) => path.startsWith(b + "/"))
        ? 0
        : 1;

      return (
        aRelevant - bRelevant ||
        a.split("/").length - b.split("/").length ||
        a.localeCompare(b)
      );
    });

  for (const path of [...targetPaths, ...repoDirectories, ...profile.files]
    .filter((p, i, a) => a.indexOf(p) === i)
    .slice(0, 80)) {
    context.repoMap.push(path);
    if (!fits()) context.repoMap.pop();
  }
  if (complexity === "complex")
    for (const f of info.slice(0, 2)) {
      context.snippets ??= [];
      context.snippets.push({
        path: f.path,
        snippet: texts.get(f.path)!.text.slice(0, 700),
      });
      if (!fits()) context.snippets.pop();
    }
  if (!context.snippets?.length) delete context.snippets;
  return {
    complexity,
    strategy: candidate ? ("deterministic" as const) : ("model" as const),
    reason,
    candidate,
    context,
  };
}

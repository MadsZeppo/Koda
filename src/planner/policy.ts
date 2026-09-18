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
  const extraWork = /\b(?:also|add|change|update|implement|create|remove|delete|refactor)\b/i.test(remaining);
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
  if (
    independent &&
    /\b(?:fix|repair)\b/i.test(task) &&
    complexity !== "complex" &&
    !coupled &&
    !ambiguous &&
    !extraWork && targetPaths.every((file) => mentioned(task, file)) &&
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
    const leaves = info.every(
      (f) =>
        f.complete &&
        !f.imports.length &&
        !/\b(?:require|import|eval|process|globalThis|global|fetch|Deno|Bun|window|document)\b/.test(
          texts.get(f.path)!.text,
        ),
    );
    if (
      leaves &&
      checks.every((c) => c.length === 1) &&
      new Set(checks.flat()).size === info.length
    ) {
      candidate = {
        taskSummary: task,
        acceptanceCriteria: [
          "All assigned checks and final repository verification pass",
        ],
        subtasks: info.map((f, i) => ({
          id: `fix-${i + 1}`,
          title: `Fix ${f.path}`,
          objective: `Repair the failing behavior in ${f.path} so ${checks[i]![0]} passes. Only this independent component is assigned.`,
          dependsOn: [],
          likelyReadPaths: [f.path, checks[i]![0]!],
          likelyWritePaths: [f.path],
          integrationContract: `Preserve the public interface of ${f.path}; do not modify tests or sibling components.`,
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
          "Explicit independent repairs map uniquely to disjoint leaf files and distinct native tests";
      complexity = "trivial";
    } else
      reason =
        "Missing distinct targeted tests, incomplete source, or non-leaf dependencies";
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
  for (const path of [...targetPaths, ...profile.files]
    .filter((p, i, a) => a.indexOf(p) === i)
    .slice(0, 60)) {
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

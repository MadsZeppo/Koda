import { extname } from "node:path";
import { createHash } from "node:crypto";
import type { RepoProfile } from "../types.js";
import type { ExecutionStrategy } from "./executionStrategy.js";

export type ProfileConfidence = "high" | "medium" | "low";

export interface SemanticTaskAssessment {
  semanticDifficulty: "easy" | "normal" | "hard" | "frontier";
  repoReasoning: "low" | "medium" | "high";
  localizationDifficulty: "low" | "medium" | "high";
  verificationStrength: "strong" | "medium" | "weak";
  consequenceRisk: "low" | "medium" | "high";
  expectedChangeSize: "single-file" | "few-files" | "multi-component";
  startingTier: "cheap" | "strong" | "frontier";
  frontierJustified: boolean;
  confidence: number;
  reason: string;
}

export interface DeterministicTaskProfile {
  profileVersion: 1;
  /** Stable routing region derived from repository facts, not prompt prose. */
  profileKey: string;
  taskFamily: string;
  languages: string[];
  frameworks: string[];
  repoScale: "small" | "medium" | "large";
  /** Read/search hints only; these do not imply mutation ownership. */
  discoveryCandidates: string[];
  likelyPaths: string[];
  likelyTests: string[];
  likelyComponents: string[];
  crossComponent: boolean;
  publicApiRisk: boolean;
  schemaRisk: boolean;
  concurrencyRisk: boolean;
  architectureRisk: boolean;
  securitySensitive: boolean;
  localizationEntropy: "low" | "medium" | "high";
  expectedBlastRadius: "single-file" | "package" | "cross-component";
  projectRoots: string[];
  verificationStrength: "strong" | "medium" | "weak";
  scopeConfidence: ProfileConfidence;
  decompositionConfidence: ProfileConfidence;
  evidence: string[];
  /** Optional LLM semantic judgment. Repository facts above remain authoritative. */
  semanticAssessment?: SemanticTaskAssessment;
}

export interface RoutingScoutResult {
  paths: string[];
  symbols: string[];
  evidence: string[];
  reproduction?: string;
}

export interface TaskResume {
  profile: DeterministicTaskProfile;
  scout?: RoutingScoutResult;
  relevantPaths: string[];
  evidence: string[];
  microScoutUsed: boolean;
  researchCalls: number;
  researchCostUsd: number;
  researchTokens: number;
}

const words = (text: string) => [...new Set(text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? [])]
  .filter((word) => !/^(?:add|fix|make|with|from|that|this|test|tests|code|change|file|using)$/.test(word));
const testPath = (path: string) => /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.py$/.test(path);

/** Bounded, repository-backed profiling. It performs no I/O and no model call. */
export function profileTask(task: string, repo: RepoProfile, strategy: ExecutionStrategy): DeterministicTaskProfile {
  const lower = task.toLowerCase();
  const explicit = repo.files.filter((path) =>
    task.includes(path) || task.includes(path.split("/").at(-1) ?? path));
  const terms = words(task);
  const ranked = repo.files.slice(0, 1500).map((path) => ({ path, score: terms.reduce((score, term) =>
    score + (path.toLowerCase().includes(term) ? 2 : 0), 0) + (testPath(path) && /\btest\b/.test(lower) ? 2 : 0) }))
    .filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, 12).map((item) => item.path);
  // Only an exact strategy target is mutation evidence. `likelyFiles` may be
  // populated by lexical discovery and must remain read/search context.
  const explicitTestStems = explicit.filter(testPath).map((path) =>
    path.split("/").at(-1)!
      .replace(/\.[^.]+$/, "")
      .replace(/\.(?:test|spec)$/, "")
      .toLowerCase());
  const companionSources = strategy.likelyFiles.filter((path) =>
    repo.files.includes(path) &&
    !testPath(path) &&
    explicitTestStems.includes(
      path.split("/").at(-1)!.replace(/\.[^.]+$/, "").toLowerCase(),
    ));
  const grounded = [
    ...(strategy.preciseTarget && repo.files.includes(strategy.preciseTarget)
      ? [strategy.preciseTarget]
      : []),
    ...companionSources,
  ];
  const likelyPaths = [...new Set([
    ...explicit,
    ...grounded,
  ])].slice(0, 12);
  const discoveryCandidates = likelyPaths.length ? [] : ranked;
  const likelyTests = likelyPaths.filter(testPath);
  const source = likelyPaths.filter((path) => !testPath(path));
  const components = [...new Set(source.map((path) => path.includes("/") ? path.split("/").slice(0, -1).join("/") : "."))];
  const crossComponent = components.length > 1 || /\b(?:across|cross[- ]component|frontend.+backend|backend.+frontend)\b/.test(lower);
  const hasConcreteEvidence = explicit.length > 0 || grounded.length > 0;
  const scopeConfidence: ProfileConfidence = hasConcreteEvidence && likelyPaths.length <= 6 ? "high"
    : likelyPaths.length ? "medium" : "low";
  const taskFamily = /\b(?:test|spec|coverage)\b/.test(lower) ? "test_change"
    : /\b(?:fix|bug|repair|debug)\b/.test(lower) ? "debugging"
    : /\brefactor\b/.test(lower) ? "refactor"
    : /\b(?:migration|schema)\b/.test(lower) ? "migration"
    : crossComponent ? "multi_component" : "implementation";
  const extensions = likelyPaths.map(extname);
  const languages = [...new Set([
    ...Object.entries(repo.extensions).filter(([extension]) => extensions.includes(extension)).flatMap(([extension]) =>
      ({ ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript", ".py": "python", ".go": "go", ".rs": "rust" } as Record<string, string>)[extension] ?? []),
    ...(repo.ecosystem?.languages ?? []),
  ])];
  const verificationStrength = likelyTests.length && repo.verificationCommands.length ? "strong"
    : repo.verificationCommands.length ? "medium" : "weak";
  const repositoryBoundaryEvidence = [
    ...likelyPaths,
    ...(repo.ecosystem?.configFiles ?? []),
    ...(repo.ecosystem?.evidence ?? []).flatMap((item) => [item.source, item.fact]),
  ].join(" ").toLowerCase();
  const publicApiRisk =
    /\b(?:public api|exported|endpoint|contract|breaking)\b/.test(lower) &&
    /(?:openapi|swagger|routes?|controllers?|public|api(?:\/|\.|$))/.test(
      repositoryBoundaryEvidence,
    );
  const schemaRisk =
    /\b(?:schema|migration|database|protocol|config(?:uration)?)\b/.test(lower) &&
    /(?:schema|migrations?|prisma|drizzle|typeorm|sequelize|alembic|django|sql(?:ite)?|postgres|database\.yml)/.test(
      repositoryBoundaryEvidence,
    );
  const concurrencyRisk =
    /\b(?:concurren|race condition|synchron|deadlock|atomic|thread[- ]safe|lock[- ]free)\w*\b/.test(
      lower,
    );
  const architectureRisk = /\b(?:architect|redesign|restructure|large refactor)\w*\b/.test(lower);
  // Vocabulary identifies intent, not consequence.  Require a concrete
  // repository security boundary before raising the risk class: a tiny
  // in-memory service named "auth" or "payment" is still locally verifiable.
  const securitySensitive =
    /\b(?:auth|permission|credential|secret|security|crypto|payment)\w*\b/.test(lower) &&
    /(?:oauth|openid|jwt|crypt|credentials?|secrets?|permissions?|polic(?:y|ies)|acl|security(?:\/|\.|$)|middleware)/.test(
      repositoryBoundaryEvidence,
    );
  const localizationEntropy = scopeConfidence === "high" ? "low"
    : scopeConfidence === "medium" ? "medium" : "high";
  const expectedBlastRadius = crossComponent ? "cross-component"
    : likelyPaths.length <= 1 ? "single-file" : "package";
  const projectRoots = [...new Set((repo.ecosystem?.projectUnits ?? [])
    .filter((unit) => likelyPaths.some((path) => unit.root === "." || path === unit.root || path.startsWith(`${unit.root}/`)))
    .map((unit) => unit.root))].sort();
  const profileKey = createHash("sha256").update(JSON.stringify({
    languages: [...languages].sort(), frameworks: [...(repo.ecosystem?.frameworks ?? [])].sort(),
    repoScale: repo.files.length < 40 ? "small" : repo.files.length < 500 ? "medium" : "large",
    likelyPaths: [...likelyPaths].sort(), components: [...components].sort(),
    projectRoots, crossComponent, publicApiRisk, schemaRisk, concurrencyRisk,
    architectureRisk, securitySensitive, verificationStrength, scopeConfidence,
    expectedBlastRadius,
  })).digest("hex").slice(0, 20);
  return {
    profileVersion: 1, profileKey,
    taskFamily, languages, frameworks: repo.ecosystem?.frameworks ?? [],
    repoScale: repo.files.length < 40 ? "small" : repo.files.length < 500 ? "medium" : "large",
    discoveryCandidates, likelyPaths, likelyTests, likelyComponents: components, crossComponent,
    publicApiRisk, schemaRisk, concurrencyRisk, architectureRisk,
    securitySensitive, localizationEntropy, expectedBlastRadius, projectRoots,
    verificationStrength, scopeConfidence,
    decompositionConfidence: crossComponent && components.length < 2 ? "low" : scopeConfidence,
    evidence: [
      ...explicit.map((path) => `explicit repository path: ${path}`),
      ...grounded.map((path) => `grounded repository path: ${path}`),
      ...likelyTests.map((path) => `repository test: ${path}`),
    ],
  };
}

export const researchBudgetUsd = (globalBudgetUsd: number, absoluteCapUsd: number, fraction: number) =>
  Math.max(0, Math.min(absoluteCapUsd, globalBudgetUsd * fraction));

export async function buildTaskResume(
  task: string,
  repo: RepoProfile,
  strategy: ExecutionStrategy,
  policy: { globalBudgetUsd: number; absoluteCapUsd: number; fraction: number },
  scout?: (profile: DeterministicTaskProfile, capUsd: number) => Promise<{ result: RoutingScoutResult; costUsd: number; tokens: number } | undefined>,
  preparedProfile?: DeterministicTaskProfile,
): Promise<TaskResume> {
  const profile = preparedProfile ?? profileTask(task, repo, strategy);
  const cap = researchBudgetUsd(policy.globalBudgetUsd, policy.absoluteCapUsd, policy.fraction);
  let inspected: Awaited<ReturnType<NonNullable<typeof scout>>>;
  let attempted = false;
  if ((profile.scopeConfidence === "low" || profile.decompositionConfidence === "low") && scout && cap > 0) {
    attempted = true;
    inspected = await scout(profile, cap).catch(() => undefined);
  }
  const validScout = inspected && inspected.costUsd <= cap ? {
    ...inspected,
    result: { ...inspected.result,
      paths: [...new Set(inspected.result.paths.filter((path) => repo.files.includes(path)))].slice(0, 12),
    },
  } : undefined;
  const used = !!validScout?.result.paths.length;
  return {
    profile, scout: used ? validScout!.result : undefined,
    relevantPaths: [...new Set([
      ...profile.likelyPaths,
      ...profile.discoveryCandidates,
      ...(used ? validScout!.result.paths : []),
    ])].slice(0, 16),
    evidence: [...profile.evidence, ...(used ? validScout!.result.evidence : [])].slice(0, 32),
    microScoutUsed: used, researchCalls: attempted ? 1 : 0,
    researchCostUsd: inspected?.costUsd ?? 0, researchTokens: inspected?.tokens ?? 0,
  };
}

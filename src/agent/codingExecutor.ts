import { verificationEvidence } from "./failureAttributionRuntime.js";
import { codingCapacity } from "../context/packetPolicy.js";
import type { Gateway } from "../openrouter/client.js";
import { isTransientProviderError } from "../openrouter/client.js";
import type { Candidate } from "../router/modelRouter.js";
import type { Role } from "../router/modelRegistry.js";
import type { CodingTier } from "../router/codingDemand.js";
import {
  codingDemand,
  nextCodingTier,
  PARETO_CODE_MODEL,
} from "../router/codingDemand.js";
import type { Subtask, Plan, EvidencePacket } from "../planner/schemas.js";
import type {
  CommandResult,
  RepoProfile,
  VerificationResult,
} from "../types.js";
import type { WorkerContext } from "../context/compiler.js";
import {
  compileContext,
  compileTargetContext,
  isSourcePath,
  isTestPath,
  resolveImports,
  taskTerms,
  workerReadPaths,
} from "../context/compiler.js";
import { requestsTestMutation } from "../router/executionStrategy.js";
import { extractFeatures } from "../router/features.js";
import {
  broadVisualDesignTask,
  preserveCanonicalTaskEvidence,
  taskFingerprint,
} from "../router/taskFingerprint.js";
import type { DeterministicTaskProfile } from "../router/taskProfiler.js";
import type { FrozenExecutionPlan } from "../router/modelRouter.js";
import { requiredQualityClass } from "../router/controlPolicy.js";
import { verificationPlan } from "../verifier/plan.js";
import {
  focusedVerificationCheck,
  impactAwareVerificationSelection,
  verificationImpactRelationships,
  objectiveCanBeAlreadySatisfied,
  workerChecks,
  workerChecksAreTaskSpecific,
  tinyDocumentationChecks,
} from "../verifier/selection.js";
import {
  optionalUnavailableCheck,
  focusedLocalReproduction,
  recoverPostMutationChecks,
} from "../verifier/recovery.js";
import {
  advisoryInfrastructureOnly,
  verify,
  verificationAgainstBaseline,
  verificationRegressed,
  verificationResult,
} from "../verifier/verifier.js";
import type { StableImplementationHandoff } from "./stable.js";
import type { RepairPacket } from "./repairPacket.js";
import type { CodingWorker } from "./codingWorker.js";
import type { CodingWorkerContext } from "./codingWorker.js";
import { AiderExecutor, preferredAiderFormat } from "./aiderExecutor.js";
import { WriteScope } from "../repo/writeScope.js";
import { AttemptCheckpoint } from "./attemptCheckpoint.js";
import { currentDiff, safePath } from "./tools.js";
import { router } from "../router/router.js";
import { taskBucket } from "../router/features.js";
import { tierRank } from "../router/pool.js";
import { testRequirementAlreadyCovered } from "./mutationInvariant.js";
import { stableNoChangePreflight } from "./stableNoChangePreflight.js";
import { readFile, lstat } from "node:fs/promises";
import { join, posix } from "node:path";
import { attemptLimitPolicy, usesDirectEditEngine } from "./attemptPolicy.js";
import { DirectEditWorker } from "./directEditWorker.js";
import { AgenticCodingWorker, agenticPromptBytes } from "./agenticCodingWorker.js";
import {
  discoverExistingNavigationOwner,
  requestsNavigationMutation,
} from "./openHandsExplorer.js";
import { planCodingHandoff } from "./handoffPlanner.js";
import { execa } from "execa";
import {
  completionReviewMessages,
  completionReviewBatches,
  completionReviewModel,
  completionReviewOutputTokens,
  completionReviewTool,
  completionReviewResponseFormat,
  completionReviewPayload,
  completionReviewContradictsVerification,
  deterministicLiteralCompletionReview,
  requiredTestMutationGap,
  missingRequirementDiagnostics,
  parseCompletionReview,
  taskRequirementChecklist,
  visualCascadeConflict,
  type CompletionReview,
  type CompletionReviewInput,
} from "./completionReview.js";

export interface CodingImplementationOptions {
  initialRole?: Role;
  evidence?: EvidencePacket;
  compiledContext?: WorkerContext;
  extra?: unknown;
  stop?: () => boolean;
  raceGroup?: string;
  selectedCandidate?: Candidate;
  model?: string;
  finalVerificationOnly?: boolean;
  /** A generated partial contribution is checked only after DAG integration. */
  deferVerificationToIntegration?: boolean;
  stableHandoff?: StableImplementationHandoff;
  repairPacket?: RepairPacket;
  stableRepair?: {
    attempt: number;
    failedChecks: CommandResult[];
    changedFiles: string[];
    failedDiff?: string;
    implicatedSymbols?: string[];
    baselineChecks?: CommandResult[];
    regressionDiagnostics?: string[];
    failureContext?: { path: string; symbol?: string; content: string }[];
  };
  tinyDirect?: boolean;
  adaptiveStartTier?: CodingTier;
  canonicalTaskProfile?: DeterministicTaskProfile;
  /** Run-level evidence for routing only; never substitutes for this worker's baseline. */
  canonicalRoutingVerification?: VerificationResult;
  canonicalVerification?: VerificationResult;
  executionPlan?: FrozenExecutionPlan;
  /** Tests inject a deterministic worker; production never supplies this. */
  codingWorker?: CodingWorker;
  /** Tests and embedders may provide an isolated semantic completion reviewer. */
  completionReviewer?: (
    input: CompletionReviewInput,
  ) => Promise<CompletionReview>;
}

const infrastructureOnly = (result: VerificationResult) =>
  result.checks.some(
    (check) =>
      check.outcome === "INFRA_FAILURE" ||
      check.outcome === "CHECK_UNAVAILABLE",
  ) && !result.checks.some((check) => check.outcome === "CHECK_FAIL");

const protocolIncompatibility = (message?: string) =>
  /(?:no endpoints?(?:\s+found)?|unsupported|not support|tool_choice|invalid_tool_(?:arguments|envelope)|requested parameters?|protocol|RepeatedFormatError|format(?:[_ ]error|[_ ]failure)|404)/i.test(
    message ?? "",
  );

const operationalFailureKind = (
  message?: string,
): "tool_protocol_incompatible" | "timeout" | "provider" =>
  protocolIncompatibility(message)
    ? "tool_protocol_incompatible"
    : /\b(?:timeout|timed out|aborted|AbortError)\b/i.test(message ?? "")
      ? "timeout"
      : "provider";

const roleFor = (candidate?: Candidate): Role =>
  candidate?.model.tier === "frontier"
    ? "FRONTIER_MODEL"
    : candidate?.model.tier === "strong"
      ? "STRONG_MODEL"
      : "CHEAP_CODER_A";

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Build one bounded source-grounded packet without duplicating file contents. */
export function codingContextPacket(input: {
  context: WorkerContext;
  evidence: EvidencePacket;
  writeScope: readonly string[];
  diagnostics?: string;
  previousFailedDiff?: string;
  localizationSummary?: string;
  repairPacket?: RepairPacket;
  completionRepair?: CodingWorkerContext["completionRepair"];
  repair: boolean;
}): CodingWorkerContext {
  const paths = new Set([
    ...input.writeScope,
    ...input.context.localDependencies,
  ]);
  const mentioned = (file: { path: string }) =>
    paths.has(file.path) ||
    !!input.diagnostics?.includes(file.path) ||
    input.writeScope.some(
      (scope) =>
        scope !== "." &&
        (file.path === scope ||
          file.path.startsWith(scope.replace(/\/$/, "") + "/")),
    );
  const repairFiles = input.context.files.filter(mentioned);
  const sourceFiles = input.repair
    ? repairFiles.length
      ? repairFiles
      : input.context.files.slice(0, 4)
    : input.context.files;
  const compactEvidence = {
    relevantFiles: input.evidence.relevantFiles,
    symbols: input.evidence.symbols,
    reproduction: input.evidence.reproduction,
    failingTests: input.evidence.failingTests,
    likelyRootCause: input.evidence.likelyRootCause,
    dependencies: input.evidence.dependencies,
    uncertainty: input.evidence.uncertainty,
    suggestedApproach: input.evidence.suggestedApproach,
    evidence: input.evidence.evidence,
  };
  const completionRepairPaths = input.completionRepair
    ? new Set(input.writeScope.filter((path) => path !== "."))
    : undefined;

  const boundedSourceFiles = completionRepairPaths
    ? sourceFiles.filter(
        (file) =>
          completionRepairPaths.has(file.path) ||
          input.context.localDependencies.includes(file.path),
      )
    : sourceFiles;

  const relevantFiles = completionRepairPaths
    ? [...completionRepairPaths]
    : [
        ...new Set([
          ...boundedSourceFiles.map((file) => file.path),
          ...input.evidence.relevantFiles,
        ]),
      ];

  return {
    localizationSummary:
      input.localizationSummary ?? input.evidence.likelyRootCause,
    relevantFiles,
    sourceFiles: boundedSourceFiles,
    completePaths: input.completionRepair
      ? relevantFiles
      : input.context.completePaths,
    diagnostics: input.diagnostics,
    previousFailedDiff: input.previousFailedDiff,
    evidence: input.repair ? undefined : compactEvidence,
    repairPacket: input.repair ? undefined : input.repairPacket,
    completionRepair: input.completionRepair,
  };
}

export function completionRepairWriteScope(input: {
  currentWriteScope: readonly string[];
  authorizedReadPaths: readonly string[];
  repositoryPaths: readonly string[];
  reviewerDiagnostics: string;
  testsAuthorized: boolean;
}) {
  const repository = new Set(input.repositoryPaths);
  const additions = input.authorizedReadPaths.filter(
    (path) =>
      repository.has(path) &&
      input.reviewerDiagnostics.includes(path) &&
      (input.testsAuthorized || !isTestPath(path)),
  );
  return [...new Set([...input.currentWriteScope, ...additions])];
}

const explicitWriteRestriction = (task: string) =>
  /\b(?:only|exclusively)\s+(?:modify|edit|change|write|touch)\b|\b(?:modify|edit|change|write|touch)\s+only\b|\b(?:do not|don.t|never)\s+(?:modify|edit|change|write|touch)\s+(?:(?:the|any|existing|current|new)\s+)?(?:tests?|specs?)\b|\bkun\s+(?:ændr|rediger|skriv|rør)\b|\b(?:ændr|rediger|skriv|rør)\s+kun\b|\b(?:ændr|rediger|skriv|rør)\s+ikke\s+(?:de\s+|eksisterende\s+)?tests?\b/i.test(
    task,
  );

const diagnosticSourcePaths = (diagnostics: string) => [
  ...new Set(
    [
      ...diagnostics.matchAll(
        /(?:^|[\s`'"(])([A-Za-z0-9_.@()+-]+(?:\/[A-Za-z0-9_.@()+-]+)+\.(?:[cm]?[jt]sx?|py|go|rs|java|[ch](?:pp)?|rb))(?=$|[.\s`'"),:;])/g,
      ),
    ]
      .map((match) => match[1]!)
      .filter((path) => !path.split("/").some((part) => /^\.+$/.test(part)))
      .map((path) => posix.normalize(path))
      .filter(
        (path) =>
          !path.startsWith("/") &&
          !path
            .split("/")
            .some(
              (part) =>
                /^\.+$/.test(part) || part === ".git" || part === ".koda",
            ) &&
          isSourcePath(path) &&
          !isTestPath(path),
      ),
  ),
];

/**
 * A rejected completion review may prove that one new source file is required
 * (for example a framework route entry). Authorize it only when the original
 * task asks for creation/routing work, the reviewer names one exact safe path,
 * and the repository already proves either its parent directory or its
 * framework basename convention. Ambiguous paths remain read-only evidence.
 */
function reviewerProvenNewSourcePath(input: {
  task: string;
  currentWriteScope: readonly string[];
  repositoryPaths: readonly string[];
  reviewerDiagnostics: string;
}) {
  if (
    !/(?:\b(?:add|create|introduce|new|route|page|screen|view)\b|\bny\b|opret|tilføj|rute|side|visning)/i.test(
      input.task,
    ) ||
    !/(?:\b(?:missing|required|needs?|create|new|route|page)\b|mangler|kræver|ikke\s+oprettet|ny\s+(?:rute|side|fil))/i.test(
      input.reviewerDiagnostics,
    )
  )
    return undefined;
  const mentioned = diagnosticSourcePaths(input.reviewerDiagnostics).filter(
    (path) => !input.repositoryPaths.includes(path),
  );
  if (mentioned.length !== 1) return undefined;
  const candidate = mentioned[0]!;
  const directories = new Set(
    input.repositoryPaths.flatMap((path) => {
      const parts = path.split("/");
      return parts
        .slice(0, -1)
        .map((_, index) => parts.slice(0, index + 1).join("/"));
    }),
  );
  const parent = posix.dirname(candidate);
  if (directories.has(parent)) return candidate;
  const basename = posix.basename(candidate);
  const ancestor = [...directories]
    .filter((directory) => parent.startsWith(directory + "/"))
    .sort((left, right) => right.length - left.length)[0];
  if (!ancestor) return undefined;
  const missingDepth = parent
    .slice(ancestor.length + 1)
    .split("/")
    .filter(Boolean).length;
  const conventionProven =
    missingDepth === 1 &&
    input.repositoryPaths.some(
      (path) =>
        posix.basename(path) === basename &&
        (posix.dirname(path) === ancestor ||
          posix.dirname(path).startsWith(ancestor + "/")),
    );
  return conventionProven ? candidate : undefined;
}

export async function evidenceBasedCompletionRepairScope(input: {
  root: string;
  task: string;
  currentWriteScope: readonly string[];
  authorizedReadPaths: readonly string[];
  repositoryPaths: readonly string[];
  reviewerDiagnostics: string;
}) {
  // Explicit edit restrictions remain authoritative during completion repair.
  if (explicitWriteRestriction(input.task)) return [...input.currentWriteScope];
  const testsAuthorized = requestsTestMutation(input.task);
  let expanded = completionRepairWriteScope({ ...input, testsAuthorized });
  const newSource = reviewerProvenNewSourcePath(input);
  if (newSource) expanded = [...new Set([...expanded, newSource])];
  if (
    requestsNavigationMutation(input.task) &&
    /\b(?:missing|absent|not\s+(?:in|added|updated|linked)|needs?|mangler|ikke\s+(?:i|tilføjet|opdateret))\b/i.test(
      input.reviewerDiagnostics,
    ) &&
    /\b(?:navigation|nav|menu|header|link)\b|navigations|menuen|headeren/i.test(
      input.reviewerDiagnostics,
    )
  ) {
    const owner = await discoverExistingNavigationOwner(input.root, {
      files: input.repositoryPaths,
    } as RepoProfile);
    if (owner) expanded = [...new Set([...expanded, owner])];
  }
  // A reviewer can prove that a site-wide visual requirement has no styling
  // behind it without knowing the stylesheet's path. Promote only a unique
  // repository-backed global stylesheet already authorized as read context.
  if (
    broadVisualDesignTask(input.task) &&
    /(?:\b(?:no|missing|absent|lacks?|not|without)\b|mangler|ingen|ikke)[^.!?\n]{0,100}\b(?:css|stylesheet|styles?|styling|theme|colors?|colours?|tema|farver?|stil)\b/i.test(
      input.reviewerDiagnostics,
    )
  ) {
    const globalStyles = input.authorizedReadPaths.filter(
      (path) =>
        input.repositoryPaths.includes(path) &&
        /(?:^|\/)(?:global|globals|theme|styles?)\.(?:css|scss|sass)$/i.test(
          path,
        ),
    );
    if (globalStyles.length === 1)
      expanded = [...new Set([...expanded, globalStyles[0]!])];
  }
  if (
    !testsAuthorized ||
    expanded.some(isTestPath) ||
    !/\b(?:test|tests|spec|specs|coverage)\b/i.test(input.reviewerDiagnostics)
  )
    return expanded;
  const known = new Set(input.repositoryPaths);
  const sources = new Set(
    [...expanded, ...input.authorizedReadPaths].filter(
      (path) => known.has(path) && isSourcePath(path) && !isTestPath(path),
    ),
  );
  const terms = [
    ...new Set([
      ...taskTerms(input.task),
      ...taskTerms(input.reviewerDiagnostics),
    ]),
  ];
  const candidates: { path: string; score: number }[] = [];
  for (const path of input.repositoryPaths.filter(isTestPath).slice(0, 160)) {
    let text = "";
    try {
      text = (await readFile(join(input.root, path), "utf8")).slice(0, 32_000);
    } catch {
      continue;
    }
    const name = posix.basename(path).toLowerCase();
    const imports = resolveImports(path, text, known);
    const score =
      (input.authorizedReadPaths.includes(path) ? 5 : 0) +
      [...sources].reduce((total, source) => {
        const stem = posix
          .basename(source)
          .replace(/\.[^.]+$/, "")
          .toLowerCase();
        return (
          total +
          (imports.includes(source) ? 6 : 0) +
          (name.split(/[._-]/).includes(stem) ? 3 : 0)
        );
      }, 0) +
      terms.filter(
        (term) =>
          term.length >= 4 &&
          (name.includes(term) || text.toLowerCase().includes(term)),
      ).length;
    if (score > 0) candidates.push({ path, score });
  }
  candidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  if (
    candidates[0] &&
    candidates[0].score >= 3 &&
    (!candidates[1] || candidates[0].score > candidates[1].score)
  )
    return [...new Set([...expanded, candidates[0].path])];

  // Creation is allowed only when one source target and a dominant existing
  // repository test convention establish an unambiguous path.
  const source = [...sources].filter((path) => expanded.includes(path));
  const existingTests = input.repositoryPaths.filter(isTestPath);
  if (source.length !== 1 || existingTests.length < 2) return expanded;
  const conventions = new Map<string, number>();
  for (const test of existingTests) {
    const directory = posix.dirname(test);
    const match = posix
      .basename(test)
      .match(/(\.(?:test|spec)\.[cm]?[jt]sx?|_test\.py)$/i);
    if (!match) continue;
    const key = `${directory}\0${match[1]}`;
    conventions.set(key, (conventions.get(key) ?? 0) + 1);
  }
  const ordered = [...conventions].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  if (
    !ordered[0] ||
    ordered[0][1] < 2 ||
    (ordered[1]?.[1] ?? 0) === ordered[0][1]
  )
    return expanded;
  const [directory, suffix] = ordered[0][0].split("\0");
  const stem = posix.basename(source[0]!).replace(/\.[^.]+$/, "");
  return [
    ...new Set([...expanded, posix.join(directory!, `${stem}${suffix}`)]),
  ];
}

/** Bounded local retrieval for unresolved root scope; never expands write authority. */
export async function rootCodingContext(
  root: string,
  task: string,
  profile: RepoProfile,
  limits: Gateway["config"]["context"],
): Promise<WorkerContext> {
  const terms = taskTerms(task);
  const corpus: { path: string; text: string }[] = [];
  let remainingBytes = 4_000_000;
  for (const path of (profile.files ?? [])
    .filter(
      (path) =>
        (isSourcePath(path) || isTestPath(path)) &&
        /\.[cm]?[jt]sx?$/.test(path) &&
        !/(?:^|\/)\./.test(path) &&
        !/(?:^|\/)(?:fixtures|node_modules|dist|build)(?:\/|$)/.test(path),
    )
    .slice(0, limits.scanFiles)) {
    if (remainingBytes <= 0) break;
    try {
      const target = await safePath(root, path);
      const info = await lstat(target);
      if (
        !info.isFile() ||
        info.nlink > 1 ||
        info.size > Math.min(1_000_000, remainingBytes)
      )
        continue;
      const text = await readFile(target, "utf8");
      remainingBytes -= Buffer.byteLength(text);
      if (!text.includes("\0")) corpus.push({ path, text });
    } catch {}
  }
  const weights = new Map(
    terms.map((term) => [
      term,
      1 +
        Math.log(
          (corpus.length + 1) /
            (1 +
              corpus.filter((file) => file.text.toLowerCase().includes(term))
                .length),
        ),
    ]),
  );
  const ranked = corpus
    .map((file) => {
      // Task descriptions embedded in test fixtures are not implementation evidence.
      const code = file.text
        .replace(/\/\*[^]*?\*\//g, " ")
        .replace(
          /(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/g,
          " ",
        )
        .replace(/\/\/[^\n]*/g, " ");
      const lines = code.toLowerCase().split("\n");
      const normalizedPath = file.path
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ");
      const pathScore = terms.reduce((sum, term) => {
        const pieces = term.split(/[-_]+/).filter((piece) => piece.length >= 3);
        return (
          sum +
          pieces.reduce(
            (pieceSum, piece) =>
              pieceSum +
              (normalizedPath.includes(piece)
                ? (weights.get(term) ?? 1) * 3
                : 0),
            0,
          )
        );
      }, 0);
      let score = pathScore;
      for (let line = 0; line < lines.length; line++) {
        const window = lines.slice(line, line + 32).join("\n");
        score = Math.max(
          score,
          pathScore +
            terms.reduce(
              (sum, term) =>
                sum + (window.includes(term) ? weights.get(term)! : 0),
              0,
            ),
        );
      }
      return { path: file.path, score };
    })
    .filter((file) => file.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const paths = [
    ...new Set([
      ...ranked
        .filter((file) => isSourcePath(file.path))
        .slice(0, 3)
        .map((file) => file.path),
      ...ranked
        .filter((file) => isTestPath(file.path))
        .slice(0, 3)
        .map((file) => file.path),
    ]),
  ].slice(0, limits.maxFiles);
  const context: WorkerContext = {
    files: [],
    repoMap: paths,
    localDependencies: [],
  };
  for (const path of paths) {
    const perFileBytes = Math.min(
      limits.fileBytes,
      Math.floor(
        (Math.min(limits.maxBytes, 8000) - 512) / Math.max(1, paths.length),
      ),
    );
    const target = await compileTargetContext(root, path, task, {
      ...limits,
      fileBytes: perFileBytes,
      maxBytes: perFileBytes + 256,
    });
    context.files.push(...target.files);
    if (Buffer.byteLength(JSON.stringify(context)) > limits.maxBytes)
      context.files.pop();
  }
  return context;
}

function mergeCodingContexts(
  primary: WorkerContext,
  secondary: WorkerContext,
  maxBytes: number,
): WorkerContext {
  const merged: WorkerContext = {
    files: [],
    repoMap: [...new Set([...primary.repoMap, ...secondary.repoMap])],
    localDependencies: [
      ...new Set([
        ...primary.localDependencies,
        ...secondary.localDependencies,
      ]),
    ],
    completePaths: [
      ...new Set([
        ...(primary.completePaths ?? []),
        ...(secondary.completePaths ?? []),
      ]),
    ],
  };
  const seen = new Set<string>();
  for (const file of [...primary.files, ...secondary.files]) {
    if (seen.has(file.path)) continue;
    const next = { ...merged, files: [...merged.files, file] };
    if (Buffer.byteLength(JSON.stringify(next)) > maxBytes) continue;
    merged.files.push(file);
    seen.add(file.path);
  }
  return merged;
}

/** Sole production coding executor. Koda routes/verifies; Aider mutates one isolated attempt. */
export async function implement(
  gateway: Gateway,
  path: string,
  task: string,
  subtask: Subtask,
  plan: Pick<Plan, "acceptanceCriteria"> & Partial<Pick<Plan, "subtasks">>,
  profile: RepoProfile,
  options: CodingImplementationOptions = {},
) {
  let writeScope = new WriteScope(
    subtask.likelyWritePaths,
    gateway.logger,
    subtask.id,
  );
  let context =
    options.compiledContext ??
    (await compileContext(
      path,
      subtask.objective,
      [...writeScope.paths, ...workerReadPaths(subtask, plan.subtasks)],
      profile,
      gateway.config.context,
      true,
    ));
  const hasCodeContext = context.files.some(
    (file) => isSourcePath(file.path) || isTestPath(file.path),
  );
  const hasMissingCodeTarget = (
    await Promise.all(
      [...writeScope.paths]
        .filter(
          (target) =>
            target !== "." && (isSourcePath(target) || isTestPath(target)),
        )
        .map(async (target) => {
          try {
            return !(await lstat(await safePath(path, target))).isFile();
          } catch {
            return true;
          }
        }),
    )
  ).some(Boolean);
  if (
    !hasCodeContext &&
    (writeScope.paths.includes(".") || hasMissingCodeTarget)
  ) {
    const discovered = await rootCodingContext(
      path,
      task,
      profile,
      gateway.config.context,
    );
    if (discovered.files.length) {
      context = mergeCodingContexts(
        discovered,
        context,
        gateway.config.context.maxBytes,
      );
    }
  }
  const evidence: EvidencePacket = options.evidence ?? {
    relevantFiles: context.files.map((file) => file.path).filter(isSourcePath),
    symbols: [],
    reproduction: "Koda verification is authoritative",
    failingTests: [],
    likelyRootCause: "Not established",
    dependencies: subtask.dependsOn,
    uncertainty: "medium",
    suggestedApproach: "Inspect, implement, and verify",
    evidence: [],
  };
  const requirements = taskRequirementChecklist({
    task: subtask.id.startsWith("bounded-") ? subtask.objective : task,
    objective: subtask.objective,
    integrationContract: subtask.integrationContract,
    acceptanceCriteria: subtask.id.startsWith("bounded-")
      ? [subtask.integrationContract]
      : plan.acceptanceCriteria,
  });
  gateway.logger.log("task_requirement_checklist", {
    subtaskId: subtask.id,
    requirements,
  });
  gateway.logger.log("worker_context", {
    subtaskId: subtask.id,
    context_files: context.files.map((file) => file.path),
    context_bytes: Buffer.byteLength(JSON.stringify(context)),
    context_bytes_initial: Buffer.byteLength(JSON.stringify(context)),
    context_bytes_repeated: 0,
    context_limit_bytes: gateway.config.context.maxBytes,
  });
  gateway.logger.log("worker_scope", {
    subtaskId: subtask.id,
    allowed_write_paths: writeScope.paths,
    context_files: context.files.map((file) => file.path),
  });

  const tinyDocs =
    options.tinyDirect &&
    subtask.likelyWritePaths.every((file) =>
      /\.(?:md|mdx|txt|rst)$/i.test(file),
    );
  const boundedDiscoveryFirstPass =
    (subtask.id === "stable" || subtask.id === "direct") &&
    !options.stableRepair &&
    writeScope.paths.length === 1 &&
    writeScope.paths[0] === ".";
  let commands = options.deferVerificationToIntegration
    ? []
    : (options.stableRepair?.failedChecks.map((check) => check.command) ??
      (boundedDiscoveryFirstPass
        ? []
        : tinyDocs
          ? subtask.likelyWritePaths.flatMap((file) =>
              tinyDocumentationChecks(profile, file),
            )
          : subtask.verificationCommands.length
            ? subtask.verificationCommands
            : options.finalVerificationOnly
              ? (() => {
                  const focused = focusedVerificationCheck(
                    subtask,
                    profile,
                    context,
                  );

                  return focused ? [focused] : [];
                })()
              : workerChecks(subtask, profile, context)));
  const profiledCandidates =
    profile.ecosystem?.projectUnits.flatMap((unit) => unit.verification) ?? [];
  if (!subtask.verificationCommands.length && !options.stableRepair)
    commands = commands.filter((command) => {
      const candidate = profiledCandidates.find(
        (item) => item.command === command,
      );
      return !candidate || !optionalUnavailableCheck(candidate);
    });
  if (tinyDocs && !commands.length && !options.stableRepair)
    commands = verificationPlan(profile, [...writeScope.paths], true)
      .filter((check) => check.available)
      .map((check) => check.command);
  const recovery =
    !options.deferVerificationToIntegration &&
    !boundedDiscoveryFirstPass &&
    !tinyDocs &&
    !commands.length &&
    !options.stableRepair
      ? await focusedLocalReproduction(profile, task, subtask.likelyWritePaths)
      : undefined;
  const recoveredCandidates = recovery ? [recovery] : [];
  let postMutationRecoveryAttempted = false;
  if (recovery) {
    commands = [recovery.command];
    gateway.logger.log("verification_recovery", {
      subtaskId: subtask.id,
      command: recovery.command,
      source: recovery.source,
    });
  }
  commands = [...new Set(commands)];
  const commandReferencesPath = (command: string, file: string) =>
    command.includes(file) || command.includes(`./${file}`);
  const baselineCommands = (
    selected: readonly string[],
    candidatePaths: readonly string[] = writeScope.paths,
  ) =>
    selected.filter(
      (command) =>
        !candidatePaths.some(
          (file) =>
            file !== "." &&
            !profile.files.includes(file) &&
            commandReferencesPath(command, file),
        ),
    );
  const candidates = profiledCandidates;
  const runChecks = async (
    selected: string[],
    afterMutation = false,
    recoveryPaths: string[] = subtask.likelyWritePaths,
  ) => {
    if (
      afterMutation &&
      !options.finalVerificationOnly &&
      !tinyDocs &&
      !selected.length &&
      !postMutationRecoveryAttempted
    ) {
      postMutationRecoveryAttempted = true;
      gateway.logger.log("verification_recovery_attempt", {
        subtaskId: subtask.id,
        paths: recoveryPaths,
      });
      const discovered = await recoverPostMutationChecks(
        path,
        task,
        recoveryPaths,
        { fingerprint },
      );
      selected = discovered.map((candidate) => candidate.command);
      commands = [...new Set(selected)];
      recoveredCandidates.push(...discovered);
      gateway.logger.log(
        discovered.length
          ? "verification_recovery"
          : "verification_recovery_exhausted",
        {
          subtaskId: subtask.id,
          commands: selected,
          source: discovered.map((candidate) => candidate.source),
        },
      );
    }
    if (
      options.finalVerificationOnly &&
      afterMutation &&
      tinyDocs &&
      !selected.length
    )
      return verificationResult([]);
    return verify(
      path,
      selected,
      () =>
        Math.min(gateway.config.commandTimeoutMs, gateway.budget.remainingMs()),
      (check) =>
        gateway.logger.log("verification", { subtaskId: subtask.id, ...check }),
      writeScope,
      [...candidates, ...recoveredCandidates].map((candidate) =>
        subtask.verificationCommands.includes(candidate.command)
          ? { ...candidate, requirement: "required" as const }
          : candidate,
      ),
    );
  };
  const infrastructureError = (result: VerificationResult) => {
    const failed = result.checks.find(
      (check) =>
        (check.requirement ?? "required") === "required" &&
        (check.outcome === "INFRA_FAILURE" ||
          (check.outcome === "CHECK_UNAVAILABLE" &&
            check.unavailable !== "unsafe_verification_command")),
    );
    return failed
      ? `${failed.command}: ${failed.unavailable ?? "verification could not execute"}`
      : undefined;
  };
  const canonicalBaseline =
    options.canonicalRoutingVerification ?? options.canonicalVerification;
  let baseline = options.stableRepair?.baselineChecks?.length
    ? verificationResult(options.stableRepair.baselineChecks)
    : canonicalBaseline?.checks.length
      ? canonicalBaseline
      : options.tinyDirect
        ? verificationResult([])
        : baselineCommands(commands).length
          ? await runChecks(baselineCommands(commands))
          : verificationResult([]);
  const initialInfrastructureError = infrastructureError(baseline);
  if (initialInfrastructureError) {
    gateway.logger.log("verification_infrastructure_failure", {
      subtaskId: subtask.id,
      error: initialInfrastructureError,
      checks: baseline.checks,
    });
    throw Error(
      `Verification infrastructure unavailable: ${initialInfrastructureError}`,
    );
  }
  if (infrastructureOnly(baseline))
    return { verification: baseline, role: "CHEAP_CODER_A" as Role, evidence };
  const docChecksAvailable =
    tinyDocs &&
    subtask.likelyWritePaths.some(
      (file) => tinyDocumentationChecks(profile, file).length,
    );
  if (
    tinyDocs &&
    commands.length &&
    !docChecksAvailable &&
    !options.stableRepair
  ) {
    const probe = await runChecks(commands);
    const probeInfra = infrastructureError(probe);
    if (probeInfra || infrastructureOnly(probe))
      return { verification: probe, role: "CHEAP_CODER_A" as Role, evidence };
  }

  const lockedTests = await Promise.all(
    writeScope.paths
      .filter((file) =>
        /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\./i.test(file),
      )
      .map(async (file) => ({
        path: file,
        content: await readFile(join(path, file), "utf8").catch(() => ""),
      })),
  );
  // A passing structural baseline proves repository health, not completion.
  // An explicit mutation needs concrete assertion evidence and its executed test.
  const noChangeProof = testRequirementAlreadyCovered(task, lockedTests)
    ? await stableNoChangePreflight(
        path,
        task,
        profile,
        () =>
          Math.min(
            gateway.config.commandTimeoutMs,
            gateway.budget.remainingMs(),
          ),
        (check) =>
          gateway.logger.log("verification", {
            subtaskId: subtask.id,
            ...check,
          }),
        baseline,
        lockedTests.map((file) => file.path),
      )
    : undefined;
  const taskAcceptanceCommands = workerChecks(subtask, profile, context);
  const existingAcceptanceProven =
    objectiveCanBeAlreadySatisfied(subtask) &&
    workerChecksAreTaskSpecific(subtask, profile, context) &&
    baseline.status === "VERIFIED_SUCCESS" &&
    taskAcceptanceCommands.every((command) =>
      baseline.checks.some(
        (check) => check.command === command && check.outcome === "CHECK_PASS",
      ),
    ) &&
    baseline.checks.some(
      (check) =>
        check.kind === "test" &&
        check.outcome === "CHECK_PASS" &&
        taskAcceptanceCommands.includes(check.command),
    );
  const noChangeVerification = noChangeProof?.satisfied
    ? noChangeProof.verification
    : existingAcceptanceProven
      ? baseline
      : undefined;
  if (noChangeVerification) {
    gateway.logger.log("no_changes_required", {
      subtaskId: subtask.id,
      status: "VERIFIED_SUCCESS",
      reason: "acceptance_checks_already_pass",
      diffBytes: 0,
      verificationCommands: noChangeVerification.checks.map(
        (check) => check.command,
      ),
      evidence_paths: noChangeProof?.satisfied
        ? noChangeProof.evidencePaths
        : context.files
            .filter(
              (file) =>
                isTestPath(file.path) &&
                taskAcceptanceCommands.some((command) =>
                  command.includes(file.path),
                ),
            )
            .map((file) => file.path),
    });
    return {
      verification: noChangeVerification,
      role: "CHEAP_CODER_A" as Role,
      evidence,
      noChangesRequired: true,
    };
  }

  const features = extractFeatures(
    subtask,
    profile,
    Buffer.byteLength(JSON.stringify({ task, context, evidence })),
    baseline,
    options.stableHandoff
      ? "stable"
      : (gateway.logger.events.findLast(
          (event) => event.type === "execution_strategy",
        )?.execution_strategy ??
          (subtask.id === "direct" ? "direct" : "planned")),
  );
  const effort =
    gateway.logger.events.findLast(
      (event) => event.type === "execution_strategy",
    )?.execution_effort ??
    (subtask.estimatedDifficulty === "high"
      ? "complex"
      : subtask.estimatedDifficulty === "low"
        ? "tiny"
        : "normal");
  const fingerprint = preserveCanonicalTaskEvidence(
    taskFingerprint(subtask, profile, features, effort, baseline),
    options.canonicalTaskProfile,
    options.canonicalRoutingVerification ?? options.canonicalVerification,
  );
  gateway.logger.log("task_fingerprint", {
    subtaskId: subtask.id,
    fingerprint,
  });

  const routingStarted = Date.now();
  const pool = gateway.modelRouter;
  const demand =
    gateway.config.adaptiveCoding &&
    pool &&
    !gateway.config.forceModel &&
    !gateway.config.specialistRouting &&
    !options.selectedCandidate &&
    !options.model
      ? codingDemand(
          features,
          subtask,
          effort,
          fingerprint,
          gateway.config.routing.minimumQuality,
        )
      : undefined;
  const specialistRequested =
    (gateway.config.specialistRouting || gateway.config.routing.authority !== "legacy") &&
    pool &&
    !gateway.config.forceModel &&
    !options.selectedCandidate &&
    !options.model;
  const immutableSelector =
    specialistRequested &&
    typeof (pool as any).selectExecutionPlan === "function";
  const executionPlan =
    options.executionPlan ??
    (immutableSelector
      ? await pool!.selectExecutionPlan(
          fingerprint,
          features,
          subtask.id,
          gateway.budget.remainingUsd(),
          options.raceGroup,
        )
      : undefined);
  // Older injected test doubles expose the V1 array seam. Production always
  // receives the immutable plan object from PoolRouter.
  const legacyCascade =
    specialistRequested && !immutableSelector
      ? await pool!.selectSpecialist(
          fingerprint,
          features,
          subtask.id,
          gateway.budget.remainingUsd(),
          options.raceGroup,
        )
      : [];
  const cascade = [...legacyCascade];
  let cascadeIndex = 0;
  let adaptiveTier: CodingTier | undefined = demand
    ? (options.adaptiveStartTier ?? demand.tier)
    : undefined;
  let adaptiveAttempt = 0;
  let selected =
    options.selectedCandidate ?? executionPlan?.initialCandidate ?? cascade[0];
  let role: Role = options.initialRole ?? roleFor(selected);
  if (adaptiveTier === "frontier" && pool)
    selected = await pool.selectFrontierRescue(features, subtask.id);
  let model =
    adaptiveTier && adaptiveTier !== "frontier"
      ? PARETO_CODE_MODEL
      : (options.model ?? selected?.model.id ?? gateway.config.forceModel);
  if (!model && pool && !adaptiveTier) {
    selected = await pool.select(
      features,
      subtask.id,
      [],
      undefined,
      false,
      options.raceGroup,
    );
    model = selected.model.id;
    role = roleFor(selected);
  }
  if (adaptiveTier)
    role =
      adaptiveTier === "frontier"
        ? "FRONTIER_MODEL"
        : adaptiveTier === "high"
          ? "STRONG_MODEL"
          : "CHEAP_CODER_A";
  model ??= gateway.config.registry[role];
  if (!model) throw Error("No compatible priced model fits the coding attempt");
  gateway.logger.log("coding_route_decision", {
    subtaskId: subtask.id,
    task_bucket: taskBucket(features),
    verification_strength: fingerprint.verificationStrength,
    task_risk: (
      executionPlan?.qualityClass ?? requiredQualityClass(fingerprint)
    ).toLowerCase(),
    semantic_complexity:
      fingerprint.semanticComplexity ??
      fingerprint.difficulty.technicalComplexity,
    consequence_risk:
      fingerprint.consequenceRisk ?? fingerprint.difficulty.changeRisk,
    verifier_false_accept_risk: fingerprint.verifierFalseAcceptRisk ?? null,
    recovery_detectability: fingerprint.recoveryDetectability ?? null,
    candidate: model,
    ...(executionPlan
      ? {
          execution_plan_id: executionPlan.id,
          execution_engine: executionPlan.executionEngine,
          quality_class: executionPlan.qualityClass,
          evidence_class: executionPlan.evidenceClass,
          conservative_quality: executionPlan.conservativeQuality,
          quality_floor: executionPlan.requiredQuality,
          expected_cost_per_verified_solve:
            executionPlan.expectedCostPerVerifiedSolve,
          expected_latency: executionPlan.expectedLatencyMs,
          expected_latency_p50_ms: executionPlan.expectedLatencyP50Ms ?? null,
          expected_latency_p90_ms: executionPlan.expectedLatencyP90Ms ?? null,
          expected_total_cost_usd: executionPlan.expectedTotalCostUsd ?? null,
          why_selected: executionPlan.whySelected,
        }
      : {
          quality_floor:
            selected && "firstAttemptQualityFloor" in selected
              ? (selected as any).firstAttemptQualityFloor
              : (demand?.qualityFloor ?? gateway.config.routing.minimumQuality),
        }),
    approved_recovery_candidates: executionPlan
      ? executionPlan.approvedCandidateSet
          .filter((entry) => entry.model.id !== model)
          .map((entry) => entry.model.id)
      : cascade.slice(1).map((entry) => entry.model.id),
  });
  gateway.logger.log("latency", {
    subtaskId: subtask.id,
    routing_selection_ms: Date.now() - routingStarted,
  });
  const excluded: string[] = [];
  const specialistPlan =
    (!!executionPlan || cascade.length > 0) &&
    !options.selectedCandidate &&
    !options.model;
  let highestQualityTier = selected ? tierRank[selected.model.tier] : 0;
  const usedOperationalFallbacks = new Set<string>();
  const selectCandidate = (next: Candidate, operational = false) => {
    const rank = tierRank[next.model.tier];
    // Tier monotonicity protects real coding-quality recovery. It must not
    // block a cheaper frozen-policy candidate after a provider/protocol
    // failure; the frozen task quality floor is the contract in that case.
    if (
      excluded.includes(next.model.id) ||
      (!executionPlan && !operational && rank < highestQualityTier)
    )
      return false;
    selected = next;
    model = next.model.id;
    role = roleFor(next);
    highestQualityTier = Math.max(highestQualityTier, rank);
    return true;
  };
  const nextPlannedModel = async (
    observation: {
      failureMode?:
        | "operational"
        | "no_mutation"
        | "verification_failure"
        | "compiler_failure"
        | "test_failure"
        | "context_limit"
        | "token_limit"
        | "discovery_limit"
        | "other";
      failurePhase?: string;
      mutationObserved?: boolean;
      inputTokens?: number;
      outputTokens?: number;
      wallClockMs?: number;
      terminationReason?: string;
      codingAttempts?: number;
    } = {},
  ) => {
    if (gateway.config.forceModel) return false;
    if (!excluded.includes(model!)) excluded.push(model!);
    if (executionPlan && pool) {
      const recoveryObservation = {
        failureMode: observation.failureMode ?? "other",
        failurePhase: observation.failurePhase ?? "DISCOVERY",
        previousModel: model!,
        mutationObserved: observation.mutationObserved ?? false,
        inputTokens: observation.inputTokens,
        outputTokens: observation.outputTokens,
        wallClockMs: observation.wallClockMs,
        terminationReason: observation.terminationReason,
        codingAttempts: observation.codingAttempts,
      };
      const next = pool.selectRecoveryCandidate(
        executionPlan,
        recoveryObservation,
        new Set(excluded),
      );
      // nextPlannedModel handles coding/no-mutation/limit recovery.
      // Provider/protocol incompatibility can still surface here as a
      // termination reason even though the declared failureMode is not
      // "operational". Treat that execution-path failure as operational so
      // Koda may move to any frozen quality-safe compatible candidate,
      // regardless of configured model tier or vendor.
      const operational =
        recoveryObservation.failureMode === "operational" ||
        recoveryObservation.terminationReason ===
          "direct_edit_protocol_error" ||
        protocolIncompatibility(recoveryObservation.terminationReason);
      return next ? selectCandidate(next, operational) : false;
    }
    if (adaptiveTier) {
      const next = nextCodingTier(adaptiveTier);
      if (!next) return false;
      adaptiveTier = next;
      adaptiveAttempt++;
      if (next === "frontier") {
        if (!pool) return false;
        selected = await pool
          .selectFrontierRescue(features, subtask.id)
          .catch(() => undefined);
        if (!selected) return false;
        model = selected.model.id;
      } else {
        selected = undefined;
        model = PARETO_CODE_MODEL;
      }
      role =
        next === "frontier"
          ? "FRONTIER_MODEL"
          : next === "high"
            ? "STRONG_MODEL"
            : "CHEAP_CODER_A";
      return true;
    }
    while (++cascadeIndex < cascade.length) {
      const next = cascade[cascadeIndex]!;
      if (selectCandidate(next)) return true;
    }
    // A specialist cascade is the optimizer's authoritative execution plan.
    // Quality failures may advance within it, never restart generic routing.
    if (specialistPlan) return false;
    if (pool) {
      try {
        const next = await pool.select(
          features,
          subtask.id,
          excluded,
          selected?.model,
          true,
          options.raceGroup,
        );
        return selectCandidate(next);
      } catch {
        return false;
      }
    }
    const next = router.escalate(role);
    if (!next || excluded.includes(gateway.config.registry[next])) return false;
    role = next;
    model = gateway.config.registry[next];
    return true;
  };
  const nextOperationalModel = async () => {
    const failedModel = model!;
    if (!excluded.includes(failedModel)) excluded.push(failedModel);
    if (executionPlan && pool) {
      const fallback = pool.selectRecoveryCandidate(
        executionPlan,
        {
          failureMode: "operational",
          failurePhase: "PROVIDER",
          previousModel: failedModel,
          mutationObserved: false,
        },
        new Set(excluded),
      );
      return fallback ? selectCandidate(fallback, true) : false;
    }
    if (
      !executionPlan &&
      specialistPlan &&
      pool &&
      !usedOperationalFallbacks.has(failedModel)
    ) {
      usedOperationalFallbacks.add(failedModel);
      try {
        const fallback = await pool.select(
          features,
          subtask.id,
          excluded,
          selected?.model,
          false,
          options.raceGroup,
        );
        if (selectCandidate(fallback, true)) return true;
      } catch {}
    }
    // The only remaining transition is the already selected monotonic quality
    // edge. Never ask the generic router to invent another runtime route.
    return nextPlannedModel();
  };

  const injectedWorker = options.codingWorker;
  let diagnostics = options.stableRepair?.failedChecks
    .map(
      (check) =>
        `${check.command}\n${[check.stdout, check.stderr].filter(Boolean).join("\n")}`,
    )
    .join("\n");
  let previousFailedDiff = options.stableRepair?.failedDiff;
  let tinyNoMutationAttempts = 0;
  let codingAttempts = 0;
  let operationalRetries = 0;
  const retriedTransientModels = new Set<string>();
  let completionContinuations = 0;
  let verificationRepairUsed = false;
  let verificationRepairPending = false;
  let verificationFailureBeforeRepair: VerificationResult | undefined;
  let retainedReviewChanges: CompletionReviewInput["fileChanges"] = [];
  let retainedReviewPaths: string[] = [];
  let completionRepair: CodingWorkerContext["completionRepair"];
  let implementationRecovery: CodingWorkerContext["implementationRecovery"];
  const economicalCompletion = (executionPlan?.authority === "openrouter-auto" || executionPlan?.authority === "cold-start") &&
    executionPlan.initialModel !== executionPlan.referenceModel;
  const maxCompletionContinuations = economicalCompletion ? 2 : 1;
  let sameModelCompletionUsed = false;
  let pinnedCompletionModel: string | undefined;
  const maxOperationalRetries = 2;
  const resumedDiscoveryEvidence = new Set<string>();
  let resumedAgenticTokenPreflight = false;
  const configuredPlanAttempts = specialistPlan
    ? (executionPlan?.maxCodingAttempts ??
      Math.min(gateway.config.maxIterations, cascade.length + 1))
    : Math.max(1, gateway.config.maxIterations);
  const maxPlanAttempts = configuredPlanAttempts;
  // Preserve the accepted baseline across retained candidate continuations.
  // Newly authorized paths are captured before their first mutation. Restore
  // newer groups first, then overlay the older authoritative baseline.
  const baselineCheckpoints = [{scope: writeScope, checkpoint: await AttemptCheckpoint.capture(path, writeScope)}];
  for (let attempt = 0; attempt < maxPlanAttempts; attempt++) {
    if (options.stop?.()) throw Error("Speculative attempt superseded");
    const addedBaselinePaths = writeScope.paths.filter(file =>
      !baselineCheckpoints.some(entry => entry.scope.allows(file)));
    if (addedBaselinePaths.length) {
      const scope = new WriteScope(addedBaselinePaths, gateway.logger, subtask.id);
      baselineCheckpoints.push({scope, checkpoint: await AttemptCheckpoint.capture(path, scope)});
    }
    const checkpoint = await AttemptCheckpoint.capture(path, writeScope);
    const coldStart = (executionPlan?.authority === "cold-start" || executionPlan?.authority === "openrouter-auto");
    const futureColdLegs = coldStart
      ? executionPlan!.approvedCandidateSet.slice(
          executionPlan!.approvedCandidateSet.findIndex((c) => c.model.id === model) + 1,
        ).filter((c) => !excluded.includes(c.model.id))
      : [];
    const coldCompletionReserve = coldStart
      ? Number(executionPlan!.coldStartDecision?.completionReserveUsd ?? 0)
      : 0;
    const futureColdUsd = futureColdLegs.reduce((sum, c) => sum + c.reservationCost, 0);
    const futureColdTokens = futureColdLegs.reduce((sum, c) => sum + c.tokenEfficiency.p90TotalTokens, 0);
    const remaining = coldStart
      ? Math.max(0, Math.min(
          gateway.budget.remainingUsd() - futureColdUsd - coldCompletionReserve,
          Number((selected as { reservationCost?: number } | undefined)?.reservationCost ?? Infinity),
        ))
      : gateway.budget.remainingUsd();
    if (
      remaining <= 0 ||
      gateway.budget.remainingTokens() <= 0 ||
      gateway.budget.remainingMs() <= 1
    ) {
      gateway.logger.log("execution_plan_exhausted", {
        subtaskId: subtask.id,
        reason: "run_budget_exhausted",
        attempted_models: excluded,
      });
      return { verification: verificationResult([]), role, evidence };
    }
    const forecast =
      selected && "expectedAttemptCost" in selected
        ? Number((selected as any).expectedAttemptCost)
        : remaining / 2;
    const conservative =
      selected && "conservativeAttemptCost" in selected
        ? Number((selected as any).conservativeAttemptCost)
        : undefined;
    const reservation =
      selected && "reservationCost" in selected
        ? Number((selected as any).reservationCost)
        : undefined;
    const plannedAttemptCost = finite(conservative)
      ? conservative
      : finite(reservation)
        ? reservation
        : finite(forecast)
          ? forecast * 2
          : remaining;
    const learnedTokenBound =
      selected && "tokenEfficiency" in selected
        ? Number((selected as any).tokenEfficiency?.p90TotalTokens)
        : undefined;
    // DIRECT/STABLE own the whole request. A planned worker owns only its
    // compiler-assigned objective and integration contract. Repeating the
    // global multi-file request and every plan acceptance criterion here gave
    // parallel workers mutually contradictory instructions: their write scope
    // named one file while the prompt told each of them to change all files.
    const workerRequirements =
      subtask.id === "direct" || subtask.id === "stable"
        ? [task, subtask.objective, ...plan.acceptanceCriteria]
        : [subtask.objective, subtask.integrationContract];
    const workerTask = [
      ...new Set(
        workerRequirements.filter((value): value is string => !!value),
      ),
    ].join("\n\n");
    const capacity = codingCapacity(
      Math.max(0, gateway.budget.remainingTokens() - futureColdTokens),
      remaining,
      !!implementationRecovery || operationalRetries > 0,
      coldStart, // Future coding legs and completion were already reserved above.
    );
    const workerContext = codingContextPacket({
      context,
      evidence,
      writeScope: writeScope.paths,
      diagnostics,
      previousFailedDiff,
      localizationSummary: options.stableHandoff?.requiredChange,
      repairPacket: options.repairPacket,
      completionRepair,
      // Operational/no-mutation recovery starts a different worker and still
      // needs the grounded packet. Only a real failed candidate diff/check is
      // a compact repair handoff.
      repair: !!diagnostics || !!previousFailedDiff,
    });
    workerContext.implementationRecovery = implementationRecovery;
    // Role-based and virtual routes use Koda's configured price ceilings, as
    // Gateway.call does. A concrete catalog selection keeps its own metadata.
    const attemptMetadata =
      selected?.metadata ??
      (!pool || adaptiveTier
        ? {
            inputPrice: gateway.config.maxInputPrice,
            outputPrice: gateway.config.maxOutputPrice,
          }
        : (await pool.catalog?.get?.())?.get(model));
    const workerOutputTokens = Math.min(
      gateway.config.maxOutputTokens,
      attemptMetadata?.maxOutputTokens ?? 4096,
    );
    let handoff = injectedWorker
      ? undefined
      : await planCodingHandoff({
          repoPath: path,
          routedModel: model,
          task: workerTask,
          writeScope: [...writeScope.paths],
          context: workerContext,
          attemptTokenCapacity: Math.min(
            gateway.budget.remainingTokens(),
            gateway.config.stageMaxTokens,
          ),
          remainingRunTokens: capacity.tokens,
          modelContextTokens: attemptMetadata?.contextLength,
          maxOutputTokens: workerOutputTokens,
          costCapacityUsd: Math.min(remaining, gateway.config.stageMaxUsd),
          promptPricePerMillion: attemptMetadata?.inputPrice,
          completionPricePerMillion: attemptMetadata?.outputPrice,
          directEditEligible:
            subtask.id !== "stable" &&
            usesDirectEditEngine(fingerprint) &&
            writeScope.paths.length === 1 &&
            writeScope.paths[0] !== ".",
        });

    if (handoff?.mode === "aider" && !injectedWorker) {
      const gitAvailable =
        (
          await execa("git", ["--version"], { reject: false }).catch(
            () => undefined,
          )
        )?.exitCode === 0;
      if (!gitAvailable) {
        gateway.logger.log("execution_mode_fallback", {
          subtaskId: subtask.id,
          from: "aider",
          to: "agentic",
          reason: "git_unavailable",
          model,
        });
        handoff = {
          ...handoff,
          mode: "agentic",
          reason: "Git unavailable; use bounded native tools on the same model",
        };
      }
    }
    if (handoff?.mode === "agentic" && !writeScope.paths.includes(".")) {
      workerContext.implementationRecovery ??= {
        reason: "bounded_coding_packet",
      };
    }
    const worker: CodingWorker =
      injectedWorker ??
      (handoff!.mode === "direct"
        ? new DirectEditWorker(gateway.budget, gateway.logger)
        : handoff!.mode === "agentic"
          ? new AgenticCodingWorker(gateway.budget, gateway.logger)
          : new AiderExecutor(gateway.budget, gateway.logger));

    const workerMode = injectedWorker
      ? (injectedWorker.engine ??
        (injectedWorker instanceof AiderExecutor
          ? "aider"
          : injectedWorker instanceof AgenticCodingWorker
            ? "agentic"
            : injectedWorker instanceof DirectEditWorker
              ? "direct-edit"
              : "custom"))
      : handoff!.mode;

    const handoffPromptBytes = worker instanceof AgenticCodingWorker
      ? agenticPromptBytes({task: workerTask, writeScope: [...writeScope.paths], context: workerContext})
      : injectedWorker
      ? Buffer.byteLength(
          JSON.stringify({
            task: workerTask,
            context: workerContext,
          }),
        ) + 1_024
      : handoff!.estimatedPromptBytes;

    gateway.logger.log("coding_handoff", {
      subtaskId: subtask.id,
      mode: workerMode,
      reason: handoff?.reason ?? "injected worker",
      estimated_prompt_bytes: handoffPromptBytes,
      editable_files:
        handoff?.aiderFiles?.editable ??
        writeScope.paths.filter((file) => file !== "."),
      readonly_files:
        handoff?.aiderFiles?.readOnly ??
        workerContext.relevantFiles?.filter(
          (file) => !writeScope.paths.includes(file),
        ) ??
        [],
    });

    const limits = attemptLimitPolicy({
      fingerprint,
      effort,
      promptBytes: handoffPromptBytes,
      progressiveCompaction: worker instanceof AgenticCodingWorker,
      maxIterations: gateway.config.maxIterations,
      maxOutputTokens: workerOutputTokens,
      learnedP90Tokens: finite(learnedTokenBound)
        ? Math.ceil(learnedTokenBound)
        : undefined,
      remainingTokens: capacity.tokens,
      stageMaxTokens: gateway.config.stageMaxTokens,
      plannedBudgetUsd: plannedAttemptCost,
      remainingUsd: capacity.usd,
      stageMaxUsd: gateway.config.stageMaxUsd,
      promptPricePerMillion: attemptMetadata?.inputPrice,
      completionPricePerMillion: attemptMetadata?.outputPrice,
      remainingMs: Math.max(
        1,
        gateway.budget.remainingMs() -
          gateway.config.phaseBudget.verificationReserveMs,
      ),
      configuredTimeoutMs: gateway.config.codingAttemptTimeoutMs,
      plannedLatencyP90Ms:
        selected && "latencyP90Ms" in selected
          ? (selected as { latencyP90Ms?: number }).latencyP90Ms
          : undefined,
      // Broad primary attempts now run through the same complete Aider
      // loop as recovery attempts; fund discover/read/mutate/verify up front.
      boundedDiscovery: false,
      aiderWorker: worker instanceof AiderExecutor,
      modelContextTokens: attemptMetadata?.contextLength,
      directEditEligible: worker instanceof DirectEditWorker,
    });
    if (!limits.viable || workerOutputTokens < 512) {
      const skippedModel = model;
      gateway.logger.log("coding_attempt_non_viable", {
        subtaskId: subtask.id,
        model: skippedModel,
        limit_kind: limits.nonViableLimitKind,
        required_tokens: limits.minimumViableTokens,
        available_tokens: limits.attemptTokenCapacity,
        required_context_tokens: limits.providerContextRequired,
        available_context_tokens: Number.isFinite(
          limits.providerContextCapacity,
        )
          ? limits.providerContextCapacity
          : null,
        required_cost_usd: limits.minimumViableCostUsd ?? null,
        available_cost_usd: Math.min(capacity.usd, gateway.config.stageMaxUsd),
        required_steps: limits.viableCalls,
        available_steps: limits.maxSteps,
        required_timeout_ms: limits.localized
          ? 10_000
          : limits.complex
            ? 30_000
            : 20_000,
        available_timeout_ms: limits.timeoutMs,
      });
      const moved = await nextPlannedModel({
        failureMode: "operational",
        failurePhase: "BEFORE_EXECUTION",
        terminationReason: limits.nonViableLimitKind,
      });
      gateway.logger.log("model_attempt", {
        subtaskId: subtask.id,
        modelRequested: skippedModel,
        modelServed: null,
        verification: "NOT_FULLY_VERIFIED",
        escalated: moved,
        reason: `non_viable_attempt:${limits.nonViableLimitKind}`,
      });
      if (moved) {
        attempt--;
        continue;
      }
      gateway.logger.log("execution_plan_exhausted", {
        subtaskId: subtask.id,
        reason: `non_viable_attempt:${limits.nonViableLimitKind}`,
        attempted_models: [...new Set([...excluded, skippedModel])],
      });
      return { verification: verificationResult([]), role, evidence };
    }
    const attemptBudget = limits.budgetUsd;
    const attemptTokenBound = limits.maxTokens;
    const attemptSteps = limits.maxSteps;
    const attemptTimeoutMs = limits.timeoutMs;
    const eventStart = gateway.logger.events.length;
    const attemptTier = adaptiveTier;
    gateway.logger.log("coding_worker_start", {
      subtaskId: subtask.id,
      worker_engine: workerMode,
      model,
      worktree: path,
      assigned_write_scope: writeScope.paths,
      attempt_budget_usd: attemptBudget,
      attempt_token_limit: attemptTokenBound,
      configured_token_limit: attemptTokenBound,
      attempt_step_limit: attemptSteps,
      attempt_timeout_ms: attemptTimeoutMs,
      forecast_provider_prompt_bytes: handoffPromptBytes,
      context_bytes_initial:
        attempt === 0 ? Buffer.byteLength(JSON.stringify(workerContext)) : 0,
      context_bytes_repeated:
        attempt === 0 ? 0 : Buffer.byteLength(JSON.stringify(workerContext)),
    });
    const workerStarted = Date.now();
    const rawResult = await worker.run({
      repoPath: path,
      attemptId: subtask.id,
      task: workerTask,
      model: model === "openrouter/auto" ? (pinnedCompletionModel ?? model) : model,
      budgetUsd: attemptBudget,
      maxTokens: attemptTokenBound,
      // Repair needs room to inspect source + failing assertions and make
      // multiple justified edits. The existing attempt limits remain binding.
      maxSteps: completionRepair?.unresolvedRequirementIds.includes("VERIFICATION_REGRESSION") && !(worker instanceof AgenticCodingWorker) ? 1 : attemptSteps,
      timeoutMs: attemptTimeoutMs,
      // Provider latency is independent of task size. The worker bounds this
      // configured request deadline by its remaining attempt time.
      requestTimeoutMs: gateway.config.modelTimeoutMs.implementation,
      commandTimeoutMs: gateway.config.commandTimeoutMs,
      maxOutputTokens: workerOutputTokens,
      baseUrl: gateway.config.baseUrl,
      sessionId: `${gateway.logger.runId}/${subtask.id}/${model}`,
      maxToolOutputBytes: gateway.config.context.toolResultBytes,
      contextWindowTokens: attemptMetadata?.contextLength,
      modelMetadata: attemptMetadata,
      autoRouter: model === "openrouter/auto" && executionPlan?.authority === "openrouter-auto"
        ? {models:executionPlan.coldStartDecision!.autoModels as string[],costTier:executionPlan.coldStartDecision!.costTier as import("../router/openRouterAutoPolicy.js").AutoRequestSettings["costTier"]}
        : undefined,
      promptPricePerMillion: attemptMetadata?.inputPrice,
      completionPricePerMillion: attemptMetadata?.outputPrice,
      codingRoute:
        attemptTier && attemptTier !== "frontier"
          ? {
              tier: attemptTier,
              reason: demand?.reason ?? "Adaptive coding",
              attempt: adaptiveAttempt,
            }
          : undefined,
      writeScope: [...writeScope.paths],
      // Only the explicit tiny fast path hands off after the first edit.
      // Progressive Agentic tasks and completion repair may require more edits.
      returnOnMutation:
        (!completionRepair || completionRepair.unresolvedRequirementIds.includes("VERIFICATION_REGRESSION")) &&
        writeScope.paths.length === 1 &&
        (!!options.tinyDirect ||
          (fingerprint.scope === "single" &&
            !fingerprint.architectureHeavy &&
            !fingerprint.crossComponent &&
            fingerprint.difficulty.changeRisk !== "high")),
      directFullScope:
        subtask.id === "stable" &&
        !subtask.parallelSafe &&
        writeScope.paths.length === 1 &&
        writeScope.paths[0] === ".",
      context: workerContext,
      aiderFiles: handoff?.mode === "aider" ? handoff.aiderFiles : undefined,
      aiderEditFormat: preferredAiderFormat(
        pool?.history?.readOperations?.() ?? [],
        model,
      ),
    });
    const mutationReachedVerificationBoundary =
      rawResult.changedPaths.length > 0 &&
      (rawResult.progressPhase === "MUTATION_OBSERVED" ||
        rawResult.progressPhase === "VERIFICATION_ATTEMPTED");
    const candidateReadyHandoff =
      mutationReachedVerificationBoundary &&
      (rawResult.limitKind === "token_preflight" ||
        (rawResult.exitStatus === "infra_failure" &&
          rawResult.terminationReason !== "budget_exhausted"));
    const result = candidateReadyHandoff
      ? {
          ...rawResult,
          exitStatus: "completed" as const,
          terminationReason: "candidate_ready_for_verification",
          limitKind: undefined,
          exactLimitFired: undefined,
        }
      : rawResult;
    if (candidateReadyHandoff)
      gateway.logger.log("candidate_verification_handoff", {
        subtaskId: subtask.id,
        model,
        changed_paths: result.changedPaths,
        consumed_tokens:
          result.consumedTokens ??
          (result.inputTokens ?? 0) + (result.outputTokens ?? 0),
        remaining_tokens: result.remainingTokens ?? null,
        reason:
          rawResult.exitStatus === "infra_failure"
            ? "provider failed after a real mutation; deterministic verification and completion review own acceptance"
            : "next model request exceeded reserve; deterministic verification owns acceptance",
      });
    // DirectEditWorker bypasses Gateway.call, so explicitly feed the one-call
    // provider outcome into the operational ledger. This calibrates future
    // DIRECT latency/reliability without contaminating coding-quality history.
    if (result.engine === "direct-edit" && pool) {
      const directOperationalFailure =
        result.exitStatus === "infra_failure" ||
        result.terminationReason === "direct_edit_protocol_error";
      pool.history?.recordOperation({
        type: "operational_call",
        timestamp: new Date().toISOString(),
        runId: gateway.logger.runId,
        subtaskId: subtask.id,
        stage: "implement",
        taskBucket: taskBucket(features),
        modelRequested: model!,
        modelServed:
          result.exitStatus === "infra_failure" ? null : result.model,
        provider: null,
        wallClockMs: result.wallClockMs,
        outcome: directOperationalFailure ? "error" : "response",
        costUsd: result.costUsd ?? null,
        classification: directOperationalFailure
          ? "OPERATIONAL_FAILURE"
          : undefined,
        failureKind: directOperationalFailure
          ? operationalFailureKind(result.fatalError)
          : undefined,
      });
    } else if (
      (result.engine === "aider" || result.engine === "agentic") &&
      pool
    ) {
      const operationalMessage = [result.terminationReason, result.fatalError]
        .filter(Boolean)
        .join(": ");
      const operationalFailure =
        result.exitStatus === "infra_failure" ||
        result.exitStatus === "failed" ||
        protocolIncompatibility(operationalMessage) ||
        result.limitKind === "timeout" ||
        result.limitKind === "provider_limit";
      pool.history?.recordOperation({
        type: "operational_call",
        timestamp: new Date().toISOString(),
        runId: gateway.logger.runId,
        subtaskId: subtask.id,
        stage: "implement",
        taskBucket: taskBucket(features),
        modelRequested: model,
        modelServed: result.model ?? null,
        provider: result.engine,
        wallClockMs: result.wallClockMs,
        outcome: operationalFailure ? "error" : "response",
        costUsd: result.costUsd ?? null,
        classification: operationalFailure ? "OPERATIONAL_FAILURE" : undefined,
        failureKind: operationalFailure
          ? operationalFailureKind(operationalMessage)
          : undefined,
      });
    }
    const recordAiderFormats = (verification: string) => {
      if (result.engine !== "aider") return;
      for (const entry of result.formatAttempts ?? []) {
        pool?.history?.recordOperation({
          type: "operational_call",
          timestamp: new Date().toISOString(),
          runId: gateway.logger.runId,
          subtaskId: subtask.id,
          stage: "implement",
          taskBucket: taskBucket(features),
          modelRequested: result.model,
          modelServed: result.model,
          provider: "aider",
          wallClockMs: entry.wallClockMs,
          costUsd: null,
          outcome: entry.failureKind ? "error" : "response",
          failureKind:
            entry.failureKind === "edit_format"
              ? "edit_format"
              : entry.failureKind
                ? "provider"
                : undefined,
          classification:
            entry.failureKind && entry.failureKind !== "edit_format"
              ? "OPERATIONAL_FAILURE"
              : undefined,
          editFormat: entry.format,
          exitCode: entry.exitCode,
          mutation: entry.mutation,
          changedPaths: entry.changedPaths,
          verification: entry.mutation ? verification : "NOT_FULLY_VERIFIED",
        });
      }
    };
    if (!result.changedPaths.length) recordAiderFormats("NOT_FULLY_VERIFIED");
    gateway.logger.log("latency", {
      subtaskId: subtask.id,
      coding_worker_ms: Date.now() - workerStarted,
    });
    gateway.logger.log("coding_worker_stop", {
      subtaskId: subtask.id,
      worker_engine: result.engine,
      worker_version: result.engineVersion,
      model: result.model,
      worktree: path,
      assigned_write_scope: writeScope.paths,
      actual_changed_paths: result.changedPaths,
      trajectory_path: result.trajectoryPath,
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      cached_input_tokens: result.cachedInputTokens ?? 0,
      uncached_input_tokens: Math.max(
        0,
        (result.inputTokens ?? 0) - (result.cachedInputTokens ?? 0),
      ),
      time_to_first_mutation_ms: result.timeToFirstMutationMs ?? null,
      cost_usd: result.costUsd,
      wall_time_ms: result.wallClockMs,
      termination_reason: result.terminationReason,
      exit_status: result.exitStatus,
      limit_kind: result.limitKind ?? null,
      progress_phase: result.progressPhase ?? null,
      edit_format: result.editFormat ?? null,
      format_attempts: result.formatAttempts ?? [],
      configured_token_limit: result.configuredTokenLimit ?? attemptTokenBound,
      consumed_tokens:
        result.consumedTokens ??
        (result.inputTokens ?? 0) + (result.outputTokens ?? 0),
      remaining_tokens:
        result.remainingTokens ??
        Math.max(
          0,
          attemptTokenBound -
            ((result.inputTokens ?? 0) + (result.outputTokens ?? 0)),
        ),
      exact_limit_fired: result.exactLimitFired ?? result.limitKind ?? null,
      steps: result.steps ?? null,
      error: result.fatalError,
    });
    if (
      result.inputTokens !== undefined ||
      result.outputTokens !== undefined ||
      result.costUsd !== undefined
    ) {
      gateway.logger.log("attempt_prediction_error", {
        subtaskId: subtask.id,
        model,
        classification: "efficiency_observation",
        predicted_tokens: finite(learnedTokenBound) ? learnedTokenBound : null,
        actual_tokens: (result.inputTokens ?? 0) + (result.outputTokens ?? 0),
        predicted_cost_usd: finite(forecast) ? forecast : null,
        actual_cost_usd: result.costUsd ?? null,
        termination_reason: result.terminationReason ?? null,
        limit_kind: result.limitKind ?? null,
        affects_coding_quality: false,
      });
    }
    const workerAlreadyLoggedCall = gateway.logger.events
      .slice(eventStart)
      .some(
        (event) =>
          event.type === "model_call" &&
          event.subtaskId === subtask.id &&
          event.modelRequested === model &&
          event.stage === "implement",
      );
    if (
      !workerAlreadyLoggedCall &&
      result.inputTokens !== undefined &&
      result.outputTokens !== undefined
    ) {
      gateway.logger.log("model_call", {
        subtaskId: subtask.id,
        role,
        modelRequested: model,
        modelReturned: result.model,
        stage: "implement",
        promptTokens: result.inputTokens,
        completionTokens: result.outputTokens,
        costUsd: result.costUsd ?? null,
        wallClockMs: result.wallClockMs,
        cachedTokens: result.cachedInputTokens ?? 0,
        cacheWriteTokens: result.cacheWriteTokens ?? 0,
        workerEngine: result.engine,
      });
    }
    if (
      result.exitStatus === "infra_failure" &&
      result.terminationReason === "budget_exhausted"
    ) {
      await checkpoint.restore(path, writeScope);
      gateway.logger.log("model_attempt", {
        subtaskId: subtask.id,
        modelRequested: model,
        modelServed: null,
        verification: "NOT_FULLY_VERIFIED",
        escalated: false,
        reason: `execution budget exhausted: ${result.fatalError ?? "bounded reservation unavailable"}`,
      });
      gateway.logger.log("execution_plan_exhausted", {
        subtaskId: subtask.id,
        reason: "run_budget_exhausted",
        attempted_models: [...new Set([...excluded, model])],
      });
      return { verification: verificationResult([]), role, evidence };
    }
    if (result.exitStatus === "infra_failure") {
      await checkpoint.restore(path, writeScope);
      if (verificationRepairPending && verificationFailureBeforeRepair) {
        // Restoring the repair checkpoint leaves the previously verified
        // failing candidate. An operational repair error cannot erase its
        // authoritative CHECK_FAIL or turn it into an unknown result.
        gateway.logger.log("verification_repair_exhausted", {
          subtaskId: subtask.id, model, reason: "operational_repair_failure",
          classification: "OPERATIONAL_FAILURE", error: result.fatalError,
        });
        return { verification: verificationFailureBeforeRepair, role, evidence };
      }

      /*
       * An Aider provider-input/context preflight failure means the complete
       * Aider packet cannot be executed as constructed. This is execution-mode
       * evidence, not coding-model quality evidence.
       *
       * Reuse Koda's existing implementationRecovery path so the same model
       * retries through progressive Agentic bounded reads instead of sending
       * the same Aider packet through another model.
       */
      const packetPreflightEvidence = [
        result.terminationReason,
        result.fatalError,
        result.exactLimitFired,
        result.limitKind,
      ]
        .filter(
          (value): value is string =>
            typeof value === "string" && value.length > 0,
        )
        .join(" ")
        .toLowerCase();

      const completePacketPreflightFailure =
        !injectedWorker &&
        (result.engine === "aider" || result.engine === "direct-edit") &&
        result.changedPaths.length === 0 &&
        (result.limitKind === "context_limit" ||
          result.limitKind === "token_preflight" ||
          packetPreflightEvidence.includes("provider_input_preflight") ||
          packetPreflightEvidence.includes("context_preflight_exhausted") ||
          packetPreflightEvidence.includes("provider_output_limit") ||
          packetPreflightEvidence.includes("direct_edit_context_preflight") ||
          packetPreflightEvidence.includes("direct_edit_token_preflight"));

      if (completePacketPreflightFailure) {
        implementationRecovery = {
          reason: result.limitKind ?? "complete_packet_preflight",
        };

        gateway.logger.log("complete_packet_execution_mode_fallback", {
          subtaskId: subtask.id,
          model,
          from: result.engine,
          to: "agentic",
          reason:
            "complete coding packet rejected by preflight; retry same model with bounded repository reads",
          termination_reason: result.terminationReason,
          limit_kind: result.limitKind ?? null,
          exact_limit_fired: result.exactLimitFired ?? null,
        });

        gateway.logger.log("model_attempt", {
          subtaskId: subtask.id,
          modelRequested: model,
          modelServed: null,
          verification: "OPERATIONAL_FAILURE",
          escalated: false,
          reason: "complete_packet_preflight_replanned_same_model",
        });

        /*
         * This is an execution-mode correction, not model-quality evidence.
         *
         * Reuse the same logical attempt and same model. The next handoff sees
         * implementationRecovery and selects Agentic progressive execution.
         */
        attempt--;
        continue;
      }

      const providerFailure = [result.fatalError, result.stderr]
        .filter(Boolean)
        .join(" ");
      // Workers normalize provider exceptions into engine-specific termination
      // reasons (for example `agentic_provider_error`). Classify the preserved
      // provider evidence instead of requiring one worker's reason literal.
      const transientProviderFailure =
        isTransientProviderError(new Error(providerFailure)) ||
        /\b(?:BadGatewayError|ServiceUnavailableError|RateLimitError|provider_protocol_error|malformed response|(?:HTTP\s*)?(?:408|409|425|429|5\d\d))\b/i.test(
          providerFailure,
        );
      if (verificationRepairPending) {
        gateway.logger.log("verification_repair_exhausted", {
          subtaskId: subtask.id,
          model,
          reason: "repair_worker_infrastructure_failure",
        });
        return {
          verification: verificationResult([
            {
              command: result.engine,
              cwd: ".",
              exitCode: 1,
              stdout: "",
              stderr:
                result.fatalError ?? "Repair worker infrastructure failure",
              wallClockMs: result.wallClockMs,
              timedOut: false,
              outcome: "INFRA_FAILURE",
              unavailable: "worker_infrastructure_unavailable",
              source: result.engine,
              kind: "test",
              requirement: "required",
            },
          ]),
          role,
          evidence,
        };
      }
      const failedModel = model;
      if (result.discoveryEvidence?.trim())
        diagnostics = [
          diagnostics,
          "Prior worker discovery evidence:\n" +
            result.discoveryEvidence.trim(),
        ]
          .filter(Boolean)
          .join("\n\n");
      let moved = false;
      operationalRetries++;
      // Pareto is a virtual OpenRouter route. If its selected endpoint cannot
      // execute the required tool protocol, retry through Koda's compatible
      // catalog instead of raising the task's requested quality tier.
      if (
        operationalRetries <= maxOperationalRetries &&
        adaptiveTier &&
        pool &&
        protocolIncompatibility(result.fatalError)
      ) {
        excluded.push(failedModel);
        adaptiveTier = undefined;
        try {
          selected = await pool.select(
            features,
            subtask.id,
            excluded,
            undefined,
            false,
            options.raceGroup,
          );
          model = selected.model.id;
          role = roleFor(selected);
          moved = true;
        } catch {
          moved = false;
        }
      } else if (operationalRetries <= maxOperationalRetries) {
        moved = await nextOperationalModel();
      }
      gateway.logger.log("model_attempt", {
        subtaskId: subtask.id,
        modelRequested: failedModel,
        modelServed: null,
        verification: "OPERATIONAL_FAILURE",
        escalated: moved,
        reason: `Coding worker infrastructure fallback ${moved ? "succeeded" : "exhausted"}: ${result.fatalError ?? result.terminationReason}`,
      });
      gateway.logger.log("aider_fallback", {
        subtaskId: subtask.id,
        from: failedModel,
        to: moved ? model : null,
        reason: "operational_failure",
        moved,
      });
      if (moved) {
        attempt--;
        continue;
      }
      if (
        transientProviderFailure &&
        !protocolIncompatibility(providerFailure) &&
        result.changedPaths.length === 0 &&
        !retriedTransientModels.has(failedModel!) &&
        operationalRetries <= maxOperationalRetries
      ) {
        // Prefer an already-approved operational peer. If the frozen board has
        // no peer, retry the same endpoint once because a transient provider
        // outage is not evidence that a different coding model is required.
        retriedTransientModels.add(failedModel!);
        gateway.logger.log("provider_transient_retry", {
          subtaskId: subtask.id,
          model: failedModel,
          engine: result.engine,
          write_scope: [...writeScope.paths],
          retry: 1,
          affects_coding_quality: false,
        });
        attempt--;
        continue;
      }
      return {
        verification: verificationResult([
          {
            command: result.engine,
            cwd: ".",
            exitCode: 1,
            stdout: "",
            stderr: result.fatalError ?? "Coding worker infrastructure failure",
            wallClockMs: result.wallClockMs,
            timedOut: false,
            outcome: "INFRA_FAILURE",
            unavailable: "worker_infrastructure_unavailable",
            source: result.engine,
            kind: "test",
            requirement: "required",
          },
        ]),
        role,
        evidence,
      };
    }
    const diffStarted = Date.now();
    const diff = await currentDiff(path);
    const attemptChangedPaths = (
      await checkpoint.changed(path, writeScope)
    ).map((change) => change.path);
    const attemptFileChanges = await checkpoint.textChanges(path, writeScope);
    const reviewChanges: Map<
      string,
      NonNullable<CompletionReviewInput["fileChanges"]>[number]
    > = new Map(
      (retainedReviewChanges ?? []).map((change) => [change.path, change]),
    );
    for (const change of attemptFileChanges) {
      const previous = reviewChanges.get(change.path);
      reviewChanges.set(
        change.path,
        previous ? { ...change, before: previous.before } : change,
      );
    }
    const candidateFileChanges: NonNullable<
      CompletionReviewInput["fileChanges"]
    > = [...reviewChanges.values()].filter(
      (change) => change.before !== change.after,
    );
    const candidateReviewPaths: string[] = [
      ...new Set([...retainedReviewPaths, ...attemptChangedPaths]),
    ].filter((file) => {
      const change = reviewChanges.get(file);
      return !change || change.before !== change.after;
    });
    gateway.logger.log("latency", {
      subtaskId: subtask.id,
      candidate_diff_ms: Date.now() - diffStarted,
    });
    const candidateMutation = result.changedPaths.length > 0 && !!diff.trim();
    if (verificationRepairPending && attemptChangedPaths.length === 0) {
      gateway.logger.log("verification_repair_exhausted", {
        subtaskId: subtask.id,
        model,
        reason: "repair_produced_no_mutation",
      });
      return {
        verification: verificationFailureBeforeRepair ?? verificationResult([]),
        role,
        evidence,
      };
    }
    if (result.limitKind && !candidateMutation) {
      await checkpoint.restore(path, writeScope);
      const limitedModel = model;
      const boundedDiscoveryLimit = result.limitKind === "discovery_limit";
      const discoveryEvidence = result.discoveryEvidence?.trim();
      if (
        boundedDiscoveryLimit &&
        (result.discoveryProgress ?? 0) > 0 &&
        discoveryEvidence &&
        !resumedDiscoveryEvidence.has(discoveryEvidence)
      ) {
        resumedDiscoveryEvidence.add(discoveryEvidence);
        diagnostics = [
          diagnostics,
          "Prior discovery evidence:\n" + discoveryEvidence,
        ]
          .filter(Boolean)
          .join("\n\n");
        gateway.logger.log("discovery_continuation", {
          subtaskId: subtask.id,
          model,
          progress: result.discoveryProgress,
          evidence_bytes: Buffer.byteLength(discoveryEvidence),
        });
        attempt--;
        continue;
      }
      if (discoveryEvidence) {
        diagnostics = [
          diagnostics,
          "Prior worker discovery evidence:\n" + discoveryEvidence,
        ]
          .filter(Boolean)
          .join("\n\n");
      }
      const boundedDiscoveryOperationalLimit =
        boundedDiscoveryFirstPass &&
        ["cost_limit", "context_limit"].includes(result.limitKind);
      const discoveryTokenLimit =
        result.progressPhase === "DISCOVERY" &&
        !candidateMutation &&
        (result.limitKind === "token_limit" ||
          result.limitKind === "token_preflight");
      const resumableDiscoveryLimit =
        boundedDiscoveryLimit || discoveryTokenLimit;
      const failureMode =
        result.limitKind === "timeout" ||
        result.limitKind === "provider_limit" ||
        [
          "output_limit",
          "context_limit",
          "token_limit",
          "token_preflight",
        ].includes(result.limitKind)
          ? "operational"
          : boundedDiscoveryOperationalLimit
            ? "operational"
            : result.limitKind === "context_limit"
              ? "context_limit"
              : result.limitKind === "discovery_limit"
                ? "discovery_limit"
                : discoveryTokenLimit
                  ? "discovery_limit"
                  : result.limitKind === "token_limit" ||
                      result.limitKind === "token_preflight"
                    ? "token_limit"
                    : "other";
      const operational = failureMode === "operational";
      if (operational) operationalRetries++;
      else if (!resumableDiscoveryLimit) codingAttempts++;
      const moved =
        (resumableDiscoveryLimit
          ? true
          : operational
            ? operationalRetries <= maxOperationalRetries
            : codingAttempts < maxPlanAttempts) &&
        (await nextPlannedModel({
          failureMode,
          failurePhase: result.progressPhase ?? "DISCOVERY",
          mutationObserved: false,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          wallClockMs: result.wallClockMs,
          terminationReason: result.terminationReason,
          codingAttempts,
        }));
      gateway.logger.log("model_attempt", {
        subtaskId: subtask.id,
        modelRequested: limitedModel,
        modelServed: result.model,
        verification: "NOT_FULLY_VERIFIED",
        escalated: moved,
        reason: `execution_limit:${result.limitKind}:${result.progressPhase ?? "DISCOVERY"}`,
      });
      gateway.logger.log("aider_fallback", {
        subtaskId: subtask.id,
        from: limitedModel,
        to: moved ? model : null,
        reason: `execution_limit:${result.limitKind}`,
        moved,
      });
      if (moved) {
        if (
          [
            "output_limit",
            "context_limit",
            "token_limit",
            "token_preflight",
          ].includes(result.limitKind)
        ) {
          implementationRecovery = { reason: result.limitKind };
        }
        if (operational || resumableDiscoveryLimit) attempt--;
        continue;
      }
      const boundedSameModelRecovery =
        !implementationRecovery &&
        (result.engine === "aider" || result.engine === "direct-edit") &&
        [
          "output_limit",
          "context_limit",
          "token_limit",
          "token_preflight",
        ].includes(result.limitKind);
      if (boundedSameModelRecovery) {
        implementationRecovery = { reason: result.limitKind };
        gateway.logger.log("complete_packet_execution_mode_fallback", {
          subtaskId: subtask.id,
          model: limitedModel,
          from: result.engine,
          to: "agentic",
          reason:
            "complete coding packet hit an execution limit; retry same model with bounded repository reads",
          termination_reason: result.terminationReason,
          limit_kind: result.limitKind,
          exact_limit_fired: result.exactLimitFired ?? null,
        });
        gateway.logger.log("aider_fallback", {
          subtaskId: subtask.id,
          from: limitedModel,
          to: limitedModel,
          reason: `execution_mode:${result.limitKind}`,
          moved: true,
        });
        attempt--;
        continue;
      }
      if (
        !resumedAgenticTokenPreflight &&
        result.engine === "agentic" &&
        result.limitKind === "token_preflight" &&
        result.progressPhase === "DISCOVERY" &&
        discoveryEvidence
      ) {
        // A first progressive attempt can exhaust its own cumulative prompt
        // budget while retaining valid localization. This is an execution
        // envelope failure, so allow one bounded same-model continuation with
        // the observed paths rather than requiring a frozen model escalation.
        resumedAgenticTokenPreflight = true;
        implementationRecovery = { reason: "agentic_token_preflight" };
        gateway.logger.log("agentic_bounded_continuation", {
          subtaskId: subtask.id,
          model: limitedModel,
          evidence_bytes: Buffer.byteLength(discoveryEvidence),
          write_scope: [...writeScope.paths],
        });
        attempt--;
        continue;
      }
      gateway.logger.log("execution_plan_exhausted", {
        subtaskId: subtask.id,
        reason: `execution_limit:${result.limitKind}`,
        attempted_models: [...new Set([...excluded, limitedModel])],
      });
      return { verification: verificationResult([]), role, evidence };
    }
    if (result.limitKind && candidateMutation)
      gateway.logger.log("execution_limit_candidate_preserved", {
        subtaskId: subtask.id,
        model,
        limit_kind: result.limitKind,
        progress_phase: result.progressPhase,
        changed_paths: result.changedPaths,
      });
    if (!result.changedPaths.length || !diff.trim()) {
      await checkpoint.restore(path, writeScope);
      const failedModel = model;
      const failedRole = role;
      if (options.tinyDirect) {
        tinyNoMutationAttempts++;
        if (!adaptiveTier && tinyNoMutationAttempts >= 2)
          throw Error(
            "Tiny direct task produced no mutation after bounded recovery",
          );
      }
      const operational = protocolIncompatibility(result.terminationReason);
      if (operational) operationalRetries++;
      else codingAttempts++;
      const moved =
        options.tinyDirect && !adaptiveTier
          ? false
          : operational && operationalRetries > maxOperationalRetries
            ? false
            : !operational && codingAttempts >= maxPlanAttempts
              ? false
              : await nextPlannedModel({
                  failureMode: operational ? "operational" : "no_mutation",
                  failurePhase: result.progressPhase ?? "DISCOVERY",
                  mutationObserved: false,
                  inputTokens: result.inputTokens,
                  outputTokens: result.outputTokens,
                  wallClockMs: result.wallClockMs,
                  terminationReason: result.terminationReason,
                  codingAttempts,
                });
      gateway.logger.log("model_attempt", {
        subtaskId: subtask.id,
        modelRequested: failedModel,
        modelServed: result.model,
        verification: "NOT_FULLY_VERIFIED",
        escalated: moved,
        reason: "no_mutation",
      });
      if (moved) {
        gateway.logger.log("escalation", {
          subtaskId: subtask.id,
          from: failedRole,
          to: role,
          fromModel: failedModel,
          toModel: model,
          reason: "Coding worker completed without a candidate diff",
        });
        gateway.logger.log("coding_route_escalation", {
          subtaskId: subtask.id,
          from: failedModel,
          to: model,
          from_role: failedRole,
          to_role: role,
          reason: "no_mutation",
        });
        if (operational) attempt--;
        continue;
      }
      if (options.tinyDirect && !adaptiveTier) {
        if (tinyNoMutationAttempts < 2) continue;
        throw Error(
          "Tiny direct task produced no mutation after bounded recovery",
        );
      }
      gateway.logger.log("execution_plan_exhausted", {
        subtaskId: subtask.id,
        reason: "no_mutation",
        attempted_models: [...new Set([...excluded, failedModel])],
      });
      return { verification: verificationResult([]), role, evidence };
    }
    let postCommands = commands;
    if (tinyDocs)
      postCommands = [
        ...new Set(
          subtask.likelyWritePaths.flatMap((file) =>
            tinyDocumentationChecks(profile, file),
          ),
        ),
      ];
    if (
      !options.deferVerificationToIntegration &&
      !tinyDocs &&
      !options.stableRepair
    ) {
      const changedContext = await compileContext(
        path,
        subtask.objective,
        result.changedPaths,
        profile,
        gateway.config.context,
        true,
      );
      const focused = focusedVerificationCheck(
        { ...subtask, likelyWritePaths: result.changedPaths },
        profile,
        changedContext,
      );
      if (focused) {
        const impact = impactAwareVerificationSelection({
          changedPaths: result.changedPaths,
          candidates: verificationPlan(profile, result.changedPaths),
          focusedCommands: [focused],
          fingerprint,
          relationships: verificationImpactRelationships(
            result.changedPaths,
            changedContext,
          ),
        });
        postCommands = [
          ...new Set([
            focused,
            ...impact.candidates.map((candidate) => candidate.command),
            ...subtask.verificationCommands,
          ]),
        ];
        commands = postCommands;
      }
    }
    const verificationStarted = Date.now();
    const candidateVerification = await runChecks(
      postCommands,
      true,
      result.changedPaths,
    );
    gateway.logger.log("latency", {
      subtaskId: subtask.id,
      focused_verification_ms: Date.now() - verificationStarted,
    });
    if (
      candidateVerification.checks.some(
        (check) => check.unavailable === "verification_source_mutation",
      )
    ) {
      gateway.logger.log("verification_infrastructure_failure", {
        subtaskId: subtask.id,
        reason: "verification_source_mutation",
        changed_paths: result.changedPaths,
        affects_coding_quality: false,
      });
      return { verification: candidateVerification, role, evidence };
    }

    if (
      options.deferVerificationToIntegration &&
      result.exitStatus === "completed" &&
      candidateMutation
    ) {
      gateway.logger.log("contribution_verification_deferred", {
        subtaskId: subtask.id,
        changed_paths: result.changedPaths,
        reason: "generated DAG contribution is verified after integration",
      });
      return {
        verification: {
          ...verificationResult([]),
          status: "CANDIDATE_NEUTRAL" as const,
        },
        role,
        evidence,
      };
    }

    // Ambiguous Stable intentionally does not run a broad suite before coding.
    // Once the exact changed paths identify a focused command, evaluate that
    // command against the pre-attempt state and then restore the candidate.
    if (
      !tinyDocs &&
      commands.length &&
      candidateVerification.checks.some(
        (check) => check.outcome !== "CHECK_PASS",
      ) &&
      baselineCommands(commands, result.changedPaths).some(
        (command) =>
          !baseline.checks.some((check) => check.command === command),
      )
    ) {
      const candidateState = await AttemptCheckpoint.capture(path, writeScope);
      try {
        for (const entry of [...baselineCheckpoints].reverse())
          await entry.checkpoint.restore(path, entry.scope);
        const comparableCommands = baselineCommands(
          commands,
          result.changedPaths,
        );
        baseline = comparableCommands.length
          ? await runChecks(comparableCommands)
          : verificationResult([]);
      } finally {
        await candidateState.restore(path, writeScope);
      }
    }

    if (options.stableHandoff) {
      gateway.logger.log("stable_focused_verification", {
        subtaskId: subtask.id,
        worker_engine: result.engine,
        model,
        status: candidateVerification.status,
        checks: candidateVerification.checks,
      });
    }

    // Observation only: retain comparable baseline and the final retry result.
    gateway.logger.log("attempt_verification_evidence", {
      subtaskId: subtask.id,
      observations: verificationEvidence(
        baseline,
        candidateVerification,
        result.changedPaths,
      ),
    });
    const relative = verificationAgainstBaseline(
      baseline,
      candidateVerification,
      result.changedPaths,
    );
    // Passing repository checks establish correctness only for a worker that
    // actually completed its execution contract. A killed/failed worker may
    // leave a useful partial mutation, but that partial candidate cannot be
    // promoted to VERIFIED_SUCCESS merely because existing checks are green.
    const attemptVerification =
      result.exitStatus === "completed"
        ? relative
        : {
            ...relative,
            status: "NOT_FULLY_VERIFIED" as const,
          };
    gateway.logger.log("aider_attempt_verification", {
      subtaskId: subtask.id,
      worker_engine: result.engine,
      model,
      outcome: attemptVerification.status,
      changed_paths: result.changedPaths,
      trajectory_path: result.trajectoryPath,
      edit_format: result.editFormat ?? null,
    });
    recordAiderFormats(attemptVerification.status);
    const candidateAccepted =
      attemptVerification.status === "VERIFIED_SUCCESS" ||
      attemptVerification.status === "CANDIDATE_NEUTRAL" ||
      attemptVerification.status === "CANDIDATE_IMPROVEMENT";

    const finalVerificationHandoff =
      result.exitStatus === "completed" &&
      options.finalVerificationOnly &&
      (candidateVerification.checks.length === 0 ||
        candidateVerification.status === "VERIFIED_SUCCESS");

    const evidencedPaths = new Set([
      ...(workerContext.sourceFiles ?? []).map(({ path }) => path),
      ...subtask.likelyReadPaths,
      ...writeScope.paths,
    ]);
    const globalStylesheets = await Promise.all(
      profile.files
        .filter(
          (file) =>
            evidencedPaths.has(file) &&
            /(?:^|\/)(?:global|globals|app|index)\.css$/i.test(file),
        )
        .slice(0, 8)
        .map(async (file) => {
          try {
            return {
              path: file,
              content: (
                await readFile(await safePath(path, file), "utf8")
              ).slice(0, 128_000),
            };
          } catch {
            return undefined;
          }
        }),
    );
    const cascadeConflict = visualCascadeConflict({
      task,
      diff,
      changedPaths: candidateReviewPaths,
      stylesheets: globalStylesheets.filter(
        (file): file is { path: string; content: string } => !!file,
      ),
    });
    const completionReviewInput: CompletionReviewInput = {
      task,
      requirements,
      diff,
      changedPaths: candidateReviewPaths,
      changedSymbols: [
        ...new Set([
          ...evidence.symbols.filter((symbol) => diff.includes(symbol)),
          ...diff.split("\n").flatMap((line) => {
            const match = line.match(/^@@[^@]*@@\s*(.+)$/);
            return match?.[1]?.trim() ? [match[1].trim()] : [];
          }),
        ]),
      ].slice(0, 24),
      toolEvidence: result.discoveryEvidence ?? result.stdout,
      workerExitStatus: result.exitStatus,
      workerTerminationReason: result.terminationReason,
      verification: attemptVerification,
      verificationDeferred:
        options.finalVerificationOnly &&
        candidateVerification.checks.length === 0,
      fileChanges: candidateFileChanges,
      repositoryEvidence: workerContext.sourceFiles,
      cascadeConflict,
    };
    let completionReview: CompletionReview | undefined;
    if (
      result.exitStatus === "completed" &&
      (candidateAccepted || finalVerificationHandoff) &&
      requirements.length
    ) {
      const deterministicReview =
        requiredTestMutationGap(completionReviewInput) ??
        deterministicLiteralCompletionReview(completionReviewInput);
      completionReview = deterministicReview;
      try {
        const providerReview =
          !deterministicReview &&
          !options.completionReviewer &&
          !(
            options.codingWorker &&
            !(options.codingWorker instanceof AgenticCodingWorker)
          );
        const provenToolModel = result.engine === "agentic"
          ? (result.model !== "openrouter/auto" ? result.model : undefined)
          : undefined;
        const batches = providerReview
          ? completionReviewBatches(
              requirements,
              gateway.config.maxOutputTokens,
            )
          : [requirements];
        const batchReviews: CompletionReview[] = [];
        for (const batch of batches) {
          const reviewInput = { ...completionReviewInput, requirements: batch };
          let batchReview = deterministicReview;
          let strongReviewRetry = false;
          for (
            let reviewAttempt = 0;
            !deterministicReview && reviewAttempt < 2;
            reviewAttempt++
          ) {
            if (options.completionReviewer) {
              batchReview = await options.completionReviewer(reviewInput);
            } else if (
              options.codingWorker &&
              !(options.codingWorker instanceof AgenticCodingWorker)
            ) {
              // Deterministic injected workers cannot dispatch a real provider
              // review. Their existing contract remains independently gated by
              // worker completion and required focused verification.
              batchReview = {
                passed: true,
                requirements: batch.map((requirement) => ({
                  id: requirement.id,
                  satisfied: true,
                  evidence:
                    "Injected worker completed and focused verification passed",
                })),
                summary: "Injected completion contract passed",
              };
            } else {
              let reviewMessage;
              // Completion review is an independent, bounded classification job.
              // Reusing a frontier recovery model here multiplied cost and made a
              // correct candidate depend on that coding endpoint's tool protocol.
              const reviewModel = completionReviewModel(
                gateway.config.registry,
                strongReviewRetry,
                provenToolModel,
              );
              try {
                reviewMessage = await gateway.call(
                  reviewModel,
                  [
                    ...completionReviewMessages(reviewInput),
                    ...(reviewAttempt
                      ? [
                          {
                            role: "user" as const,
                            content:
                              "The previous review could not be accepted due to a provider or protocol failure, or contradicted authoritative verification. Reassess the actual diff against the original user task. Deterministic verification owns regression attribution; generated build criteria do not require repairing an unchanged baseline. Return ONLY the required JSON object, with an explicit boolean assessment and concrete evidence for EVERY requirement ID. Identify the specific missing implementation when rejecting. Do not infer missing implementation from a formatting or infrastructure failure.",
                          },
                        ]
                      : []),
                  ],
                  subtask.id,
                  "completion-review",
                  completionContinuations,
                  // A tool-protocol failure must not make the one allowed retry
                  // repeat the same incompatible request shape. The retry uses
                  // plain JSON, then the same strict parser and per-requirement
                  // completeness gate below validate its structured response.
                  reviewAttempt === 0
                    ? [completionReviewTool(batch)]
                    : undefined,
                  {
                    requireTool: reviewAttempt === 0,
                    responseFormat:
                      reviewAttempt > 0
                        ? completionReviewResponseFormat(batch)
                        : undefined,
                    // Endpoint support does not imply reasoning can be disabled.
                    reasoningEffort: "low",
                    maxOutputTokens: completionReviewOutputTokens(
                      batch.length,
                      gateway.config.maxOutputTokens,
                      reviewAttempt > 0,
                    ),
                    // Use Gateway's configured stage deadline and remaining
                    // run reserve. An extra 10s cap aborted valid reviews and
                    // discarded their usage receipts before bounded retries.
                  },
                );
              } catch (error) {
                if (
                  reviewAttempt === 0 &&
                  (isTransientProviderError(error) ||
                    /Tool protocol:|No model response|malformed response/i.test(
                      String(error),
                    ))
                ) {
                  // A transport failure contains no evidence that the scout
                  // cannot assess the candidate. Keep its model on the one
                  // bounded retry; reserve stronger review for protocol defects.
                  strongReviewRetry = !isTransientProviderError(error);
                  gateway.logger.log("completion_review_protocol_retry", {
                    subtaskId: subtask.id,
                    retry_reason: strongReviewRetry ? "protocol" : "transport",
                    classification: "OPERATIONAL_FAILURE",
                    from_model: reviewModel,
                    to_model: completionReviewModel(
                      gateway.config.registry,
                      strongReviewRetry,
                      provenToolModel,
                    ),
                  });
                  continue;
                }
                throw error;
              }
              batchReview = parseCompletionReview(
                completionReviewPayload(reviewMessage),
                batch,
              );
            }
            const completeAssessments = batch.every((requirement) =>
              batchReview!.requirements.some(
                (item) =>
                  item.id === requirement.id &&
                  typeof item.satisfied === "boolean" &&
                  !!item.evidence.trim(),
              ),
            );
            const concreteRejection = batchReview.requirements.some(
              (item) => !item.satisfied && !!item.evidence.trim(),
            );
            const verificationContradiction =
              completionReviewContradictsVerification(reviewInput, batchReview);
            if (
              !batchReview.protocolFailure &&
              !verificationContradiction &&
              completeAssessments &&
              typeof batchReview.passed === "boolean" &&
              (batchReview.passed || concreteRejection)
            )
              break;
            if (reviewAttempt === 1)
              throw Error(
                "INFRA_FAILURE: completion reviewer protocol failed after structured retry",
              );
            strongReviewRetry = true;
            gateway.logger.log("completion_review_protocol_retry", {
              subtaskId: subtask.id,
              retry_reason: "protocol",
              classification: "OPERATIONAL_FAILURE",
              from_model: completionReviewModel(
                gateway.config.registry,
                false,
                provenToolModel,
              ),
              to_model: completionReviewModel(
                gateway.config.registry,
                true,
                provenToolModel,
              ),
            });
          }
          if (!batchReview)
            throw Error("INFRA_FAILURE: completion review unavailable");
          batchReviews.push(batchReview);
        }
        completionReview =
          batchReviews.length === 1
            ? batchReviews[0]
            : {
                passed: batchReviews.every((review) => review.passed),
                requirements: batchReviews.flatMap(
                  (review) => review.requirements,
                ),
                summary: batchReviews.map((review) => review.summary).join(" "),
              };
      } catch (error) {
        gateway.logger.log("completion_review_failure", {
          subtaskId: subtask.id,
          classification: "OPERATIONAL_FAILURE",
          error: String(error),
        });
        return {
          verification: verificationResult([
            {
              command: "completion-review",
              exitCode: 1,
              stdout: "",
              stderr: String(error),
              wallClockMs: 0,
              timedOut: false,
              outcome: "INFRA_FAILURE",
              unavailable: "completion_reviewer_protocol",
              requirement: "required",
            },
          ]),
          role,
          evidence,
        };
      }
      completionReview = completionReview!;
      if (cascadeConflict) {
        const visualRequirement =
          requirements.find((item) =>
            /\b(?:visual|visible|background|color|colour|dark|light|cta|hero|synlig|baggrund|farve|mørk|lys|grøn|marineblå)\b/i.test(
              item.text,
            ),
          ) ?? requirements[0];
        if (visualRequirement) {
          completionReview = {
            ...completionReview,
            passed: false,
            requirements: completionReview.requirements.map((item) =>
              item.id === visualRequirement.id
                ? { ...item, satisfied: false, evidence: cascadeConflict }
                : item,
            ),
            summary: cascadeConflict,
          };
          gateway.logger.log("visual_cascade_conflict", {
            subtaskId: subtask.id,
            requirement: visualRequirement.id,
            evidence: cascadeConflict,
          });
        }
      }
      gateway.logger.log("completion_review", {
        independentRequirementProof:
          !!deterministicReview &&
          deterministicReview.passed &&
          completionReview.passed,
        subtaskId: subtask.id,
        method: completionReview.summary.startsWith(
          "Exact localized replacement",
        )
          ? "deterministic_literal_diff"
          : "model",
        passed: completionReview.passed,
        requirements: completionReview.requirements,
        summary: completionReview.summary,
      });
      if (!completionReview.passed) {
        const missing = missingRequirementDiagnostics(
          requirements,
          completionReview,
        );
        const unresolvedRequirementIds = completionReview.requirements
          .filter((item) => !item.satisfied)
          .map((item) => item.id);
        const reviewedModel = model!;
        // Concrete missing work gets one bounded continuation before paying
        // for a quality escalation. Existing budgets still reserve rescue.
        const interruptedCandidate = candidateReadyHandoff && rawResult.exitStatus === "infra_failure";
        // Unknown provider usage consumes the bounded attempt reservation.
        // A partial candidate may still pass verification, but missing work
        // must use reserved recovery rather than reopening the spent leg.
        const sameModelContinuation = !interruptedCandidate && economicalCompletion && model !== executionPlan?.referenceModel && !sameModelCompletionUsed &&
          completionContinuations < maxCompletionContinuations;
        if (sameModelContinuation) {
          sameModelCompletionUsed = true;
          pinnedCompletionModel = model === "openrouter/auto" ? result.model : undefined;
        } else {
          codingAttempts++;
          pinnedCompletionModel = undefined;
        }
        const moved = !sameModelContinuation && await nextPlannedModel({
          failureMode: interruptedCandidate ? "operational" : "verification_failure",
          failurePhase: interruptedCandidate ? "PROVIDER" : "COMPLETION_REVIEW",
          mutationObserved: true,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          wallClockMs: result.wallClockMs,
          terminationReason: interruptedCandidate ? rawResult.terminationReason : "completion_review_rejected",
          codingAttempts,
        });
        if (completionContinuations < (sameModelCompletionUsed ? maxCompletionContinuations : 1)) {
          retainedReviewChanges = candidateFileChanges;
          retainedReviewPaths = candidateReviewPaths;
          completionContinuations++;
          diagnostics = [
            diagnostics,
            "Independent completion review found unresolved requirements. Continue in the current worktree and preserve completed work:\n" +
              missing,
          ]
            .filter(Boolean)
            .join("\n\n");
          previousFailedDiff = diff;
          if (result.engine === "agentic")
            implementationRecovery ??= { reason: "native_completion_repair" };
          completionRepair = {
            unresolvedRequirementIds,
            mutationRequiredBeforeDiscovery: true,
          };
          const repairWritePaths = await evidenceBasedCompletionRepairScope({
            root: path,
            task,
            currentWriteScope: writeScope.paths,
            authorizedReadPaths: subtask.likelyReadPaths,
            repositoryPaths: profile.files,
            reviewerDiagnostics: missing,
          });
          if (repairWritePaths.length > writeScope.paths.length) {
            const added = repairWritePaths.filter(
              (path) => !writeScope.paths.includes(path),
            );
            writeScope = new WriteScope(
              repairWritePaths,
              gateway.logger,
              subtask.id,
            );
            gateway.logger.log("completion_repair_scope_expanded", {
              subtaskId: subtask.id,
              added_paths: added,
              write_scope: writeScope.paths,
            });
          }
          const completionRepairPaths = writeScope.paths.filter(
            (repairPath) => repairPath !== ".",
          );

          context = await compileContext(
            path,
            `${subtask.objective}\n\n${missing}`,
            completionRepairPaths.length
              ? completionRepairPaths
              : context.repoMap.slice(0, 2),
            profile,
            gateway.config.context,
            true,
          );
          gateway.logger.log("completion_continuation", {
            subtaskId: subtask.id,
            continuation: completionContinuations,
            from_model: reviewedModel,
            to_model: moved ? model : reviewedModel,
            escalated: moved,
            unresolved: unresolvedRequirementIds,
            write_scope: writeScope.paths,
          });
          attempt--;
          continue;
        }
        gateway.logger.log("completion_review_exhausted", {
          subtaskId: subtask.id,
          unresolved: completionReview.requirements
            .filter((item) => !item.satisfied)
            .map((item) => item.id),
        });
        return { verification: verificationResult([]), role, evidence };
      }
      completionRepair = undefined;
    }

    if (
      completionReview?.passed === true &&
      (candidateAccepted ||
        finalVerificationHandoff ||
        (result.exitStatus === "completed" &&
          advisoryInfrastructureOnly(attemptVerification)) ||
        (result.exitStatus === "completed" &&
          options.tinyDirect &&
          options.finalVerificationOnly &&
          candidateVerification.status !== "FAILED"))
    ) {
      if (pool) {
        if (attemptTier && attemptTier !== "frontier")
          pool.recordServed(
            features,
            subtask.id,
            eventStart,
            attemptVerification.status,
            attempt > 0,
            undefined,
            fingerprint,
          );
        else
          pool.record(
            selected?.model ?? ({ id: model } as any),
            features,
            subtask.id,
            eventStart,
            attemptVerification.status,
            attempt > 0,
            undefined,
            fingerprint,
          );
      }
      if (!pool || (attemptTier && attemptTier !== "frontier"))
        gateway.logger.log("model_attempt", {
          subtaskId: subtask.id,
          modelRequested: model,
          modelServed: result.model,
          verification: attemptVerification.status,
          escalated: attempt > 0,
          reason:
            attemptVerification.status === "CANDIDATE_NEUTRAL"
              ? "baseline_equivalent_no_regression"
              : attemptVerification.status === "CANDIDATE_IMPROVEMENT"
                ? "baseline_failures_reduced"
                : options.tinyDirect
                  ? "tiny_mutation_complete"
                  : "focused_verification_passed",
        });
      if (
        result.engine !== "aider" &&
        options.tinyDirect &&
        options.finalVerificationOnly
      ) {
        gateway.logger.log("ready_for_final_verification", {
          subtaskId: subtask.id,
          diffBytes: Buffer.byteLength(diff),
          reason: "tiny_mutation_complete",
        });
      }
      return {
        verification: options.finalVerificationOnly
          ? options.stableRepair
            ? candidateVerification
            : verificationResult([])
          : attemptVerification,
        role,
        evidence,
      };
    }
    if (
      result.exitStatus === "failed" &&
      candidateMutation &&
      operationalRetries < maxOperationalRetries
    ) {
      operationalRetries++;
      diagnostics = [
        diagnostics,
        `Continue from the preserved partial mutation after ${result.terminationReason ?? "an operational interruption"}. Complete the remaining task requirements; do not restart finished edits.`,
      ]
        .filter(Boolean)
        .join("\n\n");
      gateway.logger.log("partial_candidate_continuation", {
        subtaskId: subtask.id,
        model,
        changed_paths: result.changedPaths,
        termination_reason: result.terminationReason ?? null,
        continuation: operationalRetries,
      });
      attempt--;
      continue;
    }
    if (infrastructureOnly(attemptVerification))
      return { verification: attemptVerification, role, evidence };
    previousFailedDiff = diff;
    diagnostics = "Repair the concrete failures against the original task contract. Read failing assertions and source together. Newly authored tests can contain incorrect expectations: correct them only with explicit contract evidence. Never weaken pre-existing tests or acceptance requirements. Preserve completed work.\n\n" + relative.checks
      .filter((check) => check.outcome === "CHECK_FAIL")
      .map(
        (check) =>
          `${check.command}\n${[check.stdout, check.stderr].filter(Boolean).join("\n")}`,
      )
      .join("\n");
    const attributable = verificationRegressed(baseline, candidateVerification);
    if (pool && attributable) {
      if (attemptTier && attemptTier !== "frontier")
        pool.recordServed(
          features,
          subtask.id,
          eventStart,
          "FAILED",
          true,
          "focused_verification_failed",
          fingerprint,
        );
      else
        pool.record(
          selected?.model ?? ({ id: model } as any),
          features,
          subtask.id,
          eventStart,
          "FAILED",
          true,
          "focused_verification_failed",
          fingerprint,
        );
    }
    const discoveredRepairPaths =
      (subtask.id === "stable" || subtask.id === "direct") &&
      writeScope.paths.includes(".")
        ? [...new Set(result.changedPaths)]
        : [];
    if (
      result.exitStatus === "completed" &&
      candidateMutation &&
      attributable &&
      !options.stableRepair &&
      !((executionPlan?.authority === "cold-start" || executionPlan?.authority === "openrouter-auto") &&
        executionPlan.approvedCandidateSet.some(candidate => candidate.model.id !== model && !excluded.includes(candidate.model.id))) &&
      !verificationRepairUsed
    ) {
      verificationRepairUsed = true;
      retainedReviewChanges = candidateFileChanges;
      retainedReviewPaths = candidateReviewPaths;
      verificationRepairPending = true;
      verificationFailureBeforeRepair = attemptVerification;
      diagnostics = [
        "Repair only the reported failures against the original task contract. Read the implementation and failing test before deciding what to change. Diagnose each failing assertion as implementation error, newly authored expectation error, or infrastructure; derive the expected result independently from the original contract and legal input. Inspect source and failing assertions together. A newly generated test may have a miscalculated expected result or an out-of-contract input; establish concrete contract evidence before correcting it. Never weaken existing requirements or pre-existing tests. Do not add unrelated edge cases during this repair.",
        `Changed files: ${result.changedPaths.join(", ")}`,
        ...candidateVerification.checks
          .filter((check) => check.outcome === "CHECK_FAIL")
          .map((check) =>
            [`Failing command: ${check.command}`, check.stdout, check.stderr]
              .filter(Boolean)
              .join("\n"),
          ),
      ].join("\n\n");
      // New files and their imports were absent from the original repository
      // profile. Repair must read the candidate and its actual API contracts.
      context = await compileContext(
        path,
        task,
        result.changedPaths,
        {
          ...profile,
          files: [...new Set([...profile.files, ...result.changedPaths])],
        },
        gateway.config.context,
        true,
      );
      previousFailedDiff = diff;
      completionRepair = {
        unresolvedRequirementIds: ["VERIFICATION_REGRESSION"],
        mutationRequiredBeforeDiscovery: false,
      };
      if (discoveredRepairPaths.length) {
        writeScope = new WriteScope(
          discoveredRepairPaths,
          gateway.logger,
          subtask.id,
        );
      }
      gateway.logger.log("verification_repair", {
        subtaskId: subtask.id,
        model,
        changed_paths: result.changedPaths,
        write_scope: writeScope.paths,
        failing_commands: candidateVerification.checks
          .filter((check) => check.outcome === "CHECK_FAIL")
          .map((check) => check.command),
      });
      attempt--;
      continue;
    }
    if (verificationRepairPending) {
      gateway.logger.log("verification_repair_exhausted", {
        subtaskId: subtask.id,
        model,
        reason: "repaired_candidate_failed_verification",
        changed_paths: result.changedPaths,
      });
      return { verification: attemptVerification, role, evidence };
    }
    if (result.exitStatus === "completed" && attributable && candidateMutation) {
      // A failed check is evidence for repair, not evidence that every edit
      // must be discarded. Preserve tests and code across a model switch;
      // the original checkpoint remains available and acceptance is unchanged.
      retainedReviewChanges = candidateFileChanges;
      retainedReviewPaths = candidateReviewPaths;
      if (result.engine === "agentic")
        implementationRecovery ??= { reason: "native_candidate_repair" };
      context = await compileContext(path, task, candidateReviewPaths,
        {...profile, files: [...new Set([...profile.files, ...candidateReviewPaths])]},
        gateway.config.context, true);
      gateway.logger.log("verification_candidate_preserved", {
        subtaskId: subtask.id, model, changed_paths: candidateReviewPaths,
        reason: "continue from failed candidate with authoritative diagnostics",
      });
    } else if (result.exitStatus === "completed") {
      await checkpoint.restore(path, writeScope);
      retainedReviewChanges = [];
      retainedReviewPaths = [];
    } else {
      gateway.logger.log("incomplete_candidate_preserved", {
        subtaskId: subtask.id,
        model,
        exit_status: result.exitStatus,
        termination_reason: result.terminationReason ?? null,
        changed_paths: result.changedPaths,
      });
    }
    if (discoveredRepairPaths.length) {
      writeScope = new WriteScope(
        discoveredRepairPaths,
        gateway.logger,
        subtask.id,
      );
      context = await compileContext(
        path,
        task,
        discoveredRepairPaths,
        profile,
        gateway.config.context,
        true,
      );
      gateway.logger.log("stable_discovery_scope_locked", {
        subtaskId: subtask.id,
        initial_write_scope: ["."],
        actual_changed_paths: discoveredRepairPaths,
        repair_write_scope: discoveredRepairPaths,
        rejected_candidate: true,
      });
    }
    gateway.logger.log(attributable && candidateMutation ? "attempt_repair_handoff" : "attempt_rollback", {
      subtaskId: subtask.id,
      model,
      changedPaths: result.changedPaths,
      reason: attributable
        ? "candidate verification regression"
        : "candidate not verified",
    });
    pinnedCompletionModel = undefined;
    const failedModel = model;
    const failedKind = relative.checks.some(
      (check) =>
        check.outcome === "CHECK_FAIL" &&
        /typecheck|tsc|compile|build/i.test(check.command),
    )
      ? ("compiler_failure" as const)
      : relative.checks.some(
            (check) => check.outcome === "CHECK_FAIL" && check.kind === "test",
          )
        ? ("test_failure" as const)
        : ("verification_failure" as const);
    codingAttempts++;
    const moved =
      codingAttempts < maxPlanAttempts &&
      (await nextPlannedModel({
        failureMode: failedKind,
        failurePhase: "VERIFICATION_ATTEMPTED",
        mutationObserved: true,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        wallClockMs: result.wallClockMs,
        terminationReason: result.terminationReason,
        codingAttempts,
      }));
    if (!pool || (attemptTier && attemptTier !== "frontier") || !attributable)
      gateway.logger.log("model_attempt", {
        subtaskId: subtask.id,
        modelRequested: failedModel,
        modelServed: result.model,
        verification: attributable ? "FAILED" : "NOT_FULLY_VERIFIED",
        escalated: moved,
        reason: attributable
          ? "focused_verification_failed"
          : "candidate_not_verified",
      });
    if (moved)
      gateway.logger.log("model_fallback", {
        subtaskId: subtask.id,
        failedModel,
        selectedModel: model,
        verifiedQualityFailure: attributable,
        reason: attributable
          ? "verified_candidate_regression"
          : "candidate_not_verified",
      });
    if (moved)
      gateway.logger.log("coding_route_escalation", {
        subtaskId: subtask.id,
        from: failedModel,
        to: model,
        reason: attributable
          ? "focused_verification_failed"
          : "candidate_not_verified",
      });
    gateway.logger.log("aider_fallback", {
      subtaskId: subtask.id,
      from: failedModel,
      to: moved ? model : null,
      reason: attributable
        ? "verified_candidate_regression"
        : "candidate_not_verified",
      moved,
    });
    if (!moved) return { verification: attemptVerification, role, evidence };
  }
  gateway.logger.log("execution_plan_exhausted", {
    subtaskId: subtask.id,
    reason: "attempt_limit",
    attempted_models: [...new Set([...excluded, model])],
  });
  return { verification: verificationResult([]), role, evidence };
}

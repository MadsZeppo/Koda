import type { Gateway } from "../openrouter/client.js";
import type { Candidate } from "../router/modelRouter.js";
import type { Role } from "../router/modelRegistry.js";
import type { CodingTier } from "../router/codingDemand.js";
import { codingDemand, nextCodingTier, PARETO_CODE_MODEL } from "../router/codingDemand.js";
import type { Subtask, Plan, EvidencePacket } from "../planner/schemas.js";
import type { CommandResult, RepoProfile, VerificationResult } from "../types.js";
import type { WorkerContext } from "../context/compiler.js";
import { compileContext, isSourcePath, workerReadPaths } from "../context/compiler.js";
import { extractFeatures } from "../router/features.js";
import { taskFingerprint } from "../router/taskFingerprint.js";
import { verificationPlan } from "../verifier/plan.js";
import { objectiveCanBeAlreadySatisfied, workerChecks,
  workerChecksAreTaskSpecific, tinyDocumentationChecks } from "../verifier/selection.js";
import { optionalUnavailableCheck, focusedLocalReproduction,
  recoverPostMutationChecks } from "../verifier/recovery.js";
import { advisoryInfrastructureOnly, verify, verificationAgainstBaseline,
  verificationRegressed, verificationResult } from "../verifier/verifier.js";
import type { StableImplementationHandoff } from "./stable.js";
import type { RepairPacket } from "./repairPacket.js";
import type { CodingWorker } from "./codingWorker.js";
import type { CodingWorkerContext } from "./codingWorker.js";
import { MiniSweWorker } from "./miniSweWorker.js";
import { WriteScope } from "../repo/writeScope.js";
import { AttemptCheckpoint } from "./attemptCheckpoint.js";
import { currentDiff } from "./tools.js";
import { router } from "../router/router.js";
import { taskBucket } from "../router/features.js";
import { tierRank } from "../router/pool.js";
import { testRequirementAlreadyCovered } from "./mutationInvariant.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { attemptLimitPolicy } from "./attemptPolicy.js";

export interface MiniSweImplementationOptions {
  initialRole?: Role;
  evidence?: EvidencePacket;
  compiledContext?: WorkerContext;
  extra?: unknown;
  stop?: () => boolean;
  raceGroup?: string;
  selectedCandidate?: Candidate;
  model?: string;
  finalVerificationOnly?: boolean;
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
  /** Tests inject a deterministic worker; production never supplies this. */
  codingWorker?: CodingWorker;
}

const infrastructureOnly = (result: VerificationResult) => result.checks.some((check) =>
  check.outcome === "INFRA_FAILURE" || check.outcome === "CHECK_UNAVAILABLE") &&
  !result.checks.some((check) => check.outcome === "CHECK_FAIL");

const protocolIncompatibility = (message?: string) =>
  /(?:no endpoints?(?:\s+found)?|unsupported|not support|tool_choice|requested parameters?|protocol|404)/i
    .test(message ?? "");

const roleFor = (candidate?: Candidate): Role => candidate?.model.tier === "frontier"
  ? "FRONTIER_MODEL" : candidate?.model.tier === "strong" ? "STRONG_MODEL" : "CHEAP_CODER_A";

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
  repair: boolean;
}): CodingWorkerContext {
  const paths = new Set([...input.writeScope, ...input.context.localDependencies]);
  const mentioned = (file: { path: string }) =>
    paths.has(file.path) || !!input.diagnostics?.includes(file.path) ||
    input.writeScope.some((scope) => scope !== "." &&
      (file.path === scope || file.path.startsWith(scope.replace(/\/$/, "") + "/")));
  const repairFiles = input.context.files.filter(mentioned);
  const sourceFiles = input.repair
    ? (repairFiles.length ? repairFiles : input.context.files.slice(0, 4))
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
  return {
    localizationSummary: input.localizationSummary ?? input.evidence.likelyRootCause,
    relevantFiles: [...new Set([...sourceFiles.map((file) => file.path),
      ...input.evidence.relevantFiles])],
    sourceFiles,
    completePaths: input.context.completePaths,
    diagnostics: input.diagnostics,
    previousFailedDiff: input.previousFailedDiff,
    evidence: input.repair ? undefined : compactEvidence,
    repairPacket: input.repair ? undefined : input.repairPacket,
  };
}

/** Sole production coding executor. Koda routes/verifies; mini-SWE mutates one isolated attempt. */
export async function implement(
  gateway: Gateway,
  path: string,
  task: string,
  subtask: Subtask,
  plan: Pick<Plan, "acceptanceCriteria"> & Partial<Pick<Plan, "subtasks">>,
  profile: RepoProfile,
  options: MiniSweImplementationOptions = {},
) {
  let writeScope = new WriteScope(subtask.likelyWritePaths, gateway.logger, subtask.id);
  let context = options.compiledContext ?? await compileContext(path, subtask.objective,
    [...writeScope.paths, ...workerReadPaths(subtask, plan.subtasks)], profile,
    gateway.config.context, true);
  const evidence: EvidencePacket = options.evidence ?? {
    relevantFiles: context.files.map((file) => file.path).filter(isSourcePath), symbols: [],
    reproduction: "Koda verification is authoritative", failingTests: [],
    likelyRootCause: "Not established", dependencies: subtask.dependsOn,
    uncertainty: "medium", suggestedApproach: "Inspect, implement, and verify", evidence: [],
  };
  gateway.logger.log("worker_context", { subtaskId: subtask.id,
    context_files: context.files.map((file) => file.path),
    context_bytes: Buffer.byteLength(JSON.stringify(context)),
    context_bytes_initial: Buffer.byteLength(JSON.stringify(context)),
    context_bytes_repeated: 0,
    context_limit_bytes: gateway.config.context.maxBytes });
  gateway.logger.log("worker_scope", { subtaskId: subtask.id,
    allowed_write_paths: writeScope.paths, context_files: context.files.map((file) => file.path) });

  const tinyDocs = options.tinyDirect &&
    subtask.likelyWritePaths.every((file) => /\.(?:md|mdx|txt|rst)$/i.test(file));
  const ambiguousStableFirstPass = subtask.id === "stable" && !options.stableRepair &&
    writeScope.paths.length === 1 && writeScope.paths[0] === ".";
  let commands = options.stableRepair?.failedChecks.map((check) => check.command) ??
    (ambiguousStableFirstPass ? [] : tinyDocs
      ? subtask.likelyWritePaths.flatMap((file) => tinyDocumentationChecks(profile, file))
      : subtask.verificationCommands.length ? subtask.verificationCommands
        : options.finalVerificationOnly
          ? verificationPlan(profile, [...writeScope.paths], true).filter((check) => check.available)
            .map((check) => check.command)
          : workerChecks(subtask, profile, context));
  const profiledCandidates = profile.ecosystem?.projectUnits.flatMap((unit) => unit.verification) ?? [];
  if (!subtask.verificationCommands.length && !options.stableRepair)
    commands = commands.filter((command) => {
      const candidate = profiledCandidates.find((item) => item.command === command);
      return !candidate || !optionalUnavailableCheck(candidate);
    });
  if (tinyDocs && !commands.length && !options.stableRepair)
    commands = verificationPlan(profile, [...writeScope.paths], true)
      .filter((check) => check.available).map((check) => check.command);
  const recovery = !ambiguousStableFirstPass && !tinyDocs && !commands.length && !options.stableRepair
    ? await focusedLocalReproduction(profile, task, subtask.likelyWritePaths) : undefined;
  const recoveredCandidates = recovery ? [recovery] : [];
  let postMutationRecoveryAttempted = false;
  if (recovery) {
    commands = [recovery.command];
    gateway.logger.log("verification_recovery", { subtaskId: subtask.id,
      command: recovery.command, source: recovery.source });
  }
  commands = [...new Set(commands)];
  const candidates = profiledCandidates;
  const runChecks = async (selected: string[], afterMutation = false,
    recoveryPaths: string[] = subtask.likelyWritePaths) => {
    if (afterMutation && !tinyDocs && !selected.length && !postMutationRecoveryAttempted) {
      postMutationRecoveryAttempted = true;
      gateway.logger.log("verification_recovery_attempt", { subtaskId: subtask.id,
        paths: recoveryPaths });
      const discovered = await recoverPostMutationChecks(path, task, recoveryPaths);
      selected = discovered.map((candidate) => candidate.command);
      commands = [...new Set(selected)];
      recoveredCandidates.push(...discovered);
      gateway.logger.log(discovered.length ? "verification_recovery" : "verification_recovery_exhausted", {
        subtaskId: subtask.id, commands: selected,
        source: discovered.map((candidate) => candidate.source),
      });
    }
    if (options.finalVerificationOnly && afterMutation && tinyDocs && !selected.length)
      return verificationResult([]);
    return verify(path, selected,
      () => Math.min(gateway.config.commandTimeoutMs, gateway.budget.remainingMs()),
      (check) => gateway.logger.log("verification", { subtaskId: subtask.id, ...check }),
      writeScope, [...candidates, ...recoveredCandidates].map((candidate) =>
        subtask.verificationCommands.includes(candidate.command)
          ? { ...candidate, requirement: "required" as const } : candidate));
  };
  const infrastructureError = (result: VerificationResult) => {
    const failed = result.checks.find((check) =>
      (check.requirement ?? "required") === "required" &&
      (check.outcome === "INFRA_FAILURE" ||
        (check.outcome === "CHECK_UNAVAILABLE" &&
          check.unavailable !== "unsafe_verification_command")));
    return failed
      ? `${failed.command}: ${failed.unavailable ?? "verification could not execute"}`
      : undefined;
  };
  let baseline = options.stableRepair?.baselineChecks?.length
    ? verificationResult(options.stableRepair.baselineChecks)
    : options.tinyDirect
      ? verificationResult([])
      : commands.length ? await runChecks(commands) : verificationResult([]);
  const initialInfrastructureError = infrastructureError(baseline);
  if (initialInfrastructureError) {
    gateway.logger.log("verification_infrastructure_failure", { subtaskId: subtask.id,
      error: initialInfrastructureError, checks: baseline.checks });
    throw Error(`Verification infrastructure unavailable: ${initialInfrastructureError}`);
  }
  if (infrastructureOnly(baseline))
    return { verification: baseline, role: "CHEAP_CODER_A" as Role, evidence };
  const docChecksAvailable = tinyDocs &&
    subtask.likelyWritePaths.some((file) => tinyDocumentationChecks(profile, file).length);
  if (tinyDocs && commands.length && !docChecksAvailable && !options.stableRepair) {
    const probe = await runChecks(commands);
    const probeInfra = infrastructureError(probe);
    if (probeInfra || infrastructureOnly(probe))
      return { verification: probe, role: "CHEAP_CODER_A" as Role, evidence };
  }

  const lockedTests = await Promise.all(writeScope.paths.filter((file) =>
    /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\./i.test(file)).map(async (file) => ({
      path: file, content: await readFile(join(path, file), "utf8").catch(() => ""),
    })));
  const alreadySatisfied = baseline.status === "VERIFIED_SUCCESS" &&
    ((subtask.id !== "direct" && testRequirementAlreadyCovered(task, lockedTests)) ||
      objectiveCanBeAlreadySatisfied(subtask) &&
      !!profile.ecosystem &&
      workerChecksAreTaskSpecific(subtask, profile, context));
  if (alreadySatisfied) {
    gateway.logger.log("no_changes_required", { subtaskId: subtask.id,
      status: "VERIFIED_SUCCESS", reason: "acceptance_checks_already_pass",
      diffBytes: 0, verificationCommands: baseline.checks.map((check) => check.command) });
    return { verification: baseline, role: "CHEAP_CODER_A" as Role,
      evidence, noChangesRequired: true };
  }

  const features = extractFeatures(subtask, profile,
    Buffer.byteLength(JSON.stringify({ task, context, evidence })), baseline,
    options.stableHandoff ? "stable" :
      gateway.logger.events.findLast((event) => event.type === "execution_strategy")
        ?.execution_strategy ?? (subtask.id === "direct" ? "direct" : "planned"));
  const effort = gateway.logger.events.findLast((event) => event.type === "execution_strategy")
    ?.execution_effort ?? (subtask.estimatedDifficulty === "high" ? "complex"
      : subtask.estimatedDifficulty === "low" ? "tiny" : "normal");
  const fingerprint = taskFingerprint(subtask, profile, features, effort, baseline);
  gateway.logger.log("task_fingerprint", { subtaskId: subtask.id, fingerprint });

  const routingStarted = Date.now();
  const pool = gateway.modelRouter;
  const demand = gateway.config.adaptiveCoding && pool && !gateway.config.forceModel &&
      !gateway.config.specialistRouting && !options.selectedCandidate && !options.model
    ? codingDemand(features, subtask, effort, fingerprint,
        gateway.config.routing.minimumQuality) : undefined;
  const specialistRequested = gateway.config.specialistRouting && pool && !gateway.config.forceModel &&
    !options.selectedCandidate && !options.model;
  const immutableSelector = specialistRequested && typeof (pool as any).selectExecutionPlan === "function";
  const executionPlan = immutableSelector
    ? await pool!.selectExecutionPlan(fingerprint, features, subtask.id,
        gateway.budget.remainingUsd(), options.raceGroup) : undefined;
  // Older injected test doubles expose the V1 array seam. Production always
  // receives the immutable plan object from PoolRouter.
  const legacyCascade = specialistRequested && !immutableSelector
    ? await pool!.selectSpecialist(fingerprint, features, subtask.id,
        gateway.budget.remainingUsd(), options.raceGroup) : [];
  const cascade = [...legacyCascade];
  let cascadeIndex = 0;
  let adaptiveTier: CodingTier | undefined = demand
    ? (options.adaptiveStartTier ?? demand.tier) : undefined;
  let adaptiveAttempt = 0;
  let selected = options.selectedCandidate ?? executionPlan?.initialCandidate ?? cascade[0];
  let role: Role = options.initialRole ?? roleFor(selected);
  if (adaptiveTier === "frontier" && pool)
    selected = await pool.selectFrontierRescue(features, subtask.id);
  let model = adaptiveTier && adaptiveTier !== "frontier" ? PARETO_CODE_MODEL
    : options.model ?? selected?.model.id ?? gateway.config.forceModel;
  if (!model && pool && !adaptiveTier) {
    selected = await pool.select(features, subtask.id, [], undefined, false, options.raceGroup);
    model = selected.model.id; role = roleFor(selected);
  }
  if (adaptiveTier) role = adaptiveTier === "frontier" ? "FRONTIER_MODEL"
    : adaptiveTier === "high" ? "STRONG_MODEL" : "CHEAP_CODER_A";
  model ??= gateway.config.registry[role];
  if (!model) throw Error("No compatible priced model fits the mini-SWE coding attempt");
  gateway.logger.log("coding_route_decision", { subtaskId: subtask.id,
    task_bucket: taskBucket(features), verification_strength: fingerprint.verificationStrength,
    task_risk: fingerprint.difficulty.changeRisk, candidate: model,
    ...(executionPlan ? {
      execution_plan_id: executionPlan.id,
      quality_class: executionPlan.qualityClass,
      evidence_class: executionPlan.evidenceClass,
      conservative_quality: executionPlan.conservativeQuality,
      quality_floor: executionPlan.requiredQuality,
      expected_cost_per_verified_solve: executionPlan.expectedCostPerVerifiedSolve,
      expected_latency: executionPlan.expectedLatencyMs,
      why_selected: executionPlan.whySelected,
    } : {
      quality_floor: selected && "firstAttemptQualityFloor" in selected
        ? (selected as any).firstAttemptQualityFloor
        : demand?.qualityFloor ?? gateway.config.routing.minimumQuality,
    }),
    approved_recovery_candidates: executionPlan
      ? executionPlan.approvedCandidateSet.filter((entry) => entry.model.id !== model)
        .map((entry) => entry.model.id)
      : cascade.slice(1).map((entry) => entry.model.id) });
  gateway.logger.log("latency", { subtaskId: subtask.id,
    routing_selection_ms: Date.now() - routingStarted });
  const excluded: string[] = [];
  const specialistPlan = (!!executionPlan || cascade.length > 0) &&
    !options.selectedCandidate && !options.model;
  let highestQualityTier = selected ? tierRank[selected.model.tier] : 0;
  const usedOperationalFallbacks = new Set<string>();
  const selectCandidate = (next: Candidate) => {
    const rank = tierRank[next.model.tier];
    if (excluded.includes(next.model.id) || rank < highestQualityTier) return false;
    selected = next;
    model = next.model.id;
    role = roleFor(next);
    highestQualityTier = Math.max(highestQualityTier, rank);
    return true;
  };
  const nextPlannedModel = async (observation: {
    failureMode?: "no_mutation" | "verification_failure" | "compiler_failure" |
      "test_failure" | "context_limit" | "token_limit" | "other";
    failurePhase?: string;
    mutationObserved?: boolean;
    inputTokens?: number;
    outputTokens?: number;
    wallClockMs?: number;
    terminationReason?: string;
  } = {}) => {
    if (gateway.config.forceModel) return false;
    if (!excluded.includes(model!)) excluded.push(model!);
    if (executionPlan && pool) {
      const next = pool.selectRecoveryCandidate(executionPlan, {
        failureMode: observation.failureMode ?? "other",
        failurePhase: observation.failurePhase ?? "DISCOVERY",
        previousModel: model!, mutationObserved: observation.mutationObserved ?? false,
        inputTokens: observation.inputTokens, outputTokens: observation.outputTokens,
        wallClockMs: observation.wallClockMs,
        terminationReason: observation.terminationReason,
      }, new Set(excluded));
      return next ? selectCandidate(next) : false;
    }
    if (adaptiveTier) {
      const next = nextCodingTier(adaptiveTier);
      if (!next) return false;
      adaptiveTier = next; adaptiveAttempt++;
      if (next === "frontier") {
        if (!pool) return false;
        selected = await pool.selectFrontierRescue(features, subtask.id).catch(() => undefined);
        if (!selected) return false;
        model = selected.model.id;
      } else {
        selected = undefined; model = PARETO_CODE_MODEL;
      }
      role = next === "frontier" ? "FRONTIER_MODEL"
        : next === "high" ? "STRONG_MODEL" : "CHEAP_CODER_A";
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
        const next = await pool.select(features, subtask.id, excluded, selected?.model, true,
          options.raceGroup);
        return selectCandidate(next);
      } catch { return false; }
    }
    const next = router.escalate(role);
    if (!next || excluded.includes(gateway.config.registry[next])) return false;
    role = next; model = gateway.config.registry[next]; return true;
  };
  const nextOperationalModel = async () => {
    const failedModel = model!;
    if (!excluded.includes(failedModel)) excluded.push(failedModel);
    if (executionPlan && pool) {
      const fallback = pool.selectRecoveryCandidate(executionPlan, {
        failureMode: "operational", failurePhase: "PROVIDER",
        previousModel: failedModel, mutationObserved: false,
      }, new Set(excluded));
      return fallback ? selectCandidate(fallback) : false;
    }
    if (!executionPlan && specialistPlan && pool && !usedOperationalFallbacks.has(failedModel)) {
      usedOperationalFallbacks.add(failedModel);
      try {
        const fallback = await pool.select(features, subtask.id, excluded,
          selected?.model, false, options.raceGroup);
        if (selected && tierRank[fallback.model.tier] === tierRank[selected.model.tier] &&
            selectCandidate(fallback)) return true;
      } catch {}
    }
    // The only remaining transition is the already selected monotonic quality
    // edge. Never ask the generic router to invent another runtime route.
    return nextPlannedModel();
  };

  const worker = options.codingWorker ?? new MiniSweWorker(gateway.budget, gateway.logger);
  let diagnostics = options.stableRepair?.failedChecks.map((check) =>
    `${check.command}\n${check.stderr || check.stdout}`).join("\n");
  let previousFailedDiff = options.stableRepair?.failedDiff;
  let tinyNoMutationAttempts = 0;
  const maxPlanAttempts = specialistPlan
    ? executionPlan?.maxCodingAttempts ?? Math.min(gateway.config.maxIterations,
        cascade.length + 1)
    : Math.max(1, gateway.config.maxIterations);
  for (let attempt = 0; attempt < maxPlanAttempts; attempt++) {
    if (options.stop?.()) throw Error("Speculative attempt superseded");
    const checkpoint = await AttemptCheckpoint.capture(path, writeScope);
    const remaining = gateway.budget.remainingUsd();
    if (remaining <= 0 || gateway.budget.remainingTokens() <= 0 ||
        gateway.budget.remainingMs() <= 1) {
      gateway.logger.log("execution_plan_exhausted", { subtaskId: subtask.id,
        reason: "run_budget_exhausted", attempted_models: excluded });
      return { verification: verificationResult([]), role, evidence };
    }
    const forecast = selected && "expectedAttemptCost" in selected
      ? Number((selected as any).expectedAttemptCost) : remaining / 2;
    const conservative = selected && "conservativeAttemptCost" in selected
      ? Number((selected as any).conservativeAttemptCost) : undefined;
    const reservation = selected && "reservationCost" in selected
      ? Number((selected as any).reservationCost) : undefined;
    const plannedAttemptCost = finite(conservative) ? conservative
      : finite(reservation) ? reservation : finite(forecast) ? forecast * 2 : remaining;
    const learnedTokenBound = selected && "tokenEfficiency" in selected
      ? Number((selected as any).tokenEfficiency?.p90TotalTokens) : undefined;
    const workerTask = [...new Set([task, subtask.objective, ...plan.acceptanceCriteria]
      .filter((value): value is string => !!value))].join("\n\n");
    const workerContext = codingContextPacket({ context, evidence,
      writeScope: writeScope.paths, diagnostics, previousFailedDiff,
      localizationSummary: options.stableHandoff?.requiredChange,
      repairPacket: options.repairPacket,
      // Operational/no-mutation recovery starts a different worker and still
      // needs the grounded packet. Only a real failed candidate diff/check is
      // a compact repair handoff.
      repair: !!diagnostics || !!previousFailedDiff });
    const limits = attemptLimitPolicy({ fingerprint, effort,
      promptBytes: Buffer.byteLength(JSON.stringify({ task: workerTask,
        context: workerContext })) + 1024,
      maxIterations: gateway.config.maxIterations,
      maxOutputTokens: gateway.config.maxOutputTokens,
      learnedP90Tokens: finite(learnedTokenBound) ? Math.ceil(learnedTokenBound) : undefined,
      remainingTokens: gateway.budget.remainingTokens(),
      stageMaxTokens: gateway.config.stageMaxTokens,
      plannedBudgetUsd: plannedAttemptCost,
      remainingUsd: remaining,
      stageMaxUsd: gateway.config.stageMaxUsd,
      promptPricePerMillion: selected?.metadata.inputPrice,
      completionPricePerMillion: selected?.metadata.outputPrice,
      remainingMs: Math.max(1, gateway.budget.remainingMs() -
        gateway.config.phaseBudget.verificationReserveMs),
      configuredTimeoutMs: gateway.config.codingAttemptTimeoutMs });
    if (!limits.viable) {
      const skippedModel = model;
      gateway.logger.log("coding_attempt_non_viable", { subtaskId: subtask.id,
        model: skippedModel, limit_kind: limits.nonViableLimitKind,
        required_tokens: limits.minimumViableTokens,
        available_tokens: Math.min(gateway.budget.remainingTokens(), gateway.config.stageMaxTokens),
        required_cost_usd: limits.minimumViableCostUsd ?? null,
        available_cost_usd: Math.min(remaining, gateway.config.stageMaxUsd),
        required_steps: limits.viableCalls, available_steps: limits.maxSteps,
        required_timeout_ms: limits.localized ? 10_000 : limits.complex ? 30_000 : 20_000,
        available_timeout_ms: limits.timeoutMs });
      const moved = await nextPlannedModel({ failureMode: "other",
        failurePhase: "BEFORE_EXECUTION", terminationReason: limits.nonViableLimitKind });
      gateway.logger.log("model_attempt", { subtaskId: subtask.id,
        modelRequested: skippedModel, modelServed: null,
        verification: "NOT_FULLY_VERIFIED", escalated: moved,
        reason: `non_viable_attempt:${limits.nonViableLimitKind}` });
      if (moved) continue;
      gateway.logger.log("execution_plan_exhausted", { subtaskId: subtask.id,
        reason: `non_viable_attempt:${limits.nonViableLimitKind}`,
        attempted_models: excluded.concat(skippedModel) });
      return { verification: verificationResult([]), role, evidence };
    }
    const attemptBudget = limits.budgetUsd;
    const attemptTokenBound = limits.maxTokens;
    const attemptSteps = limits.maxSteps;
    const attemptTimeoutMs = limits.timeoutMs;
    const eventStart = gateway.logger.events.length;
    const attemptTier = adaptiveTier;
    gateway.logger.log("coding_worker_start", { subtaskId: subtask.id,
      worker_engine: "mini-swe-agent", model, worktree: path,
      assigned_write_scope: writeScope.paths, attempt_budget_usd: attemptBudget,
      attempt_token_limit: attemptTokenBound, configured_token_limit: attemptTokenBound,
      attempt_step_limit: attemptSteps,
      attempt_timeout_ms: attemptTimeoutMs,
      context_bytes_initial: attempt === 0 ? Buffer.byteLength(JSON.stringify(workerContext)) : 0,
      context_bytes_repeated: attempt === 0 ? 0 : Buffer.byteLength(JSON.stringify(workerContext)) });
    const workerStarted = Date.now();
    const result = await worker.run({ repoPath: path, attemptId: subtask.id,
      task: workerTask,
      model, budgetUsd: attemptBudget,
      maxTokens: attemptTokenBound,
      maxSteps: attemptSteps,
      timeoutMs: attemptTimeoutMs,
      requestTimeoutMs: gateway.config.modelTimeoutMs.implementation,
      commandTimeoutMs: gateway.config.commandTimeoutMs,
      maxOutputTokens: gateway.config.maxOutputTokens, baseUrl: gateway.config.baseUrl,
      sessionId: `${gateway.logger.runId}/${subtask.id}/${model}`,
      maxToolOutputBytes: gateway.config.context.toolResultBytes,
      contextWindowTokens: selected?.metadata.contextLength,
      promptPricePerMillion: selected?.metadata.inputPrice,
      completionPricePerMillion: selected?.metadata.outputPrice,
      codingRoute: attemptTier && attemptTier !== "frontier" ? {
        tier: attemptTier, reason: demand?.reason ?? "Adaptive coding", attempt: adaptiveAttempt,
      } : undefined,
      writeScope: [...writeScope.paths],
      returnOnMutation: limits.localized && writeScope.paths.length === 1 &&
        writeScope.paths[0] !== ".",
      directFullScope: subtask.id === "stable" && !subtask.parallelSafe &&
        writeScope.paths.length === 1 && writeScope.paths[0] === ".",
      context: workerContext });
    gateway.logger.log("latency", { subtaskId: subtask.id,
      coding_worker_ms: Date.now() - workerStarted });
    gateway.logger.log("coding_worker_stop", { subtaskId: subtask.id,
      worker_engine: result.engine, mini_swe_version: result.engineVersion,
      model: result.model, worktree: path, assigned_write_scope: writeScope.paths,
      actual_changed_paths: result.changedPaths, trajectory_path: result.trajectoryPath,
      input_tokens: result.inputTokens, output_tokens: result.outputTokens,
      cached_input_tokens: result.cachedInputTokens ?? 0,
      uncached_input_tokens: Math.max(0, (result.inputTokens ?? 0) - (result.cachedInputTokens ?? 0)),
      time_to_first_mutation_ms: result.timeToFirstMutationMs ?? null,
      cost_usd: result.costUsd, wall_time_ms: result.wallClockMs,
      termination_reason: result.terminationReason, exit_status: result.exitStatus,
      limit_kind: result.limitKind ?? null, progress_phase: result.progressPhase ?? null,
      configured_token_limit: result.configuredTokenLimit ?? attemptTokenBound,
      consumed_tokens: result.consumedTokens ??
        ((result.inputTokens ?? 0) + (result.outputTokens ?? 0)),
      remaining_tokens: result.remainingTokens ?? Math.max(0, attemptTokenBound -
        ((result.inputTokens ?? 0) + (result.outputTokens ?? 0))),
      exact_limit_fired: result.exactLimitFired ?? result.limitKind ?? null,
      steps: result.steps ?? null,
      error: result.fatalError });
    if (result.inputTokens !== undefined || result.outputTokens !== undefined ||
        result.costUsd !== undefined) {
      gateway.logger.log("attempt_prediction_error", { subtaskId: subtask.id,
        model, classification: "efficiency_observation",
        predicted_tokens: finite(learnedTokenBound) ? learnedTokenBound : null,
        actual_tokens: (result.inputTokens ?? 0) + (result.outputTokens ?? 0),
        predicted_cost_usd: finite(forecast) ? forecast : null,
        actual_cost_usd: result.costUsd ?? null,
        termination_reason: result.terminationReason ?? null,
        limit_kind: result.limitKind ?? null,
        affects_coding_quality: false });
    }
    const workerAlreadyLoggedCall = gateway.logger.events.slice(eventStart).some((event) =>
      event.type === "model_call" && event.subtaskId === subtask.id &&
      event.modelRequested === model && event.stage === "implement");
    if (!workerAlreadyLoggedCall && result.inputTokens !== undefined &&
        result.outputTokens !== undefined) {
      gateway.logger.log("model_call", { subtaskId: subtask.id, role,
        modelRequested: model, modelReturned: result.model, stage: "implement",
        promptTokens: result.inputTokens, completionTokens: result.outputTokens,
        costUsd: result.costUsd ?? null, wallClockMs: result.wallClockMs,
        cachedTokens: result.cachedInputTokens ?? 0,
        cacheWriteTokens: result.cacheWriteTokens ?? 0, workerEngine: result.engine });
    }
    if (result.exitStatus === "infra_failure" && result.terminationReason === "budget_exhausted") {
      await checkpoint.restore(path, writeScope);
      gateway.logger.log("model_attempt", { subtaskId: subtask.id,
        modelRequested: model, modelServed: null,
        verification: "NOT_FULLY_VERIFIED", escalated: false,
        reason: `execution budget exhausted: ${result.fatalError ?? "bounded reservation unavailable"}` });
      gateway.logger.log("execution_plan_exhausted", { subtaskId: subtask.id,
        reason: "run_budget_exhausted", attempted_models: excluded.concat(model) });
      return { verification: verificationResult([]), role, evidence };
    }
    if (result.exitStatus === "infra_failure") {
      pool?.history.recordOperation({ type: "operational_call",
        timestamp: new Date().toISOString(), runId: gateway.logger.runId,
        subtaskId: subtask.id, stage: "implement", taskBucket: taskBucket(features),
        modelRequested: model, modelServed: null, provider: "mini-swe-agent",
        wallClockMs: result.wallClockMs, outcome: "error", costUsd: result.costUsd ?? null,
        classification: "OPERATIONAL_FAILURE" });
      await checkpoint.restore(path, writeScope);
      const failedModel = model;
      let moved = false;
      // Pareto is a virtual OpenRouter route. If its selected endpoint cannot
      // execute the required tool protocol, retry through Koda's compatible
      // catalog instead of raising the task's requested quality tier.
      if (adaptiveTier && pool && protocolIncompatibility(result.fatalError)) {
        excluded.push(failedModel);
        adaptiveTier = undefined;
        try {
          selected = await pool.select(features, subtask.id, excluded, undefined, false,
            options.raceGroup);
          model = selected.model.id;
          role = roleFor(selected);
          moved = true;
        } catch { moved = false; }
      } else moved = await nextOperationalModel();
      gateway.logger.log("model_attempt", { subtaskId: subtask.id,
        modelRequested: failedModel, modelServed: null,
        verification: "OPERATIONAL_FAILURE", escalated: moved,
        reason: `mini-SWE infrastructure fallback ${moved ? "succeeded" : "exhausted"}: ${result.fatalError ?? result.terminationReason}` });
      gateway.logger.log("mini_swe_fallback", { subtaskId: subtask.id,
        from: failedModel, to: moved ? model : null, reason: "operational_failure", moved });
      if (moved) continue;
      return { verification: verificationResult([{
        command: "mini-swe-agent", cwd: ".", exitCode: 1, stdout: "",
        stderr: result.fatalError ?? "mini-SWE infrastructure failure",
        wallClockMs: result.wallClockMs, timedOut: false,
        outcome: "INFRA_FAILURE", unavailable: "worker_infrastructure_unavailable",
        source: "mini-swe-agent", kind: "test", requirement: "required",
      }]), role, evidence };
    }
    const diffStarted = Date.now();
    const diff = await currentDiff(path);
    gateway.logger.log("latency", { subtaskId: subtask.id,
      candidate_diff_ms: Date.now() - diffStarted });
    const candidateMutation = result.changedPaths.length > 0 && !!diff.trim();
    if (result.limitKind && !candidateMutation) {
      await checkpoint.restore(path, writeScope);
      const limitedModel = model;
      const moved = await nextPlannedModel({
        failureMode: result.limitKind === "context_limit" ? "context_limit"
          : result.limitKind === "token_limit" || result.limitKind === "token_preflight"
            ? "token_limit" : "other",
        failurePhase: result.progressPhase ?? "DISCOVERY",
        mutationObserved: false, inputTokens: result.inputTokens,
        outputTokens: result.outputTokens, wallClockMs: result.wallClockMs,
        terminationReason: result.terminationReason,
      });
      gateway.logger.log("model_attempt", { subtaskId: subtask.id,
        modelRequested: limitedModel, modelServed: result.model,
        verification: "NOT_FULLY_VERIFIED", escalated: moved,
        reason: `execution_limit:${result.limitKind}:${result.progressPhase ?? "DISCOVERY"}` });
      gateway.logger.log("mini_swe_fallback", { subtaskId: subtask.id,
        from: limitedModel, to: moved ? model : null,
        reason: `execution_limit:${result.limitKind}`, moved });
      if (moved) continue;
      gateway.logger.log("execution_plan_exhausted", { subtaskId: subtask.id,
        reason: `execution_limit:${result.limitKind}`,
        attempted_models: excluded.concat(limitedModel) });
      return { verification: verificationResult([]), role, evidence };
    }
    if (result.limitKind && candidateMutation)
      gateway.logger.log("execution_limit_candidate_preserved", { subtaskId: subtask.id,
        model, limit_kind: result.limitKind, progress_phase: result.progressPhase,
        changed_paths: result.changedPaths });
    if (!result.changedPaths.length || !diff.trim()) {
      await checkpoint.restore(path, writeScope);
      const failedModel = model;
      const failedRole = role;
      if (options.tinyDirect) {
        tinyNoMutationAttempts++;
        if (!adaptiveTier && tinyNoMutationAttempts >= 2)
          throw Error("Tiny direct task produced no mutation after bounded recovery");
      }
      const moved = options.tinyDirect && !adaptiveTier ? false : await nextPlannedModel({
        failureMode: "no_mutation", failurePhase: result.progressPhase ?? "DISCOVERY",
        mutationObserved: false, inputTokens: result.inputTokens,
        outputTokens: result.outputTokens, wallClockMs: result.wallClockMs,
        terminationReason: result.terminationReason,
      });
      gateway.logger.log("model_attempt", { subtaskId: subtask.id,
        modelRequested: failedModel, modelServed: result.model,
        verification: "NOT_FULLY_VERIFIED", escalated: moved,
        reason: "no_mutation" });
      if (moved) {
        gateway.logger.log("escalation", { subtaskId: subtask.id,
          from: failedRole, to: role, fromModel: failedModel, toModel: model,
          reason: "mini-SWE completed without a candidate diff" });
        gateway.logger.log("coding_route_escalation", { subtaskId: subtask.id,
          from: failedModel, to: model, from_role: failedRole, to_role: role,
          reason: "no_mutation" });
        continue;
      }
      if (options.tinyDirect && !adaptiveTier) {
        if (tinyNoMutationAttempts < 2) continue;
        throw Error("Tiny direct task produced no mutation after bounded recovery");
      }
      gateway.logger.log("execution_plan_exhausted", { subtaskId: subtask.id,
        reason: "no_mutation", attempted_models: excluded.concat(failedModel) });
      return { verification: verificationResult([]), role, evidence };
    }
    if (options.tinyDirect && options.finalVerificationOnly) {
      gateway.logger.log("ready_for_final_verification", { subtaskId: subtask.id,
        diffBytes: Buffer.byteLength(diff), reason: "tiny_mutation_complete" });
      if (pool) {
        if (attemptTier && attemptTier !== "frontier")
          pool.recordServed(features, subtask.id, eventStart, "VERIFIED_SUCCESS",
            attempt > 0, undefined, fingerprint);
        else pool.record(selected?.model ?? ({ id: model } as any), features, subtask.id,
          eventStart, "VERIFIED_SUCCESS", attempt > 0, undefined, fingerprint);
      }
      gateway.logger.log("model_attempt", { subtaskId: subtask.id,
        modelRequested: model, modelServed: result.model,
        verification: "VERIFIED_SUCCESS", escalated: attempt > 0,
        reason: "tiny_mutation_complete" });
      return { verification: verificationResult([]), role, evidence };
    }
    let postCommands = commands;
    if (tinyDocs)
      postCommands = [...new Set(subtask.likelyWritePaths.flatMap((file) =>
        tinyDocumentationChecks(profile, file)))];
    const verificationStarted = Date.now();
    const candidateVerification = await runChecks(postCommands, true, result.changedPaths);
    gateway.logger.log("latency", { subtaskId: subtask.id,
      focused_verification_ms: Date.now() - verificationStarted });

    // Ambiguous Stable intentionally does not run a broad suite before coding.
    // Once the exact changed paths identify a focused command, evaluate that
    // command against the pre-attempt state and then restore the candidate.
    if (ambiguousStableFirstPass && !baseline.checks.length && commands.length) {
      const candidateState = await AttemptCheckpoint.capture(path, writeScope);
      await checkpoint.restore(path, writeScope);
      baseline = await runChecks(commands);
      await candidateState.restore(path, writeScope);
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

    const relative = verificationAgainstBaseline(baseline, candidateVerification);
    gateway.logger.log("mini_swe_attempt_verification", { subtaskId: subtask.id,
      worker_engine: result.engine, model, outcome: relative.status,
      changed_paths: result.changedPaths, trajectory_path: result.trajectoryPath });
    if (relative.status === "VERIFIED_SUCCESS" || advisoryInfrastructureOnly(relative) ||
        (options.tinyDirect && options.finalVerificationOnly &&
          candidateVerification.status !== "FAILED")) {
      if (pool) {
        if (attemptTier && attemptTier !== "frontier")
          pool.recordServed(features, subtask.id, eventStart, "VERIFIED_SUCCESS",
            attempt > 0, undefined, fingerprint);
        else pool.record(selected?.model ?? ({ id: model } as any), features, subtask.id,
          eventStart, "VERIFIED_SUCCESS", attempt > 0, undefined, fingerprint);
      }
      if (!pool || attemptTier && attemptTier !== "frontier")
        gateway.logger.log("model_attempt", { subtaskId: subtask.id,
          modelRequested: model, modelServed: result.model,
          verification: "VERIFIED_SUCCESS", escalated: attempt > 0,
          reason: options.tinyDirect ? "tiny_mutation_complete" : "focused_verification_passed" });
      if (options.tinyDirect && options.finalVerificationOnly) {
        gateway.logger.log("ready_for_final_verification", { subtaskId: subtask.id,
          diffBytes: Buffer.byteLength(diff), reason: "tiny_mutation_complete" });
      }
      return { verification: options.finalVerificationOnly ? verificationResult([]) : relative,
        role, evidence };
    }
    if (infrastructureOnly(relative))
      return { verification: relative, role, evidence };
    previousFailedDiff = diff;
    diagnostics = relative.checks.filter((check) => check.outcome === "CHECK_FAIL")
      .map((check) => `${check.command}\n${check.stderr || check.stdout}`).join("\n");
    const attributable = verificationRegressed(baseline, candidateVerification);
    if (pool && attributable) {
      if (attemptTier && attemptTier !== "frontier")
        pool.recordServed(features, subtask.id, eventStart, "FAILED", true,
          "focused_verification_failed", fingerprint);
      else pool.record(selected?.model ?? ({ id: model } as any), features,
        subtask.id, eventStart, "FAILED", true, "focused_verification_failed", fingerprint);
    }
    const discoveredRepairPaths = subtask.id === "stable" && writeScope.paths.includes(".")
      ? [...new Set(result.changedPaths)] : [];
    await checkpoint.restore(path, writeScope);
    if (discoveredRepairPaths.length) {
      writeScope = new WriteScope(discoveredRepairPaths, gateway.logger, subtask.id);
      context = await compileContext(path, task, discoveredRepairPaths, profile,
        gateway.config.context, true);
      gateway.logger.log("stable_discovery_scope_locked", { subtaskId: subtask.id,
        initial_write_scope: ["."], actual_changed_paths: discoveredRepairPaths,
        repair_write_scope: discoveredRepairPaths, rejected_candidate: true });
    }
    gateway.logger.log("attempt_rollback", { subtaskId: subtask.id, model,
      changedPaths: result.changedPaths, reason: attributable
        ? "candidate verification regression" : "candidate not verified" });
    const failedModel = model;
    const failedKind = relative.checks.some((check) =>
      /typecheck|tsc|compile|build/i.test(check.command)) ? "compiler_failure" as const
      : relative.checks.some((check) => check.kind === "test") ? "test_failure" as const
        : "verification_failure" as const;
    const moved = await nextPlannedModel({ failureMode: failedKind,
      failurePhase: "VERIFICATION_ATTEMPTED", mutationObserved: true,
      inputTokens: result.inputTokens, outputTokens: result.outputTokens,
      wallClockMs: result.wallClockMs, terminationReason: result.terminationReason });
    if (!pool || attemptTier && attemptTier !== "frontier" || !attributable)
      gateway.logger.log("model_attempt", { subtaskId: subtask.id,
        modelRequested: failedModel, modelServed: result.model,
        verification: attributable ? "FAILED" : "NOT_FULLY_VERIFIED",
        escalated: moved, reason: attributable
          ? "focused_verification_failed" : "candidate_not_verified" });
    if (moved) gateway.logger.log("model_fallback", { subtaskId: subtask.id,
      failedModel, selectedModel: model, verifiedQualityFailure: attributable,
      reason: attributable ? "verified_candidate_regression" : "candidate_not_verified" });
    if (moved) gateway.logger.log("coding_route_escalation", { subtaskId: subtask.id,
      from: failedModel, to: model, reason: attributable
        ? "focused_verification_failed" : "candidate_not_verified" });
    gateway.logger.log("mini_swe_fallback", { subtaskId: subtask.id,
      from: failedModel, to: moved ? model : null,
      reason: attributable ? "verified_candidate_regression" : "candidate_not_verified", moved });
    if (!moved) return { verification: relative, role, evidence };
  }
  gateway.logger.log("execution_plan_exhausted", { subtaskId: subtask.id,
    reason: "attempt_limit", attempted_models: excluded.concat(model) });
  return { verification: verificationResult([]), role, evidence };
}

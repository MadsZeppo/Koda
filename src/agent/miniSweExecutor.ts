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
  workerChecksAreTaskSpecific } from "../verifier/selection.js";
import { recoverPostMutationChecks } from "../verifier/recovery.js";
import { advisoryInfrastructureOnly, verify, verificationAgainstBaseline,
  verificationRegressed, verificationResult } from "../verifier/verifier.js";
import type { StableImplementationHandoff } from "./stable.js";
import type { RepairPacket } from "./repairPacket.js";
import type { CodingWorker } from "./codingWorker.js";
import { MiniSweWorker } from "./miniSweWorker.js";
import { WriteScope } from "../repo/writeScope.js";
import { AttemptCheckpoint } from "./attemptCheckpoint.js";
import { currentDiff } from "./tools.js";
import { router } from "../router/router.js";
import { taskBucket } from "../router/features.js";
import { testRequirementAlreadyCovered } from "./mutationInvariant.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

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
  /(?:no endpoints?|unsupported|not support|tool_choice|requested parameters?|protocol)/i
    .test(message ?? "");

const roleFor = (candidate?: Candidate): Role => candidate?.model.tier === "frontier"
  ? "FRONTIER_MODEL" : candidate?.model.tier === "strong" ? "STRONG_MODEL" : "CHEAP_CODER_A";

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
  const writeScope = new WriteScope(subtask.likelyWritePaths, gateway.logger, subtask.id);
  const context = options.compiledContext ?? await compileContext(path, subtask.objective,
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
    context_limit_bytes: gateway.config.context.maxBytes });
  gateway.logger.log("worker_scope", { subtaskId: subtask.id,
    allowed_write_paths: writeScope.paths, context_files: context.files.map((file) => file.path) });

  let commands = options.stableRepair?.failedChecks.map((check) => check.command) ??
    (subtask.verificationCommands.length ? subtask.verificationCommands
      : options.finalVerificationOnly
        ? verificationPlan(profile, [...writeScope.paths], true).filter((check) => check.available)
          .map((check) => check.command)
        : workerChecks(subtask, profile, context));
  commands = [...new Set(commands)];
  const candidates = profile.ecosystem?.projectUnits.flatMap((unit) => unit.verification) ?? [];
  const runChecks = (selected: string[]) => verify(path, selected,
    () => Math.min(gateway.config.commandTimeoutMs, gateway.budget.remainingMs()),
    (check) => gateway.logger.log("verification", { subtaskId: subtask.id, ...check }),
    writeScope, candidates.map((candidate) =>
      subtask.verificationCommands.includes(candidate.command)
        ? { ...candidate, requirement: "required" as const } : candidate));
  const baseline = options.stableRepair?.baselineChecks?.length
    ? verificationResult(options.stableRepair.baselineChecks)
    : commands.length ? await runChecks(commands) : verificationResult([]);
  if (infrastructureOnly(baseline))
    return { verification: baseline, role: "CHEAP_CODER_A" as Role, evidence };

  const lockedTests = await Promise.all(writeScope.paths.filter((file) =>
    /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\./i.test(file)).map(async (file) => ({
      path: file, content: await readFile(join(path, file), "utf8").catch(() => ""),
    })));
  const alreadySatisfied = baseline.status === "VERIFIED_SUCCESS" &&
    (testRequirementAlreadyCovered(task, lockedTests) ||
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

  const pool = gateway.modelRouter;
  const demand = gateway.config.adaptiveCoding && pool && !gateway.config.forceModel &&
      !gateway.config.specialistRouting && !options.selectedCandidate && !options.model
    ? codingDemand(features, subtask, effort, fingerprint,
        gateway.config.routing.minimumQuality) : undefined;
  const cascade = gateway.config.specialistRouting && pool && !gateway.config.forceModel &&
      !options.selectedCandidate && !options.model
    ? await pool.selectSpecialist(fingerprint, features, subtask.id,
        gateway.budget.remainingUsd(), options.raceGroup) : [];
  let cascadeIndex = 0;
  let adaptiveTier: CodingTier | undefined = demand
    ? (options.adaptiveStartTier ?? demand.tier) : undefined;
  let adaptiveAttempt = 0;
  let selected = options.selectedCandidate ?? cascade[0];
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
    estimated_success: selected?.quality ?? null,
    estimated_attempt_cost: selected?.cost ?? null,
    estimated_total_cost: selected && "expectedCompletionCost" in selected
      ? (selected as any).expectedCompletionCost : null,
    quality_floor: selected && "firstAttemptQualityFloor" in selected
      ? (selected as any).firstAttemptQualityFloor
      : demand?.qualityFloor ?? gateway.config.routing.minimumQuality,
    evidence_source: selected && "evidence" in selected
      ? (selected as any).evidence?.map((entry: any) => entry.source) ?? [] : ["pareto_fallback"],
    fallback: cascade.slice(1).map((entry) => entry.model.id) });
  const excluded: string[] = [];
  const nextModel = async () => {
    if (gateway.config.forceModel) return false;
    excluded.push(model!);
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
      if (!excluded.includes(next.model.id)) {
        selected = next; model = next.model.id; role = roleFor(next); return true;
      }
    }
    if (pool) {
      try {
        selected = await pool.select(features, subtask.id, excluded, selected?.model, true,
          options.raceGroup);
        model = selected.model.id; role = roleFor(selected); return true;
      } catch { return false; }
    }
    const next = router.escalate(role);
    if (!next || excluded.includes(gateway.config.registry[next])) return false;
    role = next; model = gateway.config.registry[next]; return true;
  };

  const worker = options.codingWorker ?? new MiniSweWorker(gateway.budget, gateway.logger);
  let diagnostics = options.stableRepair?.failedChecks.map((check) =>
    `${check.command}\n${check.stderr || check.stdout}`).join("\n");
  let previousFailedDiff = options.stableRepair?.failedDiff;
  for (let attempt = 0; attempt < Math.max(1, gateway.config.maxIterations); attempt++) {
    if (options.stop?.()) throw Error("Speculative attempt superseded");
    const checkpoint = await AttemptCheckpoint.capture(path, writeScope);
    const remaining = gateway.budget.remainingUsd();
    if (remaining <= 0) throw Error("Run budget exhausted");
    const forecast = selected && "expectedAttemptCost" in selected
      ? Number((selected as any).expectedAttemptCost) : remaining / 2;
    const attemptBudget = Math.min(remaining,
      Math.max(0.005, Math.min(gateway.config.stageMaxUsd, forecast * 2)));
    const eventStart = gateway.logger.events.length;
    const attemptTier = adaptiveTier;
    gateway.logger.log("coding_worker_start", { subtaskId: subtask.id,
      worker_engine: "mini-swe-agent", model, worktree: path,
      assigned_write_scope: writeScope.paths, attempt_budget_usd: attemptBudget });
    const result = await worker.run({ repoPath: path, attemptId: subtask.id,
      task: [...new Set([task, subtask.objective, ...plan.acceptanceCriteria]
        .filter((value): value is string => !!value))].join("\n\n"),
      model, budgetUsd: attemptBudget,
      maxTokens: Math.min(gateway.budget.remainingTokens(), gateway.config.stageMaxTokens),
      maxSteps: gateway.config.maxIterations,
      timeoutMs: Math.max(1, gateway.budget.remainingMs() - gateway.config.phaseBudget.verificationReserveMs),
      commandTimeoutMs: gateway.config.commandTimeoutMs,
      maxOutputTokens: gateway.config.maxOutputTokens, baseUrl: gateway.config.baseUrl,
      codingRoute: attemptTier && attemptTier !== "frontier" ? {
        tier: attemptTier, reason: demand?.reason ?? "Adaptive coding", attempt: adaptiveAttempt,
      } : undefined,
      writeScope: [...writeScope.paths], context: {
        localizationSummary: options.stableHandoff?.requiredChange ?? evidence.likelyRootCause,
        relevantFiles: [...new Set([...context.files.map((file) => file.path), ...evidence.relevantFiles])],
        sourceFiles: context.files,
        completePaths: context.completePaths,
        diagnostics, previousFailedDiff, evidence,
      } });
    gateway.logger.log("coding_worker_stop", { subtaskId: subtask.id,
      worker_engine: result.engine, mini_swe_version: result.engineVersion,
      model: result.model, worktree: path, assigned_write_scope: writeScope.paths,
      actual_changed_paths: result.changedPaths, trajectory_path: result.trajectoryPath,
      input_tokens: result.inputTokens, output_tokens: result.outputTokens,
      cost_usd: result.costUsd, wall_time_ms: result.wallClockMs,
      termination_reason: result.terminationReason, exit_status: result.exitStatus,
      error: result.fatalError });
    const workerAlreadyLoggedCall = gateway.logger.events.slice(eventStart).some((event) =>
      event.type === "model_call" && event.subtaskId === subtask.id &&
      event.modelRequested === model && event.stage === "implement");
    if (!workerAlreadyLoggedCall && result.inputTokens !== undefined &&
        result.outputTokens !== undefined) {
      gateway.logger.log("model_call", { subtaskId: subtask.id, role,
        modelRequested: model, modelReturned: result.model, stage: "implement",
        promptTokens: result.inputTokens, completionTokens: result.outputTokens,
        costUsd: result.costUsd ?? null, wallClockMs: result.wallClockMs,
        cachedTokens: 0, cacheWriteTokens: 0, workerEngine: result.engine });
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
      } else moved = await nextModel();
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
    const diff = await currentDiff(path);
    if (!result.changedPaths.length || !diff.trim()) {
      await checkpoint.restore(path, writeScope);
      const failedModel = model;
      const failedRole = role;
      const moved = await nextModel();
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
      throw Error("mini-SWE attempt completed without a candidate diff");
    }
    if (!commands.length) {
      const recovered = await recoverPostMutationChecks(path, task, writeScope.paths);
      commands = recovered.map((candidate) => candidate.command);
    }
    const candidateVerification = commands.length ? await runChecks(commands) : verificationResult([]);
    const relative = verificationAgainstBaseline(baseline, candidateVerification);
    gateway.logger.log("mini_swe_attempt_verification", { subtaskId: subtask.id,
      worker_engine: result.engine, model, outcome: relative.status,
      changed_paths: result.changedPaths, trajectory_path: result.trajectoryPath });
    if (relative.status === "VERIFIED_SUCCESS" || advisoryInfrastructureOnly(relative)) {
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
          reason: "focused_verification_passed" });
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
    await checkpoint.restore(path, writeScope);
    gateway.logger.log("attempt_rollback", { subtaskId: subtask.id, model,
      changedPaths: result.changedPaths, reason: attributable
        ? "candidate verification regression" : "candidate not verified" });
    const failedModel = model;
    const moved = await nextModel();
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
  throw Error("mini-SWE execution plan exhausted");
}

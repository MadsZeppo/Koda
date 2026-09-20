import { repairSourceContext } from "./repairSourceContext.js";
import { WriteScope } from "../repo/writeScope.js";
import { extractFeatures, taskBucket } from "../router/features.js";
import { taskFingerprint } from "../router/taskFingerprint.js";
import type { SpecialistEstimate } from "../router/routeOptimizer.js";
import {
  codingDemand,
  nextCodingTier,
  qualityFailure,
  PARETO_CODE_MODEL,
  type CodingTier,
} from "../router/codingDemand.js";
import { canFallback } from "../openrouter/client.js";
import type { Candidate } from "../router/modelRouter.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { Gateway } from "../openrouter/client.js";
import type { Subtask, Plan, EvidencePacket } from "../planner/schemas.js";
import {
  compileContext,
  workerReadPaths,
  compactProfile,
  isSourcePath,
  type WorkerContext,
} from "../context/compiler.js";
import { truncateBytes, boundMessages } from "../context/bounds.js";
import {
  objectiveCanBeAlreadySatisfied,
  workerChecks,
  workerChecksAreTaskSpecific,
  tinyDocumentationChecks,
} from "../verifier/selection.js";
import type {
  CommandResult,
  RepoProfile,
  HandoffPacket,
  VerificationResult,
} from "../types.js";
import { AgentTools, toolDefinitions, currentDiff, safePath } from "./tools.js";
import { readFile } from "node:fs/promises";
import { coderPrompt } from "./prompts.js";
import { verify, verificationAgainstBaseline, verificationResult, verificationRegressed } from "../verifier/verifier.js";
import { justifiedSiblingWrite } from "../repo/scopeExpansion.js";
import { verificationPlan } from "../verifier/plan.js";
import { focusedLocalReproduction, optionalUnavailableCheck, recoverPostMutationChecks } from "../verifier/recovery.js";
import { router } from "../router/router.js";
import { git } from "../repo/commands.js";
import { workspaceChangedPaths } from "../workspace/backend.js";
import { ProgressTracker } from "../router/progress.js";
import type { Role } from "../router/modelRegistry.js";
import type { StableImplementationHandoff } from "./stable.js";
import type { RepairPacket } from "./repairPacket.js";
import { implementStablePacket } from "./stableExecutor.js";
import { AttemptCheckpoint } from "./attemptCheckpoint.js";
async function applyCalls(
  message: any,
  messages: ChatCompletionMessageParam[],
  tools: AgentTools,
  allowedTools?: ReadonlySet<string>,
  mutationOnly = false,
) {
  messages.push(message);
  for (const call of (message.tool_calls ?? []).slice(0, 8)) {
    let content: string;
    try {
      const arguments_ = JSON.parse(call.function.arguments);
      if (allowedTools && !allowedTools.has(call.function.name))
        content = `Tool unavailable in this implementation phase: ${call.function.name}`;
      else if (
        mutationOnly &&
        call.function.name === "run_command" &&
        /^\s*(?:rg|grep|find|cat|head|tail|ls|pwd|sed\s+-n|git\s+(?:diff|status|log|show))\b/.test(
          arguments_.command ?? "",
        )
      )
        content =
          "Inspection is complete. Use write_file or a command that applies the supplied change.";
      else content = await tools.execute(call.function.name, arguments_);
    } catch (e) {
      content = `Tool error: ${String(e)}`;
      tools.logger.log("tool_error", {
        subtaskId: tools.subtaskId,
        error: content,
      });
    }
    messages.push({ role: "tool", tool_call_id: call.id, content });
  }
  if ((message.tool_calls?.length ?? 0) > 8)
    throw Error("Tool call limit exceeded");
}
export function stableReadyForFinalVerification(
  _writePaths: readonly string[],
  events: readonly Record<string, any>[],
  diff: string,
  commandResults: readonly unknown[],
) {
  if (
    !diff.trim() ||
    commandResults.some((result: any) => result.exitCode !== 0)
  )
    return false;
  const written = new Set(
    events
      .filter((event) => event.type === "write_success")
      .map((event) => event.path),
  );
  return written.size > 0;
}
export async function implement(
  gateway: Gateway,
  path: string,
  task: string,
  subtask: Subtask,
  plan: Pick<Plan, "acceptanceCriteria"> & Partial<Pick<Plan, "subtasks">>,
  profile: RepoProfile,
  options: {
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
  } = {},
) {
  if (
    options.finalVerificationOnly &&
    options.stableHandoff &&
    options.repairPacket &&
    !options.stableRepair
  ) {
    return implementStablePacket(
      gateway, path, task, subtask, plan, profile,
      {
        evidence: options.evidence,
        compiledContext: options.compiledContext,
        selectedCandidate: options.selectedCandidate,
        model: options.model,
        stableHandoff: options.stableHandoff,
        repairPacket: options.repairPacket,
        raceGroup: options.raceGroup,
        stop: options.stop,
      },
    );
  }

  const workerEventStart = gateway.logger.events.length;
  let writeScope = new WriteScope(
    subtask.likelyWritePaths,
    gateway.logger,
    subtask.id,
  );
  const acceptanceCriteria = [subtask.objective, subtask.integrationContract];
  const readPaths = workerReadPaths(subtask, plan.subtasks);
  const context =
    options.compiledContext ??
    (await compileContext(
      path,
      subtask.objective,
      [...writeScope.paths, ...readPaths],
      profile,
      gateway.config.context,
      true,
    ));
  const tinyLockedFiles = options.tinyDirect
    ? await Promise.all(
        writeScope.paths.map(async (file) => ({
          path: file,
          content: await readFile(await safePath(path, file), "utf8"),
        })),
      )
    : [];

  const tinyAllTargetsKnown =
    !!options.tinyDirect &&
    tinyLockedFiles.length > 0 &&
    tinyLockedFiles.length === writeScope.paths.length;
  const tinyAllTargetsComplete =
    tinyAllTargetsKnown &&
    tinyLockedFiles.every(
      (file) =>
        Buffer.byteLength(file.content) <= gateway.config.context.fileBytes &&
        context.completePaths?.includes(file.path),
    );
  const tinySingleLargeTarget =
    tinyAllTargetsKnown &&
    writeScope.paths.length === 1 &&
    !tinyAllTargetsComplete;
  const tinyTarget =
    options.tinyDirect && writeScope.paths.length === 1
      ? (() => {
          const targetPath = writeScope.paths[0]!;
          const compiled = context.files.find(
            (file) => file.path === targetPath,
          );
          return context.completePaths?.includes(targetPath)
            ? { path: targetPath, content: compiled?.snippet ?? "" }
            : { path: targetPath, excerpt: compiled?.snippet ?? "" };
        })()
      : undefined;

  const tinyMutationTools = tinyAllTargetsComplete
    ? new Set(["write_file"])
    : tinySingleLargeTarget
      ? new Set(["edit_file"])
      : tinyAllTargetsKnown
        ? new Set(["write_file", "edit_file"])
        : undefined;
  gateway.logger.log("worker_context", {
    subtaskId: subtask.id,
    context_files: context.files.map((f) => f.path),
    context_bytes: Buffer.byteLength(JSON.stringify(context)),
    context_limit_bytes: gateway.config.context.maxBytes,
  });
  gateway.logger.log("worker_scope", {
    subtaskId: subtask.id,
    allowed_write_paths: writeScope.paths,
    context_files: context.files.map((f) => f.path),
  });
  const evidence: EvidencePacket = options.evidence ?? {
    relevantFiles: context.files.map((f) => f.path).filter(isSourcePath),
    symbols: [],
    reproduction: "Baseline commands below are authoritative",
    failingTests: [],
    likelyRootCause: "Not established; inspect retrieved code",
    dependencies: subtask.dependsOn,
    uncertainty: "medium",
    suggestedApproach: "Use focused source/tests, then verify the objective",
    evidence: [],
  };
  const tinyDocs =
    options.tinyDirect &&
    subtask.likelyWritePaths.every((file) =>
      /\.(?:md|mdx|txt|rst)$/i.test(file),
    );
  let commands = tinyDocs
    ? subtask.likelyWritePaths.flatMap((file) =>
        tinyDocumentationChecks(profile, file),
      )
    : options.finalVerificationOnly
      ? verificationPlan(profile, subtask.likelyWritePaths, true)
          .filter((candidate) => candidate.available)
          .map((candidate) => candidate.command)
      : workerChecks(subtask, profile, context);
  const profiledCandidates = profile.ecosystem?.projectUnits.flatMap((unit) => unit.verification) ?? [];
  if (!subtask.verificationCommands.length)
    commands = commands.filter((command) => {
      const candidate = profiledCandidates.find((item) => item.command === command);
      return !candidate || !optionalUnavailableCheck(candidate);
    });
  const recovery = !tinyDocs && commands.length === 0
    ? await focusedLocalReproduction(profile, task, subtask.likelyWritePaths)
    : undefined;
  const recoveredCandidates = recovery ? [recovery] : [];
  let postMutationRecoveryAttempted = false;
  if (recovery) {
    commands = [recovery.command];
    gateway.logger.log("verification_recovery", { subtaskId: subtask.id,
      command: recovery.command, source: recovery.source });
  }
  const stableTargetedCommands =
    options.stableHandoff && options.repairPacket && subtask.verificationCommands.length
      ? subtask.verificationCommands
      : commands;
  gateway.logger.log("verification_selection", {
    subtaskId: subtask.id,
    commands:
      options.stableHandoff && options.repairPacket
        ? stableTargetedCommands
        : commands,
    selectedChecks: (
      options.stableHandoff && options.repairPacket
        ? stableTargetedCommands
        : commands
    ).map((command) => ({
      command,
      source: subtask.verificationCommands.includes(command)
        ? "subtask:verificationCommands"
        : (profile.ecosystem?.projectUnits
            .flatMap((u) => u.verification)
            .find((c) => c.command === command)?.source ??
          "inferred:targeted-native-node-test"),
    })),
    candidates: profile.ecosystem?.projectUnits
      .flatMap((u) => u.verification)
      .filter((c) => commands.includes(c.command)),
  });
  const checks = async (afterMutation = false) => {
    if (afterMutation && !tinyDocs && !commands.length && !postMutationRecoveryAttempted) {
      postMutationRecoveryAttempted = true;
      gateway.logger.log("verification_recovery_attempt", { subtaskId: subtask.id,
        paths: subtask.likelyWritePaths });
      const discovered = await recoverPostMutationChecks(path, task, subtask.likelyWritePaths);
      commands = discovered.map((candidate) => candidate.command);
      recoveredCandidates.push(...discovered);
      gateway.logger.log(discovered.length ? "verification_recovery" : "verification_recovery_exhausted", {
        subtaskId: subtask.id, commands, source: discovered.map((candidate) => candidate.source),
      });
    }
    if (options.finalVerificationOnly && !(afterMutation && recoveredCandidates.length))
      return verificationResult([]);
    return verify(
          path,
          commands,
          () =>
            Math.min(
              gateway.config.commandTimeoutMs,
              gateway.budget.remainingMs(),
            ),
          (c) =>
            gateway.logger.log("verification", {
              subtaskId: subtask.id,
              ...c,
            }),
          writeScope,
          [...profiledCandidates, ...recoveredCandidates].map((candidate) =>
            subtask.verificationCommands.includes(candidate.command)
              ? { ...candidate, requirement: "required" as const }
              : candidate,
          ),
        );
  };
  let verification = options.tinyDirect
    ? verificationResult([])
    : await checks();
  const baselineVerification = verification;
  let scopeExpansions = 0;
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
  const initialInfrastructureError = infrastructureError(verification);
  if (initialInfrastructureError) {
    gateway.logger.log("verification_infrastructure_failure", {
      subtaskId: subtask.id,
      error: initialInfrastructureError,
      checks: verification.checks,
    });
    throw Error(
      `Verification infrastructure unavailable: ${initialInfrastructureError}`,
    );
  }
  let role =
    options.initialRole ??
    router.select({
      originalTask: task,
      subtask,
      profile,
      evidence,
      attempts: 0,
      currentDiff: await currentDiff(path),
      verification,
      spent: {
        tokens: gateway.budget.tokens,
        costUsd: gateway.budget.spent,
        wallClockMs: Date.now() - gateway.budget.start,
      },
    });
  // A dependency may have already satisfied this objective. A passing check
  // does not need a decreasing failure count or an additional patch to be done.
  // Use the real status, including untracked files, rather than a truncated diff.
  if (
    verification.status === "VERIFIED_SUCCESS" &&
    objectiveCanBeAlreadySatisfied(subtask) &&
    workerChecksAreTaskSpecific(subtask, profile, context) &&
    !(
      (await workspaceChangedPaths(path)) ??
      (await git(path, "status", "--porcelain", "--untracked-files=all"))
        .split("\n")
        .filter(Boolean)
    ).length
  ) {
    gateway.logger.log("no_changes_required", {
      subtaskId: subtask.id,
      status: "VERIFIED_SUCCESS",
      reason: "already_satisfied",
      diffBytes: 0,
      verificationCommands: verification.checks.map((c) => c.command),
    });
    return { verification, role, evidence };
  }
  const pool = gateway.modelRouter;
  const features = extractFeatures(
    subtask,
    profile,
    Buffer.byteLength(JSON.stringify(context)),
    verification,
    gateway.logger.events.findLast((e) => e.type === "execution_strategy")
      ?.execution_strategy ?? (subtask.id === "direct" ? "direct" : "planned"),
  );
  const effort =
    gateway.logger.events.findLast((e) => e.type === "execution_strategy")
      ?.execution_effort ?? "normal";
  const fingerprint = taskFingerprint(subtask, profile, features, effort, verification);
  const demand =
    gateway.config.adaptiveCoding && !gateway.config.forceModel && pool
      ? codingDemand(features, subtask, effort, fingerprint, gateway.config.routing.minimumQuality)
      : undefined;
  const universalSelection = gateway.config.specialistRouting && !!pool &&
    !gateway.config.forceModel && !options.selectedCandidate;
  const specialistCascade: SpecialistEstimate[] = universalSelection
    ? await pool!.selectSpecialist(fingerprint, features, subtask.id,
        gateway.budget.remainingUsd(), options.raceGroup)
    : [];
  if (universalSelection && !specialistCascade.length)
    throw Error("No discovered model has sufficient priced capability and quality evidence for this task");
  let specialistIndex = 0;
  let adaptiveTier: CodingTier | undefined = demand && !gateway.config.specialistRouting && !specialistCascade.length
    ? (options.adaptiveStartTier ?? demand.tier)
    : undefined;
  let adaptiveAttempt = 0;
  let selected: Candidate | undefined = specialistCascade.length
    ? specialistCascade[0]
    : adaptiveTier
    ? undefined
    : (options.selectedCandidate ??
      (pool
        ? await pool.select(
            features,
            subtask.id,
            [],
            undefined,
            false,
            options.raceGroup,
          )
        : undefined));
  if (adaptiveTier === "frontier") {
    if (!pool) throw Error("Frontier rescue requires a configured model pool");
    selected = await pool.selectFrontierRescue(features, subtask.id);
  }
  const excluded: string[] = [];
  const poolRole = (): Role =>
    selected?.model.tier === "frontier"
      ? "FRONTIER_MODEL"
      : selected?.model.tier === "strong"
        ? "STRONG_MODEL"
        : "CHEAP_CODER_A";
  if (selected) role = poolRole();
  if (adaptiveTier)
    role =
      adaptiveTier === "frontier"
        ? "FRONTIER_MODEL"
        : adaptiveTier === "high"
          ? "STRONG_MODEL"
          : "CHEAP_CODER_A";
  const activeModel = () =>
    adaptiveTier && adaptiveTier !== "frontier"
      ? PARETO_CODE_MODEL
      : (selected?.model.id ?? options.model ?? gateway.config.registry[role]);
  gateway.logger.log("coding_route_decision", {
    subtaskId: subtask.id,
    task_bucket: taskBucket(features),
    verification_strength: fingerprint.verificationStrength,
    task_risk: fingerprint.difficulty.changeRisk,
    candidate: activeModel(),
    estimated_success: specialistCascade[0]?.quality ?? null,
    estimated_attempt_cost: specialistCascade[0]?.cost ?? null,
    estimated_total_cost: specialistCascade[0]?.expectedCompletionCost ?? null,
    quality_floor: specialistCascade[0]?.firstAttemptQualityFloor ??
      demand?.qualityFloor ?? gateway.config.routing.minimumQuality,
    evidence_source: specialistCascade[0]?.evidence.map((e) => e.source) ?? ["pareto_fallback"],
    fallback: specialistCascade.slice(1).map((c) => c.model.id),
  });
  let attemptStart = gateway.logger.events.length;
  let terminalAttemptRecorded = false;
  const record = (status: string, escalated = false, reason?: string) => {
    if (terminalAttemptRecorded) return;
    terminalAttemptRecorded = true;
    const meaningfulFailure = status === "FAILED" &&
      reason === "focused_verification_failed";
    if (selected && (status === "VERIFIED_SUCCESS" || meaningfulFailure))
      pool!.record(
        selected.model,
        features,
        subtask.id,
        attemptStart,
        status,
        escalated,
        reason,
        fingerprint,
      );
    else if (adaptiveTier) {
      pool?.recordServed(features, subtask.id, attemptStart, status, escalated, reason, fingerprint);
      gateway.logger.log("coding_attempt", {
        subtaskId: subtask.id,
        tier: adaptiveTier,
        attempt: adaptiveAttempt,
        verification: status,
        escalated,
        reason,
      });
    }
    attemptStart = gateway.logger.events.length;
  };
  const tools = new AgentTools(
    path,
    false,
    () =>
      Math.min(gateway.config.commandTimeoutMs, gateway.budget.remainingMs()),
    gateway.logger,
    subtask.id,
    gateway.config.context.toolResultBytes,
    writeScope,
  );
  if (options.stableRepair) {
    const allowed = new Set(["write_file", "edit_file", "apply_patch"]);
    const repairStart = gateway.logger.events.length;
    let lastRepairError = "";
    const repairCheckpoint = await AttemptCheckpoint.capture(path, writeScope);
    const failedModels = new Set<string>();
    const repairEvidence: unknown[] = [];
    const moveToRepairFallback = async (
      classification: "VERIFIED_REGRESSION" | "NO_PROGRESS" | "OPERATIONAL_FAILURE",
      error: unknown,
      rejectedDiff = "",
    ) => {
      const previous = activeModel();
      const rolledBack = await repairCheckpoint.restore(path, writeScope);
      gateway.logger.log("stable_final_repair_model_exhausted", {
        subtaskId: subtask.id, model: previous, error: String(error),
        outcome: classification,
        changedPaths: rolledBack.map((change) => change.path),
      });
      if (classification === "OPERATIONAL_FAILURE")
        gateway.logger.log("stable_final_repair_operational_failure", {
          subtaskId: subtask.id, model: previous, error: String(error),
          outcome: classification, changedPaths: rolledBack.map((change) => change.path),
        });
      repairEvidence.push({ model: previous, classification,
        rejectedDiff: truncateBytes(rejectedDiff, gateway.config.context.maxBytes),
        diagnostic: truncateBytes(String(error), 4000) });
      failedModels.add(previous);
      let next: Candidate | undefined;
      if (adaptiveTier) {
        const higher = nextCodingTier(adaptiveTier);
        if (!higher) return false;
        adaptiveTier = higher;
        adaptiveAttempt++;
        if (higher === "frontier") {
          if (!pool) return false;
          selected = await pool.selectFrontierRescue(features, subtask.id).catch(() => undefined);
        } else selected = undefined;
        role = higher === "frontier" ? "FRONTIER_MODEL" :
          higher === "high" ? "STRONG_MODEL" : "CHEAP_CODER_A";
      } else if (pool) {
        if (universalSelection) next = specialistCascade.find((candidate) =>
          !failedModels.has(candidate.model.id));
        else next = await pool.select(features, subtask.id, [...failedModels],
          selected?.model, true, options.raceGroup).catch(() => undefined);
        if (!next || failedModels.has(next.model.id)) return false;
        selected = next;
        role = poolRole();
      } else {
        const nextRole = router.escalate(role);
        if (!nextRole) return false;
        const nextModel = gateway.config.registry[nextRole];
        if (!nextModel || failedModels.has(nextModel)) return false;
        role = nextRole;
      }
      terminalAttemptRecorded = false;
      attemptStart = gateway.logger.events.length;
      gateway.logger.log("model_fallback", { subtaskId: subtask.id,
        previous_model: previous, selected_model: activeModel(),
        reason: `stable_final_repair_${classification.toLowerCase()}` });
      return true;
    };
    gateway.logger.log("coding_worker_start", {
      subtaskId: subtask.id,
      worktree: path,
    });
    try {
      // Final repair is a separate, two-turn state, never the general coder
      // loop. Refresh locked files each turn so an exact-text mismatch can be
      // corrected without reopening repository discovery.
      let modelTurn = 0;
      for (let totalTurn = 1; totalTurn <= 20; totalTurn++) {
        modelTurn++;
        const lockedFiles = await Promise.all(
          writeScope.paths.map(async (file) => ({
            path: file,
            content: await readFile(await safePath(path, file), "utf8")
              .then((value) =>
                repairSourceContext(value, file, options.stableRepair!.failedDiff ?? "",
                  options.stableRepair!.failedChecks, gateway.config.context.fileBytes),
              )
              .catch((error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return "<file does not exist>";
                throw error;
              }),
          })),
        );
        const before = await currentDiff(path);
        const messages: ChatCompletionMessageParam[] = [
          {
            role: "system",
            content:
              "You are repairing one failed Stable final verification in the SAME isolated workspace. Inspection is complete. Do not search or rediscover. Modify only the locked paths. Use edit_file or apply_patch now with exact text from currentLockedFiles. write_file is only safe when complete file content is supplied. No shell or repository inspection is available. Do not install dependencies, change checks, or claim success; the runtime reruns verification.",
          },
          {
            role: "user",
            content: JSON.stringify({
              inspectionHandoff: options.stableHandoff,
              lockedWritePaths: writeScope.paths,
              currentLockedFiles: lockedFiles,
              changedFiles: options.stableRepair.changedFiles,
              currentDiff: truncateBytes(
                before,
                gateway.config.context.maxBytes,
              ),
              failedDiff: truncateBytes(options.stableRepair.failedDiff ?? before,
                gateway.config.context.maxBytes),
              implicatedFiles: options.stableRepair.changedFiles,
              implicatedSymbols: options.stableRepair.implicatedSymbols ?? options.evidence?.symbols ?? [],
              repairPacket: options.repairPacket,
              failedChecks: options.stableRepair.failedChecks.map((check) => ({
                command: check.command,
                exitCode: check.exitCode,
                stdout: truncateBytes(check.stdout, 12000),
                stderr: truncateBytes(check.stderr, 12000),
              })),
              newRegressionDiagnostics: options.stableRepair.regressionDiagnostics ?? [],
              focusedFailureContext: options.stableRepair.failureContext ?? [],
              repairAttempt: options.stableRepair.attempt,
              turn: modelTurn,
              previousToolError: lastRepairError,
              priorRepairAttempts: repairEvidence,
              instruction:
                modelTurn === 1
                  ? "Fix the exact reported failure. Do not repeat inspection."
                  : "The previous action did not produce a clean mutation. Correct it using the current locked file contents and exact tool error; this is the last repair turn.",
            }),
          },
        ];
        const callStart = tools.commandEvidence.length;
        let response: any;
        try { response = await gateway.call(
          activeModel(),
          boundMessages(messages, gateway.config.context.maxPromptBytes),
          subtask.id,
          "implement",
          totalTurn - 1,
          toolDefinitions.filter((tool: any) =>
            allowed.has(tool.function.name),
          ),
          {
            requireTool: true,
            maxOutputTokens: 1800,
            timeoutMs: 30000,
            codingRoute:
              adaptiveTier && adaptiveTier !== "frontier"
                ? {
                    tier: adaptiveTier,
                    reason: demand?.reason ?? "Focused repair",
                    attempt: adaptiveAttempt,
                  }
                : undefined,
          },
        ); } catch (error) {
          if (!canFallback(error, gateway) || gateway.config.forceModel ||
              !(await moveToRepairFallback("OPERATIONAL_FAILURE", error))) throw error;
          modelTurn = 0;
          continue;
        }
        if (response.tool_calls?.length)
          await applyCalls(response, messages, tools, allowed, true);
        const malformed = messages.some((message) => message.role === "tool" &&
          /Tool error: SyntaxError:|Tool call limit exceeded/.test(String(message.content ?? "")));
        if (malformed) {
          const error = Error("Malformed Stable final-repair tool arguments");
          if (gateway.config.forceModel ||
              !(await moveToRepairFallback("OPERATIONAL_FAILURE", error))) throw error;
          modelTurn = 0;
          continue;
        }
        const after = await currentDiff(path);
        const failedCommand = tools.commandEvidence
          .slice(callStart)
          .find((result: any) => result.exitCode !== 0);
        lastRepairError = messages
          .filter((message) => message.role === "tool")
          .map((message) => String(message.content ?? ""))
          .join("\n");
        if (after !== before && !failedCommand) {
          const commands = [...new Set(options.stableRepair.failedChecks.map((check) => check.command))];
          const focused = await verify(path, commands,
            () => Math.min(gateway.config.commandTimeoutMs, gateway.budget.remainingMs()),
            (check) => gateway.logger.log("stable_repair_verification", {
              subtaskId: subtask.id, model: activeModel(), ...check,
            }), writeScope,
            [...(profile.ecosystem?.projectUnits.flatMap((unit) => unit.verification) ?? []),
              ...options.stableRepair.failedChecks.filter((check) =>
                check.source?.includes("focused-new-regression")).map((check) => ({
                  command: check.command, kind: "test" as const, available: true,
                  source: check.source!, cwd: ".", confidence: 1,
                  mutatesSource: false as const, requiresInstalledDependencies: true,
                }))]);
          const focusedRelative = options.stableRepair.baselineChecks?.length
            ? verificationAgainstBaseline(
                verificationResult(options.stableRepair.baselineChecks), focused)
            : focused;
          if (focusedRelative.status === "VERIFIED_SUCCESS") {
            gateway.logger.log("stable_final_repair_candidate_verified", {
              subtaskId: subtask.id, model: activeModel(), checks: focused.checks,
            });
            record("NOT_FULLY_VERIFIED");
            return { verification: focusedRelative, role, evidence };
          }
          const rejectedDiff = truncateBytes(after, gateway.config.context.maxBytes);
          const originalFailure = verificationResult(options.stableRepair.failedChecks);
          const attributable = verificationRegressed(originalFailure, focused);
          if (attributable) record("FAILED", true, "focused_verification_failed");
          const moved = await moveToRepairFallback(
            attributable ? "VERIFIED_REGRESSION" : "NO_PROGRESS",
            focused.checks.filter((check) => check.outcome === "CHECK_FAIL")
              .map((check) => `${check.command}\n${check.stdout}\n${check.stderr}`).join("\n"),
            rejectedDiff,
          );
          if (!moved) throw Error("Stable final repair fallback chain exhausted after failed verification");
          modelTurn = 0;
          lastRepairError = "Previous repair failed focused verification and was rolled back.";
          continue;
        }
        if (failedCommand) lastRepairError = `Repair tool command failed: ${JSON.stringify(failedCommand)}`;
        if (modelTurn >= 2) {
          const moved = await moveToRepairFallback("NO_PROGRESS",
            lastRepairError || "Repair model produced no mutation");
          if (!moved) throw Error("Stable final repair fallback chain exhausted without a mutation");
          modelTurn = 0;
          continue;
        }
      }
      throw Error(
        "Stable final repair globally exhausted its bounded fallback chain",
      );
    } finally {
      gateway.logger.log("coding_worker_stop", {
        subtaskId: subtask.id,
        worktree: path,
      });
    }
  }
  let tracker = new ProgressTracker();
  let messages: ChatCompletionMessageParam[] = [];
  let stageIterations = 0;
  let stageStart = Date.now();
  let stageTokens = 0;
  let stageCost = 0;
  let infrastructureFailure = false;
  let stableNoMutationTurns = 0;
  let stableActionRepairUsed = false;
  let stableSameModelRetryUsed = false;
  let stableCheckRepairUsed = false;
  let stableTargetedFailureAfterRepair = false;
  let stableMutationRepairAttempts = 0;
  let stableMissingPathNudgeUsed = false;
  let tinyNoMutationTurns = 0;
  let adaptiveProviderRetry = 0;
  let genericNoMutationTurns = 0;
  let emptySearchCycles = 0;
  let searchRecoveryUsed = false;
  const seenSearchEvidence = new Set<string>();
  const attempted: string[] = [];
  const compactVerification = (v: VerificationResult) => ({
    ...v,
    checks: v.checks.map((c) => ({
      ...c,
      stdout: truncateBytes(c.stdout, gateway.config.context.toolResultBytes),
      stderr: truncateBytes(c.stderr, gateway.config.context.toolResultBytes),
    })),
  });
  const orderedTools = (names: readonly string[]) =>
    names
      .map((name) =>
        toolDefinitions.find((tool: any) => tool.function.name === name),
      )
      .filter((tool): tool is (typeof toolDefinitions)[number] => !!tool);

  const currentLockedFiles = async () =>
    Promise.all(
      writeScope.paths.map(async (file) => ({
        path: file,
        content: await readFile(await safePath(path, file), "utf8")
          .then((value) =>
            truncateBytes(value, gateway.config.context.fileBytes),
          )
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return "<file does not exist>";
            throw error;
          }),
      })),
    );

  const startStableTargetedRepair = async (
    failed: VerificationResult,
    reason: string,
  ) => {
    messages = [
      {
        role: "system",
        content:
          coderPrompt +
          "\nSTABLE TARGETED-VERIFICATION REPAIR." +
          "\nInspection is complete. Do not rediscover the task." +
          "\nRepair the CURRENT modified workspace using only the locked paths." +
          "\nYOUR ONLY TASK: " +
          subtask.objective +
          "\nWRITE RESPONSIBILITY: " +
          JSON.stringify(writeScope.paths),
      },
      {
        role: "user",
        content: JSON.stringify({
          task: subtask.objective,
          repairPacket: options.repairPacket,
          inspectionHandoff: options.stableHandoff,
          allowed_write_paths: writeScope.paths,
          currentLockedFiles: await currentLockedFiles(),
          currentDiff: truncateBytes(
            await currentDiff(path),
            gateway.config.context.maxBytes,
          ),
          failedChecks: compactVerification(failed).checks.filter(
            (check) => check.exitCode !== 0,
          ),
          reason,
          instruction:
            "Fix the targeted verification failure now. Mutate the current workspace before any further verification.",
        }),
      },
    ];
  };
  const start = (handoff?: HandoffPacket) => {
    messages = [
      {
        role: "system",
        content:
          coderPrompt +
          "\nYOUR ONLY TASK: " +
          subtask.objective +
          "\nWRITE RESPONSIBILITY: " +
          JSON.stringify(writeScope.paths) +
          (options.stableHandoff
            ? options.repairPacket
              ? "\nInspection is complete. Implement the change now. Use the supplied RepairPacket. Your first action must mutate the locked workspace with apply_patch, edit_file, or write_file. Do not search, inspect, run commands, or rediscover."
              : "\nInspection is complete. Do not rediscover the task. Implement the supplied finding now."
            : "") +
          (options.stableRepair
            ? "\nFinal verification failed. Repair the existing implementation in this same workspace; do not restart discovery. Use the supplied exact failure output and keep the locked write scope."
            : "") +
          (options.tinyDirect
            ? "\nThe task is already scoped. Current target content is provided. Do not read, search, inspect, or run commands. Make the requested mutation now with the available write tool. Verification runs after mutation; no completion announcement is needed."
            : !options.stableHandoff && writeScope.paths.length > 0 &&
                writeScope.paths.every((file) => context.files.some((entry) => entry.path === file))
              ? "\nThe relevant source is already in the supplied context. If it is sufficient, mutate now; do not reread it or run redundant exploratory commands. The runtime performs authoritative verification."
            : ""),
      },
      {
        role: "user",
        content: JSON.stringify(
          handoff
            ? {
                handoff,
                inspectionHandoff: options.stableHandoff,
                repairPacket: options.repairPacket,
                allowed_write_paths: writeScope.paths,
                target: options.tinyDirect ? tinyTarget : undefined,
                context: options.tinyDirect ? undefined : context,
              }
            : {
                task: subtask.objective,
                subtask: { ...subtask, likelyReadPaths: readPaths },
                allowed_write_paths: writeScope.paths,
                acceptanceCriteria,
                profile: {
                  ...compactProfile(profile),
                  verificationCommands: commands,
                },
                target: options.tinyDirect ? tinyTarget : undefined,
                context: options.tinyDirect ? undefined : context,
                evidence,
                inspectionHandoff: options.stableHandoff,
                repairPacket: options.repairPacket,
                stableRepair: options.stableRepair,
                verification: compactVerification(verification),
                extra: options.extra
                  ? truncateBytes(
                      JSON.stringify(options.extra),
                      gateway.config.context.fileBytes,
                    )
                  : undefined,
              },
        ),
      },
    ];
    gateway.logger.log("route", {
      subtaskId: subtask.id,
      role,
      model: activeModel(),
    });
  };

  const startStableMutationRepair = (
    reason: string,
    failure?: {
      command: string;
      exitCode: number;
      stdout?: string;
      stderr?: string;
    },
  ) => {
    const lockedContext = context.files.filter((file) =>
      writeScope.paths.includes(file.path),
    );

    messages = [
      {
        role: "system",
        content:
          coderPrompt +
          "\nSTABLE MUTATION-ONLY REPAIR." +
          "\nInspection is finished. Do not inspect, search, summarize, run commands, or explain." +
          "\nYOUR ONLY TASK: " +
          subtask.objective +
          "\nWRITE RESPONSIBILITY: " +
          JSON.stringify(writeScope.paths) +
          (failure
            ? "\nThe previous mutation failed without changing the workspace. Use the exact tool error and locked source already in context, then retry the smallest apply_patch, edit_file, or write_file mutation."
            : "\nYour next response MUST contain apply_patch, edit_file, or write_file and mutate the locked workspace. Ordinary text is not a valid action."),
      },
      {
        role: "user",
        content: JSON.stringify({
          task: subtask.objective,
          allowed_write_paths: writeScope.paths,
          inspectionHandoff: options.stableHandoff,
          stableRepair: options.stableRepair,
          lockedContext,
          verification: compactVerification(verification),
          reason,
          failedMutation: failure,
        }),
      },
    ];

    gateway.logger.log("stable_mutation_rescue", {
      subtaskId: subtask.id,
      model: activeModel(),
      reason,
      allowed_write_paths: writeScope.paths,
    });
  };

  start();
  let attemptCheckpoint = await AttemptCheckpoint.capture(path, writeScope);
  gateway.logger.log("attempt_checkpoint_created", { subtaskId: subtask.id, model: activeModel() });

  // RepairPacket Stable execution is intentionally isolated from the legacy
  // general coder state machine below. Once Stable has localized the task and
  // built a RepairPacket, the only valid lifecycle is:
  // mutate -> targeted verify -> one same-model repair -> verified fallback.
  // Do not let generic progress/stall/finally-record logic reinterpret it.
  if (
    options.finalVerificationOnly &&
    options.stableHandoff &&
    options.repairPacket &&
    !options.stableRepair
  ) {
    let noMutationTurns = 0;
    let contextRecoveryUsed = false;
    let sameModelRepairUsed = false;
    let providerRetryUsed = false;
    const repairMessages = () => messages;

    const resetForCurrentWorkspace = async (
      reason: string,
      failed?: VerificationResult,
    ) => {
      messages = [
        {
          role: "system",
          content:
            coderPrompt +
            "\nInspection is complete. Implement the change now." +
            "\nUse the supplied RepairPacket and CURRENT locked source." +
            "\nDo not search, inspect, run commands, or rediscover." +
            "\nYOUR ONLY TASK: " +
            subtask.objective +
            "\nWRITE RESPONSIBILITY: " +
            JSON.stringify(writeScope.paths),
        },
        {
          role: "user",
          content: JSON.stringify({
            task: subtask.objective,
            repairPacket: options.repairPacket,
            inspectionHandoff: options.stableHandoff,
            allowed_write_paths: writeScope.paths,
            currentLockedFiles: await currentLockedFiles(),
            currentDiff: truncateBytes(
              await currentDiff(path),
              gateway.config.context.maxBytes,
            ),
            failedChecks: failed
              ? compactVerification(failed).checks.filter(
                  (check) => check.exitCode !== 0,
                )
              : [],
            reason,
          }),
        },
      ];
    };

    const fallbackModel = async (reason: string): Promise<boolean> => {
      // Provider/protocol failures are infrastructure outcomes. They must not
      // enter verified quality history and they do not reset mutation budget.
      if (adaptiveTier && adaptiveTier !== "frontier") {
        if (!canFallback(new Error(reason), gateway)) return false;
        if (!providerRetryUsed) {
          providerRetryUsed = true;
          adaptiveAttempt++;
          return true;
        }
        if (pool) {
          try {
            selected = await pool.select(
              features,
              subtask.id,
              excluded,
              selected?.model,
              true,
              options.raceGroup,
            );
            adaptiveTier = undefined;
            role = poolRole();
            providerRetryUsed = false;
            return true;
          } catch {
            return false;
          }
        }
        return false;
      }

      if (pool && selected) {
        const previous = selected.model;
        if (!excluded.includes(previous.id)) excluded.push(previous.id);
        try {
          selected = await pool.select(
            features,
            subtask.id,
            excluded,
            previous,
            true,
            options.raceGroup,
          );
          role = poolRole();
          providerRetryUsed = false;
          return true;
        } catch {
          return false;
        }
      }

      const next = router.escalate(role);
      if (!next || gateway.config.registry[next] === activeModel()) return false;
      role = next;
      return true;
    };

    gateway.logger.log("coding_worker_start", {
      subtaskId: subtask.id,
      worktree: path,
    });

    try {
      // Six successful model turns is a hard ceiling. Provider failures do not
      // consume the no-mutation counter, but they also cannot create an
      // unbounded retry loop because fallback candidates are exhausted.
      for (let turn = 0; turn < 6; turn++) {
        if (options.stop?.()) throw Error("Speculative attempt superseded");
        if (gateway.budget.remainingMs() <= 1)
          throw Error("Run time budget exhausted");

        const beforeDiff = await currentDiff(path);
        const allowContext = noMutationTurns > 0 && !contextRecoveryUsed;
        const toolNames = allowContext
          ? ["apply_patch", "edit_file", "write_file", "request_context"]
          : ["apply_patch", "edit_file", "write_file"];

        let response;
        try {
          response = await gateway.call(
            activeModel(),
            boundMessages(repairMessages(), gateway.config.context.maxPromptBytes),
            subtask.id,
            "implement",
            turn,
            orderedTools(toolNames),
            {
              requireTool: true,
              codingRoute:
                adaptiveTier && adaptiveTier !== "frontier"
                  ? {
                      tier: adaptiveTier,
                      reason: demand?.reason ?? "Stable RepairPacket mutation",
                      attempt: adaptiveAttempt,
                    }
                  : undefined,
            },
          );
        } catch (error) {
          if (!canFallback(error, gateway)) throw error;
          const moved = await fallbackModel(String(error));
          if (!moved) throw error;
          await resetForCurrentWorkspace(
            `provider_or_protocol_fallback: ${String(error)}`,
            verification.status === "FAILED" ? verification : undefined,
          );
          turn--;
          continue;
        }

        const toolMessageStart = messages.length;
        if (response.tool_calls?.length) {
          await applyCalls(
            response,
            messages,
            tools,
            new Set(toolNames),
            true,
          );
        } else {
          messages.push({ role: "assistant", content: response.content ?? "" });
        }

        const requestedContext = (response.tool_calls ?? []).some(
          (call: any) => call.function?.name === "request_context",
        );
        if (requestedContext) contextRecoveryUsed = true;

        const afterDiff = await currentDiff(path);
        if (afterDiff === beforeDiff) {
          noMutationTurns++;
          if (noMutationTurns >= 3)
            throw Error("Stable mutation protocol exhausted without a diff");

          const recentToolResults = messages
            .slice(toolMessageStart)
            .filter((message) => message.role === "tool")
            .map((message) => String(message.content ?? ""));

          messages.push({
            role: "user",
            content: JSON.stringify({
              currentLockedFiles: await currentLockedFiles(),
              currentDiff: truncateBytes(
                await currentDiff(path),
                gateway.config.context.maxBytes,
              ),
              previousToolResults: recentToolResults,
              instruction: requestedContext
                ? "Context recovery is complete. Your next action must mutate with apply_patch, edit_file, or write_file."
                : "No workspace mutation was produced. Correct the exact tool error. You may request_context once if an exact locked range is missing; otherwise mutate now.",
            }),
          });
          continue;
        }

        // Any meaningful scoped mutation is enough. allowed_write_paths are
        // permissions, not a checklist of files that all must be touched.
        noMutationTurns = 0;
        contextRecoveryUsed = false;

        const targeted = await verify(
          path,
          stableTargetedCommands,
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
          writeScope,
          profile.ecosystem?.projectUnits.flatMap((unit) => unit.verification),
        );

        const targetedInfrastructureError = infrastructureError(targeted);
        if (targetedInfrastructureError) {
          infrastructureFailure = true;
          throw Error(
            `Verification infrastructure unavailable: ${targetedInfrastructureError}`,
          );
        }

        verification = targeted;
        gateway.logger.log("stable_targeted_verification", {
          subtaskId: subtask.id,
          status: targeted.status,
          checks: targeted.checks,
          diffBytes: Buffer.byteLength(afterDiff),
        });

        if (targeted.status === "VERIFIED_SUCCESS") {
          gateway.logger.log("ready_for_final_verification", {
            subtaskId: subtask.id,
            diffBytes: Buffer.byteLength(afterDiff),
            reason: "targeted_verification_passed",
          });
          return {
            verification: verificationResult([]),
            role,
            evidence,
          };
        }

        if (!sameModelRepairUsed) {
          // Exactly one repair on the same model, using current source/diff.
          sameModelRepairUsed = true;
          await resetForCurrentWorkspace(
            "targeted_verification_failed_same_model_repair",
            targeted,
          );
          continue;
        }

        // The repair mutated but the focused check still fails. Only now may
        // verified quality fallback choose another model. Preserve current
        // source and diff in the handoff; never restart from stale context.
        const moved = await fallbackModel("targeted verification still failing");
        if (!moved) {
          return { verification: targeted, role, evidence };
        }
        sameModelRepairUsed = false;
        await resetForCurrentWorkspace(
          "targeted_verification_failed_model_fallback",
          targeted,
        );
      }

      throw Error("Stable mutation protocol exhausted without a diff");
    } finally {
      // Deliberately no record() here. RepairPacket attempts become quality
      // evidence only after authoritative verification; provider/protocol/no-op
      // outcomes must never contaminate task-specific quality history.
      gateway.logger.log("coding_worker_stop", {
        subtaskId: subtask.id,
        worktree: path,
      });
    }
  }

  gateway.logger.log("coding_worker_start", {
    subtaskId: subtask.id,
    worktree: path,
  });
  try {
    for (
      let iteration = 0;
      iteration <
      (options.tinyDirect
        ? adaptiveTier
          ? gateway.config.maxIterations
          : Math.min(3, gateway.config.maxIterations)
        : gateway.config.maxIterations);
      iteration++
    ) {
      if (options.stop?.()) throw Error("Speculative attempt superseded");
      if (gateway.budget.remainingMs() <= 1)
        throw Error("Run time budget exhausted");
      const actionStart = tools.actions.length;
      const evidenceStart = tools.progressEvidence.length;
      const commandEvidenceStart = tools.commandEvidence.length;
      const beforeDiff = await currentDiff(path);
      let m;
      try {
        const stableToolNames = options.stableHandoff
          ? options.repairPacket
            ? new Set(
                stableNoMutationTurns > 0
                  ? ["apply_patch", "edit_file", "write_file", "request_context"]
                  : ["apply_patch", "edit_file", "write_file"],
              )
            : new Set(
                stableNoMutationTurns > 0
                  ? ["write_file", "run_command"]
                  : [
                      "read_file",
                      "write_file",
                      "run_command",
                      "git_diff",
                      "git_status",
                    ],
              )
          : undefined;
        m = await gateway.call(
          activeModel(),
          boundMessages(messages, gateway.config.context.maxPromptBytes),
          subtask.id,
          "implement",
          iteration,
          options.stableHandoff && options.repairPacket
            ? orderedTools(
                stableNoMutationTurns > 0
                  ? [
                      "apply_patch",
                      "edit_file",
                      "write_file",
                      "request_context",
                    ]
                  : ["apply_patch", "edit_file", "write_file"],
              )
            : (tinyMutationTools ?? stableToolNames)
              ? toolDefinitions.filter((tool: any) =>
                  (tinyMutationTools ?? stableToolNames)!.has(
                    tool.function.name,
                  ),
                )
              : genericNoMutationTurns >= 2 && !searchRecoveryUsed
                ? toolDefinitions.filter((tool: any) =>
                    ["write_file", "edit_file"].includes(tool.function.name),
                  )
                : toolDefinitions,
          {
            requireTool:
              !!tinyMutationTools ||
              !!(options.stableHandoff && options.repairPacket) ||
              !!(options.stableHandoff && stableNoMutationTurns > 0),
            codingRoute:
              adaptiveTier && adaptiveTier !== "frontier"
                ? {
                    tier: adaptiveTier,
                    reason: demand?.reason ?? "Adaptive coding",
                    attempt: adaptiveAttempt,
                  }
                : undefined,
          },
        );
      } catch (error) {
        if (adaptiveTier && adaptiveTier !== "frontier") {
          if (!canFallback(error, gateway)) throw error;
          if (
            pool &&
            error instanceof Error &&
            /protocol|unsupported|parameter|400|404/i.test(String(error))
          ) {
            selected = await pool.select(features, subtask.id);
            adaptiveTier = undefined;
            role = poolRole();
            adaptiveProviderRetry = 0;
            gateway.logger.log("coding_route_fallback", {
              subtaskId: subtask.id,
              model: selected.model.id,
              reason: String(error),
            });
            start();
            continue;
          }
          if (adaptiveProviderRetry++ === 0) {
            adaptiveAttempt++;
            gateway.logger.log("coding_provider_retry", {
              subtaskId: subtask.id,
              tier: adaptiveTier,
              reason: String(error),
              attempt: adaptiveAttempt,
            });
            continue;
          }
          throw error;
        }
        if (!pool || !selected) throw error;
        if (!canFallback(error, gateway) || gateway.config.forceModel)
          throw error;
        const previous = selected.model;
        excluded.push(previous.id);
        pool.disabled.add(previous.id);
        selected = await pool.select(
          features,
          subtask.id,
          excluded,
          previous,
          true,
        );
        role = poolRole();
        gateway.logger.log("model_fallback", {
          subtaskId: subtask.id,
          previous_model: previous.id,
          selected_model: selected.model.id,
          reason: String(error),
          verification: verification.status,
          previous_cost: stageCost,
        });
        stageIterations = 0;
        stageTokens = 0;
        stageCost = 0;
        stageStart = Date.now();
        tracker = new ProgressTracker();
        start({
          originalObjective: subtask.objective,
          acceptanceCriteria,
          relevantFiles: evidence.relevantFiles,
          currentDiff: truncateBytes(
            await currentDiff(path),
            gateway.config.context.maxBytes,
          ),
          reproduction: evidence.reproduction,
          verificationFailures: compactVerification(verification).checks.filter(
            (c) => c.exitCode !== 0,
          ),
          approachesAlreadyAttempted: attempted.slice(-6),
          disprovenHypotheses: [],
          remainingProblem: `Previous model unavailable: ${String(error)}`,
        });
        if (options.stableHandoff && options.repairPacket)
          messages.push({
            role: "user",
            content: JSON.stringify({
              currentLockedFiles: await currentLockedFiles(),
              currentDiff: truncateBytes(
                await currentDiff(path),
                gateway.config.context.maxBytes,
              ),
              instruction:
                "Continue from the CURRENT modified source. Do not overwrite it from stale context.",
            }),
          });
        attemptCheckpoint = await AttemptCheckpoint.capture(path, writeScope);
        gateway.logger.log("attempt_checkpoint_created", { subtaskId: subtask.id, model: activeModel() });
        continue;
      }
      stageIterations++;
      const call = gateway.logger.events
        .filter((e) => e.type === "model_call" && e.subtaskId === subtask.id)
        .at(-1);
      stageTokens += (call?.promptTokens ?? 0) + (call?.completionTokens ?? 0);
      stageCost += call?.costUsd ?? 0;
      if (options.stop?.()) throw Error("Speculative attempt superseded");
      const activeStableTools =
        tinyMutationTools ??
        (options.stableHandoff
          ? options.repairPacket
            ? new Set(
                stableNoMutationTurns > 0
                  ? ["apply_patch", "edit_file", "write_file", "request_context"]
                  : ["apply_patch", "edit_file", "write_file"],
              )
            : new Set(
                stableNoMutationTurns > 0
                  ? ["write_file", "run_command"]
                  : [
                      "read_file",
                      "write_file",
                      "run_command",
                      "git_diff",
                      "git_status",
                    ],
              )
          : undefined);
      const scopeEventStart = gateway.logger.events.length;
      if (m.tool_calls?.length)
        await applyCalls(
          m,
          messages,
          tools,
          activeStableTools,
          !!options.stableHandoff && stableNoMutationTurns > 0,
        );
      else {
        messages.push({ role: "assistant", content: m.content ?? "" });
        attempted.push((m.content ?? "").slice(0, 600));
      }
      const violations = gateway.logger.events.slice(scopeEventStart).filter((event) =>
        event.type === "write_scope_violation" && event.subtaskId === subtask.id);
      if (violations.length && scopeExpansions < 1 && !options.tinyDirect && !options.stableHandoff) {
        const attemptedPaths = [...new Set(violations.flatMap((event) => event.attempted_write_paths ?? []))];
        const ownedElsewhere = (candidate: string) => plan.subtasks?.some((other) =>
          other.id !== subtask.id && other.likelyWritePaths.some((owned) =>
            candidate === owned || candidate.startsWith(owned + "/") || owned.startsWith(candidate + "/")));
        if (attemptedPaths.length === 1 && !ownedElsewhere(attemptedPaths[0]) &&
            await justifiedSiblingWrite(path, attemptedPaths[0], subtask, profile, task, options.evidence)) {
          const candidate = attemptedPaths[0];
          writeScope = new WriteScope([...writeScope.paths, candidate], gateway.logger, subtask.id);
          tools.writeScope = writeScope;
          subtask.likelyWritePaths.push(candidate);
          attemptCheckpoint = await AttemptCheckpoint.capture(path, writeScope);
          scopeExpansions++;
          gateway.logger.log("write_scope_expanded", { subtaskId: subtask.id, path: candidate, reason: "task_named_sibling_with_source_relationship" });
          messages.push({ role: "user", content: `Local repository evidence confirms ${candidate} is a required sibling implementation file. Its write scope is now authorized. Retry the rejected edit to that file; do not inspect or change unrelated paths.` });
          continue;
        }
      }
      const diff = await currentDiff(path);
      if (!diff.trim() && [...tools.missingReadAttempts.values()].some((count) => count >= 2))
        throw Error("Repository navigation exhausted: repeated nonexistent read path after local recovery");
      if (diff === beforeDiff) genericNoMutationTurns++;
      else genericNoMutationTurns = 0;
      let searchRecoveryTriggered = false;
      if (!options.tinyDirect && !options.stableHandoff && !diff.trim()) {
        const attemptedSearch = tools.actions.slice(actionStart).some((action) =>
          action.startsWith("search_code:"));
        const currentEvidence = tools.progressEvidence.slice(evidenceStart);
        const usefulInspection = currentEvidence.some((item) => !seenSearchEvidence.has(item));
        for (const item of currentEvidence) seenSearchEvidence.add(item);
        emptySearchCycles = attemptedSearch && !usefulInspection
          ? emptySearchCycles + 1 : usefulInspection ? 0 : emptySearchCycles;
        if (emptySearchCycles >= 2 && !searchRecoveryUsed) {
          searchRecoveryUsed = true;
          searchRecoveryTriggered = true;
          const tree = await tools.execute("list_files", {});
          const alternateSearch = await tools.execute("search_code", {
            query: "\\b(?:export|function|class|def)\\b",
          });
          const likelySources = [...new Set([
            ...subtask.likelyWritePaths, ...subtask.likelyReadPaths,
            ...profile.files,
          ])].filter((file) => profile.files.includes(file) && isSourcePath(file)).slice(0, 2);
          const source = await Promise.all(likelySources.map(async (file) => {
            try { return { path: file, content: await tools.execute("read_file", { path: file }) }; }
            catch { return { path: file, content: "unavailable" }; }
          }));
          messages.push({ role: "user", content: JSON.stringify({
            instruction: "Two searches returned no useful result. The runtime inspected the file tree, tried a different code search, and read likely source files. Use this evidence to edit or inspect a specific file now; do not repeat the empty searches.",
            tree: truncateBytes(String(tree), 2500),
            alternateSearch: truncateBytes(String(alternateSearch), 2500),
            source: source.map((entry) => ({ path: entry.path,
              content: truncateBytes(String(entry.content), 4000) })),
          }) });
          gateway.logger.log("search_strategy_change", {
            subtaskId: subtask.id, emptySearchCycles, inspectedFiles: likelySources,
          });
        }
      }
      if (gateway.config.forceModel && !diff.trim() && genericNoMutationTurns >= 3)
        throw Error("Forced model stalled without verified completion");
      let tinyBoundedNoMutation = false;
      const iterationCommandResults =
        tools.commandEvidence.slice(commandEvidenceStart);
      const failedInlineCheck = iterationCommandResults.find(
        (result: any) => result.exitCode !== 0,
      ) as
        | {
            command: string;
            exitCode: number;
            stdout?: string;
            stderr?: string;
          }
        | undefined;
      let postWriteVerification: VerificationResult | undefined;

      if (
        options.finalVerificationOnly &&
        options.stableHandoff &&
        options.repairPacket
      ) {
        if (diff !== beforeDiff && diff.trim() && !failedInlineCheck) {
          stableNoMutationTurns = 0;
          const targeted = stableTargetedCommands.length ? await verify(
            path,
            stableTargetedCommands,
            () =>
              Math.min(
                gateway.config.commandTimeoutMs,
                gateway.budget.remainingMs(),
              ),
            (c) =>
              gateway.logger.log("verification", {
                subtaskId: subtask.id,
                ...c,
              }),
            writeScope,
            profile.ecosystem?.projectUnits.flatMap((u) => u.verification),
          ) : await checks(true);
          const targetedInfrastructureError = infrastructureError(targeted);
          if (targetedInfrastructureError) {
            infrastructureFailure = true;
            verification = targeted;
            throw Error(
              `Verification infrastructure unavailable: ${targetedInfrastructureError}`,
            );
          }

          verification = targeted;
          gateway.logger.log("stable_targeted_verification", {
            subtaskId: subtask.id,
            status: targeted.status,
            checks: targeted.checks,
            diffBytes: Buffer.byteLength(diff),
          });

          if (targeted.status === "VERIFIED_SUCCESS") {
            gateway.logger.log("ready_for_final_verification", {
              subtaskId: subtask.id,
              diffBytes: Buffer.byteLength(diff),
              reason: "targeted_verification_passed",
            });
            return {
              verification: verificationResult([]),
              role,
              evidence,
            };
          }

          if (targeted.status === "NOT_FULLY_VERIFIED" && !targeted.checks.length)
            return { verification: targeted, role, evidence };

          if (!stableCheckRepairUsed) {
            stableCheckRepairUsed = true;
            stageIterations = 0;
            stageTokens = 0;
            stageCost = 0;
            stageStart = Date.now();
            tracker = new ProgressTracker();
            gateway.logger.log("stable_check_repair", {
              subtaskId: subtask.id,
              failedChecks: targeted.checks.filter(
                (check) => check.exitCode !== 0,
              ),
            });
            await startStableTargetedRepair(
              targeted,
              "targeted_verification_failed",
            );
            continue;
          }

          // The same-model repair was attempted and targeted verification still
          // fails. Keep that failure authoritative and let the normal verified
          // quality escalation choose the next model using CURRENT source.
          stableTargetedFailureAfterRepair = true;
        } else if (diff === beforeDiff) {
          stableNoMutationTurns++;
          if (stableNoMutationTurns >= 3)
            throw Error("Stable mutation protocol exhausted without a diff");

          messages.push({
            role: "user",
            content: JSON.stringify({
              currentLockedFiles: await currentLockedFiles(),
              currentDiff: truncateBytes(
                await currentDiff(path),
                gateway.config.context.maxBytes,
              ),
              previousToolResults: messages
                .filter((message) => message.role === "tool")
                .slice(-4)
                .map((message) => String(message.content ?? "")),
              instruction:
                "No workspace mutation was produced. Use the exact current locked source and tool error. Mutate now with apply_patch, edit_file, or write_file; request_context is allowed only if an exact additional locked range is required.",
            }),
          });
          continue;
        }
      }

      if (options.tinyDirect && diff === beforeDiff && !diff.trim()) {
        tinyNoMutationTurns++;
        if (adaptiveTier) {
          tinyBoundedNoMutation = true;
        } else if (tinyNoMutationTurns >= 2) {
          throw Error(
            "Tiny direct task produced no mutation after bounded recovery",
          );
        } else {
          messages.push({
            role: "user",
            content:
              "The first call produced no mutation. The exact target is already in context. Apply the requested edit to the locked path now using the write tool. Do not read, search, inspect, or run commands.",
          });
          continue;
        }
      }
      if (options.stableHandoff && !options.repairPacket) {
        if (diff !== beforeDiff)
          stableNoMutationTurns = Math.max(1, stableNoMutationTurns);
        else {
          stableNoMutationTurns++;
          if (stableNoMutationTurns === 1)
            messages.push({
              role: "user",
              content:
                "Focused implementation reading is complete. Do not search or rediscover. Apply the supplied requiredChange and regressionTest now using the locked write paths.",
            });
        }
      }
      if (
        options.finalVerificationOnly &&
        !options.stableHandoff &&
        !m.tool_calls?.length &&
        diff.trim()
      ) {
        const recovered = postWriteVerification = await checks(true);
        if (recovered.status === "FAILED") verification = recovered;
        else {
        gateway.logger.log("ready_for_final_verification", {
          subtaskId: subtask.id,
          diffBytes: Buffer.byteLength(diff),
        });
        record("NOT_FULLY_VERIFIED");
        return { verification, role, evidence };
        }
      }
      if (
        options.tinyDirect &&
        options.finalVerificationOnly &&
        diff !== beforeDiff &&
        diff.trim() &&
        !failedInlineCheck
      ) {
        const recovered = postWriteVerification = await checks(true);
        if (recovered.status === "FAILED") verification = recovered;
        else {
        gateway.logger.log("ready_for_final_verification", {
          subtaskId: subtask.id,
          diffBytes: Buffer.byteLength(diff),
          reason: "tiny_mutation_complete",
        });
        record("NOT_FULLY_VERIFIED");
        return { verification, role, evidence };
        }
      }
      if (
        options.finalVerificationOnly &&
        options.stableHandoff &&
        !options.repairPacket &&
        (options.stableRepair
          ? diff !== beforeDiff &&
            !failedInlineCheck &&
            gateway.logger.events
              .slice(workerEventStart)
              .some(
                (event) =>
                  event.type === "write_success" &&
                  event.subtaskId === subtask.id,
              )
          : stableReadyForFinalVerification(
              writeScope.paths,
              gateway.logger.events
                .slice(workerEventStart)
                .filter((event) => event.subtaskId === subtask.id),
              diff,
              iterationCommandResults,
            ))
      ) {
        const recovered = postWriteVerification = await checks(true);
        if (recovered.status === "FAILED") verification = recovered;
        else {
        gateway.logger.log("ready_for_final_verification", {
          subtaskId: subtask.id,
          diffBytes: Buffer.byteLength(diff),
          reason: options.stableRepair
            ? "stable_repair_written"
            : "meaningful_scoped_mutation",
        });
        record("NOT_FULLY_VERIFIED");
        return { verification, role, evidence };
        }
      }
      // A failed run_command with no resulting diff is normally a failed
      // mutation attempt (for example an exact-text replacement that did not
      // match). Give Stable a bounded chance to re-read the exact source and
      // retry instead of immediately treating the model as stalled.
      if (
        options.stableHandoff &&
        failedInlineCheck &&
        diff === beforeDiff &&
        stableMutationRepairAttempts < 3
      ) {
        stableMutationRepairAttempts++;
        stableNoMutationTurns = 0;
        stageIterations = 0;
        stageTokens = 0;
        stageCost = 0;
        stageStart = Date.now();
        tracker = new ProgressTracker();

        gateway.logger.log("stable_mutation_repair", {
          subtaskId: subtask.id,
          attempt: stableMutationRepairAttempts,
          command: failedInlineCheck.command,
          exitCode: failedInlineCheck.exitCode,
        });

        startStableMutationRepair("failed_exact_mutation", {
          command: failedInlineCheck.command,
          exitCode: failedInlineCheck.exitCode,
          stdout: truncateBytes(
            failedInlineCheck.stdout ?? "",
            gateway.config.context.toolResultBytes,
          ),
          stderr: truncateBytes(
            failedInlineCheck.stderr ?? "",
            gateway.config.context.toolResultBytes,
          ),
        });
        continue;
      }

      // A real failed check after a mutation still gets one focused repair.
      if (
        options.stableHandoff &&
        failedInlineCheck &&
        !stableCheckRepairUsed
      ) {
        stableCheckRepairUsed = true;
        stableNoMutationTurns = 0;
        stageIterations = 0;
        stageTokens = 0;
        stageCost = 0;
        stageStart = Date.now();
        tracker = new ProgressTracker();

        gateway.logger.log("stable_check_repair", {
          subtaskId: subtask.id,
          command: failedInlineCheck.command,
          exitCode: failedInlineCheck.exitCode,
        });

        messages.push({
          role: "user",
          content:
            "The targeted command failed after a workspace change. Use the failure output to correct the implementation or regression test. Re-read only an exact locked file if necessary. Do not rediscover the task.",
        });
        continue;
      }

      // Stable declared these paths as necessary before coding. If only part of
      // the locked scope has actually been written, explicitly finish the
      // missing artifact instead of allowing generic stall escalation.
      if (
        options.finalVerificationOnly &&
        options.stableHandoff &&
        !options.repairPacket &&
        diff.trim() &&
        !failedInlineCheck &&
        !stableMissingPathNudgeUsed
      ) {
        const writtenPaths = new Set(
          gateway.logger.events
            .slice(workerEventStart)
            .filter(
              (event) =>
                event.type === "write_success" &&
                event.subtaskId === subtask.id,
            )
            .map((event) => event.path),
        );

        const missingWritePaths = writeScope.paths.filter(
          (path) => !writtenPaths.has(path),
        );

        if (missingWritePaths.length) {
          stableMissingPathNudgeUsed = true;
          stableNoMutationTurns = 0;
          stageIterations = 0;
          stageTokens = 0;
          stageCost = 0;
          stageStart = Date.now();
          tracker = new ProgressTracker();

          gateway.logger.log("stable_missing_write_paths", {
            subtaskId: subtask.id,
            missing_write_paths: missingWritePaths,
          });

          messages.push({
            role: "user",
            content:
              "The implementation is only partially complete. The following locked files still require the declared change/regression test: " +
              JSON.stringify(missingWritePaths) +
              ". Finish those exact files now. Do not revisit completed files unless verification proves they are wrong.",
          });
          continue;
        }
      }

      if (
        options.stableHandoff &&
        tools.actions.length === actionStart &&
        diff === beforeDiff &&
        stableNoMutationTurns > 1 &&
        !stableActionRepairUsed
      ) {
        stableActionRepairUsed = true;
        gateway.logger.log("stable_action_repair", {
          subtaskId: subtask.id,
          reason: "required_tool_call_missing",
        });
        startStableMutationRepair("required_tool_call_missing");
        continue;
      }
      const verificationExecuted =
        diff !== beforeDiff ||
        iterationCommandResults.some((result: any) => commands.includes(result.command));
      let after =
        options.stableHandoff &&
        options.repairPacket &&
        stableTargetedFailureAfterRepair
          ? verification
          : verificationExecuted
            ? postWriteVerification ?? await checks(true)
            : verification;
      if (diff.trim()) {
        after = verificationAgainstBaseline(baselineVerification, after);
        if (after.checks.some((check) => check.source?.endsWith(":baseline_unchanged")))
          gateway.logger.log("verification_baseline_unchanged", {
            subtaskId: subtask.id,
            failingCommands: after.checks.filter((check) => check.source?.endsWith(":baseline_unchanged"))
              .map((check) => check.command),
          });
      }
      const currentInfrastructureError = infrastructureError(after);
      if (currentInfrastructureError) {
        infrastructureFailure = true;
        verification = after;
        gateway.logger.log("verification_infrastructure_failure", {
          subtaskId: subtask.id,
          error: currentInfrastructureError,
          checks: after.checks,
        });
        throw Error(
          `Verification infrastructure unavailable: ${currentInfrastructureError}`,
        );
      }
      if (
        after.status === "VERIFIED_SUCCESS" &&
        verificationExecuted &&
        (diff !== beforeDiff ||
          (objectiveCanBeAlreadySatisfied(subtask) &&
            workerChecksAreTaskSpecific(subtask, profile, context)))
      ) {
        gateway.logger.log("verified_completion", {
          subtaskId: subtask.id,
          reason: "acceptance_checks_passed",
          diffBytes: Buffer.byteLength(diff),
        });
        verification = after;
        attemptCheckpoint = await AttemptCheckpoint.capture(path, writeScope);
        gateway.logger.log("attempt_checkpoint_promoted", { subtaskId: subtask.id, model: activeModel() });
        record(after.status);
        return { verification: after, role, evidence };
      }
      if (
        !options.finalVerificationOnly &&
        after.status === "NOT_FULLY_VERIFIED" &&
        (!m.tool_calls?.length || diff !== beforeDiff)
      ) {
        verification = after;
        record(after.status);
        return { verification: after, role, evidence };
      }
      const taskSpecificFailure = workerChecksAreTaskSpecific(subtask, profile, context) ||
        /\b(?:tests?|checks?)\s+(?:must\s+)?pass\b/i.test(`${task} ${subtask.objective} ${subtask.integrationContract}`);
      const baselineUnchangedFailure = after.status === "FAILED" &&
          baselineVerification.checks.some((check) => check.outcome === "CHECK_FAIL") &&
          !verificationRegressed(baselineVerification, after);
      const repeatedAcceptanceCheck = iterationCommandResults.some((result: any) =>
        after.checks.some((check) => check.command === result.command));
      if (!diff.trim() && repeatedAcceptanceCheck && baselineUnchangedFailure) {
        gateway.logger.log("verification_baseline_unchanged", {
          subtaskId: subtask.id,
          failingCommands: after.checks.filter((check) => check.outcome === "CHECK_FAIL").map((check) => check.command),
          reason: "post_attempt_check_without_mutation",
        });
        verification = { ...after, status: "NOT_FULLY_VERIFIED" };
        record(verification.status);
        return { verification, role, evidence };
      }
      if (diff.trim() && baselineUnchangedFailure && !taskSpecificFailure) {
        gateway.logger.log("verification_baseline_unchanged", {
          subtaskId: subtask.id,
          failingCommands: after.checks.filter((check) => check.outcome === "CHECK_FAIL").map((check) => check.command),
        });
        verification = { ...after, status: "NOT_FULLY_VERIFIED" };
        record(verification.status);
        return { verification, role, evidence };
      }
      const assessment = tracker.assess(
        verification,
        after,
        diff,
        tools.actions.slice(actionStart),
        after !== verification,
        options.stableHandoff && diff === beforeDiff
          ? []
          : tools.progressEvidence.slice(evidenceStart),
        diff !== beforeDiff,
      );
      verification = after;
      const attemptChanges = await attemptCheckpoint.changed(path, writeScope);
      const attemptHasMutation = attemptChanges.length > 0;
      const attributableRegression = attemptHasMutation && after.status === "FAILED" &&
        verificationRegressed(baselineVerification, after);
      gateway.logger.log("attempt_evaluation", {
        subtaskId: subtask.id,
        model: activeModel(),
        changedPaths: attemptChanges.map((change) => change.path),
        verification: after.status,
        baselineRegressed: attributableRegression,
      });
      gateway.logger.log("progress", {
        subtaskId: subtask.id,
        iteration,
        ...assessment,
      });
      const verifiedQualityFailure =
        (!!adaptiveTier || specialistCascade.length > 0) &&
        (tinyBoundedNoMutation ||
          (attributableRegression && qualityFailure(after.checks, assessment.escalate && !searchRecoveryTriggered) &&
            (diff !== beforeDiff || (assessment.escalate && !searchRecoveryTriggered))));
      const frontierNoProgress =
        role === "FRONTIER_MODEL" &&
        diff === beforeDiff &&
        stageIterations >= 2 && !searchRecoveryTriggered;
      if (
        stableTargetedFailureAfterRepair ||
        (attemptHasMutation && after.status === "FAILED") ||
        attributableRegression ||
        verifiedQualityFailure ||
        (assessment.escalate && !searchRecoveryTriggered) ||
        frontierNoProgress ||
        (!gateway.config.forceModel &&
          (stageIterations >= 6 ||
            stageTokens >= gateway.config.stageMaxTokens ||
            stageCost >= gateway.config.stageMaxUsd)) ||
        Date.now() - stageStart >= gateway.config.stageMaxMinutes * 60000
      ) {
        if (gateway.config.forceModel && diff === beforeDiff && genericNoMutationTurns >= 2)
          throw Error("Forced model stalled without verified completion");
        const failedAttemptDiff = attemptHasMutation
          ? truncateBytes(diff, gateway.config.context.maxBytes)
          : "";
        const failedAttemptChecks = attributableRegression
          ? compactVerification(after).checks.filter((check) => check.exitCode !== 0)
          : [];
        if (attemptHasMutation) {
          const reverted = await attemptCheckpoint.restore(path, writeScope);
          gateway.logger.log("attempt_rollback", {
            subtaskId: subtask.id, model: activeModel(),
            changedPaths: reverted.map((change) => change.path),
            reason: attributableRegression ? "verification_regression" : "unaccepted_mutation",
          });
          verification = baselineVerification;
        }
        const attemptReason = attributableRegression
          ? "focused_verification_failed"
          : attemptHasMutation ? "unverified_mutation" : "no_mutation";
        let next = router.escalate(role);
        const previousModel = activeModel();
        if (adaptiveTier) {
          const previousTier = adaptiveTier;
          const higher = nextCodingTier(previousTier);
          if (!higher)
            throw Error("Frontier stalled without verified completion");
          record(attributableRegression ? "FAILED" : "NOT_FULLY_VERIFIED",
            attributableRegression, attemptReason);
          adaptiveTier = higher;
          adaptiveAttempt++;
          adaptiveProviderRetry = 0;
          if (higher === "frontier") {
            if (!pool)
              throw Error("Frontier rescue requires a configured model pool");
            selected = await pool.selectFrontierRescue(features, subtask.id);
          } else selected = undefined;
          next =
            higher === "frontier"
              ? "FRONTIER_MODEL"
              : higher === "high"
                ? "STRONG_MODEL"
                : "CHEAP_CODER_A";
          gateway.logger.log("coding_quality_escalation", {
            subtaskId: subtask.id,
            from: previousTier,
            to: higher,
            reason: attemptReason,
            verification: after.status,
          });
        } else if (pool && selected) {
          const previousCandidate = selected;
          record(attributableRegression ? "FAILED" : "NOT_FULLY_VERIFIED",
            attributableRegression, attemptReason);
          excluded.push(previousCandidate.model.id);
          try {
            selected = specialistCascade.length
              ? specialistIndex + 1 < specialistCascade.length
                ? specialistCascade[++specialistIndex]
                : previousCandidate.model.tier === "frontier"
                  ? undefined
                  : await pool.selectFrontierRescue(features, subtask.id)
              : await pool.select(
                  features,
                  subtask.id,
                  excluded,
                  previousCandidate.model,
                  true,
                );
            if (!selected || selected.model.id === previousCandidate.model.id)
              throw Error("No stronger eligible coding candidate remains");
            next = poolRole();
            gateway.logger.log("coding_route_escalation", {
              subtaskId: subtask.id,
              from: previousCandidate.model.id,
              to: selected!.model.id,
              to_role: selected!.model.tier === "frontier" ? "FRONTIER_MODEL" : poolRole(),
              reason: attemptReason,
            });
          } catch (error) {
            if (
              options.stableHandoff &&
              stableActionRepairUsed &&
              !stableSameModelRetryUsed
            ) {
              stableSameModelRetryUsed = true;
              selected = previousCandidate;
              role = poolRole();
              stageIterations = 0;
              stageTokens = 0;
              stageCost = 0;
              stageStart = Date.now();
              tracker = new ProgressTracker();

              gateway.logger.log("stable_same_model_retry", {
                subtaskId: subtask.id,
                model: previousCandidate.model.id,
                reason: String(error),
              });

              startStableMutationRepair("no_fallback_candidate");
              continue;
            }

            throw error;
          }
        } else {
          while (next && gateway.config.registry[next] === previousModel)
            next = router.escalate(next);
        }
        if (!next) throw Error("Frontier stalled without verified completion");
        const handoff: HandoffPacket = {
          originalObjective: subtask.objective,
          acceptanceCriteria,
          relevantFiles: evidence.relevantFiles,
          currentDiff: truncateBytes(await currentDiff(path), gateway.config.context.maxBytes),
          reproduction: evidence.reproduction,
          verificationFailures: failedAttemptChecks,
          approachesAlreadyAttempted: [
            ...attempted.slice(-6),
            ...tools.actions.slice(-12),
            ...(failedAttemptDiff ? [`REJECTED ATTEMPT DIFF (already rolled back):\n${failedAttemptDiff}`] : []),
          ],
          disprovenHypotheses: [],
          remainingProblem: `${verification.failedChecks} checks failing; ${assessment.noProgressCycles} cycles without measured improvement`,
        };
        gateway.logger.log("escalation", {
          subtaskId: subtask.id,
          from: role,
          to: next,
          previous_model: previousModel,
          selected_model: selected?.model.id ?? gateway.config.registry[next],
          previous_verification: verification,
          previous_cost: stageCost,
          reason: attemptReason,
          assessment,
          handoff,
        });
        role = next;
        terminalAttemptRecorded = false;
        stageIterations = 0;
        stageTokens = 0;
        stageCost = 0;
        stageStart = Date.now();
        tracker = new ProgressTracker();
        stableTargetedFailureAfterRepair = false;
        genericNoMutationTurns = 0;
        if (options.tinyDirect) tinyNoMutationTurns = 0;
        start(handoff);
        if (options.stableHandoff && options.repairPacket)
          messages.push({
            role: "user",
            content: JSON.stringify({
              currentLockedFiles: await currentLockedFiles(),
              currentDiff: truncateBytes(
                await currentDiff(path),
                gateway.config.context.maxBytes,
              ),
              instruction:
                "Continue from the CURRENT modified source. Do not overwrite it from stale context.",
            }),
          });
        attemptCheckpoint = await AttemptCheckpoint.capture(path, writeScope);
        gateway.logger.log("attempt_checkpoint_created", { subtaskId: subtask.id, model: activeModel() });
      } else
        messages.push({
          role: "user",
          content: JSON.stringify({
            verification: compactVerification(verification),
            assessment,
            instruction:
              "Continue using tools. When implementation is complete, give a concise final answer.",
          }),
        });
    }
    throw Error("Subtask iteration budget exhausted");
  } finally {
    if (!infrastructureFailure && !terminalAttemptRecorded) {
      const unaccepted = await attemptCheckpoint.changed(path, writeScope);
      const regressed = unaccepted.length > 0 && verification.status === "FAILED" &&
        verificationRegressed(baselineVerification, verification);
      record(regressed ? "FAILED" : "NOT_FULLY_VERIFIED", false,
        unaccepted.length ? "unaccepted_mutation" : "no_mutation");
      if (unaccepted.length) {
        await attemptCheckpoint.restore(path, writeScope);
        gateway.logger.log("attempt_rollback", {
          subtaskId: subtask.id, model: activeModel(),
          changedPaths: unaccepted.map((change) => change.path),
          reason: "worker_ended_without_acceptance",
        });
      }
    }
    gateway.logger.log("coding_worker_stop", {
      subtaskId: subtask.id,
      worktree: path,
    });
  }
}

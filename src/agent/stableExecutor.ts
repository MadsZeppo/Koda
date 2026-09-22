import { readFile } from "node:fs/promises";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import type { Gateway } from "../openrouter/client.js";
import { canFallback } from "../openrouter/client.js";
import type { Candidate } from "../router/modelRouter.js";
import { supportsParameters } from "../router/pool.js";
import { extractFeatures } from "../router/features.js";
import { taskFingerprint } from "../router/taskFingerprint.js";
import type { Role } from "../router/modelRegistry.js";
import type { Subtask, Plan, EvidencePacket } from "../planner/schemas.js";
import type { RepoProfile, VerificationResult } from "../types.js";
import { isTestPath, type WorkerContext } from "../context/compiler.js";
import { boundMessages, truncateBytes } from "../context/bounds.js";
import { advisoryInfrastructureOnly, verify, verificationResult, verificationRegressed, verificationAgainstBaseline } from "../verifier/verifier.js";
import { workerChecks, workerChecksAreTaskSpecific } from "../verifier/selection.js";
import { recoverPostMutationChecks } from "../verifier/recovery.js";
import type { VerificationCandidate } from "../repo/ecosystem.js";
import { WriteScope } from "../repo/writeScope.js";

import {
  AgentTools,
  currentDiff,
  requestContextTool,
  safePath,
  toolDefinitions,
} from "./tools.js";
import { coderPrompt } from "./prompts.js";
import type { StableImplementationHandoff } from "./stable.js";
import type { RepairPacket } from "./repairPacket.js";
import { STABLE_EVENTS } from "./executionEvents.js";
import { AttemptCheckpoint } from "./attemptCheckpoint.js";
import { taskRelevantMutationPaths, testRequirementAlreadyCovered } from "./mutationInvariant.js";
import { retrieveSourceGrounding } from "../context/sourceGrounding.js";

export interface StablePacketOptions {
  evidence?: EvidencePacket;
  compiledContext?: WorkerContext;
  selectedCandidate?: Candidate;
  model?: string;
  stableHandoff: StableImplementationHandoff;
  repairPacket: RepairPacket;
  raceGroup?: string;
  stop?: () => boolean;
}

const orderedTools = (names: readonly string[]) =>
  names
    .map((name) =>
      name === "request_context"
        ? requestContextTool
        : toolDefinitions.find((tool: any) => tool.function.name === name),
    )
    .filter((tool): tool is (typeof toolDefinitions)[number] => !!tool);

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

export async function implementStablePacket(
  gateway: Gateway,
  path: string,
  task: string,
  subtask: Subtask,
  _plan: Pick<Plan, "acceptanceCriteria"> & Partial<Pick<Plan, "subtasks">>,
  profile: RepoProfile,
  options: StablePacketOptions,
) {
  const writeScope = new WriteScope(
    subtask.likelyWritePaths,
    gateway.logger,
    subtask.id,
  );
  const evidence: EvidencePacket = options.evidence ?? {
    relevantFiles: options.repairPacket.files.map((file) => file.path),
    symbols: [],
    reproduction: "Stable inspection and RepairPacket are authoritative",
    failingTests: [],
    likelyRootCause: "Localized by Stable inspection",
    dependencies: subtask.dependsOn,
    uncertainty: "low",
    suggestedApproach: "Mutate locked source, then run focused verification",
    evidence: [],
  };

  // Focused verification must stay genuinely task-local. Broad repository
  // checks belong to authoritative final verification in run.ts; running them
  // here prevents the bounded final-repair lifecycle from ever seeing failures.
  const inferredFocused =
    options.compiledContext &&
    workerChecksAreTaskSpecific(subtask, profile, options.compiledContext)
      ? workerChecks(subtask, profile, options.compiledContext)
      : [];
  let focusedCommands =
    subtask.verificationCommands.length > 0
      ? subtask.verificationCommands
      : inferredFocused;
  const recoveredCandidates: VerificationCandidate[] = [];
  let recoveryAttempted = false;

  const selectionCommands = options.repairPacket.verificationCommands.length
    ? options.repairPacket.verificationCommands
    : focusedCommands;

  gateway.logger.log("verification_selection", {
    subtaskId: subtask.id,
    commands: selectionCommands,
    focusedCommands,
    selectedChecks: focusedCommands.map((command) => ({
      command,
      source: subtask.verificationCommands.includes(command)
        ? "subtask:verificationCommands"
        : options.repairPacket.verificationCommands.includes(command)
          ? "repairPacket:verificationCommands"
          : "verificationPlan:focused",
    })),
    candidates: profile.ecosystem?.projectUnits
      .flatMap((unit) => unit.verification)
      .filter((candidate) => focusedCommands.includes(candidate.command)),
  });

  // An explicit test-only request can already be present in the repository.
  // Prove that from assertion code plus its passing focused check before model
  // selection; a green suite alone or matching filenames are insufficient.
  const lockedTestFiles = await Promise.all(writeScope.paths.filter(isTestPath).map(async (file) => ({
    path: file,
    content: await readFile(await safePath(path, file), "utf8").catch(() => ""),
  })));
  const coveredTestRequirement = testRequirementAlreadyCovered(task, lockedTestFiles);
  const baselineCommands = focusedCommands.length
    ? focusedCommands
    : coveredTestRequirement ? selectionCommands.slice(0, 1) : [];
  const baselineFocused = baselineCommands.length
    ? await verify(path, baselineCommands,
        () => Math.min(gateway.config.commandTimeoutMs, gateway.budget.remainingMs()),
        (check) => gateway.logger.log("stable_focused_baseline", { subtaskId: subtask.id, ...check }),
        writeScope, profile.ecosystem?.projectUnits.flatMap((unit) => unit.verification))
    : verificationResult([]);
  const baselineInfra = infrastructureError(baselineFocused);
  if (baselineInfra) throw Error(`Verification infrastructure unavailable: ${baselineInfra}`);
  if (baselineFocused.status === "VERIFIED_SUCCESS" &&
      coveredTestRequirement) {
    gateway.logger.log("worker_scope", {
      subtaskId: subtask.id, phase: "implementation", read_only: false,
      allowed_write_paths: writeScope.paths,
      context_files: [...new Set([
        ...(options.compiledContext?.files.map((file) => file.path) ?? []),
        ...options.repairPacket.definitions.map((definition) => definition.path),
      ])],
    });
    gateway.logger.log("no_changes_required", {
      subtaskId: subtask.id, status: "VERIFIED_SUCCESS",
      reason: "acceptance_checks_already_pass",
      diffBytes: 0, verificationCommands: baselineFocused.checks.map((check) => check.command),
    });
    return { verification: baselineFocused, role: "CHEAP_CODER_A" as Role,
      evidence, noChangesRequired: true };
  }

  const contextPaths = [
    ...new Set([
      ...options.repairPacket.importLinks.map(([, dependency]) => dependency),
      ...options.repairPacket.definitions.map((definition) => definition.path),
    ].filter((file) => !writeScope.paths.includes(file))),
  ];
  const baseSystem =
    coderPrompt +
    "\nInspection is complete. Implement the change now." +
    "\nThe RepairPacket contains the locked file contents needed for implementation." +
    "\nDo not read, search, inspect, or run commands." +
    "\nYOUR ONLY TASK: " + subtask.objective +
    "\nWRITE RESPONSIBILITY: " + JSON.stringify(writeScope.paths);
  let messages: ChatCompletionMessageParam[] = [
    { role: "system", content: baseSystem },
    {
      role: "user",
      content: JSON.stringify({
        task,
        repairPacket: options.repairPacket,
        inspectionHandoff: options.stableHandoff,
        allowed_write_paths: writeScope.paths,
        instruction:
          "Use the supplied grounded definitions before calling unfamiliar APIs. request_context may retrieve one listed definition if its bounded excerpt is insufficient; otherwise mutate with apply_patch, edit_file, or write_file.",
      }),
    },
  ];
  const initialTools = orderedTools([
    "apply_patch", "edit_file", "write_file",
    ...(contextPaths.length ? ["request_context"] : []),
  ]);
  const features = extractFeatures(
    subtask,
    profile,
    Buffer.byteLength(JSON.stringify({
      messages: boundMessages(messages, gateway.config.context.maxPromptBytes),
      tools: initialTools,
    })),
    baselineFocused,
    "stable",
  );
  const effort = gateway.logger.events.findLast((event) => event.type === "execution_strategy")
    ?.execution_effort ?? (subtask.estimatedDifficulty === "high" ? "complex"
      : subtask.estimatedDifficulty === "low" ? "tiny" : "normal");
  const fingerprint = taskFingerprint(
    subtask,
    profile,
    features,
    effort,
    baselineFocused,
  );
  gateway.logger.log("task_fingerprint", {
    subtaskId: subtask.id,
    fingerprint,
  });

  const pool = gateway.modelRouter;
  const universalSelection = gateway.config.specialistRouting && !!pool &&
    !gateway.config.forceModel && !options.selectedCandidate && !options.model;
  const specialistCascade = universalSelection
    ? await pool!.selectSpecialist(fingerprint, features, subtask.id,
        gateway.budget.remainingUsd(), options.raceGroup)
    : [];
  if (universalSelection && !specialistCascade.length)
    throw Error("No compatible priced model fits the required protocol, context, and remaining budget");
  let specialistIndex = 0;
  let selected = specialistCascade[0] ?? options.selectedCandidate;
  let explicitModel = options.model;
  let role: Role =
    selected?.model.tier === "frontier"
      ? "FRONTIER_MODEL"
      : selected?.model.tier === "strong"
        ? "STRONG_MODEL"
        : "CHEAP_CODER_A";
  const excluded: string[] = [];
  const requiresToolChoice = (candidate: Candidate | undefined) =>
    !!candidate && supportsParameters(candidate.metadata, ["tools", "tool_choice"]);

  const selectFallbackCandidate = async (
    previous: Candidate["model"],
  ): Promise<Candidate | undefined> => {
    if (!pool) return undefined;
    if (universalSelection) {
      while (specialistIndex + 1 < specialistCascade.length) {
        const specialist = specialistCascade[++specialistIndex]!;
        if (excluded.includes(specialist.model.id)) continue;
        if (requiresToolChoice(specialist)) return specialist;
        excluded.push(specialist.model.id);
      }
    }
    const fallback = await pool.select(
      features,
      subtask.id,
      excluded,
      previous,
      true,
      options.raceGroup,
    );
    if (!fallback || excluded.includes(fallback.model.id) || !requiresToolChoice(fallback))
      return undefined;
    return fallback;
  };

  if (!selected && !explicitModel && pool && !universalSelection) {
    selected = await pool.select(features, subtask.id);
  }
  if (selected && pool && !requiresToolChoice(selected)) {
    while (selected && !requiresToolChoice(selected)) {
      const previous: Candidate["model"] = selected.model;
      if (!excluded.includes(previous.id)) excluded.push(previous.id);
      const nextSelected = await selectFallbackCandidate(previous);
      if (!nextSelected) throw Error("No tool_choice-compatible Stable coding model available");
      if (excluded.includes(nextSelected.model.id))
        throw Error("No tool_choice-compatible Stable coding model available");
      selected = nextSelected;
    }
  }
  if (selected) {
    role =
      selected.model.tier === "frontier"
        ? "FRONTIER_MODEL"
        : selected.model.tier === "strong"
          ? "STRONG_MODEL"
          : selected.model.id === gateway.config.registry.CHEAP_CODER_B
            ? "CHEAP_CODER_B"
            : "CHEAP_CODER_A";
  }

  const activeModel = () =>
    selected?.model.id ?? explicitModel ?? gateway.config.registry[role];

  const configuredFallback = (): boolean => {
    const roles: Role[] = [
      "CHEAP_CODER_A",
      "CHEAP_CODER_B",
      "STRONG_MODEL",
      "FRONTIER_MODEL",
    ];
    const current = activeModel();
    let currentIndex = roles.findIndex(
      (candidate) => gateway.config.registry[candidate] === current,
    );
    if (currentIndex < 0) currentIndex = Math.max(0, roles.indexOf(role));
    for (const nextRole of roles.slice(currentIndex + 1)) {
      const nextModel = gateway.config.registry[nextRole];
      if (nextModel && nextModel !== current) {
        selected = undefined;
        explicitModel = undefined;
        role = nextRole;
        gateway.logger.log(STABLE_EVENTS.modelFallback, {
          subtaskId: subtask.id,
          from: current,
          to: nextModel,
          previous_model: current,
          selected_model: nextModel,
          reason: "configured_model_fallback",
        });
        return true;
      }
    }
    return false;
  };

  const packetImplementationFiles = options.repairPacket.files.filter((file) =>
    writeScope.paths.includes(file.path) && !isTestPath(file.path));
  if (writeScope.paths.some((file) => !isTestPath(file)) &&
      (!packetImplementationFiles.length || packetImplementationFiles.some((file) => !file.content.trim())))
    throw Error("Stable implementation context is missing locked source content");
  const tools = new AgentTools(
    path,
    false,
    () => Math.min(gateway.config.commandTimeoutMs, gateway.budget.remainingMs()),
    gateway.logger,
    subtask.id,
    gateway.config.context.toolResultBytes,
    writeScope,
    contextPaths,
  );
  gateway.logger.log("worker_scope", {
    subtaskId: subtask.id,
    phase: "implementation",
    read_only: false,
    allowed_write_paths: writeScope.paths,
    context_files: [...new Set([
      ...(options.compiledContext?.files.map((file) => file.path) ?? []),
      ...contextPaths,
    ])],
  });
  let acceptedCheckpoint = await AttemptCheckpoint.capture(path, writeScope);
  gateway.logger.log("attempt_checkpoint_created", { subtaskId: subtask.id });

  const lockedFiles = async () =>
    Promise.all(
      writeScope.paths.map(async (file) => {
        try {
          const target = await safePath(path, file);
          const content = await readFile(target, "utf8");
          return {
            path: file,
            content: truncateBytes(content, gateway.config.context.fileBytes),
          };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return { path: file, content: "<file does not exist>" };
          throw error;
        }
      }),
    );

  let noMutationTurns = 0;
  let contextRecoveryAvailable = contextPaths.length > 0;
  let contextRecoveryConsumed = false;
  let sameModelRepairUsed = false;
  let sameModelToolRecoveryUsed = false;
  let lastFailedDiff = "";
  let attemptStart = gateway.logger.events.length;

  const recordVerifiedQualityFailure = (reason: string) => {
    if (!selected || !pool) return;
    pool.record(
      selected.model,
      features,
      subtask.id,
      attemptStart,
      "FAILED",
      true,
      reason,
    );
    attemptStart = gateway.logger.events.length;
  };

  const moveToFallback = async (
    reason: string,
    verifiedQualityFailure: boolean,
  ): Promise<boolean> => {
    const previous = activeModel();
    if (verifiedQualityFailure) recordVerifiedQualityFailure(reason);
    if (selected && pool) {
      if (!excluded.includes(selected.model.id)) excluded.push(selected.model.id);
      try {
        const prior = selected.model;
        const nextSelected = await selectFallbackCandidate(prior);
        if (!nextSelected) return false;
        // A pool implementation must honor exclusions, but defend the executor
        // against a stale/buggy selector returning the same exhausted model.
        if (excluded.includes(nextSelected.model.id)) return false;
        selected = nextSelected;
        explicitModel = undefined;
        role =
          selected.model.tier === "frontier"
            ? "FRONTIER_MODEL"
            : selected.model.tier === "strong"
              ? "STRONG_MODEL"
              : selected.model.id === gateway.config.registry.CHEAP_CODER_B
                ? "CHEAP_CODER_B"
                : "CHEAP_CODER_A";
        gateway.logger.log(STABLE_EVENTS.modelFallback, {
          subtaskId: subtask.id,
          from: previous,
          to: selected.model.id,
          previous_model: previous,
          selected_model: selected.model.id,
          reason,
          verifiedQualityFailure,
        });
        acceptedCheckpoint = await AttemptCheckpoint.capture(path, writeScope);
        gateway.logger.log("attempt_checkpoint_created", { subtaskId: subtask.id, model: activeModel() });
        return true;
      } catch {
        // A configured model pool is authoritative for this run. Do not escape
        // into the unrelated registry ladder after the pool is exhausted.
        return false;
      }
    }
    const moved = configuredFallback();
    if (moved) {
      acceptedCheckpoint = await AttemptCheckpoint.capture(path, writeScope);
      gateway.logger.log("attempt_checkpoint_created", { subtaskId: subtask.id, model: activeModel() });
    }
    return moved;
  };

  const resetToCurrentWorkspace = async (
    reason: string,
    failed?: VerificationResult,
    instruction =
      "Continue from the CURRENT modified workspace. Mutate before any further verification.",
    rejectedDiff = "",
  ) => {
    const relevantDefinitions = failed
      ? await retrieveSourceGrounding(path, writeScope.paths, profile, 4200, failed.checks, task)
      : [];
    messages = [
      { role: "system", content: baseSystem },
      {
        role: "user",
        content: JSON.stringify({
          task,
          ...(!failed ? {
            repairPacket: options.repairPacket,
            inspectionHandoff: options.stableHandoff,
          } : {}),
          allowed_write_paths: writeScope.paths,
          currentLockedFiles: await lockedFiles(),
          currentDiff: truncateBytes(await currentDiff(path), gateway.config.context.maxBytes),
          rejectedAttemptDiff: rejectedDiff,
          failedChecks: failed
            ? failed.checks.filter((check) => check.exitCode !== 0).map((check) => ({
                command: check.command, exitCode: check.exitCode,
                stdout: truncateBytes(check.stdout, 6000),
                stderr: truncateBytes(check.stderr, 6000),
              }))
            : [],
          relevantDefinitions,
          reason,
          instruction,
        }),
      },
    ];
  };

  const runFocusedVerification = async () => {
    // selectionCommands describe checks that were useful for routing/context,
    // but they are not necessarily safe, focused checks. For a source-only
    // mutation, use one structural check rather than sending an invalid patch
    // straight to broad final verification. Coupled source-and-test work keeps
    // its existing final acceptance/repair lifecycle.
    const sourceOnlyMutation = writeScope.paths.every((file) => !isTestPath(file));
    if (!focusedCommands.length && !recoveryAttempted &&
        (!selectionCommands.length || sourceOnlyMutation)) {
      recoveryAttempted = true;
      gateway.logger.log("verification_recovery_attempt", { subtaskId: subtask.id,
        paths: writeScope.paths });
      recoveredCandidates.push(...await recoverPostMutationChecks(
        path, task, writeScope.paths,
        { structuralOnly: selectionCommands.length > 0 },
      ));
      focusedCommands = recoveredCandidates.map((candidate) => candidate.command);
      gateway.logger.log(focusedCommands.length ? "verification_recovery" : "verification_recovery_exhausted", {
        subtaskId: subtask.id, commands: focusedCommands,
      });
    }
    if (!focusedCommands.length) return verificationResult([]);
    const result = await verify(
      path,
      focusedCommands,
      () => Math.min(gateway.config.commandTimeoutMs, gateway.budget.remainingMs()),
      (check) =>
        gateway.logger.log(STABLE_EVENTS.focusedVerification, {
          subtaskId: subtask.id,
          ...check,
        }),
      writeScope,
      [...(profile.ecosystem?.projectUnits.flatMap((unit) => unit.verification) ?? []),
        ...recoveredCandidates].map((candidate) =>
          subtask.verificationCommands.includes(candidate.command)
            ? { ...candidate, requirement: "required" as const }
            : candidate,
        ),
    );
    const infra = infrastructureError(result);
    if (infra) {
      gateway.logger.log("verification_infrastructure_failure", {
        subtaskId: subtask.id,
        error: infra,
        checks: result.checks,
      });
      throw Error(`Verification infrastructure unavailable: ${infra}`);
    }
    gateway.logger.log("stable_focused_verification_summary", {
      subtaskId: subtask.id,
      status: result.status,
      checks: result.checks,
      diffBytes: Buffer.byteLength(await currentDiff(path)),
    });
    return result;
  };

  let lastFocusedFailure: VerificationResult | undefined;
  const rejectCurrentAttempt = async (reason: string) => {
    const rejectedDiff = truncateBytes(await currentDiff(path), gateway.config.context.maxBytes);
    const changed = await acceptedCheckpoint.restore(path, writeScope);
    if (changed.length) gateway.logger.log("attempt_rollback", {
      subtaskId: subtask.id, model: activeModel(),
      changedPaths: changed.map((change) => change.path), reason,
    });
    return rejectedDiff;
  };

  gateway.logger.log("route", { subtaskId: subtask.id, role, model: activeModel() });
  gateway.logger.log("coding_worker_start", { subtaskId: subtask.id, worktree: path });

  try {
    for (let turn = 0; turn < 10; turn++) {
      if (options.stop?.()) throw Error("Speculative attempt superseded");
      if (gateway.budget.remainingMs() <= 1) throw Error("Run time budget exhausted");

      const beforeDiff = await currentDiff(path);
      const allowContext = contextRecoveryAvailable && !contextRecoveryConsumed;
      const toolNames = allowContext
        ? ["apply_patch", "edit_file", "write_file", "request_context"]
        : ["apply_patch", "edit_file", "write_file"];

      let response: any;
      try {
        response = await gateway.call(
          activeModel(),
          boundMessages(messages, gateway.config.context.maxPromptBytes),
          subtask.id,
          "implement",
          turn,
          orderedTools(toolNames),
          { requireTool: true },
        );
      } catch (error) {
        if (!canFallback(error, gateway) || gateway.config.forceModel) throw error;
        const failedModel = activeModel();
        const rejectedDiff = await rejectCurrentAttempt("provider_failure_after_mutation");
        // Move to the next compatible model immediately and give that model its
        // own bounded mutation budget.
        const moved = await moveToFallback(
          `provider_or_protocol_failure: ${String(error)}`,
          false,
        );
        // Provider/protocol failures are infrastructure outcomes: expose them in
        // telemetry without writing them into verified quality history.
        gateway.logger.log("model_attempt", {
          subtaskId: subtask.id,
          modelRequested: failedModel,
          modelServed: null,
          verification: "FAILED",
          escalated: moved,
          reason: moved
            ? `infrastructure fallback succeeded: ${String(error)}`
            : `infrastructure fallback exhausted: ${String(error)}`,
        });
        if (!moved) throw error;
        sameModelRepairUsed = false;
        sameModelToolRecoveryUsed = false;
        noMutationTurns = 0;
        contextRecoveryAvailable = false;
        contextRecoveryConsumed = false;
        await resetToCurrentWorkspace(
          `provider_or_protocol_fallback: ${String(error)}`,
          lastFocusedFailure,
          "The previous model's mutation was rolled back. Implement from the clean accepted source using the rejected attempt as evidence.",
          rejectedDiff,
        );
        turn--;
        continue;
      }

      const toolResults: string[] = [];
      messages.push(response);
      for (const call of (response.tool_calls ?? []).slice(0, 8)) {
        let content: string;
        try {
          if (!toolNames.includes(call.function.name))
            content = `Tool unavailable in this Stable phase: ${call.function.name}`;
          else
            content = await tools.execute(
              call.function.name,
              JSON.parse(call.function.arguments),
            );
        } catch (error) {
          content = `Tool error: ${String(error)}`;
          gateway.logger.log("tool_error", { subtaskId: subtask.id, error: content });
        }
        toolResults.push(content);
        messages.push({ role: "tool", tool_call_id: call.id, content });
      }
      if ((response.tool_calls?.length ?? 0) > 8) throw Error("Tool call limit exceeded");

      const requestedContext = (response.tool_calls ?? []).some(
        (call: any) => call.function?.name === "request_context",
      );
      if (requestedContext) {
        contextRecoveryConsumed = true;
        contextRecoveryAvailable = false;
        gateway.logger.log("stable_context_recovery", {
          subtaskId: subtask.id,
          model: activeModel(),
        });
      }

      const afterDiff = await currentDiff(path);
      if (afterDiff === beforeDiff) {
        if (sameModelRepairUsed && !requestedContext) {
          const deterministicToolError = toolResults.some((result) =>
            /^Tool error:/.test(result) && /oldText|no change|not found|exactly once/i.test(result));
          if (deterministicToolError && !sameModelToolRecoveryUsed) {
            sameModelToolRecoveryUsed = true;
            gateway.logger.log(STABLE_EVENTS.contextRecovery, {
              subtaskId: subtask.id, model: activeModel(),
              reason: "repair_tool_state_refreshed",
            });
            await resetToCurrentWorkspace(
              "repair_tool_state_refreshed",
              lastFocusedFailure,
              "The repair tool could not match stale target text. The current locked files below were re-read locally and are authoritative. Retry once with an exact unique span from this current state.",
            );
            continue;
          }
          const rejectedDiff = await rejectCurrentAttempt("same_model_repair_no_mutation");
          const moved = await moveToFallback(
            "same-model repair produced no mutation after focused failure",
            !!lastFocusedFailure && verificationRegressed(baselineFocused, lastFocusedFailure),
          );
          if (!moved) throw Error("Stable mutation protocol exhausted without a diff");
          sameModelRepairUsed = false;
          sameModelToolRecoveryUsed = false;
          noMutationTurns = 0;
          contextRecoveryConsumed = false;
          await resetToCurrentWorkspace("same_model_repair_no_mutation_model_fallback",
            lastFocusedFailure,
            "The failed patch was rolled back. Implement from the clean accepted source using the rejected attempt as evidence.",
            rejectedDiff);
          continue;
        }
        if (requestedContext) {
          messages.push({
            role: "user",
            content:
              "Context recovery is complete; your next response MUST call apply_patch, edit_file, or write_file and mutate the locked workspace.",
          });
          continue;
        }
        noMutationTurns++;
        if (noMutationTurns >= 2) {
          const moved = await moveToFallback(
            "bounded no-mutation protocol exhausted for current model",
            true,
          );
          if (!moved) throw Error("Stable mutation protocol exhausted without a diff");
          noMutationTurns = 0;
          contextRecoveryAvailable = false;
          contextRecoveryConsumed = false;
          await resetToCurrentWorkspace("no_mutation_model_fallback");
          continue;
        }
        // A stale/no-op mutation is a target-file state problem. Re-read the
        // locked file locally and replace the conversation with one compact
        // retry packet; do not offer repository context or resend the original
        // unchanged RepairPacket.
        contextRecoveryAvailable = false;
        contextRecoveryConsumed = true;
        gateway.logger.log(STABLE_EVENTS.contextRecovery, {
          subtaskId: subtask.id,
          model: activeModel(),
          reason: "mutation_produced_no_diff",
        });
        messages = [{ role: "system", content: baseSystem }, {
          role: "user",
          content: JSON.stringify({
            task,
            allowed_write_paths: writeScope.paths,
            currentLockedFiles: await lockedFiles(),
            currentDiff: truncateBytes(await currentDiff(path), gateway.config.context.maxBytes),
            previousToolResults: toolResults,
            instruction:
              "No filesystem diff was produced. currentLockedFiles was re-read from disk and is authoritative. Do not reuse stale oldText unless it appears there. Correct the exact tool error and mutate now; no further context request is available for this target-state retry.",
          }),
        }];
        continue;
      }

      gateway.logger.log(STABLE_EVENTS.mutation, {
        subtaskId: subtask.id,
        model: activeModel(),
        diffBytes: Buffer.byteLength(afterDiff),
      });
      noMutationTurns = 0;
      contextRecoveryAvailable = false;
      contextRecoveryConsumed = false;

      const focused = verificationAgainstBaseline(baselineFocused, await runFocusedVerification());
      if (focused.status === "VERIFIED_SUCCESS" ||
          advisoryInfrastructureOnly(focused) || !focusedCommands.length) {
        const attemptChanges = await acceptedCheckpoint.changed(path, writeScope);
        const relevantMutation = taskRelevantMutationPaths(
          task, writeScope.paths, attemptChanges,
        );
        if (!relevantMutation.length) {
          gateway.logger.log("stable_mutation_invariant_rejected", {
            subtaskId: subtask.id,
            model: activeModel(),
            reason: attemptChanges.length ? "test_only_mutation" : "repair_returned_to_baseline",
            changedPaths: attemptChanges.map((change) => change.path),
          });
          if (!sameModelRepairUsed) {
            sameModelRepairUsed = true;
            sameModelToolRecoveryUsed = false;
            gateway.logger.log(STABLE_EVENTS.sameModelRepair, {
              subtaskId: subtask.id,
              model: activeModel(),
              reason: "missing_task_relevant_implementation_mutation",
            });
            await resetToCurrentWorkspace(
              "missing_task_relevant_implementation_mutation",
              undefined,
              "Focused checks pass, but this implementation task still has no implementation-file mutation. Modify a locked non-test file now; changing tests alone cannot complete the task.",
            );
            continue;
          }
          const rejectedDiff = await rejectCurrentAttempt("repair_returned_to_baseline");
          const moved = await moveToFallback(
            "same-model repair returned to baseline without solving the task",
            true,
          );
          if (!moved)
            throw Error("Stable mutation protocol exhausted without a task-relevant implementation diff");
          sameModelRepairUsed = false;
          sameModelToolRecoveryUsed = false;
          noMutationTurns = 0;
          contextRecoveryConsumed = false;
          await resetToCurrentWorkspace(
            "repair_to_baseline_model_fallback",
            lastFocusedFailure,
            "The previous model restored baseline without solving the task. Produce a real implementation-file mutation from the clean source.",
            rejectedDiff || lastFailedDiff,
          );
          continue;
        }
        if (focused.status === "VERIFIED_SUCCESS") {
          acceptedCheckpoint = await AttemptCheckpoint.capture(path, writeScope);
          gateway.logger.log("attempt_checkpoint_promoted", {
            subtaskId: subtask.id, model: activeModel(), relevantMutation,
          });
        }
        gateway.logger.log(STABLE_EVENTS.readyForFinal, {
          subtaskId: subtask.id,
          diffBytes: Buffer.byteLength(afterDiff),
          reason: "focused_check_passed_final_verification_pending",
        });
        return { verification: verificationResult([]), role, evidence };
      }

      if (!sameModelRepairUsed) {
        lastFocusedFailure = focused;
        lastFailedDiff = afterDiff;
        sameModelRepairUsed = true;
        sameModelToolRecoveryUsed = false;
        gateway.logger.log(STABLE_EVENTS.sameModelRepair, {
          subtaskId: subtask.id,
          model: activeModel(),
          failedChecks: focused.failedChecks,
        });
        await resetToCurrentWorkspace(
          "focused_verification_failed_same_model_repair",
          focused,
          "Fix the focused verification failure in the CURRENT source now. Your next response MUST call apply_patch, edit_file, or write_file.",
        );
        continue;
      }

      const rejectedDiff = await rejectCurrentAttempt("focused_verification_failed");
      const moved = await moveToFallback(
        "focused verification still failing after same-model repair",
        verificationRegressed(baselineFocused, focused),
      );
      if (!moved) return { verification: focused, role, evidence };
      sameModelRepairUsed = false;
      sameModelToolRecoveryUsed = false;
      await resetToCurrentWorkspace(
        "focused_verification_failed_model_fallback",
        focused,
        "The failed patch was rolled back. Implement from the clean accepted source using the rejected attempt and failed check as evidence.",
        rejectedDiff,
      );
    }
    throw Error("Stable mutation protocol exhausted without verified completion");
  } finally {
    gateway.logger.log("coding_worker_stop", { subtaskId: subtask.id, worktree: path });
  }
}

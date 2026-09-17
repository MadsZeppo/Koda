import { readFile } from "node:fs/promises";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import type { Gateway } from "../openrouter/client.js";
import { canFallback } from "../openrouter/client.js";
import type { Candidate } from "../router/modelRouter.js";
import { extractFeatures } from "../router/features.js";
import { taskFingerprint } from "../router/taskFingerprint.js";
import type { Role } from "../router/modelRegistry.js";
import type { Subtask, Plan, EvidencePacket } from "../planner/schemas.js";
import type { RepoProfile, VerificationResult } from "../types.js";
import type { WorkerContext } from "../context/compiler.js";
import { boundMessages, truncateBytes } from "../context/bounds.js";
import { verify, verificationResult } from "../verifier/verifier.js";
import { workerChecks, workerChecksAreTaskSpecific } from "../verifier/selection.js";
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
      check.outcome === "INFRA_FAILURE" ||
      (check.outcome === "CHECK_UNAVAILABLE" &&
        check.unavailable !== "unsafe_verification_command"),
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
  const focusedCommands =
    subtask.verificationCommands.length > 0
      ? subtask.verificationCommands
      : inferredFocused;

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

  const features = extractFeatures(
    subtask,
    profile,
    Buffer.byteLength(JSON.stringify(options.compiledContext ?? options.repairPacket)),
    verificationResult([]),
    "stable",
  );
  const fingerprint = taskFingerprint(
    subtask,
    profile,
    features,
    "normal",
  );
  gateway.logger.log("task_fingerprint", {
    subtaskId: subtask.id,
    fingerprint,
  });

  const pool = gateway.modelRouter;
  let selected = options.selectedCandidate;
  let explicitModel = options.model;
  let role: Role =
    selected?.model.tier === "frontier"
      ? "FRONTIER_MODEL"
      : selected?.model.tier === "strong"
        ? "STRONG_MODEL"
        : "CHEAP_CODER_A";
  const excluded: string[] = [];
  const requiresToolChoice = (candidate: Candidate | undefined) =>
    !candidate?.metadata.supportedParameters ||
    (candidate.metadata.supportedParameters.includes("tools") &&
      candidate.metadata.supportedParameters.includes("tool_choice"));

  if (!selected && !explicitModel && pool) {
    selected = await pool.select(features, subtask.id);
  }
  if (selected && pool && !requiresToolChoice(selected)) {
    while (selected && !requiresToolChoice(selected)) {
      const previous = selected.model;
      if (!excluded.includes(previous.id)) excluded.push(previous.id);
      const nextSelected = await pool.select(
        features,
        subtask.id,
        excluded,
        previous,
        true,
        options.raceGroup,
      );
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

  const contextPaths = [
    ...new Set(options.repairPacket.importLinks.map(([, dependency]) => dependency)),
  ];
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
          "Your first action MUST call apply_patch, edit_file, or write_file and mutate the locked workspace.",
      }),
    },
  ];

  let noMutationTurns = 0;
  let contextRecoveryAvailable = false;
  let contextRecoveryConsumed = false;
  let sameModelRepairUsed = false;
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
        const nextSelected = await pool.select(
          features,
          subtask.id,
          excluded,
          prior,
          true,
          options.raceGroup,
        );
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
        return true;
      } catch {
        // A configured model pool is authoritative for this run. Do not escape
        // into the unrelated registry ladder after the pool is exhausted.
        return false;
      }
    }
    const moved = configuredFallback();
    return moved;
  };

  const resetToCurrentWorkspace = async (
    reason: string,
    failed?: VerificationResult,
    instruction =
      "Continue from the CURRENT modified workspace. Mutate before any further verification.",
  ) => {
    messages = [
      { role: "system", content: baseSystem },
      {
        role: "user",
        content: JSON.stringify({
          task,
          repairPacket: options.repairPacket,
          inspectionHandoff: options.stableHandoff,
          allowed_write_paths: writeScope.paths,
          currentLockedFiles: await lockedFiles(),
          currentDiff: truncateBytes(await currentDiff(path), gateway.config.context.maxBytes),
          failedChecks: failed
            ? failed.checks.filter((check) => check.exitCode !== 0)
            : [],
          reason,
          instruction,
        }),
      },
    ];
  };

  const runFocusedVerification = async () => {
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
      profile.ecosystem?.projectUnits.flatMap((unit) => unit.verification),
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
        // Provider/protocol failures are infrastructure outcomes: expose them in
        // telemetry without writing them into verified quality history.
        gateway.logger.log("model_attempt", {
          subtaskId: subtask.id,
          modelRequested: activeModel(),
          modelServed: null,
          verification: "FAILED",
          escalated: true,
          reason: `infrastructure fallback: ${String(error)}`,
        });
        // Move to the next compatible model immediately and give that model its
        // own bounded mutation budget.
        const moved = await moveToFallback(
          `provider_or_protocol_failure: ${String(error)}`,
          false,
        );
        if (!moved) throw error;
        noMutationTurns = 0;
        contextRecoveryAvailable = false;
        contextRecoveryConsumed = false;
        await resetToCurrentWorkspace(
          `provider_or_protocol_fallback: ${String(error)}`,
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
          const moved = await moveToFallback(
            "same-model repair produced no mutation after focused failure",
            true,
          );
          if (!moved) throw Error("Stable mutation protocol exhausted without a diff");
          sameModelRepairUsed = false;
          noMutationTurns = 0;
          contextRecoveryConsumed = false;
          await resetToCurrentWorkspace("same_model_repair_no_mutation_model_fallback");
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
            false,
          );
          if (!moved) throw Error("Stable mutation protocol exhausted without a diff");
          noMutationTurns = 0;
          contextRecoveryAvailable = false;
          contextRecoveryConsumed = false;
          await resetToCurrentWorkspace("no_mutation_model_fallback");
          continue;
        }
        contextRecoveryAvailable = true;
        gateway.logger.log(STABLE_EVENTS.contextRecovery, {
          subtaskId: subtask.id,
          model: activeModel(),
          reason: "mutation_produced_no_diff",
        });
        messages.push({
          role: "user",
          content: JSON.stringify({
            currentLockedFiles: await lockedFiles(),
            currentDiff: truncateBytes(await currentDiff(path), gateway.config.context.maxBytes),
            previousToolResults: toolResults,
            instruction:
              "No mutation was produced. Correct the exact tool error. request_context is available once if an exact trusted dependency is missing; otherwise mutate now.",
          }),
        });
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

      const focused = await runFocusedVerification();
      if (focused.status === "VERIFIED_SUCCESS" || !focusedCommands.length) {
        gateway.logger.log(STABLE_EVENTS.readyForFinal, {
          subtaskId: subtask.id,
          diffBytes: Buffer.byteLength(afterDiff),
          reason: "task_diff_verified",
        });
        return { verification: verificationResult([]), role, evidence };
      }

      if (!sameModelRepairUsed) {
        sameModelRepairUsed = true;
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

      const moved = await moveToFallback(
        "focused verification still failing after same-model repair",
        true,
      );
      if (!moved) return { verification: focused, role, evidence };
      sameModelRepairUsed = false;
      await resetToCurrentWorkspace(
        "focused_verification_failed_model_fallback",
        focused,
        "Continue from the CURRENT modified source and diff. Do not restart from stale RepairPacket source.",
      );
    }
    throw Error("Stable mutation protocol exhausted without verified completion");
  } finally {
    gateway.logger.log("coding_worker_stop", { subtaskId: subtask.id, worktree: path });
  }
}

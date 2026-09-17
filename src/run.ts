import { verificationPlan } from "./verifier/plan.js";
import type { PoolRouter } from "./router/modelRouter.js";
import { mkdir, writeFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir, homedir } from "node:os";
import type { Config } from "./config.js";
import { bridgeDependencies } from "./repo/dependencies.js";
import { raceVerified } from "./orchestrator/race.js";
import { profileRepo } from "./repo/profiler.js";
import { git, command } from "./repo/commands.js";
import { Logger } from "./telemetry/logger.js";
import { summarize } from "./telemetry/summary.js";
import { Budget } from "./openrouter/usage.js";
import { Gateway } from "./openrouter/client.js";
import {
  chooseExecutionStrategy,
  directWritePaths,
  type ExecutionStrategy,
} from "./router/executionStrategy.js";
import {
  compileContext,
  compileTargetContext,
} from "./context/compiler.js";
import { normalizePlan } from "./orchestrator/coalesce.js";
import { compileTask } from "./planner/taskCompiler.js";
import { schedule } from "./orchestrator/scheduler.js";
import { implement } from "./agent/loop.js";
import { discover } from "./agent/discovery.js";
import { prepareStableWorker } from "./agent/stable.js";
import { buildRepairPacket } from "./agent/repairPacket.js";
import { verify, verificationResult } from "./verifier/verifier.js";
import {
  repoBackedVerificationCommands,
  tinyDocumentationChecks,
  targetedProjectUnitNativeCheck,
} from "./verifier/selection.js";
import type { Status, CommandResult } from "./types.js";
import type { EvidencePacket, Subtask } from "./planner/schemas.js";
import {
  createWorkspaceBackend,
  workspaceChangedPaths,
  type ApplyResult,
  type WorkspaceBackend,
  type WorkspaceInstance,
} from "./workspace/backend.js";
import { changeCode } from "./workspace/files.js";
import { nextCodingTier, type CodingTier } from "./router/codingDemand.js";
export interface RunOptions {
  repo: string;
  /** Calibration may freeze source separately while reusing original installed dependencies. */
  dependencyRoot?: string;
  task: string;
  config: Config;
  baseCommit?: string;
  verify?: string[];
  output?: string;
  quiet?: boolean;
  apply?: boolean;
}
async function assertWriteResponsibility(path: string, subtask: Subtask) {
  const changed =
    (await workspaceChangedPaths(path)) ??
    (await git(path, "status", "--porcelain", "--untracked-files=all"))
      .split("\n")
      .filter(Boolean)
      .map((s) => s.slice(3));
  for (const file of changed) {
    if (
      !subtask.likelyWritePaths.some(
        (p) =>
          p === "." ||
          file === p ||
          file.startsWith(p.replace(/\/$/, "") + "/"),
      )
    )
      throw Error(`Write responsibility exceeded: ${file}`);
  }
}
function combineEvidence(packets: EvidencePacket[]) {
  if (!packets.length) return undefined;
  const unique = (values: string[]) => [...new Set(values)];
  return {
    relevantFiles: unique(packets.flatMap((packet) => packet.relevantFiles)),
    symbols: unique(packets.flatMap((packet) => packet.symbols)),
    reproduction: packets.map((packet) => packet.reproduction).join("\n"),
    failingTests: unique(packets.flatMap((packet) => packet.failingTests)),
    likelyRootCause: packets.map((packet) => packet.likelyRootCause).join("\n"),
    dependencies: unique(packets.flatMap((packet) => packet.dependencies)),
    uncertainty: packets.some((packet) => packet.uncertainty === "high")
      ? ("high" as const)
      : packets.some((packet) => packet.uncertainty === "medium")
        ? ("medium" as const)
        : ("low" as const),
    suggestedApproach: packets
      .map((packet) => packet.suggestedApproach)
      .join("\n"),
    evidence: unique(packets.flatMap((packet) => packet.evidence)),
  };
}
export async function run(options: RunOptions) {
  const start = Date.now(),
    runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 6)}`;
  const repo = await realpath(resolve(options.repo));
  const output = resolve(
    options.output ?? join(homedir(), ".koda", "runs", runId),
  );
  if (output === repo || output.startsWith(repo + "/"))
    throw Error("Report output must be outside the target repository");
  const logger = new Logger(output, runId, options.quiet);
  let status: Status = "FAILED",
    verification = verificationResult([]),
    error: string | undefined;
  let integration: WorkspaceInstance | undefined;
  let backend: WorkspaceBackend | undefined;
  let applyResult: ApplyResult = {
    requested: !!options.apply,
    status: "not_verified",
    conflicts: [],
    changes: [],
  };
  let poolRouter: PoolRouter | undefined;
  let plannedSubtasks = 0;
  let coalescedSubtasks = 0;
  let strategy: ExecutionStrategy = {
    execution_strategy: "planned",
    execution_effort: "complex",
    strategy_reason: "Strategy not yet assessed",
    likelyFiles: [],
  };
  try {
    logger.log("profiling", { repo });
    backend = await createWorkspaceBackend(
      repo,
      join(tmpdir(), "koda-workspaces", runId),
      logger,
      !!options.apply,
      options.baseCommit,
    );
    if (options.baseCommit && backend.mode !== "git")
      logger.log("workspace_note", {
        reason:
          "baseCommit ignored because filesystem mode preserves the current workspace",
      });
    logger.log("workspace", {
      state: backend.state,
      backend: backend.mode,
      baseline_files: backend.stats.files,
      baseline_bytes: backend.stats.bytes,
      preexisting_modified: backend.stats.preexistingModified,
      preexisting_untracked: backend.stats.preexistingUntracked,
    });
    const sandboxCheck = await command(repo, "node --version", 10000, true);
    if (sandboxCheck.exitCode !== 0)
      throw Error(`Sandbox preflight failed: ${sandboxCheck.stderr}`);
    integration = await backend.initialize();
    let profile = await profileRepo(integration.path);
    if (
      await bridgeDependencies(
        options.dependencyRoot ?? repo,
        integration.path,
        profile.ecosystem,
      )
    )
      profile = await profileRepo(integration.path);
    logger.log("worktree", {
      stage: "integration",
      path: integration.path,
      branch: integration.branch,
    });
    logger.log("profile", { profile });
    logger.log("repo_profile", { ecosystem: profile.ecosystem });
    const budget = new Budget(
      options.config.budgetUsd,
      options.config.maxTokens,
      options.config.maxMinutes * 60000 - (Date.now() - start),
    );
    const gateway = new Gateway(options.config, logger, budget);
    poolRouter = gateway.modelRouter;
    strategy = chooseExecutionStrategy(options.task, profile);
    logger.log("execution_strategy", {
      execution_strategy: strategy.execution_strategy,
      execution_effort: strategy.execution_effort,
      strategy_reason: strategy.strategy_reason,
    });
    let taskVerificationCommands: string[] = [];
    let taskVerificationIsFocused = false;
    let stableRepairContext:
      | {
          subtask: Subtask;
          context: Awaited<ReturnType<typeof compileContext>>;
          prepared: Awaited<ReturnType<typeof prepareStableWorker>>;
        }
      | undefined;
    let directRepairContext:
      | {
          subtask: Subtask;
          context: Awaited<ReturnType<typeof compileContext>>;
        }
      | undefined;
    if (strategy.execution_strategy === "stable") {
      const context = await compileContext(
        integration.path,
        options.task,
        strategy.likelyFiles,
        profile,
        options.config.context,
      );
      const inspectionTask: Subtask = {
        id: "stable",
        title: options.task,
        objective: options.task,
        dependsOn: [],
        likelyReadPaths: strategy.likelyFiles,
        likelyWritePaths: [],
        readOnly: true,
        integrationContract:
          "Inspect, declare exact files, implement the fix and regression test",
        verificationCommands: [],
        estimatedDifficulty: "normal",
        parallelSafe: false,
      };
      logger.log("task_start", { subtaskId: inspectionTask.id });
      const prepared = await prepareStableWorker(
        gateway,
        integration.path,
        options.task,
        inspectionTask,
        profile,
        context,
      );
      const subtask: Subtask = {
        ...inspectionTask,
        readOnly: false,
        likelyWritePaths: prepared.writePaths,
      };
      const stableFocusedCheck = targetedProjectUnitNativeCheck(
        subtask,
        profile,
        context,
      );

      if (stableFocusedCheck) {
        taskVerificationCommands = [stableFocusedCheck];
        taskVerificationIsFocused = true;
        subtask.verificationCommands = [stableFocusedCheck];
      }
      const { packet: repairPacket, context: implementationContext } =
        await buildRepairPacket(
          integration.path, options.task, prepared.writePaths, profile,
          profile.verificationCommands, gateway.config.context.maxPromptBytes,
          prepared.evidence,
        );
      logger.log("stable_context_focused", {
        subtaskId: subtask.id,
        before_bytes: Buffer.byteLength(JSON.stringify(context)),
        after_bytes: Buffer.byteLength(JSON.stringify(implementationContext)),
        files: implementationContext.files.map((file) => file.path),
      });
      stableRepairContext = {
        subtask,
        context: implementationContext,
        prepared,
      };
      const result = await implement(
        gateway,
        integration.path,
        options.task,
        subtask,
        { acceptanceCriteria: [options.task] },
        profile,
        {
          compiledContext: implementationContext,
          evidence: prepared.evidence,
          selectedCandidate: prepared.selected,
          model: prepared.model,
          finalVerificationOnly: true,
          stableHandoff: prepared.handoff,
          repairPacket,
        },
      );
      if (result.verification.status === "FAILED")
        throw Error("stable: worker failed before final verification");
      await assertWriteResponsibility(integration.path, subtask);
      const revision = await backend.finalizeWorker(
        integration,
        `agent: ${options.task}`,
      );
      if (!revision.changes.length)
        throw Error("stable: worker produced no changes");
      logger.log("integrated", {
        subtaskId: subtask.id,
        commit: revision.commit,
        changes: revision.changes.map((change) => change.path),
      });
      logger.log("task_complete", {
        subtaskId: subtask.id,
        verification: "AWAITING_FINAL_VERIFICATION",
      });
    } else if (strategy.execution_strategy === "direct") {
      const context =
        strategy.execution_effort === "tiny" && strategy.preciseTarget
          ? await compileTargetContext(
              integration.path,
              strategy.preciseTarget,
              options.task,
              options.config.context,
            )
          : await compileContext(
              integration.path,
              options.task,
              strategy.likelyFiles,
              profile,
              options.config.context,
            );
      const subtask: Subtask = {
        id: "direct",
        title: options.task,
        objective: options.task,
        dependsOn: [],
        likelyReadPaths: strategy.likelyFiles,
        likelyWritePaths: strategy.preciseTarget
          ? [strategy.preciseTarget]
          : directWritePaths(
              [...strategy.likelyFiles, ...context.localDependencies],
              profile,
            ),
        integrationContract:
          "Satisfy the original task while preserving existing public interfaces",
        verificationCommands: [],
        estimatedDifficulty: "normal",
        parallelSafe: false,
      };
      logger.log("task_start", { subtaskId: subtask.id });
      const result = await implement(
        gateway,
        integration.path,
        options.task,
        subtask,
        { acceptanceCriteria: [options.task] },
        profile,
        {
          compiledContext: context,
          tinyDirect: strategy.execution_effort === "tiny",
          finalVerificationOnly: strategy.execution_effort === "tiny",
        },
      );
      if (strategy.execution_effort === "tiny")
        directRepairContext = { subtask, context };
      if (
        result.verification.status !== "VERIFIED_SUCCESS" &&
        !(
          strategy.execution_effort === "tiny" &&
          result.verification.status === "NOT_FULLY_VERIFIED" &&
          (await backend.changes(integration.path)).length > 0
        )
      ) {
        status = result.verification.status;
        throw Error(`direct: ${status}`);
      }
      await assertWriteResponsibility(integration.path, subtask);
      const revision = await backend.finalizeWorker(
        integration,
        `agent: ${options.task}`,
      );
      // This is already the isolated integration branch. No second directory or
      // cherry-pick is needed; the verified commit is its integrated result.
      if (revision.changes.length)
        logger.log("integrated", {
          subtaskId: subtask.id,
          commit: revision.commit,
          changes: revision.changes.map((c) => c.path),
        });
      logger.log("task_complete", {
        subtaskId: subtask.id,
        verification:
          strategy.execution_effort === "tiny"
            ? "AWAITING_FINAL_VERIFICATION"
            : result.verification.status,
      });
    } else {
      const rawPlan = await compileTask(gateway, options.task, profile);
      const normalized = normalizePlan(rawPlan);
      const plan = normalized.plan;
      plannedSubtasks = normalized.before;
      coalescedSubtasks = normalized.after;
      logger.log("dag_normalized", {
        plannedSubtasks,
        coalescedSubtasks,
        removedContextTasks: normalized.removedContextTasks,
        groups: normalized.groups,
      });
      await writeFile(join(output, "plan.json"), JSON.stringify(plan, null, 2));
      logger.log("dag", { plan });
      const discoveryEvidence = new Map<
        string,
        Awaited<ReturnType<typeof discover>>
      >();
      const execute = async (subtask: Subtask) => {
        logger.log("task_start", { subtaskId: subtask.id });
        const inheritedEvidence = subtask.dependsOn
          .map((id) => discoveryEvidence.get(id))
          .filter((packet): packet is NonNullable<typeof packet> => !!packet);
        if (subtask.readOnly === true) {
          const wt = await backend!.createWorker(
            `task-${subtask.id}-${randomUUID().slice(0, 6)}`,
          );
          logger.log("worktree", {
            subtaskId: subtask.id,
            path: wt.path,
            branch: wt.branch,
          });
          try {
            await bridgeDependencies(repo, wt.path, profile.ecosystem);
            const evidence = await discover(
              gateway,
              wt.path,
              options.task,
              subtask,
              plan,
              profile,
              inheritedEvidence,
            );
            await assertWriteResponsibility(wt.path, subtask);
            discoveryEvidence.set(subtask.id, evidence);
            logger.log("task_complete", {
              subtaskId: subtask.id,
              verification: "READ_ONLY_DISCOVERY",
            });
          } finally {
            await backend!.cleanupWorker(wt);
          }
          return;
        }
        const candidates: WorkspaceInstance[] = [];
        const worker = async (
          suffix: string,
          initialRole?: "CHEAP_CODER_A" | "CHEAP_CODER_B",
          stop?: () => boolean,
        ) => {
          const wt = await backend!.createWorker(
            `task-${subtask.id}${suffix}-${randomUUID().slice(0, 6)}`,
          );
          candidates.push(wt);
          logger.log("worktree", {
            subtaskId: subtask.id,
            path: wt.path,
            branch: wt.branch,
          });
          try {
            await bridgeDependencies(repo, wt.path, profile.ecosystem);
            const candidateTask = { ...subtask, id: subtask.id + suffix };
            const result = await implement(
              gateway,
              wt.path,
              options.task,
              candidateTask,
              plan,
              profile,
              {
                initialRole,
                stop,
                raceGroup: suffix ? subtask.id : undefined,
                evidence: combineEvidence(inheritedEvidence),
              },
            );
            if (result.verification.status !== "VERIFIED_SUCCESS") {
              if (result.verification.status === "NOT_FULLY_VERIFIED")
                status = "NOT_FULLY_VERIFIED";
              throw Error(`${subtask.id}: ${result.verification.status}`);
            }
            await assertWriteResponsibility(wt.path, subtask);
            const revision = await backend!.finalizeWorker(
              wt,
              `agent: ${subtask.title}`,
            );
            return { wt, revision, result };
          } catch (e) {
            logger.log("attempt_failed", {
              subtaskId: subtask.id,
              path: wt.path,
              error: String(e),
            });
            throw e;
          }
        };
        let winner: Awaited<ReturnType<typeof worker>>;
        if (
          options.config.race &&
          !options.config.forceModel &&
          subtask.estimatedDifficulty === "high" &&
          options.config.maxParallel >= 2
        ) {
          winner = await raceVerified([
            (stop) => worker("-a", "CHEAP_CODER_A", stop),
            (stop) => worker("-b", "CHEAP_CODER_B", stop),
          ]);
          for (const candidate of candidates)
            if (candidate.path !== winner.wt.path)
              await backend!.cleanupWorker(candidate);
          logger.log("race_winner", {
            subtaskId: subtask.id,
            branch: winner.wt.branch,
          });
        } else winner = await worker("");
        if (winner.revision.changes.length)
          await backend!.integrate(
            winner.revision,
            subtask.id,
            async (paths) => {
              const conflictTask: Subtask = {
                ...subtask,
                id: `${subtask.id}-integration`,
                objective: `Resolve integration conflict while preserving both contracts: ${subtask.integrationContract}`,
                likelyWritePaths: paths,
                verificationCommands: [
                  ...subtask.verificationCommands,
                  ...profile.verificationCommands,
                ],
                estimatedDifficulty: "high",
              };
              const extra = {
                contracts: plan.subtasks.map((t) => ({
                  id: t.id,
                  contract: t.integrationContract,
                })),
                workspaceConflict: await backend!.conflictContext(
                  winner.revision,
                ),
              };
              const result = await implement(
                gateway,
                integration!.path,
                options.task,
                conflictTask,
                plan,
                profile,
                { initialRole: "STRONG_MODEL", extra },
              );
              if (result.verification.status !== "VERIFIED_SUCCESS")
                throw Error("Conflict resolution not verified");
            },
          );
        logger.log("task_complete", {
          subtaskId: subtask.id,
          verification: winner.result.verification.status,
        });
        await backend!.cleanupWorker(winner.wt);
      };
      await schedule(plan.subtasks, options.config.maxParallel, execute, (t) =>
        options.config.race &&
        !options.config.forceModel &&
        t.estimatedDifficulty === "high" &&
        options.config.maxParallel >= 2
          ? 2
          : 1,
      );

      taskVerificationCommands = plan.subtasks.flatMap((t) =>
        t.readOnly === true ? [] : t.verificationCommands,
      );
    }
    const finalProfile = await profileRepo(integration.path);
    const changed = (await backend.changes(integration.path)).map(
      (c) => c.path,
    );
    const verificationPaths = changed.length
      ? changed
      : stableRepairContext?.subtask.likelyWritePaths.length
        ? stableRepairContext.subtask.likelyWritePaths
        : directRepairContext?.subtask.likelyWritePaths.length
          ? directRepairContext.subtask.likelyWritePaths
          : changed;
    const currentPlan = verificationPlan(finalProfile, verificationPaths, true);
    const allFinalCandidates = [
      ...currentPlan,
      ...verificationPlan(profile, verificationPaths, true).filter(
        (c) => !currentPlan.some((r) => r.command === c.command),
      ),
    ];
    const tinyDocs =
      strategy.execution_strategy === "direct" &&
      strategy.execution_effort === "tiny" &&
      changed.length > 0 &&
      changed.every((file) => /\.(?:md|mdx|txt|rst)$/i.test(file));
    const documentCommands = tinyDocs
      ? new Set(
          changed.flatMap((file) =>
            tinyDocumentationChecks(finalProfile, file),
          ),
        )
      : undefined;
    const finalPlan = documentCommands
      ? allFinalCandidates.filter((candidate) =>
          documentCommands.has(candidate.command),
        )
      : taskVerificationIsFocused
        ? allFinalCandidates.filter(
            (candidate) =>
              candidate.kind !== "test" ||
              taskVerificationCommands.includes(candidate.command),
          )
        : allFinalCandidates;
    // Stable focused checks were derived from an available project-unit runner.
    // Re-filtering them as free-form model commands would discard nested
    // `cd unit && node --test file` checks after removing the broad suite.
    if (!taskVerificationIsFocused)
      taskVerificationCommands = repoBackedVerificationCommands(
        taskVerificationCommands,
        finalProfile,
      );
    logger.log("verification_plan", { phase: "final", candidates: finalPlan });
    const finalCommands = [
      ...finalPlan.map((c) => c.command),
      ...(tinyDocs ? [] : taskVerificationCommands),
      ...(options.verify ?? []),
    ];
    const runFinalVerification = async () => {
      const executable = await verify(
        integration!.path,
        finalCommands,
        () => Math.min(options.config.commandTimeoutMs, budget.remainingMs()),
        (c) => logger.log("final_verification", c as any),
        undefined,
        finalPlan,
      );
      if (!tinyDocs) return executable;
      const changedPaths = (await backend!.changes(integration!.path)).map(
        (change) => change.path,
      );
      const allowed = directRepairContext?.subtask.likelyWritePaths ?? [];
      const writes = logger.events.filter(
        (event) => event.type === "write_success" && event.subtaskId === "direct",
      );
      const valid =
        changedPaths.length > 0 &&
        changedPaths.every((file) => allowed.includes(file)) &&
        writes.some((event) => changedPaths.includes(event.path)) &&
        !logger.events.some(
          (event) => event.type === "write_scope_violation" && event.subtaskId === "direct",
        );
      const structural: CommandResult = {
        command: "internal:tiny-documentation-structure",
        source: "deterministic:diff-write-scope",
        kind: "check",
        outcome: valid ? "CHECK_PASS" : "CHECK_FAIL",
        exitCode: valid ? 0 : 1,
        stdout: valid
          ? "Structural change verified; prose meaning was not checked"
          : "Missing diff, successful scoped write, or intact write scope",
        stderr: "",
        wallClockMs: 0,
        timedOut: false,
      };
      logger.log("documentation_structure_verification", {
        ...structural,
        changedPaths,
        allowed,
      });
      return verificationResult([...executable.checks, structural]);
    };
    verification = await runFinalVerification();
    if (
      stableRepairContext &&
      verification.status === "FAILED" &&
      !verification.checks.some((check) => check.outcome === "INFRA_FAILURE")
    ) {
      let failedChecks = verification.checks.filter(
        (check) => check.outcome === "CHECK_FAIL",
      );
      const failureSignature = (checks: CommandResult[]) =>
        checks
          .map((check) =>
            `${check.command}:${check.exitCode}:${check.stdout}\n${check.stderr}`
              .replace(/\d+(?:\.\d+)?ms\b/g, "<duration>")
              .replace(/\b\d+(?:\.\d+)?s\b/g, "<duration>"),
          )
          .join("\n");
      for (let attempt = 1; attempt <= 2 && failedChecks.length; attempt++) {
        logger.log("stable_final_repair_start", {
          subtaskId: stableRepairContext.subtask.id,
          attempt,
          failedChecks,
        });
        const beforeRepair = JSON.stringify(
          await backend.changes(integration.path),
        );
        const modelEventStart = logger.events.length;
        let repair;
        try {
          repair = await implement(
            gateway,
            integration.path,
            options.task,
            stableRepairContext.subtask,
            { acceptanceCriteria: [options.task] },
            await profileRepo(integration.path),
            {
              compiledContext: stableRepairContext.context,
              evidence: stableRepairContext.prepared.evidence,
              selectedCandidate: stableRepairContext.prepared.selected,
              model: stableRepairContext.prepared.model,
              finalVerificationOnly: true,
              adaptiveStartTier:
                options.config.adaptiveCoding && !options.config.forceModel
                  ? attempt === 1
                    ? "high"
                    : "frontier"
                  : undefined,
              stableHandoff: stableRepairContext.prepared.handoff,
              stableRepair: {
                attempt,
                failedChecks,
                changedFiles: (await backend.changes(integration.path)).map(
                  (change) => change.path,
                ),
              },
              extra: {
                instruction:
                  "Repair the existing implementation. Do not restart discovery. The failed command will be rerun before the full final verification.",
                failedChecks,
              },
            },
          );
        } catch (repairError) {
          const repairCalls = logger.events
            .slice(modelEventStart)
            .filter(
              (event) =>
                event.type === "model_call" &&
                event.subtaskId === stableRepairContext!.subtask.id,
            );
          logger.log("stable_final_repair_attempt", {
            subtaskId: stableRepairContext.subtask.id,
            attempt,
            model_calls: repairCalls.length,
            tokens: repairCalls.reduce(
              (sum, event) =>
                sum + (event.promptTokens ?? 0) + (event.completionTokens ?? 0),
              0,
            ),
            cost_usd: repairCalls.reduce(
              (sum, event) => sum + (event.costUsd ?? 0),
              0,
            ),
            outcome: "exhausted",
          });
          logger.log("stable_final_repair_exhausted", {
            attempt,
            reason: String(repairError),
          });
          throw repairError;
        }
        const repairCalls = logger.events
          .slice(modelEventStart)
          .filter(
            (event) =>
              event.type === "model_call" &&
              event.subtaskId === stableRepairContext!.subtask.id,
          );
        logger.log("stable_final_repair_attempt", {
          subtaskId: stableRepairContext.subtask.id,
          attempt,
          model_calls: repairCalls.length,
          tokens: repairCalls.reduce(
            (sum, event) =>
              sum + (event.promptTokens ?? 0) + (event.completionTokens ?? 0),
            0,
          ),
          cost_usd: repairCalls.reduce(
            (sum, event) => sum + (event.costUsd ?? 0),
            0,
          ),
        });
        if (repair.verification.status === "FAILED")
          throw Error(`Stable final repair ${attempt} failed`);
        await assertWriteResponsibility(
          integration.path,
          stableRepairContext.subtask,
        );
        if (
          JSON.stringify(await backend.changes(integration.path)) ===
          beforeRepair
        )
          throw Error(`Stable final repair ${attempt} produced no changes`);
        await backend.finalizeWorker(
          integration,
          `agent: stable final repair ${attempt}`,
        );
        const failedCommands = [...new Set(failedChecks.map((c) => c.command))];
        const targeted = await verify(
          integration.path,
          failedCommands,
          () => Math.min(options.config.commandTimeoutMs, budget.remainingMs()),
          (c) =>
            logger.log("stable_repair_verification", {
              attempt,
              ...c,
            }),
          undefined,
          finalPlan,
        );
        logger.log("stable_final_repair_check", {
          attempt,
          status: targeted.status,
          checks: targeted.checks,
        });
        const unavailableRepair = targeted.checks.find(
          (check) =>
            check.outcome === "INFRA_FAILURE" ||
            check.outcome === "CHECK_UNAVAILABLE",
        );
        if (unavailableRepair)
          throw Error(
            `Stable repair verification infrastructure unavailable: ${unavailableRepair.command}`,
          );
        if (targeted.status !== "VERIFIED_SUCCESS") {
          const previousSignature = failureSignature(failedChecks);
          const previousFailureCount = failedChecks.length;
          verification = targeted;
          failedChecks = targeted.checks.filter(
            (check) => check.outcome === "CHECK_FAIL",
          );
          logger.log("stable_final_repair_failed", {
            attempt,
            failedChecks,
          });
          if (
            failedChecks.length >= previousFailureCount &&
            failureSignature(failedChecks) === previousSignature
          )
            break;
          continue;
        }
        verification = await runFinalVerification();
        if (verification.status === "VERIFIED_SUCCESS") {
          logger.log("stable_final_repair_success", { attempt });
          break;
        }
        failedChecks = verification.checks.filter(
          (check) => check.outcome === "CHECK_FAIL",
        );
      }
      if (verification.status !== "VERIFIED_SUCCESS")
        logger.log("stable_final_repair_exhausted", {
          attempts: 2,
          failedChecks: verification.checks.filter(
            (check) => check.outcome === "CHECK_FAIL",
          ),
        });
    }
    if (
      directRepairContext &&
      options.config.adaptiveCoding &&
      !options.config.forceModel &&
      verification.status === "FAILED" &&
      verification.checks.some((check) => check.outcome === "CHECK_FAIL") &&
      !verification.checks.some((check) => check.outcome === "INFRA_FAILURE")
    ) {
      let tier: CodingTier = "low";
      while (verification.status === "FAILED") {
        const higher = nextCodingTier(tier);
        if (!higher) break;
        tier = higher;
        const failedChecks = verification.checks.filter(
          (check) => check.outcome === "CHECK_FAIL",
        );
        logger.log("coding_quality_escalation", {
          subtaskId: directRepairContext.subtask.id,
          from: tier === "medium" ? "low" : tier === "high" ? "medium" : "high",
          to: tier,
          reason: "final deterministic CHECK_FAIL",
          failedChecks,
        });
        const before = JSON.stringify(await backend.changes(integration.path));
        const repairContext = strategy.preciseTarget
          ? await compileTargetContext(
              integration.path,
              strategy.preciseTarget,
              options.task,
              options.config.context,
            )
          : directRepairContext.context;
        try {
          await implement(
            gateway,
            integration.path,
            options.task,
            directRepairContext.subtask,
            { acceptanceCriteria: [options.task] },
            await profileRepo(integration.path),
            {
              compiledContext: repairContext,
              tinyDirect: true,
              finalVerificationOnly: true,
              adaptiveStartTier: tier,
              extra: {
                instruction:
                  "Repair the existing edit using the exact failed checks; do not rediscover the task.",
                failedChecks,
              },
            },
          );
        } catch (repairError) {
          logger.log("coding_quality_attempt_failed", {
            tier,
            error: String(repairError),
          });
          continue;
        }
        if (JSON.stringify(await backend.changes(integration.path)) === before)
          continue;
        await assertWriteResponsibility(
          integration.path,
          directRepairContext.subtask,
        );
        await backend.finalizeWorker(
          integration,
          `agent: direct ${tier} repair`,
        );
        verification = await runFinalVerification();
        if (
          verification.checks.some(
            (check) =>
              check.outcome === "INFRA_FAILURE" ||
              check.outcome === "CHECK_UNAVAILABLE",
          )
        )
          break;
      }
    }
    status = verification.status;
    const unavailable = verification.checks.find(
      (check) =>
        check.outcome === "INFRA_FAILURE" ||
        check.outcome === "CHECK_UNAVAILABLE",
    );
    if (unavailable)
      throw Error(
        `Final verification infrastructure unavailable: ${unavailable.command}: ${unavailable.unavailable ?? "verification could not execute"}`,
      );
  } catch (e) {
    error = String(e);
    logger.log("run_error", { error });
  }
  if (backend && integration) {
    try {
      applyResult = await backend.apply(
        output,
        integration,
        status === "VERIFIED_SUCCESS",
      );
    } catch (e) {
      error = `${error ? error + "; " : ""}Apply preparation failed: ${String(e)}`;
      applyResult = {
        requested: !!options.apply,
        status: "not_verified",
        conflicts: [],
        changes: [],
      };
      logger.log("apply", { status: "not_verified", error: String(e) });
    }
    logger.log("changes", {
      modified: applyResult.changes.filter((c) => c.type === "modify").length,
      created: applyResult.changes.filter((c) => c.type === "create").length,
      deleted: applyResult.changes.filter((c) => c.type === "delete").length,
      paths: applyResult.changes.map((c) => `${changeCode(c.type)} ${c.path}`),
    });
    logger.log("apply", {
      status: applyResult.status,
      conflicts: applyResult.conflicts,
      modified: applyResult.changes.filter((c) => c.type === "modify").length,
      created: applyResult.changes.filter((c) => c.type === "create").length,
      deleted: applyResult.changes.filter((c) => c.type === "delete").length,
    });
  }
  poolRouter?.history.finalize(runId, status);
  const changedFiles = applyResult.changes.map((c) => c.path);
  const summary = {
    ...summarize(
      logger,
      status,
      Date.now() - start,
      verification,
      changedFiles,
    ),
    execution_strategy: strategy.execution_strategy,
    execution_effort: strategy.execution_effort,
    strategy_reason: strategy.strategy_reason,
    plannedSubtasks,
    coalescedSubtasks,
    error,
    workspace: backend
      ? {
          backend: backend.mode,
          state: backend.state,
          baseline: backend.stats,
        }
      : null,
    changeset: applyResult.changes,
    applyRequested: applyResult.requested,
    applyResult: applyResult.status,
    applyConflicts: applyResult.conflicts,
    revertStatus: "not_requested",
    revertConflicts: [],
    integration: integration
      ? { path: integration.path, branch: integration.branch }
      : undefined,
    output,
    subtaskVerification: Object.fromEntries(
      [
        ...new Set(
          logger.events
            .filter((e) => e.type === "verification")
            .map((e) => e.subtaskId),
        ),
      ].map((id) => [
        id,
        verificationResult([
          ...new Map(
            logger.events
              .filter((e) => e.type === "verification" && e.subtaskId === id)
              .map((e) => [e.command, e]),
          ).values(),
        ]),
      ]),
    ),
  };
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, "summary.json"),
    JSON.stringify(summary, null, 2),
  );
  if (!options.quiet) {
    console.log(
      `\n${status}\nWall clock: ${(summary.wallClockMs / 1000).toFixed(1)}s\nModel cost: $${summary.costUsd.toFixed(6)}${summary.costComplete ? "" : " (incomplete accounting)"}\nTotal tokens: ${summary.totalTokens}\nMax concurrent coding workers: ${summary.parallelPeak}\nEscalations: ${summary.escalations}\nFrontier rescue calls: ${summary.frontierCalls}`,
    );
    for (const [model, cost] of Object.entries(summary.models))
      console.log(`${model}: $${cost.costUsd.toFixed(6)}`);
    console.log(
      `Integration: ${integration?.path ?? "not created"}\nReport: ${join(output, "summary.json")}`,
    );
  }
  return summary;
}

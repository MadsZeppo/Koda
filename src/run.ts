import { prepareRepairChecks, newFailureIds } from "./verifier/repairFocus.js";
import { verificationPlan } from "./verifier/plan.js";
import type { PoolRouter } from "./router/modelRouter.js";
import { mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir, homedir } from "node:os";
import type { Config } from "./config.js";
import { bootstrapDependencies, bridgeDependencies, inheritDependencyEnvironment } from "./repo/dependencies.js";
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
  requestsTestMutation,
  type ExecutionStrategy,
} from "./router/executionStrategy.js";
import {
  compileContext,
  compileTargetContext,
  isTestPath,
} from "./context/compiler.js";
import { normalizePlan } from "./orchestrator/coalesce.js";
import { compileTask } from "./planner/taskCompiler.js";
import { schedule } from "./orchestrator/scheduler.js";
import { implement } from "./agent/miniSweExecutor.js";
import { currentDiff, safePath } from "./agent/tools.js";
import { truncateBytes } from "./context/bounds.js";
import { AttemptCheckpoint } from "./agent/attemptCheckpoint.js";
import { WriteScope } from "./repo/writeScope.js";
import { discover } from "./agent/discovery.js";
import { advisoryInfrastructureOnly, verify, verificationAgainstBaseline, verificationResult, verificationRegressions } from "./verifier/verifier.js";
import { focusedLocalReproduction, optionalUnavailableCheck } from "./verifier/recovery.js";
import {
  repoBackedVerificationCommands,
  impactAwareVerificationSelection,
  tinyDocumentationChecks,
  targetedProjectUnitNativeCheck,
} from "./verifier/selection.js";
import type { Status, CommandResult, VerificationResult } from "./types.js";
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
import { taskRelevantMutationPaths } from "./agent/mutationInvariant.js";
import { stableNoChangePreflight } from "./agent/stableNoChangePreflight.js";
import type { CodingWorker } from "./agent/codingWorker.js";
import { extractFeatures } from "./router/features.js";
import { buildTaskResume, type DeterministicTaskProfile } from "./router/taskProfiler.js";
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
  /** Deterministic test seam. CLI/production never supplies a worker factory. */
  codingWorkerFactory?: (gateway: Gateway) => CodingWorker;
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
  const joined = (values: string[]) => values.filter((value) => value.trim()).join("\n");
  return {
    relevantFiles: unique(packets.flatMap((packet) => packet.relevantFiles)),
    symbols: unique(packets.flatMap((packet) => packet.symbols)),
    reproduction: joined(packets.map((packet) => packet.reproduction)),
    failingTests: unique(packets.flatMap((packet) => packet.failingTests)),
    likelyRootCause: joined(packets.map((packet) => packet.likelyRootCause)),
    dependencies: unique(packets.flatMap((packet) => packet.dependencies)),
    uncertainty: packets.some((packet) => packet.uncertainty === "high")
      ? ("high" as const)
      : packets.some((packet) => packet.uncertainty === "medium")
        ? ("medium" as const)
        : ("low" as const),
    suggestedApproach: joined(packets.map((packet) => packet.suggestedApproach)),
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
  let acceptedRepairState: string | undefined;
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
  let scheduledTaskParallelPeak = 0;
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
    if (await bridgeDependencies(
      options.dependencyRoot ?? repo, integration.path, profile.ecosystem))
      profile = await profileRepo(integration.path);
    if (profile.ecosystem && await bootstrapDependencies(
      integration.path, integration.path, profile.ecosystem, logger))
      profile = await profileRepo(integration.path);
    logger.log("worktree", {
      stage: "integration",
      path: integration.path,
      branch: integration.branch,
    });
    logger.log("profile", { profile });
    logger.log("repo_profile", { ecosystem: profile.ecosystem });
    logger.log("latency", { dependency_profile_setup_ms: Date.now() - start });
    const budget = new Budget(
      options.config.budgetUsd,
      options.config.maxTokens,
      options.config.maxMinutes * 60000 - (Date.now() - start),
    );
    const gateway = new Gateway(options.config, logger, budget);
    const codingWorker = options.codingWorkerFactory?.(gateway);
    poolRouter = gateway.modelRouter;
    strategy = chooseExecutionStrategy(options.task, profile);
    logger.log("execution_strategy", {
      execution_strategy: strategy.execution_strategy,
      execution_effort: strategy.execution_effort,
      strategy_reason: strategy.strategy_reason,
    });
    const routingResume = await buildTaskResume(options.task, profile, strategy, {
      globalBudgetUsd: options.config.budgetUsd,
      absoluteCapUsd: options.config.routing.researchAbsoluteCapUsd,
      fraction: options.config.routing.researchBudgetFraction,
    }, async (taskProfile: DeterministicTaskProfile, capUsd: number) => {
      if (!gateway.modelRouter) return undefined;
      const context = {
        task: options.task,
        likelyPaths: taskProfile.likelyPaths,
        repositoryFiles: profile.files.slice(0, 240),
        symbols: profile.symbols.slice(0, 80),
        verificationCommands: profile.verificationCommands,
      };
      const tools = [{ type: "function" as const, function: {
        name: "submit_routing_scout",
        description: "Return read-only, repository-backed routing evidence.",
        parameters: { type: "object", additionalProperties: false,
          properties: {
            paths: { type: "array", items: { type: "string" }, maxItems: 12 },
            symbols: { type: "array", items: { type: "string" }, maxItems: 12 },
            evidence: { type: "array", items: { type: "string" }, maxItems: 16 },
            reproduction: { type: "string" },
          }, required: ["paths", "symbols", "evidence"] },
      }}];
      const messages = [{ role: "system" as const,
        content: "Localize the task using only the supplied repository inventory. Read only. Cite concrete listed paths/symbols; never invent a path. Submit the structured tool once." },
      { role: "user" as const, content: JSON.stringify(context) }];
      const inputTokens = Buffer.byteLength(JSON.stringify({ messages, tools })) + 256;
      const scoutSubtask: Subtask = {
        id: "routing-scout", title: options.task, objective: options.task,
        dependsOn: [], likelyReadPaths: taskProfile.likelyPaths,
        likelyWritePaths: taskProfile.likelyPaths, readOnly: true,
        integrationContract: "Read-only routing evidence", verificationCommands: [],
        estimatedDifficulty: "low", parallelSafe: false,
      };
      const features = extractFeatures(scoutSubtask, profile, inputTokens, undefined, "planned");
      features.taskKind = "planning";
      let selected;
      try {
        selected = await gateway.modelRouter.select(features, "routing-scout", [], undefined,
          false, undefined, { budgetUsd: capUsd, inputTokens,
            outputTokens: options.config.routing.researchMaxOutputTokens });
      } catch {
        logger.log("routing_research_skipped", { reason: "no compatible scout fits research budget", cap_usd: capUsd });
        return undefined;
      }
      const md = selected.metadata;
      if (md.inputPrice === undefined || md.outputPrice === undefined ||
          (inputTokens * md.inputPrice + options.config.routing.researchMaxOutputTokens * md.outputPrice) / 1e6 > capUsd)
        return undefined;
      const since = logger.events.length;
      const response = await gateway.call(selected.model.id, messages, "routing-scout", "inspect", 0,
        tools, { requireTool: true, maxOutputTokens: options.config.routing.researchMaxOutputTokens,
          timeoutMs: options.config.routing.researchTimeoutMs });
      const call = logger.events.slice(since).find((event) => event.type === "model_call");
      const control = response.tool_calls?.find((item) => item.type === "function" &&
        item.function.name === "submit_routing_scout");
      if (!control || control.type !== "function") return undefined;
      const parsed = JSON.parse(control.function.arguments);
      return { result: {
        paths: Array.isArray(parsed.paths) ? parsed.paths.filter((path: unknown): path is string => typeof path === "string") : [],
        symbols: Array.isArray(parsed.symbols) ? parsed.symbols.filter((symbol: unknown): symbol is string => typeof symbol === "string") : [],
        evidence: Array.isArray(parsed.evidence) ? parsed.evidence.filter((item: unknown): item is string => typeof item === "string") : [],
        reproduction: typeof parsed.reproduction === "string" ? parsed.reproduction : undefined,
      }, costUsd: call?.costUsd ?? capUsd, tokens: call ? call.promptTokens + call.completionTokens : 0 };
    });
    const routingResearchCalls = logger.events.filter((event) =>
      event.type === "model_call" && event.subtaskId === "routing-scout");
    logger.log("task_profile", { profile: routingResume.profile,
      micro_scout_used: routingResume.microScoutUsed,
      routing_research_calls: routingResearchCalls.length,
      routing_research_cost_usd: routingResearchCalls.some((call) => call.costUsd === null)
        ? null : routingResearchCalls.reduce((sum, call) => sum + call.costUsd, 0),
      routing_research_tokens: routingResearchCalls.reduce((sum, call) =>
        sum + call.promptTokens + call.completionTokens, 0) });
    const sharedRoutingEvidence: EvidencePacket = {
      relevantFiles: routingResume.relevantPaths,
      symbols: routingResume.scout?.symbols ?? [],
      reproduction: routingResume.scout?.reproduction ?? "",
      failingTests: routingResume.profile.likelyTests,
      likelyRootCause: "",
      dependencies: [],
      uncertainty: routingResume.profile.scopeConfidence === "high" ? "low"
        : routingResume.profile.scopeConfidence === "medium" ? "medium" : "high",
      suggestedApproach: "Use repository-backed paths and inspect current definitions before mutation.",
      evidence: routingResume.evidence,
    };
    let taskVerificationCommands: string[] = [];
    let taskVerificationIsFocused = false;
    let stableRepairContext:
      | {
          subtask: Subtask;
          context: Awaited<ReturnType<typeof compileContext>>;
          evidence: EvidencePacket;
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
      const subtask: Subtask = {
        id: "stable",
        title: options.task,
        objective: options.task,
        dependsOn: [],
        likelyReadPaths: strategy.likelyFiles,
        likelyWritePaths: ["."],
        readOnly: false,
        integrationContract:
          "Discover the concrete implementation files in the isolated candidate workspace, implement the smallest correct change, and preserve existing public interfaces",
        verificationCommands: [],
        estimatedDifficulty: "normal",
        parallelSafe: false,
      };

      logger.log("task_start", { subtaskId: subtask.id });
      logger.log("stable_discovery_start", {
        subtaskId: subtask.id,
        initial_write_scope: ["."],
        context_files: context.files.map((file) => file.path),
      });

      const preflightStarted = Date.now();
      const preflight = await stableNoChangePreflight(
        integration.path,
        options.task,
        profile,
        () => Math.min(options.config.commandTimeoutMs, budget.remainingMs()),
        (check) => logger.log("verification", { subtaskId: subtask.id, ...check }),
      );
      logger.log("latency", {
        stable_no_change_preflight_ms: Date.now() - preflightStarted,
      });
      if (preflight.satisfied)
        logger.log("no_changes_required", { subtaskId: subtask.id,
          status: "VERIFIED_SUCCESS", reason: "acceptance_checks_already_pass",
          diffBytes: 0, verificationCommands: preflight.verification.checks.map((check) => check.command),
          evidence_paths: preflight.evidencePaths });

      const result = preflight.satisfied
        ? { verification: preflight.verification, evidence: {
            relevantFiles: preflight.evidencePaths, symbols: [], reproduction: "Passing repository test",
            failingTests: [], likelyRootCause: "Already satisfied", dependencies: [],
            uncertainty: "low" as const, suggestedApproach: "No mutation required",
            evidence: preflight.evidencePaths.map((path) => `assertion_code:${path}`),
          }, noChangesRequired: true, role: "CHEAP_CODER_A" as const }
        : await implement(
            gateway,
            integration.path,
            options.task,
            subtask,
            { acceptanceCriteria: [options.task] },
            profile,
            { codingWorker, compiledContext: context, finalVerificationOnly: true,
              evidence: sharedRoutingEvidence },
          );

      const operationalFailure = result.verification.checks.find(
        (check) =>
          check.outcome === "INFRA_FAILURE" ||
          check.outcome === "CHECK_UNAVAILABLE",
      );
      if (operationalFailure) {
        status = "NOT_FULLY_VERIFIED";
        logger.log("verification_infrastructure_failure", {
          subtaskId: subtask.id,
          phase: "focused",
          command: operationalFailure.command,
          unavailable: operationalFailure.unavailable,
          checks: result.verification.checks,
        });
        throw Error(
          `Verification infrastructure unavailable: ${operationalFailure.command}: ${operationalFailure.unavailable ?? operationalFailure.stderr ?? "verification could not execute"}`,
        );
      }

      if (result.verification.status === "FAILED")
        throw Error("stable: worker failed before final verification");

      await assertWriteResponsibility(integration.path, subtask);

      const alreadySatisfied =
        "noChangesRequired" in result && result.noChangesRequired;

      if (!alreadySatisfied) {
        const pendingChanges = await backend.changes(integration.path);
        const actualChangedPaths = [
          ...new Set(pendingChanges.map((change) => change.path)),
        ];

        if (!actualChangedPaths.length)
          throw Error("stable: discovery worker produced no changes");

        const reservedChanges = actualChangedPaths.filter(
          (path) =>
            path === ".koda" ||
            path.startsWith(".koda/") ||
            path === ".git" ||
            path.startsWith(".git/"),
        );
        if (reservedChanges.length)
          throw Error(
            `stable: worker modified Koda/Git internal paths: ${reservedChanges.join(", ")}`,
          );

        const unauthorizedTests = requestsTestMutation(options.task)
          ? []
          : actualChangedPaths.filter(isTestPath);
        if (unauthorizedTests.length)
          throw Error(
            `stable: worker changed tests without an explicit test-edit request: ${unauthorizedTests.join(", ")}`,
          );

        if (
          !taskRelevantMutationPaths(
            options.task,
            actualChangedPaths,
            pendingChanges,
          ).length
        )
          throw Error(
            "stable: worker produced no task-relevant implementation changes",
          );

        const repairProfile = await profileRepo(integration.path);
        const repairSubtask: Subtask = {
          ...subtask,
          likelyReadPaths: [
            ...new Set([...strategy.likelyFiles, ...actualChangedPaths]),
          ],
          likelyWritePaths: actualChangedPaths,
        };

        const repairContext = await compileContext(
          integration.path,
          options.task,
          actualChangedPaths,
          repairProfile,
          options.config.context,
          true,
        );

        const stableFocusedCheck = targetedProjectUnitNativeCheck(
          repairSubtask,
          repairProfile,
          repairContext,
        );
        if (stableFocusedCheck) {
          taskVerificationCommands = [stableFocusedCheck];
          taskVerificationIsFocused = true;
          repairSubtask.verificationCommands = [stableFocusedCheck];
        }

        const candidateEvidence: EvidencePacket = {
          ...result.evidence,
          relevantFiles: [
            ...new Set([
              ...result.evidence.relevantFiles,
              ...actualChangedPaths,
            ]),
          ],
          evidence: [
            ...new Set([
              ...result.evidence.evidence,
              ...actualChangedPaths.map(
                (path) => `mini_swe_changed_path:${path}`,
              ),
            ]),
          ],
        };

        stableRepairContext = {
          subtask: repairSubtask,
          context: repairContext,
          evidence: candidateEvidence,
        };

        logger.log("stable_discovery_scope_locked", {
          subtaskId: subtask.id,
          initial_write_scope: ["."],
          actual_changed_paths: actualChangedPaths,
          repair_write_scope: repairSubtask.likelyWritePaths,
        });

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
      }

      logger.log("task_complete", {
        subtaskId: subtask.id,
        verification: alreadySatisfied
          ? "VERIFIED_SUCCESS"
          : "AWAITING_FINAL_VERIFICATION",
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
              options.task,
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
          codingWorker,
          compiledContext: context,
          tinyDirect: strategy.execution_effort === "tiny",
          finalVerificationOnly: strategy.execution_effort === "tiny",
          evidence: sharedRoutingEvidence,
        },
      );
      if (strategy.execution_effort === "tiny")
        directRepairContext = { subtask, context };
      if (result.verification.checks.some((check) =>
        check.outcome === "INFRA_FAILURE" || check.outcome === "CHECK_UNAVAILABLE")) {
        status = "NOT_FULLY_VERIFIED";
        const failed = result.verification.checks.find((check) =>
          check.outcome === "INFRA_FAILURE" || check.outcome === "CHECK_UNAVAILABLE");
        throw Error(`Verification infrastructure unavailable: ${failed?.command}: ${failed?.unavailable ?? failed?.stderr ?? "verification could not execute"}`);
      }
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
      const rawPlan = await compileTask(gateway, options.task, profile, routingResume);
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
        const nodePaths = new Set([...subtask.likelyReadPaths, ...subtask.likelyWritePaths]);
        const nodeRoutingEvidence: EvidencePacket = {
          ...sharedRoutingEvidence,
          relevantFiles: sharedRoutingEvidence.relevantFiles.filter((path) => nodePaths.has(path)),
          failingTests: sharedRoutingEvidence.failingTests.filter((path) => nodePaths.has(path)),
          evidence: sharedRoutingEvidence.evidence.filter((fact) =>
            !profile.files.some((path) => fact.includes(path)) || nodePaths.has(
              profile.files.find((path) => fact.includes(path))!)),
        };
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
            await inheritDependencyEnvironment(integration!.path, wt.path);
            let evidence: EvidencePacket;
            try {
              evidence = await discover(
                gateway,
                wt.path,
                options.task,
                subtask,
                plan,
                profile,
                inheritedEvidence,
              );
            } catch (failure) {
              // Discovery is advisory. A failed scout cannot grant writes or
              // prevent a dependent coder from inspecting its own workspace.
              await assertWriteResponsibility(wt.path, subtask);
              evidence = {
                relevantFiles: subtask.likelyReadPaths.filter((file) => profile.files.includes(file)),
                symbols: [], reproduction: "", failingTests: [], likelyRootCause: "",
                dependencies: [], uncertainty: "high",
                suggestedApproach: "Inspect the relevant source before editing; discovery did not establish a finding.",
                evidence: [],
              };
              logger.log("discovery_fallback", {
                subtaskId: subtask.id, reason: String(failure),
                relevantFiles: evidence.relevantFiles,
              });
            }
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
            await inheritDependencyEnvironment(integration!.path, wt.path);
            const candidateTask = { ...subtask, id: subtask.id + suffix };
            const result = await implement(
              gateway,
              wt.path,
              options.task,
              candidateTask,
              plan,
              profile,
              {
                codingWorker,
                initialRole,
                stop,
                raceGroup: suffix ? subtask.id : undefined,
                evidence: combineEvidence([nodeRoutingEvidence, ...inheritedEvidence]),
              },
            );
            if (result.verification.status !== "VERIFIED_SUCCESS" &&
                !advisoryInfrastructureOnly(result.verification)) {
              if (result.verification.status === "NOT_FULLY_VERIFIED")
                status = "NOT_FULLY_VERIFIED";
              throw Error(`${subtask.id}: ${result.verification.status}`);
            }
            if (advisoryInfrastructureOnly(result.verification))
              logger.log("verification_advisory_unavailable", {
                subtaskId: subtask.id,
                checks: result.verification.checks.filter((check) => check.unavailable),
              });
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
        if (winner.revision.changes.length) {
          logger.log("integration_start", { subtaskId: subtask.id });
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
                { codingWorker, initialRole: "STRONG_MODEL", extra },
              );
              if (result.verification.status !== "VERIFIED_SUCCESS")
                throw Error("Conflict resolution not verified");
            },
          );
        }
        logger.log("task_complete", {
          subtaskId: subtask.id,
          verification: winner.result.verification.status,
        });
        await backend!.cleanupWorker(winner.wt);
      };
      const { peak: scheduledParallelPeak } = await schedule(plan.subtasks, options.config.maxParallel, execute, (t) =>
        options.config.race &&
        !options.config.forceModel &&
        t.estimatedDifficulty === "high" &&
        options.config.maxParallel >= 2
          ? 2
          : 1,
      );
      scheduledTaskParallelPeak = scheduledParallelPeak;
      const routed = plan.subtasks.flatMap((subtask) => {
        const event = [...logger.events].reverse().find((candidate) =>
          candidate.type === "specialist_route" && candidate.subtaskId === subtask.id);
        return event ? [{ subtask, event }] : [];
      });
      if (routed.length) {
        const critical = (field: "expected_completion_latency_p50_ms" | "expected_completion_latency_p90_ms") => {
          const totals = new Map<string, number>();
          for (const { subtask, event } of routed) {
            const parents = subtask.dependsOn.map((id) => totals.get(id) ?? 0);
            totals.set(subtask.id, Math.max(0, ...parents) + Number(event[field] ?? 0));
          }
          return Math.max(0, ...totals.values());
        };
        logger.log("execution_plan_summary", {
          subtasks: routed.map(({ subtask, event }) => ({
            subtask: subtask.id, initial_model: event.selected_model,
            approved_recovery_candidates: event.approved_recovery_candidates,
            expected_cost_usd: event.expected_completion_cost_usd,
            expected_latency_p50_ms: event.expected_completion_latency_p50_ms,
            expected_latency_p90_ms: event.expected_completion_latency_p90_ms,
          })),
          expected_total_model_cost_usd: routed.reduce((sum, { event }) =>
            sum + Number(event.expected_completion_cost_usd ?? 0), 0),
          expected_dag_critical_path_p50_ms: critical("expected_completion_latency_p50_ms"),
          expected_dag_critical_path_p90_ms: critical("expected_completion_latency_p90_ms"),
          max_expected_parallelism: scheduledParallelPeak,
        });
      }

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
    if (!allFinalCandidates.some((candidate) => candidate.available)) {
      const recovered = await focusedLocalReproduction(finalProfile, options.task, verificationPaths);
      if (recovered) {
        for (let i = allFinalCandidates.length - 1; i >= 0; i--)
          if (optionalUnavailableCheck(allFinalCandidates[i]!))
            allFinalCandidates.splice(i, 1);
        allFinalCandidates.push(recovered);
        logger.log("verification_recovery", { phase: "final", command: recovered.command,
          source: recovered.source });
      }
    }
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
    if (!taskVerificationIsFocused)
      taskVerificationCommands = repoBackedVerificationCommands(
        taskVerificationCommands,
        finalProfile,
      );
    const impact = impactAwareVerificationSelection({
      changedPaths: changed,
      candidates: allFinalCandidates,
      focusedCommands: taskVerificationCommands,
    });
    const finalPlan = documentCommands
      ? allFinalCandidates.filter((candidate) =>
          documentCommands.has(candidate.command),
        )
      : impact.candidates;
    logger.log("verification_plan", { phase: "final", candidates: finalPlan,
      why_full_suite: documentCommands ? false : impact.whyFullSuite,
      impacted_tests: documentCommands ? changed : impact.impactedTests,
      evidence: documentCommands ? ["documentation-only verified targets"] : impact.evidence });
    const finalCommands = [
      ...finalPlan.map((c) => c.command),
      ...(tinyDocs ? [] : taskVerificationCommands),
      ...(options.verify ?? []),
    ];
    const explicitlyRequiredCommands = new Set([
      ...(tinyDocs ? [] : taskVerificationCommands),
      ...(options.verify ?? []),
    ]);
    const finalCandidates = finalPlan.map((candidate) =>
      explicitlyRequiredCommands.has(candidate.command)
        ? { ...candidate, requirement: "required" as const }
        : candidate,
    );
    let finalBaseline: VerificationResult | undefined;
    const runFinalVerification = async () => {
      const finalVerificationStarted = Date.now();
      let executable = await verify(
        integration!.path,
        finalCommands,
        () => Math.min(options.config.commandTimeoutMs, budget.remainingMs()),
        (c) => logger.log("final_verification", c as any),
        undefined,
        finalCandidates,
      );
      if (executable.checks.some((check) => check.outcome !== "CHECK_PASS")) {
        finalBaseline ??= await verify(
          backend!.baselinePath, finalCommands,
          () => Math.min(options.config.commandTimeoutMs, budget.remainingMs()),
          (check) => logger.log("final_baseline_verification", check as any),
          undefined, finalCandidates,
        );
        executable = verificationAgainstBaseline(finalBaseline, executable);
      }
      const unavailableChecks = executable.checks.filter((check) =>
        check.outcome === "INFRA_FAILURE" || check.outcome === "CHECK_UNAVAILABLE");
      if (unavailableChecks.length)
        logger.log("verification_infrastructure_failure", {
          phase: "final",
          checks: unavailableChecks,
        });
      if (!tinyDocs) {
        logger.log("latency", {
          final_verification_ms: Date.now() - finalVerificationStarted,
        });
        return executable;
      }
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
      const result = verificationResult([...executable.checks, structural]);
      logger.log("latency", {
        final_verification_ms: Date.now() - finalVerificationStarted,
      });
      return result;
    };
    verification = await runFinalVerification();
    if (
      stableRepairContext &&
      changed.length > 0 &&
      verification.status === "FAILED" &&
      finalBaseline &&
      verificationRegressions(finalBaseline, verification).length > 0
    ) {
      finalBaseline ??= await verify(
        backend!.baselinePath,
        finalCommands,
        () => Math.min(options.config.commandTimeoutMs, budget.remainingMs()),
        (check) => logger.log("stable_final_baseline", check as any),
        undefined,
        finalCandidates,
      );
      const failedPatchContext = async () => {
        const uncommitted = await currentDiff(integration!.path);
        if (uncommitted.trim()) return uncommitted;
        const changes = await backend!.changes(integration!.path);
        const entries = await Promise.all(changes.slice(0, 8).map(async (change) => {
          const before = await readFile(join(backend!.baselinePath, change.path), "utf8").catch(() => "<new file>");
          const after = await readFile(join(integration!.path, change.path), "utf8").catch(() => "<deleted file>");
          const beforeLines = before.split("\n"), afterLines = after.split("\n");
          let first = 0;
          while (first < beforeLines.length && first < afterLines.length &&
            beforeLines[first] === afterLines[first]) first++;
          const start = Math.max(0, first - 10);
          return `--- baseline/${change.path}\n+++ candidate/${change.path}\n@@ -${start + 1} +${start + 1} @@\n` +
            truncateBytes(beforeLines.slice(start, first + 30).map((line) => `-${line}`).join("\n"), 3000) + "\n" +
            truncateBytes(afterLines.slice(start, first + 30).map((line) => `+${line}`).join("\n"), 3000);
        }));
        return entries.join("\n");
      };
      let failedChecks = verificationRegressions(finalBaseline, verification);
      const failureContext = async (checks: CommandResult[]) => {
        const identities = checks.flatMap((check) => newFailureIds(check, finalBaseline!.checks));
        const contexts = await Promise.all(identities.slice(0, 4).map(async (identity) => {
          const [relativePath, ...parts] = identity.split("::");
          if (!relativePath || !/^[\w./-]+\.py$/.test(relativePath) || relativePath.includes("..")) return undefined;
          const content = await readFile(await safePath(integration!.path, relativePath), "utf8").catch(() => "");
          if (!content) return undefined;
          const symbol = parts.at(-1);
          const lines = content.split("\n");
          const index = symbol ? lines.findIndex((line) => new RegExp(`\\b(?:def|class)\\s+${symbol.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\b`).test(line)) : -1;
          const start = Math.max(0, index < 0 ? 0 : index - 8);
          return { path: relativePath, symbol,
            content: truncateBytes(lines.slice(start, start + 60).join("\n"), 6000) };
        }));
        return contexts.filter((item): item is NonNullable<typeof item> => !!item);
      };
      const regressionDiagnostics = (baseline: VerificationResult, checks: CommandResult[]) =>
        checks.map((check) => {
          const previous = baseline.checks.find((item) => item.command === check.command);
          const priorLines = new Set(`${previous?.stdout ?? ""}\n${previous?.stderr ?? ""}`
            .split("\n").map((line) => line.trim()).filter(Boolean));
          const novel = `${check.stdout}\n${check.stderr}`.split("\n")
            .filter((line) => line.trim() && !priorLines.has(line.trim()))
            .filter((line) => /FAIL|Error|Assertion|expected|actual|\bE\s+|✖/i.test(line))
            .slice(0, 30);
          return `${check.command}\n${novel.join("\n")}`;
        });
      if (!failedChecks.length) {
        logger.log("stable_final_baseline_unchanged", {
          checks: verification.checks.filter((check) => check.outcome === "CHECK_FAIL"),
        });
      }
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
        // Execute the focused regression before repair. Never label broad-suite
        // stdout as if it came from a focused command.
        const repairChecks = await prepareRepairChecks(failedChecks, finalBaseline.checks,
          async (focusedCommand) => {
            const focused = await verify(integration!.path, [focusedCommand],
              () => Math.min(options.config.commandTimeoutMs, gateway.budget.remainingMs()),
              (result) => logger.log("stable_repair_diagnostic", result), undefined,
              [{ command: focusedCommand, kind: "test", available: true,
                source: "repo-check:focused-new-regression", cwd: ".", confidence: 1,
                mutatesSource: false, requiresInstalledDependencies: true }]);
            return focused.checks[0];
          });
        const beforeRepair = JSON.stringify(
          await backend.changes(integration.path),
        );
        const repairScope = new WriteScope(stableRepairContext.subtask.likelyWritePaths,
          logger, stableRepairContext.subtask.id);
        const repairCheckpoint = await AttemptCheckpoint.capture(integration.path, repairScope);
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
              codingWorker,
              compiledContext: stableRepairContext.context,
              evidence: stableRepairContext.evidence,
              finalVerificationOnly: true,
              adaptiveStartTier:
                options.config.adaptiveCoding && !options.config.forceModel
                  ? attempt === 1
                    ? "high"
                    : "frontier"
                  : undefined,
              stableRepair: {
                attempt,
                failedChecks: repairChecks,
                changedFiles: (await backend.changes(integration.path)).map(
                  (change) => change.path,
                ),
                failedDiff: await failedPatchContext(),
                implicatedSymbols: stableRepairContext.evidence.symbols,
                baselineChecks: finalBaseline.checks,
                regressionDiagnostics: regressionDiagnostics(finalBaseline, failedChecks),
                failureContext: await failureContext(failedChecks),
              },
              extra: {
                instruction:
                  "Repair the existing implementation. Do not restart discovery. The failed command will be rerun before the full final verification.",
                failedChecks,
              },
            },
          );
        } catch (repairError) {
          await repairCheckpoint.restore(integration!.path, repairScope);
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
        if (repair.verification.status === "FAILED") {
          await repairCheckpoint.restore(integration.path, repairScope);
          throw Error(`Stable final repair ${attempt} failed`);
        }
        try {
          await assertWriteResponsibility(integration.path,
            stableRepairContext.subtask);
        } catch (error) {
          await repairCheckpoint.restore(integration.path, repairScope);
          throw error;
        }
        if (
          JSON.stringify(await backend.changes(integration.path)) ===
          beforeRepair
        ) {
          await repairCheckpoint.restore(integration.path, repairScope);
          throw Error(`Stable final repair ${attempt} produced no changes`);
        }
        const targeted = repair.verification;
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
        if (unavailableRepair) {
          verification = targeted;
          logger.log("stable_final_repair_operational_failure", {
            attempt,
            command: unavailableRepair.command,
            unavailable: unavailableRepair.unavailable,
          });
          break;
        }
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
          await repairCheckpoint.restore(integration.path, repairScope);
          if (
            failedChecks.length >= previousFailureCount &&
            failureSignature(failedChecks) === previousSignature
          )
            break;
          continue;
        }
        const verifiedRepairState = JSON.stringify(await backend.changes(integration.path));
        if (verifiedRepairState === "[]")
          throw Error("Stable repair removed all task changes; baseline restoration is not verified completion");
        const rawFinalVerification = await runFinalVerification().catch(async (error) => {
          await repairCheckpoint.restore(integration!.path, repairScope);
          throw error;
        });
        verification = verificationAgainstBaseline(finalBaseline, rawFinalVerification);
        logger.log("stable_final_verification_relative_to_baseline", {
          status: verification.status,
          regressions: verificationRegressions(finalBaseline, rawFinalVerification),
        });
        if (verification.status === "VERIFIED_SUCCESS") {
          if (JSON.stringify(await backend.changes(integration.path)) !== verifiedRepairState)
            throw Error("Verified repair state changed during final verification");
          await backend.finalizeWorker(integration,
            `agent: stable final repair ${attempt}`);
          if (JSON.stringify(await backend.changes(integration.path)) !== verifiedRepairState)
            throw Error("Verified repair state disappeared or changed during promotion");
          acceptedRepairState = verifiedRepairState;
          logger.log("stable_final_repair_success", { attempt });
          break;
        }
        if (verification.status === "NOT_FULLY_VERIFIED" &&
            verification.checks.some((check) =>
              check.outcome === "INFRA_FAILURE" || check.outcome === "CHECK_UNAVAILABLE")) {
          logger.log("stable_final_repair_operational_failure", {
            attempt,
            checks: verification.checks.filter((check) =>
              check.outcome === "INFRA_FAILURE" || check.outcome === "CHECK_UNAVAILABLE"),
          });
          break;
        }
        await repairCheckpoint.restore(integration!.path, repairScope);
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
      changed.length > 0 &&
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
              codingWorker,
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
        (check.requirement ?? "required") === "required" &&
        (check.outcome === "INFRA_FAILURE" ||
          check.outcome === "CHECK_UNAVAILABLE"),
    );
    if (unavailable) {
      logger.log("verification_infrastructure_failure", {
        phase: "final",
        command: unavailable.command,
        unavailable: unavailable.unavailable,
        checks: verification.checks,
      });
      throw Error(
        `Final verification infrastructure unavailable: ${unavailable.command}: ${unavailable.unavailable ?? "verification could not execute"}`,
      );
    }
  } catch (e) {
    const message = String(e);
    if (/Verification infrastructure unavailable/i.test(message))
      status = "NOT_FULLY_VERIFIED";
    else if (status === "VERIFIED_SUCCESS") status = "FAILED";
    error = message;
    logger.log("run_error", { error });
  }
  if (backend && integration) {
    try {
      applyResult = {
        ...applyResult,
        changes: await backend.persistCandidate(output, integration),
      };
      if (acceptedRepairState !== undefined &&
          JSON.stringify(applyResult.changes) !== acceptedRepairState) {
        await backend.apply(output, integration, false);
        throw Error("Accepted verified repair state changed before apply");
      }
      applyResult = await backend.apply(
        output,
        integration,
        status === "VERIFIED_SUCCESS",
      );
      if (options.apply && status === "VERIFIED_SUCCESS" && applyResult.status !== "applied")
        throw Error("Verified state was not applied to the target repository");
    } catch (e) {
      status = "FAILED";
      error = `${error ? error + "; " : ""}Apply preparation failed: ${String(e)}`;
      applyResult = {
        requested: !!options.apply,
        status: "not_verified",
        conflicts: [],
        changes: applyResult.changes,
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
  const candidateProduced = changedFiles.length > 0;
  const candidatePatchPath = candidateProduced
    ? join(output, "candidate.patch")
    : null;
  const summary = {
    ...summarize(
      logger,
      status,
      Date.now() - start,
      verification,
      changedFiles,
      scheduledTaskParallelPeak,
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
    candidateProduced,
    candidatePatchPath,
    candidateChangedFiles: changedFiles,
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
    console.log(`Latency (ms): ${JSON.stringify(summary.latencyBreakdown)}`);
    for (const [model, cost] of Object.entries(summary.models))
      console.log(`${model}: $${cost.costUsd.toFixed(6)}`);
    console.log(
      `Integration: ${integration?.path ?? "not created"}\nReport: ${join(output, "summary.json")}`,
    );
  }
  return summary;
}

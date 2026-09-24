import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { readFile, realpath, rm, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Budget } from "../openrouter/usage.js";
import type { Logger } from "../telemetry/logger.js";
import { WriteScope, scopedCommand } from "../repo/writeScope.js";
import { command } from "../repo/commands.js";
import { AttemptCheckpoint } from "./attemptCheckpoint.js";
import type { CodingWorker, CodingWorkerInput, CodingWorkerResult } from "./codingWorker.js";
import { bridgeForRuntime, ensureMiniSweRuntime, MINI_SWE_VERSION } from "./miniSweRuntime.js";
import { DirectEditWorker } from "./directEditWorker.js";

const PLACEHOLDER_KEY = /^(?:redacted|replace[_ -]?me|your[_ -]?(?:api[_ -]?)?key|changeme|none|null)$/i;

export function sanitizeOpenRouterApiKey(value: string | undefined) {
  const key = value?.trim() ?? "";
  if (!key) throw Error("INFRA_FAILURE: OPENROUTER_API_KEY is missing");
  if (PLACEHOLDER_KEY.test(key))
    throw Error("INFRA_FAILURE: OPENROUTER_API_KEY is a placeholder");
  if (/[\r\n]/.test(key)) throw Error("INFRA_FAILURE: OPENROUTER_API_KEY is malformed");
  return key;
}

export const redactOpenRouterSecret = (value: string | undefined, secret: string) =>
  value?.replaceAll(secret, "[REDACTED]");

export type MiniSweBridgeRunner = (input: CodingWorkerInput & { trajectoryPath: string }) =>
  Promise<Omit<CodingWorkerResult, "changedPaths">>;

export interface MiniSweWorkerOptions {
  runner?: MiniSweBridgeRunner;
  ensureRuntime?: () => Promise<string>;
}

export class MiniSweWorker implements CodingWorker {
  constructor(readonly budget: Budget, readonly logger: Logger,
    private readonly options: MiniSweWorkerOptions = {}) {}

  private async invoke(input: CodingWorkerInput & { trajectoryPath: string }) {
    if (this.options.runner) return this.options.runner(input);
    const apiKey = sanitizeOpenRouterApiKey(globalThis.process.env.OPENROUTER_API_KEY);
    const python = await (this.options.ensureRuntime ?? ensureMiniSweRuntime)();
    const exchange = await mkdtemp(join(tmpdir(), "koda-miniswe-ipc-"));
    const requestPath = join(exchange, "request.json"), responsePath = join(exchange, "response.json");
    const localTrajectory = join(exchange, "trajectory.json");
    await writeFile(requestPath, JSON.stringify({ ...input, trajectoryPath: localTrajectory }));
    const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
    const runtimeRoot = join(python, "../../");
    const interpreterRoot = dirname(dirname(await realpath(python)));
    const execution = await command(input.repoPath,
      `${quote(python)} ${quote(bridgeForRuntime(python))} < ${quote(requestPath)} > ${quote(responsePath)}`,
      input.timeoutMs + 5_000, false, undefined,
      [],
      false, undefined, globalThis.process.env, true, ".",
      { OPENROUTER_API_KEY: apiKey, PYTHONUNBUFFERED: "1" }, [exchange],
      [runtimeRoot, interpreterRoot]);
    let parsed: Omit<CodingWorkerResult, "changedPaths">;
    try {
      parsed = JSON.parse(redactOpenRouterSecret(await readFile(responsePath, "utf8"), apiKey)!);
      const trajectory = await readFile(localTrajectory, "utf8").catch(() => undefined);
      if (trajectory !== undefined)
        await writeFile(input.trajectoryPath, redactOpenRouterSecret(trajectory, apiKey)!);
    }
    catch {
      if (execution.timedOut)
        throw Error("TIMEOUT: mini-SWE bridge exceeded the attempt wall-clock limit");
      throw Error(`INFRA_FAILURE: invalid mini-SWE bridge response: ${redactOpenRouterSecret(execution.stderr.slice(-2000), apiKey)}`);
    }
    finally { await rm(exchange, { recursive: true, force: true }); }
    return { ...parsed, trajectoryPath: input.trajectoryPath,
      stderr: redactOpenRouterSecret([parsed.stderr, execution.stderr].filter(Boolean).join("\n"), apiKey) };
  }

  async run(input: CodingWorkerInput): Promise<CodingWorkerResult> {
    // DIRECT is already localized by Koda. Do not pay for a repository-browsing
    // mini-SWE loop when one concrete target and a bounded source packet exist.
    // The direct worker performs one structured model call; Koda still owns
    // path validation, patch application, verification, rollback and recovery.
    if (!this.options.runner && input.attemptId === "direct" && input.returnOnMutation &&
        input.writeScope.length === 1 && input.writeScope[0] !== ".") {
      this.logger.log("direct_edit_dispatch", {
        subtaskId: input.attemptId,
        model: input.model,
        target: input.writeScope[0],
      });
      const direct = await new DirectEditWorker(this.budget, this.logger).run(input);
      if (direct.terminationReason !== "direct_edit_unsupported") return direct;
      this.logger.log("direct_edit_fallback", {
        subtaskId: input.attemptId,
        model: input.model,
        target: input.writeScope[0],
        reason: direct.fatalError ?? direct.terminationReason,
      });
    }

    const scope = new WriteScope(input.writeScope, this.logger, `mini-swe:${input.model}`);
    const checkpoint = await AttemptCheckpoint.capture(input.repoPath, scope);
    const trajectoryPath = join(this.logger.directory,
      `mini-swe-${input.model.replace(/[^a-z0-9.-]+/gi, "_")}-${randomUUID().slice(0, 8)}.json`);
    const started = Date.now();
    let release: ReturnType<Budget["reserve"]> | undefined;
    let attemptBegan = false;
    try {
      if (!this.options.runner) await (this.options.ensureRuntime ?? ensureMiniSweRuntime)();
      release = this.budget.reserve(input.budgetUsd, input.maxTokens);
      let bridge: Omit<CodingWorkerResult, "changedPaths"> | undefined;
      const execute = async (copy: string, remainingMs: number) => {
        attemptBegan = true;
        bridge = await this.invoke({ ...input, repoPath: copy,
          timeoutMs: Math.min(input.timeoutMs, remainingMs), trajectoryPath });
        return { command: "mini-swe-agent bridge", cwd: ".",
          exitCode: bridge.exitStatus === "infra_failure" ? 2 : 0,
          stdout: JSON.stringify(bridge), stderr: bridge.stderr ?? "",
          wallClockMs: bridge.wallClockMs, timedOut: bridge.terminationReason === "TimeExceeded" };
      };
      const commandResult = input.directFullScope && scope.paths.length === 1 && scope.paths[0] === "."
        ? await execute(input.repoPath, input.timeoutMs)
        : await scopedCommand(input.repoPath, scope, execute, input.timeoutMs + 5_000);
      if (!bridge) throw Error("INFRA_FAILURE: mini-SWE bridge produced no result");
      const usageKnown = bridge.costUsd !== undefined && bridge.inputTokens !== undefined &&
        bridge.outputTokens !== undefined;
      if (usageKnown) release.settle({
        promptTokens: bridge.inputTokens!, completionTokens: bridge.outputTokens!,
        reasoningTokens: 0, cachedTokens: bridge.cachedInputTokens ?? 0,
        cacheWriteTokens: bridge.cacheWriteTokens ?? 0,
        costUsd: bridge.costUsd!, raw: null,
      });
      else release.settleUncertain();
      release = undefined;
      if (bridge.model !== input.model) {
        await checkpoint.restore(input.repoPath, scope);
        throw Error(`INFRA_FAILURE: mini-SWE changed routed model from ${input.model} to ${bridge.model}`);
      }
      if (bridge.exitStatus === "infra_failure" || commandResult.stderr.includes("WRITE_SCOPE_VIOLATION"))
        await checkpoint.restore(input.repoPath, scope);
      const changedPaths = (await checkpoint.changed(input.repoPath, scope)).map((change) => change.path);
      if (input.directFullScope)
        for (const changedPath of changedPaths) scope.successful(changedPath, "mini_swe_direct");
      const result: CodingWorkerResult = { ...bridge,
        exitStatus: commandResult.stderr.includes("WRITE_SCOPE_VIOLATION") ? "failed" : bridge.exitStatus,
        changedPaths, wallClockMs: Date.now() - started,
        fatalError: commandResult.stderr.includes("WRITE_SCOPE_VIOLATION")
          ? commandResult.stderr : bridge.fatalError };
      return result;
    } catch (error) {
      if (release) attemptBegan ? release.settleUncertain() : release.cancel();
      await checkpoint.restore(input.repoPath, scope).catch(() => undefined);
      const message = String(error);
      const budgetFailure = /Run (?:USD|token|time) budget exhausted|Run budget cost is unknown/i
        .test(message);
      const timeout = /TIMEOUT|timed?\s*out|wall-clock limit/i.test(message);
      return { exitStatus: "infra_failure", model: input.model,
        engine: "mini-swe-agent", engineVersion: MINI_SWE_VERSION,
        trajectoryPath, changedPaths: [], wallClockMs: Date.now() - started,
        terminationReason: budgetFailure ? "budget_exhausted" : "infrastructure_failure",
        limitKind: budgetFailure ? "run_budget" : timeout ? "timeout" : undefined,
        fatalError: message };
    }
  }
}

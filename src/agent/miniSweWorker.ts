import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile, copyFile } from "node:fs/promises";
import type { Budget } from "../openrouter/usage.js";
import type { Logger } from "../telemetry/logger.js";
import { WriteScope, scopedCommand } from "../repo/writeScope.js";
import { command } from "../repo/commands.js";
import { AttemptCheckpoint } from "./attemptCheckpoint.js";
import type { CodingWorker, CodingWorkerInput, CodingWorkerResult } from "./codingWorker.js";
import { bridgeForRuntime, ensureMiniSweRuntime, MINI_SWE_VERSION } from "./miniSweRuntime.js";

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
    const python = await (this.options.ensureRuntime ?? ensureMiniSweRuntime)();
    const exchange = join(input.repoPath, ".koda", "miniswe");
    const requestPath = join(exchange, "request.json"), responsePath = join(exchange, "response.json");
    const localTrajectory = join(exchange, "trajectory.json");
    await mkdir(exchange, { recursive: true });
    await writeFile(requestPath, JSON.stringify({ ...input, trajectoryPath: localTrajectory }));
    const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
    const runtimeRoot = join(python, "../../");
    const interpreterRoot = dirname(dirname(await realpath(python)));
    const execution = await command(input.repoPath,
      `${quote(python)} ${quote(bridgeForRuntime(python))} < ${quote(requestPath)} > ${quote(responsePath)}`,
      input.timeoutMs + 5_000, false, undefined,
      [{ relativePath: ".koda/miniswe-runtime", sourcePath: runtimeRoot },
        { relativePath: ".koda/miniswe-python", sourcePath: interpreterRoot }],
      false, undefined, globalThis.process.env, true, ".",
      { OPENROUTER_API_KEY: globalThis.process.env.OPENROUTER_API_KEY, PYTHONUNBUFFERED: "1" });
    let parsed: Omit<CodingWorkerResult, "changedPaths">;
    try {
      parsed = JSON.parse(await readFile(responsePath, "utf8"));
      await copyFile(localTrajectory, input.trajectoryPath).catch(() => undefined);
    }
    catch {
      throw Error(`INFRA_FAILURE: invalid mini-SWE bridge response: ${execution.stderr.slice(-2000)}`);
    }
    finally { await rm(exchange, { recursive: true, force: true }); }
    return { ...parsed, trajectoryPath: input.trajectoryPath,
      stderr: [parsed.stderr, execution.stderr].filter(Boolean).join("\n") };
  }

  async run(input: CodingWorkerInput): Promise<CodingWorkerResult> {
    const scope = new WriteScope(input.writeScope, this.logger, `mini-swe:${input.model}`);
    const checkpoint = await AttemptCheckpoint.capture(input.repoPath, scope);
    const trajectoryPath = join(this.logger.directory,
      `mini-swe-${input.model.replace(/[^a-z0-9.-]+/gi, "_")}-${randomUUID().slice(0, 8)}.json`);
    const started = Date.now();
    let release: ReturnType<Budget["reserve"]> | undefined;
    try {
      if (!this.options.runner) await (this.options.ensureRuntime ?? ensureMiniSweRuntime)();
      release = this.budget.reserve(input.budgetUsd, input.maxTokens);
      let bridge: Omit<CodingWorkerResult, "changedPaths"> | undefined;
      const commandResult = await scopedCommand(input.repoPath, scope, async (copy, remainingMs) => {
        bridge = await this.invoke({ ...input, repoPath: copy,
          timeoutMs: Math.min(input.timeoutMs, remainingMs), trajectoryPath });
        return { command: "mini-swe-agent bridge", cwd: ".",
          exitCode: bridge.exitStatus === "infra_failure" ? 2 : 0,
          stdout: JSON.stringify(bridge), stderr: bridge.stderr ?? "",
          wallClockMs: bridge.wallClockMs, timedOut: bridge.terminationReason === "TimeExceeded" };
      }, input.timeoutMs + 5_000);
      if (!bridge) throw Error("INFRA_FAILURE: mini-SWE bridge produced no result");
      const usageKnown = bridge.costUsd !== undefined && bridge.inputTokens !== undefined &&
        bridge.outputTokens !== undefined;
      release(usageKnown ? {
        promptTokens: bridge.inputTokens!, completionTokens: bridge.outputTokens!,
        reasoningTokens: 0, cachedTokens: 0, cacheWriteTokens: 0,
        costUsd: bridge.costUsd!, raw: null,
      } : undefined);
      release = undefined;
      if (bridge.model !== input.model) {
        await checkpoint.restore(input.repoPath, scope);
        throw Error(`INFRA_FAILURE: mini-SWE changed routed model from ${input.model} to ${bridge.model}`);
      }
      if (bridge.exitStatus === "infra_failure" || commandResult.stderr.includes("WRITE_SCOPE_VIOLATION"))
        await checkpoint.restore(input.repoPath, scope);
      const changedPaths = (await checkpoint.changed(input.repoPath, scope)).map((change) => change.path);
      const result: CodingWorkerResult = { ...bridge,
        exitStatus: commandResult.stderr.includes("WRITE_SCOPE_VIOLATION") ? "failed" : bridge.exitStatus,
        changedPaths, wallClockMs: Date.now() - started,
        fatalError: commandResult.stderr.includes("WRITE_SCOPE_VIOLATION")
          ? commandResult.stderr : bridge.fatalError };
      return result;
    } catch (error) {
      if (release) release();
      await checkpoint.restore(input.repoPath, scope).catch(() => undefined);
      const message = String(error);
      return { exitStatus: "infra_failure", model: input.model,
        engine: "mini-swe-agent", engineVersion: MINI_SWE_VERSION,
        trajectoryPath, changedPaths: [], wallClockMs: Date.now() - started,
        terminationReason: "infrastructure_failure", fatalError: message };
    }
  }
}

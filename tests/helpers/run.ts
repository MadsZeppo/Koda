import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { run as productionRun, type RunOptions } from "../../src/run.js";
import type { Gateway } from "../../src/openrouter/client.js";
import type { CodingWorker, CodingWorkerInput } from "../../src/agent/codingWorker.js";
import { AgentTools, toolDefinitions } from "../../src/agent/tools.js";
import { WriteScope } from "../../src/repo/writeScope.js";
import { changesBetween, snapshotTree } from "../../src/workspace/files.js";
import { MINI_SWE_VERSION } from "../../src/agent/miniSweRuntime.js";

/** Adapts historical mocked OpenRouter responses to the new worker test seam.
 * It is test-only; production always constructs MiniSweWorker. */
class MockCodingWorker implements CodingWorker {
  constructor(private readonly gateway: Gateway) {}
  async run(input: CodingWorkerInput) {
    const before = await snapshotTree(input.repoPath);
    const scope = new WriteScope(input.writeScope, this.gateway.logger, input.attemptId);
    const tools = new AgentTools(input.repoPath, false, input.commandTimeoutMs,
      this.gateway.logger, input.attemptId, 8000, scope);
    const relevantFiles = input.context?.relevantFiles ?? [];
    const files = input.context?.sourceFiles ?? [];
    const { sourceFiles: _sourceFiles, ...workerHints } = input.context ?? {};
    const legacyContext = { ...workerHints, files, repoMap: relevantFiles };
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: "Deterministic test CodingWorker. Implement with tools." },
      { role: "user", content: JSON.stringify({ task: input.task, context: legacyContext,
        evidence: input.context?.evidence,
        allowed_write_paths: input.writeScope,
        // Preserve the historical mock-provider request shape while exercising the
        // new production worker boundary. These fields never reach production.
        subtask: { id: input.attemptId, objective: input.task,
          likelyReadPaths: input.context?.relevantFiles ?? [],
          likelyWritePaths: input.writeScope, dependsOn: [] },
        handoff: { originalObjective: input.task, allowedWritePaths: input.writeScope },
        repairPacket: { allowedWritePaths: input.writeScope,
          files: files.map((file) => ({ path: file.path, content: file.snippet,
            complete: input.context?.completePaths?.includes(file.path) ?? false })),
          definitions: [], diagnostics: input.context?.diagnostics,
          previousFailedDiff: input.context?.previousFailedDiff } }) },
    ];
    const tinyDirect = input.writeScope.length > 0 &&
      input.writeScope.every((path) => /\.(?:md|mdx|txt|rst)$/i.test(path));
    const tinyTools = tinyDirect &&
      input.writeScope.every((path) => input.context?.completePaths?.includes(path))
      ? toolDefinitions.filter(
        (tool) => "function" in tool && tool.function.name === "write_file",
      )
      : toolDefinitions;
    const start = this.gateway.logger.events.length;
    try {
      for (let turn = 0; turn < input.maxSteps; turn++) {
        const response: any = await this.gateway.call(input.model, messages,
          input.attemptId, "implement", turn, tinyTools,
          { requireTool: true, maxOutputTokens: input.maxOutputTokens,
            codingRoute: input.codingRoute });
        messages.push(response);
        if (!(response.tool_calls ?? []).length) break;
        for (const call of (response.tool_calls ?? []).slice(0, 8)) {
          let content: string;
          try { content = await tools.execute(call.function.name, JSON.parse(call.function.arguments)); }
          catch (error) { content = `Tool error: ${String(error)}`; }
          messages.push({ role: "tool", tool_call_id: call.id, content });
        }
        const after = await snapshotTree(input.repoPath);
        if (changesBetween(before, after).some((change) => scope.allows(change.path))) break;
      }
      const after = await snapshotTree(input.repoPath);
      const changedPaths = changesBetween(before, after).filter((change) => scope.allows(change.path))
        .map((change) => change.path);
      const calls = this.gateway.logger.events.slice(start).filter((event) =>
        event.type === "model_call" && event.modelRequested === input.model);
      return { exitStatus: "completed" as const, model: input.model,
        engine: "mini-swe-agent" as const, engineVersion: MINI_SWE_VERSION,
        changedPaths, wallClockMs: calls.reduce((sum, call) => sum + call.wallClockMs, 0),
        inputTokens: calls.reduce((sum, call) => sum + call.promptTokens, 0),
        outputTokens: calls.reduce((sum, call) => sum + call.completionTokens, 0),
        costUsd: calls.some((call) => call.costUsd === null) ? undefined
          : calls.reduce((sum, call) => sum + call.costUsd, 0),
        terminationReason: changedPaths.length ? "Submitted" : "NoMutation" };
    } catch (error) {
      return { exitStatus: "infra_failure" as const, model: input.model,
        engine: "mini-swe-agent" as const, engineVersion: MINI_SWE_VERSION,
        changedPaths: [], wallClockMs: 0, terminationReason: "mock_provider_failure",
        fatalError: String(error) };
    }
  }
}

export const codingWorkerFactory = (gateway: Gateway) => new MockCodingWorker(gateway);
export const run = (options: RunOptions) => productionRun({ ...options,
  codingWorkerFactory });
export type { RunOptions };

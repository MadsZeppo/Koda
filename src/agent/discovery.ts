import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { Gateway } from "../openrouter/client.js";
import type { EvidencePacket, Plan, Subtask } from "../planner/schemas.js";
import { evidenceSchema } from "../planner/schemas.js";
import type { RepoProfile } from "../types.js";
import {
  compactProfile,
  compileContext,
  workerReadPaths,
} from "../context/compiler.js";
import { boundMessages } from "../context/bounds.js";
import { AgentTools, currentDiff, toolDefinitions } from "./tools.js";
import { scoutPrompt } from "./prompts.js";
import { extractFeatures } from "../router/features.js";

function responseJson(text: string) {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start)
    throw Error("Discovery returned no JSON object");
  return JSON.parse(cleaned.slice(start, end + 1));
}

/** Execute a planner-declared discovery task without granting any write scope. */
export async function discover(
  gateway: Gateway,
  path: string,
  task: string,
  subtask: Subtask,
  plan: Pick<Plan, "subtasks">,
  profile: RepoProfile,
  dependencyEvidence: EvidencePacket[] = [],
) {
  if (subtask.readOnly !== true || subtask.likelyWritePaths.length)
    throw Error(
      "Discovery execution requires an explicit empty read-only scope",
    );
  const readPaths = workerReadPaths(subtask, plan.subtasks);
  const context = await compileContext(
    path,
    subtask.objective,
    readPaths,
    profile,
    gateway.config.context,
    true,
  );
  const deadline = Date.now() + 45000;
  const tools = new AgentTools(
    path,
    true,
    () =>
      Math.min(10000, deadline - Date.now(), gateway.config.commandTimeoutMs, gateway.budget.remainingMs()),
    gateway.logger,
    subtask.id,
    gateway.config.context.toolResultBytes,
  );
  const before = await currentDiff(path);
  const inspectionTools = toolDefinitions.filter((tool) =>
    tool.type === "function" && ["read_file", "search_code", "list_files", "run_command", "git_diff", "git_status"].includes(tool.function.name));
  const seenActions = new Set<string>();
  const selected = gateway.modelRouter
    ? await gateway.modelRouter.select(
        extractFeatures(
          subtask,
          profile,
          Buffer.byteLength(JSON.stringify(context)),
        ),
        subtask.id,
      )
    : undefined;
  const model = selected?.model.id ?? gateway.config.registry.SCOUT_MODEL;
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: scoutPrompt },
    {
      role: "user",
      content: JSON.stringify({
        task,
        subtask: { ...subtask, likelyReadPaths: readPaths },
        allowed_write_paths: [],
        dependencyEvidence,
        profile: compactProfile(profile),
        context,
      }),
    },
  ];
  gateway.logger.log("worker_scope", {
    subtaskId: subtask.id,
    read_only: true,
    allowed_write_paths: [],
    context_files: context.files.map((file) => file.path),
  });
  gateway.logger.log("route", {
    subtaskId: subtask.id,
    role: "SCOUT_MODEL",
    model,
  });
  gateway.logger.log("discovery_worker_start", {
    subtaskId: subtask.id,
    worktree: path,
  });
  const acceptEvidence = async (
    message: ChatCompletionMessageParam & { content?: unknown },
    finalization = false,
  ) => {
    if (!tools.progressEvidence.length && !context.files.some((file) => file.snippet.trim()))
      throw Error(
        finalization
          ? "Discovery iteration budget exhausted: no repository inspection evidence"
          : "Discovery completed without repository inspection evidence",
      );
    let evidence: EvidencePacket;
    try {
      evidence = evidenceSchema.parse(
        responseJson(typeof message.content === "string" ? message.content : ""),
      );
    } catch (error) {
      if (finalization)
        throw Error(
          `Discovery iteration budget exhausted: finalization produced no usable result (${String(error)})`,
        );
      throw error;
    }
    if ((await currentDiff(path)) !== before)
      throw Error("Read-only discovery mutated the workspace");
    gateway.logger.log("discovery_complete", {
      subtaskId: subtask.id,
      evidence: tools.progressEvidence.length,
      relevantFiles: evidence.relevantFiles,
      finalization,
    });
    return evidence;
  };
  try {
    for (let iteration = 0; iteration < 2; iteration++) {
      if (Date.now() >= deadline) throw Error("Discovery time budget exhausted");
      const message = await gateway.call(
        model,
        boundMessages(messages, gateway.config.context.maxPromptBytes),
        subtask.id,
        "discover",
        iteration,
        inspectionTools,
        { maxOutputTokens: 1200, timeoutMs: Math.min(15000, deadline - Date.now()) },
      );
      messages.push(message);
      if (message.tool_calls?.length) {
        for (const call of message.tool_calls.slice(0, 4)) {
          if (Date.now() >= deadline) throw Error("Discovery time budget exhausted");
          const toolCall = call as any;
          let content: string;
          try {
            const arguments_ = JSON.parse(toolCall.function.arguments);
            const key = `${toolCall.function.name}:${JSON.stringify(arguments_)}`;
            if (seenActions.has(key)) content = "Repeated inspection already available; summarize the existing evidence.";
            else {
              seenActions.add(key);
              content = await tools.execute(toolCall.function.name, arguments_);
            }
          } catch (error) {
            content = `Tool error: ${String(error)}`;
            gateway.logger.log("tool_error", {
              subtaskId: subtask.id,
              error: content,
            });
          }
          messages.push({ role: "tool", tool_call_id: toolCall.id, content });
        }
        if ((await currentDiff(path)) !== before)
          throw Error("Read-only discovery mutated the workspace");
        if (tools.progressEvidence.length) break;
        continue;
      }
      return acceptEvidence(message);
    }
    messages.push({
      role: "user",
      content:
        "The bounded inspection budget is exhausted. Using only the evidence already gathered, return the required discovery JSON now. Tools are unavailable on this finalization turn.",
    });
    if (Date.now() >= deadline) throw Error("Discovery time budget exhausted");
    const final = await gateway.call(
      model,
      boundMessages(messages, gateway.config.context.maxPromptBytes),
      subtask.id,
      "discover",
      2,
      undefined,
      { maxOutputTokens: 1200, timeoutMs: Math.min(15000, deadline - Date.now()) },
    );
    return acceptEvidence(final, true);
  } finally {
    gateway.logger.log("discovery_worker_stop", {
      subtaskId: subtask.id,
      worktree: path,
    });
  }
}

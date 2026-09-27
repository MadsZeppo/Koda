import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { lstat, readFile } from "node:fs/promises";

import type { Budget } from "../openrouter/usage.js";
import { estimateUsageCost, parseUsage } from "../openrouter/usage.js";
import type { Logger } from "../telemetry/logger.js";
import { codingScore, PARETO_CODE_MODEL } from "../router/codingDemand.js";
import { taskTerms } from "../context/compiler.js";
import { truncateBytes } from "../context/bounds.js";
import { AgentTools, safePath } from "./tools.js";
import { WriteScope } from "../repo/writeScope.js";
import type {
  CodingWorker,
  CodingWorkerInput,
  CodingWorkerResult,
} from "./codingWorker.js";

export const DIRECT_EDIT_VERSION = "3";

export interface DirectEditResponse {
  model: string;
  usage: unknown;
  content?: string | null;

  toolCalls: Array<{
    type: string;

    function: {
      name: string;
      arguments: string;
    };
  }>;
}

export type DirectEditRequester = (
  input: CodingWorkerInput,
  messages: ChatCompletionMessageParam[],
  tool: ChatCompletionTool,
  maxOutputTokens: number,
) => Promise<DirectEditResponse>;

const directEditTool: ChatCompletionTool = {
  type: "function",

  function: {
    name: "submit_direct_edit",

    description:
      "Submit the complete bounded edit for the one authorized target. Existing files use exact oldText/newText replacements. New files use createContent. Delete only when the task explicitly requests deletion.",

    parameters: {
      type: "object",
      additionalProperties: false,

      properties: {
        path: {
          type: "string",
        },

        edits: {
          type: "array",
          minItems: 1,
          maxItems: 8,

          items: {
            type: "object",
            additionalProperties: false,

            properties: {
              oldText: {
                type: "string",
              },

              newText: {
                type: "string",
              },
            },

            required: ["oldText", "newText"],
          },
        },

        createContent: {
          type: "string",
        },

        delete: {
          type: "boolean",
        },
      },

      required: ["path"],
    },
  },
};

// DIRECT exposes exactly one tool, so the portable OpenAI/OpenRouter
// `required` value still forces submit_direct_edit. A named function object is
// more restrictive at the provider layer: some endpoints advertise
// tool_choice support but reject that particular value before generation.
export const directEditToolChoice = "required" as const;

const isExplicitDeleteTask = (task: string) =>
  /\b(?:delete|remove)\b/i.test(task);

const apiRejectedBeforeGeneration = (error: unknown) =>
  error instanceof OpenAI.APIError &&
  [400, 401, 403, 404, 422].includes(error.status ?? 0);

const toolChoiceValueRejected = (error: unknown) =>
  error instanceof OpenAI.APIError &&
  [400, 404, 422].includes(error.status ?? 0) &&
  /(?:tool_choice[\s\S]{0,80}(?:value|unsupported|not support)|no endpoints?[\s\S]{0,160}tool_choice)/i.test(
    String(error),
  );

const operationalFailure = (error: unknown) => {
  if (error instanceof OpenAI.APIError) {
    if ([400, 404].includes(error.status ?? 0)) {
      return /(?:no endpoints?|unsupported|not support|tool_choice|requested parameters?|protocol)/i.test(
        String(error),
      );
    }

    return error.status !== 422;
  }

  return (
    error instanceof OpenAI.APIConnectionError ||
    error instanceof OpenAI.APIConnectionTimeoutError ||
    /\b(?:ETIMEDOUT|ECONNRESET|fetch failed|timeout|timed out|aborted)\b/i.test(
      String(error),
    )
  );
};

export const directEditRequestTimeoutMs = (input: CodingWorkerInput) =>
  Math.max(1, input.timeoutMs);

const validDirectEditCall = (response: DirectEditResponse) => {
  const calls = response.toolCalls;

  const call = calls[0];

  return (
    calls.length === 1 &&
    !!call &&
    call.type === "function" &&
    call.function.name === "submit_direct_edit"
  );
};

/**
 * Use the same byte-to-token model as Koda's attempt policy, with the existing
 * localized-call safety multiplier and fixed provider framing allowance.
 */
export function directEditPromptTokenCeiling(
  messages: ChatCompletionMessageParam[],
) {
  const serializedBytes = Buffer.byteLength(
    JSON.stringify({ messages, tools: [directEditTool] }),
  );
  const estimatedTokens = Math.max(256, Math.ceil(serializedBytes / 4));
  return Math.ceil(estimatedTokens * 1.4) + 128;
}

function localizedRawExcerpt(content: string, task: string, maxBytes: number) {
  if (Buffer.byteLength(content) <= maxBytes) {
    return content;
  }

  const terms = taskTerms(task);

  const lines = content.split("\n");

  const scored = lines
    .map((line, index) => {
      const lower = line.toLowerCase();
      const score = terms.reduce(
        (sum, term) => sum + (lower.includes(term) ? 1 : 0),
        0,
      );
      return { index, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  // A task symbol often appears first in a declaration and later in the code
  // that enforces it. One large first-hit window hides that implementation
  // and encourages invented semantics. Keep several small exact-match windows
  // inside the same byte budget instead.
  const anchors: number[] = [];
  for (const entry of scored) {
    if (anchors.every((anchor) => Math.abs(anchor - entry.index) > 12))
      anchors.push(entry.index);
    if (anchors.length === 3) break;
  }
  if (!anchors.length) anchors.push(0);

  const ranges = anchors
    .sort((a, b) => a - b)
    .map((anchor) => ({
      // Put the matched line near the beginning of its allocation so a small
      // reference budget cannot truncate the very symbol that selected the
      // window. Retain nearby signatures plus broader following fixture code.
      start: Math.max(0, anchor - 6),
      end: Math.min(lines.length, anchor + 101),
      anchor,
    }));
  const headBudget = Math.min(256, Math.floor(maxBytes * 0.15));
  const head = headBudget > 0 ? truncateBytes(content, headBudget) : "";
  const headers = ranges.reduce(
    (sum, range) =>
      sum +
      Buffer.byteLength(
        `\n\n[LOCALIZED WINDOW AROUND LINE ${range.anchor + 1}]\n`,
      ),
    head ? Buffer.byteLength("[FILE START]\n") : 0,
  );
  const windowBudget = Math.max(
    96,
    Math.floor((maxBytes - Buffer.byteLength(head) - headers) / ranges.length),
  );
  const windows = ranges.map(
    (range) =>
      `[LOCALIZED WINDOW AROUND LINE ${range.anchor + 1}]\n${truncateBytes(
        lines.slice(range.start, range.end).join("\n"),
        windowBudget,
      )}`,
  );

  return truncateBytes(
    [head ? "[FILE START]\n" + head : "", ...windows]
      .filter(Boolean)
      .join("\n\n"),
    maxBytes,
  );
}

function boundedReferenceContext(input: CodingWorkerInput, maxBytes: number) {
  const terms = taskTerms(input.task);

  const files = (input.context?.sourceFiles ?? [])
    .filter((file) => !input.writeScope.includes(file.path))
    .map((file, index) => {
      const lower = file.snippet.toLowerCase();

      const score = terms.reduce(
        (sum, term) =>
          sum + (lower.includes(term) ? (/[_.-]/.test(term) ? 6 : 3) : 0),
        0,
      );

      return {
        file,
        index,
        score,
      };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index);

  let output = "";

  for (const { file } of files) {
    const remaining = maxBytes - Buffer.byteLength(output);

    if (remaining <= 96) {
      break;
    }

    const header = `\n\nREFERENCE ${file.path}\n`;

    const bodyBudget = Math.max(0, remaining - Buffer.byteLength(header));

    if (bodyBudget <= 0) {
      break;
    }

    const body = localizedRawExcerpt(file.snippet, input.task, bodyBudget);

    const section = header + truncateBytes(body, bodyBudget);

    if (Buffer.byteLength(section) > remaining) {
      break;
    }

    output += section;
  }

  return output;
}

function usageFromEvent(logger: Logger, start: number, model: string) {
  const event = logger.events
    .slice(start)
    .findLast(
      (entry) =>
        entry.type === "model_call" &&
        entry.stage === "implement" &&
        entry.modelRequested === model,
    );

  return event
    ? {
        model: event.modelReturned ?? model,

        inputTokens:
          typeof event.promptTokens === "number"
            ? event.promptTokens
            : undefined,

        outputTokens:
          typeof event.completionTokens === "number"
            ? event.completionTokens
            : undefined,

        cachedInputTokens:
          typeof event.cachedTokens === "number"
            ? event.cachedTokens
            : undefined,

        cacheWriteTokens:
          typeof event.cacheWriteTokens === "number"
            ? event.cacheWriteTokens
            : undefined,

        costUsd: typeof event.costUsd === "number" ? event.costUsd : undefined,
      }
    : {
        model,
      };
}

function combinedUsage(
  responses: readonly DirectEditResponse[],
  input: CodingWorkerInput,
) {
  const parsed = responses.map((response) => parseUsage(response.usage));

  const promptTokens = parsed.reduce(
    (sum, usage) => sum + usage.promptTokens,
    0,
  );

  const completionTokens = parsed.reduce(
    (sum, usage) => sum + usage.completionTokens,
    0,
  );

  const reasoningTokens = parsed.reduce(
    (sum, usage) => sum + usage.reasoningTokens,
    0,
  );

  const cachedTokens = parsed.reduce(
    (sum, usage) => sum + usage.cachedTokens,
    0,
  );

  const cacheWriteTokens = parsed.reduce(
    (sum, usage) => sum + usage.cacheWriteTokens,
    0,
  );

  const costs = parsed.map((usage) => {
    if (usage.costUsd !== null) {
      return usage.costUsd;
    }

    if (
      input.promptPricePerMillion === undefined ||
      input.completionPricePerMillion === undefined
    ) {
      return null;
    }

    return estimateUsageCost(
      usage,
      input.promptPricePerMillion,
      input.completionPricePerMillion,
    );
  });

  const costUsd = costs.every(
    (cost): cost is number => typeof cost === "number" && Number.isFinite(cost),
  )
    ? costs.reduce((sum, cost) => sum + cost, 0)
    : null;

  return {
    promptTokens,
    completionTokens,
    reasoningTokens,
    cachedTokens,
    cacheWriteTokens,
    costUsd,
    raw: null,
  };
}

export class DirectEditWorker implements CodingWorker {
  constructor(
    readonly budget: Budget,

    readonly logger: Logger,

    private readonly requester?: DirectEditRequester,
  ) {}

  private async request(
    input: CodingWorkerInput,

    messages: ChatCompletionMessageParam[],

    maxOutputTokens: number,
  ): Promise<DirectEditResponse> {
    if (this.requester) {
      return this.requester(input, messages, directEditTool, maxOutputTokens);
    }

    const apiKey = (process.env.OPENROUTER_API_KEY ?? "").trim();

    if (!apiKey) {
      throw Error("INFRA_FAILURE: OPENROUTER_API_KEY is missing");
    }

    const timeoutMs = directEditRequestTimeoutMs(input);

    const sdk = new OpenAI({
      apiKey,

      baseURL: input.baseUrl,

      maxRetries: 0,

      /*
       * The attempt policy owns the
       * DIRECT deadline.
       */
      timeout: timeoutMs,
    });

    const provider: Record<string, unknown> = {
      /*
       * Because tool_choice is now explicitly present,
       * require_parameters forces OpenRouter to choose
       * only endpoints able to satisfy the DIRECT
       * protocol.
       */
      require_parameters: true,

      allow_fallbacks: true,

      sort: {
        by: "price",
        partition: "none",
      },

      preferred_max_latency: {
        p90: 3,
      },
    };

    if (
      input.promptPricePerMillion !== undefined &&
      input.completionPricePerMillion !== undefined
    ) {
      provider.max_price = {
        prompt: input.promptPricePerMillion,

        completion: input.completionPricePerMillion,
      };
    }

    const create = (remainingMs: number) =>
      sdk.chat.completions.create(
        {
          model: input.model,

          messages,

          tools: [directEditTool],

          /*
           * DIRECT is not a conversational agent.
           *
           * It has exactly one valid response action:
           * submit_direct_edit.
           *
           * Leaving tool_choice unset changes OpenRouter
           * semantics to "auto", allowing a model to use
           * the entire generation budget without ever
           * producing Koda's mutation protocol.
           *
           * Require a tool call. Because the request exposes exactly one tool,
           * this still forces the one concrete function without relying on the
           * less portable named-function tool_choice form.
           *
           * If an endpoint cannot support this parameter,
           * require_parameters causes a fast provider
           * rejection. Koda classifies that as an
           * operational failure and moves to another
           * frozen candidate.
           */
          tool_choice: directEditToolChoice,

          max_tokens: maxOutputTokens,

          stream: false,

          ...({
            session_id: input.sessionId,

            provider,

            ...(input.model === PARETO_CODE_MODEL && input.codingRoute
              ? {
                  plugins: [
                    {
                      id: "pareto-router",

                      min_coding_score: codingScore(input.codingRoute.tier),
                    },
                  ],
                }
              : {}),
          } as any),
        },
        {
          timeout: remainingMs,
          signal: AbortSignal.timeout(remainingMs),
        },
      );

    let response;
    try {
      response = await create(timeoutMs);
    } catch (error) {
      if (toolChoiceValueRejected(error))
        this.logger.log("direct_edit_protocol_incompatible", {
          subtaskId: input.attemptId,
          model: input.model,
          protocol: "required_tool_choice",
          reason: "provider rejected required tool_choice before generation",
        });
      // DIRECT has exactly one valid response action. Retrying with `auto`
      // spends another provider deadline while weakening that contract. Let
      // the frozen execution plan choose its next compatible operational
      // candidate immediately; the router also remembers this capability
      // observation for later runs.
      throw error;
    }

    const message = response.choices[0]?.message;

    return {
      model: response.model,

      usage: response.usage,

      content: typeof message?.content === "string" ? message.content : null,

      toolCalls: (message?.tool_calls ?? []).map((call) =>
        call.type === "function"
          ? {
              type: call.type,

              function: {
                name: call.function.name,

                arguments: call.function.arguments,
              },
            }
          : {
              type: call.type,

              function: {
                name: "",
                arguments: "{}",
              },
            },
      ),
    };
  }

  async run(input: CodingWorkerInput): Promise<CodingWorkerResult> {
    const started = Date.now();

    const target =
      input.writeScope.length === 1 ? input.writeScope[0] : undefined;

    if (!target || target === "." || /[*?\[\]]/.test(target)) {
      return {
        exitStatus: "failed",

        model: input.model,

        engine: "direct-edit",

        engineVersion: DIRECT_EDIT_VERSION,

        changedPaths: [],

        wallClockMs: Date.now() - started,

        terminationReason: "direct_edit_unsupported",

        progressPhase: "DISCOVERY",

        fatalError: "Direct edit requires one concrete file target",
      };
    }

    let source: string | undefined;

    try {
      const targetPath = await safePath(input.repoPath, target);

      const info = await lstat(targetPath);

      if (!info.isFile() || info.nlink > 1 || info.size > 1024 * 1024) {
        return {
          exitStatus: "failed",

          model: input.model,

          engine: "direct-edit",

          engineVersion: DIRECT_EDIT_VERSION,

          changedPaths: [],

          wallClockMs: Date.now() - started,

          terminationReason: "direct_edit_unsupported",

          progressPhase: "DISCOVERY",

          fatalError:
            "Direct edit requires a regular non-hardlinked target under 1MB",
        };
      }

      const bytes = await readFile(targetPath);

      source = new TextDecoder("utf-8", {
        fatal: true,
      }).decode(bytes);

      if (source.includes("\0")) {
        throw Error("binary target");
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        return {
          exitStatus: "failed",

          model: input.model,

          engine: "direct-edit",

          engineVersion: DIRECT_EDIT_VERSION,

          changedPaths: [],

          wallClockMs: Date.now() - started,

          terminationReason: "direct_edit_unsupported",

          progressPhase: "DISCOVERY",

          fatalError: String(error),
        };
      }
    }

    const maxOutputTokens = Math.max(
      512,

      Math.min(
        input.maxOutputTokens,

        2048,

        Math.max(
          512,

          Math.floor(input.maxTokens * 0.3),
        ),
      ),
    );

    const promptByteBudget = Math.max(
      2048,

      Math.min(
        32_000,

        input.maxTokens - maxOutputTokens - 768,
      ),
    );

    const framingBudget = Math.min(
      768,

      Math.floor(promptByteBudget * 0.2),
    );

    const usablePromptBytes = Math.max(
      1024,

      promptByteBudget - framingBudget,
    );

    const hasReferences = (input.context?.sourceFiles ?? []).some(
      (file) => !input.writeScope.includes(file.path),
    );

    const referenceBudget = hasReferences
      ? Math.min(
          4096,

          Math.max(
            768,

            Math.floor(usablePromptBytes * 0.3),
          ),
        )
      : 0;

    const targetBudget = Math.max(
      1024,

      usablePromptBytes - referenceBudget,
    );

    const targetContext =
      source === undefined
        ? "[TARGET DOES NOT EXIST YET]"
        : localizedRawExcerpt(source, input.task, targetBudget);

    const references = boundedReferenceContext(input, referenceBudget);

    const repair = [
      input.context?.diagnostics
        ? `\n\nVERIFICATION DIAGNOSTICS\n${truncateBytes(
            input.context.diagnostics,
            3000,
          )}`
        : "",

      input.context?.previousFailedDiff
        ? `\n\nPREVIOUS FAILED DIFF\n${truncateBytes(
            input.context.previousFailedDiff,
            3000,
          )}`
        : "",
    ].join("");

    const messages: ChatCompletionMessageParam[] = [
      {
        role: "system",

        content: [
          "You are Koda's direct edit engine, not a repository-browsing agent.",

          "The target is already localized. Do not ask for more context and do not describe a plan.",

          "Your response must call submit_direct_edit exactly once.",

          "Do not answer with prose.",

          "For an existing target, return the smallest exact unique oldText/newText replacements needed.",

          "For test edits, mirror the existing helper signatures and neighboring assertion patterns exactly; do not invent APIs, fields, or positional semantics.",

          "Use REFERENCE excerpts to ground every named policy field or symbol from the task before constructing fixtures.",

          "For a missing target, return createContent only.",

          "Use delete=true only when the task explicitly asks to delete the target.",

          "Do not modify any path except the authorized target.",

          "Koda applies the edit and performs verification independently.",
        ].join(" "),
      },

      {
        role: "user",

        content:
          `TASK\n${input.task}` +
          `\n\nAUTHORIZED TARGET\n${target}` +
          `\n\nCURRENT TARGET CONTENT\n${targetContext}` +
          references +
          repair,
      },
    ];

    const reservation = this.budget.reserve(input.budgetUsd, input.maxTokens);

    let settled = false;

    const eventStart = this.logger.events.length;

    this.logger.log("provider_policy", {
      subtaskId: input.attemptId,

      stage: "implement",

      model: input.model,

      session_id: input.sessionId ?? null,

      provider: {
        require_parameters: true,

        allow_fallbacks: true,

        sort: {
          by: "price",
          partition: "none",
        },

        preferred_max_latency: {
          p90: 3,
        },

        ...(input.promptPricePerMillion !== undefined &&
        input.completionPricePerMillion !== undefined
          ? {
              max_price: {
                prompt: input.promptPricePerMillion,

                completion: input.completionPricePerMillion,
              },
            }
          : {}),
      },

      reasoning_effort: null,

      worker_engine: "direct-edit",

      required_tool: "submit_direct_edit",
    });

    try {
      const responses: DirectEditResponse[] = [];
      let response: DirectEditResponse | undefined;
      let structuralRepairReason: string | undefined;
      let outcome: {
        applied: boolean;
        error?: string;
        reason?: string;
        progressPhase: "DISCOVERY" | "MUTATION_ATTEMPTED" | "MUTATION_OBSERVED";
      } = {
        applied: false,
        error: "Direct edit response was not evaluated",
        reason: "unknown",
        progressPhase: "DISCOVERY",
      };

      const scope = new WriteScope([target], this.logger, input.attemptId);
      const tools = new AgentTools(
        input.repoPath,
        false,
        input.commandTimeoutMs,
        this.logger,
        input.attemptId,
        input.maxToolOutputBytes ?? 4000,
        scope,
        input.context?.relevantFiles ?? [],
      );

      const currentTargetContent = async () => {
        try {
          const targetPath = await safePath(input.repoPath, target);
          const info = await lstat(targetPath);
          if (!info.isFile() || info.nlink > 1 || info.size > 1024 * 1024)
            throw Error(
              "authorized target is no longer a regular non-hardlinked file under 1MB",
            );
          const bytes = await readFile(targetPath);
          const content = new TextDecoder("utf-8", { fatal: true }).decode(
            bytes,
          );
          if (content.includes("\0"))
            throw Error("authorized target became binary");
          source = content;
          return localizedRawExcerpt(content, input.task, targetBudget);
        } catch (error: any) {
          if (error?.code === "ENOENT") {
            source = undefined;
            return "[TARGET DOES NOT EXIST YET]";
          }
          throw error;
        }
      };

      const evaluate = async (
        candidate: DirectEditResponse,
      ): Promise<typeof outcome> => {
        if (!validDirectEditCall(candidate)) {
          return {
            applied: false,
            error:
              candidate.toolCalls.length === 0
                ? "submit_direct_edit was missing"
                : candidate.toolCalls.length > 1
                  ? `Expected exactly one submit_direct_edit call; received ${candidate.toolCalls.length}`
                  : `Expected submit_direct_edit; received ${candidate.toolCalls[0]?.function.name || "unknown tool"}`,
            reason:
              candidate.toolCalls.length > 1
                ? "multiple_submit_direct_edit_calls"
                : "missing_submit_direct_edit",
            progressPhase: "DISCOVERY",
          };
        }

        const call = candidate.toolCalls[0]!;
        let args: any;
        try {
          args = JSON.parse(call.function.arguments);
        } catch (error) {
          return {
            applied: false,
            error: `submit_direct_edit arguments were not valid JSON: ${String(error)}`,
            reason: "malformed_argument_json",
            progressPhase: "DISCOVERY",
          };
        }

        const allowedKeys = new Set([
          "path",
          "edits",
          "createContent",
          "delete",
        ]);
        if (
          !args ||
          typeof args !== "object" ||
          Array.isArray(args) ||
          Object.keys(args).some((key) => !allowedKeys.has(key))
        ) {
          return {
            applied: false,
            error:
              "submit_direct_edit arguments did not match the required object schema",
            reason: "invalid_argument_schema",
            progressPhase: "DISCOVERY",
          };
        }
        if (args.path !== target) {
          return {
            applied: false,
            error: `Unauthorized path ${String(args.path)}; the only authorized path is ${target}`,
            reason: "unauthorized_path",
            progressPhase: "DISCOVERY",
          };
        }
        if (
          (args.delete !== undefined && typeof args.delete !== "boolean") ||
          (args.createContent !== undefined &&
            typeof args.createContent !== "string") ||
          (args.edits !== undefined && !Array.isArray(args.edits))
        ) {
          return {
            applied: false,
            error: "submit_direct_edit optional fields have invalid types",
            reason: "invalid_argument_schema",
            progressPhase: "DISCOVERY",
          };
        }

        const suppliedCreate = typeof args.createContent === "string";
        const wantsDelete = args.delete === true;
        const edits = Array.isArray(args.edits) ? args.edits : [];
        const validEdits =
          edits.length >= 1 &&
          edits.length <= 8 &&
          edits.every(
            (edit: any) =>
              edit &&
              typeof edit === "object" &&
              !Array.isArray(edit) &&
              Object.keys(edit).every(
                (key) => key === "oldText" || key === "newText",
              ) &&
              typeof edit.oldText === "string" &&
              typeof edit.newText === "string",
          );
        if (edits.length && !validEdits) {
          return {
            applied: false,
            error:
              "Each edit requires only string oldText and newText fields (1-8 edits)",
            reason: "invalid_argument_schema",
            progressPhase: "DISCOVERY",
          };
        }

        const wantsEdits = edits.length > 0;
        const wantsCreate = source === undefined && suppliedCreate;
        const conflictingCreate =
          source !== undefined &&
          suppliedCreate &&
          args.createContent.length > 0;
        if (
          conflictingCreate ||
          [wantsCreate, wantsDelete, wantsEdits].filter(Boolean).length !== 1
        ) {
          return {
            applied: false,
            error:
              "Direct edit must choose exactly one of edits, createContent, or delete",
            reason: "conflicting_edit_action",
            progressPhase: "DISCOVERY",
          };
        }
        if (
          (source === undefined && !wantsCreate) ||
          (source !== undefined && wantsCreate)
        ) {
          return {
            applied: false,
            error:
              source === undefined
                ? "Missing target requires createContent"
                : "Existing target must use edits or explicit deletion",
            reason: "invalid_edit_action",
            progressPhase: "DISCOVERY",
          };
        }
        if (wantsDelete && !isExplicitDeleteTask(input.task)) {
          return {
            applied: false,
            error:
              "Model requested deletion but the task did not explicitly request it",
            reason: "unauthorized_delete",
            progressPhase: "DISCOVERY",
          };
        }

        try {
          await tools.execute("apply_patch", {
            edits: wantsCreate
              ? [{ path: target, createContent: args.createContent }]
              : wantsDelete
                ? [{ path: target, delete: true }]
                : edits.map((edit: any) => ({
                    path: target,
                    oldText: edit.oldText,
                    newText: edit.newText,
                  })),
          });
          return { applied: true, progressPhase: "MUTATION_OBSERVED" };
        } catch (error) {
          return {
            applied: false,
            error: String(error),
            reason: "mechanical_patch_rejected",
            progressPhase: "MUTATION_ATTEMPTED",
          };
        }
      };

      let requestMessages = messages;
      let requestInput = input;
      let requestOutputTokens = maxOutputTokens;
      for (let round = 0; round < 2; round++) {
        response = await this.request(
          requestInput,
          requestMessages,
          requestOutputTokens,
        );
        responses.push(response);
        outcome = await evaluate(response);
        if (outcome.applied) break;
        if (round === 1) break;

        const firstUsage = combinedUsage(responses, input);
        const usedTokens =
          firstUsage.promptTokens + firstUsage.completionTokens;
        const tokenRoom = Math.max(0, input.maxTokens - usedTokens);
        const costRoom =
          firstUsage.costUsd === null
            ? 0
            : Math.max(0, input.budgetUsd - firstUsage.costUsd);
        const remainingMs = input.timeoutMs - (Date.now() - started);
        if (tokenRoom < 384 || costRoom <= 0 || remainingMs < 1000) break;

        structuralRepairReason = outcome.reason ?? "structural_protocol_error";
        // apply_patch is transactional. Refreshing here both proves that the
        // authorized target remains safe and gives repair the current exact
        // source instead of the stale prompt state.
        const refreshedTarget = await currentTargetContent();
        const previousAttempt =
          response.toolCalls.length > 0
            ? response.toolCalls
                .map(
                  (item) => `${item.function.name}: ${item.function.arguments}`,
                )
                .join("\n")
            : (response.content ?? "[NO TOOL CALL OR CONTENT]");
        requestMessages = [
          {
            role: "system",
            content: [
              "PROTOCOL REPAIR: correct the existing edit envelope only.",
              "Do not redo analysis and do not explain anything.",
              "Call submit_direct_edit exactly once.",
              "Keep exact replacement safety: oldText must identify one unique current span.",
            ].join(" "),
          },
          {
            role: "user",
            content: [
              `TASK\n${input.task}`,
              `AUTHORIZED TARGET\n${target}`,
              `EXACT REJECTION\n${truncateBytes(outcome.error ?? "unknown structural error", 1200)}`,
              `PREVIOUS ATTEMPT\n${truncateBytes(previousAttempt, 1600)}`,
              `REFRESHED CURRENT TARGET CONTENT\n${refreshedTarget}`,
            ].join("\n\n"),
          },
        ];

        // A structural retry shares the original attempt reservation. Bound
        // its prompt and completion against the remaining attempt tokens and
        // known per-token prices before dispatch.
        if (
          input.promptPricePerMillion === undefined ||
          input.completionPricePerMillion === undefined
        ) {
          break;
        }
        const repairPromptTokenCeiling =
          directEditPromptTokenCeiling(requestMessages);
        const tokenLimitedOutput = tokenRoom - repairPromptTokenCeiling;
        const promptCostCeiling =
          (repairPromptTokenCeiling * input.promptPricePerMillion) / 1e6;
        const completionBudgetUsd = costRoom - promptCostCeiling;
        const costLimitedOutput =
          input.completionPricePerMillion === 0
            ? tokenLimitedOutput
            : Math.floor(
                (completionBudgetUsd * 1e6) / input.completionPricePerMillion,
              );
        const repairOutputLimit = Math.min(
          maxOutputTokens,
          tokenLimitedOutput,
          costLimitedOutput,
        );
        if (repairOutputLimit < 128) break;

        this.logger.log("direct_edit_protocol_repair", {
          subtaskId: input.attemptId,
          model: input.model,
          structural_repair: true,
          same_model: true,
          repair_reason: structuralRepairReason,
          error: truncateBytes(
            outcome.error ?? "unknown structural error",
            1200,
          ),
          previous_tool_calls: response.toolCalls.map(
            (item) => item.function.name,
          ),
          remaining_tokens: tokenRoom,
          repair_prompt_token_ceiling: repairPromptTokenCeiling,
          repair_output_token_limit: repairOutputLimit,
          remaining_budget_usd: costRoom,
          remaining_ms: remainingMs,
        });
        requestInput = { ...input, timeoutMs: remainingMs };
        requestOutputTokens = repairOutputLimit;
      }

      const usage = combinedUsage(responses, input);
      if (usage.costUsd === null) reservation.settleUncertain();
      else reservation.settle(usage);
      settled = true;

      const wallClockMs = Date.now() - started;
      this.logger.log("model_call", {
        subtaskId: input.attemptId,
        stage: "implement",
        role: "DIRECT_EDIT",
        modelRequested: input.model,
        modelReturned: response?.model ?? input.model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        reasoningTokens: usage.reasoningTokens,
        cachedTokens: usage.cachedTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        costUsd: usage.costUsd ?? input.budgetUsd,
        wallClockMs,
        attempt: 0,
        outcome: "response",
        workerEngine: "direct-edit",
        providerCalls: responses.length,
        structuralRepair: responses.length > 1,
        repairReason: structuralRepairReason ?? null,
      });

      const common = {
        model: response?.model ?? input.model,
        engine: "direct-edit" as const,
        engineVersion: DIRECT_EDIT_VERSION,
        changedPaths: [] as string[],
        wallClockMs,
        inputTokens: usage.promptTokens,
        outputTokens: usage.completionTokens,
        cachedInputTokens: usage.cachedTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        costUsd: usage.costUsd ?? input.budgetUsd,
        configuredTokenLimit: input.maxTokens,
        consumedTokens: usage.promptTokens + usage.completionTokens,
        remainingTokens: Math.max(
          0,
          input.maxTokens - usage.promptTokens - usage.completionTokens,
        ),
        steps: responses.length,
      };

      if (!outcome.applied) {
        return {
          ...common,
          exitStatus: "failed",
          terminationReason: "direct_edit_protocol_error",
          progressPhase: outcome.progressPhase,
          fatalError: `${outcome.error ?? "Direct edit structural failure"}${
            responses.length > 1
              ? " (after bounded protocol repair; structural repair exhausted)"
              : " (structural repair unavailable within remaining attempt limits)"
          }`,
        };
      }

      return {
        ...common,
        exitStatus: "completed",
        changedPaths: [target],
        terminationReason: "Submitted",
        progressPhase: "MUTATION_OBSERVED",
        timeToFirstMutationMs: Date.now() - started,
      };
    } catch (error) {
      if (!settled) {
        if (apiRejectedBeforeGeneration(error)) {
          /*
           * Nothing was generated and OpenRouter reports a request/endpoint
           * incompatibility. Release the reservation fully.
           */
          reservation.cancel();
        } else {
          reservation.settleUncertain();
        }
      }

      const call = usageFromEvent(this.logger, eventStart, input.model);

      const operational = operationalFailure(error);

      return {
        exitStatus: operational ? "infra_failure" : "failed",

        model: call.model,

        engine: "direct-edit",

        engineVersion: DIRECT_EDIT_VERSION,

        changedPaths: [],

        wallClockMs: Date.now() - started,

        terminationReason: operational
          ? "infrastructure_failure"
          : "direct_edit_protocol_error",

        progressPhase: "DISCOVERY",

        inputTokens: call.inputTokens,

        outputTokens: call.outputTokens,

        cachedInputTokens: call.cachedInputTokens,

        cacheWriteTokens: call.cacheWriteTokens,

        costUsd: call.costUsd,

        fatalError: String(error),
      };
    }
  }
}

import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { lstat, readFile } from "node:fs/promises";

import type { Budget } from "../openrouter/usage.js";
import { estimateUsageCost, parseUsage } from "../openrouter/usage.js";
import type { Logger } from "../telemetry/logger.js";
import {
  codingScore,
  PARETO_CODE_MODEL,
} from "../router/codingDemand.js";
import { taskTerms } from "../context/compiler.js";
import { truncateBytes } from "../context/bounds.js";
import { AgentTools, safePath } from "./tools.js";
import { WriteScope } from "../repo/writeScope.js";
import type {
  CodingWorker,
  CodingWorkerInput,
  CodingWorkerResult,
} from "./codingWorker.js";

export const DIRECT_EDIT_VERSION = "2";

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

const isExplicitDeleteTask = (task: string) =>
  /\b(?:delete|remove)\b/i.test(task);

const apiRejectedBeforeGeneration = (error: unknown) =>
  error instanceof OpenAI.APIError &&
  [400, 401, 403, 404, 422].includes(error.status ?? 0);

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

function localizedRawExcerpt(
  content: string,
  task: string,
  maxBytes: number,
) {
  if (Buffer.byteLength(content) <= maxBytes) {
    return content;
  }

  const terms = taskTerms(task);
  const lines = content.split("\n");

  let bestLine = 0;
  let bestScore = -1;

  for (const [index, line] of lines.entries()) {
    const lower = line.toLowerCase();

    const score = terms.reduce(
      (sum, term) => sum + (lower.includes(term) ? 1 : 0),
      0,
    );

    if (score > bestScore) {
      bestScore = score;
      bestLine = index;
    }
  }

  const radius = 80;
  const start = Math.max(0, bestLine - radius);
  const end = Math.min(lines.length, bestLine + radius + 1);

  const middle = truncateBytes(
    lines.slice(start, end).join("\n"),
    Math.max(1024, (maxBytes * 2) / 3),
  );

  const remaining = Math.max(
    0,
    maxBytes - Buffer.byteLength(middle),
  );

  const edge = Math.floor(remaining / 2);

  const head =
    edge > 0
      ? truncateBytes(content, edge)
      : "";

  const tail =
    edge > 0
      ? Buffer.from(content)
          .subarray(
            Math.max(
              0,
              Buffer.byteLength(content) - edge,
            ),
          )
          .toString("utf8")
      : "";

  return [
    head
      ? "[FILE START]\n" + head
      : "",
    `[LOCALIZED WINDOW AROUND LINE ${bestLine + 1}]\n${middle}`,
    tail
      ? "[FILE END]\n" + tail
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function boundedReferenceContext(
  input: CodingWorkerInput,
  maxBytes: number,
) {
  const terms = taskTerms(input.task);

  const files = (input.context?.sourceFiles ?? [])
    .filter(
      (file) =>
        !input.writeScope.includes(file.path),
    )
    .map((file, index) => {
      const lower = file.snippet.toLowerCase();

      const score = terms.reduce(
        (sum, term) =>
          sum +
          (lower.includes(term)
            ? /[_.-]/.test(term)
              ? 6
              : 3
            : 0),
        0,
      );

      return {
        file,
        index,
        score,
      };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.index - b.index,
    );

  let output = "";

  for (const { file } of files) {
    const remaining =
      maxBytes - Buffer.byteLength(output);

    if (remaining <= 96) {
      break;
    }

    const header =
      `\n\nREFERENCE ${file.path}\n`;

    const bodyBudget = Math.max(
      0,
      remaining - Buffer.byteLength(header),
    );

    if (bodyBudget <= 0) {
      break;
    }

    const body = localizedRawExcerpt(
      file.snippet,
      input.task,
      bodyBudget,
    );

    const section =
      header +
      truncateBytes(body, bodyBudget);

    if (
      Buffer.byteLength(section) >
      remaining
    ) {
      break;
    }

    output += section;
  }

  return output;
}

function usageFromEvent(
  logger: Logger,
  start: number,
  model: string,
) {
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
        model:
          event.modelReturned ?? model,
        inputTokens:
          typeof event.promptTokens === "number"
            ? event.promptTokens
            : undefined,
        outputTokens:
          typeof event.completionTokens ===
          "number"
            ? event.completionTokens
            : undefined,
        cachedInputTokens:
          typeof event.cachedTokens === "number"
            ? event.cachedTokens
            : undefined,
        cacheWriteTokens:
          typeof event.cacheWriteTokens ===
          "number"
            ? event.cacheWriteTokens
            : undefined,
        costUsd:
          typeof event.costUsd === "number"
            ? event.costUsd
            : undefined,
      }
    : {
        model,
      };
}

function combinedUsage(
  responses: readonly DirectEditResponse[],
  input: CodingWorkerInput,
) {
  const parsed = responses.map((response) =>
    parseUsage(response.usage),
  );

  const promptTokens = parsed.reduce(
    (sum, usage) =>
      sum + usage.promptTokens,
    0,
  );

  const completionTokens = parsed.reduce(
    (sum, usage) =>
      sum + usage.completionTokens,
    0,
  );

  const reasoningTokens = parsed.reduce(
    (sum, usage) =>
      sum + usage.reasoningTokens,
    0,
  );

  const cachedTokens = parsed.reduce(
    (sum, usage) =>
      sum + usage.cachedTokens,
    0,
  );

  const cacheWriteTokens = parsed.reduce(
    (sum, usage) =>
      sum + usage.cacheWriteTokens,
    0,
  );

  const costs = parsed.map(
    (usage, index) => {
      if (usage.costUsd !== null) {
        return usage.costUsd;
      }

      if (
        input.promptPricePerMillion ===
          undefined ||
        input.completionPricePerMillion ===
          undefined
      ) {
        return null;
      }

      return estimateUsageCost(
        usage,
        input.promptPricePerMillion,
        input.completionPricePerMillion,
      );
    },
  );

  const costUsd = costs.every(
    (cost): cost is number =>
      typeof cost === "number" &&
      Number.isFinite(cost),
  )
    ? costs.reduce(
        (sum, cost) => sum + cost,
        0,
      )
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

export class DirectEditWorker
  implements CodingWorker
{
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
      return this.requester(
        input,
        messages,
        directEditTool,
        maxOutputTokens,
      );
    }

    const apiKey = (
      process.env.OPENROUTER_API_KEY ?? ""
    ).trim();

    if (!apiKey) {
      throw Error(
        "INFRA_FAILURE: OPENROUTER_API_KEY is missing",
      );
    }

    const timeoutMs =
      directEditRequestTimeoutMs(input);

    const sdk = new OpenAI({
      apiKey,
      baseURL: input.baseUrl,
      maxRetries: 0,

      // The coding-attempt policy is the authoritative
      // deadline for DIRECT.
      //
      // Previously the SDK was configured with the
      // generic 30 second implementation timeout,
      // which silently shortened a 45 second coding
      // attempt to 30 seconds.
      timeout: timeoutMs,
    });

    const provider: Record<
      string,
      unknown
    > = {
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
      input.promptPricePerMillion !==
        undefined &&
      input.completionPricePerMillion !==
        undefined
    ) {
      provider.max_price = {
        prompt:
          input.promptPricePerMillion,
        completion:
          input.completionPricePerMillion,
      };
    }

    const response =
      await sdk.chat.completions.create(
        {
          model: input.model,
          messages,
          tools: [directEditTool],

          /*
           * IMPORTANT:
           *
           * Do NOT send:
           *
           *   tool_choice: "required"
           *
           * Some OpenRouter endpoints support tools
           * but do not expose the requested
           * tool_choice capability.
           *
           * provider.require_parameters=true still
           * ensures the endpoint supports the
           * parameters we actually send.
           *
           * Koda enforces the structured-edit
           * protocol itself below and gets one
           * bounded same-model repair if the model
           * returns text instead of the tool.
           */

          max_tokens: maxOutputTokens,
          stream: false,

          ...({
            session_id: input.sessionId,
            provider,

            ...(input.model ===
              PARETO_CODE_MODEL &&
            input.codingRoute
              ? {
                  plugins: [
                    {
                      id: "pareto-router",
                      min_coding_score:
                        codingScore(
                          input.codingRoute
                            .tier,
                        ),
                    },
                  ],
                }
              : {}),
          } as any),
        },
        {
          timeout: timeoutMs,
          signal:
            AbortSignal.timeout(
              timeoutMs,
            ),
        },
      );

    const message =
      response.choices[0]?.message;

    return {
      model: response.model,
      usage: response.usage,
      content:
        typeof message?.content === "string"
          ? message.content
          : null,
      toolCalls: (
        message?.tool_calls ?? []
      ).map((call) =>
        call.type === "function"
          ? {
              type: call.type,
              function: {
                name: call.function.name,
                arguments:
                  call.function.arguments,
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

  async run(
    input: CodingWorkerInput,
  ): Promise<CodingWorkerResult> {
    const started = Date.now();

    const target =
      input.writeScope.length === 1
        ? input.writeScope[0]
        : undefined;

    if (
      !target ||
      target === "." ||
      /[*?\[\]]/.test(target)
    ) {
      return {
        exitStatus: "failed",
        model: input.model,
        engine: "direct-edit",
        engineVersion:
          DIRECT_EDIT_VERSION,
        changedPaths: [],
        wallClockMs:
          Date.now() - started,
        terminationReason:
          "direct_edit_unsupported",
        progressPhase: "DISCOVERY",
        fatalError:
          "Direct edit requires one concrete file target",
      };
    }

    let source:
      | string
      | undefined;

    try {
      const targetPath = await safePath(
        input.repoPath,
        target,
      );

      const info =
        await lstat(targetPath);

      if (
        !info.isFile() ||
        info.nlink > 1 ||
        info.size > 1024 * 1024
      ) {
        return {
          exitStatus: "failed",
          model: input.model,
          engine: "direct-edit",
          engineVersion:
            DIRECT_EDIT_VERSION,
          changedPaths: [],
          wallClockMs:
            Date.now() - started,
          terminationReason:
            "direct_edit_unsupported",
          progressPhase:
            "DISCOVERY",
          fatalError:
            "Direct edit requires a regular non-hardlinked target under 1MB",
        };
      }

      const bytes =
        await readFile(targetPath);

      source = new TextDecoder(
        "utf-8",
        {
          fatal: true,
        },
      ).decode(bytes);

      if (source.includes("\0")) {
        throw Error("binary target");
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        return {
          exitStatus: "failed",
          model: input.model,
          engine: "direct-edit",
          engineVersion:
            DIRECT_EDIT_VERSION,
          changedPaths: [],
          wallClockMs:
            Date.now() - started,
          terminationReason:
            "direct_edit_unsupported",
          progressPhase:
            "DISCOVERY",
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
          Math.floor(
            input.maxTokens * 0.3,
          ),
        ),
      ),
    );

    const promptByteBudget =
      Math.max(
        2048,
        Math.min(
          32_000,
          input.maxTokens -
            maxOutputTokens -
            768,
        ),
      );

    const framingBudget =
      Math.min(
        768,
        Math.floor(
          promptByteBudget * 0.2,
        ),
      );

    const usablePromptBytes =
      Math.max(
        1024,
        promptByteBudget -
          framingBudget,
      );

    const hasReferences = (
      input.context?.sourceFiles ?? []
    ).some(
      (file) =>
        !input.writeScope.includes(
          file.path,
        ),
    );

    const referenceBudget =
      hasReferences
        ? Math.min(
            4096,
            Math.max(
              768,
              Math.floor(
                usablePromptBytes *
                  0.3,
              ),
            ),
          )
        : 0;

    const targetBudget =
      Math.max(
        1024,
        usablePromptBytes -
          referenceBudget,
      );

    const targetContext =
      source === undefined
        ? "[TARGET DOES NOT EXIST YET]"
        : localizedRawExcerpt(
            source,
            input.task,
            targetBudget,
          );

    const references =
      boundedReferenceContext(
        input,
        referenceBudget,
      );

    const repair = [
      input.context?.diagnostics
        ? `\n\nVERIFICATION DIAGNOSTICS\n${truncateBytes(
            input.context.diagnostics,
            3000,
          )}`
        : "",

      input.context
        ?.previousFailedDiff
        ? `\n\nPREVIOUS FAILED DIFF\n${truncateBytes(
            input.context
              .previousFailedDiff,
            3000,
          )}`
        : "",
    ].join("");

    const messages: ChatCompletionMessageParam[] =
      [
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

    const reservation =
      this.budget.reserve(
        input.budgetUsd,
        input.maxTokens,
      );

    let settled = false;

    const eventStart =
      this.logger.events.length;

    this.logger.log(
      "provider_policy",
      {
        subtaskId:
          input.attemptId,
        stage: "implement",
        model: input.model,
        session_id:
          input.sessionId ?? null,

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

          ...(input.promptPricePerMillion !==
            undefined &&
          input.completionPricePerMillion !==
            undefined
            ? {
                max_price: {
                  prompt:
                    input.promptPricePerMillion,
                  completion:
                    input.completionPricePerMillion,
                },
              }
            : {}),
        },

        reasoning_effort: null,
        worker_engine:
          "direct-edit",
      },
    );

    try {
      const responses:
        DirectEditResponse[] = [];

      let response =
        await this.request(
          input,
          messages,
          maxOutputTokens,
        );

      responses.push(response);

      /*
       * One bounded protocol repair.
       *
       * This is intentionally NOT a quality
       * escalation.
       *
       * Gemini returning prose instead of the
       * requested tool call says nothing about
       * whether it can solve the coding task.
       *
       * The old implementation immediately
       * discarded the whole attempt and moved
       * to a more expensive model.
       */
      if (
        !validDirectEditCall(response)
      ) {
        const firstUsage =
          combinedUsage(
            responses,
            input,
          );

        const usedTokens =
          firstUsage.promptTokens +
          firstUsage.completionTokens;

        const tokenRoom =
          Math.max(
            0,
            input.maxTokens -
              usedTokens,
          );

        const costRoom =
          firstUsage.costUsd === null
            ? input.budgetUsd
            : Math.max(
                0,
                input.budgetUsd -
                  firstUsage.costUsd,
              );

        const remainingMs =
          input.timeoutMs -
          (Date.now() - started);

        const repairViable =
          tokenRoom >= 384 &&
          costRoom > 0 &&
          remainingMs >= 1000;

        if (repairViable) {
          this.logger.log(
            "direct_edit_protocol_repair",
            {
              subtaskId:
                input.attemptId,
              model:
                input.model,
              reason:
                "required_submit_direct_edit_missing",
              previous_tool_calls:
                response.toolCalls.map(
                  (call) =>
                    call.function
                      .name,
                ),
              previous_content:
                truncateBytes(
                  response.content ??
                    "",
                  600,
                ),
            },
          );

          const repairMessages: ChatCompletionMessageParam[] =
            [
              ...messages,
              {
                role: "user",
                content: [
                  "PROTOCOL REPAIR.",
                  "Your previous response did not satisfy the output protocol.",
                  "Do not explain anything.",
                  "Do not repeat analysis.",
                  "Call submit_direct_edit exactly once now.",
                  `The only authorized path is ${target}.`,
                  "Return the smallest valid bounded edit.",
                ].join(" "),
              },
            ];

          const repairInput: CodingWorkerInput =
            {
              ...input,

              // The repair shares the original
              // attempt deadline.
              timeoutMs:
                remainingMs,
            };

          response =
            await this.request(
              repairInput,
              repairMessages,
              Math.max(
                384,
                Math.min(
                  1200,
                  maxOutputTokens,
                  tokenRoom,
                ),
              ),
            );

          responses.push(response);
        }
      }

      const usage =
        combinedUsage(
          responses,
          input,
        );

      if (usage.costUsd === null) {
        reservation.settleUncertain();
      } else {
        reservation.settle(usage);
      }

      settled = true;

      const wallClockMs =
        Date.now() - started;

      this.logger.log(
        "model_call",
        {
          subtaskId:
            input.attemptId,
          stage: "implement",
          role: "DIRECT_EDIT",
          modelRequested:
            input.model,
          modelReturned:
            response.model,
          promptTokens:
            usage.promptTokens,
          completionTokens:
            usage.completionTokens,
          reasoningTokens:
            usage.reasoningTokens,
          cachedTokens:
            usage.cachedTokens,
          cacheWriteTokens:
            usage.cacheWriteTokens,
          costUsd:
            usage.costUsd ??
            input.budgetUsd,
          wallClockMs,
          attempt:
            responses.length - 1,
          outcome: "response",
          workerEngine:
            "direct-edit",
          protocolRepair:
            responses.length > 1,
        },
      );

      const calls =
        response.toolCalls;

      const call =
        calls[0];

      if (
        calls.length !== 1 ||
        !call ||
        call.type !==
          "function" ||
        call.function.name !==
          "submit_direct_edit"
      ) {
        return {
          exitStatus: "failed",
          model:
            response.model,
          engine:
            "direct-edit",
          engineVersion:
            DIRECT_EDIT_VERSION,
          changedPaths: [],
          wallClockMs,
          terminationReason:
            "direct_edit_protocol_error",
          progressPhase:
            "DISCOVERY",
          inputTokens:
            usage.promptTokens,
          outputTokens:
            usage.completionTokens,
          cachedInputTokens:
            usage.cachedTokens,
          cacheWriteTokens:
            usage.cacheWriteTokens,
          costUsd:
            usage.costUsd ??
            input.budgetUsd,
          configuredTokenLimit:
            input.maxTokens,
          consumedTokens:
            usage.promptTokens +
            usage.completionTokens,
          remainingTokens:
            Math.max(
              0,
              input.maxTokens -
                usage.promptTokens -
                usage.completionTokens,
            ),
          steps:
            responses.length,
          fatalError:
            responses.length > 1
              ? "Direct edit model still did not return exactly one submit_direct_edit call after bounded protocol repair"
              : "Direct edit model did not return exactly one submit_direct_edit call",
        };
      }

      let args: any;

      try {
        args = JSON.parse(
          call.function.arguments,
        );
      } catch {
        return {
          exitStatus: "failed",
          model:
            response.model,
          engine:
            "direct-edit",
          engineVersion:
            DIRECT_EDIT_VERSION,
          changedPaths: [],
          wallClockMs,
          terminationReason:
            "direct_edit_protocol_error",
          progressPhase:
            "DISCOVERY",
          inputTokens:
            usage.promptTokens,
          outputTokens:
            usage.completionTokens,
          cachedInputTokens:
            usage.cachedTokens,
          cacheWriteTokens:
            usage.cacheWriteTokens,
          costUsd:
            usage.costUsd ??
            input.budgetUsd,
          steps:
            responses.length,
          fatalError:
            "Direct edit tool arguments were not valid JSON",
        };
      }

      if (
        !args ||
        typeof args !== "object" ||
        Array.isArray(args) ||
        args.path !== target
      ) {
        return {
          exitStatus: "failed",
          model:
            response.model,
          engine:
            "direct-edit",
          engineVersion:
            DIRECT_EDIT_VERSION,
          changedPaths: [],
          wallClockMs,
          terminationReason:
            "direct_edit_protocol_error",
          progressPhase:
            "DISCOVERY",
          inputTokens:
            usage.promptTokens,
          outputTokens:
            usage.completionTokens,
          cachedInputTokens:
            usage.cachedTokens,
          cacheWriteTokens:
            usage.cacheWriteTokens,
          costUsd:
            usage.costUsd ??
            input.budgetUsd,
          steps:
            responses.length,
          fatalError:
            `Direct edit attempted unauthorized target ${String(
              args?.path,
            )}`,
        };
      }

      const suppliedCreate =
        typeof args.createContent ===
        "string";

      const wantsDelete =
        args.delete === true;

      const edits =
        Array.isArray(args.edits)
          ? args.edits
          : [];

      const wantsEdits =
        edits.length > 0;

      /*
       * Providers may materialize optional
       * fields with neutral defaults.
       *
       * createContent: "" on an existing
       * file is absence, not a conflicting
       * create action.
       */
      const wantsCreate =
        source === undefined &&
        suppliedCreate;

      const conflictingCreate =
        source !== undefined &&
        suppliedCreate &&
        args.createContent.length > 0;

      if (
        conflictingCreate ||
        [
          wantsCreate,
          wantsDelete,
          wantsEdits,
        ].filter(Boolean).length !== 1
      ) {
        return {
          exitStatus: "failed",
          model:
            response.model,
          engine:
            "direct-edit",
          engineVersion:
            DIRECT_EDIT_VERSION,
          changedPaths: [],
          wallClockMs,
          terminationReason:
            "direct_edit_protocol_error",
          progressPhase:
            "DISCOVERY",
          inputTokens:
            usage.promptTokens,
          outputTokens:
            usage.completionTokens,
          cachedInputTokens:
            usage.cachedTokens,
          cacheWriteTokens:
            usage.cacheWriteTokens,
          costUsd:
            usage.costUsd ??
            input.budgetUsd,
          steps:
            responses.length,
          fatalError:
            "Direct edit must choose exactly one of edits, createContent, or delete",
        };
      }

      if (
        (source === undefined &&
          !wantsCreate) ||
        (source !== undefined &&
          wantsCreate)
      ) {
        return {
          exitStatus: "failed",
          model:
            response.model,
          engine:
            "direct-edit",
          engineVersion:
            DIRECT_EDIT_VERSION,
          changedPaths: [],
          wallClockMs,
          terminationReason:
            "direct_edit_protocol_error",
          progressPhase:
            "DISCOVERY",
          inputTokens:
            usage.promptTokens,
          outputTokens:
            usage.completionTokens,
          cachedInputTokens:
            usage.cachedTokens,
          cacheWriteTokens:
            usage.cacheWriteTokens,
          costUsd:
            usage.costUsd ??
            input.budgetUsd,
          steps:
            responses.length,
          fatalError:
            source === undefined
              ? "Missing target requires createContent"
              : "Existing target must use edits or explicit deletion",
        };
      }

      if (
        wantsDelete &&
        !isExplicitDeleteTask(
          input.task,
        )
      ) {
        return {
          exitStatus: "failed",
          model:
            response.model,
          engine:
            "direct-edit",
          engineVersion:
            DIRECT_EDIT_VERSION,
          changedPaths: [],
          wallClockMs,
          terminationReason:
            "direct_edit_protocol_error",
          progressPhase:
            "DISCOVERY",
          inputTokens:
            usage.promptTokens,
          outputTokens:
            usage.completionTokens,
          cachedInputTokens:
            usage.cachedTokens,
          cacheWriteTokens:
            usage.cacheWriteTokens,
          costUsd:
            usage.costUsd ??
            input.budgetUsd,
          steps:
            responses.length,
          fatalError:
            "Model requested deletion but the task did not explicitly request it",
        };
      }

      const scope =
        new WriteScope(
          [target],
          this.logger,
          input.attemptId,
        );

      const tools =
        new AgentTools(
          input.repoPath,
          false,
          input.commandTimeoutMs,
          this.logger,
          input.attemptId,
          input.maxToolOutputBytes ??
            4000,
          scope,
          input.context
            ?.relevantFiles ?? [],
        );

      try {
        await tools.execute(
          "apply_patch",
          {
            edits: wantsCreate
              ? [
                  {
                    path: target,
                    createContent:
                      args.createContent,
                  },
                ]
              : wantsDelete
                ? [
                    {
                      path:
                        target,
                      delete:
                        true,
                    },
                  ]
                : edits.map(
                    (edit: any) => ({
                      path:
                        target,
                      oldText:
                        edit.oldText,
                      newText:
                        edit.newText,
                    }),
                  ),
          },
        );
      } catch (error) {
        return {
          exitStatus: "failed",
          model:
            response.model,
          engine:
            "direct-edit",
          engineVersion:
            DIRECT_EDIT_VERSION,
          changedPaths: [],
          wallClockMs:
            Date.now() -
            started,
          terminationReason:
            "direct_edit_patch_rejected",
          progressPhase:
            "MUTATION_ATTEMPTED",
          inputTokens:
            usage.promptTokens,
          outputTokens:
            usage.completionTokens,
          cachedInputTokens:
            usage.cachedTokens,
          cacheWriteTokens:
            usage.cacheWriteTokens,
          costUsd:
            usage.costUsd ??
            input.budgetUsd,
          steps:
            responses.length,
          fatalError:
            String(error),
        };
      }

      return {
        exitStatus: "completed",
        model:
          response.model,
        engine: "direct-edit",
        engineVersion:
          DIRECT_EDIT_VERSION,
        changedPaths: [target],
        wallClockMs:
          Date.now() - started,
        terminationReason:
          "Submitted",
        progressPhase:
          "MUTATION_OBSERVED",
        steps: responses.length,
        timeToFirstMutationMs:
          Date.now() - started,
        inputTokens:
          usage.promptTokens,
        outputTokens:
          usage.completionTokens,
        cachedInputTokens:
          usage.cachedTokens,
        cacheWriteTokens:
          usage.cacheWriteTokens,
        costUsd:
          usage.costUsd ??
          input.budgetUsd,
        configuredTokenLimit:
          input.maxTokens,
        consumedTokens:
          usage.promptTokens +
          usage.completionTokens,
        remainingTokens:
          Math.max(
            0,
            input.maxTokens -
              usage.promptTokens -
              usage.completionTokens,
          ),
      };
    } catch (error) {
      if (!settled) {
        if (
          apiRejectedBeforeGeneration(
            error,
          )
        ) {
          reservation.cancel();
        } else {
          reservation.settleUncertain();
        }
      }

      const call =
        usageFromEvent(
          this.logger,
          eventStart,
          input.model,
        );

      return {
        exitStatus:
          operationalFailure(error)
            ? "infra_failure"
            : "failed",
        model: call.model,
        engine: "direct-edit",
        engineVersion:
          DIRECT_EDIT_VERSION,
        changedPaths: [],
        wallClockMs:
          Date.now() - started,
        terminationReason:
          operationalFailure(error)
            ? "infrastructure_failure"
            : "direct_edit_protocol_error",
        progressPhase:
          "DISCOVERY",
        inputTokens:
          call.inputTokens,
        outputTokens:
          call.outputTokens,
        cachedInputTokens:
          call.cachedInputTokens,
        cacheWriteTokens:
          call.cacheWriteTokens,
        costUsd:
          call.costUsd,
        fatalError:
          String(error),
      };
    }
  }
}
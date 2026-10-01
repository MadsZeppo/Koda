import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

import type { Budget } from "../openrouter/usage.js";
import {
  estimateUsageCost,
  parseUsage,
} from "../openrouter/usage.js";
import type { Usage } from "../types.js";
import type { Logger } from "../telemetry/logger.js";

import {
  AgentTools,
  toolDefinitions,
} from "./tools.js";
import { WriteScope } from "../repo/writeScope.js";
import { AttemptCheckpoint } from "./attemptCheckpoint.js";

import type {
  CodingWorker,
  CodingWorkerInput,
  CodingWorkerResult,
} from "./codingWorker.js";

export const AGENTIC_CODING_VERSION = "1";

export interface AgenticCodingResponse {
  model: string;
  usage: unknown;
  message: {
    content?: string | null;
    tool_calls?: Array<{
      id: string;
      type: string;
      function: {
        name: string;
        arguments: string;
      };
    }>;
  };
}

export type AgenticCodingRequester = (
  input: CodingWorkerInput,
  messages: ChatCompletionMessageParam[],
  tools: ChatCompletionTool[],
  maxOutputTokens: number,
) => Promise<AgenticCodingResponse>;

function estimatedPromptTokens(
  messages: ChatCompletionMessageParam[],
) {
  const bytes =
    Buffer.byteLength(
      JSON.stringify({
        messages,
        tools: toolDefinitions,
      }),
    );

  return Math.ceil(
    Math.max(
      256,
      bytes / 4,
    ) * 1.4,
  ) + 128;
}

function compactSeed(
  input: CodingWorkerInput,
) {
  return [
    input.context?.localizationSummary
      ? `LOCALIZATION\n${input.context.localizationSummary.slice(0, 2_000)}`
      : "",
    input.context?.diagnostics
      ? `DIAGNOSTICS\n${input.context.diagnostics.slice(0, 3_000)}`
      : "",
    input.context?.previousFailedDiff
      ? `PREVIOUS FAILED DIFF\n${input.context.previousFailedDiff.slice(0, 3_000)}`
      : "",
    `KNOWN RELEVANT PATHS\n${JSON.stringify(
      input.context?.relevantFiles ?? [],
    )}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function aggregateUsage(
  values: readonly Usage[],
  input: CodingWorkerInput,
): Usage {
  const promptTokens =
    values.reduce(
      (sum, usage) =>
        sum + usage.promptTokens,
      0,
    );

  const completionTokens =
    values.reduce(
      (sum, usage) =>
        sum + usage.completionTokens,
      0,
    );

  const reasoningTokens =
    values.reduce(
      (sum, usage) =>
        sum + usage.reasoningTokens,
      0,
    );

  const cachedTokens =
    values.reduce(
      (sum, usage) =>
        sum + usage.cachedTokens,
      0,
    );

  const cacheWriteTokens =
    values.reduce(
      (sum, usage) =>
        sum + usage.cacheWriteTokens,
      0,
    );

  const directCosts =
    values.map(
      (usage) =>
        usage.costUsd,
    );

  let costUsd: number | null = null;

  if (
    directCosts.every(
      (value): value is number =>
        typeof value === "number" &&
        Number.isFinite(value),
    )
  ) {
    costUsd =
      directCosts.reduce(
        (sum, value) =>
          sum + value,
        0,
      );
  } else if (
    input.promptPricePerMillion !== undefined &&
    input.completionPricePerMillion !== undefined
  ) {
    costUsd = estimateUsageCost(
      {
        promptTokens,
        completionTokens,
        reasoningTokens,
        cachedTokens,
        cacheWriteTokens,
        costUsd: null,
        raw: {
          prompt_tokens:
            promptTokens,
          completion_tokens:
            completionTokens,
        },
      },
      input.promptPricePerMillion,
      input.completionPricePerMillion,
    );
  }

  return {
    promptTokens,
    completionTokens,
    reasoningTokens,
    cachedTokens,
    cacheWriteTokens,
    costUsd,
    raw: {
      prompt_tokens:
        promptTokens,
      completion_tokens:
        completionTokens,
    },
  };
}

export class AgenticCodingWorker
  implements CodingWorker
{
  constructor(
    readonly budget: Budget,
    readonly logger: Logger,
    private readonly requester?: AgenticCodingRequester,
  ) {}

  private async request(
    input: CodingWorkerInput,
    messages: ChatCompletionMessageParam[],
    maxOutputTokens: number,
  ): Promise<AgenticCodingResponse> {
    if (this.requester) {
      return this.requester(
        input,
        messages,
        toolDefinitions,
        maxOutputTokens,
      );
    }

    const apiKey =
      (
        process.env.OPENROUTER_API_KEY ??
        ""
      ).trim();

    if (!apiKey) {
      throw Error(
        "INFRA_FAILURE: OPENROUTER_API_KEY is missing",
      );
    }

    const sdk = new OpenAI({
      apiKey,
      baseURL: input.baseUrl,
      maxRetries: 0,
      timeout: input.requestTimeoutMs,
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
    };

    if (
      input.promptPricePerMillion !== undefined &&
      input.completionPricePerMillion !== undefined
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
          tools: toolDefinitions,
          tool_choice: "auto",
          max_tokens:
            maxOutputTokens,
          stream: false,
          ...({
            session_id:
              input.sessionId,
            provider,
          } as any),
        },
        {
          timeout:
            input.requestTimeoutMs,
          signal:
            AbortSignal.timeout(
              input.requestTimeoutMs,
            ),
        },
      );

    return {
      model: response.model,
      usage: response.usage,
      message:
        (response.choices[0]
          ?.message ?? {}) as any,
    };
  }

  async run(
    input: CodingWorkerInput,
  ): Promise<CodingWorkerResult> {
    const started = Date.now();

    const scope =
      new WriteScope(
        input.writeScope,
        this.logger,
        input.attemptId,
      );

    const checkpoint =
      await AttemptCheckpoint.capture(
        input.repoPath,
        scope,
      );

    const tools =
      new AgentTools(
        input.repoPath,
        false,
        input.commandTimeoutMs,
        this.logger,
        input.attemptId,
        input.maxToolOutputBytes ??
          4_000,
        scope,
        input.context
          ?.relevantFiles ??
          [],
      );

    const messages:
      ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: [
          "You are Koda's progressive coding worker.",
          "Use repository tools instead of asking for the whole repository in the prompt.",
          "Search and read only the code needed to complete the task.",
          "Never invent a repository path when search or list_files can establish the real path.",
          "Modify only paths permitted by the immutable write scope.",
          "For new files, use write_file only when the task and repository evidence justify the path.",
          "Prefer edit_file or apply_patch for small changes to existing files.",
          "Do not stop at a plan: make the code change.",
          "Use run_command only for focused checks or safe repository inspection.",
          "Koda performs authoritative verification after this worker finishes.",
        ].join(" "),
      },
      {
        role: "user",
        content: [
          `TASK\n${input.task}`,
          `WRITE SCOPE\n${JSON.stringify(
            input.writeScope,
          )}`,
          compactSeed(input),
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ];

    const reservation =
      this.budget.reserve(
        input.budgetUsd,
        input.maxTokens,
      );

    const usages: Usage[] = [];
    let modelServed =
      input.model;
    let mutationObserved = false;
    let providerDispatched = false;

    const settleKnown = () => {
      const usage =
        aggregateUsage(
          usages,
          input,
        );

      reservation.settle(
        usage,
      );

      return usage;
    };

    const currentChanges =
      async () =>
        checkpoint.changed(
          input.repoPath,
          scope,
        );

    const result = async (
      partial: Omit<
        CodingWorkerResult,
        | "model"
        | "engine"
        | "engineVersion"
        | "wallClockMs"
      >,
    ): Promise<CodingWorkerResult> => {
      const usage = settleKnown();

      return {
        ...partial,
        model: modelServed,
        engine: "agentic",
        engineVersion:
          AGENTIC_CODING_VERSION,
        wallClockMs:
          Date.now() - started,
        costUsd:
          usage.costUsd ??
          undefined,
        inputTokens:
          usage.promptTokens,
        outputTokens:
          usage.completionTokens,
        cachedInputTokens:
          usage.cachedTokens,
        cacheWriteTokens:
          usage.cacheWriteTokens,
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
    };

    try {
      for (
        let step = 0;
        step < input.maxSteps;
        step++
      ) {
        const usedTokens =
          usages.reduce(
            (sum, usage) =>
              sum +
              usage.promptTokens +
              usage.completionTokens,
            0,
          );

        const promptTokens =
          estimatedPromptTokens(
            messages,
          );

        const attemptRoom =
          input.maxTokens -
          usedTokens -
          promptTokens;

        const providerRoom =
          (input.contextWindowTokens ?? Infinity) -
          promptTokens;

        const tokenRoom =
          Math.min(
            attemptRoom,
            providerRoom,
          );

        if (tokenRoom < 256) {
          const changes =
            await currentChanges();

          if (changes.length) {
            mutationObserved = true;

            return result({
              exitStatus:
                "completed",
              changedPaths:
                changes.map(
                  (change) =>
                    change.path,
                ),
              terminationReason:
                "candidate_ready_for_verification",
              progressPhase:
                "MUTATION_OBSERVED",
              limitKind:
                "token_preflight",
              exactLimitFired:
                "agentic_token_preflight_after_mutation",
              steps: step,
            });
          }

          return result({
            exitStatus: "failed",
            changedPaths: [],
            terminationReason:
              "attempt_budget_exhausted",
            limitKind:
              "token_preflight",
            exactLimitFired:
              "agentic_token_preflight",
            progressPhase:
              "DISCOVERY",
            steps: step,
          });
        }

        let maxOutput =
          Math.min(
            input.maxOutputTokens,
            1_200,
            tokenRoom,
          );

        if (
          input.promptPricePerMillion !== undefined &&
          input.completionPricePerMillion !== undefined
        ) {
          const spent =
            usages.reduce(
              (sum, usage) =>
                sum +
                (usage.costUsd ??
                  estimateUsageCost(
                    usage,
                    input.promptPricePerMillion!,
                    input.completionPricePerMillion!,
                  ) ??
                  0),
              0,
            );

          const promptCost =
            promptTokens *
            input.promptPricePerMillion /
            1e6;

          const availableForOutput =
            input.budgetUsd -
            spent -
            promptCost;

          if (
            availableForOutput <=
            0
          ) {
            const changes =
              await currentChanges();

            if (changes.length) {
              return result({
                exitStatus:
                  "completed",
                changedPaths:
                  changes.map(
                    (change) =>
                      change.path,
                  ),
                terminationReason:
                  "candidate_ready_for_verification",
                progressPhase:
                  "MUTATION_OBSERVED",
                limitKind:
                  "token_preflight",
                exactLimitFired:
                  "agentic_cost_preflight_after_mutation",
                steps: step,
              });
            }

            return result({
              exitStatus:
                "failed",
              changedPaths: [],
              terminationReason:
                "attempt_budget_exhausted",
              limitKind:
                "token_preflight",
              exactLimitFired:
                "agentic_cost_preflight",
              progressPhase:
                "DISCOVERY",
              steps: step,
            });
          }

          if (
            input.completionPricePerMillion >
            0
          ) {
            maxOutput =
              Math.min(
                maxOutput,
                Math.floor(
                  availableForOutput *
                    1e6 /
                    input.completionPricePerMillion,
                ),
              );
          }
        }

        if (maxOutput < 64) {
          const changes =
            await currentChanges();

          if (changes.length) {
            return result({
              exitStatus:
                "completed",
              changedPaths:
                changes.map(
                  (change) =>
                    change.path,
                ),
              terminationReason:
                "candidate_ready_for_verification",
              progressPhase:
                "MUTATION_OBSERVED",
              limitKind:
                "token_preflight",
              exactLimitFired:
                "agentic_output_reserve_after_mutation",
              steps: step,
            });
          }

          return result({
            exitStatus: "failed",
            changedPaths: [],
            terminationReason:
              "attempt_budget_exhausted",
            limitKind:
              "token_preflight",
            exactLimitFired:
              "agentic_output_reserve",
            progressPhase:
              "DISCOVERY",
            steps: step,
          });
        }

        this.logger.log(
          "provider_policy",
          {
            subtaskId:
              input.attemptId,
            stage: "implement",
            model: input.model,
            worker_engine:
              "agentic",
            max_output_tokens:
              maxOutput,
          },
        );

        providerDispatched = true;

        const response =
          await this.request(
            input,
            messages,
            maxOutput,
          );

        modelServed =
          response.model ||
          input.model;

        const usage =
          parseUsage(
            response.usage,
          );

        usages.push(usage);

        this.logger.log(
          "model_call",
          {
            subtaskId:
              input.attemptId,
            stage: "implement",
            modelRequested:
              input.model,
            modelReturned:
              modelServed,
            promptTokens:
              usage.promptTokens,
            completionTokens:
              usage.completionTokens,
            cachedTokens:
              usage.cachedTokens,
            cacheWriteTokens:
              usage.cacheWriteTokens,
            costUsd:
              usage.costUsd,
            wallClockMs:
              Date.now() -
              started,
          },
        );

        const assistant =
          response.message as any;

        messages.push(
          assistant,
        );

        const calls =
          assistant.tool_calls ??
          [];

        if (!calls.length) {
          const changes =
            await currentChanges();

          if (changes.length) {
            mutationObserved = true;

            return result({
              exitStatus:
                "completed",
              changedPaths:
                changes.map(
                  (change) =>
                    change.path,
                ),
              terminationReason:
                "agentic_completed",
              progressPhase:
                "MUTATION_OBSERVED",
              steps: step + 1,
            });
          }

          messages.push({
            role: "user",
            content:
              "No mutation has been made yet. Continue with repository tools and implement the requested change. Do not only explain.",
          });

          continue;
        }

        for (
          const call
          of calls.slice(0, 8)
        ) {
          let content: string;

          try {
            const args =
              JSON.parse(
                call.function.arguments,
              );

            content =
              String(
                await tools.execute(
                  call.function.name,
                  args,
                ),
              );
          } catch (error) {
            content =
              `Tool error: ${String(
                error,
              )}`;
          }

          messages.push({
            role: "tool",
            tool_call_id:
              call.id,
            content,
          } as any);
        }

        const changes =
          await currentChanges();

        if (changes.length) {
          mutationObserved = true;
        }
      }

      const changes =
        await currentChanges();

      return result({
        exitStatus:
          changes.length
            ? "completed"
            : "failed",
        changedPaths:
          changes.map(
            (change) =>
              change.path,
          ),
        terminationReason:
          changes.length
            ? "candidate_ready_for_verification"
            : "agentic_step_limit",
        limitKind:
          changes.length
            ? undefined
            : "step_limit",
        progressPhase:
          changes.length
            ? "MUTATION_OBSERVED"
            : "DISCOVERY",
        steps: input.maxSteps,
      });
    } catch (error) {
      if (providerDispatched) {
        reservation.settleUncertain();
      } else {
        reservation.cancel();
      }

      const changes =
        await currentChanges()
          .catch(() => []);

      return {
        exitStatus:
          "infra_failure",
        model: modelServed,
        engine: "agentic",
        engineVersion:
          AGENTIC_CODING_VERSION,
        changedPaths:
          changes.map(
            (change) =>
              change.path,
          ),
        wallClockMs:
          Date.now() - started,
        terminationReason:
          "agentic_provider_error",
        progressPhase:
          mutationObserved ||
          changes.length
            ? "MUTATION_OBSERVED"
            : "DISCOVERY",
        fatalError:
          String(error),
        configuredTokenLimit:
          input.maxTokens,
      };
    }
  }
}

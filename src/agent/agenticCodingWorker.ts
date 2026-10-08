import {AUTO_MODEL,autoRequestPlugin} from "../router/openRouterAutoPolicy.js";
import { admitProviderPayload, providerPayloadBound } from "../context/packetPolicy.js";
import { providerTransport } from '../provider/transport.js';
import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { isTestPath, resolveImports } from "../context/compiler.js";
import { listWorkspaceFiles } from "../workspace/files.js";
import { discoveredTestGlobs, matchesDiscoveredTestGlob } from "../verifier/selection.js";
import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

import { supportsParameters } from "../router/pool.js";
import type { Budget } from "../openrouter/usage.js";
import {
  estimateUsageCost,
  parseUsage,
} from "../openrouter/usage.js";
import type { Usage } from "../types.js";
import type { Logger } from "../telemetry/logger.js";

import {
  AgentTools,
  safePath,
  toolDefinitions,
} from "./tools.js";
import { requestsTestMutation } from "../router/executionStrategy.js";
import { WriteScope } from "../repo/writeScope.js";
import { AttemptCheckpoint } from "./attemptCheckpoint.js";

import type {
  CodingWorker,
  CodingWorkerInput,
  CodingWorkerResult,
} from "./codingWorker.js";

export const AGENTIC_CODING_VERSION = "1";

const MIN_NEXT_OUTPUT_TOKENS = 256;
const MAX_TOOL_CALLS_PER_TURN = 8;
const MAX_USEFUL_DISCOVERY_BEFORE_MUTATION = 2;
const DISCOVERY_EVIDENCE_BYTES = 3_000;

const DISCOVERY_TOOLS = new Set([
  "list_files",
  "search_code",
  "read_file",
  "file_outline",
  "git_diff",
  "git_status",
]);
const MUTATION_TOOLS = new Set(["apply_patch", "edit_file", "write_file"]);
const MUTATION_TOOL_DEFINITIONS = toolDefinitions.filter((tool) =>
  "function" in tool && MUTATION_TOOLS.has(tool.function.name));
const LOCALIZED_READ_TOOLS = new Set(["read_file", "file_outline"]);
const LOCALIZED_READ_DEFINITIONS = toolDefinitions.filter((tool) =>
  "function" in tool && LOCALIZED_READ_TOOLS.has(tool.function.name));
const READ_TOOL_DEFINITIONS = toolDefinitions.filter((tool) =>
  "function" in tool && tool.function.name === "read_file");

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
  tools: ChatCompletionTool[] = toolDefinitions,
) {
  return providerPayloadBound({ messages, tools });
}

function compactSeed(
  input: CodingWorkerInput,
) {
  /*
   * A complete-packet recovery exists specifically because attached context
   * did not fit. Do not send that same context back through Agentic.
   *
   * Never truncate input.task here. Repository context is expendable because
   * Agentic can retrieve it progressively with read/search tools.
   */
  const sourceExcerptBudget =
    input.context?.implementationRecovery
      ? 0
      : input.context?.completionRepair
        ? 4_000
        : 8_000;

  let excerptBytes = 0;

  const excerpts =
    (input.context?.sourceFiles ?? []).flatMap((file) => {
      if (excerptBytes >= sourceExcerptBudget) {
        return [];
      }

      const remaining =
        sourceExcerptBudget - excerptBytes;

      const snippet =
        file.snippet.slice(0, remaining);

      excerptBytes +=
        Buffer.byteLength(snippet);

      return snippet
        ? [
            `FILE EXCERPT ${file.path}\n${snippet}`,
          ]
        : [];
    });
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
    input.context?.completionRepair
      ? `UNRESOLVED REQUIREMENT IDS\n${JSON.stringify(input.context.completionRepair.unresolvedRequirementIds)}`
      : "",
    input.context?.implementationRecovery && input.context.evidence
      ? `RETAINED LOCALIZATION EVIDENCE\n${JSON.stringify(input.context.evidence).slice(0, 2000)}`
      : "",
    `KNOWN RELEVANT PATHS\n${JSON.stringify(
      input.context?.relevantFiles ?? [],
    )}`,
    excerpts.length
      ? `BOUNDED IMPLEMENTATION EXCERPTS\n${excerpts.join("\n\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Conservative framing for the same bounded seed that native tools use.
 * Never size Agentic from a full Aider file packet or raw verifier transcript. */
export function agenticPromptBytes(input: Pick<CodingWorkerInput, "task" | "writeScope" | "context">) {
  return Buffer.byteLength(JSON.stringify({task: input.task, writeScope: input.writeScope,
    seed: compactSeed(input as CodingWorkerInput), tools: toolDefinitions})) + 8192;
}

function aggregateUsage(
  values: readonly Usage[],
  input: CodingWorkerInput,
): Usage {
  const promptTokens = values.reduce(
    (sum, usage) =>
      sum + usage.promptTokens,
    0,
  );

  const completionTokens = values.reduce(
    (sum, usage) =>
      sum + usage.completionTokens,
    0,
  );

  const reasoningTokens = values.reduce(
    (sum, usage) =>
      sum + usage.reasoningTokens,
    0,
  );

  const cachedTokens = values.reduce(
    (sum, usage) =>
      sum + usage.cachedTokens,
    0,
  );

  const cacheWriteTokens = values.reduce(
    (sum, usage) =>
      sum + usage.cacheWriteTokens,
    0,
  );

  const directCosts = values.map(
    (usage) => usage.costUsd,
  );

  let costUsd: number | null = null;

  if (
    directCosts.every(
      (value): value is number =>
        typeof value === "number" &&
        Number.isFinite(value),
    )
  ) {
    costUsd = directCosts.reduce(
      (sum, value) => sum + value,
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
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
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
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
    },
  };
}

function compactToolText(
  value: string,
  maxChars: number,
) {
  if (value.length <= maxChars) {
    return value;
  }

  const marker =
    "\n...[Koda compacted older tool output; call the tool again if exact omitted text is needed]...\n";

  if (maxChars <= marker.length + 32) {
    return (
      value.slice(0, Math.max(0, maxChars - 1)) +
      "…"
    );
  }

  const room = maxChars - marker.length;
  const head = Math.ceil(room * 0.7);
  const tail = Math.max(0, room - head);

  return (
    value.slice(0, head) +
    marker +
    (tail ? value.slice(-tail) : "")
  );
}

/**
 * Keep tool-call protocol structure intact while bounding repeated history.
 *
 * Every assistant tool_call still keeps its corresponding tool response. We
 * only compact the textual payload of older tool responses. This avoids the
 * invalid-history bug caused by dropping tool messages, while preventing a
 * few 4KB read/search results from being resent in full on every later turn.
 */
function compactToolHistoryToBudget(
  messages: ChatCompletionMessageParam[],
  promptBudgetTokens: number,
  tools: ChatCompletionTool[] = toolDefinitions,
) {
  let promptTokens =
    estimatedPromptTokens(messages, tools);

  if (
    !Number.isFinite(promptBudgetTokens) ||
    promptTokens <= promptBudgetTokens
  ) {
    return {
      promptTokens,
      compactedMessages: 0,
    };
  }

  const toolIndexes = messages
    .map((message, index) =>
      (message as { role?: string }).role === "tool"
        ? index
        : -1,
    )
    .filter((index) => index >= 0);

  let compactedMessages = 0;

  const passes = [
    { keepRecent: 2, maxChars: 1_200 },
    { keepRecent: 1, maxChars: 700 },
    { keepRecent: 0, maxChars: 384 },
    { keepRecent: 0, maxChars: 192 },
  ];

  for (const pass of passes) {
    const protectedFrom = Math.max(
      0,
      toolIndexes.length - pass.keepRecent,
    );

    for (
      let position = 0;
      position < protectedFrom;
      position++
    ) {
      const index = toolIndexes[position]!;
      const message = messages[index] as {
        role?: string;
        content?: unknown;
      };

      if (typeof message.content !== "string") {
        continue;
      }

      const compacted = compactToolText(
        message.content,
        pass.maxChars,
      );

      if (compacted !== message.content) {
        message.content = compacted;
        compactedMessages++;
      }
    }

    promptTokens =
      estimatedPromptTokens(messages, tools);

    if (promptTokens <= promptBudgetTokens) {
      break;
    }
  }

  return {
    promptTokens,
    compactedMessages,
  };
}

function boundedDiscoveryEvidence(
  notes: readonly string[],
) {
  if (!notes.length) return undefined;

  const joined = notes.join("\n");
  const bytes = Buffer.from(joined);

  if (bytes.length <= DISCOVERY_EVIDENCE_BYTES) {
    return joined;
  }

  return bytes
    .subarray(
      bytes.length - DISCOVERY_EVIDENCE_BYTES,
    )
    .toString("utf8");
}

function discoveryNote(
  name: string,
  args: Record<string, unknown>,
  content: string,
) {
  if (
    !DISCOVERY_TOOLS.has(name)
  ) {
    return undefined;
  }

  const subject =
    args.path ??
    args.query ??
    args.command ??
    "";

  const excerpt = content
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 650);

  return `${name}${subject ? ` ${String(subject)}` : ""}: ${excerpt}`;
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
    tools: ChatCompletionTool[],
    maxOutputTokens: number,
  ): Promise<AgenticCodingResponse> {
    const autoPlugin = input.model === AUTO_MODEL && input.autoRouter ? {plugins:[autoRequestPlugin(input.autoRouter)]} : {};
    if (input.model === AUTO_MODEL && !input.autoRouter) throw Error("provider_protocol_error: Auto requires an explicit allowed model pool");
    const payloadBound = admitProviderPayload({ ...autoPlugin, model: input.model, messages, tools,
      tool_choice: "required", max_tokens: maxOutputTokens, stream: false,
      session_id: input.sessionId, provider: { require_parameters: true, allow_fallbacks: true,
        sort: { by: "price", partition: "none" },
        max_price: { prompt: input.promptPricePerMillion, completion: input.completionPricePerMillion } } },
      maxOutputTokens, input.contextWindowTokens);
    if (estimatedPromptTokens(messages, tools) + maxOutputTokens > input.maxTokens)
      throw Error("provider_input_preflight: request cannot consume remaining attempt tokens");
    this.logger.log("provider_payload_bound", { subtaskId: input.attemptId, ...payloadBound });
    if (this.requester) {
      return this.requester(
        input,
        messages,
        tools,
        maxOutputTokens,
      );
    }

    const { apiKey, baseUrl } = providerTransport(input.baseUrl);

    const sdk = new OpenAI({
      apiKey,
      baseURL: baseUrl,
      maxRetries: 0,
      timeout: input.requestTimeoutMs,
    });

    const provider: Record<string, unknown> = {
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
        prompt: input.promptPricePerMillion,
        completion: input.completionPricePerMillion,
      };
    }

    const response =
      await sdk.chat.completions.create(
        {
          ...autoPlugin,
          model: input.model,
          messages,
          tools,
          tool_choice: "required",
          max_tokens: maxOutputTokens,
          stream: false,
          ...({
            session_id: input.sessionId,
            provider,
          } as any),
        },
        {
          timeout: input.requestTimeoutMs,
          signal: AbortSignal.timeout(
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

    const scope = new WriteScope(
      input.writeScope,
      this.logger,
      input.attemptId,
    );

    const checkpoint =
      await AttemptCheckpoint.capture(
        input.repoPath,
        scope,
      );

    const tools = new AgentTools(
      input.repoPath,
      false,
      input.commandTimeoutMs,
      this.logger,
      input.attemptId,
      input.maxToolOutputBytes ?? 4_000,
      scope,
      input.context?.relevantFiles ?? [],
    );

    let testGlobs: string[] = [];
    try {
      const manifest = JSON.parse(await readFile(join(input.repoPath, "package.json"), "utf8"));
      testGlobs = discoveredTestGlobs(manifest.scripts?.test ?? "");
    } catch {}
    const inspectedFiles = new Map<string, string>();
    const knownPaths = new Set(await listWorkspaceFiles(input.repoPath));
    const groundedRead = (name: string, args: Record<string, unknown>) =>
      (name === "read_file" || name === "file_outline") &&
      !inspectedFiles.has(String(args.path)) &&
      (input.writeScope.includes(String(args.path)) || [...inspectedFiles].some(([path, text]) =>
        resolveImports(path, text, knownPaths).includes(String(args.path))));
    const localizedRecovery = !!input.context?.implementationRecovery &&
      input.writeScope.length > 0 && !input.writeScope.includes(".");
    const recoveryReadPaths = new Set([
      ...input.writeScope, ...(input.context?.relevantFiles ?? []),
    ]);
    const recoveryReadLimit = Math.max(2, Math.min(6, recoveryReadPaths.size));
    const recoveryReads = () => tools.progressEvidence.filter((key) => key.startsWith("read_file:")).length;
    const existingWritePaths = input.writeScope.filter((path) => knownPaths.has(path));
    const broadScope = input.writeScope.includes(".");
    const returnAfterMutation = input.returnOnMutation === true;
    const needsContractReads = broadScope || existingWritePaths.length > 1 || input.writeScope.some(isTestPath) ||
      /\b(?:tests?|regression)\b/i.test(input.task);
    const hasRead = () => tools.progressEvidence.some((key) => key.startsWith("read_file:"));
    // A large authorized scope is permission, not an instruction to read
    // every file before the first edit. Each existing mutation path is still
    // guarded below by its own successful read.
    const hasTargetRead = () => broadScope || existingWritePaths.length === 0
      ? hasRead()
      : existingWritePaths.length > 4
        ? existingWritePaths.some((path) =>
            tools.progressEvidence.some((key) => key.startsWith(`read_file:${path}:`)))
        : existingWritePaths.every((path) =>
            tools.progressEvidence.some((key) => key.startsWith(`read_file:${path}:`)));
    const hasAllTargetContents = () => existingWritePaths.length > 0 &&
      existingWritePaths.every((path) => inspectedFiles.has(path));
    const testWritingTask = input.writeScope.some(isTestPath) ||
      /\b(?:tests?|regression)\b/i.test(input.task);
    const implementationExcerpts = () => {
      let room = 8000;
      let secondaryRoom = 1000;
      return [...inspectedFiles].sort(([left], [right]) =>
        Number(input.writeScope.includes(right)) - Number(input.writeScope.includes(left))).map(([path, content]) => {
        const primary = input.writeScope.includes(path) || broadScope;
        const excerpt = content.slice(0, Math.max(0, Math.min(room, primary ? room : secondaryRoom)));
        room -= excerpt.length;
        if (!primary) secondaryRoom -= excerpt.length;
        return excerpt ? `READ FILE ${path}\n${excerpt}` : "";
      }).filter(Boolean).join("\n\n");
    };
    if (input.context?.completionRepair) {
      const paths = [
        ...new Set([
          ...input.writeScope.filter(
            (path) => path !== ".",
          ),
          ...(input.context.relevantFiles ?? []),
        ]),
      ].slice(0, 2);

      for (const path of paths) {
        try {
          const content = String(
            await tools.execute(
              "read_file",
              { path },
            ),
          );

          if (content.trim()) {
            inspectedFiles.set(
              path,
              content,
            );
          }
        } catch {}
      }
    }

    const messages: ChatCompletionMessageParam[] = [
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
          input.returnOnMutation
            ? "Follow LOCATE -> READ -> MUTATE -> RETURN TO KODA. Read relevant code before implementing."
            : "Read relevant existing files, implement the required changes, inspect the result and retrieve more precise context when needed. Continue editing until the complete assigned task is implemented, then return to Koda.",
          "Preserve exact public identifiers and literals from the original task, including dispatch keys, exports and routes. Do not shorten or normalize them. Requested regression tests are part of implementation: cover the public entry point with those original identifiers, not only internal helpers. Complete source and requested tests before finishing.",
          "Never run tests; deterministic Koda verification owns all checks.",
          "Derive expected test results independently from the original contract: trace counts, ordering and tie rules. Test only legal inputs; an empty value is not an omitted argument. For repair, inspect the failing assertion and source together. Correct newly generated expectations only with concrete contract evidence, never merely to match current output; preserve pre-existing tests and required behaviors. Do not introduce unrelated cases during repair.",
          testGlobs.length ? `Test files must match the discovered runner globs: ${testGlobs.join(", ")}.` : "",
          !testGlobs.length && input.writeScope.includes("package.json") &&
            input.writeScope.some(isTestPath)
            ? "This repository has no discovered test runner. The task requires tests: use the authorized package manifest and test file to establish a runnable repository test command. Koda must execute the new tests before accepting the candidate."
            : "",
          "Koda performs authoritative verification after this worker finishes.",
          localizedRecovery ? "This is an implementation continuation after an execution limit. Localization and write scope are already established. Read a precise range in the supplied relevant files, then implement. Do not repeat repository-wide searches or listing. Necessary precise contract reads remain available within the supplied paths." : "",
          input.context?.completionRepair
            ? input.context.completionRepair.mutationRequiredBeforeDiscovery
              ? "This is a completion-repair continuation. The existing diff, compact excerpts, and reviewer diagnostics already establish the missing work. Mutate the authorized scope first. After a real mutation, normal tools reopen for at most two new evidence reads before another implementation mutation is required."
              : "This is verification repair. Read the failing test and implementation before editing. Derive the expected result from the original contract and input independently of the candidate output. Distinguish incorrect code from incorrect newly authored expectations. Preserve pre-existing tests and requirements; a passing assertion obtained by copying current output is not proof. Complete all justified repairs before returning to Koda."
            : "",
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
          input.context?.completionRepair
            ? implementationExcerpts()
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ];

    const reservation = this.budget.reserve(
      input.budgetUsd,
      input.maxTokens,
    );

    const usages: Usage[] = [];
    const discoveryNotes: string[] = [];
    let modelServed = input.model;
    let mutationObserved = false;
    let repairDiscoverySinceMutation = 0;
    let providerDispatched = false;
    let timeToFirstMutationMs: number | undefined;
    let implementationNudgeSent = false;
    let implementationContextRebuilt = false;
    let minimalImplementationRebuilt = false;

    // Prompt compaction is an execution-envelope correction, not a coding
    // step. It may happen once and must not consume one of maxSteps.
    let initialPromptRebuilt = false;
    let mutationHistoryRebuilt = false;

    let readNudgeSent = false;
    let consecutiveTextTurns = 0;
    let missingTestsNudgeSent = false;
    let malformedToolRetryUsed = false;
    let creditOutputCap: number | undefined;
    const fullBoundedScopeChanged = async () => {
      if (broadScope || input.writeScope.length < 2 || input.writeScope.length > 4)
        return false;
      const changed = new Set((await currentChanges()).map(({ path }) => path));
      return input.writeScope.every((path) => changed.has(path));
    };
    const activeTools = () => {
      const repairMutationRequired =
        !!input.context?.completionRepair?.mutationRequiredBeforeDiscovery &&
        hasRead() &&
        (!mutationObserved || repairDiscoverySinceMutation >= 2);

      // Normal agentic execution must also leave discovery once enough
      // repository evidence exists. A prose nudge is not sufficient:
      // weaker/cheaper models may keep requesting reads until the attempt
      // token budget is exhausted without ever editing anything.
      //
      // After the implementation transition, expose mutation tools only
      // until the first real mutation. Normal discovery tools reopen after
      // that mutation so the worker can continue a multi-file implementation.
      const implementationMutationRequired =
        !mutationObserved &&
        implementationNudgeSent &&
        hasTargetRead() &&
        (
          !needsContractReads ||
          // Once every file in a small, concrete multi-file scope has been
          // read, another discovery turn only repeats evidence. Test-writing
          // tasks remain free to follow imports and read their contracts.
          (!broadScope && !testWritingTask && existingWritePaths.length > 1 &&
            hasAllTargetContents()) ||
          // For a large scope, start with a grounded edit in one read file.
          // Discovery reopens after that edit so later files can be inspected
          // and changed in separate steps without paying to reread all files
          // before the first mutation.
          (!broadScope && !testWritingTask && existingWritePaths.length > 4 &&
            existingWritePaths.filter((path) => inspectedFiles.has(path)).length >= 2) ||
          // Output-limit recovery may need the supplied readonly contracts,
          // but its bounded read allowance must eventually end in mutation.
          (localizedRecovery && recoveryReads() >= recoveryReadLimit)
        );

      const mutationRequired =
        repairMutationRequired ||
        implementationMutationRequired;

      const readRequired =
        (readNudgeSent || (localizedRecovery && existingWritePaths.length > 0)) &&
        !hasTargetRead();

      return mutationRequired
            ? MUTATION_TOOL_DEFINITIONS
            : readRequired
              ? localizedRecovery ? LOCALIZED_READ_DEFINITIONS : READ_TOOL_DEFINITIONS
            : localizedRecovery && !mutationObserved
              ? toolDefinitions.filter((tool) => "function" in tool &&
                  (MUTATION_TOOLS.has(tool.function.name) || LOCALIZED_READ_TOOLS.has(tool.function.name)))
              : toolDefinitions;
    };


    const settleKnown = () => {
      const usage = aggregateUsage(
        usages,
        input,
      );

      reservation.settle(usage);
      return usage;
    };

    const currentChanges = async () =>
      checkpoint.changed(
        input.repoPath,
        scope,
      );

    const evidencePacket = () =>
      boundedDiscoveryEvidence(
        discoveryNotes,
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
          usage.costUsd ?? undefined,
        inputTokens:
          usage.promptTokens,
        outputTokens:
          usage.completionTokens,
        cachedInputTokens:
          usage.cachedTokens,
        cacheWriteTokens:
          usage.cacheWriteTokens,
        timeToFirstMutationMs,
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
        if (
          !mutationObserved &&
          !hasTargetRead() &&
          (broadScope || existingWritePaths.length > 0) &&
          !readNudgeSent &&
          (tools.progressEvidence.length >= 2 || localizedRecovery || returnAfterMutation)
        ) {
          const discoveryEvidence = evidencePacket();
          const systemMessage = messages[0]!;
          messages.splice(
            0,
            messages.length,
            systemMessage,
            {
              role: "user",
              content: [
                `TASK\n${input.task}`,
                `WRITE SCOPE\n${JSON.stringify(input.writeScope)}`,
                compactSeed(input),
                discoveryEvidence
                  ? `DISCOVERY EVIDENCE\n${discoveryEvidence}`
                  : "",
                "READ PHASE: repository search has located candidate code. Read the most relevant implementation or test file now. When a search result gives a line number, request a narrow range around that line. Search output alone is not implementation evidence.",
              ].filter(Boolean).join("\n\n"),
            },
          );
          readNudgeSent = true;
          this.logger.log("agentic_read_transition", {
            subtaskId: input.attemptId,
            useful_discovery_steps: tools.progressEvidence.length,
          });
        }

        if (
          !mutationObserved &&
          !implementationNudgeSent &&
          hasTargetRead() &&
          (tools.progressEvidence.length >= 2 || localizedRecovery || returnAfterMutation)
        ) {
          const discoveryEvidence = evidencePacket();
          const systemMessage = messages[0]!;
          messages.splice(
            0,
            messages.length,
            systemMessage,
            {
              role: "user",
              content: [
                `TASK\n${input.task}`,
                `WRITE SCOPE\n${JSON.stringify(input.writeScope)}`,
                compactSeed(input),
                discoveryEvidence
                  ? `DISCOVERY EVIDENCE\n${discoveryEvidence}`
                  : "",
                implementationExcerpts(),
                needsContractReads
                  ? "IMPLEMENTATION PHASE: implement one small, justified edit in a file already read. Use concise edit_file or apply_patch arguments, not a whole-file rewrite. After a real mutation, precise reads reopen for the remaining work. If a definition or API contract is still missing, read its exact file/range first. Never guess APIs or write from search results alone."
                  : "IMPLEMENTATION PHASE: the assigned target has been read. Make one concise mutation now using edit_file or apply_patch; use write_file for a new file.",
              ].filter(Boolean).join("\n\n"),
            },
          );
          implementationNudgeSent = true;
          implementationContextRebuilt = true;
          this.logger.log("agentic_implementation_transition", {
            subtaskId: input.attemptId,
            useful_discovery_steps: tools.progressEvidence.length,
          });
        }
        const usedTokens = usages.reduce(
          (sum, usage) =>
            sum +
            usage.promptTokens +
            usage.completionTokens,
          0,
        );

        const maxPromptByAttempt =
          input.maxTokens -
          usedTokens -
          MIN_NEXT_OUTPUT_TOKENS;

        const maxPromptByProvider =
          (input.contextWindowTokens ?? Infinity) -
          MIN_NEXT_OUTPUT_TOKENS;

        const promptBudgetTokens = Math.max(
          0,
          Math.min(
            maxPromptByAttempt,
            maxPromptByProvider,
          ),
        );

        const compacted =
          compactToolHistoryToBudget(
            messages,
            promptBudgetTokens,
            activeTools(),
          );

        if (compacted.compactedMessages > 0) {
          this.logger.log(
            "agentic_history_compaction",
            {
              subtaskId:
                input.attemptId,
              compacted_messages:
                compacted.compactedMessages,
              estimated_prompt_tokens:
                compacted.promptTokens,
              prompt_budget_tokens:
                promptBudgetTokens,
            },
          );
        }

        const promptTokens =
          compacted.promptTokens;

        const attemptRoom =
          input.maxTokens -
          usedTokens -
          promptTokens;

        const providerRoom =
          (input.contextWindowTokens ?? Infinity) -
          promptTokens;

        const tokenRoom = Math.min(
          attemptRoom,
          providerRoom,
        );

        if (tokenRoom < MIN_NEXT_OUTPUT_TOKENS) {
          const discoveryEvidence = evidencePacket();

          /*
           * The first Agentic request may still contain more repository seed
           * context than the attempt can afford.
           *
           * Preserve the COMPLETE user task and immutable scope, but remove
           * attached repository text. The model can retrieve implementation
           * context using repository tools.
           */
          if (
            !mutationObserved &&
            !initialPromptRebuilt
          ) {
            const systemMessage =
              messages[0]!;

            messages.splice(
              0,
              messages.length,
              systemMessage,
              {
                role: "user",
                content: [
                  `TASK\n${input.task}`,
                  `WRITE SCOPE\n${JSON.stringify(
                    input.writeScope,
                  )}`,
                  `KNOWN RELEVANT PATHS\n${JSON.stringify(
                    input.context?.relevantFiles ?? [],
                  )}`,
                  input.context?.implementationRecovery
                    ? `RECOVERY CONTEXT\n${JSON.stringify(
                        input.context.evidence ?? {},
                      ).slice(0, 2_000)}`
                    : "",
                  "PROMPT RECOVERY: preserve every requirement in TASK. Retrieve repository implementation details progressively with repository tools instead of relying on attached source excerpts.",
                ]
                  .filter(Boolean)
                  .join("\n\n"),
              },
            );

            initialPromptRebuilt = true;

            this.logger.log(
              "agentic_initial_prompt_compact_retry",
              {
                subtaskId:
                  input.attemptId,
                used_tokens:
                  usedTokens,
              },
            );

            /*
             * This was not a coding/model step: no provider request happened.
             *
             * Keep the same logical step. The for-loop increment after
             * `continue` returns -1 -> 0 (or N-1 -> N), so maxSteps still
             * counts actual worker turns rather than prompt-envelope retries.
             */
            step--;
            continue;
          }

          if (
            !mutationObserved &&
            implementationContextRebuilt &&
            !minimalImplementationRebuilt &&
            discoveryEvidence
          ) {
            const systemMessage = messages[0]!;
            messages.splice(
              0,
              messages.length,
              systemMessage,
              {
                role: "user",
                content: [
                  `TASK\n${input.task}`,
                  `WRITE SCOPE\n${JSON.stringify(input.writeScope)}`,
                  `DISCOVERY EVIDENCE\n${discoveryEvidence}`,
                  implementationExcerpts(),
                  "TOKEN RECOVERY: use the retained file contents to make the smallest justified mutation. Never guess missing code or API contracts.",
                ].join("\n\n"),
              },
            );

            minimalImplementationRebuilt = true;

            this.logger.log(
              "agentic_token_preflight_compact_retry",
              {
                subtaskId: input.attemptId,
                used_tokens: usedTokens,
              },
            );

            continue;
          }

          const changes =
            await currentChanges();

          // Retain the candidate and complete task, not the growing tool
          // transcript. A partial mutation is not a reason to abandon useful
          // remaining attempt budget or pay for a fresh repair session.
          if (changes.length && !returnAfterMutation && !mutationHistoryRebuilt) {
            const currentContents: string[] = [];
            let room = 4000;
            for (const change of changes) {
              if (room <= 0) break;
              try {
                const text = await readFile(join(input.repoPath, change.path), "utf8");
                const excerpt = text.slice(0, room);
                currentContents.push(`CURRENT FILE ${change.path}\n${excerpt}`);
                room -= excerpt.length;
              } catch { /* Deleted paths remain recorded in the change list. */ }
            }
            messages.splice(1, messages.length - 1, {
              role: "user",
              content: [
                `TASK\n${input.task}`,
                `WRITE SCOPE\n${JSON.stringify(input.writeScope)}`,
                `ALREADY CHANGED PATHS\n${JSON.stringify(changes.map(change => change.path))}`,
                currentContents.join("\n\n"),
                `DISCOVERY EVIDENCE\n${discoveryEvidence}`,
                "Continue the remaining requirements, including requested tests. These are current candidate contents. Retrieve precise missing contents as needed; do not restart broad discovery.",
              ].join("\n\n"),
            });
            mutationHistoryRebuilt = true;
            mutationObserved = true;
            this.logger.log("agentic_mutation_history_compact_retry", {subtaskId: input.attemptId, used_tokens: usedTokens});
            step--;
            continue;
          }

          if (changes.length) {
            mutationObserved = true;
            // Catch the same concrete omission as the executor's completion gate
            // while the worker still owns its reads, model pin and transcript.
            // One reminder only: budget/deadline exhaustion still hands back the
            // inspectable candidate for authoritative verification and recovery.
            if (!returnAfterMutation && !missingTestsNudgeSent &&
                requestsTestMutation(input.task) &&
                !changes.some(change => isTestPath(change.path) &&
                  (!testGlobs.length || matchesDiscoveredTestGlob(change.path, testGlobs)))) {
              missingTestsNudgeSent = true;
              messages.push({ role: "user", content:
                "The requested test mutation is missing. Continue in this session: read the relevant existing test if necessary, then add the requested regression coverage through the public entry point using the original task's exact identifiers. Follow the discovered runner convention and immutable write scope. Do not run tests or repeat completed implementation work. If scope prevents the test, report the precise blocker." });
              this.logger.log("agentic_missing_tests_continuation", {
                subtaskId: input.attemptId, model: modelServed,
                changed_paths: changes.map(change => change.path),
              });
              continue;
            }

            return result({
              exitStatus: "completed",
              changedPaths:
                changes.map(
                  (change) => change.path,
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
              discoveryEvidence:
                evidencePacket(),
              discoveryProgress:
                discoveryNotes.length,
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
            discoveryEvidence:
              evidencePacket(),
            discoveryProgress:
              discoveryNotes.length,
          });
        }

        const phaseOutputLimit =
          implementationNudgeSent || mutationObserved
            ? input.maxOutputTokens
            : Math.min(input.maxOutputTokens, 1_200);

        let maxOutput = Math.min(
          phaseOutputLimit,
          tokenRoom,
          creditOutputCap ?? Infinity,
        );

        if (
          input.promptPricePerMillion !== undefined &&
          input.completionPricePerMillion !== undefined
        ) {
          const spent = usages.reduce(
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

          if (availableForOutput <= 0) {
            const changes =
              await currentChanges();

            if (changes.length) {
              return result({
                exitStatus: "completed",
                changedPaths:
                  changes.map(
                    (change) => change.path,
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
                discoveryEvidence:
                  evidencePacket(),
                discoveryProgress:
                  discoveryNotes.length,
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
                "agentic_cost_preflight",
              progressPhase:
                "DISCOVERY",
              steps: step,
              discoveryEvidence:
                evidencePacket(),
              discoveryProgress:
                discoveryNotes.length,
            });
          }

          if (
            input.completionPricePerMillion > 0
          ) {
            maxOutput = Math.min(
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
              exitStatus: "completed",
              changedPaths:
                changes.map(
                  (change) => change.path,
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
              discoveryEvidence:
                evidencePacket(),
              discoveryProgress:
                discoveryNotes.length,
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
            discoveryEvidence:
              evidencePacket(),
            discoveryProgress:
              discoveryNotes.length,
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
            request_timeout_ms: Math.min(input.requestTimeoutMs, input.timeoutMs - (Date.now() - started)),
            max_output_tokens:
              maxOutput,
          },
        );

        if (!supportsParameters(input.modelMetadata ?? {}, ["tools", "tool_choice"])) {
          throw Error("INFRA_FAILURE: coding worker requires an endpoint supporting tools and tool_choice together");
        }
        const remainingWorkerMs = input.timeoutMs - (Date.now() - started);
        if (remainingWorkerMs <= 0) {
          const changes = await currentChanges();
          return result({ exitStatus: changes.length ? "completed" : "infra_failure",
            changedPaths: changes.map((change) => change.path),
            terminationReason: changes.length ? "candidate_ready_for_verification" : "agentic_attempt_timeout",
            limitKind: "timeout", progressPhase: changes.length ? "MUTATION_OBSERVED" : "DISCOVERY", steps: step });
        }
        providerDispatched = true;

        const requestStarted = Date.now();
        let response: AgenticCodingResponse;
        const requestModel = input.autoRouter && modelServed !== AUTO_MODEL ? modelServed : input.model;
        try {
          response = await this.request(
            { ...input, model: requestModel, maxTokens: input.maxTokens - usedTokens, requestTimeoutMs: Math.min(input.requestTimeoutMs, remainingWorkerMs) },
            messages,
            activeTools(),
            maxOutput,
          );
        } catch (error) {
          // A rejected output reservation is not a failed coding attempt.
          // Retry once only when the provider supplies an explicit affordable
          // bound. Preserve model, messages, reads and candidate state.
          const affordable = /\b402\b[\s\S]*can only afford\s+([\d,]+)\b/i.exec(String(error));
          const affordableTokens = affordable ? Number(affordable[1]!.replaceAll(",", "")) : 0;
          if (creditOutputCap === undefined && Number.isSafeInteger(affordableTokens) &&
              affordableTokens >= MIN_NEXT_OUTPUT_TOKENS && affordableTokens < maxOutput &&
              Date.now() - started < input.timeoutMs) {
            creditOutputCap = affordableTokens;
            this.logger.log("agentic_credit_output_retry", {subtaskId: input.attemptId,
              model: requestModel, max_output_tokens: creditOutputCap, classification: "OPERATIONAL_FAILURE"});
            step--;
            continue;
          }
          if (!malformedToolRetryUsed &&
              /\b(?:invalid_tool_(?:arguments|envelope)|malformed tool protocol)\b/i.test(String(error))) {
            malformedToolRetryUsed = true;
            messages.push({ role: "user", content:
              "The provider rejected the previous tool arguments as invalid JSON. Retry with exactly one small tool call and valid JSON arguments. For an existing file, use a concise edit_file or apply_patch change instead of a full-file rewrite. Preserve the task and authorized write scope." });
            this.logger.log("agentic_tool_protocol_retry", {
              subtaskId: input.attemptId,
              reason: "invalid_tool_arguments",
              retained_reads: inspectedFiles.size,
            });
            // The provider rejected this request before returning a worker
            // turn. In a one-step verification repair, charging that failed
            // dispatch would prevent the promised protocol retry entirely.
            step--;
            continue;
          }
          // A dispatched failure has no settled provider receipt. Keep it visible
          // to accounting even when earlier turns have known usage.
          this.logger.log("model_call", {
            subtaskId: input.attemptId, stage: "implement",
            modelRequested: requestModel, modelReturned: modelServed,
            promptTokens: 0, completionTokens: 0, cachedTokens: 0,
            providerReportedCostUsd: null, costUsd: null, costSource: "missing",
            wallClockMs: Date.now() - requestStarted,
            outcome: "OPERATIONAL_FAILURE", error: String(error),
          });
          // The exception originated at provider dispatch, not tool execution.
          this.logger.log("model_error", {
            subtaskId: input.attemptId, stage: "implement",
            modelRequested: input.model, failureOrigin: "provider",
            classification: "OPERATIONAL_FAILURE", error: String(error),
          });
          throw error;
        }

        const previousServedModel = modelServed;
        modelServed =
          response.model ||
          input.model;

        const usage = parseUsage(
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
              requestModel,
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
            providerReportedCostUsd: usage.costUsd,
            costSource: usage.costUsd === null ? "missing" : "provider_reported",
            raw: usage.raw,
            costUsd:
              usage.costUsd,
            wallClockMs:
              Date.now() - requestStarted,
          },
        );

        if (input.autoRouter && (!input.autoRouter.models.includes(modelServed) ||
            (previousServedModel !== AUTO_MODEL && modelServed !== previousServedModel))) {
          const fatalError="provider_protocol_error: Auto omitted, changed or returned an unauthorized concrete model";
          this.logger.log("model_error",{subtaskId:input.attemptId,stage:"implement",failureOrigin:"provider",classification:"OPERATIONAL_FAILURE",error:fatalError});
          return result({exitStatus:"infra_failure",changedPaths:(await currentChanges()).map(change=>change.path),terminationReason:"agentic_provider_error",fatalError});
        }
        const assistant =
          response.message as any;

        messages.push(assistant);

        const calls =
          assistant.tool_calls ?? [];

        if (!calls.length) {
          const changes =
            await currentChanges();

          if (changes.length) {
            mutationObserved = true;
            // Catch the same concrete omission as the executor's completion gate
            // while the worker still owns its reads, model pin and transcript.
            // One reminder only: budget/deadline exhaustion still hands back the
            // inspectable candidate for authoritative verification and recovery.
            if (!returnAfterMutation && !missingTestsNudgeSent &&
                requestsTestMutation(input.task) &&
                !changes.some(change => isTestPath(change.path) &&
                  (!testGlobs.length || matchesDiscoveredTestGlob(change.path, testGlobs)))) {
              missingTestsNudgeSent = true;
              messages.push({ role: "user", content:
                "The requested test mutation is missing. Continue in this session: read the relevant existing test if necessary, then add the requested regression coverage through the public entry point using the original task's exact identifiers. Follow the discovered runner convention and immutable write scope. Do not run tests or repeat completed implementation work. If scope prevents the test, report the precise blocker." });
              this.logger.log("agentic_missing_tests_continuation", {
                subtaskId: input.attemptId, model: modelServed,
                changed_paths: changes.map(change => change.path),
              });
              continue;
            }

            return result({
              exitStatus: "completed",
              changedPaths:
                changes.map(
                  (change) => change.path,
                ),
              terminationReason:
                "agentic_completed",
              progressPhase:
                "MUTATION_OBSERVED",
              steps: step + 1,
              discoveryEvidence:
                evidencePacket(),
              discoveryProgress:
                discoveryNotes.length,
            });
          }

          if (++consecutiveTextTurns >= 2) {
            return result({ exitStatus: "failed", changedPaths: [], terminationReason: "agentic_no_tool_progress",
              progressPhase: "DISCOVERY", steps: step + 1, discoveryEvidence: evidencePacket(),
              discoveryProgress: tools.progressEvidence.length });
          }
          const nudge =
            "No tool action or mutation was made. Your next response must call a repository tool: read the missing relevant code or implement the justified change. Prose cannot complete this task.";

          const last =
            messages.at(-1) as {
              role?: string;
              content?: unknown;
            } | undefined;

          if (
            last?.role !== "user" ||
            last.content !== nudge
          ) {
            messages.push({
              role: "user",
              content: nudge,
            });
          }

          continue;
        }

        consecutiveTextTurns = 0;
        let repairMutationAttempted = false;
        for (
          let callIndex = 0;
          callIndex < calls.length;
          callIndex++
        ) {
          const call = calls[callIndex]!;
          let content: string;
          let parsedArgs: Record<string, unknown> = {};
          let discoveryDeferred = false;

          if (callIndex >= MAX_TOOL_CALLS_PER_TURN) {
            content =
              "Tool call skipped by Koda because this provider turn exceeded the per-turn tool-call bound. Request the tool again on the next turn if it is still needed.";
          } else {
            try {
              parsedArgs = JSON.parse(
                call.function.arguments,
              );

              const mutationPaths = MUTATION_TOOLS.has(call.function.name)
                ? call.function.name === "apply_patch"
                  ? (Array.isArray(parsedArgs.edits) ? parsedArgs.edits.map((edit: { path?: string }) => String(edit.path ?? "")) : [])
                  : [String(parsedArgs.path ?? "")]
                : [];
              if (input.context?.completionRepair && mutationPaths.length)
                repairMutationAttempted = true;
              const unreadExistingMutation = mutationPaths.length > 0 &&
                (await Promise.all(mutationPaths.filter((path) => !inspectedFiles.has(path) &&
                  !input.context?.sourceFiles?.some((file) => file.path === path && file.snippet.trim()))
                  .map(async (path) => {
                  try { return (await lstat(await safePath(input.repoPath, path))).isFile(); }
                  catch { return false; }
                }))).some(Boolean);
              const repairToolGate =
                !!input.context?.completionRepair?.mutationRequiredBeforeDiscovery &&
                hasRead() &&
                (!mutationObserved || repairDiscoverySinceMutation >= 2);
              if (
                repairToolGate &&
                !MUTATION_TOOLS.has(call.function.name)
              ) {
                discoveryDeferred = true;
                content =
                  "Completion repair is mutation-gated. Use apply_patch, edit_file, or write_file before any read, search, listing, outline, command, or diff tool.";
                this.logger.log("completion_repair_tool_deferred", {
                  subtaskId: input.attemptId,
                  tool: call.function.name,
                });
              } else if (localizedRecovery && !mutationObserved &&
                DISCOVERY_TOOLS.has(call.function.name) &&
                (!LOCALIZED_READ_TOOLS.has(call.function.name) ||
                  !recoveryReadPaths.has(String(parsedArgs.path)) ||
                  recoveryReads() >= recoveryReadLimit)) {
                discoveryDeferred = true;
                content = "Localization is retained. Read only a precise supplied path/range or mutate the authorized scope; broad rediscovery is unnecessary.";
              } else if (
                !localizedRecovery && !mutationObserved &&
                DISCOVERY_TOOLS.has(call.function.name) &&
                hasTargetRead() &&
                !groundedRead(call.function.name, parsedArgs) &&
                tools.progressEvidence.length >=
                  MAX_USEFUL_DISCOVERY_BEFORE_MUTATION
              ) {
                discoveryDeferred = true;
                content =
                  "Discovery phase complete: Koda already has two useful repository observations and no mutation. Use edit_file, apply_patch, or write_file now. A later verification failure can provide concrete evidence for a bounded repair.";
                this.logger.log(
                  "agentic_discovery_call_deferred",
                  {
                    subtaskId: input.attemptId,
                    tool: call.function.name,
                    useful_discovery_steps:
                      tools.progressEvidence.length,
                  },
                );
              } else if (call.function.name === "run_command" &&
                (!/^\s*(?:rg|grep|find|cat|head|tail|ls|pwd|sed\s+-n|git\s+(?:diff|status|log|show))\b/.test(String(parsedArgs.command)) ||
                  /[;&|><`$\r\n]/.test(String(parsedArgs.command)))) {
                content = "Tool error: coding workers only inspect repository files; Koda owns deterministic verification.";
              } else if (unreadExistingMutation) {
                content = "Tool error: read the relevant existing file before mutating it. Search results alone are not implementation evidence.";
              } else if (MUTATION_TOOLS.has(call.function.name) && testGlobs.length &&
                mutationPaths.some((path) =>
                    isTestPath(path) && !matchesDiscoveredTestGlob(path, testGlobs))) {
                content = `Tool error: test path must match the discovered runner globs: ${testGlobs.join(", ")}`;
              } else {
                content = String(
                  await tools.execute(
                    call.function.name,
                    parsedArgs,
                  ),
                );
                if (call.function.name === "read_file" &&
                  tools.progressEvidence.some((key) => key.startsWith(`read_file:${String(parsedArgs.path)}:`))) {
                  inspectedFiles.set(String(parsedArgs.path), content);
                }
                if (
                  input.context?.completionRepair &&
                  mutationObserved &&
                  !MUTATION_TOOLS.has(call.function.name)
                ) repairDiscoverySinceMutation++;
                if (
                  input.context?.completionRepair &&
                  MUTATION_TOOLS.has(call.function.name) &&
                  !/^Tool error:/i.test(content)
                ) {
                  repairDiscoverySinceMutation = 0;
                }
              }
            } catch (error) {
              content =
                `Tool error: ${String(error)}`;
            }
          }

          const note = discoveryDeferred
            ? undefined
            : discoveryNote(
                call.function.name,
                parsedArgs,
                content,
              );

          if (note) {
            discoveryNotes.push(note);

            while (
              discoveryNotes.length > 1 &&
              Buffer.byteLength(
                discoveryNotes.join("\n"),
              ) > DISCOVERY_EVIDENCE_BYTES
            ) {
              discoveryNotes.shift();
            }
          }

          // Stop within the batch: a queued command must never run after the edit.
          if (returnAfterMutation && MUTATION_TOOLS.has(call.function.name) && !/^Tool error:/i.test(content)) {
            const changes = await currentChanges();
            if (changes.length) {
              timeToFirstMutationMs ??= Date.now() - started;
              return result({ exitStatus: "completed", changedPaths: changes.map((change) => change.path),
                terminationReason: "candidate_ready_for_verification", progressPhase: "MUTATION_OBSERVED",
                steps: step + 1, discoveryEvidence: evidencePacket(), discoveryProgress: discoveryNotes.length });
            }
          }
          if (MUTATION_TOOLS.has(call.function.name) && !/^Tool error:/i.test(content) &&
              await fullBoundedScopeChanged()) {
            const changes = await currentChanges();
            timeToFirstMutationMs ??= Date.now() - started;
            return result({ exitStatus: "completed", changedPaths: changes.map((change) => change.path),
              terminationReason: "candidate_ready_for_verification", progressPhase: "MUTATION_OBSERVED",
              steps: step + 1, discoveryEvidence: evidencePacket(), discoveryProgress: discoveryNotes.length });
          }
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content,
          } as any);
        }

        const changes =
          await currentChanges();

        if (input.context?.completionRepair && repairMutationAttempted && !changes.length) {
          return result({
            exitStatus: "failed",
            changedPaths: [],
            terminationReason: "repair_produced_no_mutation",
            progressPhase: "MUTATION_OBSERVED",
            steps: step + 1,
            discoveryEvidence: evidencePacket(),
            discoveryProgress: discoveryNotes.length,
          });
        }

        if (changes.length) {
          if (!mutationObserved) {
            timeToFirstMutationMs =
              Date.now() - started;
          }

          mutationObserved = true;

          if (returnAfterMutation) {
            return result({
              exitStatus: "completed",
              changedPaths:
                changes.map(
                  (change) => change.path,
                ),
              terminationReason:
                "candidate_ready_for_verification",
              progressPhase:
                "MUTATION_OBSERVED",
              steps: step + 1,
              discoveryEvidence:
                evidencePacket(),
              discoveryProgress:
                discoveryNotes.length,
            });
          }
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
            (change) => change.path,
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
        discoveryEvidence:
          evidencePacket(),
        discoveryProgress:
          discoveryNotes.length,
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

      const knownUsage = aggregateUsage(usages, input);
      return {
        // Preserve known receipts even when the failed request has unknown
        // usage. Cost remains unknown; never turn partial accounting into $0.
        ...(usages.length ? {
          inputTokens: knownUsage.promptTokens,
          outputTokens: knownUsage.completionTokens,
          cachedInputTokens: knownUsage.cachedTokens,
          cacheWriteTokens: knownUsage.cacheWriteTokens,
          consumedTokens: knownUsage.promptTokens + knownUsage.completionTokens,
          remainingTokens: Math.max(0, input.maxTokens - knownUsage.promptTokens - knownUsage.completionTokens),
        } : {}),
        timeToFirstMutationMs,
        exitStatus: "infra_failure",
        model: modelServed,
        engine: "agentic",
        engineVersion:
          AGENTIC_CODING_VERSION,
        changedPaths:
          changes.map(
            (change) => change.path,
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
        discoveryEvidence:
          evidencePacket(),
        discoveryProgress:
          discoveryNotes.length,
      };
    }
  }
}

import { z } from "zod";
import { posix } from "node:path";
import { lstat, readFile, realpath } from "node:fs/promises";

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import type { Gateway } from "../openrouter/client.js";
import { canFallback } from "../openrouter/client.js";

import type { Candidate } from "../router/modelRouter.js";
import type { RepoProfile } from "../types.js";
import type { Subtask } from "../planner/schemas.js";
import { evidenceSchema } from "../planner/schemas.js";

import type { WorkerContext } from "../context/compiler.js";
import { compactProfile, isTestPath, resolveImports } from "../context/compiler.js";
import { boundMessages } from "../context/bounds.js";

import { extractFeatures } from "../router/features.js";
import { WriteScope } from "../repo/writeScope.js";

import { AgentTools, currentDiff, safePath, toolDefinitions } from "./tools.js";
import { stableInspectionPrompt } from "./prompts.js";

const actionableText = z
  .string()
  .trim()
  .min(8)
  .refine((value) => !/^(?:none|unknown|no issue|not found)\b/i.test(value));

const declarationSchema = z.object({
  issue: actionableText,

  writePaths: z.array(z.string()).min(1).max(6),

  evidence: evidenceSchema.superRefine((evidence, context) => {
    if (!evidence.relevantFiles.length || !evidence.evidence.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Actionable inspection requires file-specific evidence",
      });
    }
  }),

  requiredChange: actionableText,

  regressionTest: actionableText,

  relevantDetails: z.array(z.string()).optional(),
});

const scopeProposalSchema = z.object({
  paths: z.array(z.string()).min(1).max(6),
  reason: z.string().trim().min(8).max(500),
});

export type StableImplementationHandoff = z.infer<typeof declarationSchema>;

class StableDeclarationError extends Error {}
class StableScopeTimeoutError extends Error {}

/**
 * Legacy parser kept for compatibility with existing tests.
 *
 * Live Stable inspection does NOT depend on free-form model JSON anymore.
 * The live transition is lock_write_scope.
 */
export function extractStableDeclaration(text: string) {
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "{") continue;

    let depth = 0;
    let quoted = false;
    let escaped = false;

    for (let end = start; end < text.length; end++) {
      const character = text[end]!;

      if (quoted) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          quoted = false;
        }

        continue;
      }

      if (character === '"') {
        quoted = true;
        continue;
      }

      if (character === "{") {
        depth++;
        continue;
      }

      if (character === "}" && --depth === 0) {
        try {
          const parsed = declarationSchema.safeParse(
            JSON.parse(text.slice(start, end + 1)),
          );

          if (parsed.success) {
            return parsed.data;
          }
        } catch {
          // Continue looking for another schema-valid object.
        }

        break;
      }
    }
  }

  throw new StableDeclarationError(
    "Stable inspection returned no valid declaration",
  );
}

/**
 * Stable's control-plane tool.
 *
 * This tool does not mutate the repository. It finalizes the read-only
 * inspection and declares the immutable write scope for implementation.
 */
const lockWriteScopeTool = {
  type: "function",
  function: {
    name: "lock_write_scope",

    description:
      "Propose only the minimal exact write paths and a concise reason. Runtime validates against its own inspection evidence.",

    parameters: {
      type: "object",

      additionalProperties: false,

      properties: {
        paths: {
          type: "array",
          minItems: 1,
          maxItems: 6,

          items: {
            type: "string",
          },

          description:
            "Exact repository-relative files required to implement the fix and regression test.",
        },

        reason: { type: "string", description: "One short sentence explaining the proposed scope." },
      },

      required: ["paths", "reason"],
    },
  },
} as const;

const reportNoScopeTool = {
  type: "function",
  function: {
    name: "report_no_scope",
    description: "Finish inspection without a write scope when no actionable, evidence-backed change can be identified.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { reason: { type: "string" } },
      required: ["reason"],
    },
  },
} as const;

export async function prepareStableWorker(
  gateway: Gateway,
  path: string,
  task: string,
  subtask: Subtask,
  profile: RepoProfile,
  context: WorkerContext,
) {
  const pool = gateway.modelRouter;

  const features = extractFeatures(
    subtask,
    profile,
    Buffer.byteLength(JSON.stringify(context)),
    undefined,
    "stable",
  );

  let selected: Candidate | undefined = pool
    ? await pool.select(features, subtask.id)
    : undefined;

  let model = selected?.model.id ?? gateway.config.registry.CHEAP_CODER_A;

  const excluded: string[] = [];

  /**
   * Inspection tools are instantiated in read-only mode.
   *
   * Even if a model tries to invoke a mutation tool during inspection,
   * AgentTools remains the enforcement boundary.
   */
  const tools = new AgentTools(
    path,
    true,
    () =>
      Math.min(gateway.config.commandTimeoutMs, gateway.budget.remainingMs()),
    gateway.logger,
    subtask.id,
    gateway.config.context.toolResultBytes,
  );

  const before = await currentDiff(path);
  const inspectedText = new Map<string, string>();

  /**
   * Normal inspection:
   * repository tools + the control-plane transition.
   */
  const inspectionTools = [
    ...toolDefinitions.filter((tool) =>
      tool.type === "function" &&
      !["write_file", "edit_file"].includes(tool.function.name)),
    lockWriteScopeTool,
    reportNoScopeTool,
  ] as any;

  /**
   * Finalization:
   * absolutely no more repository exploration.
   *
   * The model either calls lock_write_scope based on evidence it already
   * gathered or Stable fails closed.
   */
  const finalizationTools = [lockWriteScopeTool, reportNoScopeTool] as any;

  const messages: ChatCompletionMessageParam[] = [
    {
      role: "system",

      content: `${stableInspectionPrompt}

STABLE MODE CONTROL PROTOCOL

You are currently in a READ-ONLY inspection phase.

Your goal is to find ONE small, real, actionable issue supported by concrete repository evidence.

You have at most THREE normal inspection turns before Koda enters mandatory finalization.

During normal inspection:
- use repository read/search tools only when necessary
- gather concrete file-specific evidence
- do not rediscover information already present in context
- do not mutate the repository

As soon as you have enough evidence for one real issue, call lock_write_scope.

Do NOT return the implementation handoff as ordinary text.
Do NOT return the implementation handoff as free-form JSON.

lock_write_scope is the control-plane transition from inspection to implementation.

Its paths must contain only the exact repository-relative files needed for:
1. the smallest implementation fix
2. the focused regression test

Do not declare directories.
Do not declare speculative files.
Do not expand the scope after it is locked.

If there is genuinely not enough evidence for a real issue, call report_no_scope with a concrete reason.`,
    },

    {
      role: "user",

      content: JSON.stringify({
        task,

        allowed_write_paths: [],

        profile: compactProfile(profile),

        context,
      }),
    },
  ];

  gateway.logger.log("worker_scope", {
    subtaskId: subtask.id,

    phase: "inspection",

    read_only: true,

    allowed_write_paths: [],

    context_files: context.files.map((file) => file.path),
  });

  gateway.logger.log("stable_worker_start", {
    subtaskId: subtask.id,

    model,

    worktree: path,
  });

  /**
   * One model turn.
   *
   * `availableTools` is deliberately passed per phase so finalization can
   * remove read/search tools entirely.
   */
  const call = async (
    iteration: number,
    availableTools: any,
    finalization = false,
    requestMessages: ChatCompletionMessageParam[] = messages,
    deadline?: number,
  ) => {
    while (true) {
      const since = gateway.logger.events.length;

      try {
        const remaining = deadline === undefined ? 30000 : deadline - Date.now();
        if (remaining <= 0) throw new StableScopeTimeoutError("Stable scope finalization timed out");
        const request = gateway.call(
          model,

          boundMessages(requestMessages, gateway.config.context.maxPromptBytes),

          subtask.id,

          "inspect",

          iteration,

          availableTools,

          {
            maxOutputTokens: finalization ? 900 : 1800,
            timeoutMs: Math.min(remaining, finalization ? 10000 : 30000),
            ...(finalization ? { requireTool: true } : {}),
          },
        );
        if (deadline === undefined) return await request;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            request,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new StableScopeTimeoutError("Stable scope finalization timed out")), remaining);
            }),
          ]);
        } finally { if (timer) clearTimeout(timer); }
      } catch (error) {
        if (error instanceof StableScopeTimeoutError) throw error;
        if (
          !pool ||
          !selected ||
          !canFallback(error, gateway) ||
          gateway.config.forceModel
        ) {
          throw error;
        }

        // Provider/protocol failure is infrastructure telemetry, not verified
        // task-quality evidence. Keep it out of specialist history.
        gateway.logger.log("model_attempt", {
          subtaskId: subtask.id,
          modelRequested: selected.model.id,
          modelServed: null,
          verification: "FAILED",
          escalated: true,
          reason: `stable inspection infrastructure fallback: ${String(error)}`,
        });

        const previous = selected.model;

        excluded.push(previous.id);

        pool.disabled.add(previous.id);

        selected = await pool.select(
          features,
          subtask.id,
          excluded,
          previous,
          true,
        );

        model = selected.model.id;

        gateway.logger.log("model_fallback", {
          subtaskId: subtask.id,

          previous_model: previous.id,

          selected_model: model,

          reason: String(error),

          phase: "stable_inspection",
        });
      }
    }
  };

  /**
   * Validate and freeze the Stable implementation handoff.
   */
  const known = new Set(profile.files);
  const inspected = new Set<string>();
  const searchHits = new Set<string>();
  const significantTerms = (task.toLowerCase().match(/[a-z]{3,}/g) ?? [])
    .filter((term) => !/^(?:the|and|for|that|with|when|from|new|add|keep|about|after|before|check|files|small|tests|there|these|using|would|write|focus|focused|change|changes|issue|implementation|regression|please|should)$/.test(term));
  const explicitlyNamed = (file: string) =>
    task.includes(file) || subtask.likelyReadPaths.includes(file) &&
      task.toLowerCase().includes(posix.basename(file).replace(/\.[^.]+$/, "").toLowerCase());
  const sourceText = (file: string) =>
    `${context.files.find((entry) => entry.path === file)?.snippet ?? ""}\n${inspectedText.get(file) ?? ""}`;
  const imports = (file: string) => resolveImports(file, sourceText(file), known);
  const sourceRelevant = (file: string) => {
    if (explicitlyNamed(file)) return true;
    if (!inspected.has(file) && !searchHits.has(file)) return false;
    const text = sourceText(file).toLowerCase();
    const fileName = posix.basename(file).toLowerCase().replace(/\.[^.]+$/, "");
    return significantTerms.some((term) => fileName.includes(term)) ||
      significantTerms.filter((term) => text.includes(term)).length >= 2;
  };
  const trustedSources = () => {
    const trusted = new Set(profile.files.filter((file) => !isTestPath(file) && explicitlyNamed(file)));
    for (const file of inspected) {
      if (!isTestPath(file) && known.has(file) && sourceRelevant(file)) trusted.add(file);
    }
    // Only inspected files connected to an already relevant implementation
    // file can be added through local imports. Mere reading is insufficient.
    let changed = true;
    while (changed) {
      changed = false;
      for (const file of inspected) {
        if (isTestPath(file) || trusted.has(file) || !known.has(file)) continue;
        if ([...trusted].some((source) => imports(source).includes(file) || imports(file).includes(source))) {
          trusted.add(file);
          changed = true;
        }
      }
    }
    return trusted;
  };
  const matchingTest = async (file: string, sources: Set<string>) => {
    if (!isTestPath(file) || !known.has(file)) return false;
    if (explicitlyNamed(file)) return true;
    for (const source of sources) {
      const stem = posix.basename(source).replace(/\.[^.]+$/, "").toLowerCase();
      const name = posix.basename(file).toLowerCase();
      if (name.startsWith(`${stem}.`) || name.startsWith(`${stem}_`)) return true;
    }
    // A test importing one of the authorized sources is also focused.
    try {
      const contents = await readFile(await safePath(path, file), "utf8");
      return resolveImports(file, contents.slice(0, 32000), known)
        .some((source) => sources.has(source));
    } catch { return false; }
  };
  const safeExistingFile = async (file: string) => {
    try {
      const target = await safePath(path, file);
      const info = await lstat(target);
      return info.isFile() && info.nlink === 1 && await realpath(target) === target;
    } catch { return false; }
  };
  const deterministicScope = async () => {
    if (!tools.progressEvidence.length || /\b(?:inspect|discover|find)\b/i.test(task) ||
        !/\b(?:test|tests|regression)\b/i.test(task))
      return undefined;
    const explicit = [...inspected].filter((file) => !isTestPath(file) && explicitlyNamed(file));
    const anchors = explicit.length ? explicit : [...inspected].filter((file) => {
      if (isTestPath(file)) return false;
      const stem = posix.basename(file).replace(/\.[^.]+$/, "").toLowerCase();
      return significantTerms.some((term) => term === stem);
    });
    if (!anchors.length || anchors.length > 2) return undefined;
    const sources = new Set(anchors);
    // One inspected, directly imported implementation neighbor may be needed
    // for feature plumbing. Never traverse the whole dependency graph.
    for (const anchor of anchors) {
      const neighbors = imports(anchor).filter((file) => inspected.has(file) && !isTestPath(file));
      if (neighbors.length === 1) sources.add(neighbors[0]!);
      else if (neighbors.length > 1) return undefined;
    }
    if (sources.size > 3)
      return undefined;
    const tests: string[] = [];
    if (/\b(?:test|tests|regression)\b/i.test(task)) {
      const candidates = profile.files.filter(isTestPath);
      for (const file of candidates) {
        if (!await safeExistingFile(file) || !await matchingTest(file, sources)) continue;
        const text = (await readFile(await safePath(path, file), "utf8")).slice(0, 32000).toLowerCase();
        const name = posix.basename(file).toLowerCase();
        const score = [...sources].reduce((n, source) => {
          const stem = posix.basename(source).replace(/\.[^.]+$/, "").toLowerCase();
          return n + (name.startsWith(`${stem}.`) ? 4 : 0) + (resolveImports(file, text, known).includes(source) ? 2 : 0);
        }, 0) + significantTerms.filter((term) => name.includes(term) || text.includes(term)).length;
        tests.push(`${String(score).padStart(3, "0")}:${file}`);
      }
      tests.sort().reverse();
      if (!tests.length || (tests.length > 1 && tests[0]!.slice(0, 3) === tests[1]!.slice(0, 3)))
        return undefined;
    }
    const paths = [...sources, ...tests.slice(0, 1).map((entry) => entry.slice(4))];
    if (paths.length > 6 || !(await Promise.all(paths.map(safeExistingFile))).every(Boolean)) return undefined;
    return paths;
  };
  const scopeSummary = async () => {
    const sources = trustedSources();
    const testCandidates: string[] = [];
    for (const file of profile.files.filter(isTestPath).slice(0, 100))
      if (await matchingTest(file, sources)) testCandidates.push(file);
    return {
      task: task.slice(0, 1200),
      inspectedFiles: [...inspected].filter((file) => known.has(file)),
      relevantSources: [...sources],
      importLinks: [...inspected].flatMap((file) => imports(file)
        .filter((dependency) => inspected.has(dependency))
        .map((dependency) => [file, dependency])),
      testCandidates: testCandidates.slice(0, 12),
    };
  };
  const acceptLock = async (rawArguments: string, deterministic = false) => {
    let raw: unknown;
    try { raw = JSON.parse(rawArguments); }
    catch { throw new StableDeclarationError("lock_write_scope arguments were not valid JSON"); }
    const parsed = scopeProposalSchema.safeParse(raw);
    if (!parsed.success)
      throw new StableDeclarationError(`Invalid lock_write_scope arguments: ${parsed.error.message}`);
    const proposal = parsed.data;
    if (!tools.progressEvidence.length)
      throw new StableDeclarationError("Stable inspection produced no repository evidence");
    if (new Set(proposal.paths).size !== proposal.paths.length ||
        proposal.paths.some((file) => !known.has(file) || file === "." || file.endsWith("/")))
      throw new StableDeclarationError("Write scope requires distinct existing repository files");
    const sources = trustedSources();
    for (const file of proposal.paths) {
      if (!await safeExistingFile(file))
        throw new StableDeclarationError(`Unsafe or missing write path: ${file}`);
      const allowed = isTestPath(file)
        ? await matchingTest(file, sources)
        : sources.has(file);
      if (!allowed)
        throw new StableDeclarationError(`Write path lacks trusted task-specific evidence: ${file}`);
    }
    if ((await currentDiff(path)) !== before)
      throw Error("Stable read-only inspection mutated the workspace");
    const scope = new WriteScope(proposal.paths, gateway.logger, subtask.id);
    const evidence = evidenceSchema.parse({
      relevantFiles: [...new Set([...inspected, ...scope.paths])],
      symbols: [],
      reproduction: `Inspection of ${[...inspected].join(", ")}`,
      failingTests: [],
      likelyRootCause: proposal.reason,
      dependencies: [...inspected].flatMap(imports).filter((file) => known.has(file)),
      uncertainty: "low",
      suggestedApproach: task,
      evidence: [...inspected].map((file) => `Read ${file} during Stable inspection`),
    });
    const handoff = declarationSchema.parse({
      issue: proposal.reason,
      writePaths: [...scope.paths],
      evidence,
      requiredChange: `Implement the inspected finding (${proposal.reason}) for task: ${task}`,
      regressionTest: `Prove the requested behavior with focused tests for ${task}`,
    });
    gateway.logger.log("stable_scope_locked", {
      subtaskId: subtask.id, allowed_write_paths: scope.paths, deterministic,
    });
    return { writePaths: [...scope.paths], evidence, handoff, selected, model };
  };
  let lastScopeError = "";

  /**
   * Process one assistant turn.
   *
   * Returns the finalized handoff if lock_write_scope succeeds.
   * Otherwise returns undefined and inspection/finalization continues.
   */
  const processMessage = async (
    message: any,
    allowRepositoryTools: boolean,
  ) => {
    const boundedCalls = message.tool_calls?.slice(0, 4) ?? [];

    /**
     * Text-only output never completes Stable.
     *
     * We retain it in conversation history so the model can use whatever
     * reasoning it already surfaced, but runtime state does not transition.
     */
    if (!boundedCalls.length) {
      messages.push(message);

      return undefined;
    }

    messages.push({
      ...message,

      tool_calls: boundedCalls,
    });

    for (const raw of boundedCalls) {
      const toolCall = raw as any;

      if (toolCall.function.name === "report_no_scope") {
        const parsed = z.object({ reason: z.string().trim().min(8).max(500) })
          .safeParse((() => { try { return JSON.parse(toolCall.function.arguments); } catch { return null; } })());
        if (parsed.success) {
          if ((await currentDiff(path)) !== before)
            throw Error("Stable read-only inspection mutated the workspace");
          gateway.logger.log("stable_non_actionable", {
            subtaskId: subtask.id, reason: parsed.data.reason,
          });
          throw Error(`Stable inspection found no actionable scope: ${parsed.data.reason}`);
        }
        messages.push({ role: "tool", tool_call_id: toolCall.id,
          content: "report_no_scope rejected: provide a concrete reason (8-500 characters)." });
        continue;
      }

      /**
       * lock_write_scope is handled by Stable itself.
       *
       * It is not delegated to AgentTools because it is a control-plane
       * transition rather than a filesystem tool.
       */
      if (toolCall.function.name === "lock_write_scope") {
        try {
          return await acceptLock(toolCall.function.arguments);
        } catch (error) {
          if (!(error instanceof StableDeclarationError)) {
            throw error;
          }

          gateway.logger.log("stable_scope_rejected", {
            subtaskId: subtask.id,

            reason: error.message,
          });
          lastScopeError = error.message;

          messages.push({
            role: "tool",

            tool_call_id: toolCall.id,

            content:
              `lock_write_scope rejected: ${error.message}. ` +
              "Correct the declaration using repository evidence already gathered.",
          });

          continue;
        }
      }

      /**
       * Once finalization begins, repository inspection is over.
       *
       * A provider/mock that emits a non-control tool despite not being
       * offered one is rejected rather than executed.
       */
      if (!allowRepositoryTools) {
        gateway.logger.log("stable_finalization_tool_rejected", {
          subtaskId: subtask.id,

          tool: toolCall.function.name,
        });

        messages.push({
          role: "tool",

          tool_call_id: toolCall.id,

          content:
            "Repository inspection is closed. Use lock_write_scope or report_no_scope.",
        });

        continue;
      }

      let content: string;

      try {
        content = await tools.execute(
          toolCall.function.name,

          JSON.parse(toolCall.function.arguments),
        );
        if (toolCall.function.name === "read_file" && typeof JSON.parse(toolCall.function.arguments).path === "string") {
          const file = JSON.parse(toolCall.function.arguments).path as string;
          inspectedText.set(file, `${inspectedText.get(file) ?? ""}\n${content}`);
          if (tools.progressEvidence.some((item) => item.startsWith(`read_file:${file}:`)))
            inspected.add(file);
        }
        if (toolCall.function.name === "search_code" && content.trim()) {
          for (const match of content.matchAll(/^([^:\n]+):\d+:/gm))
            if (known.has(match[1]!)) searchHits.add(match[1]!);
        }
      } catch (error) {
        content = `Tool error: ${String(error)}`;

        gateway.logger.log("tool_error", {
          subtaskId: subtask.id,

          error: content,
        });
      }

      messages.push({
        role: "tool",

        tool_call_id: toolCall.id,

        content,
      });
    }

    /**
     * Re-check the workspace after every inspection tool batch.
     */
    if ((await currentDiff(path)) !== before) {
      throw Error("Stable read-only inspection mutated the workspace");
    }

    return undefined;
  };

  try {
    /**
     * ---------------------------------------------------------
     * PHASE 1 — BOUNDED REPOSITORY INSPECTION
     * ---------------------------------------------------------
     *
   * At most three normal inspection opportunities; finish sooner when the
   * named files have supplied enough evidence for a scope decision.
     *
     * Critically, we do NOT let the model consume the fourth and final
     * turn doing another read/search operation.
     */
    for (let iteration = 0; iteration < 3; iteration++) {
      const message = await call(iteration, inspectionTools);

      const prepared = await processMessage(message, true);

      if (prepared) {
        return prepared;
      }

      const relevant = subtask.likelyReadPaths.filter((file) => profile.files.includes(file));
      if (new Set(tools.progressEvidence).size &&
          (relevant.length ? relevant.every((file) => inspected.has(file)) :
            new Set(tools.progressEvidence).size >= 2)) break;

      /**
       * If the model emitted plain text, remind it that text does not
       * transition Stable state.
       *
       * If it used repository tools, their results are already in messages
       * and the next turn naturally continues from that evidence.
       */
      if (!message.tool_calls?.length) {
        messages.push({
          role: "user",

          content:
            "Stable inspection is not completed by text. If you already have enough concrete evidence, call lock_write_scope now. Otherwise use the remaining inspection budget efficiently.",
        });
      }
    }

    /**
     * ---------------------------------------------------------
     * PHASE 2 — MANDATORY FINALIZATION
     * ---------------------------------------------------------
     *
     * Finalization and its single correction expose only control tools.
     * Neither turn can spend its budget on another repository inspection.
     */
    const deterministic = await deterministicScope();
    if (deterministic) {
      return acceptLock(JSON.stringify({
        paths: deterministic,
        reason: `Implement the requested change in ${deterministic.join(", ")}`,
      }), true);
    }
    gateway.logger.log("stable_finalization_start", {
      subtaskId: subtask.id, model, evidence_count: tools.progressEvidence.length,
    });
    const summary = await scopeSummary();
    const scopeDeadline = Date.now() + Math.min(10000, gateway.config.commandTimeoutMs);
    const compatible = (candidate: Candidate | undefined) =>
      candidate?.model.strengths.includes("tool_use") &&
      candidate.metadata.supportedParameters?.includes("tools") &&
      candidate.metadata.supportedParameters?.includes("tool_choice");
    if (pool) {
      while (!compatible(selected)) {
        if (gateway.config.forceModel || !selected)
          throw Error("No verified tool-compatible model for Stable scope finalization");
        const previous = selected.model;
        excluded.push(previous.id);
        try {
          selected = await pool.select(features, subtask.id, excluded, previous, true);
        } catch {
          throw Error("No verified tool-compatible model for Stable scope finalization");
        }
        model = selected.model.id;
      }
    }
    const finalMessages: ChatCompletionMessageParam[] = [
      { role: "system", content: "Stable scope decision. Call lock_write_scope({paths, reason}) or report_no_scope({reason}). Choose the minimum justified existing files. No repository tools or EvidencePacket." },
      { role: "user", content: JSON.stringify(summary) },
    ];
    const finalMessage = await call(3, finalizationTools, true, finalMessages, scopeDeadline);

    const prepared = await processMessage(finalMessage, false);

    if (prepared) {
      return prepared;
    }

    finalMessages.push({
      role: "user",
      content: `Lock the minimal write scope now using lock_write_scope, based only on the evidence already collected. Do not reread the repository. ${lastScopeError ? `Previous proposal was rejected: ${lastScopeError}.` : "Previous response did not lock a scope."} If no actionable scope is justified, call report_no_scope. This is the only correction turn.`,
    });
    const corrected = await processMessage(await call(4, finalizationTools, true, finalMessages, scopeDeadline), false);
    if (corrected) return corrected;

    /**
     * No valid control transition happened.
     *
     * Fail closed. We never invent a scope on the model's behalf.
     */
    if ((await currentDiff(path)) !== before) {
      throw Error("Stable read-only inspection mutated the workspace");
    }

    throw Error(
      "Stable inspection exhausted its bounded budget without locking a write scope",
    );
  } finally {
    gateway.logger.log("stable_worker_stop", {
      subtaskId: subtask.id,

      worktree: path,
    });
  }
}

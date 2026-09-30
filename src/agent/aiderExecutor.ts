import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { execa } from "execa";

import type { Budget } from "../openrouter/usage.js";
import type { Usage } from "../types.js";
import type { Logger } from "../telemetry/logger.js";
import type { CommandResult } from "../types.js";

import { command } from "../repo/commands.js";
import { WriteScope, scopedCommand } from "../repo/writeScope.js";

import { AttemptCheckpoint } from "./attemptCheckpoint.js";
import type {
  CodingWorker,
  CodingWorkerInput,
  CodingWorkerResult,
} from "./codingWorker.js";
import { ensureAiderRuntime } from "./aiderRuntime.js";

export type AiderEditFormat = "native" | "diff" | "whole";

export interface AiderInvocation {
  binary: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  model: string;
  editFormat: AiderEditFormat;
  reportPath: string;
  ledgerPath: string;
}

export interface AiderExecutorOptions {
  ensureRuntime?: () => Promise<string>;
  runner?: (
    cwd: string,
    invocation: AiderInvocation,
    timeoutMs: number,
  ) => Promise<CommandResult>;
}

const shellQuote = (value: string) =>
  `'${value.replaceAll("'", `'\\''`)}'`;

const bridgePath = fileURLToPath(
  new URL("../../workers/aider/bridge.py", import.meta.url),
);

const MAX_AIDER_EDITABLE_FILES = 8;
const MAX_AIDER_READ_ONLY_FILES = 8;

function normalizeAiderPath(value: string): string | undefined {
  const path = value.trim().replaceAll("\\", "/");
  if (!path || path === "." || path.includes("\0") || path.startsWith("/") || /^[A-Za-z]:\//.test(path)) return undefined;
  const parts = path.split("/").filter((part) => part && part !== ".");
  if (!parts.length || parts.some((part) => part === "..") || parts[0] === ".git") return undefined;
  return parts.join("/");
}

function isTestPath(path: string) {
  return /(?:^|\/)(?:tests?|__tests__)(?:\/|$)/i.test(path) || /\.(?:test|spec)\.[^/]+$/i.test(path);
}

function explicitlyScoped(path: string, writeScope: readonly string[]) {
  return writeScope.some((rawScope) => {
    const scope = normalizeAiderPath(rawScope);
    return !!scope && (path === scope || path.startsWith(`${scope}/`));
  });
}

function insideWriteScope(path: string, writeScope: readonly string[]) {
  return writeScope.some((scope) => scope.trim() === ".") || explicitlyScoped(path, writeScope);
}

function evidenceRelevantFiles(evidence: unknown): string[] {
  if (!evidence || typeof evidence !== "object") return [];
  const relevantFiles = (evidence as { relevantFiles?: unknown }).relevantFiles;
  if (!Array.isArray(relevantFiles)) return [];
  return relevantFiles.filter((value): value is string => typeof value === "string");
}

function broadTaskExplicitlyCreatesTests(task: string) {
  return /\b(?:add|create|write|introduce)\b[^\n]{0,80}\b(?:tests?|specs?)\b/i.test(task);
}

export function selectAiderFiles(input: CodingWorkerInput): { editable: string[]; readOnly: string[] } {
  const context = input.context;
  if (!context) return { editable: [], readOnly: [] };
  const normalizeList = (values: readonly string[]) => values.map(normalizeAiderPath).filter((value): value is string => !!value);
  const evidence = normalizeList(evidenceRelevantFiles(context.evidence));
  const complete = normalizeList(context.completePaths ?? []);
  const source = normalizeList((context.sourceFiles ?? []).map((file) => file.path));
  const relevant = normalizeList(context.relevantFiles ?? []);
  const all = [...new Set([...evidence, ...complete, ...source, ...relevant])];
  const preferredEditable = new Set([...evidence, ...complete]);
  const allowBroadTestEdits = broadTaskExplicitlyCreatesTests(input.task);
  const editable = all
    .filter((path) => insideWriteScope(path, input.writeScope))
    .filter((path) => isTestPath(path)
      ? explicitlyScoped(path, input.writeScope) || allowBroadTestEdits
      : preferredEditable.has(path) || explicitlyScoped(path, input.writeScope))
    .slice(0, MAX_AIDER_EDITABLE_FILES);
  const editableSet = new Set(editable);
  const readOnly = all.filter((path) => !editableSet.has(path)).slice(0, MAX_AIDER_READ_ONLY_FILES);
  return { editable, readOnly };
}

async function existingAiderFiles(root: string, selected: ReturnType<typeof selectAiderFiles>) {
  const rootReal = await realpath(root);
  const keep = async (path: string) => {
    try {
      const candidateReal = await realpath(join(root, path));
      const rel = relative(rootReal, candidateReal);
      return !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
    } catch {
      return false;
    }
  };
  const editable = (await Promise.all(selected.editable.map(async (path) => [path, await keep(path)] as const)))
    .filter(([, exists]) => exists).map(([path]) => path);
  const editableSet = new Set(editable);
  const readOnly = (await Promise.all(selected.readOnly.map(async (path) => [path, await keep(path)] as const)))
    .filter(([, exists]) => exists).map(([path]) => path).filter((path) => !editableSet.has(path));
  return { editable, readOnly };
}

export function aiderOpenRouterModel(model: string) {
  if (!/^[^\s/]+\/[^\s]+$/.test(model)) {
    throw Error("AIDER_MODEL_INVALID");
  }

  return `openrouter/${model}`;
}

export function alternateAiderFormat(
  format: string,
): "diff" | "whole" {
  return format === "whole" ? "diff" : "whole";
}

export function buildAiderArgs(
  input: CodingWorkerInput,
  files: {
    prompt: string;
    metadata: string;
    chat: string;
    inputHistory: string;
    config: string;
  },
  format: AiderEditFormat,
) {
  const model = aiderOpenRouterModel(input.model);

  const mapTokens = 0;

  const args = [
    "--model",
    model,

    // Koda chooses the coding model. Do not allow Aider to silently
    // substitute another model for weak/editor work.
    "--weak-model",
    model,
    "--editor-model",
    model,

    "--message-file",
    files.prompt,

    "--model-metadata-file",
    files.metadata,

    "--config",
    files.config,

    "--map-tokens",
    String(mapTokens),

    "--max-chat-history-tokens",
    String(
      Math.min(
        input.contextWindowTokens ?? input.maxTokens,
        input.maxTokens,
      ),
    ),

    "--timeout",
    String(
      Math.max(
        1,
        Math.ceil(input.requestTimeoutMs / 1000),
      ),
    ),

    "--chat-history-file",
    files.chat,

    "--input-history-file",
    files.inputHistory,

    "--yes-always",

    // Koda owns the candidate/worktree lifecycle.
    "--no-auto-commits",
    "--no-dirty-commits",
    "--no-gitignore",

    // Fully non-interactive / deterministic subprocess behaviour.
    "--no-pretty",
    "--no-stream",
    "--no-check-update",
    "--no-show-release-notes",
    "--no-auto-lint",
    "--no-auto-test",
    "--no-suggest-shell-commands",
    "--no-detect-urls",
    "--no-fancy-input",
    "--analytics-disable",

    "--cache-keepalive-pings",
    "0",
  ];

  // "native" means: let Aider choose the model's normal/default edit
  // format. This is important for unknown/new OpenRouter models.
  if (format !== "native") {
    args.push("--edit-format", format);
  }

  return args;
}

export function aiderMetadata(input: CodingWorkerInput) {
  return {
    [aiderOpenRouterModel(input.model)]: {
      max_tokens: input.maxOutputTokens,
      max_input_tokens:
        input.contextWindowTokens ?? input.maxTokens,
      max_output_tokens: input.maxOutputTokens,

      ...(input.promptPricePerMillion === undefined
        ? {}
        : {
            input_cost_per_token:
              input.promptPricePerMillion / 1e6,
          }),

      ...(input.completionPricePerMillion === undefined
        ? {}
        : {
            output_cost_per_token:
              input.completionPricePerMillion / 1e6,
          }),

      litellm_provider: "openrouter",
      mode: "chat",
    },
  };
}

/**
 * Git identifies candidate paths.
 * AttemptCheckpoint distinguishes mutations introduced by this attempt
 * from changes that were already present before execution.
 */
async function gitChangedPaths(root: string) {
  const opts = {
    cwd: root,
    env: {
      GIT_OPTIONAL_LOCKS: "0",
    },
  };

  const tracked = await execa(
    "git",
    [
      "diff",
      "--no-ext-diff",
      "--name-only",
      "-z",
      "HEAD",
      "--",
    ],
    opts,
  );

  const untracked = await execa(
    "git",
    [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ],
    opts,
  );

  return new Set(
    (
      tracked.stdout +
      "\0" +
      untracked.stdout
    )
      .split("\0")
      .filter(Boolean),
  );
}

function looksLikeEditFormatFailure(
  stdout: string,
  stderr: string,
) {
  const text = `${stdout}\n${stderr}`.toLowerCase();

  return (
    text.includes("edit format") ||
    text.includes("failed to apply edit") ||
    text.includes("failed to apply patch") ||
    text.includes("search/replace") ||
    text.includes("search replace block") ||
    text.includes("malformed edit")
  );
}

function looksLikeProviderFailure(
  stdout: string,
  stderr: string,
) {
  const text = `${stdout}\n${stderr}`.toLowerCase();

  return (
    text.includes("429") ||
    text.includes("rate limit") ||
    text.includes("rate_limit") ||
    text.includes("timeout") ||
    text.includes("timed out") ||
    text.includes("connection error") ||
    text.includes("api connection") ||
    text.includes("502") ||
    text.includes("503") ||
    text.includes("504") ||
    text.includes("bad gateway") ||
    text.includes("service unavailable") ||
    text.includes("gateway timeout")
  );
}

async function readJsonFile(path: string) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

function ledgerUsage(ledger: any): Usage | undefined {
  const cost =
    typeof ledger?.costUsd === "number" &&
    Number.isFinite(ledger.costUsd) &&
    ledger.costUsd >= 0
      ? ledger.costUsd
      : undefined;

  const inputTokens =
    Number.isSafeInteger(ledger?.inputTokens) &&
    ledger.inputTokens >= 0
      ? ledger.inputTokens
      : undefined;

  const outputTokens =
    Number.isSafeInteger(ledger?.outputTokens) &&
    ledger.outputTokens >= 0
      ? ledger.outputTokens
      : undefined;

  if (
    cost === undefined ||
    inputTokens === undefined ||
    outputTokens === undefined
  ) {
    return undefined;
  }

  return {
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    reasoningTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    costUsd: cost,
    raw: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      cost,
    },
  };
}

export class AiderExecutor implements CodingWorker {
  constructor(
    readonly budget: Budget,
    readonly logger: Logger,
    private readonly options: AiderExecutorOptions = {},
  ) {}

  async run(
    input: CodingWorkerInput,
  ): Promise<CodingWorkerResult> {
    const started = Date.now();

    const deadline =
      started +
      Math.min(
        input.timeoutMs,
        this.budget.remainingMs(),
      );

    const scope = new WriteScope(
      input.writeScope,
      this.logger,
      `aider:${input.model}`,
    );

    const checkpoint =
      await AttemptCheckpoint.capture(
        input.repoPath,
        scope,
      );

    const scratch = await mkdtemp(
      join(tmpdir(), "koda-aider-"),
    );

    // The production Python bridge writes these files; injected test runners
    // may omit them and are classified from their direct command result.
    const reportPath = join(
      scratch,
      "report.json",
    );

    const ledgerPath = join(
      scratch,
      "ledger.json",
    );

    let release:
      | ReturnType<Budget["reserve"]>
      | undefined;

    let dispatched = false;

    const attempts: NonNullable<
      CodingWorkerResult["formatAttempts"]
    > = [];

    const secret =
      process.env.OPENROUTER_API_KEY?.trim() ?? "";

    const redact = (value: string) =>
      (
        secret
          ? value.replaceAll(
              secret,
              "[REDACTED]",
            )
          : value
      ).slice(-12000);

    let stdout = "";
    let stderr = "";
    let version = "unknown";
    let usage: Usage | undefined;
    let ledger: any;

    let gitCandidatePaths:
      | Set<string>
      | undefined;

    const changes = async () => {
      const gitPaths =
        gitCandidatePaths ??
        (await gitChangedPaths(
          input.repoPath,
        ).catch(
          () => new Set<string>(),
        ));

      return (
        await checkpoint.changed(
          input.repoPath,
          scope,
        )
      )
        .map((change) => change.path)
        .filter((path) =>
          gitPaths.has(path),
        );
    };

    const finish = async (
      status: CodingWorkerResult["exitStatus"],
      reason: string,
      changedPaths: string[],
      format?: string,
    ): Promise<CodingWorkerResult> => {
      if (release) {
        if (dispatched) {
          if (usage) {
            release.settle(usage);
          } else {
            release.settleUncertain();
          }
        } else {
          release.cancel();
        }

        release = undefined;
      }

      return {
        exitStatus: status,
        terminationReason: reason,

        model: input.model,

        engine: "aider",
        engineVersion: version,

        changedPaths,

        wallClockMs:
          Date.now() - started,

        stdout,
        stderr,

        editFormat: format,
        formatAttempts: attempts,

        costUsd: usage?.costUsd ??
          (dispatched
            ? input.budgetUsd
            : 0),

        inputTokens:
          usage?.promptTokens,

        outputTokens:
          usage?.completionTokens,

        consumedTokens: dispatched
          ? usage
            ? usage.promptTokens +
              usage.completionTokens
            : input.maxTokens
          : 0,

        configuredTokenLimit:
          input.maxTokens,

        remainingTokens: dispatched
          ? usage
            ? Math.max(
                0,
                input.maxTokens -
                  usage.promptTokens -
                  usage.completionTokens,
              )
            : 0
          : input.maxTokens,

        ...(changedPaths.length
          ? {
              timeToFirstMutationMs:
                Date.now() - started,
              progressPhase:
                "MUTATION_OBSERVED" as const,
            }
          : {}),

        ...(status === "infra_failure"
          ? {
              fatalError: reason,
            }
          : {}),

        ...(reason === "attempt_budget_exhausted"
          ? {
              limitKind: "token_preflight" as const,
              exactLimitFired: reason,
              progressPhase: "DISCOVERY" as const,
            }
          : {}),
      };
    };

    try {
      const binary =
        await (
          this.options.ensureRuntime ??
          ensureAiderRuntime
        )();

      if (
        !secret ||
        /[\r\n]/.test(secret)
      ) {
        throw Error(
          "AIDER_AUTH_UNAVAILABLE",
        );
      }

      // Capture installed Aider version for telemetry.
      try {
        const versionResult =
          await execa(
            binary,
            ["--version"],
            {
              timeout: Math.min(
                5000,
                Math.max(
                  1,
                  deadline -
                    Date.now(),
                ),
              ),
              env: {
                ...process.env,
                OPENROUTER_API_KEY:
                  secret,
              },
            },
          );

        const match =
          versionResult.stdout.match(
            /aider\s+([^\s]+)/i,
          );

        if (match?.[1]) {
          version = match[1];
        }
      } catch {
        // Runtime existence was already validated.
        // Version telemetry is optional.
      }

      release =
        this.budget.reserve(
          input.budgetUsd,
          input.maxTokens,
        );

      const files = {
        prompt: join(
          scratch,
          "task.txt",
        ),

        metadata: join(
          scratch,
          "metadata.json",
        ),

        chat: join(
          scratch,
          "chat.md",
        ),

        inputHistory: join(
          scratch,
          "history",
        ),

        config: join(
          scratch,
          "config.yml",
        ),
      };

      // Explicit empty config prevents inherited Aider configuration
      // from silently changing Koda's selected model/behaviour.
      await writeFile(
        files.config,
        "{}\n",
      );

      const aiderFiles = await existingAiderFiles(
        input.repoPath,
        selectAiderFiles(input),
      );
      if (!aiderFiles.editable.length)
        return finish(
          "infra_failure",
          "missing_editable_scope: repository exploration must establish an editable file before Aider starts",
          [],
        );

      await writeFile(
        files.prompt,
        [
          input.task,

          [
            "Use the attached files as the primary implementation context.",
            "Implement the complete task with the smallest correct change.",
            "Do not ask the user to add a file and do not merely explain the change.",
          ].join(" "),

          `Authorized write paths: ${JSON.stringify(
            input.writeScope,
          )}`,

          input.context
            ? `Koda context:\n${JSON.stringify(
                input.context,
              )}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      );

      await writeFile(
        files.metadata,
        JSON.stringify(
          aiderMetadata(input),
          null,
          2,
        ),
      );

      const requestPath = join(
        scratch,
        "request.json",
      );

      this.logger.log("aider_file_handoff", {
        subtaskId: input.attemptId,
        editable_files: aiderFiles.editable,
        readonly_files: aiderFiles.readOnly,
        discovery_mode: false,
      });

      let format:
        AiderEditFormat =
        input.aiderEditFormat ??
        "native";

      for (
        let index = 0;
        index < 2;
        index++
      ) {
        const env: NodeJS.ProcessEnv =
          {
            PATH: process.env.PATH,

            // Keep normal user HOME so pipx Aider and normal runtime
            // dependencies behave the same way as the direct command
            // that we already proved works.
            HOME: process.env.HOME,

            LANG:
              process.env.LANG ??
              "C.UTF-8",

            OPENROUTER_API_KEY:
              secret,

            NO_COLOR: "1",

            PYTHONDONTWRITEBYTECODE:
              "1",
          };

        const model =
          aiderOpenRouterModel(
            input.model,
          );

        await writeFile(
          requestPath,
          JSON.stringify(
            {
              model,
              prompt: files.prompt,
              report: reportPath,
              ledger: ledgerPath,
              maxSteps: input.maxSteps,
              deadline,
              promptPricePerMillion:
                input.promptPricePerMillion,
              completionPricePerMillion:
                input.completionPricePerMillion,
              maxOutputTokens:
                input.maxOutputTokens,
              maxTokens: input.maxTokens,
              budgetUsd: input.budgetUsd,
              baseUrl: input.baseUrl,
              requestTimeoutMs:
                input.requestTimeoutMs,
              modelMetadata:
                input.modelMetadata,
              editableFiles:
                aiderFiles.editable,
              readOnlyFiles:
                aiderFiles.readOnly,
              discoveryMode: false,
            },
            null,
            2,
          ),
        );

        const invocation: AiderInvocation =
          {
            binary,

            args: [
              "-I",
              bridgePath,
              requestPath,
              ...aiderFiles.editable,
              ...aiderFiles.readOnly.flatMap((path) => [
                "--read",
                path,
              ]),
              ...buildAiderArgs(
                input,
                files,
                format,
              ),
            ],

            env,

            model,

            editFormat: format,

            reportPath,
            ledgerPath,
          };

        const execute = async (
          cwd: string,
          timeoutMs: number,
        ) => {
          /**
           * scopedCommand may copy a linked-worktree .git pointer.
           *
           * Turn the isolated candidate copy into a standalone Git repo
           * so Aider sees a normal repository and can build its repo map
           * without reaching into the parent repository.
           */
          if (
            cwd !== input.repoPath
          ) {
            await rm(
              join(cwd, ".git"),
              {
                recursive: true,
                force: true,
              },
            );

            await execa(
              "git",
              ["init", "-q"],
              {
                cwd,
                timeout: Math.max(
                  1,
                  deadline -
                    Date.now(),
                ),
              },
            );

            await execa(
              "git",
              ["add", "-A"],
              {
                cwd,
                timeout: Math.max(
                  1,
                  deadline -
                    Date.now(),
                ),
              },
            );

            await execa(
              "git",
              [
                "-c",
                "user.name=Koda",

                "-c",
                "user.email=koda@localhost",

                "-c",
                "core.hooksPath=/dev/null",

                "-c",
                "commit.gpgsign=false",

                "commit",
                "-qm",
                "Koda attempt baseline",

                "--allow-empty",
              ],
              {
                cwd,
                timeout: Math.max(
                  1,
                  deadline -
                    Date.now(),
                ),
              },
            );
          }

          timeoutMs = Math.min(
            timeoutMs,
            deadline - Date.now(),
            this.budget.remainingMs(),
          );

          if (timeoutMs <= 0) {
            return {
              command: "aider",
              exitCode: 1,
              stdout: "",
              stderr:
                "Attempt deadline exhausted before dispatch",
              timedOut: true,
              wallClockMs:
                Date.now() -
                started,
            };
          }

          dispatched = true;

          let result: CommandResult;

          try {
            result =
              this.options.runner
                ? await this.options.runner(
                    cwd,
                    invocation,
                    timeoutMs,
                  )
                : await command(
                    cwd,

                    [
                      shellQuote(binary),
                      ...invocation.args.map(
                        shellQuote,
                      ),
                    ].join(" "),

                    timeoutMs,

                    false,
                    undefined,
                    [],
                    false,
                    undefined,

                    env,

                    true,

                    ".",

                    env,

                    [scratch],

                    [
                      scratch,
                      dirname(
                        bridgePath,
                      ),
                      dirname(
                        dirname(binary),
                      ),
                      dirname(
                        dirname(
                          await realpath(
                            binary,
                          ),
                        ),
                      ),
                    ],
                  );
          } catch (error) {
            result = {
              command: "aider",
              cwd,
              exitCode: 1,
              stdout: "",
              stderr: redact(
                String(error),
              ),
              timedOut: false,
              wallClockMs:
                Date.now() -
                started,
            };
          }

          gitCandidatePaths =
            await gitChangedPaths(
              cwd,
            ).catch(
              () =>
                new Set<string>(),
            );

          return result;
        };

        const remaining =
          Math.min(
            deadline - Date.now(),
            this.budget.remainingMs(),
          );

        if (remaining <= 0) {
          return await finish(
            "infra_failure",
            "timeout",
            await changes(),
            format,
          );
        }

        const result =
          await scopedCommand(
            input.repoPath,

            scope,

            (cwd, ms) =>
              execute(
                cwd,
                Math.min(
                  ms,
                  deadline -
                    Date.now(),
                ),
              ),

            remaining,
          );

        stdout = redact(
          `${stdout}\n${result.stdout}`,
        );

        stderr = redact(
          `${stderr}\n${result.stderr}`,
        );

        const changedPaths =
          await changes();

        const report =
          await readJsonFile(
            reportPath,
          );

        ledger =
          (await readJsonFile(
            ledgerPath,
          )) ?? ledger;

        usage =
          ledgerUsage(ledger) ??
          usage;

        if (
          typeof report?.version ===
          "string"
        ) {
          version =
            report.version;
        }

        const actualFormat =
          typeof report?.format ===
          "string"
            ? report.format
            : format;

        let failure:
          | string
          | undefined;

        if (
          typeof report?.failureKind ===
            "string" &&
          report.failureKind
        ) {
          failure =
            report.failureKind;
        } else if (
          !this.options.runner &&
          !report
        ) {
          failure = "runtime";
        } else if (result.timedOut) {
          failure = "provider";
        } else if (
          result.exitCode !== 0
        ) {
          if (
            looksLikeProviderFailure(
              result.stdout,
              result.stderr,
            )
          ) {
            failure = "provider";
          } else if (
            looksLikeEditFormatFailure(
              result.stdout,
              result.stderr,
            )
          ) {
            failure =
              "edit_format";
          } else {
            failure = "runtime";
          }
        }

        attempts.push({
          format:
            actualFormat,

          exitCode:
            result.exitCode,

          mutation:
            changedPaths.length > 0,

          wallClockMs:
            result.wallClockMs,

          changedPaths,

          failureKind:
            failure,
        });

        this.logger.log(
          "aider_execution",
          {
            subtaskId:
              input.attemptId,

            model:
              input.model,

            aider_model:
              invocation.model,

            edit_format:
              actualFormat,

            exit_code:
              result.exitCode,

            wall_time_ms:
              result.wallClockMs,

            changed_paths:
              changedPaths,

            mutation:
              changedPaths.length >
              0,

            failure_kind:
              failure ?? null,
          },
        );

        if (
          result.exitCode !== 0
        ) {
          this.logger.log(
            "aider_execution_error",
            {
              subtaskId:
                input.attemptId,

              model:
                input.model,

              aider_model:
                invocation.model,

              edit_format:
                actualFormat,

              exit_code:
                result.exitCode,

              stderr: redact(
                result.stderr,
              ),

              stdout: redact(
                result.stdout,
              ),
            },
          );
        }

        /**
         * Any actual mutation is handed back to Koda verification,
         * regardless of Aider's exit code.
         *
         * Aider output is never considered proof of correctness.
         */
        if (
          changedPaths.length
        ) {
          return await finish(
            "completed",
            "candidate_ready_for_verification",
            changedPaths,
            actualFormat,
          );
        }

        if (!failure) {
          return await finish(
            "failed",
            "no_mutation",
            [],
            actualFormat,
          );
        }

        /**
         * Provider/runtime errors are not model edit-format evidence.
         * Let Koda's normal recovery/router decide what happens next.
         */
        if (
          failure !==
          "edit_format"
        ) {
          return await finish(
            "infra_failure",
            failure,
            [],
            actualFormat,
          );
        }

        if (index === 1) {
          return await finish(
            "failed",
            "aider_edit_format_failure",
            [],
            actualFormat,
          );
        }

        /**
         * One bounded edit-format retry.
         *
         * Retry only the format that Aider actually selected. Unknown
         * models default to diff in the bridge, so they retry with whole.
         */
        format =
          actualFormat === "native"
            ? "whole"
            : alternateAiderFormat(
                actualFormat,
              );
      }

      return await finish(
        "failed",
        "aider_edit_format_failure",
        [],
      );
    } catch (error) {
      stderr = redact(
        `${stderr}\n${String(
          error,
        )}`,
      );

      // Preserve any mutations already made before the runtime error.
      const changedPaths =
        await changes().catch(
          () => [] as string[],
        );

      const message =
        String(error);

      return await finish(
        changedPaths.length
          ? "completed"
          : "infra_failure",

        message.includes(
          "AIDER_UNAVAILABLE",
        )
          ? "AIDER_UNAVAILABLE"
          : message.includes(
                "AIDER_AUTH_UNAVAILABLE",
              )
            ? "AIDER_AUTH_UNAVAILABLE"
            : "aider_execution_failure",

        changedPaths,

        attempts.at(-1)
          ?.format,
      );
    } finally {
      if (release) {
        if (dispatched) {
          release.settleUncertain();
        } else {
          release.cancel();
        }
      }

      await rm(
        scratch,
        {
          recursive: true,
          force: true,
        },
      );
    }
  }
}

/**
 * Only verified edit-format evidence should influence future compatibility
 * routing. Provider/runtime failures must not poison model quality.
 */
export function preferredAiderFormat(
  rows: import("../router/history.js").OperationalCall[],
  model: string,
): "diff" | "whole" | undefined {
  const relevant =
    rows.filter(
      (row) =>
        row.provider === "aider" &&
        row.modelRequested ===
          model &&
        (row.editFormat ===
          "diff" ||
          row.editFormat ===
            "whole"),
    );

  const success =
    relevant.findLast(
      (row) =>
        row.verification ===
        "VERIFIED_SUCCESS",
    );

  if (success) {
    return success.editFormat as
      | "diff"
      | "whole";
  }

  const failed =
    relevant.findLast(
      (row) =>
        row.failureKind ===
        "edit_format",
    );

  return failed
    ? alternateAiderFormat(
        failed.editFormat!,
      )
    : undefined;
}

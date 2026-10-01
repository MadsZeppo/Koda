#!/usr/bin/env python3
from __future__ import annotations

import shutil
import subprocess
from datetime import datetime
from pathlib import Path


ROOT = Path("/Users/madsflyvholm/Desktop/Koda.ai").resolve()

AIDER_EXECUTOR = ROOT / "src/agent/aiderExecutor.ts"
CODING_EXECUTOR = ROOT / "src/agent/codingExecutor.ts"
ATTEMPT_POLICY = ROOT / "src/agent/attemptPolicy.ts"
BRIDGE = ROOT / "workers/aider/bridge.py"
BRIDGE_TEST = ROOT / "workers/aider/test_bridge.py"
AIDER_TEST = ROOT / "tests/aiderExecutor.test.ts"

FILES = [
    AIDER_EXECUTOR,
    CODING_EXECUTOR,
    ATTEMPT_POLICY,
    BRIDGE,
    BRIDGE_TEST,
    AIDER_TEST,
]

for path in FILES:
    if not path.exists():
        raise SystemExit(f"Missing expected file: {path}")


texts = {
    path: path.read_text()
    for path in FILES
}


def replace_once(
    path: Path,
    old: str,
    new: str,
    label: str,
) -> None:
    text = texts[path]

    if new in text and old not in text:
        print(f"[already] {label}")
        return

    count = text.count(old)

    if count != 1:
        raise SystemExit(
            "\nSTOPPED BEFORE WRITING.\n"
            f"{label}\n"
            f"Expected exactly 1 old block in {path}, found {count}.\n"
            "Your local code differs from the expected branch."
        )

    texts[path] = text.replace(
        old,
        new,
        1,
    )

    print(f"[patch] {label}")


def insert_before_once(
    path: Path,
    marker: str,
    addition: str,
    unique_text: str,
    label: str,
) -> None:
    text = texts[path]

    if unique_text in text:
        print(f"[already] {label}")
        return

    count = text.count(marker)

    if count != 1:
        raise SystemExit(
            "\nSTOPPED BEFORE WRITING.\n"
            f"{label}\n"
            f"Expected exactly 1 marker in {path}, found {count}."
        )

    texts[path] = text.replace(
        marker,
        addition + marker,
        1,
    )

    print(f"[patch] {label}")


# ============================================================
# 1. src/agent/aiderExecutor.ts
# ============================================================

replace_once(
    AIDER_EXECUTOR,
    '''import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";''',
    '''import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";''',
    "import stat for real Aider handoff sizing",
)


replace_once(
    AIDER_EXECUTOR,
    '''export function selectAiderFiles(input: CodingWorkerInput): { editable: string[]; readOnly: string[] } {''',
    '''export function selectAiderFiles(
  input: Pick<CodingWorkerInput, "task" | "writeScope" | "context">,
): { editable: string[]; readOnly: string[] } {''',
    "allow file selection before complete worker input exists",
)


insert_before_once(
    AIDER_EXECUTOR,
    '''async function existingAiderFiles(''',
    r'''function boundedAiderText(
  value: unknown,
  maxChars: number,
) {
  if (
    value === undefined ||
    value === null
  ) {
    return "";
  }

  let text: string;

  if (typeof value === "string") {
    text = value;
  } else {
    try {
      const encoded = JSON.stringify(value);

      if (typeof encoded !== "string") {
        return "";
      }

      text = encoded;
    } catch {
      return "";
    }
  }

  if (text.length <= maxChars) {
    return text;
  }

  return (
    text.slice(0, maxChars) +
    "\n[truncated by Koda]"
  );
}


/**
 * Aider receives actual repository files separately.
 *
 * Never serialize CodingWorkerContext.sourceFiles into the message again:
 * doing so duplicates the same source once in Koda's prompt and again in
 * Aider's attached-file context.
 *
 * Keep only bounded non-file evidence that is useful for implementation
 * and repair.
 */
function compactAiderContext(
  context: CodingWorkerInput["context"],
) {
  if (!context) return "";

  return [
    context.localizationSummary
      ? `Localization summary:\n${boundedAiderText(
          context.localizationSummary,
          2_000,
        )}`
      : "",

    context.diagnostics
      ? `Verification diagnostics:\n${boundedAiderText(
          context.diagnostics,
          4_000,
        )}`
      : "",

    context.previousFailedDiff
      ? `Previous failed diff:\n${boundedAiderText(
          context.previousFailedDiff,
          6_000,
        )}`
      : "",

    context.evidence
      ? `Repository evidence:\n${boundedAiderText(
          context.evidence,
          4_000,
        )}`
      : "",

    context.repairPacket
      ? `Repair evidence:\n${boundedAiderText(
          context.repairPacket,
          6_000,
        )}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}


export function buildAiderPrompt(
  input: Pick<
    CodingWorkerInput,
    "task" | "writeScope" | "context"
  >,
  files: {
    editable: readonly string[];
    readOnly: readonly string[];
  },
) {
  const compactContext =
    compactAiderContext(input.context);

  return [
    input.task,

    [
      "Use the attached repository files as the primary implementation context.",
      "Implement the complete task with the smallest correct change.",
      "Do not ask the user to add a file and do not merely explain the change.",
      "Files marked read-only are evidence, not mutation targets.",
    ].join(" "),

    `Authorized write paths: ${JSON.stringify(
      input.writeScope,
    )}`,

    `Attached editable files: ${JSON.stringify(
      files.editable,
    )}`,

    `Attached read-only files: ${JSON.stringify(
      files.readOnly,
    )}`,

    compactContext,
  ]
    .filter(Boolean)
    .join("\n\n");
}


''',
    "function compactAiderContext(",
    "add compact Aider prompt builder",
)


insert_before_once(
    AIDER_EXECUTOR,
    '''export function aiderOpenRouterModel(''',
    r'''/**
 * Estimate the provider input Aider will actually construct.
 *
 * Unlike the old estimate, this includes the real attached repository file
 * sizes rather than only Koda's compiled JSON packet.
 *
 * Aider/system framing itself is accounted for separately by
 * AIDER_PROMPT_OVERHEAD_TOKENS in attemptPolicy.ts.
 */
export async function estimateAiderPromptBytes(
  input: Pick<
    CodingWorkerInput,
    "repoPath" | "task" | "writeScope" | "context"
  >,
) {
  const selected =
    await existingAiderFiles(
      input.repoPath,
      selectAiderFiles(input),
    );

  const attached = [
    ...selected.editable,
    ...selected.readOnly,
  ];

  const attachedBytes = (
    await Promise.all(
      attached.map(async (path) => {
        try {
          const info = await stat(
            join(input.repoPath, path),
          );

          return (
            info.size +
            Buffer.byteLength(path) +
            128
          );
        } catch {
          return 0;
        }
      }),
    )
  ).reduce(
    (sum, value) => sum + value,
    0,
  );

  return (
    Buffer.byteLength(
      buildAiderPrompt(
        input,
        selected,
      ),
    ) +
    attachedBytes +
    1_024
  );
}


''',
    "export async function estimateAiderPromptBytes(",
    "add real Aider provider-prompt estimator",
)


OLD_PROMPT = r'''      await writeFile(
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
'''

NEW_PROMPT = r'''      await writeFile(
        files.prompt,
        buildAiderPrompt(
          input,
          aiderFiles,
        ),
      );
'''

replace_once(
    AIDER_EXECUTOR,
    OLD_PROMPT,
    NEW_PROMPT,
    "remove duplicated full Koda context from Aider message",
)


# ============================================================
# 2. src/agent/codingExecutor.ts
# ============================================================

replace_once(
    CODING_EXECUTOR,
    '''import { AiderExecutor, preferredAiderFormat } from "./aiderExecutor.js";''',
    '''import {
  AiderExecutor,
  estimateAiderPromptBytes,
  preferredAiderFormat,
} from "./aiderExecutor.js";''',
    "import real Aider prompt estimator",
)


OLD_POLICY = r'''    const limits = attemptLimitPolicy({
      fingerprint,
      effort,
      promptBytes:
        Buffer.byteLength(
          JSON.stringify({ task: workerTask, context: workerContext }),
        ) + 1024,
      maxIterations: gateway.config.maxIterations,
'''

NEW_POLICY = r'''    const forecastPromptBytes =
      worker instanceof AiderExecutor
        ? await estimateAiderPromptBytes({
            repoPath: path,
            task: workerTask,
            writeScope: [...writeScope.paths],
            context: workerContext,
          })
        : Buffer.byteLength(
            JSON.stringify({
              task: workerTask,
              context: workerContext,
            }),
          ) + 1_024;

    const limits = attemptLimitPolicy({
      fingerprint,
      effort,
      promptBytes: forecastPromptBytes,
      maxIterations: gateway.config.maxIterations,
'''

replace_once(
    CODING_EXECUTOR,
    OLD_POLICY,
    NEW_POLICY,
    "budget using actual attached Aider files",
)


replace_once(
    CODING_EXECUTOR,
    '''      attempt_timeout_ms: attemptTimeoutMs,
      context_bytes_initial:
''',
    '''      attempt_timeout_ms: attemptTimeoutMs,
      forecast_provider_prompt_bytes:
        forecastPromptBytes,
      context_bytes_initial:
''',
    "add provider prompt forecast telemetry",
)


# ============================================================
# 3. src/agent/attemptPolicy.ts
# ============================================================

replace_once(
    ATTEMPT_POLICY,
    '''export const AIDER_PROMPT_OVERHEAD_TOKENS = 2_048;''',
    '''export const AIDER_PROMPT_OVERHEAD_TOKENS = 4_096;''',
    "use conservative Aider system-prompt overhead",
)


# ============================================================
# 4. workers/aider/bridge.py
# ============================================================

OLD_TOKEN_BLOCK = r'''        # maxTokens is the per-attempt token allowance.
        # Aider's input context must be allowed to consume that
        # allowance without making the first provider call impossible.
        # The actual USD budget remains enforced below.
        remaining_tokens = r["maxTokens"]

        output = min(
            r["maxOutputTokens"],
            remaining_tokens,
        )
'''

NEW_TOKEN_BLOCK = r'''        # maxTokens is Koda's TOTAL provider-token allowance for
        # this attempt, not a completion-only allowance.
        #
        # Count:
        #   previous provider usage
        # + this provider prompt
        # + this provider completion
        #
        # state["tokens"] contains usage from previous provider calls.
        remaining_tokens = (
            r["maxTokens"]
            - state["tokens"]
            - prompt
        )

        output = min(
            r["maxOutputTokens"],
            max(
                0,
                remaining_tokens,
            ),
        )
'''

replace_once(
    BRIDGE,
    OLD_TOKEN_BLOCK,
    NEW_TOKEN_BLOCK,
    "restore whole-attempt token budget semantics",
)


# ============================================================
# 5. tests/aiderExecutor.test.ts
# ============================================================

replace_once(
    AIDER_TEST,
    '''import { AiderExecutor, aiderOpenRouterModel, preferredAiderFormat, selectAiderFiles, type AiderInvocation } from "../src/agent/aiderExecutor.js";''',
    '''import {
  AiderExecutor,
  aiderOpenRouterModel,
  estimateAiderPromptBytes,
  preferredAiderFormat,
  selectAiderFiles,
  type AiderInvocation,
} from "../src/agent/aiderExecutor.js";''',
    "import Aider prompt estimator in regression tests",
)


insert_before_once(
    AIDER_TEST,
    '''test("Aider invocation pre-attaches bounded editable and read-only files without interactive add", async (t) => {''',
    r'''test(
  "Aider prompt forecast uses real attached files instead of duplicating source snippets",
  async (t) => {
    const root = await fixture(t);

    const hugeDuplicatedSnippet =
      "x".repeat(100_000);

    const bytes =
      await estimateAiderPromptBytes({
        repoPath: root,
        task: "Change both values to 3",
        writeScope: ["src"],
        context: {
          relevantFiles: [
            "src/value.cjs",
            "src/other.cjs",
          ],
          sourceFiles: [
            {
              path: "src/value.cjs",
              snippet:
                hugeDuplicatedSnippet,
            },
            {
              path: "src/other.cjs",
              snippet:
                hugeDuplicatedSnippet,
            },
          ],
          completePaths: [
            "src/value.cjs",
            "src/other.cjs",
          ],
          evidence: {
            relevantFiles: [
              "src/value.cjs",
              "src/other.cjs",
            ],
          },
        },
      });

    assert.ok(
      bytes < 20_000,
      `duplicated source snippets leaked into Aider prompt estimate: ${bytes}`,
    );
  },
);


''',
    'test(\n  "Aider prompt forecast uses real attached files instead of duplicating source snippets"',
    "add Aider context-duplication regression test",
)


replace_once(
    AIDER_TEST,
    '''    assert.equal(i.args.includes("../outside.cjs"), false);
    await writeFile(join(cwd, "src/value.cjs"), "module.exports = 3;\\n");''',
    r'''    assert.equal(i.args.includes("../outside.cjs"), false);

    const messageIndex =
      i.args.indexOf("--message-file");

    assert.ok(messageIndex >= 0);

    const message = await readFile(
      i.args[messageIndex + 1]!,
      "utf8",
    );

    assert.match(
      message,
      /Fix the failing value test/,
    );

    assert.doesNotMatch(
      message,
      /Koda context:/,
    );

    assert.doesNotMatch(
      message,
      /"sourceFiles"\s*:/,
    );

    assert.doesNotMatch(
      message,
      /module\.exports = 1/,
    );

    await writeFile(join(cwd, "src/value.cjs"), "module.exports = 3;\n");''',
    "prove Aider task prompt does not duplicate source contents",
)


# ============================================================
# 6. workers/aider/test_bridge.py
# ============================================================

insert_before_once(
    BRIDGE_TEST,
    '''    def test_unknown_tokenizer_uses_bounded_fallback(
''',
    r'''    def test_total_attempt_budget_counts_prompt_and_completion(
        self,
    ):
        request = dict(
            self.request,
            maxTokens=5000,
            maxOutputTokens=1000,
            budgetUsd=1,
        )

        state = dict(
            steps=0,
            tokens=0,
            costUsd=0,
            inputTokens=0,
            outputTokens=0,
        )

        calls = []

        def tokenizer(
            *,
            model,
            messages,
            **_kwargs,
        ):
            self.assertIn(
                model,
                (
                    "openrouter/foo/bar",
                    "foo/bar",
                ),
            )

            return 4200

        def complete(**kwargs):
            calls.append(kwargs)

            return types.SimpleNamespace(
                usage={
                    "prompt_tokens": 4100,
                    "completion_tokens": 600,
                    "cost": 0.01,
                }
            )

        guard = CallGuard(
            request,
            state,
            lambda: None,
            complete,
            tokenizer,
        )

        guard(
            model=request["model"],
            messages=[
                {
                    "role": "user",
                    "content": "large prompt",
                }
            ],
        )

        # 5000 total - 4200 current prompt = at most 800 output.
        self.assertEqual(
            calls[0]["max_tokens"],
            800,
        )

        # Provider truth replaces the reservation:
        # 4100 prompt + 600 completion = 4700 consumed.
        self.assertEqual(
            state["tokens"],
            4700,
        )

        # A second 4200-token prompt cannot fit in the same
        # 5000-token whole-attempt allowance.
        with self.assertRaises(
            StopExecution
        ) as error:
            guard(
                model=request["model"],
                messages=[
                    {
                        "role": "user",
                        "content": "second call",
                    }
                ],
            )

        self.assertEqual(
            error.exception.kind,
            "attempt_budget_exhausted",
        )

        self.assertEqual(
            len(calls),
            1,
        )


''',
    "def test_total_attempt_budget_counts_prompt_and_completion(",
    "lock whole-attempt token accounting with regression test",
)


# ============================================================
# Validate every transformation BEFORE writing anything
# ============================================================

for path, text in texts.items():
    if not text.strip():
        raise SystemExit(
            f"Refusing to write empty file: {path}"
        )


# ============================================================
# Backups
# ============================================================

stamp = datetime.now().strftime(
    "%Y%m%d-%H%M%S"
)

backup_dir = (
    ROOT
    / ".koda"
    / "backups"
    / f"aider-context-budget-{stamp}"
)

backup_dir.mkdir(
    parents=True,
    exist_ok=False,
)

for path in FILES:
    relative = path.relative_to(ROOT)
    destination = backup_dir / relative

    destination.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    shutil.copy2(
        path,
        destination,
    )


# ============================================================
# Write patched files
# ============================================================

for path, text in texts.items():
    path.write_text(text)


print("\nPatched:")

for path in FILES:
    print(
        "  -",
        path.relative_to(ROOT),
    )

print(
    f"\nBackups: {backup_dir}"
)


# ============================================================
# Verification
# ============================================================

def run(command: list[str]) -> None:
    print(
        "\n$",
        " ".join(command),
    )

    result = subprocess.run(
        command,
        cwd=ROOT,
    )

    if result.returncode != 0:
        raise SystemExit(
            "\nVERIFICATION FAILED.\n"
            "The patch is still present so it can be inspected.\n"
            f"Backups: {backup_dir}\n"
        )


run([
    "git",
    "diff",
    "--check",
])

run([
    "python3",
    "-m",
    "py_compile",
    "workers/aider/bridge.py",
])

run([
    "python3",
    "-m",
    "unittest",
    "discover",
    "-s",
    "workers/aider",
    "-p",
    "test_*.py",
])

run([
    "pnpm",
    "exec",
    "tsx",
    "--test",
    "tests/aiderExecutor.test.ts",
    "tests/attemptPolicy.test.ts",
])

run([
    "pnpm",
    "typecheck",
])


print(
    """
============================================================
OK

Aider context/budget patch passed:

- full Koda source context is no longer duplicated into task.txt
- actual attached repository files are included in prompt forecasting
- Aider framing overhead is reserved
- maxTokens covers prompt + completion for the whole attempt
- Python bridge tests passed
- Aider/attempt-policy tests passed
- TypeScript typecheck passed

Full pnpm test was NOT run automatically.
============================================================
"""
)
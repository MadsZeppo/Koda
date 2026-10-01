#!/usr/bin/env python3
from __future__ import annotations

import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path.cwd()
FILES = [
    ROOT / "src/agent/agenticCodingWorker.ts",
    ROOT / "src/agent/codingExecutor.ts",
    ROOT / "src/config.ts",
    ROOT / "tests/agenticCodingWorker.test.ts",
]

def die(msg: str) -> None:
    raise SystemExit(f"\nPATCH FAILED: {msg}")

def replace_once(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        die(f"{label}: expected exactly 1 match in {path}, found {count}")
    path.write_text(text.replace(old, new, 1))

def backup(path: Path, stamp: str) -> None:
    dst = path.with_name(path.name + f".pre-agentic-runtime-fix-{stamp}")
    shutil.copy2(path, dst)
    print(f"backup: {dst.relative_to(ROOT)}")

for path in FILES:
    if not path.exists():
        die(f"missing required file: {path}")

stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
for path in FILES:
    backup(path, stamp)

agent = FILES[0]
executor = FILES[1]
config = FILES[2]
tests = FILES[3]

replace_once(
    agent,
    '''    let implementationNudgeSent = false;\n''',
    '''    let implementationNudgeSent = false;
    let implementationContextRebuilt = false;
    let minimalImplementationRebuilt = false;
''',
    "agentic state flags",
)

replace_once(
    agent,
    '''      ) {
        if (
          !mutationObserved &&
          !implementationNudgeSent &&
          tools.progressEvidence.length >= 2
        ) {
''',
    '''      ) {
        const elapsedMs = Date.now() - started;
        if (elapsedMs >= input.timeoutMs) {
          const changes = await currentChanges();
          return result({
            exitStatus: changes.length ? "completed" : "failed",
            changedPaths: changes.map((change) => change.path),
            terminationReason: changes.length
              ? "candidate_ready_for_verification"
              : "agentic_attempt_timeout",
            limitKind: changes.length ? undefined : "timeout",
            exactLimitFired: changes.length
              ? undefined
              : "agentic_attempt_timeout",
            progressPhase: changes.length
              ? "MUTATION_OBSERVED"
              : "DISCOVERY",
            steps: step,
            discoveryEvidence: evidencePacket(),
            discoveryProgress: discoveryNotes.length,
          });
        }

        if (
          !mutationObserved &&
          !implementationNudgeSent &&
          tools.progressEvidence.length >= 2
        ) {
''',
    "attempt deadline",
)

old_transition = '''          messages.push({
            role: "user",
            content:
              "You now have enough distinct repository evidence to implement. Make the smallest justified mutation in the allowed write scope now. Further reads are allowed only for a genuinely new symbol or line range required to construct that edit.",
          });
          implementationNudgeSent = true;
          this.logger.log("agentic_implementation_transition", {
            subtaskId: input.attemptId,
            useful_discovery_steps: tools.progressEvidence.length,
          });
'''
new_transition = '''          const discoveryEvidence = evidencePacket();
          const systemMessage = messages[0]!;
          messages.splice(
            0,
            messages.length,
            systemMessage,
            {
              role: "user",
              content: [
                `TASK\\n${input.task}`,
                `WRITE SCOPE\\n${JSON.stringify(input.writeScope)}`,
                compactSeed(input),
                discoveryEvidence
                  ? `DISCOVERY EVIDENCE\\n${discoveryEvidence}`
                  : "",
                "IMPLEMENTATION PHASE: repository discovery is complete. Make the smallest justified mutation now. Use edit_file, apply_patch, or write_file. Do not search, read, explain, or plan before the mutation.",
              ]
                .filter(Boolean)
                .join("\\n\\n"),
            },
          );
          implementationNudgeSent = true;
          implementationContextRebuilt = true;
          this.logger.log("agentic_implementation_transition", {
            subtaskId: input.attemptId,
            useful_discovery_steps: tools.progressEvidence.length,
          });
          this.logger.log("agentic_implementation_context_reset", {
            subtaskId: input.attemptId,
            evidence_bytes: discoveryEvidence
              ? Buffer.byteLength(discoveryEvidence)
              : 0,
          });
'''
replace_once(agent, old_transition, new_transition, "implementation context reset")

old_preflight = '''        if (tokenRoom < MIN_NEXT_OUTPUT_TOKENS) {
          const changes =
            await currentChanges();

          if (changes.length) {
'''
new_preflight = '''        if (tokenRoom < MIN_NEXT_OUTPUT_TOKENS) {
          const discoveryEvidence = evidencePacket();
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
                  `TASK\\n${input.task}`,
                  `WRITE SCOPE\\n${JSON.stringify(input.writeScope)}`,
                  `DISCOVERY EVIDENCE\\n${discoveryEvidence}`,
                  "TOKEN-RECOVERY IMPLEMENTATION: mutate the authorized code now. Use edit_file, apply_patch, or write_file. Do not perform more discovery.",
                ].join("\\n\\n"),
              },
            );
            minimalImplementationRebuilt = true;
            this.logger.log("agentic_token_preflight_compact_retry", {
              subtaskId: input.attemptId,
              used_tokens: usedTokens,
              remaining_tokens: Math.max(0, input.maxTokens - usedTokens),
            });
            continue;
          }

          const changes =
            await currentChanges();

          if (changes.length) {
'''
replace_once(agent, old_preflight, new_preflight, "token preflight compact retry")

replace_once(
    agent,
    '''        let maxOutput = Math.min(
          input.maxOutputTokens,
          1_200,
          tokenRoom,
        );
''',
    '''        const phaseOutputLimit =
          implementationNudgeSent || mutationObserved
            ? input.maxOutputTokens
            : Math.min(input.maxOutputTokens, 1_200);

        let maxOutput = Math.min(
          phaseOutputLimit,
          tokenRoom,
        );
''',
    "phase output limit",
)

old_request = '''        const response = await this.request(
          input,
          messages,
          repairMutationRequired
            ? MUTATION_TOOL_DEFINITIONS
            : toolDefinitions,
          maxOutput,
        );
'''
new_request = '''        const remainingAttemptMs = Math.max(
          1,
          input.timeoutMs - (Date.now() - started),
        );
        const requestInput: CodingWorkerInput = {
          ...input,
          requestTimeoutMs: Math.max(
            1,
            Math.min(
              input.requestTimeoutMs,
              remainingAttemptMs,
            ),
          ),
        };
        const mutationOnly =
          repairMutationRequired ||
          (implementationNudgeSent && !mutationObserved);

        const response = await this.request(
          requestInput,
          messages,
          mutationOnly
            ? MUTATION_TOOL_DEFINITIONS
            : toolDefinitions,
          maxOutput,
        );
'''
replace_once(agent, old_request, new_request, "mutation-only implementation request")

replace_once(
    executor,
    '''      requestTimeoutMs: gateway.config.modelTimeoutMs.implementation,\n''',
    '''      requestTimeoutMs: Math.max(
        gateway.config.modelTimeoutMs.implementation,
        attemptTimeoutMs,
      ),
''',
    "executor request timeout",
)

anchor = '''      const resumableDiscoveryLimit =
        boundedDiscoveryLimit || discoveryTokenLimit;
      const failureMode =
'''
insert = '''      const resumableDiscoveryLimit =
        boundedDiscoveryLimit || discoveryTokenLimit;

      if (
        discoveryTokenLimit &&
        (result.discoveryProgress ?? 0) > 0 &&
        discoveryEvidence
      ) {
        const continuationKey = `token-preflight:${discoveryEvidence}`;
        if (!resumedDiscoveryEvidence.has(continuationKey)) {
          resumedDiscoveryEvidence.add(continuationKey);
          diagnostics = [
            diagnostics,
            "Prior discovery evidence:\\n" + discoveryEvidence,
            "The previous worker exhausted its prompt trajectory before mutation. Reuse this evidence and mutate before any new discovery.",
          ]
            .filter(Boolean)
            .join("\\n\\n");
          gateway.logger.log("discovery_continuation", {
            subtaskId: subtask.id,
            model,
            progress: result.discoveryProgress,
            evidence_bytes: Buffer.byteLength(discoveryEvidence),
            reason: "token_preflight_same_model_retry",
          });
          attempt--;
          continue;
        }
      }

      const failureMode =
'''
replace_once(executor, anchor, insert, "same-model discovery continuation")

replace_once(
    config,
    '''    implementation: z.number().positive().default(30000),\n''',
    '''    implementation: z.number().positive().default(45000),\n''',
    "implementation timeout default",
)

marker = 'test("agentic worker resets an expensive discovery trajectory before implementation"'
test_text = tests.read_text()
if marker not in test_text:
    test_text += r'''

test("agentic worker resets an expensive discovery trajectory before implementation", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-agentic-real-preflight-"));
  await writeFile(join(root, "target.ts"), "export const value = 1;\n");
  await writeFile(join(root, "context.ts"), "export const clue = 1;\n");

  const events: any[] = [];
  const logger = {
    events,
    log(type: string, payload: any) {
      events.push({ type, ...payload });
    },
  } as any;

  let call = 0;
  let sawFreshImplementationPacket = false;
  let sawMutationOnlyTools = false;

  const worker = new AgenticCodingWorker(
    new Budget(1, 40_000, 60_000),
    logger,
    async (_input, messages, tools) => {
      call++;

      if (call === 1) {
        return {
          model: "mock/model",
          usage: {
            prompt_tokens: 19_243,
            completion_tokens: 2_038,
            cost: 0.001,
          },
          message: {
            content: null,
            tool_calls: [
              {
                id: "read-1",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ path: "target.ts" }),
                },
              },
              {
                id: "read-2",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ path: "context.ts" }),
                },
              },
            ],
          },
        } satisfies AgenticCodingResponse;
      }

      sawFreshImplementationPacket =
        messages.length <= 2 &&
        String((messages[1] as any)?.content ?? "").includes("DISCOVERY EVIDENCE") &&
        String((messages[1] as any)?.content ?? "").includes("IMPLEMENTATION PHASE");

      const names = tools.flatMap((tool) =>
        "function" in tool ? [tool.function.name] : [],
      );
      sawMutationOnlyTools =
        names.includes("edit_file") &&
        names.includes("apply_patch") &&
        names.includes("write_file") &&
        !names.includes("read_file") &&
        !names.includes("search_code");

      return {
        model: "mock/model",
        usage: {
          prompt_tokens: 2_000,
          completion_tokens: 400,
          cost: 0.001,
        },
        message: {
          content: null,
          tool_calls: [
            {
              id: "edit-1",
              type: "function",
              function: {
                name: "edit_file",
                arguments: JSON.stringify({
                  path: "target.ts",
                  oldText: "value = 1",
                  newText: "value = 2",
                }),
              },
            },
          ],
        },
      } satisfies AgenticCodingResponse;
    },
  );

  const result = await worker.run({
    repoPath: root,
    attemptId: "real-preflight",
    task: "Use context.ts and update target.ts",
    model: "mock/model",
    budgetUsd: 0.1,
    maxTokens: 30_000,
    maxSteps: 5,
    timeoutMs: 45_000,
    requestTimeoutMs: 45_000,
    commandTimeoutMs: 5_000,
    maxOutputTokens: 4_096,
    maxToolOutputBytes: 4_000,
    contextWindowTokens: 128_000,
    baseUrl: "http://unused",
    writeScope: ["target.ts"],
    returnOnMutation: true,
    promptPricePerMillion: 1,
    completionPricePerMillion: 1,
  });

  assert.equal(result.exitStatus, "completed");
  assert.deepEqual(result.changedPaths, ["target.ts"]);
  assert.equal(
    await readFile(join(root, "target.ts"), "utf8"),
    "export const value = 2;\n",
  );
  assert.equal(call, 2);
  assert.equal(sawFreshImplementationPacket, true);
  assert.equal(sawMutationOnlyTools, true);
  assert.ok(
    events.some(
      (event) => event.type === "agentic_implementation_context_reset",
    ),
  );
});
'''
    tests.write_text(test_text)
else:
    print("test already present; leaving it unchanged")

print("\nPatched:")
for path in FILES:
    print(" -", path.relative_to(ROOT))

if "--no-test" not in sys.argv:
    print("\nRunning focused regression test...")
    subprocess.run(
        ["pnpm", "exec", "tsx", "--test", "tests/agenticCodingWorker.test.ts"],
        cwd=ROOT,
        check=True,
    )
    print("\nRunning typecheck...")
    subprocess.run(["pnpm", "typecheck"], cwd=ROOT, check=True)

print("\nPATCH COMPLETE")
print("Next: run your real Koda smoke test again.")

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentTools } from "../src/agent/tools.js";
import { Logger } from "../src/telemetry/logger.js";
import { boundMessages, truncateBytes } from "../src/context/bounds.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
test("tool results enforce a byte cap and history trimming preserves paired tool exchanges", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-tool-bound-"));
  try {
    await writeFile(join(root, "large.txt"), "💡".repeat(20000));
    const tools = new AgentTools(
      root,
      false,
      1000,
      new Logger(join(root, "logs"), "bounds", true),
      "worker",
      512,
    );
    const output = await tools.execute("read_file", { path: "large.txt" });
    assert.ok(Buffer.byteLength(output) <= 512);
    assert.ok(output.includes("[truncated]"));
    assert.ok(Buffer.byteLength(truncateBytes("💡".repeat(1000), 512)) <= 512);
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: "rules" },
      { role: "user", content: "original objective" },
      { role: "assistant", content: "old".repeat(1000) },
      { role: "user", content: "old feedback" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "latest",
            type: "function",
            function: { name: "read_file", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "latest", content: "latest result" },
    ];
    boundMessages(messages, 800);
    assert.equal(messages[1]!.content, "original objective");
    assert.equal(messages.length, 4);
    assert.equal(messages[2]!.role, "assistant");
    assert.equal(messages[3]!.role, "tool");
    assert.throws(
      () => boundMessages([{ role: "user", content: "x".repeat(1000) }], 100),
      /context budget/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

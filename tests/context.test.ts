import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentTools } from "../src/agent/tools.js";
import { Logger } from "../src/telemetry/logger.js";
import { boundMessages, truncateBytes } from "../src/context/bounds.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
test("search_code locates a literal symbol with path, line and source snippet", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-symbol-search-"));
  try {
    await writeFile(join(root, "codec.py"), "def to_native_string(value):\n    return value\n");
    const tools = new AgentTools(root, true, 1000, new Logger(join(root, "logs"), "search", true), "worker");
    const result = String(await tools.execute("search_code", { query: "to_native_string" }));
    assert.match(result, /codec\.py:1: def to_native_string\(value\)/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
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

test("discovery excludes backups, caches and nested worktrees without hiding mutation evidence", async () => {
  const { mkdir } = await import("node:fs/promises");
  const { profileRepo } = await import("../src/repo/profiler.js");
  const { snapshotTree } = await import("../src/workspace/files.js");
  const root = await mkdtemp(join(tmpdir(), "koda-discovery-noise-"));
  try {
    for (const file of ["src/answer.js", "src/answer.js.before-repair", "backups/answer.js", ".cache/answer.js", ".worktrees/old/src/answer.js"]) {
      const { dirname } = await import("node:path");
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), "export const requestedAnswer = 42;\n");
    }
    const logger = new Logger(join(root, ".koda"), "discovery-noise", true);
    const tools = new AgentTools(root, true, 1000, logger, "worker");
    assert.equal(String(await tools.execute("list_files", {})), "src/answer.js");
    const hits = String(await tools.execute("search_code", { query: "requestedAnswer" }));
    assert.match(hits, /src\/answer.js/);
    assert.doesNotMatch(hits, /before-repair|backups|\.cache|\.worktrees/);
    assert.deepEqual((await profileRepo(root)).files, ["src/answer.js"]);
    assert.ok((await snapshotTree(root)).files["backups/answer.js"], "Safety snapshots must still detect edits to excluded discovery files");
  } finally { await rm(root, { recursive: true, force: true }); }
});

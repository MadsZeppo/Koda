import type { WriteScope } from "../repo/writeScope.js";
import {
  readFile,
  writeFile,
  mkdir,
  rm,
  realpath,
  readdir,
  lstat,
  open,
} from "node:fs/promises";
import { dirname, resolve, relative, join, isAbsolute } from "node:path";
import { truncateBytes } from "../context/bounds.js";
import { execa } from "execa";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { command, git } from "../repo/commands.js";
import type { Logger } from "../telemetry/logger.js";
import { filesystemDiff, workspaceChanges } from "../workspace/diff.js";
import { changeCode, listWorkspaceFiles } from "../workspace/files.js";
import { createHash } from "node:crypto";
import { nearbyRepoPaths } from "../repo/navigation.js";

/** Find one formatting-equivalent span while preserving current-file offsets. */
function whitespaceEquivalentSpan(content: string, requested: string) {
  if (requested.trim().length < 12) return undefined;
  const needle = requested.trim().replace(/\s+/g, " ");
  if (!needle) return undefined;
  let normalized = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let whitespace = false;
  for (let index = 0; index < content.length; index++) {
    const character = content[index]!;
    if (/\s/.test(character)) {
      if (!normalized.length || whitespace) continue;
      normalized += " "; starts.push(index); ends.push(index + 1); whitespace = true;
    } else {
      normalized += character; starts.push(index); ends.push(index + 1); whitespace = false;
    }
  }
  const first = normalized.indexOf(needle);
  if (first < 0 || normalized.indexOf(needle, first + 1) >= 0) return undefined;
  return { start: starts[first]!, end: ends[first + needle.length - 1]! };
}
export const toolDefinitions: ChatCompletionTool[] = [
  [
    "search_code",
    "Search repository text from the bounded workspace inventory with ripgrep",
    { query: { type: "string" } },
    ["query"],
  ],
  [
    "read_file",
    "Read a repository file; bounded by line range",
    {
      path: { type: "string" },
      startLine: { type: "integer" },
      endLine: { type: "integer" },
    },
    ["path"],
  ],
  ["list_files", "List files from the bounded workspace inventory", {}, []],
  [
    "write_file",
    "Write complete UTF-8 file contents within this worker's immutable allowed_write_paths only",
    { path: { type: "string" }, content: { type: "string" } },
    ["path", "content"],
  ],
  [
    "edit_file",
    "Replace one exact, unique text span in an existing scoped UTF-8 file; preserve all other content",
    {
      path: { type: "string" },
      oldText: { type: "string" },
      newText: { type: "string" },
    },
    ["path", "oldText", "newText"],
  ],
  [
    "apply_patch",
    "Apply exact replacements to existing locked files atomically. Each edit needs path, non-empty oldText occurring exactly once, and newText. Never send createContent, hunks, or delete.",
    { edits: { type: "array", items: { type: "object", properties: {
      path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" },
    }, required: ["path", "oldText", "newText"], additionalProperties: false } } },
    ["edits"],
  ],
  [
    "run_command",
    "Execute shell command in sandbox; writes outside allowed_write_paths are rejected and discarded",
    { command: { type: "string" } },
    ["command"],
  ],
  ["git_diff", "Read current workspace changes", {}, []],
  ["git_status", "Read current workspace change status", {}, []],
].map(([name, description, properties, required]) => ({
  type: "function",
  function: {
    name: name as string,
    description: description as string,
    parameters: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  },
}));
export const requestContextTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "request_context",
    description: "Once only: request a bounded excerpt from one locked file or trusted dependency; choose startLine or an exact symbol when the needed code is later in the file",
    parameters: { type: "object", properties: { path: { type: "string" }, startLine: { type: "integer", minimum: 1 }, symbol: { type: "string" } }, required: ["path"], additionalProperties: false },
  },
};
export async function safePath(root: string, input: string) {
  root = await realpath(root);
  if (
    isAbsolute(input) ||
    input.split(/[\\/]/).some((p) => p === ".." || p === ".git") ||
    input.includes("\0")
  )
    throw Error("Path escapes worktree or accesses git metadata");
  const target = resolve(root, input);
  if (!target.startsWith(root + "/"))
    throw Error("Path must identify a file inside worktree");
  let parent = target;
  while (true) {
    try {
      const actual = await realpath(parent);
      if (actual !== root && !actual.startsWith(root + "/"))
        throw Error("Symlink escapes worktree");
      if (relative(root, actual).split("/").includes(".git"))
        throw Error("Git metadata alias denied");
      break;
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
      parent = dirname(parent);
    }
  }
  return target;
}
export async function currentDiff(root: string) {
  const local = await workspaceChanges(root);
  if (local) return filesystemDiff(root);
  const tracked = await git(root, "diff", "HEAD");
  const untracked = (
    await git(root, "ls-files", "--others", "--exclude-standard")
  )
    .split("\n")
    .filter(Boolean);
  let extra = "";
  for (const p of untracked.slice(0, 30)) {
    try {
      extra += `\nNEW FILE ${p}\n${(await readFile(await safePath(root, p), "utf8")).slice(0, 8000)}`;
    } catch {}
  }
  return (tracked + extra).slice(0, 40000);
}
export class AgentTools {
  readonly actions: string[] = [];
  readonly commandEvidence: unknown[] = [];
  readonly progressEvidence: string[] = [];
  readonly missingReadAttempts = new Map<string, number>();
  constructor(
    readonly root: string,
    readonly readOnly: boolean,
    readonly timeout: number | (() => number),
    readonly logger: Logger,
    readonly subtaskId: string,
    readonly resultBytes = 4000,
    public writeScope?: WriteScope,
    readonly contextPaths: readonly string[] = [],
  ) {}
  private contextRequests = 0;
  async execute(name: string, args: any) {
    const started = Date.now();
    this.actions.push(
      `${name}:${args.path ?? args.command ?? args.query ?? ""}`,
    );
    this.logger.log("tool", {
      subtaskId: this.subtaskId,
      name,
      path: args.path,
      command: args.command,
    });
    let result: unknown;
    let progressKey: string | undefined;
    let searchMatched = false;
    let navigationUseful = true;
    switch (name) {
      case "read_file": {
        const p = await safePath(this.root, args.path);
        let s;
        try { s = await lstat(p); }
        catch (error: any) {
          if (error.code !== "ENOENT") throw error;
          this.missingReadAttempts.set(args.path, (this.missingReadAttempts.get(args.path) ?? 0) + 1);
          const files = await listWorkspaceFiles(this.root);
          const nearby = nearbyRepoPaths(args.path, files);
          const symbol = String(args.path).split("/").at(-1)?.replace(/\.[^.]+$/, "")
            .replace(/^(?:test_|spec_)/, "").replace(/[._-](?:test|spec)$/, "") ?? "";
          let contentMatches: string[] = [];
          if (/^[\w-]{3,80}$/.test(symbol) && files.length) {
            const found = await execa("rg", ["-l", "-F", "--max-filesize", "1M", "--", symbol,
              ...files.slice(0, 200)], { cwd: this.root, reject: false, maxBuffer: 1024 * 1024 });
            if (found.exitCode === 0) contentMatches = found.stdout.split("\n").filter(Boolean).slice(0, 6);
          }
          const candidates = [...new Set([...nearby.map((item) => item.path), ...contentMatches])];
          const source = candidates.find((file) => /\.(?:[cm]?[jt]sx?|py|go|rs|java|rb)$/i.test(file) &&
            !/(?:^|\/)(?:tests?|__tests__)(?:\/|$)/i.test(file));
          let excerpt = "";
          if (source) {
            try {
              const file = await safePath(this.root, source);
              const stat = await lstat(file);
              if (stat.isFile() && stat.nlink === 1) {
                const handle = await open(file, "r");
                try {
                  const bytes = Buffer.alloc(2400);
                  const read = await handle.read(bytes, 0, bytes.length, 0);
                  excerpt = bytes.subarray(0, read.bytesRead).toString("utf8");
                } finally { await handle.close(); }
              }
            }
            catch {}
          }
          navigationUseful = !!source;
          progressKey = `navigation:${args.path}:${source ?? "none"}`;
          result = JSON.stringify({ missingPath: args.path,
            nearbyTree: files.filter((file) => file.startsWith(dirname(args.path) + "/")).slice(0, 20),
            candidateFiles: candidates.slice(0, 6), source, excerpt,
            instruction: source
              ? "Use existing repository paths. The missing path is not a valid read target."
              : "No reliable target found. Do not retry the missing path or invent a write target.",
          });
          this.logger.log("missing_path_navigation", {
            subtaskId: this.subtaskId, path: args.path, candidates: candidates.slice(0, 6), source,
          });
          break;
        }
        if (!s.isFile() || s.size > 1024 * 1024)
          throw Error("Read requires regular file under 1MB");
        const lines = (await readFile(p, "utf8")).split("\n");
        const start = Math.max(0, (args.startLine ?? 1) - 1);
        const end = Math.min(args.endLine ?? start + 250, start + 400);
        result = lines
          .slice(start, end)
          .map((l, i) => `${start + i + 1}: ${l}`)
          .join("\n");
        progressKey = `read_file:${args.path}:${start + 1}:${end}`;
        break;
      }
      case "list_files":
        result = (await listWorkspaceFiles(this.root))
          .join("\n")
          .slice(0, 16000);
        break;
      case "search_code": {
        const files = await listWorkspaceFiles(this.root);
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (!query || query.length > 256) throw Error("Invalid search query");
        const hits: string[] = [];
        let pattern: RegExp | undefined;
        try { pattern = new RegExp(query); } catch { /* Literal search remains available. */ }
        for (const f of files) {
          if (hits.length >= 40) break;
          try {
            const p = await safePath(this.root, f);
            const stat = await lstat(p);
            if (!stat.isFile() || stat.size > 1024 * 1024) continue;
            const source = await readFile(p, "utf8");
            if (source.includes("\0")) continue;
            const lines = source.split("\n");
            for (let index = 0; index < lines.length && hits.length < 40; index++) {
              const line = lines[index]!;
              if (line.includes(query) || pattern?.test(line))
                hits.push(`${f}:${index + 1}: ${line.slice(0, 240)}`);
            }
          } catch {}
        }
        searchMatched = hits.length > 0;
        result = hits.length ? hits.join("\n").slice(0, 16000) : "No matches";
        break;
      }
      case "write_file":
        if (this.readOnly) throw Error("Scout cannot edit");
        if (
          typeof args.content !== "string" ||
          args.content.length > 1024 * 1024
        )
          throw Error("Invalid file content");
        {
          this.writeScope?.attempted(args.path, "write_file");
          const p = this.writeScope
            ? await this.writeScope.target(this.root, args.path)
            : await safePath(this.root, args.path);
          try {
            if ((await lstat(p)).nlink > 1)
              throw Error("Writing hardlinked files is prohibited");
          } catch (e: any) {
            if (e.code !== "ENOENT") throw e;
          }
          await mkdir(dirname(p), { recursive: true });
          await writeFile(p, args.content);
          this.writeScope?.successful(args.path, "write_file");
          result = "written";
          break;
        }
      case "edit_file": {
        if (this.readOnly) throw Error("Scout cannot edit");
        if (
          typeof args.oldText !== "string" ||
          !args.oldText.length ||
          typeof args.newText !== "string"
        )
          throw Error("edit_file requires non-empty oldText and text newText");
        this.writeScope?.attempted(args.path, "edit_file");
        const p = this.writeScope
          ? await this.writeScope.target(this.root, args.path, "edit_file")
          : await safePath(this.root, args.path);
        const info = await lstat(p);
        if (!info.isFile() || info.nlink > 1 || info.size > 1024 * 1024)
          throw Error(
            "edit_file requires a regular non-hardlinked text file under 1MB",
          );
        const bytes = await readFile(p);
        let content: string;
        try {
          content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          throw Error("edit_file requires UTF-8 text");
        }
        if (content.includes("\0"))
          throw Error("edit_file requires text, not binary data");
        let first = content.indexOf(args.oldText);
        let replacedLength = args.oldText.length;
        let refreshed = false;
        if (first < 0) {
          const span = whitespaceEquivalentSpan(content, args.oldText);
          refreshed = true;
          this.logger.log("edit_file_context_refreshed", {
            subtaskId: this.subtaskId, path: args.path,
            recovered: !!span, reason: "oldText_not_found",
          });
          if (!span) throw Error("edit_file oldText was not found after local refresh");
          first = span.start;
          replacedLength = span.end - span.start;
        } else if (content.indexOf(args.oldText, first + 1) >= 0)
          throw Error("edit_file oldText is ambiguous (multiple matches)");
        const updated = content.slice(0, first) +
          args.newText +
          content.slice(first + replacedLength);
        if (updated === content)
          throw Error("edit_file produced no change; re-read the current file before retrying");
        await writeFile(p, updated);
        this.writeScope?.successful(args.path, "edit_file");
        result = refreshed
          ? "edited after refreshing current file and matching formatting-equivalent text"
          : "edited";
        break;
      }
      case "apply_patch": {
        if (this.readOnly) throw Error("Scout cannot edit");
        if (!this.writeScope || !Array.isArray(args.edits) ||
            !args.edits.length || args.edits.length > 8)
          throw Error("apply_patch requires 1-8 scoped edits");
        // Multiple edits to one path are one atomic file update, in order.
        const grouped = new Map<string, any>();
        for (const edit of args.edits) {
          if (typeof edit.path !== "string")
            throw Error("apply_patch requires concrete paths");
          const previous = grouped.get(edit.path);
          if (!previous) { grouped.set(edit.path, { ...edit }); continue; }
          if (previous.delete || previous.createContent !== undefined ||
              edit.delete || edit.createContent !== undefined)
            throw Error("apply_patch cannot combine create/delete with same-path hunks");
          const hunks = (value: any) => value.hunks ??
            [{ oldText: value.oldText, newText: value.newText }];
          grouped.set(edit.path, { path: edit.path, hunks: [...hunks(previous), ...hunks(edit)] });
        }
        const staged: { path: string; target: string; before?: Buffer; after?: string }[] = [];
        const seen = new Set<string>();
        for (const edit of grouped.values()) {
          if (typeof edit.path !== "string" || seen.has(edit.path))
            throw Error("apply_patch requires distinct concrete paths");
          seen.add(edit.path);
          this.writeScope.attempted(edit.path, "apply_patch");
          const target = await this.writeScope.target(this.root, edit.path, "apply_patch");
          let before: Buffer | undefined;
          try {
            const info = await lstat(target);
            if (!info.isFile() || info.nlink > 1 || info.size > 1024 * 1024)
              throw Error("apply_patch requires regular non-hardlinked text files under 1MB");
            before = await readFile(target);
          } catch (error: any) {
            if (error.code !== "ENOENT") throw error;
          }
          if (edit.delete === true) {
            if (!before || edit.createContent !== undefined || edit.hunks || edit.oldText)
              throw Error("apply_patch delete requires one existing file and no hunks");
            staged.push({ path: edit.path, target, before });
            continue;
          }
          if (edit.createContent !== undefined) {
            if (before || typeof edit.createContent !== "string" ||
                edit.createContent.includes("\0") || edit.hunks || edit.oldText)
              throw Error("apply_patch create requires a new text file and no hunks");
            staged.push({ path: edit.path, target, after: edit.createContent });
            continue;
          }
          if (!before) throw Error("apply_patch hunks require an existing file");
          let content = new TextDecoder("utf-8", { fatal: true }).decode(before);
          if (content.includes("\0")) throw Error("apply_patch requires text files");
          const hunks = edit.hunks ?? [{ oldText: edit.oldText, newText: edit.newText }];
          if (!Array.isArray(hunks) || !hunks.length || hunks.length > 20)
            throw Error("apply_patch requires 1-20 exact hunks");
          for (const hunk of hunks) {
            if (typeof hunk.oldText !== "string" || !hunk.oldText.length ||
                typeof hunk.newText !== "string")
              throw Error("apply_patch requires non-empty oldText and text newText");
            let first = content.indexOf(hunk.oldText);
            let replacedLength = hunk.oldText.length;
            if (first < 0) {
              const span = whitespaceEquivalentSpan(content, hunk.oldText);
              this.logger.log("apply_patch_context_refreshed", {
                subtaskId: this.subtaskId, path: edit.path,
                recovered: !!span, reason: "oldText_not_found",
              });
              if (!span) throw Error("apply_patch oldText was not found after local refresh");
              first = span.start;
              replacedLength = span.end - span.start;
            } else if (content.indexOf(hunk.oldText, first + 1) >= 0)
              throw Error("apply_patch oldText must occur exactly once");
            content = content.slice(0, first) + hunk.newText +
              content.slice(first + replacedLength);
          }
          staged.push({ path: edit.path, target, before, after: content });
        }
        const applied: typeof staged = [];
        try {
          for (const edit of staged) {
            if (edit.after === undefined) await rm(edit.target);
            else {
              await mkdir(dirname(edit.target), { recursive: true });
              await writeFile(edit.target, edit.after);
            }
            applied.push(edit);
          }
        } catch (error) {
          for (const edit of applied.reverse()) {
            if (edit.before === undefined) await rm(edit.target, { force: true });
            else await writeFile(edit.target, edit.before);
          }
          throw error;
        }
        for (const edit of staged) this.writeScope.successful(edit.path, "apply_patch");
        result = `patched ${staged.length} file(s)`;
        break;
      }
      case "request_context": {
        if (this.contextRequests++ >= 1 || typeof args.path !== "string" ||
            !this.contextPaths.includes(args.path))
          throw Error("request_context is limited to one trusted locked dependency");
        const target = await safePath(this.root, args.path);
        const info = await lstat(target);
        if (!info.isFile() || info.size > 1024 * 1024)
          throw Error("request_context requires a regular file under 1MB");
        const content = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(target));
        if (content.includes("\0")) throw Error("request_context requires text");
        const lines = content.split("\n");
        if (args.startLine !== undefined && (!Number.isInteger(args.startLine) || args.startLine < 1))
          throw Error("request_context startLine must be a positive integer");
        if (args.symbol !== undefined && (typeof args.symbol !== "string" || !args.symbol.trim()))
          throw Error("request_context symbol must be nonempty text");
        const hit = args.symbol ? lines.findIndex((line) => line.includes(args.symbol)) : -1;
        // `path` is authoritative: a stale or path-shaped symbol must not turn
        // an existing trusted file request into a dead end. Exact symbol hits
        // still center the excerpt as before.
        const start = args.startLine ? args.startLine - 1 : hit >= 0 ? Math.max(0, hit - 8) : 0;
        const excerpt = truncateBytes(lines.slice(start, start + 100).join("\n"), 3200);
        result = args.symbol && hit < 0
          ? `Symbol ${JSON.stringify(args.symbol)} was not found; returning trusted file context.\n${excerpt}`
          : excerpt;
        break;
      }
      case "run_command": {
        const r = await command(
          this.root,
          args.command,
          typeof this.timeout === "function" ? this.timeout() : this.timeout,
          this.readOnly,
          this.writeScope,
        );
        this.commandEvidence.push(r);
        result = r;
        break;
      }
      case "git_diff":
        result = await currentDiff(this.root);
        break;
      case "git_status":
        result =
          (await workspaceChanges(this.root))
            ?.map((change) => `${changeCode(change.type)} ${change.path}`)
            .join("\n") ?? (await git(this.root, "status", "--short"));
        break;
      default:
        throw Error(`Unknown tool ${name}`);
    }
    const text = typeof result === "string" ? result : JSON.stringify(result);
    const nonempty = text.trim() && text !== "No files";
    if (name === "read_file" && nonempty && navigationUseful)
      this.progressEvidence.push(progressKey!);
    else if (name === "search_code" && searchMatched)
      this.progressEvidence.push(
        `search_code:${createHash("sha256").update(text).digest("hex")}`,
      );
    else if (
      name === "run_command" &&
      /^(?:\s*(?:rg|grep|find|cat|head|tail|ls|pwd|sed\s+-n|git\s+(?:diff|status|log|show))\b)/.test(
        args.command,
      ) &&
      ((result as any)?.stdout?.trim() || (result as any)?.stderr?.trim())
    )
      this.progressEvidence.push(
        `inspection:${createHash("sha256")
          .update(
            `${(result as any).stdout ?? ""}\n${(result as any).stderr ?? ""}`,
          )
          .digest("hex")}`,
      );
    this.logger.log("tool_result", {
      subtaskId: this.subtaskId,
      name,
      result: truncateBytes(text, this.resultBytes),
      wallClockMs: Date.now() - started,
    });
    return truncateBytes(text, this.resultBytes);
  }
}

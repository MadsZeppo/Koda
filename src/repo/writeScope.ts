import { constants, createReadStream } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  realpath,
  rm,
  rmdir,
  chmod,
  copyFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, posix, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Logger } from "../telemetry/logger.js";
import type { CommandResult } from "../types.js";

export class WriteScope {
  readonly paths: readonly string[];
  constructor(
    paths: readonly string[],
    readonly logger: Logger,
    readonly subtaskId: string,
  ) {
    if (!paths.length) throw Error("Missing write responsibility");
    this.paths = Object.freeze([
      ...new Set(
        paths.map((p) => {
          if (
            !p ||
            p.startsWith("/") ||
            /[\\\0*?\[\]]/.test(p) ||
            p.split("/").some((s) => s === ".." || s === ".git" || s === ".koda")
          )
            throw Error("Write responsibility requires safe concrete paths");
          return posix.normalize(p).replace(/\/$/, "");
        }),
      ),
    ]);
    Object.freeze(this);
  }
  allows(path: string) {
    if (
      !path ||
      path.startsWith("/") ||
      /[\\\0]/.test(path) ||
      path.split("/").some((s) => s === ".." || s === ".git" || s === ".koda")
    )
      return false;
    path = posix.normalize(path);
    return this.paths.some(
      (p) => p === "." || path === p || path.startsWith(p + "/"),
    );
  }
  violation(paths: string[], source: string) {
    this.logger.log("write_scope_violation", {
      subtaskId: this.subtaskId,
      attempted_write_paths: paths,
      allowed_write_paths: this.paths,
      source,
    });
    return `WRITE_SCOPE_VIOLATION: Rejected ${paths.join(", ")}. This worker may only modify: ${this.paths.join(", ")}. Do not modify sibling files or unassigned tests. Continue only your assigned subtask.`;
  }
  attempted(path: string, source: string) {
    this.logger.log("write_attempt", {
      subtaskId: this.subtaskId,
      path,
      source,
    });
  }
  successful(path: string, source: string) {
    this.logger.log("write_success", {
      subtaskId: this.subtaskId,
      path,
      source,
    });
  }
  async target(root: string, path: string, source = "write_file") {
    if (!this.allows(path)) throw Error(this.violation([path], source));
    root = await realpath(root);
    const target = resolve(root, path);
    if (!target.startsWith(root + "/"))
      throw Error(this.violation([path], "path"));
    // Reject aliases before opening: a permitted filename must not redirect a write.
    for (let current = target; current !== root; current = dirname(current)) {
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1))
          throw Error(this.violation([path], "alias"));
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
      }
    }
    return target;
  }
}
interface Entry {
  type: "file" | "directory" | "symlink" | "other";
  mode: number;
  hash: string;
  linked: boolean;
}
async function inventory(root: string) {
  const result = new Map<string, Entry>();
  async function visit(dir: string) {
    for (const name of await readdir(join(root, dir))) {
      if (!dir && name === ".git") continue;
      const path = posix.join(dir, name),
        full = join(root, path),
        stat = await lstat(full);
      const type = stat.isDirectory()
        ? "directory"
        : stat.isSymbolicLink()
          ? "symlink"
          : stat.isFile()
            ? "file"
            : "other";
      let hash = "";
      if (type === "file") {
        const h = createHash("sha256");
        for await (const chunk of createReadStream(full)) h.update(chunk);
        hash = h.digest("hex");
      } else if (type === "symlink") hash = await readlink(full);
      result.set(path, {
        type,
        mode: stat.mode & 0o777,
        hash,
        linked: type === "file" && stat.nlink > 1,
      });
      if (type === "directory") await visit(path);
    }
  }
  await visit("");
  return result;
}
/** Execute under the existing sandbox in a disposable copy. Never expose the real
 * worker directory as writable, and never copy unauthorized changes back. */
export async function scopedCommand(
  root: string,
  scope: WriteScope,
  execute: (copy: string, remainingMs: number) => Promise<CommandResult>,
  timeoutMs: number,
): Promise<CommandResult> {
  const start = Date.now();
  const staging = await mkdtemp(join(tmpdir(), "koda-command-"));
  const copy = join(staging, "worktree");
  try {
    await cp(root, copy, {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
      verbatimSymlinks: true,
    });
    const before = await inventory(copy);
    const remaining = timeoutMs - (Date.now() - start);
    if (remaining <= 0)
      throw Error("Command budget exhausted during scope snapshot");
    const result = await execute(copy, remaining);
    const after = await inventory(copy);
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
      (p) => JSON.stringify(before.get(p)) !== JSON.stringify(after.get(p)),
    );
    const files = changed.filter(
      (p) => (after.get(p) ?? before.get(p))?.type !== "directory",
    );
    const violations: string[] = [];
    for (const path of changed) {
      scope.attempted(path, "run_command");
      const entry = after.get(path);
      const parentCreation =
        !before.has(path) &&
        entry?.type === "directory" &&
        files.some((f) => f.startsWith(path + "/") && scope.allows(f));
      if (
        (!scope.allows(path) && !parentCreation) ||
        (entry &&
          (entry.type === "symlink" || entry.type === "other" || entry.linked))
      )
        violations.push(path);
    }
    if (violations.length)
      return {
        ...result,
        exitCode: 1,
        stderr: scope.violation(violations, "run_command"),
        wallClockMs: Date.now() - start,
      };
    // Validate all destination paths before copying any result back.
    for (const path of files) {
      await scope.target(root, path);
      if (after.get(path)) await scope.target(copy, path);
    }
    for (const path of changed
      .filter((p) => after.get(p)?.type === "directory")
      .sort((a, b) => a.length - b.length)) {
      if (before.get(path)?.type && before.get(path)?.type !== "directory")
        await rm(join(root, path));
      await mkdir(join(root, path), { recursive: true });
      if (scope.allows(path))
        await chmod(join(root, path), after.get(path)!.mode);
    }
    for (const path of files) {
      const target = await scope.target(root, path),
        entry = after.get(path);
      if (!entry) await rm(target, { force: true });
      else {
        if (before.get(path)?.type === "directory") await rmdir(target);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(join(copy, path), target);
        await chmod(target, entry.mode);
      }
      scope.successful(path, "run_command");
    }
    for (const path of changed
      .filter((p) => !after.has(p) && before.get(p)?.type === "directory")
      .sort((a, b) => b.length - a.length))
      await rmdir(join(root, path));
    return { ...result, wallClockMs: Date.now() - start };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { generatedPath } from "../repo/ecosystem.js";
import { execa } from "execa";

export interface FileRecord {
  hash: string;
  mode: number;
  size: number;
}
export interface Snapshot {
  files: Record<string, FileRecord>;
  fileCount: number;
  totalBytes: number;
  explicitlyIncluded?: string[];
}
export interface FileChange {
  type: "create" | "modify" | "delete";
  path: string;
  beforeHash?: string;
  afterHash?: string;
  beforeMode?: number;
  afterMode?: number;
}
export const changeCode = (type: FileChange["type"]) =>
  type === "create" ? "A" : type === "modify" ? "M" : "D";
export interface SnapshotLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}
export const defaultSnapshotLimits: SnapshotLimits = {
  maxFiles: 20_000,
  maxFileBytes: 100 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
};
const generatedRoots = (paths: ReadonlySet<string>) => {
  const roots = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    for (let length = 1; length <= parts.length; length++) {
      const prefix = parts.slice(0, length).join("/");
      if (generatedPath(prefix)) {
        roots.add(prefix);
        break;
      }
    }
  }
  return roots;
};
const alwaysExcluded = (path: string, includedRoots: ReadonlySet<string>) =>
  path === ".git" ||
  path.startsWith(".git/") ||
  path === ".koda" ||
  path.startsWith(".koda/") ||
  (generatedPath(path) &&
    ![...includedRoots].some(
      (root) => path === root || path.startsWith(root + "/") || root.startsWith(path + "/"),
    ));
const secretPath = (path: string) => {
  const name = path.split("/").at(-1)!.toLowerCase();
  return (
    name === ".env" ||
    name.startsWith(".env.") ||
    /(?:credentials|secrets?)\.(?:json|ya?ml|toml)$/.test(name) ||
    /\.(?:pem|key|p12|pfx)$/.test(name)
  );
};
const safeRelative = (path: string) =>
  !!path &&
  !path.startsWith("/") &&
  !path.includes("\\") &&
  !path.includes("\0") &&
  !path.split("/").some((part) => part === ".." || part === ".git");
const hash = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex");

/** Bounded, deterministic traversal. Unsafe links are rejected, never followed. */
export async function snapshotTree(
  root: string,
  limits = defaultSnapshotLimits,
  explicitlyIncluded: ReadonlySet<string> = new Set(),
): Promise<Snapshot> {
  root = resolve(root);
  const files: Record<string, FileRecord> = {};
  const includedRoots = generatedRoots(explicitlyIncluded);
  let fileCount = 0,
    totalBytes = 0;
  async function visit(relative: string) {
    const entries = await readdir(join(root, relative), { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = posix.join(relative, entry.name);
      if (alwaysExcluded(path, includedRoots)) continue;
      const full = join(root, path);
      const stat = await lstat(full);
      if (stat.isSymbolicLink())
        throw Error(`Unsafe workspace topology: symlink ${path}`);
      if (stat.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!stat.isFile())
        throw Error(`Unsafe workspace topology: non-regular file ${path}`);
      if (stat.nlink > 1)
        throw Error(`Unsafe workspace topology: hardlink ${path}`);
      if (stat.size > limits.maxFileBytes)
        throw Error(`Workspace snapshot limit exceeded: file_size path=${path}`);
      fileCount++;
      totalBytes += stat.size;
      if (fileCount > limits.maxFiles)
        throw Error("Workspace snapshot limit exceeded: file_count");
      if (totalBytes > limits.maxTotalBytes)
        throw Error("Workspace snapshot limit exceeded: total_bytes");
      files[path] = {
        hash: hash(await readFile(full)),
        mode: stat.mode & 0o777,
        size: stat.size,
      };
    }
  }
  await visit("");
  return {
    files,
    fileCount,
    totalBytes,
    explicitlyIncluded: [...explicitlyIncluded],
  };
}

export function changesBetween(before: Snapshot, after: Snapshot): FileChange[] {
  return [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])]
    .sort()
    .flatMap((path): FileChange[] => {
      const a = before.files[path],
        b = after.files[path];
      if (!a && b)
        return [
          { type: "create", path, afterHash: b.hash, afterMode: b.mode },
        ];
      if (a && !b)
        return [
          { type: "delete", path, beforeHash: a.hash, beforeMode: a.mode },
        ];
      if (a && b && (a.hash !== b.hash || a.mode !== b.mode))
        return [
          {
            type: "modify",
            path,
            beforeHash: a.hash,
            afterHash: b.hash,
            beforeMode: a.mode,
            afterMode: b.mode,
          },
        ];
      return [];
    });
}

export async function copySnapshot(
  source: string,
  target: string,
  explicitlyIncluded: ReadonlySet<string> = new Set(),
) {
  const snapshot = await snapshotTree(
    source,
    defaultSnapshotLimits,
    explicitlyIncluded,
  );
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  for (const [path, entry] of Object.entries(snapshot.files)) {
    const destination = join(target, path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(source, path), destination);
    await chmod(destination, entry.mode);
  }
  const copied = await snapshotTree(
    target,
    defaultSnapshotLimits,
    explicitlyIncluded,
  );
  if (changesBetween(snapshot, copied).length)
    throw Error("Workspace changed while its snapshot was being copied");
  return snapshot;
}

export async function applyChangeFiles(
  source: string,
  target: string,
  changes: FileChange[],
) {
  for (const change of changes) {
    const destination = join(target, change.path);
    if (change.type === "delete") {
      await rm(destination, { force: true });
      continue;
    }
    await mkdir(dirname(destination), { recursive: true });
    const temporary = join(
      dirname(destination),
      `.koda-${randomUUID()}.tmp`,
    );
    await copyFile(join(source, change.path), temporary);
    await chmod(temporary, change.afterMode ?? 0o644);
    await rename(temporary, destination);
  }
}

export function validateChangePaths(changes: FileChange[]) {
  for (const change of changes)
    if (!safeRelative(change.path)) throw Error(`Unsafe change path: ${change.path}`);
}

/** One bounded file listing API for profiles, tools and both workspace modes. */
export async function listWorkspaceFiles(root: string) {
  root = resolve(root);
  const repository = await execa("git", ["rev-parse", "--show-toplevel"], {
    cwd: root,
    reject: false,
    env: { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  }).catch(() => undefined);
  if (repository?.exitCode === 0) {
    const top = await realpath(repository.stdout.trim());
    if (top === (await realpath(root))) {
      const [tracked, untracked] = await Promise.all([
        execa("git", ["ls-files", "-z"], { cwd: root }),
        execa("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
          cwd: root,
        }),
      ]);
      return [...new Set((tracked.stdout + "\0" + untracked.stdout).split("\0"))]
        .filter((path) => path && !generatedPath(path) && !secretPath(path))
        .slice(0, defaultSnapshotLimits.maxFiles);
    }
  }
  return Object.keys((await snapshotTree(root)).files).filter(
    (path) => !secretPath(path),
  );
}

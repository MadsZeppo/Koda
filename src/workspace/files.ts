import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { generatedPath } from "../repo/ecosystem.js";
import { execa } from "execa";

export interface FileRecord {
  hash: string;
  mode: number;
  size: number;
  linkTarget?: string;
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

const pathWithin = (root: string, target: string) => {
  const candidate = relative(root, target);
  return (
    candidate === "" ||
    (!isAbsolute(candidate) &&
      candidate !== ".." &&
      !candidate.startsWith(`..${sep}`))
  );
};

const pointsIntoGit = (root: string, target: string) => {
  const candidate = relative(root, target).split(sep).join("/");
  return candidate === ".git" || candidate.startsWith(".git/");
};

/**
 * Bounded, deterministic traversal.
 * Relative symlinks are accepted only when both their lexical and canonical
 * targets remain inside the repository. Symlinks are recorded, never traversed.
 */
export async function snapshotTree(
  root: string,
  limits = defaultSnapshotLimits,
  explicitlyIncluded: ReadonlySet<string> = new Set(),
): Promise<Snapshot> {
  root = resolve(root);
  const canonicalRoot = await realpath(root);
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
      if (stat.isSymbolicLink()) {
        let linkTarget: string;
        try {
          linkTarget = await readlink(full);
        } catch {
          throw Error(`Unsafe workspace topology: symlink ${path}`);
        }

        const lexicalTarget = resolve(dirname(full), linkTarget);
        if (
          isAbsolute(linkTarget) ||
          !pathWithin(root, lexicalTarget) ||
          pointsIntoGit(root, lexicalTarget)
        ) {
          throw Error(`Unsafe workspace topology: symlink ${path}`);
        }

        let canonicalTarget: string;
        try {
          canonicalTarget = await realpath(full);
        } catch {
          // Broken links and symlink loops are unsafe.
          throw Error(`Unsafe workspace topology: symlink ${path}`);
        }

        if (
          !pathWithin(canonicalRoot, canonicalTarget) ||
          pointsIntoGit(canonicalRoot, canonicalTarget)
        ) {
          throw Error(`Unsafe workspace topology: symlink ${path}`);
        }

        const linkSize = Buffer.byteLength(linkTarget);
        if (linkSize > limits.maxFileBytes)
          throw Error(`Workspace snapshot limit exceeded: file_size path=${path}`);

        fileCount++;
        totalBytes += linkSize;
        if (fileCount > limits.maxFiles)
          throw Error("Workspace snapshot limit exceeded: file_count");
        if (totalBytes > limits.maxTotalBytes)
          throw Error("Workspace snapshot limit exceeded: total_bytes");

        files[path] = {
          hash: hash(Buffer.from(linkTarget)),
          mode: stat.mode & 0o777,
          size: linkSize,
          linkTarget,
        };
        continue;
      }
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
      if (
        a &&
        b &&
        (a.hash !== b.hash ||
          a.mode !== b.mode ||
          a.linkTarget !== b.linkTarget)
      )
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
    if (entry.linkTarget !== undefined) {
      const currentTarget = await readlink(join(source, path));
      if (currentTarget !== entry.linkTarget)
        throw Error("Workspace changed while its snapshot was being copied");
      await symlink(entry.linkTarget, destination);
      continue;
    }
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
    const sourcePath = join(source, change.path);
    const sourceStat = await lstat(sourcePath);
    if (sourceStat.isSymbolicLink())
      throw Error(`Unsafe workspace mutation: symlink ${change.path}`);
    const temporary = join(
      dirname(destination),
      `.koda-${randomUUID()}.tmp`,
    );
    await copyFile(sourcePath, temporary);
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

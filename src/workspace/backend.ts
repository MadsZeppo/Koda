import {
  copyFile,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { execa } from "execa";
import type { Logger } from "../telemetry/logger.js";
import { git } from "../repo/commands.js";
import { Worktrees } from "../worktrees/manager.js";
import { Integrator } from "../integration/integrator.js";
import {
  applyChangeFiles,
  changesBetween,
  copySnapshot,
  snapshotTree,
  validateChangePaths,
  type FileChange,
  type Snapshot,
} from "./files.js";
import {
  registerWorkspaceBaseline,
  unregisterWorkspace,
  workspaceChanges,
} from "./diff.js";

export type WorkspaceState = "clean_git" | "dirty_git" | "non_git";
export interface WorkspaceInstance {
  path: string;
  branch?: string;
  baseline?: Snapshot;
}
export interface WorkspaceRevision {
  instance: WorkspaceInstance;
  commit?: string;
  changes: FileChange[];
}
export interface WorkspaceBackend {
  readonly mode: "git" | "filesystem";
  readonly state: WorkspaceState;
  readonly originalRoot: string;
  readonly baseline: Snapshot;
  readonly baselinePath: string;
  readonly applyRequested: boolean;
  readonly stats: {
    files: number;
    bytes: number;
    preexistingModified: number;
    preexistingUntracked: number;
  };
  initialize(): Promise<WorkspaceInstance>;
  createWorker(name: string): Promise<WorkspaceInstance>;
  finalizeWorker(instance: WorkspaceInstance, message: string): Promise<WorkspaceRevision>;
  integrate(
    revision: WorkspaceRevision,
    subtaskId: string,
    resolveConflict?: (paths: string[]) => Promise<void>,
  ): Promise<void>;
  cleanupWorker(instance: WorkspaceInstance): Promise<void>;
  changes(path: string): Promise<FileChange[]>;
  conflictContext(revision: WorkspaceRevision): Promise<unknown>;
  apply(
    output: string,
    integration: WorkspaceInstance,
    verified: boolean,
  ): Promise<ApplyResult>;
}
export interface ApplyResult {
  requested: boolean;
  status: "preview" | "applied" | "conflict" | "not_verified";
  conflicts: string[];
  changes: FileChange[];
}

async function detectState(root: string) {
  const result = await execa("git", ["rev-parse", "--show-toplevel"], {
    cwd: root,
    reject: false,
    env: { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  }).catch(() => undefined);
  if (!result) return { state: "non_git" as const, isGit: false };
  if (result.exitCode !== 0) return { state: "non_git" as const, isGit: false };
  const top = await realpath(result.stdout.trim());
  if (top !== root) return { state: "non_git" as const, isGit: false };
  const status = await git(root, "status", "--porcelain", "--untracked-files=all");
  return {
    state: status ? ("dirty_git" as const) : ("clean_git" as const),
    status,
    isGit: true,
  };
}
const counts = (status = "") => ({
  preexistingModified: status
    .split("\n")
    .filter((line) => line && !line.startsWith("??")).length,
  preexistingUntracked: status
    .split("\n")
    .filter((line) => line.startsWith("??")).length,
});

abstract class BaseBackend implements WorkspaceBackend {
  abstract readonly mode: "git" | "filesystem";
  abstract initialize(): Promise<WorkspaceInstance>;
  abstract createWorker(name: string): Promise<WorkspaceInstance>;
  abstract finalizeWorker(instance: WorkspaceInstance, message: string): Promise<WorkspaceRevision>;
  abstract integrate(revision: WorkspaceRevision, subtaskId: string): Promise<void>;
  abstract cleanupWorker(instance: WorkspaceInstance): Promise<void>;
  constructor(
    readonly state: WorkspaceState,
    readonly originalRoot: string,
    readonly directory: string,
    readonly logger: Logger,
    readonly baseline: Snapshot,
    readonly baselinePath: string,
    readonly stats: WorkspaceBackend["stats"],
    readonly applyRequested: boolean,
    readonly requestedBaseCommit?: string,
    readonly explicitlyIncluded: ReadonlySet<string> = new Set(),
  ) {}
  async changes(path: string) {
    return changesBetween(
      this.baseline,
      await snapshotTree(path, undefined, this.explicitlyIncluded),
    );
  }
  async apply(
    output: string,
    integration: WorkspaceInstance,
    verified: boolean,
  ): Promise<ApplyResult> {
    const changes = await this.changes(integration.path);
    validateChangePaths(changes);
    await writeApplyArtifact(output, this, integration.path, changes, false);
    if (!verified) {
      await updateArtifact(output, { applyStatus: "not_verified" });
      return {
        requested: this.applyRequested,
        status: "not_verified",
        conflicts: [],
        changes,
      };
    }
    if (!this.applyRequested)
      return { requested: false, status: "preview", conflicts: [], changes };
    const current = await snapshotTree(
      this.originalRoot,
      undefined,
      this.explicitlyIncluded,
    );
    const conflicts = changes
      .filter((change) => {
        const baseline = this.baseline.files[change.path];
        const now = current.files[change.path];
        return baseline
          ? !now || now.hash !== baseline.hash || now.mode !== baseline.mode
          : !!now;
      })
      .map((change) => change.path);
    if (conflicts.length) {
      await updateArtifact(output, { applied: false, applyStatus: "conflict", applyConflicts: conflicts });
      return { requested: true, status: "conflict", conflicts, changes };
    }
    await applyChangeFiles(integration.path, this.originalRoot, changes);
    await updateArtifact(output, { applied: true, applyStatus: "applied", applyConflicts: [] });
    return { requested: true, status: "applied", conflicts: [], changes };
  }
  async conflictContext(revision: WorkspaceRevision): Promise<unknown> {
    return { incomingChanges: revision.changes };
  }
}

class GitBackend extends BaseBackend {
  readonly mode = "git" as const;
  private manager: Worktrees;
  private integrator?: Integrator;
  private integration?: WorkspaceInstance;
  private baseCommit = "";
  constructor(...args: ConstructorParameters<typeof BaseBackend>) {
    super(...args);
    this.manager = new Worktrees(this.originalRoot, this.directory, this.logger.runId);
  }
  async initialize() {
    this.baseCommit = await git(
      this.originalRoot,
      "rev-parse",
      "--verify",
      `${this.requestedBaseCommit ?? "HEAD"}^{commit}`,
    );
    this.integration = await this.manager.create("integration", this.baseCommit);
    this.integrator = new Integrator(this.integration.path, this.logger);
    return this.integration;
  }
  async createWorker(name: string) {
    const base = await this.integrator!.exclusive(() =>
      git(this.integration!.path, "rev-parse", "HEAD"),
    );
    return this.manager.create(name, base);
  }
  async finalizeWorker(instance: WorkspaceInstance, message: string) {
    const before = await git(instance.path, "rev-parse", "HEAD");
    const commit = await this.manager.commit(instance.path, message);
    return { instance, commit, changes: commit === before ? [] : await this.changes(instance.path) };
  }
  async integrate(
    revision: WorkspaceRevision,
    subtaskId: string,
    resolveConflict?: (paths: string[]) => Promise<void>,
  ) {
    if (!revision.commit || !revision.changes.length) return;
    await this.integrator!.merge(
      revision.commit,
      subtaskId,
      resolveConflict ?? (async () => {
        throw Error("Git integration conflict requires a resolver");
      }),
    );
  }
  async cleanupWorker(instance: WorkspaceInstance) {
    await this.manager.cleanup(instance.path);
  }
  async conflictContext(revision: WorkspaceRevision) {
    return {
      incoming: revision.commit
        ? await git(this.originalRoot, "show", revision.commit)
        : "",
      integrated: this.integration
        ? await git(this.integration.path, "diff", "--cc")
        : "",
    };
  }
}

class FilesystemBackend extends BaseBackend {
  readonly mode = "filesystem" as const;
  private integration?: WorkspaceInstance;
  private tail: Promise<unknown> = Promise.resolve();
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn);
    this.tail = next.catch(() => {});
    return next;
  }
  async initialize() {
    const path = join(this.directory, "integration");
    await copySnapshot(this.baselinePath, path, this.explicitlyIncluded);
    this.integration = { path, baseline: this.baseline };
    await registerWorkspaceBaseline(path, this.baseline);
    return this.integration;
  }
  async createWorker(name: string) {
    if (!/^[\w-]+$/.test(name)) throw Error("Invalid workspace name");
    return this.exclusive(async () => {
      const path = join(this.directory, "workers", name);
      const baseline = await copySnapshot(
        this.integration!.path,
        path,
        this.explicitlyIncluded,
      );
      const instance = { path, baseline };
      await registerWorkspaceBaseline(path, baseline);
      return instance;
    });
  }
  async finalizeWorker(instance: WorkspaceInstance, _message: string) {
    return {
      instance,
      changes: changesBetween(
        instance.baseline!,
        await snapshotTree(instance.path, undefined, this.explicitlyIncluded),
      ),
    };
  }
  async integrate(revision: WorkspaceRevision, subtaskId: string) {
    if (!revision.changes.length) return;
    await this.exclusive(async () => {
      validateChangePaths(revision.changes);
      const current = await snapshotTree(
        this.integration!.path,
        undefined,
        this.explicitlyIncluded,
      );
      const conflicts = revision.changes.filter((change) => {
        const workerBase = revision.instance.baseline!.files[change.path];
        const now = current.files[change.path];
        return workerBase
          ? !now || now.hash !== workerBase.hash || now.mode !== workerBase.mode
          : !!now;
      });
      if (conflicts.length)
        throw Error(
          `Filesystem integration conflict: ${conflicts.map((c) => c.path).join(", ")}`,
        );
      await applyChangeFiles(revision.instance.path, this.integration!.path, revision.changes);
      this.logger.log("integrated", {
        subtaskId,
        changes: revision.changes.map((c) => c.path),
      });
    });
  }
  async cleanupWorker(instance: WorkspaceInstance) {
    await unregisterWorkspace(instance.path);
    await rm(instance.path, { recursive: true, force: true });
  }
}

export async function createWorkspaceBackend(
  root: string,
  directory: string,
  logger: Logger,
  applyRequested: boolean,
  baseCommit?: string,
) {
  root = await realpath(resolve(root));
  const detected = await detectState(root);
  await mkdir(directory, { recursive: true });
  const baselinePath = join(directory, "baseline");
  const explicitlyIncluded = detected.isGit
    ? new Set(
        (await git(root, "ls-files", "-z")).split("\0").filter(Boolean),
      )
    : new Set<string>();
  const baseline = await copySnapshot(root, baselinePath, explicitlyIncluded);
  const dirty = counts(detected.status);
  const stats = {
    files: baseline.fileCount,
    bytes: baseline.totalBytes,
    ...dirty,
  };
  const args = [
    detected.state,
    root,
    directory,
    logger,
    baseline,
    baselinePath,
    stats,
    applyRequested,
    baseCommit,
    explicitlyIncluded,
  ] as const;
  return detected.isGit && detected.state === "clean_git"
    ? new GitBackend(...args)
    : new FilesystemBackend(...args);
}

async function writeApplyArtifact(
  output: string,
  backend: WorkspaceBackend,
  integration: string,
  changes: FileChange[],
  applied: boolean,
) {
  const workspace = join(output, "workspace");
  for (const change of changes) {
    if (change.type !== "create") {
      const target = join(workspace, "before", change.path);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(backend.baselinePath, change.path), target);
    }
    if (change.type !== "delete") {
      const target = join(workspace, "after", change.path);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(integration, change.path), target);
    }
  }
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, "workspace.json"),
    JSON.stringify(
      {
        version: 1,
        workspaceMode: backend.mode,
        workspaceState: backend.state,
        originalRoot: backend.originalRoot,
        baselineStats: backend.stats,
        changes,
        applied,
        applyRequested: backend.applyRequested,
        applyStatus: backend.applyRequested ? "pending" : "preview",
        applyConflicts: [],
        revertStatus: "not_requested",
        revertConflicts: [],
      },
      null,
      2,
    ),
  );
}
async function updateArtifact(output: string, values: Record<string, unknown>) {
  const path = join(output, "workspace.json");
  const artifact = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...artifact, ...values }, null, 2));
}

export async function revertWorkspaceRun(output: string) {
  output = await realpath(resolve(output));
  const artifactPath = join(output, "workspace.json");
  const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
  if (!artifact.applied) throw Error("Run changes are not applied");
  const root = await realpath(artifact.originalRoot);
  const affected = new Set(
    (artifact.changes as FileChange[]).map((change) => change.path),
  );
  const current = await snapshotTree(root, undefined, affected);
  const conflicts = (artifact.changes as FileChange[])
    .filter((change) => {
      const now = current.files[change.path];
      return change.afterHash ? !now || now.hash !== change.afterHash : !!now;
    })
    .map((change) => change.path);
  if (conflicts.length) {
    await updateArtifact(output, { revertStatus: "conflict", revertConflicts: conflicts });
    await updateSummaryRevert(output, "conflict", conflicts);
    return { status: "REVERT_CONFLICT" as const, conflicts };
  }
  const inverse = (artifact.changes as FileChange[]).map((change): FileChange =>
    change.type === "create"
      ? { type: "delete", path: change.path, beforeHash: change.afterHash }
      : change.type === "delete"
        ? { type: "create", path: change.path, afterHash: change.beforeHash, afterMode: change.beforeMode }
        : {
            type: "modify",
            path: change.path,
            beforeHash: change.afterHash,
            afterHash: change.beforeHash,
            beforeMode: change.afterMode,
            afterMode: change.beforeMode,
          },
  );
  await applyChangeFiles(join(output, "workspace", "before"), root, inverse);
  await updateArtifact(output, { applied: false, revertStatus: "reverted", revertConflicts: [] });
  await updateSummaryRevert(output, "reverted", []);
  return { status: "REVERTED" as const, conflicts: [] };
}

/** Apply a previously verified preview after the user has inspected its artifact. */
export async function applyWorkspaceRun(output: string) {
  output = await realpath(resolve(output));
  const artifact = JSON.parse(
    await readFile(join(output, "workspace.json"), "utf8"),
  );
  const summary = JSON.parse(
    await readFile(join(output, "summary.json"), "utf8"),
  );
  if (summary.status !== "VERIFIED_SUCCESS" || artifact.applyStatus !== "preview")
    throw Error("Only a verified, unapplied preview can be applied");
  const root = await realpath(artifact.originalRoot);
  const changes = artifact.changes as FileChange[];
  validateChangePaths(changes);
  const affected = new Set(changes.map((change) => change.path));
  const current = await snapshotTree(root, undefined, affected);
  const conflicts = changes
    .filter((change) => {
      const now = current.files[change.path];
      return change.beforeHash
        ? !now || now.hash !== change.beforeHash || now.mode !== change.beforeMode
        : !!now;
    })
    .map((change) => change.path);
  if (conflicts.length) {
    await updateArtifact(output, {
      applied: false,
      applyRequested: true,
      applyStatus: "conflict",
      applyConflicts: conflicts,
    });
    await updateSummaryApply(output, "conflict", conflicts);
    return { status: "APPLY_CONFLICT" as const, conflicts, changes };
  }
  await applyChangeFiles(join(output, "workspace", "after"), root, changes);
  await updateArtifact(output, {
    applied: true,
    applyRequested: true,
    applyStatus: "applied",
    applyConflicts: [],
  });
  await updateSummaryApply(output, "applied", []);
  return { status: "APPLIED" as const, conflicts: [], changes };
}

async function updateSummaryApply(
  output: string,
  status: "applied" | "conflict",
  conflicts: string[],
) {
  const path = join(output, "summary.json");
  const summary = JSON.parse(await readFile(path, "utf8"));
  await writeFile(
    path,
    JSON.stringify(
      {
        ...summary,
        applyRequested: true,
        applyResult: status,
        applyConflicts: conflicts,
      },
      null,
      2,
    ),
  );
}

async function updateSummaryRevert(
  output: string,
  status: "reverted" | "conflict",
  conflicts: string[],
) {
  const path = join(output, "summary.json");
  try {
    const summary = JSON.parse(await readFile(path, "utf8"));
    await writeFile(
      path,
      JSON.stringify(
        { ...summary, revertStatus: status, revertConflicts: conflicts },
        null,
        2,
      ),
    );
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
}

export async function workspaceChangedPaths(path: string) {
  return (await workspaceChanges(path))?.map((c) => c.path);
}

import {
  copyFile,
  lstat,
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
import { verifyAppliedRepository } from './verification.js';
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
  persistCandidate(output: string, integration: WorkspaceInstance): Promise<FileChange[]>;
  conflictContext(revision: WorkspaceRevision): Promise<unknown>;
  apply(
    output: string,
    integration: WorkspaceInstance,
    verified: boolean,
    acceptedChanges?: FileChange[],
  ): Promise<ApplyResult>;
}
export interface ApplyResult {
  requested: boolean;
  status: "preview" | "applied" | "conflict" | "not_verified" | "verification_failed";
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
  const revision = await execa("git", ["rev-parse", "--verify", "HEAD"], { cwd: root, reject: false });
  return {
    hasHead: revision.exitCode === 0,
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
    acceptedChanges?: FileChange[],
  ): Promise<ApplyResult> {
    const changes = await this.persistCandidate(output, integration);
    if (verified && acceptedChanges && JSON.stringify(changes) !== JSON.stringify(acceptedChanges))
      throw Error('Verified integration changed before apply');
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
    for (const change of changes.filter((change) => change.type === 'create')) {
      if (await lstat(join(this.originalRoot, change.path)).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
      })) if (!conflicts.includes(change.path)) conflicts.push(change.path);
    }
    if (conflicts.length) {
      await updateArtifact(output, { applied: false, applyStatus: "conflict", applyConflicts: conflicts });
      return { requested: true, status: "conflict", conflicts, changes };
    }
    await assertCandidateMatches(integration.path, changes);
    await applyVerifiedChanges(output, integration.path, this.originalRoot, changes);
    const applied = await snapshotTree(this.originalRoot, undefined, this.explicitlyIncluded);
    const accepted = await this.changes(integration.path);
    if (JSON.stringify(accepted) !== JSON.stringify(changes) || changes.some((change) => {
      const actual = applied.files[change.path];
      return change.type === "delete" ? !!actual :
        !actual || actual.hash !== change.afterHash || actual.mode !== change.afterMode;
    })) throw Error("Applied target does not match the accepted verified integration state");
    await updateArtifact(output, { applied: true, applyStatus: "applied", applyConflicts: [] });
    return { requested: true, status: "applied", conflicts: [], changes };
  }
  async persistCandidate(output: string, integration: WorkspaceInstance) {
    const changes = await this.changes(integration.path);
    validateChangePaths(changes);
    await writeApplyArtifact(output, this, integration.path, changes, false);
    return changes;
  }
  async conflictContext(revision: WorkspaceRevision): Promise<unknown> {
    return { incomingChanges: revision.changes };
  }
}

class GitBackend extends BaseBackend {
  readonly mode = "git" as const;
  private readonly worktreeBaselines = new Map<string, Snapshot>();
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
    this.worktreeBaselines.set(this.integration.path,
      await snapshotTree(this.integration.path, undefined, this.explicitlyIncluded));
    this.integrator = new Integrator(this.integration.path, this.logger);
    return this.integration;
  }
  override async changes(path: string) {
    return changesBetween(
      this.worktreeBaselines.get(path) ?? this.baseline,
      await snapshotTree(path, undefined, this.explicitlyIncluded),
    );
  }
  async createWorker(name: string) {
    const base = await this.integrator!.exclusive(() =>
      git(this.integration!.path, "rev-parse", "HEAD"),
    );
    const worker = await this.manager.create(name, base);
    this.worktreeBaselines.set(worker.path,
      await snapshotTree(worker.path, undefined, this.explicitlyIncluded));
    return worker;
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
    this.worktreeBaselines.delete(instance.path);
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
  return detected.isGit && detected.hasHead && detected.state === "clean_git"
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
  await rm(join(workspace, "before"), { recursive: true, force: true });
  await rm(join(workspace, "after"), { recursive: true, force: true });
  await mkdir(join(workspace, "before"), { recursive: true });
  await mkdir(join(workspace, "after"), { recursive: true });
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
  if (changes.length) {
    const baseline = await realpath(join(workspace, "before"));
    const candidate = await realpath(join(workspace, "after"));
    let diff = await execa(
      "git",
      [
        "diff",
        "--no-index",
        "--binary",
        "--no-renames",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--",
        baseline,
        candidate,
      ],
      { reject: false, maxBuffer: 16 * 1024 * 1024 },
    ).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (diff?.code === 'ENOENT') diff = undefined;
    if (diff && diff.exitCode !== 0 && diff.exitCode !== 1)
      throw Error(`Candidate patch generation failed: ${diff.stderr}`);
    const normalized = diff ? diff.stdout
      .replaceAll(`a${baseline}/`, "a/")
      .replaceAll(`b${candidate}/`, "b/")
      .replaceAll(`a/${baseline.replace(/^\//, "")}/`, "a/")
      .replaceAll(`b/${candidate.replace(/^\//, "")}/`, "b/")
      : await filesystemCandidatePatch(baseline, candidate, changes);
    await writeFile(join(output, "candidate.patch"), normalized + (normalized.endsWith("\n") ? "" : "\n"));
  }
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
        candidateProduced: changes.length > 0,
        candidatePatchPath: changes.length ? join(output, "candidate.patch") : null,
        candidateChangedFiles: changes.map((change) => change.path),
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

async function filesystemCandidatePatch(before: string, after: string, changes: FileChange[]) {
  const patches: string[] = [];
  for (const change of changes) {
    const a = change.type === 'create' ? Buffer.alloc(0) : await readFile(join(before, change.path));
    const b = change.type === 'delete' ? Buffer.alloc(0) : await readFile(join(after, change.path));
    const header = `diff --git a/${change.path} b/${change.path}\n`;
    if ([a, b].some((bytes) => bytes.includes(0) || !Buffer.from(bytes.toString('utf8')).equals(bytes))) {
      patches.push(`${header}Binary files differ; exact before/after bytes are preserved in workspace/\n`);
      continue;
    }
    const lines = (bytes: Buffer) => bytes.length ? bytes.toString('utf8').replace(/\n$/, '').split('\n') : [];
    const old = lines(a), next = lines(b);
    const body = (rows: string[], prefix: string, bytes: Buffer) => rows.map((row, index) =>
      `${prefix}${row}\n${index === rows.length - 1 && !bytes.toString('utf8').endsWith('\n') ? '\\ No newline at end of file\n' : ''}`).join('');
    patches.push(`${header}--- ${change.type === 'create' ? '/dev/null' : `a/${change.path}`}\n` +
      `+++ ${change.type === 'delete' ? '/dev/null' : `b/${change.path}`}\n` +
      `@@ -${old.length ? 1 : 0},${old.length} +${next.length ? 1 : 0},${next.length} @@\n` + body(old, '-', a) + body(next, '+', b));
  }
  return patches.join('');
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
  for (const change of changes.filter((change) => change.type === 'create')) {
    if (await lstat(join(root, change.path)).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    })) if (!conflicts.includes(change.path)) conflicts.push(change.path);
  }
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
  await assertCandidateMatches(join(output, "workspace", "after"), changes);
  await applyVerifiedChanges(output, join(output, "workspace", "after"), root, changes);
  await assertCandidateMatches(root, changes);
  await updateArtifact(output, {
    applied: true,
    applyRequested: true,
    applyStatus: "applied",
    applyConflicts: [],
  });
  await updateSummaryApply(output, "applied", []);
  if (summary.verification) {
    let verification;
    try {
      verification = await verifyAppliedRepository(root, summary.verification, summary.applyVerificationTimeoutMs ?? 120_000, undefined, changes);
      await assertCandidateMatches(root, changes);
    } catch (error) {
      await updateArtifact(output, { applyStatus: 'verification_failed', applyError: String(error) });
      const rollback = await rollbackAppliedRun(output);
      await writeFile(join(output, 'summary.json'), JSON.stringify({ ...summary,
        status: 'NOT_FULLY_VERIFIED', applyRequested: true, applyResult: 'verification_failed',
        applyRollback: rollback, revertStatus: rollback.status === 'REVERTED' ? 'reverted' : 'conflict',
        revertConflicts: rollback.conflicts,
        error: `Applied repository verification failed: ${String(error)}`,
      }, null, 2));
      return { status: 'APPLY_VERIFICATION_FAILED' as const, conflicts: [], changes };
    }
    const rollback = verification.status !== 'VERIFIED_SUCCESS' ? await rollbackAppliedRun(output) : undefined;
    await writeFile(join(output, 'summary.json'), JSON.stringify({ ...summary,
      status: verification.status, verification, applyRequested: true,
      applyResult: verification.status === 'VERIFIED_SUCCESS' ? 'applied' : 'verification_failed',
      applyConflicts: [], appliedVerification: verification,
      ...(rollback ? { applyRollback: rollback, revertStatus: rollback.status === 'REVERTED' ? 'reverted' : 'conflict', revertConflicts: rollback.conflicts } : {}),
    }, null, 2));
    if (verification.status !== 'VERIFIED_SUCCESS') {
      await updateArtifact(output, { applyStatus: 'verification_failed', appliedVerification: verification });
      return { status: 'APPLY_VERIFICATION_FAILED' as const, conflicts: [], changes };
    }
    await updateArtifact(output, { appliedVerification: verification });
  }
  return { status: "APPLIED" as const, conflicts: [], changes };
}

export async function rollbackAppliedRun(output: string) {
  try { return await revertWorkspaceRun(output); }
  catch (error) {
    const artifact = JSON.parse(await readFile(join(output, 'workspace.json'), 'utf8'));
    const conflicts = (artifact.changes as FileChange[]).map((change) => change.path);
    await updateArtifact(output, { revertStatus: 'conflict', revertConflicts: conflicts, revertError: String(error) });
    return { status: 'REVERT_CONFLICT' as const, conflicts, error: String(error) };
  }
}

/** Roll back completed writes on a mid-apply error, without replacing new user edits. */
export async function applyVerifiedChanges(output: string, source: string, target: string, changes: FileChange[]) {
  const completed: FileChange[] = [];
  try {
    for (const change of changes) {
      await applyChangeFiles(source, target, [change], true);
      completed.push(change);
    }
  } catch (error) {
    const conflicts: string[] = [];
    for (const change of completed.reverse()) {
      const inverse: FileChange = {
        path: change.path,
        type: change.type === 'create' ? 'delete' : change.type === 'delete' ? 'create' : 'modify',
        beforeHash: change.afterHash, beforeMode: change.afterMode,
        afterHash: change.beforeHash, afterMode: change.beforeMode,
      };
      try { await applyChangeFiles(join(output, 'workspace', 'before'), target, [inverse], true); }
      catch { conflicts.push(change.path); }
    }
    await updateArtifact(output, { applied: conflicts.length > 0, applyStatus: 'not_verified',
      partialApplyConflicts: conflicts, applyError: String(error) });
    throw Error(`${String(error)}${conflicts.length ? `; rollback conflicts: ${conflicts.join(', ')}` : '; completed writes rolled back'}`);
  }
}

export async function assertCandidateMatches(root: string, changes: FileChange[]) {
  const snapshot = await snapshotTree(root, undefined, new Set(changes.map((change) => change.path)));
  for (const change of changes) {
    const actual = snapshot.files[change.path];
    if (change.type === 'delete' ? !!actual :
      !actual || actual.hash !== change.afterHash || actual.mode !== change.afterMode)
      throw Error(`Verified candidate changed before/during apply: ${change.path}`);
  }
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

import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { changesBetween, snapshotTree, type Snapshot } from "../workspace/files.js";
import type { WriteScope } from "../repo/writeScope.js";

interface SavedFile { bytes: Buffer; mode: number }

/** An attempt owns only its scoped files; everything else must remain untouched. */
export class AttemptCheckpoint {
  private constructor(
    readonly snapshot: Snapshot,
    private readonly saved: Map<string, SavedFile>,
  ) {}

  static async capture(root: string, scope: WriteScope) {
    const snapshot = await snapshotTree(root, undefined, new Set(scope.paths));
    const saved = new Map<string, SavedFile>();
    let bytes = 0;
    for (const [path, entry] of Object.entries(snapshot.files)) {
      if (!scope.allows(path)) continue;
      bytes += entry.size;
      if (bytes > 64 * 1024 * 1024) throw Error("Attempt checkpoint exceeds scoped byte limit");
      saved.set(path, { bytes: await readFile(join(root, path)), mode: entry.mode });
    }
    return new AttemptCheckpoint(snapshot, saved);
  }

  async changed(root: string, scope: WriteScope) {
    const current = await snapshotTree(root, undefined, new Set(scope.paths));
    return changesBetween(this.snapshot, current);
  }

  async restore(root: string, scope: WriteScope) {
    const changes = await this.changed(root, scope);
    for (const change of changes) {
      if (!scope.allows(change.path))
        throw Error(`Attempt changed a path outside its scope: ${change.path}`);
      await scope.target(root, change.path, "attempt_restore");
    }
    for (const change of changes) {
      const target = join(root, change.path);
      const original = this.saved.get(change.path);
      if (!original) await rm(target, { force: true });
      else {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, original.bytes);
        await chmod(target, original.mode);
      }
    }
    if ((await this.changed(root, scope)).length)
      throw Error("Attempt rollback did not restore the accepted checkpoint");
    return changes;
  }
}

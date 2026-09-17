import { git } from "../repo/commands.js";
import type { Logger } from "../telemetry/logger.js";
export class Integrator {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    readonly path: string,
    readonly logger: Logger,
  ) {}
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn);
    this.tail = next.catch(() => {});
    return next;
  }
  async merge(
    commit: string,
    subtaskId: string,
    resolveConflict: (paths: string[]) => Promise<void>,
  ) {
    return this.exclusive(async () => {
      try {
        await git(
          this.path,
          "-c",
          "user.name=Koda Agent",
          "-c",
          "user.email=koda@localhost",
          "-c",
          "core.hooksPath=/dev/null",
          "cherry-pick",
          commit,
        );
      } catch (e) {
        const paths = (
          await git(this.path, "diff", "--name-only", "--diff-filter=U")
        )
          .split("\n")
          .filter(Boolean);
        if (!paths.length) throw e;
        this.logger.log("merge_conflict", { subtaskId, commit, paths });
        try {
          await resolveConflict(paths);
          await git(this.path, "add", "-A");
          await git(
            this.path,
            "-c",
            "user.name=Koda Agent",
            "-c",
            "user.email=koda@localhost",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.editor=true",
            "cherry-pick",
            "--continue",
          );
        } catch (err) {
          await git(this.path, "cherry-pick", "--abort");
          throw err;
        }
      }
      this.logger.log("integrated", { subtaskId, commit });
    });
  }
}

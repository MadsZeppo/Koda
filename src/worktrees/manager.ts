import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { git } from "../repo/commands.js";
export class Worktrees {
  constructor(
    readonly repo: string,
    readonly directory: string,
    readonly runId: string,
  ) {}
  async create(name: string, base: string) {
    if (!/^[\w-]+$/.test(name)) throw Error("Invalid worktree name");
    await mkdir(this.directory, { recursive: true });
    const path = join(this.directory, name),
      branch = `agent/${this.runId}/${name}`;
    await git(this.repo, "worktree", "add", "-b", branch, path, base);
    return { path, branch };
  }
  async cleanup(path: string) {
    await git(this.repo, "worktree", "remove", "--force", path);
  }
  async commit(path: string, message: string) {
    await git(path, "add", "-A");
    if (!(await git(path, "diff", "--cached", "--name-only")))
      return git(path, "rev-parse", "HEAD");
    await git(
      path,
      "-c",
      "user.name=Koda Agent",
      "-c",
      "user.email=koda@localhost",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-m",
      message,
    );
    return git(path, "rev-parse", "HEAD");
  }
}

import { detectEcosystem } from "./ecosystem.js";
import { readFile, readdir, lstat, realpath } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { git } from "./commands.js";
import { execa } from "execa";
import { listWorkspaceFiles } from "../workspace/files.js";
import { safePath } from "../agent/tools.js";
import type { RepoProfile } from "../types.js";
export async function profileRepo(root: string): Promise<RepoProfile> {
  root = resolve(root);
  const probe = await execa("git", ["rev-parse", "--show-toplevel"], {
    cwd: root,
    reject: false,
    env: { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  }).catch(() => undefined);
  const isGit =
    probe?.exitCode === 0 && (await realpath(probe.stdout.trim())) === root;
  const [commit, status, diff, files, top] = await Promise.all([
    isGit ? git(root, "rev-parse", "HEAD") : "",
    isGit ? git(root, "status", "--porcelain", "--untracked-files=all") : "",
    isGit ? git(root, "diff", "HEAD") : "",
    listWorkspaceFiles(root),
    readdir(root),
  ]);
  const extensions: Record<string, number> = {};
  for (const f of files)
    extensions[extname(f) || "(none)"] =
      (extensions[extname(f) || "(none)"] ?? 0) + 1;
  const symbols: string[] = [];
  for (const file of files
    .filter((f) => /\.(?:[cm]?[jt]sx?|py|go|rs)$/.test(f))
    .slice(0, 80)) {
    try {
      const path = await safePath(root, file);
      if ((await lstat(path)).size > 100000) continue;
      const lines = (await readFile(path, "utf8")).split("\n");
      for (const [i, line] of lines.entries())
        if (
          /^\s*(?:export |(?:async )?function |class |def |func |(?:pub )?fn )/.test(
            line,
          )
        )
          symbols.push(`${file}:${i + 1}: ${line.slice(0, 160)}`);
      if (symbols.length >= 100) break;
    } catch {}
  }
  const ecosystem = await detectEcosystem(root, files);
  const scripts = ecosystem.projectUnits[0]?.scripts ?? {};
  const packageManager = ecosystem.packageManager?.name ?? "unknown";
  const configs: Record<string, string> = {};
  for (const f of ecosystem.configFiles.slice(0, 24))
    try {
      const path = await safePath(root, f);
      if ((await lstat(path)).size <= 65536)
        configs[f] = (await readFile(path, "utf8")).slice(0, 3000);
    } catch {}
  const verificationCommands = ecosystem.projectUnits.flatMap((u) =>
    u.verification.map((c) => c.command),
  );
  return {
    root,
    ecosystem,
    commit,
    status,
    diff: diff.slice(0, 6000),
    files: files.slice(0, 1500),
    topLevel: top.filter((f) => f !== ".git"),
    extensions,
    symbols: symbols.slice(0, 100),
    packageManager,
    scripts,
    configs,
    verificationCommands,
  };
}

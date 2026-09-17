import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { changesBetween, snapshotTree, type Snapshot } from "./files.js";

const baselines = new Map<string, Snapshot>();
const workspaceKey = async (path: string) =>
  realpath(resolve(path)).catch(() => resolve(path));
export async function registerWorkspaceBaseline(
  path: string,
  baseline: Snapshot,
) {
  baselines.set(await workspaceKey(path), baseline);
}
export async function unregisterWorkspace(path: string) {
  baselines.delete(await workspaceKey(path));
}
export async function workspaceChanges(path: string) {
  const baseline = baselines.get(await workspaceKey(path));
  return baseline
    ? changesBetween(
        baseline,
        await snapshotTree(
          path,
          undefined,
          new Set(baseline.explicitlyIncluded ?? []),
        ),
      )
    : undefined;
}
export async function filesystemDiff(path: string) {
  const changes = (await workspaceChanges(path)) ?? [];
  let text = changes.map((c) => `${c.type.toUpperCase()} ${c.path}`).join("\n");
  for (const change of changes.filter((c) => c.type !== "delete").slice(0, 30))
    try {
      text += `\n${change.type === "create" ? "NEW FILE" : "CONTENT"} ${change.path}\n${(await readFile(join(path, change.path), "utf8")).slice(0, 8000)}`;
    } catch {}
  return text.slice(0, 40000);
}

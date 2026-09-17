import { access, lstat, realpath } from "node:fs/promises";
import { join, posix, relative, resolve } from "node:path";
import type { EcosystemProfile } from "./ecosystem.js";

export interface DependencyBridge {
  relativePath: string;
  sourcePath: string;
}

const registered = new Map<string, DependencyBridge[]>();
const key = async (path: string) => realpath(resolve(path));
const inheritedBridges = () => {
  try {
    const value = JSON.parse(process.env.KODA_SANDBOX_DEPENDENCIES ?? "[]");
    return Array.isArray(value) ? (value as DependencyBridge[]) : [];
  } catch {
    return [];
  }
};

/** Register existing JavaScript dependencies for read-only sandbox mounting.
 * Nothing is copied or linked into the source workspace. */
export async function bridgeDependencies(
  source: string,
  target: string,
  profile?: EcosystemProfile,
) {
  const found: DependencyBridge[] = [];
  for (const unit of profile?.projectUnits ?? [
    { root: ".", ecosystem: "javascript" },
  ]) {
    if (unit.ecosystem !== "javascript") continue;
    const relativePath = posix.join(unit.root, "node_modules");
    const sourcePath = join(source, relativePath);
    try {
      const stat = await lstat(sourcePath);
      const resolved = await realpath(sourcePath);
      const inherited = inheritedBridges().some(
        (bridge) =>
          bridge.relativePath === relativePath &&
          resolve(bridge.sourcePath) === resolved,
      );
      if ((!stat.isDirectory() || stat.isSymbolicLink()) && !inherited)
        throw Error(`${relativePath} must be a real dependency directory`);
      found.push({ relativePath, sourcePath: resolved });
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  registered.set(await key(target), found);
  return found.length > 0;
}

export async function dependenciesForWorkspace(path: string) {
  const known = registered.get(await key(path));
  if (known) return known;
  const inherited: DependencyBridge[] = [];
  for (const bridge of inheritedBridges())
    try {
      if (
        (await realpath(join(path, bridge.relativePath))) ===
        (await realpath(bridge.sourcePath))
      )
        inherited.push({
          relativePath: bridge.relativePath,
          sourcePath: await realpath(bridge.sourcePath),
        });
    } catch {}
  return inherited;
}

export async function dependencyPathAvailable(root: string, path: string) {
  const normalized = posix.normalize(path);
  for (const bridge of await dependenciesForWorkspace(root)) {
    if (
      normalized !== bridge.relativePath &&
      !normalized.startsWith(bridge.relativePath + "/")
    )
      continue;
    const suffix = relative(bridge.relativePath, normalized);
    if (suffix.startsWith("..")) continue;
    try {
      await access(join(bridge.sourcePath, suffix));
      return true;
    } catch {}
  }
  return false;
}

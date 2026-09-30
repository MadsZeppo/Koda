import { posix } from "node:path";
import type { Plan, Subtask } from "../planner/schemas.js";
import type { RepositoryExploration } from "../agent/openHandsExplorer.js";

const owns = (scope: string, path: string) =>
  scope === "." || path === scope || path.startsWith(scope.replace(/\/$/, "") + "/");

/** Add only repository-backed or explicitly declared producer/consumer ordering. */
export function inferRepositoryDependencies(
  plan: Plan,
  dependencies: RepositoryExploration["dependencies"] = [],
) {
  const inferred: Array<{ provider: string; consumer: string; reason: string }> = [];
  const reaches = (from: string, target: string, seen = new Set<string>()): boolean => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return plan.subtasks.find((task) => task.id === from)?.dependsOn
      .some((dependency) => reaches(dependency, target, seen)) ?? false;
  };
  for (const consumer of plan.subtasks) {
    for (const provider of plan.subtasks) {
      if (consumer.id === provider.id || consumer.dependsOn.includes(provider.id) || reaches(provider.id, consumer.id)) continue;
      const contracts = provider.provides?.filter((contract) => consumer.consumes?.includes(contract)) ?? [];
      const explicitRead = consumer.likelyReadPaths.some((read) =>
        provider.likelyWritePaths.some((write) => owns(write, read)));
      const graphEdge = dependencies.find((edge) =>
        [...consumer.likelyReadPaths, ...consumer.likelyWritePaths].some((scope) => owns(scope, edge.from)) &&
        provider.likelyWritePaths.some((scope) => owns(scope, edge.to)));
      if (!contracts.length && !explicitRead && !graphEdge) continue;
      consumer.dependsOn.push(provider.id);
      inferred.push({
        provider: provider.id,
        consumer: consumer.id,
        reason: contracts.length ? `contract:${contracts.join(",")}` : explicitRead ? "declared_read" : `${graphEdge!.kind}:${graphEdge!.from}->${graphEdge!.to}`,
      });
    }
  }
  validateDag(plan);
  return inferred;
}
export function overlap(a: Subtask, b: Subtask) {
  const norm = (p: string) => {
    const value = posix.normalize(p).replace(/\/$/, "");
    return process.platform === "darwin" ? value.toLowerCase() : value;
  };
  return (
    !a.parallelSafe ||
    !b.parallelSafe ||
    a.likelyWritePaths.some((x) =>
      b.likelyWritePaths.some((y) => {
        x = norm(x);
        y = norm(y);
        return (
          /[*?\[\]]/.test(x + y) ||
          x === "." ||
          y === "." ||
          x === y ||
          x.startsWith(y + "/") ||
          y.startsWith(x + "/")
        );
      }),
    )
  );
}
export function validateDag(plan: Plan) {
  const tasks = plan.subtasks;
  const ids = new Set(tasks.map((t) => t.id));
  if (ids.size !== tasks.length) throw Error("Duplicate task IDs");
  const done = new Set<string>();
  for (const t of tasks) {
    if (t.readOnly === true && t.likelyWritePaths.length)
      throw Error("Read-only discovery cannot declare writable paths");
    if (t.readOnly !== true && !t.likelyWritePaths.length)
      throw Error("Mutation subtasks require write responsibility");
    if (
      t.reusableArtifact &&
      (!t.likelyWritePaths.includes(t.reusableArtifact) ||
        tasks.filter((other) => other.dependsOn.includes(t.id)).length < 2)
    )
      throw Error(
        "Reusable exploration requires a declared artifact and multiple consumers",
      );
    if (t.dependsOn.some((d) => !ids.has(d))) throw Error("Unknown dependency");
    for (const p of [...t.likelyReadPaths, ...t.likelyWritePaths])
      if (
        !p ||
        p.startsWith("/") ||
        p.includes("\\") ||
        p.split("/").some((part) => part === ".." || part === ".git")
      )
        throw Error("Unsafe planned path");
    t.likelyReadPaths = t.likelyReadPaths.map((p) => posix.normalize(p));
    t.likelyWritePaths = t.likelyWritePaths.map((p) => posix.normalize(p));
  }
  while (done.size < tasks.length) {
    const ready = tasks.filter(
      (t) => !done.has(t.id) && t.dependsOn.every((d) => done.has(d)),
    );
    if (!ready.length) throw Error("Dependency cycle");
    ready.forEach((t) => done.add(t.id));
  }
  return plan;
}
export function readyTasks(
  tasks: Subtask[],
  done: Set<string>,
  started: Set<string>,
  active: Subtask[],
) {
  return tasks.filter(
    (t) =>
      !started.has(t.id) &&
      t.dependsOn.every((d) => done.has(d)) &&
      !active.some((a) => overlap(a, t)),
  );
}

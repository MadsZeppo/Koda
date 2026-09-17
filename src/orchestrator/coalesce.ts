import { validateDag } from "./dag.js";
import type { Plan, Subtask } from "../planner/schemas.js";
const unique = <T>(values: T[]) => [...new Set(values)];
const key = (p: string) =>
  process.platform === "darwin" ? p.toLowerCase() : p;
const pathOverlap = (a: string, b: string) =>
  a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
export function normalizePlan(input: Plan) {
  const plan = validateDag(structuredClone(input));
  const before = plan.subtasks.length;
  const removed = plan.subtasks
    .filter(
      (t) =>
        t.readOnly !== true &&
        /^(?:inspect|read|understand|explore|scout|analy[sz]e)\b/i.test(
          t.title,
        ) &&
        !t.reusableArtifact &&
        !/\b(?:fix|implement|modify|write|create|generate|update|repair)\b/i.test(
          t.objective,
        ),
    )
    .map((t) => t.id);
  const original = new Map(plan.subtasks.map((t) => [t.id, t]));
  const expand = (id: string): string[] =>
    removed.includes(id) ? original.get(id)!.dependsOn.flatMap(expand) : [id];
  plan.subtasks = plan.subtasks
    .filter((t) => !removed.includes(t.id))
    .map((t) => ({ ...t, dependsOn: unique(t.dependsOn.flatMap(expand)) }));
  if (!plan.subtasks.length)
    throw Error(
      "Planner produced only context-gathering tasks; no executable work",
    );
  const aliases = new Map<string, string>();
  const groups: { task: Subtask; members: string[] }[] = [];
  const levels = new Map<string, number>();
  const byId = new Map(plan.subtasks.map((t) => [t.id, t]));
  const level = (id: string): number => {
    if (!levels.has(id))
      levels.set(id, Math.max(-1, ...byId.get(id)!.dependsOn.map(level)) + 1);
    return levels.get(id)!;
  };
  for (const task of plan.subtasks) {
    const paths = task.likelyWritePaths.map(key);
    const group = groups.find(
      (g) =>
        task.readOnly !== true &&
        g.task.readOnly !== true &&
        !task.reusableArtifact &&
        !g.task.reusableArtifact &&
        level(g.task.id) === level(task.id) &&
        !paths
          .concat(g.task.likelyWritePaths)
          .some((p) => p === "." || /[*?\[\]]/.test(p)) &&
        paths.filter((p) =>
          g.task.likelyWritePaths.some((q) => pathOverlap(p, key(q))),
        ).length /
          Math.max(1, Math.min(paths.length, g.task.likelyWritePaths.length)) >=
          0.5,
    );
    if (!group) {
      groups.push({ task: structuredClone(task), members: [task.id] });
      aliases.set(task.id, task.id);
      continue;
    }
    aliases.set(task.id, group.task.id);
    group.members.push(task.id);
    group.task.title += " + " + task.title;
    group.task.objective += "\n\n" + task.objective;
    group.task.integrationContract += "\n\n" + task.integrationContract;
    group.task.dependsOn = unique([...group.task.dependsOn, ...task.dependsOn]);
    group.task.likelyReadPaths = unique([
      ...group.task.likelyReadPaths,
      ...task.likelyReadPaths,
    ]);
    group.task.likelyWritePaths = unique([
      ...group.task.likelyWritePaths,
      ...task.likelyWritePaths,
    ]);
    group.task.verificationCommands = unique([
      ...group.task.verificationCommands,
      ...task.verificationCommands,
    ]);
    if (
      task.estimatedDifficulty === "high" ||
      group.task.estimatedDifficulty === "high"
    )
      group.task.estimatedDifficulty = "high";
    else if (task.estimatedDifficulty === "normal")
      group.task.estimatedDifficulty = "normal";
    group.task.parallelSafe &&= task.parallelSafe;
  }
  plan.subtasks = groups.map((g) => ({
    ...g.task,
    dependsOn: unique(g.task.dependsOn.map((id) => aliases.get(id)!)).filter(
      (id) => id !== g.task.id,
    ),
  }));
  return {
    plan: validateDag(plan),
    before,
    after: plan.subtasks.length,
    removedContextTasks: removed,
    groups: groups.map((g) => ({ id: g.task.id, members: g.members })),
  };
}

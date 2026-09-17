import { readyTasks } from "./dag.js";
import type { Subtask } from "../planner/schemas.js";
export async function schedule(
  tasks: Subtask[],
  maxParallel: number,
  execute: (task: Subtask) => Promise<void>,
  slots: (task: Subtask) => number = () => 1,
) {
  const done = new Set<string>(),
    started = new Set<string>();
  const active = new Map<string, { task: Subtask; promise: Promise<void> }>();
  let failure: unknown;
  let peak = 0;
  while (done.size < tasks.length) {
    if (!failure) {
      while (active.size < maxParallel) {
        const used = [...active.values()].reduce(
          (n, v) => n + slots(v.task),
          0,
        );
        const t = readyTasks(
          tasks,
          done,
          started,
          [...active.values()].map((v) => v.task),
        ).find((t) => slots(t) + used <= maxParallel);
        if (!t) break;
        started.add(t.id);
        const promise = execute(t)
          .then(
            () => {
              done.add(t.id);
            },
            (e) => {
              failure ??= e;
            },
          )
          .finally(() => {
            active.delete(t.id);
          });
        active.set(t.id, { task: t, promise });
        peak = Math.max(peak, active.size);
      }
    }
    if (!active.size) {
      if (failure) throw failure;
      throw Error("DAG stalled");
    }
    await Promise.race([...active.values()].map((v) => v.promise));
    if (failure) {
      await Promise.all([...active.values()].map((v) => v.promise));
      throw failure;
    }
  }
  return { peak, completed: [...done] };
}

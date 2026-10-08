import { access, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { homedir } from "node:os";
import { execa } from "execa";

/** Use the interpreter that owns Aider, never install into a customer repo. */
export async function ensureAiderRuntime(env: NodeJS.ProcessEnv = process.env) {
  const candidates = env.KODA_AIDER_PYTHON ? [env.KODA_AIDER_PYTHON] : [];
  const bins = env.AIDER_BIN ? [env.AIDER_BIN] :
    [...(env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, "aider")),
      join(env.HOME ?? homedir(), ".local", "bin", "aider"),
      join(env.HOME ?? homedir(), "Library", "Application Support", "pipx", "venvs", "aider-chat", "bin", "aider"),
      join(env.HOME ?? homedir(), ".local", "share", "pipx", "venvs", "aider-chat", "bin", "aider")];
  if (!candidates.length) for (const bin of bins) {
    try {
      await access(bin, constants.X_OK);
      const path = await realpath(bin);
      const launcher = (await readFile(path, "utf8")).split("\n");
      const first = launcher[0];
      // pipx uses a shell trampoline when its interpreter path contains spaces.
      // Read that literal path; never execute or evaluate launcher shell text.
      const interpreter = first?.match(/^#!\s*(\/[^\s]+)\s*$/)?.[1] === "/bin/sh"
        ? launcher[1]?.match(/^'''exec' '([^']+)' "\$0" "\$@"\s*$/)?.[1]
        : first?.match(/^#!\s*(\/[^\s]+)\s*$/)?.[1];
      if (interpreter) candidates.push(interpreter);
      candidates.push(join(dirname(path), "python"), join(dirname(path), "python3"));
    } catch { /* Try the next installed entry point. */ }
  }
  if (!env.KODA_AIDER_PYTHON && !env.AIDER_BIN) candidates.push("python3");
  for (const python of [...new Set(candidates)]) {
    const result = await execa(python, ["-I", "-c",
      "from aider.main import main; from aider.models import MODEL_SETTINGS, ModelSettings; from aider.llm import litellm; assert callable(litellm.completion); import sys; print(sys.executable)"],
    { reject: false, timeout: 15_000, env: { ...env, OPENROUTER_API_KEY: undefined, LITELLM_LOCAL_MODEL_COST_MAP: "True" } }).catch(() => undefined);
    if (result?.exitCode === 0) return result.stdout.trim().split("\n").at(-1)!;
  }
  throw Error("AIDER_UNAVAILABLE: install aider-chat and set KODA_AIDER_PYTHON to its Python interpreter (or AIDER_BIN to its entry point)");
}

/** Preserve managed-Python aliases used by pyvenv.cfg inside the read-only sandbox. */
export async function aiderSandboxReadRoots(python: string) {
  const venv = dirname(dirname(python));
  const roots = new Set([venv, dirname(dirname(await realpath(python)))]);
  try {
    const config = await readFile(join(venv, "pyvenv.cfg"), "utf8");
    const home = config.match(/^home\s*=\s*(.+)$/m)?.[1]?.trim();
    if (home?.startsWith("/")) {
      const base = /(?:^|\/)(?:bin|Scripts)$/.test(home) ? dirname(home) : home;
      const resolved = await realpath(base);
      roots.add(resolved);
      // A canonical mount alone hides the alias through which CPython locates
      // its base installation. Mount the alias's containing runtime directory.
      if (base !== resolved) roots.add(dirname(base));
    }
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
  return [...roots];
}

import { access, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { execa } from "execa";

/** Use the interpreter that owns Aider, never install into a customer repo. */
export async function ensureAiderRuntime(env: NodeJS.ProcessEnv = process.env) {
  const candidates = env.KODA_AIDER_PYTHON ? [env.KODA_AIDER_PYTHON] : [];
  const bins = env.AIDER_BIN ? [env.AIDER_BIN] :
    (env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, "aider"));
  if (!candidates.length) for (const bin of bins) {
    try {
      await access(bin, constants.X_OK);
      const path = await realpath(bin);
      const first = (await readFile(path, "utf8")).split("\n")[0];
      const interpreter = first?.match(/^#!\s*(\/[^\s]+)\s*$/)?.[1];
      if (interpreter) candidates.push(interpreter);
      candidates.push(join(dirname(path), "python"), join(dirname(path), "python3"));
    } catch { /* Try the next installed entry point. */ }
  }
  if (!env.KODA_AIDER_PYTHON && !env.AIDER_BIN) candidates.push("python3");
  for (const python of [...new Set(candidates)]) {
    const result = await execa(python, ["-I", "-c",
      "from aider.main import main; from aider.models import MODEL_SETTINGS, ModelSettings; from aider.llm import litellm; assert callable(litellm.completion); import sys; print(sys.executable)"],
    { reject: false, timeout: 15_000, env: { ...env, OPENROUTER_API_KEY: undefined } }).catch(() => undefined);
    if (result?.exitCode === 0) return result.stdout.trim().split("\n").at(-1)!;
  }
  throw Error("AIDER_UNAVAILABLE: install aider-chat and set KODA_AIDER_PYTHON to its Python interpreter (or AIDER_BIN to its entry point)");
}

import { access, mkdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

export const OPENHANDS_SDK_VERSION = "1.50.0";
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const requirements = join(moduleDirectory, "../../workers/openhands/requirements.txt");
const defaultCache = () => process.env.KODA_RUNTIME_CACHE ??
  join(homedir(), ".cache", "koda", "runtimes");
let provisioning: Promise<string> | undefined;

async function usable(python: string) {
  try {
    await access(python, constants.X_OK);
    const result = await execa(python, ["-c",
      `import importlib.metadata as m; assert m.version('openhands-sdk') == '${OPENHANDS_SDK_VERSION}'`],
    { reject: false, timeout: 10_000, env: { ...process.env, OPENHANDS_SUPPRESS_BANNER: "1" } });
    return result.exitCode === 0;
  } catch { return false; }
}

/** Provision the pinned SDK outside both the source and candidate repositories. */
export async function ensureOpenHandsRuntime() {
  if (process.env.KODA_OPENHANDS_PYTHON) {
    if (!await usable(process.env.KODA_OPENHANDS_PYTHON))
      throw Error("INFRA_FAILURE: configured OpenHands SDK runtime is unavailable or incompatible");
    return process.env.KODA_OPENHANDS_PYTHON;
  }
  if (provisioning) return provisioning;
  provisioning = (async () => {
    const root = join(defaultCache(), `openhands-sdk-${OPENHANDS_SDK_VERSION}`);
    const python = join(root, "venv", "bin", "python");
    if (await usable(python)) return python;
    await mkdir(root, { recursive: true });
    const expected = `openhands-sdk==${OPENHANDS_SDK_VERSION}`;
    if ((await readFile(requirements, "utf8")).trim() !== expected)
      throw Error("INFRA_FAILURE: OpenHands requirements pin does not match runtime version");
    const uv = await execa("uv", ["--version"], { reject: false }).catch(() => undefined);
    if (!uv || uv.exitCode !== 0)
      throw Error("INFRA_FAILURE: uv is required to provision the isolated OpenHands runtime");
    const create = await execa("uv", ["venv", "--python", "3.13", join(root, "venv")],
      { reject: false, timeout: 120_000 });
    if (create.exitCode !== 0)
      throw Error(`INFRA_FAILURE: OpenHands Python provisioning failed: ${create.stderr}`);
    const install = await execa("uv", ["pip", "install", "--python", python, "-r", requirements],
      { reject: false, timeout: 300_000 });
    if (install.exitCode !== 0 || !await usable(python))
      throw Error(`INFRA_FAILURE: OpenHands dependency provisioning failed: ${install.stderr}`);
    return python;
  })().catch((error) => { provisioning = undefined; throw error; });
  return provisioning;
}

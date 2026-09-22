import { access, copyFile, mkdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

export const MINI_SWE_VERSION = "2.4.6";
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
export const MINI_SWE_BRIDGE = join(moduleDirectory, "../../workers/miniswe/bridge.py");
const defaultCache = () => process.env.KODA_RUNTIME_CACHE ?? join(homedir(), ".cache", "koda", "runtimes");
let provisioning: Promise<string> | undefined;

async function usable(python: string) {
  try {
    await access(python, constants.X_OK);
    const result = await execa(python, ["-c",
      `import minisweagent; assert minisweagent.__version__ == '${MINI_SWE_VERSION}'`],
    { reject: false, timeout: 10_000 });
    return result.exitCode === 0;
  } catch { return false; }
}

export const bridgeForRuntime = (python: string) => join(dirname(dirname(python)), "koda_bridge.py");
const installBridge = async (python: string) => {
  await copyFile(MINI_SWE_BRIDGE, bridgeForRuntime(python));
  return python;
};

/** Provision Koda's pinned worker runtime outside every customer repository. */
export async function ensureMiniSweRuntime() {
  if (process.env.KODA_MINISWE_PYTHON) {
    if (!await usable(process.env.KODA_MINISWE_PYTHON))
      throw Error("INFRA_FAILURE: configured mini-SWE Python runtime is unavailable or incompatible");
    return process.env.KODA_MINISWE_PYTHON;
  }
  if (provisioning) return provisioning;
  provisioning = (async () => {
    const root = join(defaultCache(), `mini-swe-agent-${MINI_SWE_VERSION}`);
    const python = join(root, "venv", "bin", "python");
    if (await usable(python)) return installBridge(python);
    await mkdir(root, { recursive: true });
    const requirements = join(moduleDirectory, "../../workers/miniswe/requirements.txt");
    const expected = `mini-swe-agent==${MINI_SWE_VERSION}`;
    if ((await readFile(requirements, "utf8")).trim() !== expected)
      throw Error("INFRA_FAILURE: mini-SWE requirements pin does not match bridge version");
    const uv = await execa("uv", ["--version"], { reject: false }).catch(() => undefined);
    if (!uv || uv.exitCode !== 0)
      throw Error("INFRA_FAILURE: uv is required to provision the isolated mini-SWE runtime");
    const create = await execa("uv", ["venv", "--python", "3.13", join(root, "venv")],
      { reject: false, timeout: 120_000 });
    if (create.exitCode !== 0)
      throw Error(`INFRA_FAILURE: mini-SWE Python provisioning failed: ${create.stderr}`);
    const install = await execa("uv", ["pip", "install", "--python", python, "-r", requirements],
      { reject: false, timeout: 300_000 });
    if (install.exitCode !== 0 || !await usable(python))
      throw Error(`INFRA_FAILURE: mini-SWE dependency provisioning failed: ${install.stderr}`);
    return installBridge(python);
  })().catch((error) => { provisioning = undefined; throw error; });
  return provisioning;
}

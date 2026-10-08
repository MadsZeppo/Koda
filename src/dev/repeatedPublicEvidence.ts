import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  digest,
  freezeEvidence,
  writeImmutable,
} from "../router/knowledge/evidenceRegistry.js";
/** Bounded offline pilot. Source order is NOT claimed to be actual retry chronology. */
export async function collectRepeatedPilot(output: string, anchors = 10) {
  const root = resolve(output);
  await mkdir(root, { recursive: true });
  const source = "https://datasets-server.huggingface.co/";
  const query = (endpoint: string, params: Record<string, string>) => {
    const u = new URL(endpoint, source);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  };
  const base = {
    dataset: "nebius/SWE-rebench-openhands-trajectories",
    config: "default",
    split: "train",
  };
  const sources: Record<string, string> = {};
  async function get(url: string) {
    const path = join(root, digest(url) + ".json");
    let text;
    try {
      text = await readFile(path, "utf8");
    } catch {
      const response = await fetch(url);
      if (!response.ok)
        throw Error(
          `Public dataset unavailable: ${response.status}: ${(await response.text()).slice(0, 150)}`,
        );
      text = await response.text();
      await writeFile(path, text, { flag: "wx" });
    }
    sources[url] = digest(text);
    return JSON.parse(text);
  }
  const first = await get(
    query("rows", {
      ...base,
      offset: "0",
      length: String(Math.min(100, anchors)),
    }),
  );
  const tasks = [
    ...new Set<string>(first.rows.map((r: any) => r.row.instance_id)),
  ];
  const repeated = [];
  const unavailable = [];
  for (const id of tasks) {
    try {
      if (!/^[\w.-]+$/.test(id)) throw Error("Unsafe source ID");
      const result = await get(
        query("filter", {
          ...base,
          where: `"instance_id" = '${id}'`,
          length: "100",
        }),
      );
      const rows = result.rows.map((r: any) => ({
        trajectoryId: r.row.trajectory_id,
        sourceRow: r.row_idx,
        success: r.row.resolved === 1,
      }));
      const n = rows.length,
        solved = rows.filter((r: any) => r.success).length;
      repeated.push({
        taskId: id,
        rows,
        attempts: n,
        failures: n - solved,
        successes: solved,
        conditionalExchangeableRetry:
          n > 1 && solved < n ? solved / (n - 1) : null,
      });
    } catch (error) {
      unavailable.push({ taskId: id, reason: String(error) });
    }
  }
  const envelope = freezeEvidence(
    {
      kind: "same-model-source-experiment",
      model: "Qwen3-Coder-480B (publisher identity; exact revision unreported)",
      harness: "OpenHands (publisher experiment)",
      chronologyAvailable: false,
      assumption:
        "conditional exchangeable rerun, not observed sequential retry",
      repeated,
      unavailable,
    },
    {
      sourceDigests: sources,
      modelMappingDigest: digest("publisher-experiment-only"),
      taskVersion: 1,
      splitDigest: digest(tasks.map((id) => [id, "DEVELOPMENT"])),
      estimatorVersion: "retry-v1",
      calibrationVersion: "source-only-untransferred",
      policyDigest: digest({
        ranking: false,
        modelExact: false,
        scope: "bounded-pilot",
      }),
      timestamp: "content-frozen",
      provenance: Object.keys(sources),
    },
  );
  const path = join(root, "repeated-" + envelope.digest + ".json");
  await writeImmutable(path, envelope);
  return {
    path,
    tasks: repeated.length,
    trajectories: repeated.reduce((s, r) => s + r.attempts, 0),
    observedSequentialRetryPairs: 0,
    unavailable,
  };
}
if (process.argv[1]?.endsWith("repeatedPublicEvidence.ts"))
  console.log(
    JSON.stringify(
      await collectRepeatedPilot(
        process.argv[2] ?? "/tmp/koda-repeated-public",
        Number(process.argv[3] ?? 10),
      ),
      null,
      2,
    ),
  );

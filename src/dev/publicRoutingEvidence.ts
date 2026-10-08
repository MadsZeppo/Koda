import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { canonicalRoutingTask } from "../router/canonicalTask.js";
import { lexicalTask } from "../router/lexicalTask.js";
import { assessTask } from "../router/taskAssessment.js";
import { buildVerificationContract } from "../verifier/contract.js";
import type { CanonicalQualityObservation } from "../router/knowledge/canonical.js";
import {
  digest,
  freezeEvidence,
  writeImmutable,
  taskEvidenceRole,
} from "../router/knowledge/evidenceRegistry.js";
export interface PublicTask {
  id: string;
  text: string;
  repo: string;
  baseCommit: string;
  createdAt?: string;
}
export interface PublicSubmission {
  id: string;
  model: string;
  revision: string;
  harness: string;
  engine: string;
  resolved: string[];
  unavailable: string[];
  provenance: string;
  timestamp: string;
  patches?: Record<string, string>;
}
export function normalizePublicSubmission(
  tasks: PublicTask[],
  s: PublicSubmission,
): CanonicalQualityObservation[] {
  if (!s.model || !s.revision || !s.harness)
    throw Error("Exact source identity and harness required");
  return tasks
    .filter((t) => !s.unavailable.includes(t.id))
    .map((t) => {
      let assessment;
      try {
        assessment = assessTask({
          task: t.text,
          facts: {
            files: [],
            resolvedPaths: [],
            relatedTests: [],
            components: [],
            localizationConfidence: "low",
            checks: [],
          },
        });
      } catch (error) {
        if (!String(error).includes("task_spec_requires_decomposition"))
          throw error;
      }
      let contract;
      try {
        if (assessment)
          contract = buildVerificationContract({ task: t.text, assessment });
      } catch (error) {
        if (!String(error).includes("task_spec_requires_decomposition"))
          throw error;
        // Preserve the entire original issue. An offline issue cannot be truncated to fit a runtime coding packet.
        contract = undefined;
      }
      return {
        id: digest([s.id, t.id, s.model, s.harness]),
        taskId: t.id,
        task: {
          ...canonicalRoutingTask({
            family: "debugging",
            text: t.text,
            semantic: lexicalTask(t.text),
            engine: s.engine,
            harness: s.harness,
            assessment,
            contract,
          }),
          repo: t.repo,
          baseCommit: t.baseCommit,
          languages: ["python"],
        },
        model: s.model,
        revision: s.revision,
        identity: "SOURCE_EXACT",
        source: s.id,
        population: "SWE-bench_Verified",
        configuration: s.id,
        split: "development",
        role: taskEvidenceRole(t.id),
        origin: "external",
        provenance: s.provenance,
        timestamp: s.timestamp,
        success: s.resolved.includes(t.id),
        trainingAllowed: true,
      };
    });
}
async function cached(url: string, cache: string) {
  const path = join(cache, digest(url) + ".txt");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    const response = await fetch(url);
    if (!response.ok) throw Error(`${response.status} ${url}`);
    text = await response.text();
    await writeFile(path, text, { flag: "wx" });
  }
  return text;
}
/** Explicit offline fetch. Never imported from normal routing/dispatch. */
export async function buildPublicEvidence(
  output: string,
  sourceConfig?: string,
) {
  const root = resolve(output),
    cache = join(root, "sources");
  await mkdir(cache, { recursive: true });
  const sourceDigests: Record<string, string> = {};
  const get = async (url: string) => {
    const text = await cached(url, cache);
    sourceDigests[url] = digest(text);
    return text;
  };
  const tasks: PublicTask[] = [];
  for (let offset = 0; offset < 500; offset += 100) {
    const url = `https://datasets-server.huggingface.co/rows?dataset=SWE-bench%2FSWE-bench_Verified&config=default&split=test&offset=${offset}&length=100`;
    const json = JSON.parse(await get(url));
    for (const { row: r } of json.rows) {
      if (!r.problem_statement || !r.base_commit)
        throw Error("Missing legitimate task text");
      tasks.push({
        id: r.instance_id,
        text: r.problem_statement,
        repo: r.repo,
        baseCommit: r.base_commit,
        createdAt: r.created_at,
      });
    }
  }
  // The source catalog is a data manifest, never a routing model list/ranking.
  const config = sourceConfig
    ? JSON.parse(await readFile(sourceConfig, "utf8"))
    : {
        submissions: [
          "20241029_OpenHands-CodeAct-2.1-sonnet-20241022",
          "20250415_openhands",
          "20250520_openhands_devstral_small",
          "20250524_openhands_claude_4_sonnet",
          "20250716_openhands_kimi_k2",
          "20250807_openhands_gpt5",
          "20250519_trae",
          "20250603_Refact_Agent_claude-4-sonnet",
          "20250611_moatless_claude-4-sonnet-20250514",
          "20250612_trae",
          "20250720_Lingxi-v1.5_claude-4-sonnet-20250514",
        ],
      };
  const rows: CanonicalQualityObservation[] = [];
  const submissions = [];
  const exclusions = [];
  for (const id of config.submissions) {
    try {
      const base = `https://raw.githubusercontent.com/SWE-bench/experiments/main/evaluation/verified/${id}`;
      const metadata = await get(base + "/metadata.yaml");
      const model = metadata
        .match(/\n\s*model:\s*\n\s*-\s*([^\n]+)/)?.[1]
        ?.trim();
      const harness = metadata.match(/\n\s*agent:\s*([^\n]+)/)?.[1]?.trim();
      if (!model || !harness)
        throw Error("Missing unambiguous source model/harness");
      const result = JSON.parse(await get(base + "/results/results.json"));
      if (
        !Array.isArray(result.resolved) ||
        !Array.isArray(result.no_logs) ||
        !Array.isArray(result.no_generation)
      )
        throw Error("Unknown result schema");
      const submission = {
        id,
        model,
        revision: model,
        harness,
        engine: "source-agent",
        resolved: result.resolved,
        unavailable: [...result.no_logs, ...result.no_generation],
        provenance: base,
        timestamp: id.slice(0, 8),
      };
      const normalized = normalizePublicSubmission(tasks, submission);
      rows.push(...normalized);
      submissions.push({ ...submission, observations: normalized.length });
    } catch (error) {
      exclusions.push({ source: id, reason: String(error) });
    }
  }
  if (!rows.length) throw Error("No usable public outcomes");
  const metadata = {
    sourceDigests,
    modelMappingDigest: digest(
      submissions.map((s) => [s.id, s.model, s.harness]),
    ),
    taskVersion: 1,
    splitDigest: digest(tasks.map((t) => [t.id, taskEvidenceRole(t.id)])),
    estimatorVersion: "contextual-vnext-2",
    calibrationVersion: "unmeasured",
    policyDigest: digest({
      split: "DEVELOPMENT",
      labels: "public-published",
      goldExcluded: true,
    }),
    timestamp: "source-content-addressed",
    provenance: Object.keys(sourceDigests),
  };
  const envelope = freezeEvidence(
    { tasks, rows, submissions, exclusions },
    metadata,
  );
  const path = join(root, `public-${envelope.digest}.json`);
  await writeImmutable(path, envelope);
  await writeFile(
    join(root, "latest.json"),
    JSON.stringify({ path, digest: envelope.digest }),
  );
  return {
    path,
    tasks: tasks.length,
    richTasks: tasks.length,
    observations: rows.length,
    models: new Set(rows.map((r) => r.model)).size,
    harnesses: [...new Set(rows.map((r) => r.task.harness))],
    exclusions,
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: { output: { type: "string" }, sources: { type: "string" } },
  });
  if (!values.output) throw Error("--output required");
  console.log(
    JSON.stringify(
      await buildPublicEvidence(values.output, values.sources),
      null,
      2,
    ),
  );
}

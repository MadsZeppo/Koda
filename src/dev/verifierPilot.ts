import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { digest } from "../router/knowledge/evidenceRegistry.js";
import {
  runtimeCandidate,
  verifierStageA,
  verifierStageB,
  verifierStatistics,
} from "./verifierCalibration.js";
import { verificationPreflight } from "./verificationRuntime.js";
export interface PilotEntry {
  id: string;
  role: "DEVELOPMENT" | "CALIBRATION" | "FINAL_HOLDOUT";
  runtime: string;
  truth: string;
  family: string;
}
export function sampleCandidates(
  entries: PilotEntry[],
  max: number,
  seed: string,
  family?: string,
) {
  if (!Number.isInteger(max) || max < 1 || max > 1000)
    throw Error("Invalid candidate bound");
  if (new Set(entries.map((e) => e.id)).size !== entries.length)
    throw Error("Duplicate candidate identities");
  const pool = entries.filter(
    (e) =>
      ["DEVELOPMENT", "CALIBRATION"].includes(e.role) &&
      (!family || e.family === family),
  );
  const selected: PilotEntry[] = [];
  const families = new Set<string>();
  while (selected.length < Math.min(max, pool.length)) {
    const rest = pool
      .filter((e) => !selected.includes(e))
      .sort(
        (a, b) =>
          Number(!families.has(b.family)) - Number(!families.has(a.family)) ||
          digest([seed, a.id]).localeCompare(digest([seed, b.id])),
      );
    selected.push(rest[0]!);
    families.add(rest[0]!.family);
  }
  return selected;
}
export async function verifierPilot(o: {
  source: string;
  output: string;
  maxCandidates: number;
  seed: string;
  family?: string;
  resume?: boolean;
  preflight?: boolean;
}) {
  const source = resolve(o.source),
    out = resolve(o.output);
  const corpus = JSON.parse(await readFile(source, "utf8"));
  const entries = sampleCandidates(
    corpus.candidates,
    o.maxCandidates,
    o.seed,
    o.family,
  );
  await mkdir(out, { recursive: true });
  const sources = await Promise.all(
    entries.map(async (e) => {
      const runtime = resolve(dirname(source), e.runtime);
      const truth = resolve(dirname(source), e.truth);
      return { e, runtime, truth, bytes: await readFile(runtime, "utf8") };
    }),
  );
  const identity = digest([sources.map((x) => [x.e, x.bytes]), o.seed]);
  if (!o.preflight) {
    const plan = join(out, "pilot-plan.json");
    try {
      await writeFile(plan, JSON.stringify({ identity, entries }), {
        flag: "wx",
      });
    } catch (e) {
      if (
        (e as NodeJS.ErrnoException).code !== "EEXIST" ||
        !o.resume ||
        JSON.parse(await readFile(plan, "utf8")).identity !== identity
      )
        throw Error("Pilot resume/identity mismatch");
    }
  }
  const reports = [];
  for (const x of sources) {
    const c = runtimeCandidate(JSON.parse(x.bytes));
    c.origin = corpus.origin?.includes("fixture")
      ? "integration_fixture"
      : "public";
    c.role = x.e.role as "DEVELOPMENT" | "CALIBRATION";
    if (c.id !== x.e.id) throw Error("Candidate identity mismatch");
    // Stage B file stays outside the base repository AND every execution workspace.
    const inside = (root: string, path: string) =>
      path === root || path.startsWith(root + "/");
    const isolated = !inside(resolve(c.repo), x.truth) && !inside(out, x.truth);
    if (!isolated)
      throw Error("Truth source overlaps Stage A repository/workspace");
    if (o.preflight) {
      reports.push({
        id: c.id,
        ...(await verificationPreflight({
          ...c,
          truthIsolated: isolated,
          truthAvailable: await access(x.truth).then(
            () => true,
            () => false,
          ),
          candidateAvailable: true,
          output: out,
        })),
      });
      continue;
    }
    await verifierStageA(c, out);
    // External truth is first read HERE, after Stage A completed its immutable publication.
    reports.push(
      await verifierStageB(join(out, c.id + ".stage-a.json"), x.truth),
    );
  }
  const report = o.preflight
    ? { identity, preflight: reports }
    : {
        identity,
        origin: corpus.origin ?? "unknown",
        rows: reports,
        statistics: verifierStatistics(
          reports as Awaited<ReturnType<typeof verifierStageB>>[],
        ),
        paidCalls: 0,
      };
  await writeFile(
    join(out, o.preflight ? "preflight.json" : "report.json"),
    JSON.stringify(report, null, 2),
  );
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values: v } = parseArgs({
    options: {
      source: { type: "string" },
      output: { type: "string" },
      "max-candidates": { type: "string", default: "6" },
      seed: { type: "string", default: "20261006" },
      "task-family": { type: "string" },
      resume: { type: "boolean" },
      preflight: { type: "boolean" },
    },
  });
  if (!v.source || !v.output)
    throw Error("--source --output required; no image downloads/model calls");
  console.log(
    JSON.stringify(
      await verifierPilot({
        source: v.source,
        output: v.output,
        maxCandidates: Number(v["max-candidates"]),
        seed: v.seed!,
        family: v["task-family"],
        resume: v.resume,
        preflight: v.preflight,
      }),
      null,
      2,
    ),
  );
}

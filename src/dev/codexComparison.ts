import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { parseArgs } from "node:util";
import { execa } from "execa";
import { stressCodingScenarios } from "./stressCodingSuiteFixtures.js";
import { scenarioFixture } from "./codingSuiteFixtures.js";
import { codexCost, codexPrices } from "./codexCost.js";

export const comparisonScenarios = stressCodingScenarios.slice(0, 10);
export function codexArguments(repo: string, model?: string) {
  return ["exec", ...(model ? ["--model", model] : []), "--skip-git-repo-check", "--sandbox", "workspace-write", "--ephemeral", "--json", "--cd", repo, "-"];
}
export function reportedModel(transcript: string): string {
  const models = new Set<string>();
  for (const line of transcript.split("\n")) {
    try {
      const e = JSON.parse(line);
      // Only protocol metadata, never model names guessed from assistant text.
      if (["thread.started", "turn.started", "turn.completed"].includes(e.type) && typeof e.model === "string") models.add(e.model);
    } catch { /* Missing metadata keeps price unknown. */ }
  }
  return models.size === 1 ? [...models][0]! : "unknown-default";
}
export async function runCodexComparison(output: string, model?: string) {
  if (model && !codexPrices[model]) throw Error(`No verified pricing for ${model}; supported: ${Object.keys(codexPrices).join(", ")}`);
  const root = resolve(output);
  await mkdir(root, { recursive: false });
  const results = [];
  for (const s of comparisonScenarios) {
    const fixture = scenarioFixture(s), parent = join(root, s.id), repo = join(parent, "repo");
    await mkdir(repo, { recursive: true });
    for (const [path, content] of Object.entries(fixture.files)) {
      await mkdir(dirname(join(repo, path)), { recursive: true });
      await writeFile(join(repo, path), content);
    }
    const start = Date.now();
    let error: string | undefined;
    let exitCode: number | undefined;
    let transcript = "";
    let finished = false;
    try {
      const child = await execa("codex", codexArguments(repo, model), {
        input: fixture.task, reject: false, all: true, timeout: 240_000,
      });
      transcript = child.stdout ?? "";
      finished = child.exitCode === 0;
      await writeFile(join(parent, "codex.stderr.log"), child.stderr ?? "");
      exitCode = child.exitCode;
      if (exitCode !== 0) throw Error(`Codex exit ${exitCode}`);
      for (const args of [["--test", fixture.testPath], ["--check", fixture.source], ["-e", fixture.acceptance, join(repo, fixture.source)]]) {
        const check = await execa(process.execPath, args, { cwd: repo, reject: false, all: true, timeout: 10_000 });
        if (check.exitCode !== 0) throw Error(`Check failed: ${check.all}`);
      }
      if (await readFile(join(repo, fixture.source), "utf8") === fixture.files[fixture.source]) throw Error("No source mutation");
      if (await readFile(join(repo, fixture.testPath), "utf8") === fixture.files[fixture.testPath]) throw Error("No requested test mutation");
      const allowed = new Set([fixture.source, fixture.testPath]);
      async function inspect(prefix = "") {
        for (const e of await readdir(join(repo, prefix), { withFileTypes: true })) {
          const path = prefix ? `${prefix}/${e.name}` : e.name;
          if (e.isSymbolicLink()) throw Error(`Unexpected symlink ${path}`);
          if (e.isDirectory()) await inspect(path);
          else if (!allowed.has(path) && (!(path in fixture.files) || await readFile(join(repo, path), "utf8") !== fixture.files[path])) throw Error(`Unexpected mutation ${path}`);
        }
      }
      await inspect();
      for (const path of Object.keys(fixture.files)) await readFile(join(repo, path));
    } catch (e) {
      error = String(e);
      if (e && typeof e === "object" && "stdout" in e) transcript = String(e.stdout ?? "");
    }
    await writeFile(join(parent, "codex.jsonl"), transcript);
    const result = { id: s.id, passed: !error, exitCode, error, wallClockMs: Date.now() - start, ...codexCost(transcript, model ?? reportedModel(transcript), finished) };
    results.push(result);
    await writeFile(join(parent, "result.json"), JSON.stringify(result, null, 2));
    console.log(`${result.passed ? "PASS" : "FAIL"} ${s.id} — API estimate ${result.costUsd === null ? "unknown" : `$${result.costUsd.toFixed(5)}`} (${(result.wallClockMs / 1000).toFixed(1)}s)${error ? `: ${error}` : ""}`);
    const passed = results.filter(r => r.passed).length;
    const costComplete = results.every(r => r.costComplete);
    const knownCostUsd = results.reduce((n,r)=>n+(r.costUsd ?? 0),0);
    await writeFile(join(root, "suite-summary.json"), JSON.stringify({ runner: "codex", model, costBasis: result.costBasis, passed, completed: results.length,
      costUsd: costComplete ? knownCostUsd : null, knownCostUsd, costComplete,
      costPerPassedUsd: costComplete && passed ? knownCostUsd / passed : null,
      wallClockMs: results.reduce((n,r)=>n+r.wallClockMs,0), results }, null, 2));
  }
  const codexSummary = JSON.parse(await readFile(join(root, "suite-summary.json"), "utf8"));
  try {
    const koda = JSON.parse(await readFile(join(dirname(root), "koda", "suite-summary.json"), "utf8"));
    if (JSON.stringify(koda.results.map((r: any) => r.id)) !== JSON.stringify(results.map(r => r.id))) throw Error("Different tasks: cannot compare");
    const comparison = {
      caveat: "Koda reported provider cost vs Codex Standard API-equivalent token estimate, not subscription billing. Failed task spend is included. Unknown/incomplete costs are not comparable.",
      koda: { passed: koda.passed, tasks: koda.scenarioCount, wallClockMs: koda.wallClockMs,
        costUsd: koda.costComplete ? koda.costUsd : null, costComplete: koda.costComplete,
        costPerPassedUsd: koda.costComplete && koda.passed ? koda.costUsd / koda.passed : null },
      codex: { passed: codexSummary.passed, tasks: results.length, wallClockMs: codexSummary.wallClockMs,
        costUsd: codexSummary.costUsd, costComplete: codexSummary.costComplete, costPerPassedUsd: codexSummary.costPerPassedUsd },
    };
    await writeFile(join(dirname(root), "comparison.json"), JSON.stringify(comparison, null, 2));
    console.table({ Koda: comparison.koda, "Codex (API estimate)": comparison.codex });
  } catch (e) {
    console.log(`Comparison unavailable: ${String(e)}. Codex results retained at ${root}`);
  }
  return results;
}

if (process.argv[1]?.endsWith("codexComparison.ts")) {
  const { values } = parseArgs({ options: { output: { type: "string" }, list: { type: "boolean" }, model: { type: "string" } } });
  if (values.list) console.log(comparisonScenarios.map(s => s.id).join(","));
  else {
    const results = await runCodexComparison(values.output ?? `/tmp/koda-codex-comparison-${Date.now()}`, values.model);
    console.log(`${results.filter(r => r.passed).length}/10 passed`);
    if (results.some(r => !r.passed)) process.exitCode = 1;
  }
}

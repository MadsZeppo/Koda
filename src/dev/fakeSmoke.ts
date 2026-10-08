import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { fakeSmokeFixtures } from "./fakeSmokeFixtures.js";
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
export async function runFakeSmoke(name: string, options: { apply?: boolean; git?: boolean; cli?: boolean } = {}) {
  const fixture = fakeSmokeFixtures[name];
  if (!fixture) throw Error(`Unknown fake smoke scenario: ${name}`);
  const parent = await mkdtemp(join(tmpdir(), `koda-fake-${name}-`));
  const repo = join(parent, "repo"), output = join(parent, "report"), script = join(parent, "script.json");
  await mkdir(repo);
  for (const [path, text] of Object.entries(fixture.files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  await writeFile(script, JSON.stringify(fixture.script, null, 2));
  if (options.git) {
    await execa('git', ['init', '-q'], { cwd: repo });
    await execa('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'add', '.'], { cwd: repo });
    await execa('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-qm', 'baseline'], { cwd: repo });
  }
  const entry = options.cli ? [fileURLToPath(new URL('../../bin/koda.mjs', import.meta.url)), 'agent'] : ['--import', import.meta.resolve('tsx'), cli];
  const child = await execa(process.execPath, [...entry, "dev-run", "--repo", ".", "--task", fixture.task,
    "--script", script, "--output", output, ...(options.apply ? ['--apply'] : [])], { cwd: repo,
    env: { NODE_ENV: "test", OPENROUTER_API_KEY: "" }, reject: false, timeout: 90_000 });
  const summary = JSON.parse(await readFile(join(output, "summary.json"), "utf8"));
  const transcript = JSON.parse(await readFile(join(output, "fake-provider.json"), "utf8"));
  const events = (await readFile(join(output, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  return { parent, repo, output, child, summary, transcript, events, expectedSuccess: fixture.success };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const names = process.argv[2] ? [process.argv[2]] : Object.keys(fakeSmokeFixtures);
  for (const name of names) {
    const result = await runFakeSmoke(name);
    const passed = (result.summary.status === "VERIFIED_SUCCESS") === result.expectedSuccess &&
      (result.child.exitCode === 0) === result.expectedSuccess;
    console.log(`${passed ? "PASS" : "FAIL"} ${name}: ${result.summary.status} — ${result.output}`);
    if (!passed) { console.error(result.child.stderr); process.exitCode = 1; }
  }
}

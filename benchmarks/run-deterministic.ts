import { spawnSync } from "node:child_process";

const fixtures = [
  ["DIRECT", "tests/e2e.test.ts", "direct execution: success"],
  ["STABLE", "tests/stable.test.ts", "stable mode locks scope"],
  ["PLANNED", "tests/e2e.test.ts", "complete mocked OpenRouter run"],
] as const;

const results: Record<string, unknown>[] = [];
for (const [strategy, file, pattern] of fixtures) {
  const child = spawnSync(
    "pnpm",
    ["exec", "tsx", "--test", `--test-name-pattern=${pattern}`, file],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, KODA_DETERMINISTIC_BENCH: "1" },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const output = child.stdout + child.stderr;
  const marker = output.match(/KODA_BENCH (\{[^\n]+\})/);
  if (child.status !== 0 || !marker) {
    process.stderr.write(output);
    throw Error(
      `${strategy} deterministic fixture failed or emitted no metrics`,
    );
  }
  const result = JSON.parse(marker[1]!);
  if (
    result.status !== "VERIFIED_SUCCESS" ||
    result.strategy !== strategy.toLowerCase()
  )
    throw Error(`${strategy} returned ${result.status}/${result.strategy}`);
  results.push(result);
}
console.log(JSON.stringify(results, null, 2));

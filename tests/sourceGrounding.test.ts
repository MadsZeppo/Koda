import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { profileRepo } from "../src/repo/profiler.js";
import { retrieveSourceGrounding } from "../src/context/sourceGrounding.js";
import type { CommandResult } from "../src/types.js";

test("TypeScript grounding resolves imported classes and their referenced API types", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-grounding-ts-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/router.ts"),
      "export interface Router { choose(): string; estimateCost(): number; }\n");
    await writeFile(join(root, "src/client.ts"),
      "import type { Router } from './router.js'; export class Client { constructor(public router: Router) {} }\n");
    await writeFile(join(root, "src/feature.ts"),
      "import { Client } from './client.js'; export const feature = (client: Client) => client.router.choose();\n");
    const profile = await profileRepo(root);
    const definitions = await retrieveSourceGrounding(root, ["src/feature.ts"], profile, 5000);
    assert.ok(definitions.some((item) => item.path === "src/client.ts" && /class Client/.test(item.content)));
    assert.ok(definitions.some((item) => /Router/.test(item.symbol + item.content) &&
      /choose\(\).*estimateCost\(\)/s.test(item.content)));
    assert.ok(Buffer.byteLength(JSON.stringify(definitions)) <= 5000);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("language-neutral grounding resolves Python relative imports without path conventions", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-grounding-python-"));
  try {
    await mkdir(join(root, "app"));
    await writeFile(join(root, "app/contracts.py"),
      "class RouteInfo:\n    selected_model: str\n    expected_cost: float\n");
    await writeFile(join(root, "app/service.py"),
      "from .contracts import RouteInfo\n\ndef render(info: RouteInfo):\n    return info.selected_model\n");
    const profile = await profileRepo(root);
    const first = await retrieveSourceGrounding(root, ["app/service.py"], profile, 3000);
    const second = await retrieveSourceGrounding(root, ["app/service.py"], profile, 3000);
    assert.deepEqual(second, first, "unchanged retrieval is deterministic and deduplicated");
    assert.equal(new Set(first.map((item) => `${item.path}:${item.startLine}:${item.symbol}`)).size,
      first.length);
    assert.ok(first.some((item) => item.path === "app/contracts.py" &&
      /selected_model.*expected_cost/s.test(item.content)));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("compiler diagnostics retrieve the named real type while simple local code stays empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-grounding-diagnostic-"));
  try {
    await mkdir(join(root, "lib"));
    await writeFile(join(root, "lib/api.ts"),
      "export interface Api { existing(): void; cost(): number; }\n");
    await writeFile(join(root, "lib/use.ts"),
      "import type { Api } from './api.js'; export const use = (api: Api) => api.missing();\n");
    await writeFile(join(root, "lib/local.py"), "def local_value():\n    return 1\n");
    const profile = await profileRepo(root);
    const failure = {
      command: "typecheck", exitCode: 2, stdout: "",
      stderr: "lib/use.ts(1,75): error TS2339: Property 'missing' does not exist on type 'Api'.",
      wallClockMs: 1, timedOut: false, outcome: "CHECK_FAIL",
    } as CommandResult;
    const definitions = await retrieveSourceGrounding(root, ["lib/use.ts"], profile, 2400, [failure]);
    assert.ok(definitions.some((item) => /interface Api/.test(item.content) &&
      /existing\(\).*cost\(\)/s.test(item.content)));
    assert.deepEqual(await retrieveSourceGrounding(root, ["lib/local.py"], profile, 2400), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("test grounding prioritizes the called implementation body for the requested telemetry", async () => {
  const root = await mkdtemp(join(tmpdir(), "koda-grounding-called-method-"));
  try {
    await mkdir(join(root, "src")); await mkdir(join(root, "tests"));
    for (let index = 0; index < 8; index++)
      await writeFile(join(root, `src/noise${index}.ts`), `export const noise${index} = ${index};\n`);
    await writeFile(join(root, "src/router.ts"),
      "export class Router {\n  selectPlan() {\n    const selected_model = 'cheap';\n    const expected_completion_cost_usd = 0.2;\n    return { selected_model, expected_completion_cost_usd };\n  }\n}\n");
    await writeFile(join(root, "tests/router.test.ts"),
      `${Array.from({ length: 8 }, (_, index) => `import { noise${index} } from '../src/noise${index}.js';`).join("\n")}\n` +
      "import { Router } from '../src/router.js';\nconst route = new Router().selectPlan();\n" +
      "if (!route.selected_model) throw Error('missing');\n");
    const profile = await profileRepo(root);
    const definitions = await retrieveSourceGrounding(root, ["tests/router.test.ts"], profile,
      1800, [], "verify route telemetry selected model and expected completion cost");
    const method = definitions.find((item) => item.path === "src/router.ts" &&
      item.symbol === "selectPlan");
    assert.match(method?.content ?? "", /selected_model[\s\S]*expected_completion_cost_usd/);
    assert.ok(Buffer.byteLength(JSON.stringify(definitions)) <= 1800);
  } finally { await rm(root, { recursive: true, force: true }); }
});

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { config } from "../src/config.js";
import { compileContext } from "../src/context/compiler.js";
import { Budget } from "../src/openrouter/usage.js";
import { Gateway } from "../src/openrouter/client.js";
import { Logger } from "../src/telemetry/logger.js";
import { profileRepo } from "../src/repo/profiler.js";
import {
  OpenHandsExplorer,
  OpenHandsOperationalError,
  fastPathExploration,
  boundedTextEditExploration,
  withInferredFrameworkCreationTargets,
  modelFreeExplorationIsSufficient,
  deterministicRepositoryExploration,
  strategyWithExploration,
  type OpenHandsInvocation,
  type OpenHandsReport,
  type RepositoryExploration,
} from "../src/agent/openHandsExplorer.js";

test("local fallback prefers imported implementation over standalone patch scripts with matching words", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "update_budget.py"),
    "# budget router route attempt budget route attempt\nfrom pathlib import Path\nPath('src/budget.ts').write_text('export const attemptBudget = 1')\n");
  const profile = await profileRepo(f.root);
  const result = await deterministicRepositoryExploration(f.root,
    "Correct attempt budget routing and add focused tests", profile, ["update_budget.py"]);
  assert.ok(result.editableCandidates.some((file) => file.path === "src/budget.ts"));
  assert.equal(result.editableCandidates.some((file) => file.path === "update_budget.py"), false);
  const explicit = await deterministicRepositoryExploration(f.root,
    "Modify update_budget.py to correct its attempt budget routing", profile);
  assert.ok(explicit.editableCandidates.some((file) => file.path === "update_budget.py"),
    "an explicitly requested script must remain a valid implementation target");
});

test("failed exploration can localize a new route plus its existing navigation owner", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, "src/app"), { recursive: true });
  await mkdir(join(f.root, "src/components/site"), { recursive: true });
  await writeFile(join(f.root, "package.json"), JSON.stringify({ dependencies: { next: "16.0.0" } }));
  await writeFile(join(f.root, "src/app/page.tsx"),
    "import { SiteHeader } from '../components/site/header'; export default function Home(){return <SiteHeader/>}\n");
  await writeFile(join(f.root, "src/components/site/header.tsx"),
    "export function SiteHeader(){const links=[{href:'/',label:'Home'}];return <nav>{links.map(x=><a key={x.href} href={x.href}>{x.label}</a>)}</nav>}\n");
  await writeFile(join(f.root, "src/components/contact-link-form.tsx"),
    "export const contactLink = 'contact link contact link';\n");
  const profile = await profileRepo(f.root);
  const task = "Create a real page at /contact with heading Contact us. Add a Contact link to the existing navigation. Preserve the other links.";
  const localized = withInferredFrameworkCreationTargets(task, profile,
    await deterministicRepositoryExploration(f.root, task, profile));
  assert.deepEqual(localized.editableCandidates.map(({ path }) => path), [
    "src/components/site/header.tsx", "src/app/contact/page.tsx",
  ]);
  assert.equal(modelFreeExplorationIsSufficient(localized, task), true);
});

test("a new page without a named URL scopes its route and existing header, not a lexical API match", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, "src/app/api/billing"), { recursive: true });
  await mkdir(join(f.root, "src/components/site"), { recursive: true });
  await writeFile(join(f.root, "package.json"), JSON.stringify({ dependencies: { next: "16.0.0" } }));
  await writeFile(join(f.root, "src/app/page.tsx"),
    "import { SiteHeader } from '../components/site/header'; export default function Home(){return <SiteHeader/>}\n");
  await writeFile(join(f.root, "src/components/site/header.tsx"),
    "export function SiteHeader(){return <nav><a href='/pricing'>Pricing</a></nav>}\n");
  await writeFile(join(f.root, "src/app/api/billing/route.ts"),
    "export const GET=()=>Response.json({link:'billing'});\n");
  const profile = await profileRepo(f.root);
  for (const [task, route] of [
    ["Lav en ny side hvor du skriver om hvad virksomheden laver præcist. link til den i headeren ved pricing sektionen.",
      "src/app/hvad-virksomheden-laver-praecist/page.tsx"],
    ["Create a new Company overview page and link to it in the header near Pricing.",
      "src/app/company-overview/page.tsx"],
  ] as const) {
    const localized = withInferredFrameworkCreationTargets(task, profile,
      await deterministicRepositoryExploration(f.root, task, profile));
    const paths = localized.editableCandidates.map(({ path }) => path);
    assert.ok(paths.includes(route), `${route} must be writable before coding`);
    assert.ok(paths.includes("src/components/site/header.tsx"), "existing navigation owner must be writable");
    assert.equal(paths.includes("src/app/api/billing/route.ts"), false);
    assert.equal(modelFreeExplorationIsSufficient(localized, task), true,
      "repository-backed two-file scope should avoid paid repository rediscovery");
  }
  const ambiguous = "Create a new Company page and a new Pricing page.";
  const localized = withInferredFrameworkCreationTargets(ambiguous, profile,
    await deterministicRepositoryExploration(f.root, ambiguous, profile));
  assert.equal(localized.editableCandidates.some(({ path }) =>
    /src\/app\/[^/]+\/page\.tsx$/.test(path)), false,
  "multiple unnamed pages must not silently share one inferred route");
});
import { chooseExecutionStrategy, directWritePaths } from "../src/router/executionStrategy.js";
import { compileTaskSpec } from "../src/planner/taskSpec.js";
import { selectAiderFiles } from "../src/agent/aiderExecutor.js";
import { inferRepositoryDependencies } from "../src/orchestrator/dag.js";
import { schedule } from "../src/orchestrator/scheduler.js";
import type { Plan, Subtask } from "../src/planner/schemas.js";

async function fixture(t: any) {
  const base = await mkdtemp(join(tmpdir(), "koda-openhands-test-"));
  const root = join(base, "repo");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "tests"));
  await writeFile(join(root, "src/budget.ts"), "export const attemptBudget = 8192;\n");
  await writeFile(join(root, "src/router.ts"), "import { attemptBudget } from './budget.js';\nexport const route = attemptBudget;\n");
  await writeFile(join(root, "src/other.ts"), "export const unrelated = true;\n");
  await writeFile(join(root, "tests/budget.test.ts"), "import { attemptBudget } from '../src/budget.js';\n");
  t.after(() => rm(base, { recursive: true, force: true }));
  const settings = await config(undefined, {
    models: { SCOUT_MODEL: "mock/explorer" },
    budgetUsd: 1,
    maxTokens: 50_000,
    stageMaxTokens: 20_000,
    stageMaxUsd: .5,
    stageMaxMinutes: 1,
    baseUrl: "http://127.0.0.1:1/v1",
  });
  const logger = new Logger(join(base, "logs"), "openhands-test", true);
  const gateway = new Gateway(settings, logger, new Budget(1, 50_000, 60_000));
  return { root, profile: await profileRepo(root), gateway, logger };
}

const exploration = (overrides: Partial<RepositoryExploration> = {}): RepositoryExploration => ({
  confidence: "high",
  editableCandidates: [{ path: "src/budget.ts", reason: "defines the attempt budget" }],
  readonlyFiles: [{ path: "src/router.ts", reason: "consumes the budget" }],
  relatedTests: ["tests/budget.test.ts"],
  dependencies: [{ from: "src/router.ts", to: "src/budget.ts", kind: "import" }],
  evidence: [{ path: "src/budget.ts", detail: "attemptBudget is defined here" }],
  unresolvedQuestions: [],
  ...overrides,
});

const report = (result = exploration()): OpenHandsReport => ({
  status: "completed",
  sdkVersion: "1.50.0",
  providerDispatched: true,
  result,
  inputTokens: 300,
  outputTokens: 80,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  costUsd: .001,
  modelCalls: 3,
  toolCalls: 7,
  filesInspected: ["src/budget.ts", "src/router.ts", "tests/budget.test.ts"],
  wallClockMs: 25,
});

test("exact existing path uses the conservative zero-call fast path", async (t) => {
  const f = await fixture(t);
  const task = "Change src/budget.ts to use a larger constant.";
  const route = chooseExecutionStrategy(task, f.profile);
  const result = fastPathExploration(task, f.profile, route);
  assert.deepEqual(result?.editableCandidates.map(({ path }) => path), ["src/budget.ts"]);
  assert.deepEqual(result?.readonlyFiles, []);
});

test("exact missing file path uses the zero-call fast path and remains exact scope", async (t) => {
  const f = await fixture(t);
  const path = "tests/newFocusedSelection.test.ts";
  const task = `Create a new test file named ${path}. Make no unrelated changes.`;
  const route = chooseExecutionStrategy(task, f.profile);
  const result = fastPathExploration(task, f.profile, route);
  assert.equal(route.preciseTarget, path);
  assert.deepEqual(result?.editableCandidates.map(({ path }) => path), [path]);
  assert.equal(result?.confidence, "high");
});

test("unquoted Danish logo replacement uses a bounded local read without model exploration", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, "src/components"), { recursive: true });
  await writeFile(join(f.root, "src/components/brand-logo.tsx"),
    "export const BrandLogo=()=> <span>zeppo</span>;\n");
  const profile = await profileRepo(f.root);
  const task = "Gør så der på logoet i hjørnet står yeppo i stedet for zeppo";
  const result = await boundedTextEditExploration(f.root, task, profile);
  assert.equal(result?.confidence, "high");
  assert.deepEqual(result?.editableCandidates.map(({ path }) => path), [
    "src/components/brand-logo.tsx",
  ]);
  assert.match(result?.evidence[0]?.detail ?? "", /no model exploration required/i);
});

test("explicit new Next App Router route enters the initial editable scope", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, "src/app"), { recursive: true });
  await mkdir(join(f.root, "src/components"), { recursive: true });
  await writeFile(join(f.root, "src/app/page.tsx"), "export default function Home(){return null}\n");
  await writeFile(join(f.root, "src/app/layout.tsx"), "export default function Layout({children}:any){return children}\n");
  await writeFile(join(f.root, "src/app/globals.css"), "body { color: white; }\n");
  await writeFile(join(f.root, "src/components/header.tsx"), "export const Header=()=>null\n");
  await writeFile(join(f.root, "package.json"), JSON.stringify({ dependencies: { next: "16.0.0", react: "19.0.0" } }));
  const profile = await profileRepo(f.root);
  const localized = exploration({
    editableCandidates: [
      { path: "src/app/globals.css", reason: "global theme" },
      { path: "src/components/header.tsx", reason: "navigation" },
    ],
    readonlyFiles: [{ path: "src/app/page.tsx", reason: "home context" }],
    relatedTests: [], dependencies: [], evidence: [],
  });
  const task = compileTaskSpec(
    "Gør hele appens UI sort. Opret en rigtig side på routen /how-it-works og opdatér navigationens link.",
  ).routingPrompt;
  const result = withInferredFrameworkCreationTargets(
    task,
    profile,
    localized,
  );
  assert.deepEqual(result.editableCandidates.map(({ path }) => path), [
    "src/app/globals.css",
    "src/components/header.tsx",
    "src/app/page.tsx",
    "src/app/how-it-works/page.tsx",
  ]);
  assert.ok(result.evidence.some(({ path }) => path === "src/app/how-it-works/page.tsx"));
  assert.deepEqual(directWritePaths(result.editableCandidates.map(({ path }) => path), profile, task), [
    "src/app/globals.css",
    "src/components/header.tsx",
    "src/app/page.tsx",
    "src/app/how-it-works/page.tsx",
  ]);
});

test("localized visual task receives global CSS as read-only cascade evidence", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, "src/app"), { recursive: true });
  await writeFile(join(f.root, "src/app/page.tsx"),
    "export default function Home(){return <section className='bg-white'>Hello</section>}\n");
  await writeFile(join(f.root, "src/app/globals.css"),
    "body * { background-color: white !important; }\n");
  await writeFile(join(f.root, "package.json"), JSON.stringify({ dependencies: { next: "16.0.0" } }));
  const profile = await profileRepo(f.root);
  const result = withInferredFrameworkCreationTargets(
    "Make the homepage hero background dark navy and visible in the browser.",
    profile,
    exploration({
      editableCandidates: [{ path: "src/app/page.tsx", reason: "renders hero" }],
      readonlyFiles: [], relatedTests: [], dependencies: [], evidence: [],
    }),
  );
  assert.deepEqual(result.editableCandidates.map(({ path }) => path), ["src/app/page.tsx"]);
  assert.deepEqual(result.readonlyFiles.map(({ path }) => path), ["src/app/globals.css"]);
  const context = await compileContext(f.root, "Make the hero background dark navy",
    ["src/app/page.tsx", "src/app/globals.css"], profile, f.gateway.config.context, true);
  assert.match(context.files.find(({ path }) => path === "src/app/globals.css")?.snippet ?? "", /!important/);
});

test("site-wide theme controls make the proven global stylesheet writable", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, "src/app"), { recursive: true });
  await mkdir(join(f.root, "src/components"), { recursive: true });
  await writeFile(join(f.root, "package.json"), JSON.stringify({ dependencies: { next: "16.0.0" } }));
  await writeFile(join(f.root, "src/app/layout.tsx"),
    "import './globals.css'; export default function Layout({children}:any){return children}\n");
  await writeFile(join(f.root, "src/app/page.tsx"),
    "import { Header } from '../components/header'; export default function Home(){return <><Header/><main className='bg-white'>Home</main></>}\n");
  await writeFile(join(f.root, "src/app/globals.css"), ":root { --background: white; }\n");
  await writeFile(join(f.root, "src/components/header.tsx"),
    "export function Header(){return <nav><a href='/'>Home</a></nav>}\n");
  const profile = await profileRepo(f.root);
  const localized = exploration({
    editableCandidates: [{ path: "src/components/header.tsx", reason: "theme control" }],
    readonlyFiles: [{ path: "src/app/globals.css", reason: "theme context" }],
    relatedTests: [], dependencies: [], evidence: [],
  });
  for (const task of [
    "Add a dark mode toggle to the website header and preserve the choice between pages.",
    "Tilføj en mørk tilstand til hjemmesiden med en knap i headeren. Bevar valget mellem sider.",
  ]) {
    const result = withInferredFrameworkCreationTargets(task, profile, localized);
    const paths = result.editableCandidates.map(({ path }) => path);
    assert.ok(paths.includes("src/app/globals.css"), "shared theme CSS must be writable");
    assert.ok(paths.includes("src/app/page.tsx"), "hardcoded page colors require a writable owner");
    assert.equal(result.readonlyFiles.some(({ path }) => path === "src/app/globals.css"), false);
  }
  const restricted = withInferredFrameworkCreationTargets(
    "Only modify src/components/header.tsx. Add a dark mode toggle to the website header.",
    profile, localized);
  assert.deepEqual(restricted.editableCandidates.map(({ path }) => path),
    ["src/components/header.tsx"]);
  assert.ok(restricted.readonlyFiles.some(({ path }) => path === "src/app/globals.css"));
});

test("route inference stays bounded by convention, ambiguity and explicit restrictions", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, "src/app"), { recursive: true });
  await writeFile(join(f.root, "src/app/page.tsx"), "export default function Home(){return null}\n");
  await writeFile(join(f.root, "package.json"), JSON.stringify({ dependencies: { next: "16.0.0" } }));
  const profile = await profileRepo(f.root);
  const localized = exploration({ relatedTests: [], dependencies: [], evidence: [] });
  const unchanged = (task: string) => withInferredFrameworkCreationTargets(task, profile, localized)
    .editableCandidates.map(({ path }) => path);
  assert.deepEqual(unchanged("Update the navigation link to /docs."), ["src/budget.ts"]);
  assert.deepEqual(unchanged("Create pages for /docs and /pricing."), ["src/budget.ts"]);
  assert.deepEqual(unchanged("Create a page at /docs. Only modify src/budget.ts."), ["src/budget.ts"]);
  assert.deepEqual(unchanged("Create a page at /docs/[slug]."), ["src/budget.ts"]);
});

test("explicit Next API endpoint receives a bounded new route write target", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, "src/app/api/bridge/webhook"), { recursive: true });
  await writeFile(join(f.root, "src/app/page.tsx"), "export default function Home(){return null}\n");
  await writeFile(join(f.root, "src/app/api/bridge/webhook/route.ts"),
    "export const POST=()=>Response.json({ok:true});\n");
  await writeFile(join(f.root, "package.json"), JSON.stringify({ dependencies: { next: "16.0.0" } }));
  const profile = await profileRepo(f.root);
  const localized = exploration({
    editableCandidates: [{ path: "src/app/api/bridge/webhook/route.ts", reason: "related existing webhook" }],
    readonlyFiles: [], relatedTests: [], dependencies: [], evidence: [],
  });
  const task = "Implementér et sikkert webhook-endpoint i backend på /api/webhooks/events.";
  const result = withInferredFrameworkCreationTargets(task, profile, localized);
  assert.deepEqual(result.editableCandidates.map(({ path }) => path), [
    "src/app/api/bridge/webhook/route.ts",
    "src/app/api/webhooks/events/route.ts",
  ]);
  assert.deepEqual(directWritePaths(result.editableCandidates.map(({ path }) => path), profile, task),
    result.editableCandidates.map(({ path }) => path));
  assert.equal(result.editableCandidates.some(({ path }) => path.endsWith("/page.tsx")), false);
  assert.deepEqual(withInferredFrameworkCreationTargets(
    "Only modify src/app/api/bridge/webhook/route.ts. Implement /api/webhooks/events.", profile, localized,
  ).editableCandidates, localized.editableCandidates);
  assert.deepEqual(withInferredFrameworkCreationTargets(
    "Create endpoints /api/webhooks/events and /api/webhooks/status.", profile, localized,
  ).editableCandidates, localized.editableCandidates);
});

test("fallback localization covers distinct quoted navigation and global-theme requirements", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, "src/app"), { recursive: true });
  await mkdir(join(f.root, "src/components"), { recursive: true });
  await writeFile(join(f.root, "src/app/page.tsx"),
    "import { Header } from '../components/header'; export default function Home(){return <Header/>}\n");
  await writeFile(join(f.root, "src/app/layout.tsx"),
    "import './globals.css'; export default function Layout({children}:any){return children}\n");
  await writeFile(join(f.root, "src/app/globals.css"), "body { background: white; }\n");
  await writeFile(join(f.root, "src/components/header.tsx"),
    "export const Header=()=> <a href='#how-it-works'>How it works</a>\n");
  await writeFile(join(f.root, "package.json"), JSON.stringify({ dependencies: { next: "16.0.0", react: "19.0.0" } }));
  const profile = await profileRepo(f.root);
  const task = "Make the whole app UI black. Create a page at /how-it-works and update the 'How it works' navigation link.";
  const localized = await deterministicRepositoryExploration(f.root, task, profile);
  const result = withInferredFrameworkCreationTargets(task, profile, localized);
  assert.ok(result.editableCandidates.some(({ path }) => path === "src/components/header.tsx"));
  assert.ok(result.editableCandidates.some(({ path }) => path === "src/app/globals.css"));
  assert.ok(result.editableCandidates.some(({ path }) => path === "src/app/page.tsx"));
  assert.ok(result.editableCandidates.some(({ path }) => path === "src/app/how-it-works/page.tsx"));
  assert.equal(modelFreeExplorationIsSufficient(result), true,
    "an explicit static route plus repository-backed targets needs no model exploration");
});

test("existing route content and navigation labels keep both literal owners in bounded local scope", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, "src/app/how-it-works"), { recursive: true });
  await mkdir(join(f.root, "src/components/landing"), { recursive: true });
  await writeFile(join(f.root, "src/app/page.tsx"),
    "import {Header} from '../components/landing/header';export default function Home(){return <Header/>}\n");
  await writeFile(join(f.root, "src/app/globals.css"), "body { background: white; }\n");
  await writeFile(join(f.root, "src/app/how-it-works/page.tsx"),
    "export default function Page(){return <><h1>How It Works</h1><p>jeg elsker betalinger</p></>}\n");
  await writeFile(join(f.root, "src/components/landing/header.tsx"),
    "export const Header=()=> <a href='/how-it-works'>How it works</a>\n");
  await writeFile(join(f.root, "package.json"), JSON.stringify({ dependencies: { next: "16.0.0" } }));
  const profile = await profileRepo(f.root);
  const task = "Gør hele appens UI sort. Opret /how-it-works med teksten 'jeg elsker betalinger'. Opdatér 'How it works'-linket til /how-it-works.";
  const result = withInferredFrameworkCreationTargets(task, profile,
    await deterministicRepositoryExploration(f.root, task, profile));
  assert.ok(result.editableCandidates.some(({ path }) => path === "src/app/how-it-works/page.tsx"));
  assert.ok(result.editableCandidates.some(({ path }) => path === "src/components/landing/header.tsx"));
  assert.ok(result.editableCandidates.some(({ path }) => path === "src/app/globals.css"));
  assert.ok(result.editableCandidates.some(({ path }) => path === "src/app/page.tsx"));
  assert.equal(modelFreeExplorationIsSufficient(result), true);
});

test("model-free exploration remains conservative for ordinary behavior work", () => {
  assert.equal(modelFreeExplorationIsSufficient(exploration()), false);
});

test("application-wide visual wording uses proved framework scope without model exploration", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, "src/app"), { recursive: true });
  await writeFile(join(f.root, "src/app/layout.tsx"),
    "import './globals.css'; export default function Layout({children}:any){return children}\n");
  await writeFile(join(f.root, "src/app/page.tsx"),
    "export default function Home(){return <main>Home</main>}\n");
  await writeFile(join(f.root, "src/app/globals.css"), "body { background: white; }\n");
  await writeFile(join(f.root, "package.json"), JSON.stringify({ dependencies: { next: "16.0.0" } }));
  const profile = await profileRepo(f.root);

  for (const task of [
    "Make all pages on the entire website black.",
    "Gør alle sider på hele hjemmesiden sort.",
  ]) {
    const result = withInferredFrameworkCreationTargets(task, profile,
      await deterministicRepositoryExploration(f.root, task, profile));
    assert.deepEqual(result.editableCandidates.map(({ path }) => path).sort(),
      ["src/app/globals.css", "src/app/page.tsx"]);
    assert.equal(modelFreeExplorationIsSufficient(result, task), true);
    const strategy = strategyWithExploration(task, chooseExecutionStrategy(task, profile), {
      ...result, confidence: "high", unresolvedQuestions: [],
    });
    assert.equal(strategy.execution_strategy, "direct");
    assert.equal(strategy.execution_effort, "normal");
  }
});

test("page-wide professional redesign includes both rendered page and global cascade owner", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, "src/app"), { recursive: true });
  await writeFile(join(f.root, "src/app/layout.tsx"),
    "import './globals.css'; export default function Layout({children}:any){return children}\n");
  await writeFile(join(f.root, "src/app/page.tsx"),
    "export default function Home(){return <main className='hero'>Home</main>}\n");
  await writeFile(join(f.root, "src/app/globals.css"),
    "body * { color: black !important; background: white !important; }\n");
  await writeFile(join(f.root, "package.json"), JSON.stringify({ dependencies: { next: "16.0.0" } }));
  const profile = await profileRepo(f.root);
  const task = "Gør hele forsiden top level, meget flot og professionel med en moderne Stripe-lignende stil.";
  const result = withInferredFrameworkCreationTargets(task, profile,
    await deterministicRepositoryExploration(f.root, task, profile));
  assert.deepEqual(result.editableCandidates.map(({ path }) => path).sort(),
    ["src/app/globals.css", "src/app/page.tsx"]);
  assert.equal(modelFreeExplorationIsSufficient(result, task), true);
});

test("single destination-page copy edit accepts deterministic local evidence without OpenHands", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, "src/app/how-it-works"), { recursive: true });
  await writeFile(join(f.root, "src/app/how-it-works/page.tsx"),
    "export default function Page(){return <p>jeg elsker betalinger</p>}\n");
  await writeFile(join(f.root, "src/other.ts"), "export const unrelated = true\n");
  const profile = await profileRepo(f.root);
  const task = "ændrer teksten inde på den side man kommer til fra how it works til 'hej jeg hedder y'";
  const local = await deterministicRepositoryExploration(f.root, task, profile);
  assert.deepEqual(local.editableCandidates.map(({ path }) => path),
    ["src/app/how-it-works/page.tsx"]);
  assert.equal(modelFreeExplorationIsSufficient(local, task), true);
  const strategy = strategyWithExploration(task, chooseExecutionStrategy(task, profile), {
    ...local, confidence: "high",
  });
  assert.equal(strategy.execution_effort, "tiny");
});

test("OpenHands line-number locations authorize only the underlying repository path", async (t) => {
  const f = await fixture(t);
  const result = await new OpenHandsExplorer(f.gateway, { runner: async () => report(exploration({
    editableCandidates: [{ path: "src/budget.ts:1", reason: "definition at line 1" }],
    readonlyFiles: [], relatedTests: [], dependencies: [],
    evidence: [{ path: "src/budget.ts:1:8", detail: "exact symbol location" }],
  })) }).explore({ repoPath: f.root, task: "Update budget", profile: f.profile });
  assert.deepEqual(result.editableCandidates.map(({ path }) => path), ["src/budget.ts"]);
  assert.deepEqual(result.evidence.map(({ path }) => path), ["src/budget.ts"]);
});

test("no-path behavior task uses OpenHands and forwards implementation evidence to Aider", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const result = await new OpenHandsExplorer(f.gateway, { runner: async () => { calls++; return report(); } }).explore({
    repoPath: f.root,
    task: "Fix coding attempts that exhaust their budget before provider dispatch.",
    profile: f.profile,
  });
  const selected = selectAiderFiles({
    repoPath: f.root, attemptId: "test", task: "fix", model: "mock/model",
    budgetUsd: .1, maxTokens: 10_000, maxSteps: 1, timeoutMs: 1,
    requestTimeoutMs: 1, commandTimeoutMs: 1, maxOutputTokens: 1,
    baseUrl: "http://localhost", writeScope: result.editableCandidates.map(({ path }) => path),
    context: {
      relevantFiles: [...result.editableCandidates, ...result.readonlyFiles].map(({ path }) => path),
      completePaths: result.editableCandidates.map(({ path }) => path),
      evidence: { relevantFiles: result.editableCandidates.map(({ path }) => path) },
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(selected.editable, ["src/budget.ts"]);
  assert.deepEqual(selected.readOnly, ["src/router.ts"]);
});

test("OpenHands evidence overrides a wrong cheap initial hint", async (t) => {
  const f = await fixture(t);
  const route = strategyWithExploration("Fix provider budget exhaustion", {
    execution_strategy: "direct", execution_effort: "normal",
    strategy_reason: "cheap hint", likelyFiles: ["src/other.ts"], preciseTarget: "src/other.ts",
  }, exploration());
  assert.equal(route.preciseTarget, "src/budget.ts");
  assert.equal(route.likelyFiles.includes("src/other.ts"), false);
});

test("an explicit discovered test target prevents promotion of additional related tests", () => {
  const evidence = exploration({
    editableCandidates: [
      { path: "src/budget.ts", reason: "implementation target" },
      { path: "tests/newBudget.test.ts", reason: "requested new test" },
    ],
    relatedTests: ["tests/budget.test.ts"],
  });
  strategyWithExploration("Add focused tests for the budget helper", {
    execution_strategy: "direct", execution_effort: "normal",
    strategy_reason: "bounded", likelyFiles: [],
  }, evidence);
  assert.deepEqual(evidence.editableCandidates.map(({ path }) => path), [
    "src/budget.ts", "tests/newBudget.test.ts",
  ]);
  assert.deepEqual(evidence.relatedTests, ["tests/budget.test.ts"]);
});

test("multiple implementation candidates remain in the authorized scope", async (t) => {
  const f = await fixture(t);
  const result = await new OpenHandsExplorer(f.gateway, { runner: async () => report(exploration({
    editableCandidates: [
      { path: "src/budget.ts", reason: "defines budget" },
      { path: "src/router.ts", reason: "applies budget" },
    ],
    readonlyFiles: [],
  })) }).explore({ repoPath: f.root, task: "Update budget routing", profile: f.profile });
  assert.deepEqual(result.editableCandidates.map(({ path }) => path), ["src/budget.ts", "src/router.ts"]);
});

test("OpenHands may authorize a safe missing path as a new editable file", async (t) => {
  const f = await fixture(t);
  const result = await new OpenHandsExplorer(f.gateway, {
    runner: async () => report(exploration({
      editableCandidates: [{
        path: "src/executionOutcome.ts",
        reason: "A new reusable module is the smallest design",
      }],
      readonlyFiles: [{ path: "src/router.ts", reason: "integration context" }],
      dependencies: [{
        from: "src/router.ts",
        to: "src/executionOutcome.ts",
        kind: "will import",
      }],
      evidence: [{
        path: "src/executionOutcome.ts",
        detail: "authorized new module",
      }],
    })),
  }).explore({ repoPath: f.root, task: "Create a reusable execution outcome module", profile: f.profile });

  assert.deepEqual(result.editableCandidates.map(({ path }) => path), [
    "src/executionOutcome.ts",
  ]);
});

test("missing read-only and evidence paths remain invalid", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    new OpenHandsExplorer(f.gateway, {
      runner: async () => report(exploration({
        readonlyFiles: [{ path: "src/missing.ts", reason: "not inspected" }],
      })),
    }).explore({ repoPath: f.root, task: "Inspect budgeting", profile: f.profile }),
    /unknown repository path/,
  );
});

test("readonly dependencies and tests never become editable", async (t) => {
  const f = await fixture(t);
  const result = await new OpenHandsExplorer(f.gateway, { runner: async () => report() }).explore({
    repoPath: f.root, task: "Fix attempt budgeting", profile: f.profile,
  });
  assert.deepEqual(result.readonlyFiles.map(({ path }) => path), ["src/router.ts"]);
  assert.deepEqual(result.relatedTests, ["tests/budget.test.ts"]);
  assert.equal(result.editableCandidates.some(({ path }) => path === "src/router.ts"), false);
});

test("invalid and escaping OpenHands paths are rejected", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    new OpenHandsExplorer(f.gateway, { runner: async () => report(exploration({
      editableCandidates: [{ path: "../outside.ts", reason: "invalid" }],
    })) }).explore({ repoPath: f.root, task: "Fix budget", profile: f.profile }),
    OpenHandsOperationalError,
  );
});

test("OpenHands operational failure is classified without coding-model quality evidence", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    new OpenHandsExplorer(f.gateway, { runner: async () => ({
      ...report(), status: "infra_failure", result: undefined, providerDispatched: false,
      error: "SDK unavailable",
    }) }).explore({ repoPath: f.root, task: "Fix budget", profile: f.profile }),
    /SDK unavailable/,
  );
  assert.equal(f.logger.events.some((event) => event.type === "model_attempt"), false);
  assert.equal(f.logger.events.findLast((event) => event.type === "repo_exploration_failure")?.operational, true);
});

const subtask = (id: string, writes: string[], reads: string[] = []): Subtask => ({
  id, title: id, objective: id, dependsOn: [], likelyReadPaths: reads,
  likelyWritePaths: writes, integrationContract: id, verificationCommands: [],
  estimatedDifficulty: "normal", parallelSafe: true,
});

test("large exploration evidence can build dependency-aware work units", () => {
  const provider = { ...subtask("budget", ["src/budget.ts"]), provides: ["AttemptBudget"] };
  const consumer = { ...subtask("router", ["src/router.ts"], ["src/budget.ts"]), consumes: ["AttemptBudget"] };
  const plan: Plan = { taskSummary: "budget and router", acceptanceCriteria: ["works"], subtasks: [provider, consumer] };
  const inferred = inferRepositoryDependencies(plan, exploration().dependencies);
  assert.deepEqual(consumer.dependsOn, ["budget"]);
  assert.equal(inferred.length, 1);
});

test("independent evidence-backed work remains parallel", async () => {
  const plan = [subtask("budget", ["src/budget.ts"]), subtask("other", ["src/other.ts"])];
  let active = 0, peak = 0;
  const result = await schedule(plan, 2, async () => {
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
  });
  assert.equal(peak, 2);
  assert.equal(result.peak, 2);
});

test("producer and consumer evidence preserves dependency order", async () => {
  const provider = subtask("budget", ["src/budget.ts"]);
  const consumer = { ...subtask("router", ["src/router.ts"]), dependsOn: ["budget"] };
  const order: string[] = [];
  await schedule([provider, consumer], 2, async (item) => { order.push(item.id); });
  assert.deepEqual(order, ["budget", "router"]);
});

test("scope expansion uses a bounded OpenHands continuation with prior evidence", async (t) => {
  const f = await fixture(t);
  let invocation: OpenHandsInvocation | undefined;
  const previous = exploration({ confidence: "medium" });
  await new OpenHandsExplorer(f.gateway, { runner: async (value) => { invocation = value; return report(); } }).explore({
    repoPath: f.root, task: "Investigate the requested additional write path", profile: f.profile,
    previousExploration: previous, continuationReason: "scope_expansion_required: src/router.ts",
  });
  assert.deepEqual(invocation?.previousExploration, previous);
  assert.match(invocation?.continuationReason ?? "", /scope_expansion_required/);
  assert.ok((invocation?.maxTokens ?? Infinity) <= 12_000);
  assert.ok((invocation?.maxTokens ?? Infinity) <= f.gateway.config.stageMaxTokens);
  assert.ok((invocation?.maxInputTokens ?? Infinity) +
    (invocation?.maxOutputTokens ?? Infinity) <= f.gateway.config.maxTokens);
});

test("verification diagnostics can drive an evidence-preserving continuation", async (t) => {
  const f = await fixture(t);
  let invocation: OpenHandsInvocation | undefined;
  await new OpenHandsExplorer(f.gateway, { runner: async (value) => { invocation = value; return report(); } }).explore({
    repoPath: f.root, task: "Resolve the failed focused verification", profile: f.profile,
    previousExploration: exploration(), continuationReason: "Type error references src/router.ts:1",
  });
  assert.match(invocation?.continuationReason ?? "", /src\/router\.ts/);
  assert.equal(invocation?.previousExploration?.editableCandidates[0]?.path, "src/budget.ts");
});

test("read-only guard restores the repository if a runner attempts mutation", async (t) => {
  const f = await fixture(t);
  const original = await readFile(join(f.root, "src/budget.ts"), "utf8");
  await assert.rejects(
    new OpenHandsExplorer(f.gateway, { runner: async () => {
      await writeFile(join(f.root, "src/budget.ts"), "mutated\n");
      return report();
    } }).explore({ repoPath: f.root, task: "Inspect budget", profile: f.profile }),
    /read-only violation/i,
  );
  assert.equal(await readFile(join(f.root, "src/budget.ts"), "utf8"), original);
});

for (const task of [
  "On the homepage change the primary button text to 'Start now'. Preserve its link and design.",
  "På forsiden: ændr teksten på den primære knap til 'Kom i gang'. Bevar link og design.",
]) test(`bounded UI text localization avoids model discovery: ${task}`, async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, "src/app"), { recursive: true });
  await writeFile(join(f.root, "src/app/page.tsx"),
    "import {CTA} from '../cta';export default function Home(){return <CTA href='/start'>Begin</CTA>}");
  await writeFile(join(f.root, "src/cta.tsx"), "export const CTA=()=>null;");
  for (let i = 0; i < 70; i++) await writeFile(join(f.root, `src/route${i}.tsx`), "export const link='Start now';");
  const profile = await profileRepo(f.root);
  const evidence = await boundedTextEditExploration(f.root, task, profile);
  assert.equal(evidence?.confidence, "high");
  assert.deepEqual(evidence?.editableCandidates.map(({path})=>path), ["src/app/page.tsx"]);
  assert.deepEqual(evidence?.readonlyFiles.map(({path})=>path), ["src/cta.tsx"]);
  assert.match(evidence!.evidence[0]!.detail, /inspected locally/);
  const strategy = strategyWithExploration(task, chooseExecutionStrategy(task, profile), evidence!);
  assert.equal(strategy.execution_strategy, "direct");
  assert.equal(strategy.execution_effort, "tiny");
  assert.equal(strategy.preciseTarget, "src/app/page.tsx");
});

test("bounded text localization declines ambiguity, explicit restrictions, large files and behavior work", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, "src/app"), {recursive:true});
  await mkdir(join(f.root, "pages"));
  await writeFile(join(f.root, "src/app/page.tsx"), "export default()=> <button>Old</button>");
  const task = "Change the homepage button text to 'New'";
  let profile = await profileRepo(f.root);
  assert.ok(await boundedTextEditExploration(f.root, task, profile));
  assert.equal(await boundedTextEditExploration(f.root, task + ". Modify only src/other.ts", profile), undefined);
  assert.equal(await boundedTextEditExploration(f.root, task + ". Modify only files within src/app", profile), undefined);
  assert.equal(await boundedTextEditExploration(f.root, task + " and implement authentication", profile), undefined);
  await writeFile(join(f.root, "pages/index.tsx"), "export default()=> <button>Old</button>");
  profile = await profileRepo(f.root);
  assert.equal(await boundedTextEditExploration(f.root, task, profile), undefined);
  await rm(join(f.root, "pages/index.tsx"));
  await writeFile(join(f.root, "src/app/page.tsx"), "x".repeat(33_000));
  profile = await profileRepo(f.root);
  assert.equal(await boundedTextEditExploration(f.root, task, profile), undefined);
});

test("explicit existing scope skips semantic discovery even for complex independent batch logic", async t => {
  const f=await fixture(t);
  const task="Modify src/budget.ts and add regression tests in tests/budget.test.ts. Implement three algorithms behind a batch API; each invocation must be independent. Preserve every requirement.";
  const route={...chooseExecutionStrategy(task,f.profile),execution_strategy:"stable" as const};
  const result=fastPathExploration(task,f.profile,route);
  assert.deepEqual(result?.editableCandidates.map(x=>x.path).sort(),["src/budget.ts","tests/budget.test.ts"]);
  assert.equal(fastPathExploration("Refactor throughout the entire repository including src/budget.ts",f.profile,route),undefined);
  const readonly=fastPathExploration("Modify src/budget.ts. Read tests/budget.test.ts as context; preserve existing tests.",f.profile,route);
  assert.ok(!readonly?.editableCandidates.some(x=>x.path==="tests/budget.test.ts"));
});

test('header copy localization follows UI imports instead of identical favicon literals in a large repo', async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'src/components'), { recursive: true });
  await mkdir(join(f.root, 'src/app'), { recursive: true });
  await writeFile(join(f.root, 'src/components/site-header.tsx'), "import { Logo } from '@site/brand-logo';export function Header(){return <header><Logo/></header>}");
  await writeFile(join(f.root, 'tsconfig.json'), JSON.stringify({compilerOptions:{paths:{'@site/*':['./src/components/*']}}}));
  await writeFile(join(f.root, 'src/components/brand-logo.tsx'), "export function Logo(){return <span>sample.</span>}");
  await writeFile(join(f.root, 'src/app/icon.tsx'), "export default function Icon(){return <span>sample.</span>}");
  await writeFile(join(f.root, 'src/app/apple-icon.tsx'), "export default function Icon(){return <span>sample.</span>}");
  for (let i = 0; i < 20; i++) await writeFile(join(f.root, `src/other-${i}.tsx`), 'export default()=> <div/>');
  const profile = await profileRepo(f.root);
  const evidence = await boundedTextEditExploration(f.root, 'Ændrer navnet på headeren fra sample. til newname', profile);
  assert.deepEqual(evidence?.editableCandidates.map(file => file.path), ['src/components/brand-logo.tsx']);
  assert.ok(evidence?.readonlyFiles.some(file => file.path === 'src/components/site-header.tsx'));
  await writeFile(join(f.root, 'src/components/brand-logo.tsx'), 'export function Logo(){return <span>other</span>}');
  assert.equal(await boundedTextEditExploration(f.root, 'Change header text from sample. to newname', profile), undefined,
    'favicon-only evidence must not authorize a header edit');
});

test('fallback preserves all explicit multi-file edits including entrypoint and tests, excluding preserved files',async t=>{
 const f=await fixture(t);await mkdir(join(f.root,'src/operations'));
 const paths=['src/index.cjs','src/operations/a.cjs','src/operations/b.cjs','src/operations/c.cjs','tests/api.test.cjs'];
 for(const p of paths)await writeFile(join(f.root,p),'module.exports=()=>null;');
 const profile=await profileRepo(f.root);
 const task='Modify src/index.cjs and src/operations/a.cjs, src/operations/b.cjs, src/operations/c.cjs. Add regression tests in tests/api.test.cjs. Preserve package.json and README.md.';
 const result=await deterministicRepositoryExploration(f.root,task,profile);
 for(const path of paths)assert.ok(result.editableCandidates.some(p=>p.path===path),path);
 assert.ok(!result.editableCandidates.some(p=>p.path==='package.json'));
 const restricted=await deterministicRepositoryExploration(f.root,'Modify only src/index.cjs. Do not modify src/operations/a.cjs.',profile);
 assert.deepEqual(restricted.editableCandidates.map(p=>p.path),['src/index.cjs']);
});

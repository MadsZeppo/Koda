import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import {
  AiderExecutor,
  aiderOpenRouterModel,
  estimateAiderPromptBytes,
  preferredAiderFormat,
  selectAiderFiles,
  type AiderInvocation,
} from "../src/agent/aiderExecutor.js";
import { ensureAiderRuntime } from "../src/agent/aiderRuntime.js";
import { Budget } from "../src/openrouter/usage.js";
import { Logger } from "../src/telemetry/logger.js";
import { config } from "../src/config.js";
import { implement } from "../src/agent/codingExecutor.js";
import { History } from "../src/router/history.js";
import { modelSchema } from "../src/router/pool.js";
import type { CodingWorkerInput } from "../src/agent/codingWorker.js";

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "koda-aider-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-secret-not-paid";
  t.after(() => { if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous; });
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/value.cjs"), "module.exports = 1;\n");
  await writeFile(join(root, "src/other.cjs"), "module.exports = 1;\n");
  await execa("git", ["init", "-q"], { cwd: root });
  await execa("git", ["add", "."], { cwd: root });
  await execa("git", ["-c", "user.name=Koda", "-c", "user.email=koda@localhost", "commit", "-qm", "baseline"], { cwd: root });
  return root;
}
const input = (root: string): CodingWorkerInput => ({ repoPath: root, attemptId: "test",
  task: "Change both values to 3", model: "foo/bar", budgetUsd: .1,
  maxTokens: 10000, maxSteps: 4, timeoutMs: 30000, requestTimeoutMs: 5000,
  commandTimeoutMs: 2000, maxOutputTokens: 1000, promptPricePerMillion: 1,
  completionPricePerMillion: 1, baseUrl: "http://localhost:1", writeScope: ["src"],
  context: { relevantFiles: ["src/value.cjs", "src/other.cjs"],
    completePaths: ["src/value.cjs", "src/other.cjs"],
    evidence: { relevantFiles: ["src/value.cjs", "src/other.cjs"] } } });
const success = { command: "mock aider", cwd: ".", exitCode: 0, stdout: "done", stderr: "", timedOut: false, wallClockMs: 2 };
async function report(i: AiderInvocation, format: string, failureKind?: string) {
  await writeFile(i.reportPath, JSON.stringify({ format, failureKind, version: "mock" }));
  await writeFile(i.ledgerPath, JSON.stringify({ costUsd: .001, tokens: 20, inputTokens: 10, outputTokens: 10, steps: 1 }));
}
function worker(root: string, runner: NonNullable<ConstructorParameters<typeof AiderExecutor>[2]>["runner"]) {
  return new AiderExecutor(new Budget(1, 100000, 60000), new Logger(join(root, ".koda"), "aider", true),
    { ensureRuntime: async () => "mock-python", runner });
}

test("arbitrary OpenRouter model IDs transform deterministically without an allowlist", () => {
  for (const id of ["foo/bar", "new-company/future-model:free", "vendor/model-v123", "openrouter/future-route"]) {
    assert.equal(aiderOpenRouterModel(id), `openrouter/${id}`);
  }
});

test("Aider file handoff keeps grounded source editable and tests/read context read-only", () => {
  const selected = selectAiderFiles({
    ...input("/repo"),
    writeScope: ["."],
    task: "Fix the failing value test without changing the test",
    context: {
      relevantFiles: ["package.json", "src/value.cjs", "tests/value.test.cjs", "../outside.cjs", "."],
      sourceFiles: [
        { path: "package.json", snippet: "{}" },
        { path: "src/value.cjs", snippet: "module.exports = 1" },
      ],
      completePaths: [],
      evidence: { relevantFiles: ["src/value.cjs", "tests/value.test.cjs"] },
    },
  });
  assert.deepEqual(selected.editable, ["src/value.cjs"]);
  assert.deepEqual(selected.readOnly, ["tests/value.test.cjs", "package.json"]);
});

test(
  "Aider prompt forecast uses real attached files instead of duplicating source snippets",
  async (t) => {
    const root = await fixture(t);

    const hugeDuplicatedSnippet =
      "x".repeat(100_000);

    const bytes =
      await estimateAiderPromptBytes({
        repoPath: root,
        task: "Change both values to 3",
        writeScope: ["src"],
        context: {
          relevantFiles: [
            "src/value.cjs",
            "src/other.cjs",
          ],
          sourceFiles: [
            {
              path: "src/value.cjs",
              snippet:
                hugeDuplicatedSnippet,
            },
            {
              path: "src/other.cjs",
              snippet:
                hugeDuplicatedSnippet,
            },
          ],
          completePaths: [
            "src/value.cjs",
            "src/other.cjs",
          ],
          evidence: {
            relevantFiles: [
              "src/value.cjs",
              "src/other.cjs",
            ],
          },
        },
      });

    assert.ok(
      bytes < 20_000,
      `duplicated source snippets leaked into Aider prompt estimate: ${bytes}`,
    );
  },
);


test("Aider invocation pre-attaches bounded editable and read-only files without interactive add", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, "tests"));
  await writeFile(join(root, "tests/value.test.cjs"), "const {test}=require('node:test'); test('value',()=>{});\n");
  const runInput: CodingWorkerInput = {
    ...input(root),
    writeScope: ["."],
    task: "Fix the failing value test. Make the smallest correct source change.",
    context: {
      relevantFiles: ["src/value.cjs", "tests/value.test.cjs"],
      sourceFiles: [
        { path: "src/value.cjs", snippet: "module.exports = 1" },
        { path: "tests/value.test.cjs", snippet: "test" },
      ],
      completePaths: [],
      evidence: { relevantFiles: ["src/value.cjs", "tests/value.test.cjs"] },
    },
  };
  const w = worker(root, async (cwd, i) => {
    assert.ok(i.args[2]);
    assert.equal(i.args[3], "src/value.cjs");
    const readIndex = i.args.indexOf("--read");
    assert.ok(readIndex > 0);
    assert.equal(i.args[readIndex + 1], "tests/value.test.cjs");
    assert.equal(i.args.includes("."), false);
    assert.equal(i.args.includes("../outside.cjs"), false);

    const messageIndex =
      i.args.indexOf("--message-file");

    assert.ok(messageIndex >= 0);

    const message = await readFile(
      i.args[messageIndex + 1]!,
      "utf8",
    );

    assert.match(
      message,
      /Fix the failing value test/,
    );

    assert.doesNotMatch(
      message,
      /Koda context:/,
    );

    assert.doesNotMatch(
      message,
      /"sourceFiles"\s*:/,
    );

    assert.doesNotMatch(
      message,
      /module\.exports = 1/,
    );

    await writeFile(join(cwd, "src/value.cjs"), "module.exports = 3;\n");
    await report(i, "whole");
    return success;
  });
  const result = await w.run(runInput);
  assert.equal(result.exitStatus, "completed");
  assert.deepEqual(result.changedPaths, ["src/value.cjs"]);
});

test("Aider refuses to dispatch until repository exploration supplies an editable file", async (t) => {
  const root = await fixture(t);
  let dispatched = false;
  const w = worker(root, async () => { dispatched = true; return success; });
  const result = await w.run({ ...input(root), context: undefined });
  assert.equal(dispatched, false);
  assert.equal(result.exitStatus, "infra_failure");
  assert.match(result.terminationReason!, /missing_editable_scope/);
});

test("attempt-local Aider preflight exhaustion remains operational evidence", async (t) => {
  const root = await fixture(t);
  const result = await worker(root, async (_cwd, i) => {
    await report(i, "diff", "attempt_budget_exhausted");
    return { ...success, exitCode: 1 };
  }).run({ ...input(root), context: {
    relevantFiles: ["src/value.cjs"],
    completePaths: ["src/value.cjs"],
    evidence: { relevantFiles: ["src/value.cjs"] },
  } });
  assert.equal(result.exitStatus, "infra_failure");
  assert.equal(result.terminationReason, "attempt_budget_exhausted");
  assert.equal(result.limitKind, "token_preflight");
  assert.equal(result.progressPhase, "DISCOVERY");
});

test("Aider sandbox metadata never becomes an authorized source change", async (t) => {
  const root = await fixture(t);
  const original = await readFile(join(root, ".git/config"), "utf8");
  const result = await worker(root, async (cwd, i) => {
    await writeFile(join(cwd, ".git/config"), "[unsafe]\nvalue=true\n");
    await report(i, "diff");
    return success;
  }).run(input(root));
  assert.deepEqual(result.changedPaths, []);
  assert.equal(await readFile(join(root, ".git/config"), "utf8"), original);
});

test("Aider receives native identifiers, temporary metadata, controlled secondary models and scoped multi-file edits", async (t) => {
  const root = await fixture(t);
  let scratchFile = "";
  const w = worker(root, async (cwd, i) => {
    assert.notEqual(cwd, root);
    assert.equal(i.model, "openrouter/foo/bar");
    for (const flag of ["--model", "--weak-model", "--editor-model"])
      assert.equal(i.args[i.args.indexOf(flag) + 1], i.model);
    assert.equal(i.args.includes("--edit-format"), false, "native settings resolve first");
    assert.equal(i.env.OPENROUTER_API_KEY, "test-secret-not-paid");
    assert.equal(i.args.join(" ").includes("test-secret-not-paid"), false);
    assert.equal(i.env.AIDER_OPENAI_API_BASE, undefined);
    scratchFile = i.args[i.args.indexOf("--model-metadata-file") + 1]!;
    assert.ok(!scratchFile.startsWith(root));
    const metadata = JSON.parse(await readFile(scratchFile, "utf8"));
    assert.equal(metadata[i.model].max_output_tokens, 1000);
    await writeFile(join(cwd, "src/value.cjs"), "module.exports = 3;\n");
    await writeFile(join(cwd, "src/new.cjs"), "module.exports = 3;\n");
    await report(i, "diff");
    return success;
  });
  const result = await w.run(input(root));
  assert.equal(result.exitStatus, "completed");
  assert.deepEqual(result.changedPaths.sort(), ["src/new.cjs", "src/value.cjs"]);
  assert.equal(result.editFormat, "diff");
  assert.equal(w.budget.spent, .001);
  assert.equal(w.budget.reserved, 0);
  await assert.rejects(readFile(scratchFile));
});

for (const first of ["diff", "whole"] as const) test(`${first} retries exactly once with the alternate format on malformed edits`, async (t) => {
  const root = await fixture(t);
  const formats: string[] = [];
  const w = worker(root, async (_cwd, i) => {
    formats.push(i.editFormat);
    await report(i, i.editFormat, "edit_format");
    return { ...success, exitCode: 1 };
  });
  const result = await w.run({ ...input(root), aiderEditFormat: first });
  assert.deepEqual(formats, [first, first === "diff" ? "whole" : "diff"]);
  assert.equal(result.terminationReason, "aider_edit_format_failure");
  assert.equal(result.formatAttempts?.length, 2);
});

test("provider failures and ordinary no-mutation responses never trigger format incompatibility", async (t) => {
  const root = await fixture(t);
  for (const failure of ["provider", undefined]) {
    let calls = 0;
    const result = await worker(root, async (_cwd, i) => {
      calls++;
      await report(i, "whole", failure);
      return { ...success, exitCode: failure ? 1 : 0, stderr: failure ? "HTTP 429 test-secret-not-paid" : "" };
    }).run(input(root));
    assert.equal(calls, 1);
    assert.notEqual(result.formatAttempts?.[0]?.failureKind, "edit_format");
    assert.equal(JSON.stringify(result).includes("test-secret-not-paid"), false);
    if (failure) assert.equal(result.exitStatus, "infra_failure");
  }
});

test("partial edits survive provider failures and exceptions; prior mutations are never reset", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "src/other.cjs"), "prior accepted mutation\n");
  const result = await worker(root, async (cwd) => {
    await writeFile(join(cwd, "src/value.cjs"), "module.exports = 3;\n");
    throw Error("provider timed out");
  }).run(input(root));
  assert.equal(result.exitStatus, "completed");
  assert.deepEqual(result.changedPaths, ["src/value.cjs"]);
  assert.equal(await readFile(join(root, "src/other.cjs"), "utf8"), "prior accepted mutation\n");
});

test("missing Aider is infrastructure evidence and consumes no model budget", async (t) => {
  const root = await fixture(t);
  const w = new AiderExecutor(new Budget(1, 10000, 30000), new Logger(join(root, ".koda"), "missing", true),
    { ensureRuntime: () => ensureAiderRuntime({ KODA_AIDER_PYTHON: "/missing/python" }) });
  const result = await w.run(input(root));
  assert.equal(result.terminationReason, "AIDER_UNAVAILABLE");
  assert.equal(result.exitStatus, "infra_failure");
  assert.equal(w.budget.spent, 0);
});

test("format telemetry learns only explicit compatibility evidence", () => {
  const row: any = { provider: "aider", modelRequested: "foo/bar", editFormat: "diff" };
  assert.equal(preferredAiderFormat([{ ...row, failureKind: "provider" }], "foo/bar"), undefined);
  assert.equal(preferredAiderFormat([{ ...row, failureKind: "edit_format" }], "foo/bar"), "whole");
  assert.equal(preferredAiderFormat([{ ...row, editFormat: "whole", verification: "VERIFIED_SUCCESS" }], "foo/bar"), "whole");
});

test("Aider fixture reaches VERIFIED_SUCCESS only through Koda's real checks", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, "tests"));
  await writeFile(join(root, "tests/value.test.cjs"), "const {test}=require('node:test');const a=require('node:assert/strict');test('value',()=>a.equal(require('../src/value.cjs'),3));\n");
  const model = modelSchema.parse({ id: "foo/bar", tier: "cheap", qualityPrior: .99 });
  const cfg = await config(undefined, { specialistRouting: true, maxIterations: 2,
    modelPool: { provider: "openrouter", models: [model] } });
  const logger = new Logger(join(root, ".koda"), "verified", true);
  const history = new History(join(root, ".koda", "history"));
  const candidate = { model, metadata: { inputPrice: 1, outputPrice: 1 }, quality: .99, cost: .01, latency: 1, score: 1 };
  const gateway: any = { config: cfg, logger, budget: new Budget(1, 100000, 60000), modelRouter: {
    selectSpecialist: async () => [candidate], select: async () => candidate,
    record: () => {}, history,
  } };
  const codingWorker = worker(root, async (cwd, i) => {
    await writeFile(join(cwd, "src/value.cjs"), "module.exports = 3;\n");
    await report(i, "whole");
    return success;
  });
  const subtask: any = { id: "fix", title: "Fix value", objective: "Make value equal 3", likelyReadPaths: ["src/value.cjs"],
    likelyWritePaths: ["src/value.cjs"], dependsOn: [], integrationContract: "value equals 3",
    verificationCommands: ["node --test tests/value.test.cjs"], estimatedDifficulty: "normal", parallelSafe: false };
  const result = await implement(gateway, root, subtask.objective, subtask,
    { acceptanceCriteria: ["value equals 3"] }, { files: ["src/value.cjs", "tests/value.test.cjs"], verificationCommands: subtask.verificationCommands } as any,
    { codingWorker, compiledContext: {
      files: [{ path: "src/value.cjs", snippet: "module.exports = 1" }],
      localDependencies: [], completePaths: ["src/value.cjs"], repoMap: ["src/value.cjs"],
    } as any });
  assert.equal(result.verification.status, "VERIFIED_SUCCESS");
  assert.ok(logger.events.some((e) => e.type === "aider_attempt_verification" && e.outcome === "VERIFIED_SUCCESS"));
  assert.ok(history.readOperations().some((e) => e.editFormat === "whole" && e.verification === "VERIFIED_SUCCESS"));

  // Role-based routes have no catalog candidate but still supply Koda's price
  // ceilings to the same completion guard.
  delete gateway.modelRouter;
  await writeFile(join(root, "src/value.cjs"), "module.exports = 1;\n");
  const roleWorker = worker(root, async (cwd, i) => {
    const request = JSON.parse(await readFile(i.args[2]!, "utf8"));
    assert.equal(request.promptPricePerMillion, cfg.maxInputPrice);
    assert.equal(request.completionPricePerMillion, cfg.maxOutputPrice);
    await writeFile(join(cwd, "src/value.cjs"), "module.exports = 3;\n");
    await report(i, "whole");
    return success;
  });
  const roleResult = await implement(gateway, root, subtask.objective, subtask,
    { acceptanceCriteria: ["value equals 3"] }, { files: ["src/value.cjs", "tests/value.test.cjs"], verificationCommands: subtask.verificationCommands } as any,
    { model: "foo/bar", codingWorker: roleWorker,
      compiledContext: {
        files: [{ path: "src/value.cjs", snippet: "module.exports = 1" }],
        localDependencies: [], completePaths: ["src/value.cjs"], repoMap: ["src/value.cjs"],
      } as any });
  assert.equal(roleResult.verification.status, "VERIFIED_SUCCESS");
});

test("OpenHands-localized work reaches Aider once with a bounded focused budget", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, "tests"));
  await writeFile(join(root, "tests/value.test.cjs"), "const {test}=require('node:test');const a=require('node:assert/strict');test('value',()=>a.equal(require('../src/value.cjs'),3));\n");
  const cfg = await config(undefined, { maxIterations: 1 });
  const logger = new Logger(join(root, ".koda"), "aider-discovery", true);
  const sharedBudget = new Budget(2, 100_000, 120_000);
  const gateway: any = {
    config: cfg,
    logger,
    budget: sharedBudget,
  };
  const tokenLimits: number[] = [];
  let calls = 0;
  const runner: NonNullable<ConstructorParameters<typeof AiderExecutor>[2]>["runner"] = async (cwd, i) => {
    calls++;
    const request = JSON.parse(await readFile(i.args[2]!, "utf8"));
    tokenLimits.push(request.maxTokens);
    assert.equal(i.args[3], "src/value.cjs");
    await writeFile(join(cwd, "src/value.cjs"), "module.exports = 3;\n");
    await report(i, "diff");
    return success;
  };
  const codingWorker = new AiderExecutor(sharedBudget, logger, {
    ensureRuntime: async () => "mock-python",
    runner,
  });
  const subtask: any = {
    id: "broad-fix",
    title: "Find and fix value",
    objective: "Find the implementation that supplies the tested value and make it return 3",
    likelyReadPaths: ["src/value.cjs", "tests/value.test.cjs"],
    likelyWritePaths: ["src/value.cjs"],
    dependsOn: [],
    integrationContract: "the value test passes",
    verificationCommands: ["node --test tests/value.test.cjs"],
    estimatedDifficulty: "normal",
    parallelSafe: false,
  };
  const output = await implement(
    gateway,
    root,
    subtask.objective,
    subtask,
    { acceptanceCriteria: ["the value test passes"] },
    {
      files: ["src/value.cjs", "src/other.cjs", "tests/value.test.cjs"],
      verificationCommands: subtask.verificationCommands,
    } as any,
    {
      model: "foo/bar",
      codingWorker,
      evidence: {
        relevantFiles: ["src/value.cjs", "tests/value.test.cjs"], symbols: [],
        reproduction: "", failingTests: ["tests/value.test.cjs"], likelyRootCause: "",
        dependencies: [], uncertainty: "low", suggestedApproach: "Edit the localized file", evidence: [],
      },
      compiledContext: {
        files: [
          { path: "src/value.cjs", snippet: "module.exports = 1" },
          { path: "tests/value.test.cjs", snippet: "test" },
        ],
        localDependencies: [], completePaths: ["src/value.cjs"],
        repoMap: ["src/value.cjs", "tests/value.test.cjs"],
      },
    },
  );

  assert.equal(output.verification.status, "VERIFIED_SUCCESS", JSON.stringify({
    calls,
    tokenLimits,
    events: logger.events.filter((event) => [
      "coding_attempt_non_viable",
      "coding_worker_start",
      "coding_worker_stop",
      "execution_plan_exhausted",
    ].includes(event.type)),
  }));
  assert.equal(calls, 1);
  assert.equal(tokenLimits.length, 1);
  assert.ok(tokenLimits[0]! <= cfg.stageMaxTokens);
  assert.equal(logger.events.some((event) =>
    event.type === "coding_worker_start" && event.worker_engine !== "aider"), false);
  assert.equal(logger.events.some((event) => event.type === "discovery_continuation"), false);
});

test("Python launcher preserves native settings, synthesizes unknown settings and guards every completion", async () => {
  const result = await execa("python3", ["-m", "unittest", "discover", "-s", "workers/aider", "-p", "test_*.py"],
    { env: { PYTHONDONTWRITEBYTECODE: "1" } });
  assert.match(result.stderr, /OK/);
});

test("Aider unverified changes remain inspectable and never apply to the original repo", async (t) => {
  const { createWorkspaceBackend } = await import("../src/workspace/backend.js");
  const root = await fixture(t);
  const storage = await mkdtemp(join(tmpdir(), "koda-aider-apply-"));
  t.after(() => rm(storage, { recursive: true, force: true }));
  const logger = new Logger(join(storage, "logs"), "apply", true);
  const backend = await createWorkspaceBackend(root, join(storage, "workspaces"), logger, true);
  const integration = await backend.initialize();
  const result = await worker(integration.path, async (cwd, i) => {
    await writeFile(join(cwd, "src/value.cjs"), "module.exports = 999;\n");
    await report(i, "whole");
    return success;
  }).run(input(integration.path));
  assert.equal(result.exitStatus, "completed", "execution alone is only a candidate");
  const applied = await backend.apply(join(storage, "output"), integration, false);
  assert.equal(applied.status, "not_verified");
  assert.equal(await readFile(join(root, "src/value.cjs"), "utf8"), "module.exports = 1;\n");
  assert.equal(await readFile(join(integration.path, "src/value.cjs"), "utf8"), "module.exports = 999;\n");
});

test("installed Aider runtime launches through the real sandbox without paid calls", async (t) => {
  const root = await fixture(t);
  const runtime = await mkdtemp(join(tmpdir(), "koda-mock-aider-runtime-"));
  t.after(() => rm(runtime, { recursive: true, force: true }));
  await execa("python3", ["-m", "venv", "--without-pip", runtime]);
  const python = join(runtime, "bin", "python");
  const site = (await execa(python, ["-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"])).stdout.trim();
  const pkg = join(site, "aider");
  await mkdir(pkg);
  await writeFile(join(pkg, "__init__.py"), '__version__="mock-installed"\n');
  await writeFile(join(pkg, "models.py"), 'MODEL_SETTINGS=[]\nMODEL_ALIASES={}\nclass ModelSettings: pass\n');
  await writeFile(join(pkg, "repomap.py"), 'class RepoMap: pass\n');
  await writeFile(join(pkg, "llm.py"), `from types import SimpleNamespace
class LLM:
    def completion(self, **kwargs):
        assert kwargs['model'] == 'openrouter/foo/bar'
        assert kwargs['num_retries'] == 0
        return SimpleNamespace(usage={'prompt_tokens': 20, 'completion_tokens': 10, 'cost': .00003})
litellm=LLM()
`);
  await writeFile(join(pkg, "main.py"), `from pathlib import Path
from types import SimpleNamespace
from .llm import litellm
def get_parser(defaults, root): return None
def main(args, return_coder=False):
    assert return_coder
    assert '--yes-always' in args
    model=args[args.index('--model')+1]
    def run(with_message):
        litellm.completion(model=model, messages=[{'role':'user','content':with_message}])
        Path('src/value.cjs').write_text('module.exports = 3;\\n')
    return SimpleNamespace(edit_format='whole', num_malformed_responses=0, run=run)
`);
  const w = new AiderExecutor(new Budget(1, 100000, 60000), new Logger(join(root, ".koda"), "sandbox", true),
    { ensureRuntime: () => ensureAiderRuntime({ KODA_AIDER_PYTHON: python, PATH: process.env.PATH }) });
  const result = await w.run(input(root));
  assert.equal(result.exitStatus, "completed", JSON.stringify(result));
  assert.deepEqual(result.changedPaths, ["src/value.cjs"]);
  assert.equal(result.engineVersion, "mock-installed");
  assert.ok(Math.abs(result.costUsd! - .00003) < 1e-12);
  assert.equal(result.consumedTokens, 30);
});

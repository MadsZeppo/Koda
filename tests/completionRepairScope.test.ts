import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";

import {
  evidenceBasedCompletionRepairScope,
  implement,
} from "../src/agent/codingExecutor.js";
import { completionReviewGate, completionReviewMessages } from "../src/agent/completionReview.js";
import type { CodingWorker } from "../src/agent/codingWorker.js";
import { Budget } from "../src/openrouter/usage.js";
import { Logger } from "../src/telemetry/logger.js";
import { config } from "../src/config.js";
import { AgenticCodingWorker } from "../src/agent/agenticCodingWorker.js";

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "koda-completion-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "tests"), { recursive: true });
  await writeFile(join(root, "src/outcome.cjs"), "module.exports = 1;\n");
  await writeFile(join(root, "src/wiring.cjs"), "module.exports = null;\n");
  await writeFile(
    join(root, "tests/outcome.test.cjs"),
    "const {test}=require('node:test');test('placeholder',()=>{});\n",
  );
  await writeFile(
    join(root, "tests/unrelated.test.cjs"),
    "const {test}=require('node:test');test('unrelated',()=>{});\n",
  );

  await execa("git", ["init", "-q"], { cwd: root });
  await execa("git", ["add", "."], { cwd: root });
  await execa(
    "git",
    [
      "-c",
      "user.name=Koda",
      "-c",
      "user.email=koda@localhost",
      "commit",
      "-qm",
      "baseline",
    ],
    { cwd: root },
  );

  return root;
}

test("real coding executor reviews many requirements in bounded structured batches", async (t) => {
  const root = await fixture(t);
  const cfg = await config(undefined, { maxIterations: 1, maxOutputTokens: 4096,
    maxInputPrice: 1, maxOutputPrice: 1 });
  const logger = new Logger(join(root, ".koda"), "batched-review", true);
  const budget = new Budget(10, 100_000, 60_000);
  let workerCalls = 0;
  const worker = new AgenticCodingWorker(budget, logger, async () => {
    workerCalls++;
    const name = workerCalls === 1 ? "read_file" : "write_file";
    const args = workerCalls === 1
      ? { path: "src/outcome.cjs" }
      : { path: "src/newOutcome.cjs", content: "module.exports = 3;\n" };
    return { model: "mock/coder", usage: { prompt_tokens: 20, completion_tokens: 10, cost: 0 },
      message: { content: null, tool_calls: [{ id: `tool-${workerCalls}`, type: "function" as const,
        function: { name, arguments: JSON.stringify(args) } }] } };
  });
  const reviewCalls: { requirements: string[]; outputTokens: number; disableReasoning: boolean; reasoningEffort: string }[] = [];
  const gateway = { config: cfg, logger, budget,
    async call(_model: string, messages: any[], _subtaskId: string, _stage: string,
      _attempt: number, tools: any[], limits: any) {
      const requirements = tools[0].function.parameters.properties.requirements.items.properties.id.enum as string[];
      reviewCalls.push({ requirements, outputTokens: limits.maxOutputTokens,
        disableReasoning: limits.disableReasoning, reasoningEffort: limits.reasoningEffort });
      return { role: "assistant", content: null, tool_calls: [{ id: "review", type: "function",
        function: { name: "submit_completion_review", arguments: JSON.stringify({
          passed: true, summary: "All batch requirements assessed",
          requirements: requirements.map((id) => ({ id, satisfied: true,
            evidence: "Changed source and passing focused repository test" })),
        }) } }] };
    },
  } as any;
  const result = await implement(gateway, root, "Create src/newOutcome.cjs exporting 3.", {
    id: "direct", title: "Outcome", objective: "Create src/newOutcome.cjs exporting 3",
    likelyReadPaths: ["src/outcome.cjs"], likelyWritePaths: ["src/newOutcome.cjs"],
    dependsOn: [], integrationContract: "Preserve the module export",
    verificationCommands: ["node --test tests/outcome.test.cjs"],
    estimatedDifficulty: "normal", parallelSafe: false,
  } as any, { acceptanceCriteria: Array.from({ length: 15 }, (_, index) =>
    `Requirement ${index + 1} is implemented`) }, {
    files: ["src/outcome.cjs", "tests/outcome.test.cjs"],
    verificationCommands: ["node --test tests/outcome.test.cjs"],
  } as any, { model: "mock/coder", codingWorker: worker });
  assert.equal(result.verification.status, "VERIFIED_SUCCESS");
  assert.ok(reviewCalls.length >= 2, JSON.stringify(logger.events
    .filter((event) => /review|no_changes|required|worker/.test(event.type))
    .map((event) => ({ type: event.type, summary: event.summary, status: event.status }))));
  assert.ok(reviewCalls.every((call) => 1344 + call.requirements.length * 160 <= cfg.maxOutputTokens));
  assert.ok(reviewCalls.every((call) => !call.disableReasoning && call.reasoningEffort === "low"));
  assert.ok(reviewCalls.some((call) => call.outputTokens > 1600));
  assert.deepEqual(new Set(reviewCalls.flatMap((call) => call.requirements)).size,
    reviewCalls.reduce((total, call) => total + call.requirements.length, 0));
});

test(
  "completion repair discovers the relevant repository test when initial likelyTests is empty",
  async (t) => {
    const root = await fixture(t);
    const repositoryPaths = [
      "src/outcome.cjs",
      "src/wiring.cjs",
      "tests/outcome.test.cjs",
      "tests/unrelated.test.cjs",
    ];

    const scope = await evidenceBasedCompletionRepairScope({
      root,
      task: "Create the outcome behavior and add a focused regression test",
      currentWriteScope: ["src/outcome.cjs", "src/wiring.cjs"],
      authorizedReadPaths: ["src/wiring.cjs"],
      repositoryPaths,
      reviewerDiagnostics:
        "The implementation exists but the focused regression test is missing.",
    });

    assert.deepEqual(scope, [
      "src/outcome.cjs",
      "src/wiring.cjs",
      "tests/outcome.test.cjs",
    ]);
    assert.equal(scope.includes("tests/unrelated.test.cjs"), false);
  },
);

test(
  "missing requested test evidence expands an empty test scope before model review",
  async (t) => {
    const root = await fixture(t);
    const cfg = await config(undefined, { maxIterations: 1, maxInputPrice: 1, maxOutputPrice: 1 });
    const logger = new Logger(join(root, ".koda"), "completion-scope-e2e", true);

    let workerCalls = 0;
    const codingWorker: CodingWorker = {
      engine: "agentic",
      async run(workerInput) {
        workerCalls++;

        if (workerCalls === 1) {
          assert.deepEqual(workerInput.writeScope, [
            "src/outcome.cjs",
            "src/wiring.cjs",
          ]);
          assert.equal(
            workerInput.writeScope.includes("tests/outcome.test.cjs"),
            false,
          );
          await writeFile(join(root, "src/outcome.cjs"), "module.exports = 3;\n");
          return {
            exitStatus: "completed",
            model: workerInput.model,
            engine: "agentic",
            engineVersion: "test",
            changedPaths: ["src/outcome.cjs"],
            wallClockMs: 1,
          };
        }

        assert.ok(
          workerInput.writeScope.includes("tests/outcome.test.cjs"),
          "completion repair must authorize the repository-backed focused test",
        );
        assert.equal(
          workerInput.writeScope.includes("tests/unrelated.test.cjs"),
          false,
          "scope expansion must not grant unrelated tests",
        );
        assert.equal(
          workerInput.context?.completionRepair?.mutationRequiredBeforeDiscovery,
          true,
        );
        assert.match(
          workerInput.context?.diagnostics ?? "",
          /unresolved requirements/i,
        );

        await writeFile(
          join(root, "src/wiring.cjs"),
          "module.exports = require('./outcome.cjs');\n",
        );
        await writeFile(
          join(root, "tests/outcome.test.cjs"),
          "const {test}=require('node:test');const a=require('node:assert/strict');test('wired outcome',()=>a.equal(require('../src/wiring.cjs'),3));\n",
        );

        return {
          exitStatus: "completed",
          model: workerInput.model,
          engine: "agentic",
          engineVersion: "test",
          changedPaths: [
            "src/outcome.cjs",
            "src/wiring.cjs",
            "tests/outcome.test.cjs",
          ],
          wallClockMs: 1,
        };
      },
    };

    let reviews = 0;
    const output = await implement(
      {
        config: cfg,
        logger,
        budget: new Budget(1, 100_000, 60_000),
      } as any,
      root,
      "Create outcome behavior. Wire it into telemetry. Add a focused regression test.",
      {
        id: "stable",
        title: "Outcome",
        objective: "Implement and wire outcome with a focused regression test",
        // Intentionally no test path here: this reproduces likelyTests: [].
        likelyReadPaths: ["src/wiring.cjs"],
        likelyWritePaths: ["src/outcome.cjs", "src/wiring.cjs"],
        dependsOn: [],
        integrationContract: "Wiring uses outcome and the focused test passes",
        verificationCommands: ["node --test tests/outcome.test.cjs"],
        estimatedDifficulty: "normal",
        parallelSafe: false,
      } as any,
      {
        acceptanceCriteria: [
          "Outcome behavior exists",
          "Wiring uses the outcome",
          "Focused regression test covers the behavior",
        ],
      },
      {
        files: [
          "src/outcome.cjs",
          "src/wiring.cjs",
          "tests/outcome.test.cjs",
          "tests/unrelated.test.cjs",
        ],
        verificationCommands: ["node --test tests/outcome.test.cjs"],
      } as any,
      {
        model: "foo/bar",
        codingWorker,
        completionReviewer: async (reviewInput) => {
          reviews++;
          const passed = workerCalls > 1;
          return {
            passed,
            requirements: reviewInput.requirements.map((requirement, index) => ({
              id: requirement.id,
              satisfied: passed || index === 0,
              evidence: passed
                ? "full diff plus focused regression test"
                : index === 0
                  ? "initial implementation exists"
                  : "wiring and focused regression test are still missing",
            })),
            summary: passed
              ? "completion repair finished the task"
              : "partial implementation; focused regression test is missing",
          };
        },
      },
    );

    assert.equal(workerCalls, 2);
    assert.equal(reviews, 1, "the first missing-test gap is deterministic; review runs after repair");
    assert.equal(output.verification.status, "VERIFIED_SUCCESS");

    const expansion = logger.events.find(
      (event) => event.type === "completion_repair_scope_expanded",
    );
    assert.ok(expansion, "repair scope expansion should be observable");
    assert.ok(
      (expansion?.added_paths as string[] | undefined)?.includes(
        "tests/outcome.test.cjs",
      ),
    );
    assert.equal(
      (expansion?.added_paths as string[] | undefined)?.includes(
        "tests/unrelated.test.cjs",
      ),
      false,
    );
    assert.ok(
      logger.events.some(
        (event) => event.type === "completion_review" && event.passed === true,
      ),
    );
  },
);

for (const recovers of [true, false]) {
  test(`review protocol retry ${recovers ? "recovers" : "fails operationally"} without coding repair or scope expansion`, async (t) => {
    const root = await fixture(t);
    const cfg = await config(undefined, { maxIterations: 1, maxInputPrice: 1, maxOutputPrice: 1 });
    const logger = new Logger(join(root, ".koda"), "review-protocol", true);
    let workers = 0;
    let reviews = 0;
    const output = await implement({ config: cfg, logger, budget: new Budget(1, 100_000, 60_000) } as any,
      root, "Modify outcome export to return 3", {
        id: "review-task", title: "Outcome", objective: "Modify outcome export to return 3",
        likelyReadPaths: [], likelyWritePaths: ["src/outcome.cjs"], dependsOn: [],
        integrationContract: "Outcome updated", verificationCommands: ["node --test tests/outcome.test.cjs"],
        estimatedDifficulty: "normal", parallelSafe: false,
      } as any, { acceptanceCriteria: ["Outcome updated"] }, {
        files: ["src/outcome.cjs", "tests/outcome.test.cjs"],
        verificationCommands: ["node --test tests/outcome.test.cjs"],
      } as any, { model: "foo/bar", codingWorker: { engine: "agentic", async run(input) {
        workers++;
        await writeFile(join(root, "src/outcome.cjs"), "module.exports = 3;\n");
        return { exitStatus: "completed", model: input.model, engine: "agentic", engineVersion: "test",
          changedPaths: ["src/outcome.cjs"], wallClockMs: 1 };
      } }, completionReviewer: async (input) => {
        reviews++;
        if (reviews === 1 || !recovers) return { protocolFailure: true, passed: false, requirements: [], summary: "malformed" };
        return { passed: true, requirements: input.requirements.map((item) => ({ id: item.id, satisfied: true, evidence: "Changed export and focused test" })), summary: "complete" };
      } });
    assert.equal(workers, 1, JSON.stringify(logger.events));
    assert.equal(reviews, 2);
    assert.equal(logger.events.some((event) => event.type === "completion_continuation" || event.type === "completion_repair_scope_expanded"), false);
    assert.equal(output.verification.status, recovers ? "VERIFIED_SUCCESS" : "NOT_FULLY_VERIFIED");
    assert.equal(logger.events.some((event) => event.type === "completion_review_failure"), !recovers);
  });
}

test("a requested but not-yet-run build remains verifier work and never starts coding repair", async (t) => {
  const root = await fixture(t);
  const cfg = await config(undefined, { maxIterations: 2, maxInputPrice: 1, maxOutputPrice: 1 });
  const logger = new Logger(join(root, ".koda"), "build-owned-by-verifier", true);
  let workers = 0;
  const output = await implement({ config: cfg, logger, budget: new Budget(1, 100_000, 60_000) } as any,
    root, "Modify outcome export to return 3.\nKør lint, typecheck og build.", {
      id: "review-task", title: "Outcome", objective: "Modify outcome export to return 3",
      likelyReadPaths: [], likelyWritePaths: ["src/outcome.cjs"], dependsOn: [],
      integrationContract: "npm run build passes", verificationCommands: ["node --test tests/outcome.test.cjs"],
      estimatedDifficulty: "normal", parallelSafe: false,
    } as any, { acceptanceCriteria: ["Outcome updated", "Lint and typecheck must pass"] }, {
      files: ["src/outcome.cjs", "tests/outcome.test.cjs"],
      verificationCommands: ["node --test tests/outcome.test.cjs"],
    } as any, { model: "foo/bar", codingWorker: { engine: "agentic", async run(input) {
      workers++;
      await writeFile(join(root, "src/outcome.cjs"), "module.exports = 3;\n");
      return { exitStatus: "completed", model: input.model, engine: "agentic", engineVersion: "test",
        changedPaths: ["src/outcome.cjs"], wallClockMs: 1 };
    } }, completionReviewer: async (input) => {
      assert.equal(input.requirements.some((item) => /lint|typecheck|build/i.test(item.text)), false);
      return { passed: true, requirements: input.requirements.map((item) => ({
        id: item.id, satisfied: true, evidence: "Candidate diff contains the requested export",
      })), summary: "Implementation is complete; deterministic final verification owns commands" };
    } });
  assert.equal(workers, 1);
  assert.equal(output.verification.status, "VERIFIED_SUCCESS");
  assert.equal(logger.events.some((event) =>
    event.type === "completion_continuation" || event.type === "completion_repair_scope_expanded"), false);
});

test("tiny final-only coding reviews implementation before checks without latching a missing-verification rejection", async (t) => {
  const root = await fixture(t);
  const cfg = await config(undefined, { maxIterations: 1, maxInputPrice: 1, maxOutputPrice: 1 });
  const logger = new Logger(join(root, ".koda"), "deferred-final-checks", true);
  let workers = 0, reviews = 0;
  const output = await implement({ config: cfg, logger, budget: new Budget(1, 100_000, 60_000) } as any,
    root, "Change the value to 3. Make the smallest necessary change and verify it.", {
      id: "direct", title: "Value", objective: "Change the value to 3",
      likelyReadPaths: [], likelyWritePaths: ["src/outcome.cjs"], dependsOn: [],
      integrationContract: "Preserve the module export", verificationCommands: [],
      estimatedDifficulty: "tiny", parallelSafe: false,
    } as any, { acceptanceCriteria: [] }, {
      files: ["src/outcome.cjs"], verificationCommands: [],
    } as any, { model: "mock/coder", tinyDirect: true, finalVerificationOnly: true,
      codingWorker: { engine: "agentic", async run(input) {
        workers++;
        await writeFile(join(root, "src/outcome.cjs"), "module.exports = 3;\n");
        return { exitStatus: "completed", model: input.model, engine: "agentic", engineVersion: "test",
          changedPaths: ["src/outcome.cjs"], wallClockMs: 1 };
      } }, completionReviewer: async (input) => {
        reviews++;
        assert.equal(input.verificationDeferred, true);
        assert.deepEqual(input.verification.checks, []);
        assert.equal(input.requirements.some((item) => /verify it/i.test(item.text)), false);
        const payload = JSON.parse(completionReviewMessages(input)[1]!.content as string);
        assert.equal(payload.verification.status, "PENDING_FINAL_VERIFICATION");
        return { passed: true, requirements: input.requirements.map((item) => ({ id: item.id,
          satisfied: true, evidence: "The candidate diff changes only the requested module export" })),
          summary: "Implementation complete; final verification pending" };
      } });
  assert.equal(workers, 1);
  assert.equal(reviews, 1);
  assert.equal(logger.events.some((event) => event.type === "completion_continuation"), false);
  assert.ok(logger.events.some((event) => event.type === "completion_review" && event.passed));
  assert.equal(completionReviewGate("VERIFIED_SUCCESS", logger.events).status, "VERIFIED_SUCCESS");
  assert.equal(completionReviewGate("FAILED", logger.events).status, "FAILED");
  assert.notEqual(output.verification.status, "FAILED");
});

test("completion repair preserves explicit user write restrictions", async (t) => {
  const root = await fixture(t);
  const scope = await evidenceBasedCompletionRepairScope({ root,
    task: "Only modify src/outcome.cjs. Add regression coverage if possible.",
    currentWriteScope: ["src/outcome.cjs"], authorizedReadPaths: ["tests/outcome.test.cjs"],
    repositoryPaths: ["src/outcome.cjs", "tests/outcome.test.cjs"],
    reviewerDiagnostics: "tests/outcome.test.cjs is missing coverage" });
  assert.deepEqual(scope, ["src/outcome.cjs"]);
});

test("missing site-wide theme styling promotes one proven read-only stylesheet", async (t) => {
  const root = await fixture(t);
  const base = {
    root,
    task: "Add a dark mode toggle to the website and preserve it between pages.",
    currentWriteScope: ["src/components/header.tsx"],
    authorizedReadPaths: ["src/app/globals.css"],
    repositoryPaths: ["src/components/header.tsx", "src/app/globals.css"],
    reviewerDiagnostics: "The toggle exists, but no CSS applies the dark theme to the pages.",
  };
  assert.deepEqual(await evidenceBasedCompletionRepairScope(base),
    ["src/components/header.tsx", "src/app/globals.css"]);
  assert.deepEqual(await evidenceBasedCompletionRepairScope({ ...base,
    task: "Only modify src/components/header.tsx. Add a dark mode toggle to the website.",
  }), ["src/components/header.tsx"]);
  assert.deepEqual(await evidenceBasedCompletionRepairScope({ ...base,
    authorizedReadPaths: ["src/app/globals.css", "src/styles/theme.css"],
    repositoryPaths: [...base.repositoryPaths, "src/styles/theme.css"],
  }), ["src/components/header.tsx"], "ambiguous stylesheets must stay read-only");
  assert.deepEqual(await evidenceBasedCompletionRepairScope({ ...base,
    reviewerDiagnostics: "The header button text is wrong.",
  }), ["src/components/header.tsx"], "unrelated review must not expand scope");
});

test("completion repair finds the existing navigation component when review names no path", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, "src/app"), { recursive: true });
  await mkdir(join(root, "src/app/kontakt"), { recursive: true });
  await mkdir(join(root, "src/components"), { recursive: true });
  await writeFile(join(root, "src/app/page.tsx"),
    "import { Header } from '../components/header'; export default function Page(){return <Header/>}\n");
  await writeFile(join(root, "src/components/header.tsx"),
    "export function Header(){return <nav><a href='/'>Home</a></nav>}\n");
  await writeFile(join(root, "src/app/kontakt/page.tsx"),
    "export default function Contact(){return <h1>Kontakt os</h1>}\n");
  const repositoryPaths = ["src/app/page.tsx", "src/components/header.tsx", "src/app/kontakt/page.tsx"];
  const input = {
    root,
    task: "Opret en side på /kontakt. Tilføj et Kontakt-link i den eksisterende navigation.",
    currentWriteScope: ["src/app/kontakt/page.tsx"],
    authorizedReadPaths: [] as string[],
    repositoryPaths,
    reviewerDiagnostics: "The existing navigation is missing the Contact link; it appears only on the new page.",
  };
  assert.deepEqual(await evidenceBasedCompletionRepairScope(input), [
    "src/app/kontakt/page.tsx", "src/components/header.tsx",
  ]);
  assert.deepEqual(await evidenceBasedCompletionRepairScope({
    ...input, task: "Only modify src/app/kontakt/page.tsx. Add a Contact link to navigation.",
  }), ["src/app/kontakt/page.tsx"]);
  await writeFile(join(root, "src/components/footer-nav.tsx"),
    "export function FooterNav(){return <nav><a href='/'>Home</a></nav>}\n");
  await writeFile(join(root, "src/app/page.tsx"),
    "import { Header } from '../components/header'; import { FooterNav } from '../components/footer-nav'; export default function Page(){return <><Header/><FooterNav/></>}\n");
  assert.deepEqual(await evidenceBasedCompletionRepairScope({
    ...input, repositoryPaths: [...repositoryPaths, "src/components/footer-nav.tsx"],
  }), ["src/app/kontakt/page.tsx"], "ambiguous navigation owners must not expand write scope");
});

test("visual completion cannot pass behind unchanged broad important CSS and repair may edit the proven stylesheet", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "src/globals.css"),
    "body * { background-color: white !important; color: black !important; }\n");
  await execa("git", ["add", "src/globals.css"], { cwd: root });
  await execa("git", ["-c", "user.name=Koda", "-c", "user.email=koda@localhost", "commit", "-qm", "add global styles"], { cwd: root });
  const cfg = await config(undefined, { maxIterations: 1, maxInputPrice: 1, maxOutputPrice: 1 });
  const logger = new Logger(join(root, ".koda"), "cascade-repair", true);
  let calls = 0;
  const output = await implement({ config: cfg, logger, budget: new Budget(1, 100_000, 60_000) } as any,
    root, "Make the hero background dark navy and text light, visibly in the browser.", {
      id: "stable", title: "Hero colors", objective: "Make the hero background dark navy and text light",
      likelyReadPaths: ["src/globals.css"], likelyWritePaths: ["src/outcome.cjs"], dependsOn: [],
      integrationContract: "Hero is visibly dark with light text", verificationCommands: ["node --check src/outcome.cjs"],
      estimatedDifficulty: "normal", parallelSafe: false,
    } as any, { acceptanceCriteria: ["Hero background and text colors are visible"] }, {
      files: ["src/outcome.cjs", "src/globals.css"], verificationCommands: ["node --check src/outcome.cjs"],
    } as any, { model: "mock/coder", codingWorker: { engine: "agentic", async run(input) {
      calls++;
      if (calls === 1) {
        await writeFile(join(root, "src/outcome.cjs"), "module.exports = '<section class=\"bg-navy text-white\">Hero</section>';\n");
        return { exitStatus: "completed", model: input.model, engine: "agentic", engineVersion: "test",
          changedPaths: ["src/outcome.cjs"], wallClockMs: 1 };
      }
      assert.ok(input.writeScope.includes("src/globals.css"));
      await writeFile(join(root, "src/globals.css"), "body { background-color: white; color: black; }\n");
      return { exitStatus: "completed", model: input.model, engine: "agentic", engineVersion: "test",
        changedPaths: ["src/outcome.cjs", "src/globals.css"], wallClockMs: 1 };
    } }, completionReviewer: async (input) => ({ passed: true,
      requirements: input.requirements.map((item) => ({ id: item.id, satisfied: true, evidence: "candidate diff" })),
      summary: "model thought the classes were visible",
    }) });
  assert.equal(calls, 2);
  assert.equal(output.verification.status, "VERIFIED_SUCCESS");
  assert.ok(logger.events.some((event) => event.type === "visual_cascade_conflict"));
  assert.ok(logger.events.some((event) => event.type === "completion_repair_scope_expanded" &&
    (event.added_paths as string[]).includes("src/globals.css")));
});

test("completion repair authorizes one reviewer-proven new route file", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, "src/app"), { recursive: true });
  await writeFile(join(root, "src/app/page.tsx"), "export default function Page(){return <a href='/how-it-works'>How it works</a>}\n");
  const scope = await evidenceBasedCompletionRepairScope({
    root,
    task: "Create a new How it works page and connect the existing navigation link.",
    currentWriteScope: ["src/app/page.tsx"],
    authorizedReadPaths: [],
    repositoryPaths: ["src/app/page.tsx", "src/outcome.cjs"],
    reviewerDiagnostics: "The requested new route is missing. Create src/app/how-it-works/page.tsx and preserve the existing page.",
  });
  assert.deepEqual(scope, ["src/app/page.tsx", "src/app/how-it-works/page.tsx"]);
});

test("completion continuation creates a reviewer-proven route inside the expanded scope", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, "src/app"), { recursive: true });
  await writeFile(join(root, "src/app/page.cjs"), "module.exports = '/?page=how';\n");
  const cfg = await config(undefined, { maxIterations: 1, maxInputPrice: 1, maxOutputPrice: 1 });
  const logger = new Logger(join(root, ".koda"), "new-route-repair", true);
  let calls = 0;
  const output = await implement({ config: cfg, logger, budget: new Budget(1, 100_000, 60_000) } as any,
    root, "Create a new How it works page and update the navigation link.", {
      id: "stable", title: "How it works", objective: "Create a new How it works page and update navigation",
      likelyReadPaths: ["src/app/page.cjs"], likelyWritePaths: ["src/app/page.cjs"], dependsOn: [],
      integrationContract: "Navigation opens a real page route", verificationCommands: ["node --check src/app/page.cjs"],
      estimatedDifficulty: "normal", parallelSafe: false,
    } as any, { acceptanceCriteria: ["A real How it works route exists"] }, {
      files: ["src/app/page.cjs"], verificationCommands: ["node --check src/app/page.cjs"],
    } as any, { model: "mock/coder", codingWorker: { engine: "agentic", async run(input) {
      calls++;
      if (calls === 1) {
        assert.deepEqual(input.writeScope, ["src/app/page.cjs"]);
        await writeFile(join(root, "src/app/page.cjs"), "module.exports = '/how-it-works';\n");
        return { exitStatus: "completed", model: input.model, engine: "agentic", engineVersion: "test",
          changedPaths: ["src/app/page.cjs"], wallClockMs: 1 };
      }
      assert.deepEqual(input.writeScope, ["src/app/page.cjs", "src/app/how-it-works/page.cjs"]);
      await mkdir(join(root, "src/app/how-it-works"), { recursive: true });
      await writeFile(join(root, "src/app/how-it-works/page.cjs"), "module.exports = 'How it works';\n");
      return { exitStatus: "completed", model: input.model, engine: "agentic", engineVersion: "test",
        changedPaths: ["src/app/page.cjs", "src/app/how-it-works/page.cjs"], wallClockMs: 1 };
    } }, completionReviewer: async (input) => {
      const passed = calls > 1;
      return { passed, requirements: input.requirements.map((item) => ({ id: item.id, satisfied: passed,
        evidence: passed ? "Navigation and the new route file are present" :
          "The real route is missing. Create src/app/how-it-works/page.cjs." })), summary: passed ? "complete" : "route missing" };
    } });
  assert.equal(calls, 2);
  assert.equal(output.verification.status, "VERIFIED_SUCCESS");
  assert.ok(logger.events.some((event) => event.type === "completion_repair_scope_expanded" &&
    (event.added_paths as string[]).includes("src/app/how-it-works/page.cjs")));
});

test("completion repair does not authorize ambiguous, unconstrained, or explicitly forbidden new source paths", async (t) => {
  const root = await fixture(t);
  const base = {
    root,
    task: "Create a new page.",
    currentWriteScope: ["src/app/page.tsx"],
    authorizedReadPaths: [] as string[],
    repositoryPaths: ["src/app/page.tsx"],
  };
  assert.deepEqual(await evidenceBasedCompletionRepairScope({ ...base,
    reviewerDiagnostics: "Create src/app/a/page.tsx or src/app/b/page.tsx." }), ["src/app/page.tsx"]);
  assert.deepEqual(await evidenceBasedCompletionRepairScope({ ...base,
    task: "Only modify src/app/page.tsx while adding a new page.",
    reviewerDiagnostics: "Create src/app/how-it-works/page.tsx." }), ["src/app/page.tsx"]);
  assert.deepEqual(await evidenceBasedCompletionRepairScope({ ...base,
    reviewerDiagnostics: "A new page is missing, but no concrete repository path is proven." }), ["src/app/page.tsx"]);
  assert.deepEqual(await evidenceBasedCompletionRepairScope({ ...base,
    reviewerDiagnostics: "The new route is missing (for example src/app/.../page.tsx)." }),
  ["src/app/page.tsx"], "reviewer example placeholders must never become writable paths");
});

for (const reviewerRecovers of [true, false]) {
  test(`baseline-only review rejection ${reviewerRecovers ? "reassesses successfully" : "stays operational"} without another mutation`, async (t) => {
    const root = await fixture(t);
    const legacy = "node --test tests/legacy.test.cjs";
    await writeFile(join(root, "tests/legacy.test.cjs"), "const {test}=require('node:test');test('existing failure',()=>{throw Error('legacy failure')});\n");
    const checks = ["node --test tests/outcome.test.cjs", legacy];
    const cfg = await config(undefined, { maxIterations: 1, maxInputPrice: 1, maxOutputPrice: 1 });
    const logger = new Logger(join(root, ".koda"), "baseline-review", true);
    let workers = 0, reviews = 0;
    const output = await implement({ config: cfg, logger, budget: new Budget(1, 100_000, 60_000) } as any,
      root, "Modify outcome export to return 3", {
        id: "review-task", title: "Outcome", objective: "Modify outcome export to return 3",
        likelyReadPaths: [], likelyWritePaths: ["src/outcome.cjs"], dependsOn: [],
        integrationContract: "Outcome updated", verificationCommands: checks,
        estimatedDifficulty: "normal", parallelSafe: false,
      } as any, { acceptanceCriteria: ["Outcome updated", "Verification passes"] }, {
        files: ["src/outcome.cjs", "tests/outcome.test.cjs", "tests/legacy.test.cjs"],
        verificationCommands: checks,
      } as any, { model: "foo/bar", codingWorker: { engine: "agentic", async run(input) {
        workers++;
        await writeFile(join(root, "src/outcome.cjs"), "module.exports = 3;\n");
        return { exitStatus: "completed", model: input.model, engine: "agentic", engineVersion: "test",
          changedPaths: ["src/outcome.cjs"], wallClockMs: 1 };
      } }, completionReviewer: async (input) => {
        reviews++;
        assert.ok(input.verification.checks.some((check) => check.command === legacy && check.source?.endsWith(":baseline_unchanged")));
        const passed = reviewerRecovers && reviews > 1;
        return { passed, requirements: input.requirements.map((item, index) => ({
          id: item.id, satisfied: passed || index !== input.requirements.length - 1,
          evidence: passed || index !== input.requirements.length - 1 ? "Diff proves requested export" : `${legacy} failed with unchanged baseline error`,
        })), summary: passed ? "Requested mutation is complete" : "Existing verification failure" };
      } });
    assert.equal(workers, 1);
    assert.equal(reviews, 2);
    assert.equal(output.verification.status, reviewerRecovers ? "VERIFIED_SUCCESS" : "NOT_FULLY_VERIFIED");
    assert.equal(logger.events.some((event) => event.type === "completion_continuation" || event.type === "completion_repair_scope_expanded"), false);
    assert.equal(logger.events.some((event) => event.type === "adaptive_recovery_decision"), false);
    assert.equal(await (await import("node:fs/promises")).readFile(join(root, "src/outcome.cjs"), "utf8"), "module.exports = 3;\n");
  });
}

for (const outcome of ["success", "agentic-429", "persistent-provider-failure", "authentication-failure", "invalid-tool-arguments", "regression"] as const) {
  test(`transient provider retry preserves localized scope: ${outcome}`, async (t) => {
    const root = await fixture(t);
    await writeFile(join(root, "tests/outcome.test.cjs"),
      "const {test}=require('node:test');const a=require('node:assert/strict');test('valid outcome',()=>a.ok([1,3].includes(require('../src/outcome.cjs'))));\n");
    const cfg = await config(undefined, { maxIterations: 1, maxInputPrice: 1, maxOutputPrice: 1 });
    cfg.forceModel = "mock/coder";
    const logger = new Logger(join(root, ".koda"), "provider-retry", true);
    let calls = 0;
    let originalEvidence: unknown;
    const output = await implement({ config: cfg, logger, budget: new Budget(1, 100_000, 60_000) } as any,
      root, "Modify only src/outcome.cjs to export 3", {
        id: "retry-task", title: "Outcome", objective: "Modify only src/outcome.cjs to export 3",
        likelyReadPaths: ["src/outcome.cjs"], likelyWritePaths: ["src/outcome.cjs"], dependsOn: [],
        integrationContract: "Outcome is 3", verificationCommands: ["node --test tests/outcome.test.cjs"],
        estimatedDifficulty: "normal", parallelSafe: false,
      } as any, { acceptanceCriteria: ["Outcome is 3"] }, {
        files: ["src/outcome.cjs", "tests/outcome.test.cjs"],
        verificationCommands: ["node --test tests/outcome.test.cjs"],
      } as any, { model: "mock/coder", codingWorker: { engine: "agentic", async run(input) {
        calls++;
        assert.equal(input.model, "mock/coder");
        assert.deepEqual(input.writeScope, ["src/outcome.cjs"]);
        assert.ok(input.context?.relevantFiles?.includes("src/outcome.cjs"));
        if (calls === 1) originalEvidence = input.context?.evidence;
        else if (calls === 2) assert.deepEqual(input.context?.evidence, originalEvidence);
        if (calls === 1 || outcome.endsWith("failure")) return {
          exitStatus: "infra_failure",
          terminationReason: outcome === "agentic-429" ? "agentic_provider_error" : "provider",
          model: input.model,
          engine: "agentic", engineVersion: "test", changedPaths: [], wallClockMs: 1,
          fatalError: outcome === "agentic-429" ? "Error: 429 Provider returned error"
            : outcome === "invalid-tool-arguments" ? "Error: 502 OpenRouter returned a malformed response (invalid_tool_arguments)" : "provider",
          stderr: outcome === "authentication-failure"
            ? "AuthenticationError: HTTP 401 Missing Authentication header"
            : "BadGatewayError: OpenRouter returned a malformed response",
        };
        await writeFile(join(root, "src/outcome.cjs"), `module.exports = ${outcome === "regression" ? 2 : 3};\n`);
        return { exitStatus: "completed", model: input.model, engine: "agentic", engineVersion: "test",
          changedPaths: ["src/outcome.cjs"], wallClockMs: 1 };
      } }, completionReviewer: async (input) => ({ passed: true,
        requirements: input.requirements.map((item) => ({ id: item.id, satisfied: true, evidence: "Export updated and actual focused test passed" })),
        summary: "complete",
      }) });
    assert.equal(calls, outcome === "authentication-failure" || outcome === "invalid-tool-arguments" ? 1 : outcome === "regression" ? 3 : 2);
    assert.equal(logger.events.filter((event) => event.type === "provider_transient_retry").length,
      outcome === "authentication-failure" || outcome === "invalid-tool-arguments" ? 0 : 1);
    assert.equal(output.verification.status === "VERIFIED_SUCCESS",
      outcome === "success" || outcome === "agentic-429");
    if (outcome.endsWith("failure") || outcome === "invalid-tool-arguments")
      assert.equal(output.verification.status, "NOT_FULLY_VERIFIED");
  });
}

test("verifier source mutation preserves candidate and never starts coding repair", async (t) => {
  const { profileRepo } = await import("../src/repo/profiler.js");
  const { readFile } = await import("node:fs/promises");
  const root = await fixture(t);
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { typecheck: "node check.cjs" } }));
  await writeFile(join(root, "check.cjs"), "if(require('./src/outcome.cjs')===3)require('node:fs').writeFileSync('src/wiring.cjs','verifier changed source');");
  const cfg = await config(undefined, { maxIterations: 3, maxInputPrice: 1, maxOutputPrice: 1 });
  const logger = new Logger(join(root, ".koda"), "verifier-source-mutation", true);
  let workers = 0;
  const output = await implement({ config: cfg, logger, budget: new Budget(1, 100_000, 60_000) } as any,
    root, "Modify only src/outcome.cjs to export 3", {
      id: "mutation-task", title: "Outcome", objective: "Modify only src/outcome.cjs to export 3",
      likelyReadPaths: ["src/outcome.cjs"], likelyWritePaths: ["src/outcome.cjs"], dependsOn: [],
      integrationContract: "Outcome is 3", verificationCommands: ["npm run typecheck"],
      estimatedDifficulty: "normal", parallelSafe: false,
    } as any, { acceptanceCriteria: ["Outcome is 3"] }, await profileRepo(root), {
      model: "mock/coder", codingWorker: { engine: "agentic", async run(input) {
        workers++;
        await writeFile(join(root, "src/outcome.cjs"), "module.exports = 3;\n");
        return { exitStatus: "completed", model: input.model, engine: "agentic", engineVersion: "test",
          changedPaths: ["src/outcome.cjs"], wallClockMs: 1 };
      } }, completionReviewer: async () => { throw Error("Must not review infrastructure failure"); },
    });
  assert.equal(workers, 1);
  assert.equal(output.verification.status, "NOT_FULLY_VERIFIED");
  assert.equal(output.verification.checks[0]!.unavailable, "verification_source_mutation");
  assert.equal(await readFile(join(root, "src/outcome.cjs"), "utf8"), "module.exports = 3;\n");
  assert.equal(await readFile(join(root, "src/wiring.cjs"), "utf8"), "module.exports = null;\n");
  assert.equal(logger.events.some((event) => event.type === "verification_repair" || event.type === "completion_repair_scope_expanded"), false);
});

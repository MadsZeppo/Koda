import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { config } from "../config.js";
import { run } from "../run.js";
import { AgenticCodingWorker } from "../agent/agenticCodingWorker.js";
import { deterministicRepositoryExploration } from "../agent/openHandsExplorer.js";

const stepSchema = z.object({
  stage: z.enum(["worker", "review", "planner", "inspection"]),
  subtaskId: z.string().optional(),
  content: z.string().optional(),
  servedModel: z.string().min(1).optional(),
  json: z.unknown().optional(),
  toolCalls: z.array(z.object({ name: z.string(), arguments: z.record(z.unknown()) })).optional(),
  error: z.object({ status: z.number().int().min(400).max(599), message: z.string() }).optional(),
  failure: z.enum(["token_preflight", "output_limit"]).optional(),
  review: z.object({ passed: z.boolean(), evidence: z.string().min(1), missingIds: z.array(z.string()).optional() }).optional(),
}).strict();
export const fakeScriptSchema = z.object({ steps: z.array(stepSchema).min(1) }).strict();
export type FakeScript = z.infer<typeof fakeScriptSchema>;

export function assertFakeProviderMode() {
  if (!["test", "development"].includes(process.env.NODE_ENV ?? ""))
    throw Error("Fake provider requires NODE_ENV=test or NODE_ENV=development; unavailable in production");
}

/** OpenAI-compatible loopback transport. Missing steps fail closed; no upstream exists. */
export async function startFakeProvider(script: FakeScript) {
  assertFakeProviderMode();
  script = fakeScriptSchema.parse(script);
  const consumed = new Set<number>();
  const requests: { stage: string; subtaskId?: string; step?: number; payload: any }[] = [];
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404).end(); return;
      }
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 128_000) throw Error("Fake provider request too large");
      }
      const body = JSON.parse(raw);
      const system = String(body.messages?.[0]?.content ?? "");
      const stage = system.includes("Independently review task completion") ? "review"
        : system.includes("Compile") || system.includes("executable DAG") ? "planner"
        : body.tools?.some((tool: any) => tool.function?.name === "lock_write_scope") ? "inspection" : "worker";
      const subtaskId = String(body.session_id ?? "").split("/")[1];
      const index = script.steps.findIndex((step, index) => !consumed.has(index) && step.stage === stage &&
        (!step.subtaskId || step.subtaskId === subtaskId));
      requests.push({ stage, subtaskId, step: index < 0 ? undefined : index, payload: body });
      res.setHeader("content-type", "application/json");
      if (index < 0) { res.writeHead(400).end(JSON.stringify({ error: { message: `Unscripted fake-provider call: ${stage}/${subtaskId}` } })); return; }
      consumed.add(index);
      const step = script.steps[index]!;
      if (step.error || step.failure === "token_preflight") {
        res.writeHead(step.error?.status ?? 400).end(JSON.stringify({ error: { message: step.error?.message ?? "provider_input_preflight: scripted token admission failure" } }));
        return;
      }
      let content = step.content ?? (step.json === undefined ? null : JSON.stringify(step.json));
      if (step.review) {
        const input = JSON.parse(body.messages.find((message: any) => message.role === "user").content);
        const missing = new Set(step.review.missingIds ?? []);
        if (!step.review.passed && !missing.size) throw Error("Scripted rejection requires concrete missing requirement IDs");
        content = JSON.stringify({ passed: step.review.passed,
          requirements: input.requirements.map((item: any) => ({ id: item.id,
            satisfied: !missing.has(item.id), evidence: step.review!.evidence })), summary: step.review.evidence });
      }
      const tool_calls = step.toolCalls?.map((tool, index) => ({ id: `fake-${requests.length}-${index}`,
        type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }));
      res.end(JSON.stringify({ id: `fake-${requests.length}`, model: step.servedModel ?? body.model,
        choices: [{ index: 0, finish_reason: step.failure === "output_limit" ? "length" : tool_calls?.length ? "tool_calls" : "stop",
          message: { role: "assistant", content, ...(tool_calls ? { tool_calls } : {}) } }],
        usage: { prompt_tokens: Math.ceil(Buffer.byteLength(raw) / 4), completion_tokens: step.failure === "output_limit" ? body.max_tokens : 64, cost: 0 } }));
    } catch (error) {
      if (!res.headersSent) res.setHeader("content-type", "application/json");
      res.writeHead(400).end(JSON.stringify({ error: { message: String(error) } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests,
    unusedSteps: () => script.steps.flatMap((_step, index) => consumed.has(index) ? [] : [index]),
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); } };
}

export async function runFakeProvider(options: { repo: string; task: string; script: string; output: string; verify?: string[]; apply?: boolean; taskAssessmentShadow?: boolean; verificationContractShadow?: boolean; failureAttributionShadow?: boolean; routingV1Shadow?: boolean }) {
  assertFakeProviderMode();
  const script = fakeScriptSchema.parse(JSON.parse(await readFile(resolve(options.script), "utf8")));
  const provider = await startFakeProvider(script);
  const roles = ["SCOUT_MODEL", "CHEAP_CODER_A", "CHEAP_CODER_B", "STRONG_MODEL", "FRONTIER_MODEL"];
  const keys = [...roles, "KODA_PROVIDER_MODE", "KODA_API_URL"];
  const original = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const role of roles) process.env[role] = "koda-test/scripted";
    process.env.KODA_PROVIDER_MODE = "backend";
    process.env.KODA_API_URL = provider.baseUrl;
    // No pool/catalog/history exists in this isolated run. Real providers and
    // their learned quality, cost and latency records cannot be read or updated.
    const cfg = await config(undefined, { models: Object.fromEntries(roles.map((role) => [role, "koda-test/scripted"])),
      baseUrl: provider.baseUrl, maxInputPrice: 1, maxOutputPrice: 1, maxIterations: 3,
      budgetUsd: 10, maxTokens: 300_000, maxMinutes: 2, semanticRouter: { enabled: false },
      routing: { stateDirectory: join(resolve(options.output), "synthetic-routing") } });
    const result = await run({ ...options, config: cfg, apply: options.apply === true, syntheticTelemetry: true,
      codingWorkerFactory: (gateway) => new AgenticCodingWorker(gateway.budget, gateway.logger),
      repositoryExplorerFactory: () => ({ explore: ({ repoPath, task, profile }) => deterministicRepositoryExploration(repoPath, task, profile) }) });
    return result;
  } finally {
    for (const [key, value] of original) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await provider.close();
    await mkdir(resolve(options.output), { recursive: true });
    await writeFile(join(resolve(options.output), "fake-provider.json"), JSON.stringify({ synthetic: true,
      provider: "scripted-local", externalCalls: 0, requests: provider.requests, unusedSteps: provider.unusedSteps() }, null, 2));
  }
}

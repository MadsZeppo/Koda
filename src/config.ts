import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { poolSchema, routingSchema } from "./router/pool.js";
import { z } from "zod";
import { registry } from "./router/modelRegistry.js";
const schema = z.object({
  maxParallel: z.number().int().min(1).max(8).default(3),
  budgetUsd: z.number().positive().default(5),
  maxTokens: z.number().int().positive().default(200000),
  maxIterations: z.number().int().positive().default(18),
  maxMinutes: z.number().positive().default(20),
  commandTimeoutMs: z.number().positive().default(120000),
  modelTimeoutMs: z.object({
    inspection: z.number().positive().default(18000),
    planning: z.number().positive().default(30000),
    implementation: z.number().positive().default(45000),
    finalization: z.number().positive().default(12000),
  }).default({}),
  phaseBudget: z.object({
    discoveryMaxFraction: z.number().positive().max(1).default(0.25),
    planningMaxFraction: z.number().positive().max(1).default(0.25),
    implementationReserveFraction: z.number().min(0).max(1).default(0.5),
    verificationReserveMs: z.number().nonnegative().default(15000),
  }).refine((value) =>
    value.discoveryMaxFraction + value.implementationReserveFraction <= 1 &&
    value.planningMaxFraction + value.implementationReserveFraction <= 1,
  "Inspection/planning caps must preserve the implementation reserve").default({}),
  maxOutputTokens: z.number().int().positive().default(4096),
  maxInputPrice: z.number().positive().default(20),
  maxOutputPrice: z.number().positive().default(100),
  stageMaxTokens: z.number().int().positive().default(30000),
  stageMaxUsd: z.number().positive().default(1),
  stageMaxMinutes: z.number().positive().default(4),
  context: z
    .object({
      maxBytes: z.number().int().min(1024).default(16000),
      maxFiles: z.number().int().min(1).max(40).default(8),
      fileBytes: z.number().int().min(128).default(2400),
      toolResultBytes: z.number().int().min(128).default(4000),
      maxPromptBytes: z.number().int().min(8192).default(64000),
      scanFiles: z.number().int().min(1).max(2000).default(200),
      readBytes: z.number().int().min(1024).max(100000).default(16000),
    })
    .default({}),
  planner: z
    .object({
      minimumQuality: z.number().min(0).max(1).default(0.9),
      qualityPrior: z.number().min(0).max(1).default(0.95),
      priorStrength: z.number().positive().default(10),
      costWeight: z.number().nonnegative().default(0.4),
      latencyWeight: z.number().nonnegative().default(0.6),
      latencyTargetMs: z.number().positive().default(5000),
      costTargetUsd: z.number().positive().default(0.001),
      contextBytes: z.number().int().min(1024).max(16000).default(6000),
      maxOutputTokens: z.number().int().min(256).max(4096).default(1800),
    })
    .refine(
      (p) => p.costWeight + p.latencyWeight > 0,
      "Planner weights must have positive total",
    )
    .default({}),
  modelPool: poolSchema.optional(),
  adaptiveCoding: z.boolean().default(false),
  specialistRouting: z.boolean().default(false),
  modelsFile: z.string().optional(),
  routing: routingSchema,
  forceModel: z.string().optional(),
  race: z.boolean().default(false),
  models: z.record(z.string()).default({}),
  baseUrl: z.string().url().default("https://openrouter.ai/api/v1"),
});
export type Config = z.infer<typeof schema> & {
  registry: ReturnType<typeof registry>;
};
export async function config(
  path?: string,
  overrides: Record<string, unknown> = {},
): Promise<Config> {
  const raw = path ? JSON.parse(await readFile(path, "utf8")) : {};
  const merged = {
    ...raw,
    ...Object.fromEntries(
      Object.entries(overrides).filter(([, v]) => v !== undefined),
    ),
  };
  let bundledPool = false;
  if (merged.modelsFile)
    merged.modelPool = JSON.parse(
      await readFile(
        resolve(
          path ? dirname(resolve(path)) : process.cwd(),
          merged.modelsFile,
        ),
        "utf8",
      ),
    );
  else if (
    !merged.modelPool &&
    !merged.models &&
    !Object.keys(process.env).some((k) =>
      [
        "SCOUT_MODEL",
        "CHEAP_CODER_A",
        "CHEAP_CODER_B",
        "STRONG_MODEL",
        "FRONTIER_MODEL",
      ].includes(k),
    )
  ) {
    bundledPool = true;
    merged.modelPool = JSON.parse(
      await readFile(
        new URL("../koda.models.json", import.meta.url),
        "utf8",
      ).catch(() =>
        readFile(
          resolve(
            dirname(fileURLToPath(import.meta.url)),
            "../../koda.models.json",
          ),
          "utf8",
        ),
      ),
    );
  }
  const c = schema.parse({
    ...merged,
    adaptiveCoding: merged.adaptiveCoding ?? bundledPool,
    specialistRouting: merged.specialistRouting ?? (bundledPool || merged.adaptiveCoding === true),
    ...Object.fromEntries(
      Object.entries(overrides).filter(([, v]) => v !== undefined),
    ),
  });
  if (c.forceModel && !c.modelPool?.models.some((m) => m.id === c.forceModel))
    throw Error("forceModel must name a configured pool candidate");
  return { ...c, registry: registry(c.models) };
}

import { z } from "zod";
export const metadataSchema = z.object({
  inputPrice: z.number().finite().nonnegative().optional(),
  outputPrice: z.number().finite().nonnegative().optional(),
  contextLength: z.number().positive().optional(),
  maxOutputTokens: z.number().positive().optional(),
  available: z.boolean().optional(),
  supportedParameters: z.array(z.string()).optional(),
  reasoning: z.object({ mandatory: z.boolean().optional(), supported_efforts: z.array(z.string()).nullable().optional() }).passthrough().optional(),
  /** Parameters supported together by each concrete provider endpoint. */
  routableParameterSets: z.array(z.array(z.string())).optional(),
  retrievedAt: z.string().optional(),
});
export const modelSchema = z.object({
  id: z
    .string()
    .min(1)
    .refine((s) => !s.includes("openrouter/auto")),
  enabled: z.boolean().default(true),
  tier: z.enum(["cheap", "fast", "strong", "frontier"]),
  strengths: z.array(z.string()).default(["coding", "tool_use"]),
  qualityPrior: z.number().min(0).max(1),
  latencyPriorMs: z.number().positive().default(5000),
  plannerQualityPrior: z.number().min(0).max(1).optional(),
  plannerLatencyPriorMs: z.number().positive().optional(),
  fallback: metadataSchema.optional(),
});
export const poolSchema = z
  .object({
    provider: z.string().min(1).default("openrouter"),
    models: z.array(modelSchema).min(1),
  })
  .refine(
    (p) => new Set(p.models.map((m) => m.id)).size === p.models.length,
    "Duplicate model IDs",
  );
export const routingSchema = z
  .object({
    authority: z.enum(["legacy", "cold-start", "openrouter-auto"]).default("legacy"),
    openRouterAuto: z.object({
      models: z.array(z.string().min(1)).min(1).optional(),
      referenceModel: z.string().min(1),
      costTier: z.enum(["auto", "low", "medium", "high", "xhigh", "max"]).default("auto"),
      priceRatio: z.object({low:z.number().positive().default(0.05),medium:z.number().positive().default(0.25),high:z.number().positive().default(1),xhigh:z.number().positive().default(2),max:z.number().positive().default(4)}).default({}),
      completionReserveFraction: z.number().min(0.05).max(0.5).default(0.1),
    }).refine(p => (!p.models || (new Set(p.models).size === p.models.length && p.models.includes(p.referenceModel) && !p.models.some(id => id.startsWith("openrouter/auto") || /[*?]/.test(id)))),
      "Auto requires exact unique concrete model IDs including its reference").optional(),
    coldStart: z.object({
      referenceModel: z.string().min(1),
      models: z.array(z.string().min(1)).min(1).max(6),
      evidenceFile: z.string().min(1).optional(),
      completionReserveFraction: z.number().min(0.05).max(0.5).default(0.1),
    }).refine((p) => new Set(p.models).size === p.models.length && p.models.includes(p.referenceModel),
      "Cold-start pool must be unique and include its explicit reference").optional(),
    minimumQuality: z.number().min(0).max(1).default(0.9),
    maxQualityRegret: z.number().min(0).max(0.2).default(0.02),
    costWeight: z.number().nonnegative().default(0.55),
    latencyWeight: z.number().nonnegative().default(0.45),
    priorStrength: z.number().positive().default(10),
    plannerCandidates: z.array(z.string()).optional(),
    cacheTtlMs: z.number().positive().default(21600000),
    stateDirectory: z.string().optional(),
    shortlistSize: z.number().int().min(3).max(20).default(8),
    researchAbsoluteCapUsd: z.number().nonnegative().max(1).default(0.002),
    researchBudgetFraction: z.number().nonnegative().max(0.25).default(0.03),
    researchMaxOutputTokens: z.number().int().min(128).max(1024).default(400),
    researchTimeoutMs: z.number().int().positive().max(20000).default(12000),
    conditionalRecoveryMinSamples: z.number().int().min(2).max(50).default(3),
  })
  .refine(r => r.authority !== "openrouter-auto" || !!r.openRouterAuto, "Auto authority requires an explicit pool and reference")
  .refine(
    (r) => r.authority !== "cold-start" || !!r.coldStart,
    "Cold-start authority requires a pool and reference model",
  )
  .refine(
    (r) => r.costWeight + r.latencyWeight > 0,
    "Routing weights must have positive total",
  )
  .default({});
export type PoolModel = z.infer<typeof modelSchema>;
export type Metadata = z.infer<typeof metadataSchema>;
export type Pool = z.infer<typeof poolSchema>;
export const tierRank = { cheap: 0, fast: 1, strong: 2, frontier: 3 };

/** Model-level parameter lists are unions; endpoint sets prove co-support. */
export function supportsParameters(metadata: Metadata, required: readonly string[]) {
  if (metadata.routableParameterSets !== undefined)
    return metadata.routableParameterSets.some((set) =>
      required.every((parameter) => set.includes(parameter)));
  return metadata.supportedParameters === undefined ||
    required.every((parameter) => metadata.supportedParameters!.includes(parameter));
}

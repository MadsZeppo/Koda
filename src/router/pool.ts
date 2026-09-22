import { z } from "zod";
export const metadataSchema = z.object({
  inputPrice: z.number().finite().nonnegative().optional(),
  outputPrice: z.number().finite().nonnegative().optional(),
  contextLength: z.number().positive().optional(),
  available: z.boolean().optional(),
  supportedParameters: z.array(z.string()).optional(),
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
    minimumQuality: z.number().min(0).max(1).default(0.9),
    maxQualityRegret: z.number().min(0).max(0.2).default(0.025),
    costWeight: z.number().nonnegative().default(0.55),
    latencyWeight: z.number().nonnegative().default(0.45),
    priorStrength: z.number().positive().default(10),
    plannerCandidates: z.array(z.string()).optional(),
    cacheTtlMs: z.number().positive().default(21600000),
    stateDirectory: z.string().optional(),
  })
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

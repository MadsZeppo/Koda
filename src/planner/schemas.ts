import { z } from "zod";
export const subtaskSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
    title: z.string(),
    objective: z.string(),
    dependsOn: z.array(z.string()),
    likelyReadPaths: z.array(z.string()),
    likelyWritePaths: z.array(z.string()),
    readOnly: z.boolean().optional(),
    integrationContract: z.string(),
    reusableArtifact: z.string().optional(),
    verificationCommands: z.array(z.string()),
    estimatedDifficulty: z.enum(["low", "normal", "high"]),
    parallelSafe: z.boolean(),
  })
  .superRefine((subtask, ctx) => {
    if (subtask.readOnly === true && subtask.likelyWritePaths.length)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["likelyWritePaths"],
        message: "Read-only discovery cannot declare writable paths",
      });
    if (subtask.readOnly !== true && !subtask.likelyWritePaths.length)
      ctx.addIssue({
        code: z.ZodIssueCode.too_small,
        minimum: 1,
        type: "array",
        inclusive: true,
        exact: false,
        path: ["likelyWritePaths"],
        message: "Mutation subtasks require at least one writable path",
      });
  });
export const planSchema = z.object({
  taskSummary: z.string(),
  acceptanceCriteria: z.array(z.string()).min(1),
  subtasks: z.array(subtaskSchema).min(1).max(4),
});
export const evidenceSchema = z.object({
  relevantFiles: z.array(z.string()),
  symbols: z.array(z.string()),
  reproduction: z.string(),
  failingTests: z.array(z.string()),
  likelyRootCause: z.string(),
  dependencies: z.array(z.string()),
  uncertainty: z.enum(["low", "medium", "high"]),
  suggestedApproach: z.string(),
  evidence: z.array(z.string()),
});
export type Subtask = z.infer<typeof subtaskSchema>;
export type Plan = z.infer<typeof planSchema>;
export type EvidencePacket = z.infer<typeof evidenceSchema>;

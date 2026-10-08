import { z } from "zod";
import { performance } from "node:perf_hooks";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { tmpdir } from "node:os";
import {
  buildVerificationContract,
  proofSchema,
  verificationMethods,
  type VerificationContractV1,
} from "./contract.js";
import { verify } from "./verifier.js";
import { fieldMetrics } from "../router/taskAssessmentEvaluation.js";
import type { VerificationCandidate } from "../repo/ecosystem.js";
const checkSchema = z.object({
  command: z.string().min(1),
  kind: z.enum(["test", "typecheck", "build", "lint", "check"]),
  requirement: z.enum(["required", "advisory"]).default("required"),
});
export const contractCaseSchema = z.object({
  id: z.string().min(1),
  task: z.string().min(1),
  language: z.enum(["en", "da"]),
  category: z.string().min(1),
  critical: z.boolean(),
  requirements: z
    .array(z.object({ id: z.string().min(1), text: z.string().min(1) }))
    .min(1),
  relatedTests: z.array(z.string()).default([]),
  resolvedPaths: z.array(z.string()).default([]),
  proofs: z.array(proofSchema).default([]),
  projectChecks: z.array(checkSchema).default([]),
  expected: z.array(
    z.object({
      requirementId: z.string(),
      methods: z.array(z.enum(verificationMethods)),
      strength: z.enum(["strong", "medium", "weak"]),
      falseAcceptRisk: z.enum(["low", "medium", "high"]),
    }),
  ),
  baseFiles: z.record(z.string()).default({}),
  proofFiles: z.record(z.string()).default({}),
  proofChecks: z.array(checkSchema).default([]),
  candidates: z
    .array(
      z.object({
        id: z.string().min(1),
        expected: z.enum(["GOOD", "BAD"]),
        reason: z.string().min(1),
        files: z.record(z.string().nullable()),
      }),
    )
    .min(1),
});
export type ContractCase = z.infer<typeof contractCaseSchema>;
export async function readContractDataset(path: string) {
  const text = (await readFile(path, "utf8")).trim();
  const raw: unknown = text.startsWith("[")
    ? JSON.parse(text)
    : text
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
  if (!Array.isArray(raw) || !raw.length)
    throw Error("Verification dataset must be nonempty");
  const rows = raw.map((row) => contractCaseSchema.parse(row));
  if (new Set(rows.map((row) => row.id)).size !== rows.length)
    throw Error("Duplicate case ID");
  for (const row of rows) {
    if (new Set(row.candidates.map((c) => c.id)).size !== row.candidates.length)
      throw Error("Duplicate candidate ID");
    if (
      row.expected.length !== row.requirements.length ||
      new Set(row.expected.map((e) => e.requirementId)).size !==
        row.requirements.length ||
      row.expected.some(
        (e) => !row.requirements.some((r) => r.id === e.requirementId),
      )
    )
      throw Error(
        "Gold planning labels must cover every requirement exactly once",
      );
    if (
      !row.candidates.some((c) => c.expected === "GOOD") ||
      !row.candidates.some((c) => c.expected === "BAD")
    )
      throw Error("Each case requires good and bad candidates");
  }
  return rows;
}
const safePath = (root: string, path: string) => {
  const dest = join(root, path),
    rel = relative(root, dest);
  if (
    isAbsolute(path) ||
    !rel ||
    rel === ".." ||
    rel.startsWith("../") ||
    path.includes("\0")
  )
    throw Error(`Unsafe fixture path: ${path}`);
  return dest;
};
export interface CandidateObservation {
  caseId: string;
  candidateId: string;
  expected: "GOOD" | "BAD";
  observed: "ACCEPT" | "REJECT" | "UNRESOLVED";
  strength: "strong" | "medium" | "weak";
  critical: boolean;
  healthPassed: boolean;
  status: string;
  checks: unknown[];
  reason: string;
}
export function discriminationMetrics(rows: CandidateObservation[]) {
  const good = rows.filter((r) => r.expected === "GOOD"),
    bad = rows.filter((r) => r.expected === "BAD");
  const falseAccepts = bad.filter((r) => r.observed === "ACCEPT").length;
  const falseRejects = good.filter((r) => r.observed === "REJECT").length;
  return {
    count: rows.length,
    goodCount: good.length,
    badCount: bad.length,
    correctCandidateAcceptRate: good.length
      ? good.filter((r) => r.observed === "ACCEPT").length / good.length
      : null,
    incorrectCandidateRejectRate: bad.length
      ? bad.filter((r) => r.observed === "REJECT").length / bad.length
      : null,
    falseAcceptRate: bad.length ? falseAccepts / bad.length : null,
    falseRejectRate: good.length ? falseRejects / good.length : null,
    falseAccepts,
    falseRejects,
    criticalFalseAccepts: bad.filter(
      (r) => r.critical && r.observed === "ACCEPT",
    ).length,
    unresolvedGood: good.filter((r) => r.observed === "UNRESOLVED").length,
    unresolvedBad: bad.filter((r) => r.observed === "UNRESOLVED").length,
    healthPassingIncorrectCandidates: bad.filter((r) => r.healthPassed).length,
  };
}
const candidateChecks = (
  rows: ContractCase["projectChecks"],
): VerificationCandidate[] =>
  rows.map((check) => ({
    ...check,
    cwd: ".",
    source: "verification-contract-eval:declared",
    confidence: 1,
    available: true,
    origin: "declared",
    mutatesSource: false,
    requiresInstalledDependencies: false,
  }));
export async function executeContractCandidate(
  row: ContractCase,
  candidate: ContractCase["candidates"][number],
  contract: VerificationContractV1,
  timeoutMs = 10000,
): Promise<CandidateObservation> {
  const root = await mkdtemp(join(tmpdir(), "koda-contract-eval-"));
  try {
    const files: Record<string, string> = { ...row.baseFiles };
    for (const [path, content] of Object.entries(candidate.files)) {
      safePath(root, path);
      if (Object.hasOwn(row.proofFiles, path))
        throw Error("Candidate attempted to overwrite independent proof");
      if (content === null) delete files[path];
      else files[path] = content;
    }
    for (const [path, content] of Object.entries({
      ...files,
      ...row.proofFiles,
    })) {
      const target = safePath(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    const checks = [...row.projectChecks, ...row.proofChecks];
    const result = await verify(
      root,
      checks.map((c) => c.command),
      timeoutMs,
      undefined,
      undefined,
      candidateChecks(checks),
    );
    const healthPassed =
      row.projectChecks.length > 0 &&
      row.projectChecks.every((check) =>
        result.checks.some(
          (r) => r.command === check.command && r.outcome === "CHECK_PASS",
        ),
      );
    // Eval-only observation. Production acceptance never consumes this decision.
    // The contract proposes a proof; only an executed independent proof can
    // discharge it. Planned tests and generic health PASS cannot fake acceptance.
    const covered = contract.requirements.every((requirement) =>
      row.proofs.some(
        (proof) =>
          proof.requirementId === requirement.requirementId &&
          proof.available &&
          ["targeted_test", "existing_test", "static_check"].includes(
            proof.method,
          ) &&
          proof.command &&
          row.proofChecks.some((check) => check.command === proof.command) &&
          Object.keys(row.proofFiles).length > 0 &&
          result.checks.some(
            (check) =>
              check.command === proof.command && check.outcome === "CHECK_PASS",
          ),
      ),
    );
    const infrastructure = result.checks.some(
      (check) =>
        check.unavailable ||
        check.timedOut ||
        check.outcome === "INFRA_FAILURE" ||
        check.outcome === "CHECK_UNAVAILABLE",
    );
    const observed = infrastructure
      ? "UNRESOLVED"
      : result.status === "FAILED"
        ? "REJECT"
        : result.status === "VERIFIED_SUCCESS" &&
            covered &&
            contract.overallStrength !== "weak"
          ? "ACCEPT"
          : "UNRESOLVED";
    return {
      caseId: row.id,
      candidateId: candidate.id,
      expected: candidate.expected,
      observed,
      strength: contract.overallStrength,
      critical: row.critical || contract.requirements.some((r) => r.critical),
      healthPassed,
      status: result.status,
      checks: result.checks,
      reason: infrastructure
        ? "Verification infrastructure unavailable"
        : observed === "UNRESOLVED"
          ? "No executed adequate proof for every requirement; project health alone is insufficient"
          : "Executed independent requirement proof and project checks",
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
export async function evaluateVerificationContracts(rows: ContractCase[]) {
  const contracts = [],
    observations: CandidateObservation[] = [],
    overhead: number[] = [];
  const goldStrength: string[] = [],
    actualStrength: string[] = [],
    goldRisk: string[] = [],
    actualRisk: string[] = [];
  let methodMatches = 0,
    requirements = 0;
  for (const row of rows) {
    const start = performance.now();
    const contract = buildVerificationContract(row);
    overhead.push(performance.now() - start);
    contracts.push({ caseId: row.id, contract });
    for (const expected of row.expected) {
      const actual = contract.requirements.find(
        (r) => r.requirementId === expected.requirementId,
      )!;
      requirements++;
      if (
        JSON.stringify([...expected.methods].sort()) ===
        JSON.stringify([...actual.methods].sort())
      )
        methodMatches++;
      goldStrength.push(expected.strength);
      actualStrength.push(actual.strength);
      goldRisk.push(expected.falseAcceptRisk);
      actualRisk.push(actual.falseAcceptRisk);
    }
    for (const candidate of row.candidates)
      observations.push(
        await executeContractCandidate(row, candidate, contract),
      );
  }
  const sorted = [...overhead].sort((a, b) => a - b);
  const percentile = (fraction: number) =>
    sorted.length
      ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]
      : null;
  return {
    version: 1,
    caseCount: rows.length,
    planningQuality: {
      requirementCount: requirements,
      exactMethodSetAccuracy: requirements
        ? methodMatches / requirements
        : null,
      strength: fieldMetrics(
        goldStrength,
        actualStrength,
        ["weak", "medium", "strong"],
        true,
      ),
      falseAcceptRisk: fieldMetrics(
        goldRisk,
        actualRisk,
        ["low", "medium", "high"],
        true,
      ),
    },
    discrimination: discriminationMetrics(observations),
    byStrength: Object.fromEntries(
      ["strong", "medium", "weak"].map((strength) => [
        strength,
        discriminationMetrics(
          observations.filter((r) => r.strength === strength),
        ),
      ]),
    ),
    byCategory: Object.fromEntries(
      [...new Set(rows.map((r) => r.category))].map((category) => [
        category,
        discriminationMetrics(
          observations.filter(
            (o) => rows.find((r) => r.id === o.caseId)?.category === category,
          ),
        ),
      ]),
    ),
    planningOverheadMs: { p50: percentile(0.5), p95: percentile(0.95) },
    contracts,
    observations,
  };
}

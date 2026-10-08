import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execa } from "execa";
import { verify, runtimeInfrastructureFailure } from "../verifier/verifier.js";
import { digest } from "../router/knowledge/evidenceRegistry.js";
import { wilson } from "../router/contextualQuality.js";
import {
  resolveVerificationRuntime,
  verificationPreflight,
  runVerificationRuntime,
  type VerificationRuntime,
} from "./verificationRuntime.js";
import { snapshotTree, changesBetween } from "../workspace/files.js";
export interface RuntimeCandidate {
  id: string;
  repo: string;
  commit: string;
  patch: string;
  task: string;
  checks: string[];
  proofChecks?: string[];
  proofClass: string;
  taskFamily: string;
  runtime?: VerificationRuntime;
  taskId?: string;
  role?: "DEVELOPMENT" | "CALIBRATION";
  language?: string;
  framework?: string;
  risk?: string;
  origin?: "public" | "integration_fixture";
}
export interface FrozenVerifierDecision {
  id: string;
  digest: string;
  candidateDigest: string;
  verifierDigest: string;
  environmentDigest: string;
  decision: "accept" | "reject" | "unresolved";
  taskFamily: string;
  proofClass: string;
  checks: Awaited<ReturnType<typeof verify>>;
  wallClockMs: number;
  reason: string;
  infrastructureState?: string;
  taskId?: string;
  baseCommit?: string;
  patchDigest?: string;
  canonicalTaskDigest?: string;
  runIdentity?: string;
  timestamp?: string;
  versions?: Record<string, unknown>;
  proofMethods?: string[];
  verificationStrength?: string;
  outputDigests?: Array<{ command: string; stdout: string; stderr: string }>;
  language?: string;
  framework?: string;
  risk?: string;
  diffSize?: number;
  blastRadius?: number;
  targetedTests?: boolean;
  origin?: "public" | "integration_fixture";
}
/** Runtime input is allowlisted: external labels, gold patches and hidden tests cannot cross this boundary. */
export function runtimeCandidate(value: unknown): RuntimeCandidate {
  const x = value as RuntimeCandidate;
  if (!x || !/^[a-zA-Z0-9_-]+$/.test(x.id) || !Array.isArray(x.checks))
    throw Error("Invalid runtime candidate identity/commands");
  return {
    id: x.id,
    repo: x.repo,
    commit: x.commit,
    patch: x.patch,
    task: x.task,
    checks: [...x.checks],
    proofChecks: x.proofChecks ? [...x.proofChecks] : undefined,
    proofClass: x.proofClass,
    taskFamily: x.taskFamily,
    runtime: x.runtime
      ? x.runtime.kind === "container"
        ? {
            kind: "container",
            image: x.runtime.image,
            workdir: x.runtime.workdir,
            path: x.runtime.path,
            harnessVersion: x.runtime.harnessVersion,
          }
        : {
            kind: "repository",
            path: x.runtime.path,
            provenance: x.runtime.provenance,
          }
      : undefined,
    taskId: x.taskId,
    role: x.role,
    language: x.language,
    framework: x.framework,
    risk: x.risk,
    origin: x.origin,
  };
}
export async function verifierStageA(
  input: RuntimeCandidate,
  output: string,
): Promise<FrozenVerifierDecision> {
  const c = runtimeCandidate(input),
    root = resolve(output);
  const verifierDigest = digest([
    verify.toString(),
    runtimeInfrastructureFailure.toString(),
    verifierStageA.toString(),
    "runtime-requirement-proof-v1",
  ]);
  if (c.role && !["DEVELOPMENT", "CALIBRATION"].includes(c.role))
    throw Error("Verifier final holdout forbidden");
  const runtime = await resolveVerificationRuntime(c.repo, c.runtime);
  const preflight = await verificationPreflight({ ...c, runtime });
  const environmentDigest = digest([
    runtime,
    preflight.imageDigest ?? process.version,
  ]);
  await mkdir(root, { recursive: true });
  const path = join(root, c.id + ".stage-a.json");
  try {
    const old = JSON.parse(await readFile(path, "utf8"));
    const { digest: d, ...body } = old;
    if (
      d !== digest(body) ||
      old.candidateDigest !== digest(c) ||
      old.verifierDigest !== verifierDigest ||
      old.environmentDigest !== environmentDigest
    )
      throw Error("Frozen Stage A mismatch");
    return old;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const runIdentity = digest([
    c.taskId ?? c.id,
    c.commit,
    digest(c.patch),
    verifierDigest,
    environmentDigest,
  ]);
  const repo = join(root, `${c.id}-${runIdentity.slice(0, 16)}-repo`);
  const started = Date.now();
  let checks: Awaited<ReturnType<typeof verify>> = {
    status: "NOT_FULLY_VERIFIED",
    checks: [],
    failedChecks: 0,
    failingTests: 0,
    buildErrors: 0,
  };
  let infra = !preflight.usable;
  let failure: string | undefined;
  let versions: Record<string, unknown> = {};
  try {
    if (infra)
      throw Error(
        "VERIFICATION_INFRA_FAILURE: " +
          preflight.items
            .filter((i) => i.status === "BLOCKED")
            .map((i) => i.name + ": " + i.detail)
            .join("; "),
      );
    // An interrupted unpublished Stage A may be safely restarted: no paid calls, unique candidate identity.
    await rm(repo, { recursive: true, force: true });
    await execa("git", [
      "clone",
      "--no-hardlinks",
      "--no-checkout",
      "--",
      resolve(c.repo),
      repo,
    ]);
    await execa("git", ["checkout", "--detach", c.commit], { cwd: repo });
    // Remove history (which could include future/gold commits) before runtime verification.
    await rm(join(repo, ".git"), { recursive: true, force: true });
    await execa("git", ["apply", "--check", "-"], {
      cwd: repo,
      input: c.patch.endsWith("\n") ? c.patch : c.patch + "\n",
    });
    await execa("git", ["apply", "-"], {
      cwd: repo,
      input: c.patch.endsWith("\n") ? c.patch : c.patch + "\n",
    });
    const before = await snapshotTree(repo);
    const executed = await runVerificationRuntime(
      repo,
      c.checks,
      runtime,
      120000,
    );
    checks = executed.result;
    versions = executed.versions;
    infra =
      changesBetween(before, await snapshotTree(repo)).length > 0 ||
      checks.checks.some(
        (ch) => ch.unavailable || runtimeInfrastructureFailure(ch),
      );
  } catch (error) {
    infra = true;
    failure = String(error);
  }
  const failed = checks.checks.some((ch) => ch.exitCode !== 0);
  const proof =
    c.proofChecks?.length &&
    c.proofChecks.every((cmd) =>
      checks.checks.some((ch) => ch.command === cmd && ch.exitCode === 0),
    );
  const decision = infra
    ? "unresolved"
    : failed
      ? "reject"
      : proof
        ? "accept"
        : "unresolved";
  const body = {
    id: c.id,
    origin: c.origin,
    taskId: c.taskId ?? c.id,
    baseCommit: c.commit,
    patchDigest: digest(c.patch),
    canonicalTaskDigest: digest(c.task),
    runIdentity,
    language: c.language ?? "unknown",
    framework: c.framework ?? "unknown",
    risk: c.risk ?? "unknown",
    diffSize: c.patch
      .split("\n")
      .filter((l) => /^[+-]/.test(l) && !/^\+\+\+|^---/.test(l)).length,
    blastRadius: c.patch.split("\n").filter((l) => l.startsWith("diff --git "))
      .length,
    targetedTests: !!c.proofChecks?.length,
    timestamp: new Date().toISOString(),
    versions,
    proofMethods: c.proofChecks ?? [],
    verificationStrength: proof ? "requirement" : "generic",
    infrastructureState: infra ? "VERIFICATION_INFRA_FAILURE" : "READY",
    outputDigests: checks.checks.map((ch) => ({
      command: ch.command,
      stdout: digest(ch.stdout),
      stderr: digest(ch.stderr),
    })),
    candidateDigest: digest(c),
    verifierDigest,
    environmentDigest,
    decision: decision as FrozenVerifierDecision["decision"],
    taskFamily: c.taskFamily,
    proofClass: c.proofClass,
    checks,
    wallClockMs: Date.now() - started,
    reason: infra
      ? (failure ?? "verification infrastructure unavailable")
      : failed
        ? "runtime check failure"
        : proof
          ? "runtime requirement checks passed"
          : "generic checks are not requirement proof; completion review not executed offline",
  };
  const frozen = { ...body, digest: digest(body) };
  await writeFile(path, JSON.stringify(frozen), { flag: "wx" });
  return frozen;
}
/** Label is opened only after persisted/hash-verified A, never passed to its process/input. */
export async function verifierStageB(stageAPath: string, labelPath: string) {
  const a: FrozenVerifierDecision = JSON.parse(
    await readFile(stageAPath, "utf8"),
  );
  const { digest: d, ...body } = a;
  if (d !== digest(body)) throw Error("Stage A modified before label reveal");
  const label = JSON.parse(await readFile(labelPath, "utf8"));
  if (label.id !== a.id || typeof label.correct !== "boolean")
    throw Error("Label mismatch");
  const result = {
    origin: a.origin,
    labelDigest: digest(label),
    id: a.id,
    stageADigest: d,
    verifierDigest: a.verifierDigest,
    environmentDigest: a.environmentDigest,
    infrastructureState: a.infrastructureState,
    language: a.language,
    framework: a.framework,
    risk: a.risk,
    diffSize: a.diffSize,
    blastRadius: a.blastRadius,
    targetedTests: a.targetedTests,
    verificationStrength: a.verificationStrength,
    correct: label.correct as boolean,
    decision: a.decision,
    taskFamily: a.taskFamily,
    proofClass: a.proofClass,
    latencyMs: a.wallClockMs,
  };
  const frozenPath = stageAPath.replace(/\.stage-a\.json$/, ".stage-b.json");
  if (frozenPath === stageAPath)
    throw Error("Invalid Stage A artifact filename");
  try {
    await writeFile(frozenPath, JSON.stringify(result), { flag: "wx" });
  } catch (e) {
    if (
      (e as NodeJS.ErrnoException).code !== "EEXIST" ||
      digest(JSON.parse(await readFile(frozenPath, "utf8"))) !== digest(result)
    )
      throw Error("Stage B cache/label mismatch");
  }
  return result;
}
export function verifierStatistics(
  rows: Array<{
    correct: boolean;
    decision: "accept" | "reject" | "unresolved";
    taskFamily?: string;
    proofClass?: string;
    infrastructureState?: string;
    language?: string;
    framework?: string;
    risk?: string;
    diffSize?: number;
    blastRadius?: number;
    targetedTests?: boolean;
    verificationStrength?: string;
  }>,
) {
  const evaluable = rows.filter((r) => r.decision !== "unresolved");
  const wrong = evaluable.filter((r) => !r.correct),
    correct = evaluable.filter((r) => r.correct);
  const rate = (rs: typeof rows, decision: string) => {
    const n = rs.filter((r) => r.decision === decision).length;
    return { events: n, count: rs.length, ...wilson(n, rs.length) };
  };
  return {
    candidates: rows.length,
    evaluable: evaluable.length,
    actuallyCorrect: rows.filter((r) => r.correct).length,
    actuallyWrong: rows.filter((r) => !r.correct).length,
    accepted: rows.filter((r) => r.decision === "accept").length,
    rejected: rows.filter((r) => r.decision === "reject").length,
    infraUnresolved: rows.filter(
      (r) => r.decision === "unresolved" && r.infrastructureState !== "READY",
    ).length,
    wrong: wrong.length,
    correct: correct.length,
    detection: rate(wrong, "reject"),
    falseAccept: rate(wrong, "accept"),
    correctAccept: rate(correct, "accept"),
    falseReject: rate(correct, "reject"),
    unresolved: rows.filter((r) => r.decision === "unresolved").length,
    breakdown: Object.fromEntries(
      (
        [
          "taskFamily",
          "proofClass",
          "language",
          "framework",
          "risk",
          "verificationStrength",
          "targetedTests",
          "diffSize",
          "blastRadius",
        ] as const
      ).map((key) => [
        key,
        Object.fromEntries(
          [...new Set(rows.map((r) => String(r[key] ?? "unknown")))].map(
            (value) => {
              const group = rows.filter(
                  (r) => String(r[key] ?? "unknown") === value,
                ),
                usable = group.filter((r) => r.decision !== "unresolved"),
                wrongGroup = usable.filter((r) => !r.correct),
                correctGroup = usable.filter((r) => r.correct);
              return [
                value,
                {
                  total: group.length,
                  evaluable: usable.length,
                  unresolved: group.length - usable.length,
                  detection: rate(wrongGroup, "reject"),
                  falseAccept: rate(wrongGroup, "accept"),
                  correctAccept: rate(correctGroup, "accept"),
                  falseReject: rate(correctGroup, "reject"),
                },
              ];
            },
          ),
        ),
      ]),
    ),
    byProof: Object.fromEntries(
      [...new Set(rows.map((r) => r.proofClass ?? "unknown"))].map((k) => [
        k,
        rows.filter((r) => r.proofClass === k).length,
      ]),
    ),
  };
}

if (process.argv[1]?.endsWith("verifierCalibration.ts")) {
  const { parseArgs } = await import("node:util");
  const { values: v } = parseArgs({
    options: {
      stage: { type: "string" },
      runtime: { type: "string" },
      output: { type: "string" },
      "stage-a": { type: "string" },
      label: { type: "string" },
    },
  });
  if (v.stage === "a") {
    if (!v.runtime || !v.output || v.label || v["stage-a"])
      throw Error(
        "Stage A accepts only runtime manifest and output; labels forbidden",
      );
    console.log(
      JSON.stringify(
        await verifierStageA(
          runtimeCandidate(JSON.parse(await readFile(v.runtime, "utf8"))),
          v.output,
        ),
      ),
    );
  } else if (v.stage === "b") {
    if (!v["stage-a"] || !v.label)
      throw Error("Stage B needs frozen Stage A and external label");
    console.log(JSON.stringify(await verifierStageB(v["stage-a"], v.label)));
  } else throw Error("--stage a|b required");
}

export function measuredVerifier(
  rows: Array<{
    correct: boolean;
    decision: "accept" | "reject" | "unresolved";
    taskFamily: string;
    proofClass: string;
    stageADigest: string;
    latencyMs: number;
    origin?: string;
  }>,
  taskFamily: string,
  proofClass: string,
  costUsd: number | undefined,
) {
  const relevant = rows.filter(
    (r) =>
      r.origin !== "integration_fixture" &&
      r.taskFamily === taskFamily &&
      r.proofClass === proofClass,
  );
  const stats = verifierStatistics(relevant);
  if (
    stats.wrong < 30 ||
    stats.correct < 30 ||
    costUsd === undefined ||
    !Number.isFinite(costUsd) ||
    costUsd < 0
  )
    return;
  return {
    detectionLower: stats.detection.lower,
    detectionMean: stats.detection.events / stats.wrong,
    detectionUpper: stats.detection.upper,
    falseAcceptUpper: stats.falseAccept.upper,
    support: relevant.length,
    provenance: digest(relevant.map((r) => r.stageADigest)),
    costUsd,
    latencyMs: relevant.reduce((s, r) => s + r.latencyMs, 0) / relevant.length,
  };
}

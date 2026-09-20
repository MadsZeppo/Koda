import { safeVerificationScript } from "../repo/ecosystem.js";
import { cp, mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { git } from "../repo/commands.js";
import { execa } from "execa";
import { snapshotTree } from "../workspace/files.js";
import type { VerificationCandidate, CheckKind } from "../repo/ecosystem.js";
import type { WriteScope } from "../repo/writeScope.js";
import { command } from "../repo/commands.js";
import type { CommandResult, VerificationResult } from "../types.js";
import { dependenciesForWorkspace } from "../repo/dependencies.js";
export const runtimeInfrastructureFailure = (check: CommandResult) => {
  const output = `${check.stdout}\n${check.stderr}`;
  if (!/\b(?:AssertionError|assert\s|FAILED\s+\S+::)/i.test(output) &&
      /Temporary failure in name resolution|Network is unreachable|No route to host|Name or service not known|nodename nor servname provided|socket\.gaierror|ProxyError:.*(?:proxy|connect)/i.test(output))
    return "verification_network_environment";
  if ([126, 127].includes(check.exitCode) &&
      /(?:python(?:\d+(?:\.\d+)?)?|pytest|tox)["']?:.*(?:not found|No such file|Permission denied)/i.test(output))
    return "python_environment_inaccessible";
  if (/pyvenv\.cfg|virtualenv|virtual environment|Fatal Python error:.*path/i.test(output) &&
      /PermissionError|Operation not permitted|Permission denied|EACCES|ENOENT|No such file/i.test(output))
    return "python_environment_inaccessible";
  if (
    /(?:EINVAL|ENAMETOOLONG)/.test(output) &&
    /(?:syscall.{0,20}listen|\.pipe\b|unix.{0,20}socket)/i.test(output)
  )
    return "verification_ipc_environment";
  if (
    /runDepsStatusCheck|Recreating .*node_modules|Command failed with exit code \d+: pnpm install|ERR_PNPM_VERIFY_DEPS_BEFORE_RUN/i.test(
      output,
    )
  )
    return "pnpm_dependency_environment";
  if (/sandbox-exec|\bbwrap\b|spawn .* ENOENT|command not found/i.test(output))
    return "verification_sandbox_or_tool_unavailable";
  return undefined;
};
const normalizedFailureOutput = (check: CommandResult) =>
  `${check.stdout}\n${check.stderr}`
    .replace(/\x1b\[[\d;]*m/g, "")
    .replace(/\/[^\s:'"]*\/koda-verify-[^/\s:'"]+\/repo/g, "<verification-repo>")
    .replace(/\/(?:private\/)?tmp\/koda-[^\s/:]+/g, "<workspace>")
    .split("\n")
    .filter((line) => !/^=+\s*(?:short test summary|\d+ (?:passed|failed)|warnings?).*=*$/i.test(line.trim()))
    .join("\n").trim();

export const verificationFailureIdentities = (check: CommandResult) => {
  const normalized = normalizedFailureOutput(check);
  // Pytest's detailed trace contains volatile object addresses, temporary
  // paths and environment text. Its terminal summary provides stable test
  // identities, which are the authoritative regression unit. Comparing the
  // entire trace made an unchanged failing baseline look like a new failure.
  const pytestTests = [...normalized.matchAll(
    /^(?:FAILED|ERROR)\s+(.+?)(?:\s+-\s+.*|\s*)$/gm,
  )].map((match) => match[1]!).sort();
  if (pytestTests.length) return [...new Set(pytestTests)];
  return [];
};
const failureSignature = (check: CommandResult) => {
  const normalized = normalizedFailureOutput(check)
    .replace(/\b\d+(?:\.\d+)?(?:ms|s)\b/g, "<duration>")
    .replace(/\b(?:duration_ms|duration|time):\s*\d+(?:\.\d+)?/g, "duration: <duration>");
  const pytestTests = verificationFailureIdentities(check);
  if (pytestTests.length)
    return pytestTests.map((test) => `pytest:${test}`).join("\n");
  const diagnostics = normalized.split("\n").filter((line) =>
    /\b(?:FAILED|FAIL|AssertionError|SyntaxError|TypeError|error TS\d+|error\[E\d+\])\b|\b(?:Error|expected|actual):|(?:!==|===|!=|==)|^\s*E\s+|^\s*✖\s+[^()]+$/i.test(line));
  return diagnostics.length ? diagnostics.join("\n") : normalized;
};

const introducedFailure = (previous: CommandResult, check: CommandResult) => {
  // Do not hide interrupted runs or a verifier's integrity rejection behind
  // an otherwise unchanged test summary.
  if (check.timedOut || previous.timedOut || check.exitCode !== previous.exitCode ||
      /Verification modified repository source/.test(check.stderr)) return true;
  const compilerDiagnostics = (result: CommandResult) =>
    normalizedFailureOutput(result).split("\n")
      .filter((line) => /error TS\d+|error\[E\d+\]|INTERNALERROR>/.test(line))
      .map((line) => line.replace(/\x1b\[[\d;]*m/g, "").trim());
  const knownDiagnostics = new Set(compilerDiagnostics(previous));
  if (compilerDiagnostics(check).some((line) => !knownDiagnostics.has(line))) return true;
  const pytestUnits = (result: CommandResult) =>
    [...normalizedFailureOutput(result).matchAll(
      /^(FAILED|ERROR)\s+(.+?)(?:\s+-\s+(.*)|\s*)$/gm,
    )].map((match) => {
      const reason = match[3] ?? "";
      const exception = reason.match(/\b[\w.]*(?:Error|Exception)\b/)?.[0] ?? "";
      const missingModule = reason.match(/No module named ['"]([^'"]+)['"]/)?.[1] ?? "";
      return `${match[1]}:${match[2]}:${exception}:${missingModule}`;
    });
  const before = pytestUnits(previous);
  const after = pytestUnits(check);
  if (before.length && after.length) {
    const known = new Set(before);
    return after.some((identity) => !known.has(identity));
  }
  const previousSignature = failureSignature(previous);
  const candidateSignature = failureSignature(check);
  const beforeDiagnostics = previousSignature.split("\n");
  const afterDiagnostics = candidateSignature.split("\n");
  if ([...beforeDiagnostics, ...afterDiagnostics].every((line) => /error TS\d+|error\[E\d+\]/.test(line))) {
    const known = new Set(beforeDiagnostics);
    return afterDiagnostics.some((line) => !known.has(line));
  }
  return previousSignature !== candidateSignature;
};

/** A failed check is patch-attributable only if it is new or changed from baseline. */
export function verificationRegressed(baseline: VerificationResult, after: VerificationResult) {
  return verificationRegressions(baseline, after).length > 0;
}

/** A candidate may proceed to final verification when only optional tooling is missing. */
export function advisoryInfrastructureOnly(result: VerificationResult) {
  return result.status === "NOT_FULLY_VERIFIED" &&
    result.checks.some((check) =>
      !!check.unavailable && check.requirement === "advisory") &&
    !result.checks.some((check) =>
      check.outcome === "CHECK_FAIL" ||
      (!!check.unavailable && (check.requirement ?? "required") === "required"));
}

/** Return only failure identities introduced or changed by the candidate. */
export function verificationRegressions(baseline: VerificationResult, after: VerificationResult) {
  return after.checks.filter((check) => {
    if (check.outcome !== "CHECK_FAIL") return false;
    const previous = baseline.checks.find((item) => item.command === check.command && item.cwd === check.cwd);
    if (previous?.unavailable || previous?.outcome === "INFRA_FAILURE" || previous?.outcome === "CHECK_UNAVAILABLE") return false;
    return !previous || previous.outcome !== "CHECK_FAIL" ||
      introducedFailure(previous, check);
  });
}

/** Preserve diagnostics while treating identical pre-existing failures as neutral. */
export function verificationAgainstBaseline(
  baseline: VerificationResult,
  after: VerificationResult,
) {
  const regressions = new Set(verificationRegressions(baseline, after));
  return verificationResult(after.checks.map((check) => {
    if (check.outcome !== "CHECK_FAIL" || regressions.has(check)) return { ...check };
    const previous = baseline.checks.find((item) => item.command === check.command && item.cwd === check.cwd);
    if (previous?.unavailable || previous?.outcome === "INFRA_FAILURE" || previous?.outcome === "CHECK_UNAVAILABLE")
      return { ...check, unavailable: "baseline_verification_unavailable", outcome: "INFRA_FAILURE" as const,
        stderr: `${check.stderr}\nBaseline verification unavailable: ${previous.unavailable ?? previous.stderr}` };
    if (!previous || previous.outcome !== "CHECK_FAIL" ||
        introducedFailure(previous, check)) return { ...check };
    return { ...check, exitCode: 0, outcome: "CHECK_PASS" as const,
      source: `${check.source ?? "verification"}:baseline_unchanged`,
      stdout: `UNCHANGED BASELINE FAILURE (neutral for candidate)\n${check.stdout}` };
  }));
}
export function verificationResult(
  checks: CommandResult[],
): VerificationResult {
  for (const check of checks) {
    check.requirement ??= "required";
    check.outcome ??= check.unavailable
      ? "CHECK_UNAVAILABLE"
      : check.exitCode === 0
        ? "CHECK_PASS"
        : "CHECK_FAIL";
  }
  const failedChecks = checks.filter(
    (c) => !c.unavailable && c.exitCode !== 0,
  ).length;
  const required = checks.filter((check) => (check.requirement ?? "required") === "required");
  const requiredUnavailable = required.some((check) => !!check.unavailable);
  const executableEvidence = checks.some(
    (check) => !check.unavailable && check.exitCode === 0,
  );
  const output = checks.filter((c) => !c.source?.endsWith(":baseline_unchanged"))
    .map((c) => c.stdout + "\n" + c.stderr).join("\n");
  const counts = [
    ...output.matchAll(/(?:(?:#|ℹ) fail\s+(\d+)|(\d+) failed)/g),
  ].map((m) => Number(m[1] ?? m[2]));
  const noEvidence = checks.some(
    (c) =>
      /^(?:true|echo|printf|pwd|ls|git status)(?:\s|$)/.test(
        c.command.trim(),
      ) ||
      /(?:#|ℹ) tests\s+0\b|Ran 0 tests\b|no tests found|no tests ran/i.test(
        c.stdout + c.stderr,
      ),
  );
  const errors = [...output.matchAll(/error TS\d+|error\[E\d+\]/g)].length;
  return {
    dimensions: Object.fromEntries(
      (["test", "typecheck", "lint", "build", "check"] as CheckKind[]).map(
        (kind) => {
          const rows = checks.filter((c) => c.kind === kind);
          return [
            kind,
            rows.some((c) => !c.unavailable && c.exitCode !== 0)
              ? "FAIL"
              : rows.some((c) => c.unavailable)
                ? "UNAVAILABLE"
                : rows.some((c) =>
                      /(?:#|ℹ) tests\s+0\b|Ran 0 tests\b|no tests found|no tests ran/i.test(
                        c.stdout + c.stderr,
                      ),
                    )
                  ? "NOT_RUN"
                  : rows.length
                    ? "PASS"
                    : "NOT_RUN",
          ];
        },
      ),
    ),
    status:
      checks.length === 0
        ? "NOT_FULLY_VERIFIED"
        : failedChecks
          ? "FAILED"
          : noEvidence || requiredUnavailable || !executableEvidence
            ? "NOT_FULLY_VERIFIED"
            : "VERIFIED_SUCCESS",
    checks,
    failedChecks,
    failingTests: counts.length ? counts.reduce((a, b) => a + b, 0) : null,
    buildErrors: /error TS|error\[E|tsc|typecheck|cargo check/.test(
      output + checks.map((c) => c.command).join(" "),
    )
      ? errors
      : null,
  };
}
export async function verify(
  path: string,
  commands: string[],
  timeout: number | (() => number),
  onResult?: (c: CommandResult) => void,
  scope?: WriteScope,
  candidates: VerificationCandidate[] = [],
) {
  const checks: CommandResult[] = [];
  for (const cmd of [...new Set(commands)].filter((c) => c.trim())) {
    const normalize = (c: string) =>
      c.replace(/\b(npm|pnpm|yarn|bun)\s+run\s+/g, "$1 ").trim();
    const exactCandidate = candidates.find(
      (c) => normalize(c.command) === normalize(cmd),
    );
    const normalized = normalize(cmd);
    const baseCandidate = candidates.find((c) => {
      const base = normalize(c.command);
      if (
        c.kind !== "test" ||
        !/^(?:npm|pnpm|yarn|bun) test$/.test(base) ||
        !normalized.startsWith(base + " -- ")
      )
        return false;
      const args = normalized.slice((base + " -- ").length);
      return (
        !/[;&|><`$\\\r\n\0]/.test(args) &&
        !/(?:^|\s)(?:\/|\.\.?(?:\/|\s|$))/.test(args) &&
        args
          .split(/\s+/)
          .some((arg) =>
            /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\.[\w*]+$/.test(
              arg.replace(/^['"]|['"]$/g, ""),
            ),
          )
      );
    });
    const candidate =
      exactCandidate ??
      (baseCandidate
        ? {
            ...baseCandidate,
            command: cmd,
            source: `${baseCandidate.source}:targeted-arguments`,
          }
        : undefined);
    const blocked =
      candidate && !candidate.available
        ? (candidate.reason ?? "dependencies_not_available")
        : !candidate && !safeVerificationScript(cmd, {})
          ? "unsafe_verification_command"
          : undefined;
    let c: CommandResult;
    if (blocked)
      c = {
        command: cmd,
        exitCode: 0,
        stdout: "",
        stderr: blocked,
        wallClockMs: 0,
        timedOut: false,
        unavailable: blocked,
        outcome: "CHECK_UNAVAILABLE",
      };
    else
      try {
        const limit = typeof timeout === "function" ? timeout() : timeout;
        const started = Date.now();
        const execute = (strict: boolean) => candidate
          ? isolatedVerification(path, cmd, Math.max(1, limit - (Date.now() - started)), false, scope, strict)
          : command(path, cmd, Math.max(1, limit - (Date.now() - started)), false, scope, undefined, strict);
        c = await execute(false);
        const environmentFailure = c.exitCode !== 0 && runtimeInfrastructureFailure(c);
        if (environmentFailure && environmentFailure !== "verification_network_environment" && /\b(?:python(?:\d+(?:\.\d+)?)?|pytest|tox)\b/i.test(cmd) &&
            limit - (Date.now() - started) > 100) {
          c = await execute(true);
          c.infrastructureRecoveryAttempts = 1;
        }
      } catch (error) {
        c = {
          command: cmd,
          exitCode: 1,
          stdout: "",
          stderr: String(error).slice(0, 2000),
          wallClockMs: 0,
          timedOut: false,
          unavailable: "verification_environment_setup",
          outcome: "INFRA_FAILURE",
        };
      }
    if (!c.unavailable && c.exitCode !== 0) {
      const infrastructure = runtimeInfrastructureFailure(c);
      if (infrastructure) {
        c.unavailable = infrastructure;
        c.outcome = "INFRA_FAILURE";
      }
    }
    c.outcome ??= c.unavailable
      ? "CHECK_UNAVAILABLE"
      : c.exitCode === 0
        ? "CHECK_PASS"
        : "CHECK_FAIL";
    if (candidate) {
      c.kind = candidate.kind;
      c.cwd = candidate.cwd;
      c.source = candidate.source;
      c.requirement = candidate.requirement ??
        (candidate.origin === "inferred" || candidate.origin === "generic"
          ? "advisory"
          : "required");
    } else {
      c.source = "task_or_targeted_check";
      c.kind = /--test|\bpytest\b/.test(cmd) ? "test" : "check";
      c.requirement = "required";
    }
    checks.push(c);
    onResult?.(c);
  }
  return verificationResult(checks);
}

/** Automatic checks may create build/cache artifacts, but never change the worktree. */
async function isolatedVerification(
  path: string,
  cmd: string,
  timeout: number,
  _readOnly?: boolean,
  _scope?: WriteScope,
  strictPythonEnvironment = false,
) {
  const start = Date.now();
  const staging = await mkdtemp(join(tmpdir(), "koda-verify-"));
  const copy = join(staging, "repo");
  try {
    await cp(path, copy, {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
    });
    if (Date.now() - start >= timeout)
      return {
        command: cmd,
        exitCode: 1,
        stdout: "",
        stderr: "Verification budget exhausted during isolation",
        timedOut: true,
        wallClockMs: Date.now() - start,
      };
    const snapshot = async () => {
      const probe = await execa("git", ["rev-parse", "--show-toplevel"], {
        cwd: copy,
        reject: false,
        env: { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      }).catch(() => undefined);
      if (!probe || probe.exitCode !== 0)
        return JSON.stringify(await snapshotTree(copy));
      const tracked = await git(
        copy,
        "--work-tree",
        copy,
        "diff",
        "--binary",
        "HEAD",
      );
      const untracked = (
        await git(
          copy,
          "--work-tree",
          copy,
          "ls-files",
          "--others",
          "--exclude-standard",
          "-z",
        )
      )
        .split("\0")
        .filter(Boolean);
      const hashes = await Promise.all(
        untracked.map(async (p) => [
          p,
          createHash("sha256")
            .update(await readFile(join(copy, p)))
            .digest("hex"),
        ]),
      );
      return JSON.stringify([tracked, hashes]);
    };
    const before = await snapshot();
    const result = await command(
      copy,
      cmd,
      timeout - (Date.now() - start),
      false,
      undefined,
      await dependenciesForWorkspace(path),
      strictPythonEnvironment,
      path,
    );
    if ((await snapshot()) !== before)
      return {
        ...result,
        exitCode: 1,
        stderr:
          result.stderr +
          "\nVerification modified repository source; result rejected",
      };
    return result;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

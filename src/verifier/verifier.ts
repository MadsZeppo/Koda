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
const runtimeInfrastructureFailure = (check: CommandResult) => {
  const output = `${check.stdout}\n${check.stderr}`;
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
export function verificationResult(
  checks: CommandResult[],
): VerificationResult {
  for (const check of checks)
    check.outcome ??= check.unavailable
      ? "CHECK_UNAVAILABLE"
      : check.exitCode === 0
        ? "CHECK_PASS"
        : "CHECK_FAIL";
  const failedChecks = checks.filter(
    (c) => !c.unavailable && c.exitCode !== 0,
  ).length;
  const output = checks.map((c) => c.stdout + "\n" + c.stderr).join("\n");
  const counts = [
    ...output.matchAll(/(?:(?:#|ℹ) fail\s+(\d+)|(\d+) failed)/g),
  ].map((m) => Number(m[1] ?? m[2]));
  const noEvidence = checks.some(
    (c) =>
      /^(?:true|echo|printf|pwd|ls|git status)(?:\s|$)/.test(
        c.command.trim(),
      ) ||
      /(?:#|ℹ) tests\s+0\b|no tests found|no tests ran/i.test(
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
                      /(?:#|ℹ) tests\s+0\b|no tests found|no tests ran/i.test(
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
          : noEvidence || checks.some((c) => c.unavailable)
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
        c = await (candidate ? isolatedVerification : command)(
          path,
          cmd,
          typeof timeout === "function" ? timeout() : timeout,
          false,
          scope,
        );
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
    } else {
      c.source = "task_or_targeted_check";
      c.kind = /--test|\bpytest\b/.test(cmd) ? "test" : "check";
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

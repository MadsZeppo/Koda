import type { CommandResult, VerificationResult } from "../types.js";
import {
  verify,
  verificationAgainstBaseline,
  verificationResult,
} from "../verifier/verifier.js";
import { snapshotTree, type FileChange } from "./files.js";

/** Re-run the accepted checks against the destination, preserving only failures
 * already demonstrated neutral in the verified candidate. */
export async function verifyAppliedRepository(
  root: string,
  accepted: VerificationResult,
  timeoutMs: number,
  onResult?: (check: CommandResult) => void,
  acceptedChanges?: FileChange[],
) {
  const acceptedExecutable = accepted.checks.filter(
    (check) => check.command !== "internal:tiny-documentation-structure",
  );
  const testChecks = acceptedExecutable.filter((check) => check.kind === "test");
  const structural = acceptedExecutable.find((check) => check.kind === "typecheck") ??
    acceptedExecutable.find((check) => check.kind === "lint") ??
    acceptedExecutable.find((check) => check.kind === "build");
  // The apply layer already proves byte-for-byte equality for every changed
  // path. Re-run the behavior checks plus the smallest accepted structural
  // check against the actual destination instead of repeating build, lint and
  // typecheck as a second full suite.
  const executable = [...new Map(
    [...testChecks, ...(structural ? [structural] : []),
      ...(!testChecks.length && !structural ? acceptedExecutable.slice(0, 1) : [])]
      .map((check) => [check.command, check]),
  ).values()];
  const candidates = executable.map((check) => ({
    command: check.command,
    cwd: check.cwd ?? ".",
    kind: check.kind ?? ("check" as const),
    source: check.source ?? "accepted_verification",
    confidence: 1,
    available: !check.unavailable,
    reason: check.unavailable,
    requirement: check.requirement ?? ("required" as const),
    mutatesSource: false as const,
    requiresInstalledDependencies: true,
  }));
  const actual = await verify(
    root,
    executable.map((check) => check.command),
    timeoutMs,
    onResult,
    undefined,
    candidates,
  );
  const documentationStructural = accepted.checks.find(
    (check) => check.command === "internal:tiny-documentation-structure",
  );
  if (documentationStructural) {
    const paths = acceptedChanges ?? [];
    const snapshot = await snapshotTree(root);
    const valid =
      documentationStructural.outcome === "CHECK_PASS" &&
      paths.length > 0 &&
      paths.every((change) => {
        if (!/\.(?:md|mdx|txt|rst)$/i.test(change.path)) return false;
        const file = snapshot.files[change.path];
        return change.type === "delete"
          ? !file
          : !!file &&
              file.hash === change.afterHash &&
              file.mode === change.afterMode;
      });
    const check: CommandResult = {
      ...documentationStructural,
      cwd: ".",
      outcome: valid ? "CHECK_PASS" : "CHECK_FAIL",
      exitCode: valid ? 0 : 1,
      stdout: valid
        ? "Original files match the accepted scoped documentation changes"
        : "Applied documentation differs from the verified change manifest",
      stderr: "",
      source: "deterministic:applied-diff-write-scope",
    };
    actual.checks.push(check);
    onResult?.(check);
  }
  const reference = {
    ...accepted,
    checks: executable.map((check) => ({
      ...check,
      cwd: check.cwd ?? ".",
      stdout: check.stdout.replace(
        /^UNCHANGED BASELINE FAILURE \(neutral for candidate\)\n/,
        "",
      ),
    })),
  };
  return verificationAgainstBaseline(
    reference,
    verificationResult(actual.checks),
    [],
  );
}

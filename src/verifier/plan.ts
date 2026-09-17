import type { RepoProfile } from "../types.js";
import type { VerificationCandidate } from "../repo/ecosystem.js";
import { projectFor } from "../repo/ecosystem.js";
export function verificationPlan(
  profile: RepoProfile,
  paths: string[] = [],
  final = false,
): VerificationCandidate[] {
  const e = profile.ecosystem;
  if (!e) return [];
  const units = paths.length
    ? [...new Set(paths.map((p) => projectFor(e, p)).filter((u) => !!u))]
    : e.projectUnits;
  let candidates = units.flatMap((u) => u.verification);
  if (final) {
    // Root contracts are authoritative for their dimensions; preserve uncovered package checks.
    const root = e.projectUnits.find((u) => u.root === ".")!.verification;
    candidates = [
      ...root,
      ...candidates.filter(
        (c) =>
          c.cwd !== "." &&
          !root.some(
            (r) =>
              r.kind === c.kind &&
              /\b(?:turbo|nx)\b|--workspaces|\s-r\b/.test(
                e.projectUnits[0]!.scripts[
                  r.source.split("scripts.")[1] ?? ""
                ] ?? "",
              ),
          ),
      ),
    ];
  } else {
    const fast = candidates.filter((c) => c.kind !== "build");
    if (fast.length) candidates = fast;
  }
  // Prefer aggregate test/check entrypoints over redundant variants, but never drop another dimension.
  candidates = candidates.filter(
    (c) =>
      !candidates.some(
        (r) =>
          r !== c &&
          r.cwd === c.cwd &&
          r.kind === c.kind &&
          r.source.includes("pyproject.toml:task.") &&
          !c.source.includes("pyproject.toml:task.") &&
          !c.source.includes("package.json:scripts."),
      ),
  );
  if (final) return candidates;
  return candidates.filter(
    (c) =>
      !c.source.match(/scripts.test:(?:unit|ci|integration)$/) ||
      !candidates.some(
        (r) => r.cwd === c.cwd && r.source.endsWith("scripts.test"),
      ),
  );
}

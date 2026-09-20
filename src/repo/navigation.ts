import { posix } from "node:path";

const testPath = (path: string) => /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|(?:^|\/)test_|[._](?:test|spec)\./i.test(path);
const stem = (path: string) => posix.basename(path).replace(/\.[^.]+$/, "").replace(/^(?:test_|spec_)/i, "").replace(/[._-](?:test|spec)$/i, "").toLowerCase();

/** File-name evidence only. A tie is ambiguity, never write authorization. */
export function nearbyRepoPaths(path: string, files: readonly string[], limit = 6) {
  const name = posix.basename(path).toLowerCase();
  const wantedStem = stem(path);
  const wantedKind = testPath(path);
  return files.map((candidate) => {
    if (testPath(candidate) !== wantedKind) return { path: candidate, score: 0 };
    const basename = posix.basename(candidate).toLowerCase();
    const score = candidate.toLowerCase() === path.toLowerCase() ? 120
      : basename === name ? 100
      : wantedStem.length >= 3 && stem(candidate) === wantedStem ? 80
      : 0;
    return { path: candidate, score };
  }).filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit);
}

export function unambiguousRepoPath(path: string, files: readonly string[]) {
  const candidates = nearbyRepoPaths(path, files, 2);
  return candidates[0] && candidates[0].score > (candidates[1]?.score ?? 0)
    ? candidates[0].path : undefined;
}

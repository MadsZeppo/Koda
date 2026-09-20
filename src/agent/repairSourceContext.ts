import { truncateBytes } from "../context/bounds.js";
import type { CommandResult } from "../types.js";

/** Refresh current source around patch/trace evidence rather than the file prefix. */
export function repairSourceContext(text: string, path: string, diff: string,
  checks: CommandResult[], limit: number) {
  if (Buffer.byteLength(text) <= limit) return text;
  const lines = text.split("\n");
  const anchors: number[] = [];
  const section = diff.split(/(?=^diff --git |^--- baseline\/)/m)
    .find((part) => part.includes(path));
  for (const match of (section ?? "").matchAll(/^@@[^\n]*\+(\d+)/gm))
    anchors.push(Number(match[1]) - 1);
  const diagnostics = checks.map((check) => `${check.stdout}\n${check.stderr}`).join("\n");
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const match of diagnostics.matchAll(new RegExp(`${escaped}:(\\d+)`, "g")))
    anchors.push(Number(match[1]) - 1);
  if (!anchors.length) anchors.push(0);
  const windows = [...new Set(anchors)].slice(0, 3).map((line) => {
    const start = Math.max(0, line - 12);
    return `--- ${path}, lines ${start + 1}-${Math.min(lines.length, line + 24)} (partial file) ---\n` +
      lines.slice(start, line + 24).join("\n");
  });
  return truncateBytes(windows.join("\n"), limit);
}

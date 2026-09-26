/**
 * Conservative identity helpers used only to transfer public routing evidence
 * across nearby revisions of the same model family. Family transfer is always
 * down-weighted by the estimator; it never creates an exact identity claim.
 */
export function modelFamilyKey(value?: string): string | undefined {
  if (!value) return undefined;
  const slug = value.trim().toLowerCase()
    .replace(/:[^/]+$/, "")
    .split("/").at(-1)!
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-");

  const rules: Array<[RegExp, (match: RegExpMatchArray) => string]> = [
    [/^claude-(opus|sonnet|haiku)(?:-|$)/, (m) => `claude-${m[1]}`],
    [/^gpt-(\d+)(?:[.-]|$)/, (m) => `gpt-${m[1]}`],
    [/^glm-(\d+)(?:[.-]|$)/, (m) => `glm-${m[1]}`],
    [/^qwen-?(\d+)(?:[.-]|$)/, (m) => `qwen${m[1]}`],
    [/^gemini-(\d+)(?:[.-]|$)/, (m) => `gemini-${m[1]}`],
    [/^deepseek-(?:v)?(\d+)(?:[.-]|$)/, (m) => `deepseek-v${m[1]}`],
    [/^kimi-k(\d+)(?:[.-]|$)/, (m) => `kimi-k${m[1]}`],
    [/^minimax-m(\d+)(?:[.-]|$)/, (m) => `minimax-m${m[1]}`],
  ];
  for (const [pattern, project] of rules) {
    const match = slug.match(pattern);
    if (match) return project(match);
  }

  const variant = new Set([
    "preview", "instruct", "chat", "thinking", "reasoning", "flash", "pro",
    "plus", "max", "coder", "code", "latest", "mini", "nano", "turbo",
    "luna", "sol", "experimental", "exp",
  ]);
  const tokens = slug.split("-").filter((token) => token && !variant.has(token));
  return tokens.length >= 2 ? tokens.slice(0, 2).join("-") : undefined;
}

/** Align Koda's ontology with the coarse public benchmark dimensions. */
export function normalizeRoutingTaskFamily(value?: string): string | undefined {
  if (!value) return undefined;
  const family = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (/bug|debug|repair|fix/.test(family)) return "debugging";
  if (/test|spec|coverage/.test(family)) return "testing";
  if (/refactor/.test(family)) return "refactor";
  if (/front|ui|web|design/.test(family)) return "frontend_ui";
  if (/back|api|server/.test(family)) return "backend_api";
  if (/sql|database|data_base/.test(family)) return "database";
  if (/devops|terminal|shell|ci|deploy|infra/.test(family)) return "devops";
  if (/doc|readme|writing/.test(family)) return "documentation";
  if (/architect|system_design|migration/.test(family)) return "architecture";
  if (/multi|agentic|repo|swe/.test(family)) return "multi_component";
  if (/algorithm|implementation|code_generation|coding|reasoning|program/.test(family))
    return "implementation";
  return family;
}

export const defaults = {
  SCOUT_MODEL: "z-ai/glm-5.3-flash",
  CHEAP_CODER_A: "deepseek/deepseek-v4-flash-0731",
  CHEAP_CODER_B: "xiaomi/mimo-v2.5",
  STRONG_MODEL: "z-ai/glm-5.3",
  FRONTIER_MODEL: "openai/gpt-5.6-sol",
};
export type Role = keyof typeof defaults;
export function registry(overrides: Partial<Record<Role, string>> = {}) {
  return Object.fromEntries(
    Object.entries(defaults).map(([role, id]) => {
      const model = process.env[role] ?? overrides[role as Role] ?? id;
      if (model.includes("openrouter/auto"))
        throw Error("Auto routing is prohibited");
      return [role, model];
    }),
  ) as Record<Role, string>;
}

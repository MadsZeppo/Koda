/** Claude Code adapter. No provider SDK, credentials or model calls on import. */
export function claudeArguments(model: string, budgetUsd: number) {
  if (!model.trim() || !Number.isFinite(budgetUsd) || budgetUsd <= 0)
    throw Error("Claude requires a model and explicit positive budget");
  return [
    "-p",
    "--model",
    model,
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-budget-usd",
    String(budgetUsd),
    "--no-session-persistence",
    "--safe-mode",
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    "Read,Glob,Grep,Edit,Write,Bash",
  ];
}
export function parseClaudeOutput(stdout: string) {
  let events: any[];
  let malformed = false;
  try {
    const value = JSON.parse(stdout);
    events = Array.isArray(value) ? value : [value];
  } catch {
    events = stdout
      .split("\n")
      .filter((l) => l.trim())
      .flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          malformed = true;
          return [];
        }
      });
  }
  const result = events.findLast((e) => e.type === "result");
  const modelUsage = result?.modelUsage ?? result?.model_usage;
  const models = new Set<string>(
    modelUsage && typeof modelUsage === "object" ? Object.keys(modelUsage) : [],
  );
  for (const e of events)
    if (e.type === "assistant" && typeof e.message?.model === "string")
      models.add(e.message.model);
  const costUsd =
    typeof result?.total_cost_usd === "number" &&
    Number.isFinite(result.total_cost_usd) &&
    result.total_cost_usd >= 0
      ? result.total_cost_usd
      : null;
  return {
    models: [...models],
    costUsd,
    costComplete: !!result && !malformed && costUsd !== null,
    tokens: result?.usage ?? null,
    modelUsage: modelUsage ?? null,
    attempts: events
      .filter((e) => e.type === "assistant")
      .map((e) => ({
        model: e.message?.model ?? null,
        usage: e.message?.usage ?? null,
        tools: (e.message?.content ?? [])
          .filter((c: any) => c.type === "tool_use")
          .map((c: any) => ({ id: c.id, name: c.name })),
      })),
    toolResults: events
      .filter((e) => e.type === "user")
      .flatMap((e) =>
        (e.message?.content ?? [])
          .filter((c: any) => c.type === "tool_result")
          .map((c: any) => ({
            toolUseId: c.tool_use_id,
            isError: c.is_error === true,
          })),
      ),
    claimedSuccess:
      !!result && result.is_error === false && result.subtype === "success",
    result: result ?? null,
    malformed,
  };
}
export function benchmarkArms(
  claudeModels: string[],
  base = ["routing-v1", "current-koda"],
) {
  if (
    claudeModels.some((m) => !m.trim()) ||
    new Set(claudeModels).size !== claudeModels.length
  )
    throw Error("Empty or duplicate Claude model selection");
  if (
    base.some(
      (a) =>
        ![
          "routing-v1",
          "current-koda",
          "strongest",
          "cheapest",
          "codex",
        ].includes(a),
    )
  )
    throw Error("Unknown benchmark arm");
  const arms = [...base, ...claudeModels.map((m) => `claude:${m}`)];
  if (!arms.length || new Set(arms).size !== arms.length)
    throw Error("Empty or duplicate benchmark arms");
  return arms;
}

import type { Usage } from "../types.js";
export function parseUsage(u: any): Usage {
  const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
  return {
    promptTokens: num(u?.prompt_tokens),
    completionTokens: num(u?.completion_tokens),
    reasoningTokens: num(u?.completion_tokens_details?.reasoning_tokens),
    cachedTokens: num(u?.prompt_tokens_details?.cached_tokens),
    cacheWriteTokens: num(u?.prompt_tokens_details?.cache_write_tokens),
    costUsd:
      typeof u?.cost === "number" && Number.isFinite(u.cost) && u.cost >= 0
        ? u.cost
        : null,
    raw: u ?? null,
  };
}
export class Budget {
  spent = 0;
  tokens = 0;
  reserved = 0;
  reservedTokens = 0;
  unknown = false;
  readonly start = Date.now();
  constructor(
    readonly usd: number,
    readonly maxTokens: number,
    readonly durationMs: number,
  ) {}
  reserve(cost: number, tokens: number) {
    if (
      this.unknown ||
      this.spent + this.reserved + cost > this.usd ||
      this.tokens + this.reservedTokens + tokens > this.maxTokens ||
      Date.now() - this.start >= this.durationMs
    )
      throw Error("Run budget exhausted or cost unknown");
    this.reserved += cost;
    this.reservedTokens += tokens;
    let released = false;
    return (usage?: Usage) => {
      if (released) return;
      released = true;
      this.reserved -= cost;
      this.reservedTokens -= tokens;
      if (usage) {
        this.tokens += usage.promptTokens + usage.completionTokens;
        if (usage.costUsd === null) this.unknown = true;
        else this.spent += usage.costUsd;
      } else this.unknown = true;
    };
  }
  remainingMs() {
    return Math.max(1, this.durationMs - (Date.now() - this.start));
  }
  remainingUsd() {
    return Math.max(0, this.usd - this.spent - this.reserved);
  }
  remainingTokens() {
    return Math.max(0, this.maxTokens - this.tokens - this.reservedTokens);
  }
}

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
export function estimateUsageCost(
  usage: Usage,
  promptPrice: number,
  completionPrice: number,
) {
  const raw = usage.raw as Record<string, unknown> | null;
  const promptTokens = raw?.prompt_tokens;
  const completionTokens = raw?.completion_tokens;
  if (
    !Number.isSafeInteger(promptTokens) ||
    (promptTokens as number) < 0 ||
    !Number.isSafeInteger(completionTokens) ||
    (completionTokens as number) < 0 ||
    !Number.isFinite(promptPrice) ||
    promptPrice < 0 ||
    !Number.isFinite(completionPrice) ||
    completionPrice < 0
  ) return null;
  const cost =
    ((promptTokens as number) * promptPrice +
      (completionTokens as number) * completionPrice) /
    1e6;
  return Number.isFinite(cost) && cost >= 0 ? cost : null;
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
    if (this.unknown) throw Error("Run budget cost is unknown");
    if (this.spent + this.reserved + cost > this.usd)
      throw Error("Run USD budget exhausted");
    if (this.tokens + this.reservedTokens + tokens > this.maxTokens)
      throw Error("Run token budget exhausted");
    if (Date.now() - this.start >= this.durationMs)
      throw Error("Run time budget exhausted");
    this.reserved += cost;
    this.reservedTokens += tokens;
    let released = false;
    const finish = (mode: "known" | "uncertain" | "cancel", usage?: Usage) => {
      if (released) return;
      released = true;
      this.reserved -= cost;
      this.reservedTokens -= tokens;
      if (mode === "known" && usage) {
        if (usage.costUsd === null) {
          // The call was bounded before dispatch. Charge the full reservation
          // when the provider cannot report usage instead of making every
          // future reservation unknowable.
          this.spent += cost;
          this.tokens += tokens;
        } else {
          this.tokens += usage.promptTokens + usage.completionTokens;
          this.spent += usage.costUsd;
        }
      } else if (mode === "uncertain") {
        // The provider may have started generation without returning usage.
        // Consume the bounded reservation, preserving safety and allowing a
        // later attempt to use only the genuinely remaining run budget.
        this.spent += cost;
        this.tokens += tokens;
      }
    };
    const reservation = ((usage?: Usage) =>
      finish(usage ? "known" : "uncertain", usage)) as ((usage?: Usage) => void) & {
        settle: (usage: Usage) => void;
        settleUncertain: () => void;
        cancel: () => void;
      };
    reservation.settle = (usage) => finish("known", usage);
    reservation.settleUncertain = () => finish("uncertain");
    reservation.cancel = () => finish("cancel");
    return reservation;
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
  availableUsd(reserveFraction = 0) {
    return Math.max(0, this.remainingUsd() - this.usd * reserveFraction);
  }
  availableTokens(reserveFraction = 0) {
    return Math.max(0, this.remainingTokens() - this.maxTokens * reserveFraction);
  }
}

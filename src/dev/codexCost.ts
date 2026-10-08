// Standard API-equivalent rates, USD per million tokens, verified 2026-10-05.
// Subscription billing, tools, Fast mode and region uplifts are not included.
export const codexPrices: Record<string, { input: number; cached: number; write: number; output: number; long: number[] }> = {
  "gpt-6.1-sol": { input: 2, cached: .1, write: 2.5, output: 10, long: [4, .2, 5, 15] },
  "gpt-6-astra": { input: 10, cached: 1, write: 12.5, output: 50, long: [20, 2, 25, 75] },
  "gpt-6-luna": { input: .1, cached: .01, write: .125, output: .5, long: [.2, .02, .25, .75] },
  "gpt-5.6-sol": { input: 4, cached: .4, write: 5, output: 20, long: [8, .8, 10, 30] },
};
export function codexCost(transcript: string, model: string, finished = true) {
  const tokens = { input: 0, cachedInput: 0, cacheWriteInput: 0, output: 0, reasoningOutput: 0 };
  let turns = 0, valid = true;
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { valid = false; continue; }
    if (e.type === "turn.failed" || e.type === "error") valid = false;
    if (e.type !== "turn.completed") continue;
    const u = e.usage;
    const fields = [u?.input_tokens, u?.cached_input_tokens, u?.output_tokens, u?.cache_write_input_tokens ?? 0, u?.reasoning_output_tokens ?? 0];
    if (fields.some(n => !Number.isSafeInteger(n) || n < 0) || fields[1] + fields[3] > fields[0] || fields[4] > fields[2]) { valid = false; continue; }
    turns++;
    tokens.input += fields[0]; tokens.cachedInput += fields[1]; tokens.output += fields[2];
    tokens.cacheWriteInput += fields[3]; tokens.reasoningOutput += fields[4];
  }
  const price = codexPrices[model];
  const estimate = (rates: number[]) => ((tokens.input - tokens.cachedInput - tokens.cacheWriteInput) * rates[0]! + tokens.cachedInput * rates[1]! + tokens.cacheWriteInput * rates[2]! + tokens.output * rates[3]!) / 1e6;
  const usable = turns > 0 && !!price;
  return {
    model, tokens, turns, costBasis: "estimated_standard_api_equivalent", actualSubscriptionChargeUsd: null,
    costUsd: usable ? estimate([price.input, price.cached, price.write, price.output]) : null,
    costUpperUsd: usable ? estimate(price.long) : null,
    costComplete: usable && valid && finished,
    priceSource: "https://developers.openai.com/api/docs/pricing", priceVerifiedAt: "2026-10-05",
    caveat: "Short-context estimate and long-context upper estimate: exec totals do not reveal per-request context tiers. Excludes tools, service-tier/region premiums and subscription billing; reasoning tokens are already included in output. Unknown usage is never zero.",
  };
}

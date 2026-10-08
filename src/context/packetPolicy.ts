/** Hard per-call bounds, independent of task/repository/model window size. */
export const MAX_PROVIDER_INPUT_TOKENS = 32_768;
export const MAX_PROVIDER_OUTPUT_TOKENS = 4_096;
export const MAX_CODING_PACKET_BYTES = 32_768;
export const MAX_TASK_SPEC_BYTES = 6_000;

/**
 * Conservative tokenizer-independent fallback. Payload size is measured in
 * bytes first, then converted to token units exactly once. Keeping bytes and
 * tokens separate prevents a valid 30KB request from being treated as 30K
 * tokens while retaining margin for JSON framing and uncommon tokenizers.
 */
export function providerPayloadBound(payload: unknown) {
  const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  return Math.ceil(bytes / 3) + 256;
}
export function admitProviderPayload(payload: unknown, outputTokens: number, contextTokens = Infinity) {
  const inputTokens = providerPayloadBound(payload);
  if (inputTokens > MAX_PROVIDER_INPUT_TOKENS || outputTokens > MAX_PROVIDER_OUTPUT_TOKENS ||
      inputTokens + outputTokens > contextTokens)
    throw Error("provider_input_preflight: bounded payload requires shrinking or decomposition");
  return { inputTokens, outputTokens };
}
/** Keep independent capacity for a recovery and final review. */
export function codingCapacity(tokens: number, usd: number, recovery: boolean, alreadyReserved = false) {
  if (alreadyReserved) return { tokens: Math.floor(Math.min(65_536, tokens)), usd };
  return { tokens: Math.floor(Math.min(65_536, tokens * (recovery ? .75 : .45))),
    usd: usd * (recovery ? .75 : .7) };
}

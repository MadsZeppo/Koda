/** Hard per-call bounds, independent of task/repository/model window size. */
export const MAX_PROVIDER_INPUT_TOKENS = 32_768;
export const MAX_PROVIDER_OUTPUT_TOKENS = 4_096;
export const MAX_CODING_PACKET_BYTES = 32_768;
export const MAX_TASK_SPEC_BYTES = 6_000;

/** UTF-8 bytes conservatively bound tokens even for unknown tokenizers. */
export function providerPayloadBound(payload: unknown) {
  return Buffer.byteLength(JSON.stringify(payload), "utf8") + 512;
}
export function admitProviderPayload(payload: unknown, outputTokens: number, contextTokens = Infinity) {
  const inputTokens = providerPayloadBound(payload);
  if (inputTokens > MAX_PROVIDER_INPUT_TOKENS || outputTokens > MAX_PROVIDER_OUTPUT_TOKENS ||
      inputTokens + outputTokens > contextTokens)
    throw Error("provider_input_preflight: bounded payload requires shrinking or decomposition");
  return { inputTokens, outputTokens };
}
/** Keep independent capacity for a recovery and final review. */
export function codingCapacity(tokens: number, usd: number, recovery: boolean) {
  return { tokens: Math.floor(Math.min(65_536, tokens * (recovery ? .75 : .45))),
    usd: usd * (recovery ? .75 : .7) };
}

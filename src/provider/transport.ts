export const BACKEND_CLIENT_CREDENTIAL = "koda-backend-client"; // Public SDK placeholder, not a secret.
export const OPENROUTER_URL = "https://openrouter.ai/api/v1";

/** Transport markers distinguish a forwarded provider rejection from a proxy failure. */
export function providerErrorOrigin(error: unknown) {
  const headers = (error as { headers?: Headers } | undefined)?.headers;
  return headers?.get?.("x-koda-error-origin") ?? undefined;
}

export function providerMode() {
  const mode = process.env.KODA_PROVIDER_MODE ?? "backend";
  if (mode !== "backend" && mode !== "direct-openrouter")
    throw Error("KODA_PROVIDER_MODE must be backend or direct-openrouter");
  return mode;
}
export function isOpenRouterUrl(url: string) {
  return /(?:^|\.)openrouter\.ai$/i.test(new URL(url).hostname);
}
export function backendBaseUrl() {
  const url = (process.env.KODA_API_URL ?? "http://127.0.0.1:8787").replace(
    /\/$/,
    "",
  );
  if (!["http:", "https:"].includes(new URL(url).protocol))
    throw Error("KODA_API_URL requires HTTP or HTTPS");
  return url.endsWith("/v1") ? url : url + "/v1";
}
/** KODA_API_URL is authoritative, including over legacy/custom provider config.
 * An explicit loopback baseUrl remains a local test/dev backend alias. */
export function providerTransport(
  baseUrl = OPENROUTER_URL,
  provider = "openrouter",
) {
  const mode = providerMode();
  if (mode === "direct-openrouter") {
    if (provider !== "openrouter")
      return {
        mode,
        baseUrl,
        apiKey: process.env.KODA_MODEL_API_KEY || "missing",
      };
    const apiKey = localOpenRouterKey();
    if (!apiKey)
      throw Error(
        "INFRA_FAILURE: OPENROUTER_API_KEY is missing in direct-openrouter mode",
      );
    return { mode, baseUrl, apiKey };
  }
  const hostname = new URL(baseUrl).hostname;
  const localAlias = ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
  return {
    mode,
    baseUrl:
      !process.env.KODA_API_URL && localAlias ? baseUrl : backendBaseUrl(),
    apiKey: BACKEND_CLIENT_CREDENTIAL,
  };
}
/** This is the only client-side read of the direct OpenRouter credential. */
export function localOpenRouterKey() {
  return providerMode() === "direct-openrouter"
    ? process.env.OPENROUTER_API_KEY?.trim()
    : undefined;
}
/** LiteLLM must use its generic compatible transport, not model-prefix routing. */
export function liteLLMTransport(
  model: string,
  baseUrl: string,
  provider = "openrouter",
) {
  const transport = providerTransport(baseUrl, provider);
  return {
    ...transport,
    model:
      transport.mode === "backend"
        ? `openai/${model}`
        : provider === "openrouter"
          ? `openrouter/${model}`
          : model,
  };
}
export function openRouterCompatibleBackend(baseUrl: string) {
  return (
    providerMode() === "backend" &&
    baseUrl.replace(/\/$/, "") === backendBaseUrl()
  );
}

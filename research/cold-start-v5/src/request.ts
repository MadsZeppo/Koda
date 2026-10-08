/** Judge-only research transport. Uses the existing shared backend selection. */
import { providerTransport } from '../../../src/provider/transport.js';
let source = '';
for await (const chunk of process.stdin) source += chunk;
const payload = JSON.parse(source);
if (payload.model !== 'openai/gpt-5-2025-08-07') throw Error('Frozen V5 judge only');
const transport = providerTransport();
const started = Date.now();
const response = await fetch(`${transport.baseUrl}/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', Authorization: `Bearer ${transport.apiKey}` },
  body: JSON.stringify(payload), signal: AbortSignal.timeout(120_000),
});
const body = await response.text();
process.stdout.write(JSON.stringify({ status: response.status, origin: response.headers.get('x-koda-error-origin'), transport: transport.mode, elapsedMs: Date.now() - started, body }));

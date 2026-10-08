import { startKodaBackend } from "./proxy.js";
const backend = await startKodaBackend({
  host: process.env.KODA_BACKEND_HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8787),
  timeoutMs: Number(process.env.KODA_BACKEND_TIMEOUT_MS ?? 120_000),
  validateAuth: true,
});
console.log(
  `Koda provider backend listening on port ${new URL(backend.url).port}`,
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void backend.close().then(() => process.exit(0));
  });

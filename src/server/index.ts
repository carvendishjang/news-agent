import "dotenv/config";
import { loadConfig } from "../config.js";
import { createDefaultDeps, createRunner } from "../agent.js";
import { buildNewsGraph } from "../graph/build.js";
import { buildApp } from "./app.js";

async function main() {
  const cfg = loadConfig();
  const runDigest = createRunner(buildNewsGraph(createDefaultDeps(cfg)));

  const app = await buildApp({
    runDigest,
    apiKeys: cfg.API_KEYS,
    rateLimitPerMinute: cfg.RATE_LIMIT_PER_MINUTE,
    requestTimeoutMs: cfg.REQUEST_TIMEOUT_MS,
    cacheTtlSeconds: cfg.CACHE_TTL_SECONDS,
    cacheMaxEntries: cfg.CACHE_MAX_ENTRIES,
    logLevel: cfg.LOG_LEVEL,
    trustProxy: cfg.TRUST_PROXY,
  });

  if (cfg.API_KEYS.length === 0) app.log.warn("API_KEYS is empty: authentication is DISABLED (dev mode)");

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    const force = setTimeout(() => process.exit(1), 30_000);
    force.unref();
    await app.close(); // stops accepting, waits for in-flight requests
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ host: cfg.HOST, port: cfg.PORT });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

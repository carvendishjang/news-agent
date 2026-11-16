import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import type { RunDigest } from "../agent.js";
import { DigestRequestSchema } from "../types.js";
import { DigestCache } from "./cache.js";

export interface AppOptions {
  runDigest: RunDigest;
  apiKeys: string[];
  rateLimitPerMinute: number;
  requestTimeoutMs: number;
  cacheTtlSeconds: number;
  cacheMaxEntries: number;
  logLevel?: string;
  trustProxy?: boolean;
}

class DigestTimeoutError extends Error {
  constructor() {
    super("digest timed out");
    this.name = "DigestTimeoutError";
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function extractApiKey(req: FastifyRequest): string | undefined {
  const header = req.headers["x-api-key"];
  if (typeof header === "string" && header) return header;
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  return undefined;
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: opts.logLevel ?? "info",
      redact: ["req.headers.authorization", 'req.headers["x-api-key"]'],
    },
    trustProxy: opts.trustProxy ?? false,
    bodyLimit: 16 * 1024,
    requestTimeout: opts.requestTimeoutMs + 5_000,
    genReqId: () => crypto.randomUUID(),
  });

  const cache = new DigestCache(opts.cacheTtlSeconds, opts.cacheMaxEntries);
  let shuttingDown = false;
  app.addHook("onClose", async () => {
    shuttingDown = true;
  });

  // ---- public probes ----
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_req, reply) =>
    shuttingDown ? reply.code(503).send({ status: "shutting_down" }) : { status: "ready" },
  );

  // ---- authenticated API ----
  await app.register(async (api) => {
    api.addHook("onRequest", async (req, reply) => {
      if (opts.apiKeys.length === 0) return; // auth disabled (dev only; config enforces keys in production)
      const key = extractApiKey(req);
      if (!key || !opts.apiKeys.some((k) => safeEqual(k, key))) {
        return reply.code(401).send({ error: "unauthorized" });
      }
    });

    await api.register(rateLimit, {
      max: opts.rateLimitPerMinute,
      timeWindow: "1 minute",
      keyGenerator: (req) => extractApiKey(req) ?? req.ip,
    });

    api.post("/v1/digests", async (req, reply) => {
      const parsed = DigestRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request", details: z.treeifyError(parsed.error) });
      }
      const input = parsed.data;

      // The run is shared by identical concurrent requests (single-flight), so it is bounded
      // only by the timeout — one client disconnecting must not abort it for the others.
      const compute = async () => {
        const signal = AbortSignal.timeout(opts.requestTimeoutMs);
        try {
          return await opts.runDigest(input, { signal });
        } catch (err) {
          if (signal.aborted) throw new DigestTimeoutError();
          throw err;
        }
      };

      const started = Date.now();
      try {
        const { digest, cached } = await cache.getOrCompute(input, compute);
        req.log.info(
          { keyword: input.keyword, articles: digest.articles.length, cached, ms: Date.now() - started },
          "digest served",
        );
        reply.header("x-cache", cached ? "HIT" : "MISS");
        return digest;
      } catch (err) {
        if (err instanceof DigestTimeoutError) {
          req.log.warn({ keyword: input.keyword, ms: Date.now() - started }, "digest timed out");
          return reply.code(504).send({ error: "timeout", requestId: req.id });
        }
        req.log.error({ err, keyword: input.keyword }, "digest failed");
        return reply.code(502).send({ error: "upstream_failure", requestId: req.id });
      }
    });
  });

  return app;
}

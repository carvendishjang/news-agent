import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, type AppOptions } from "../src/server/app.js";
import type { Digest } from "../src/types.js";

const digest = (keyword: string): Digest => ({
  keyword,
  generatedAt: "2026-11-16T00:00:00.000Z",
  timeWindowDays: 7,
  language: "en",
  overview: "ok",
  articles: [],
  queries: [keyword],
  warnings: [],
});

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function make(overrides: Partial<AppOptions> = {}) {
  let calls = 0;
  app = await buildApp({
    runDigest: async (req) => {
      calls++;
      return digest(req.keyword);
    },
    apiKeys: ["secret-key"],
    rateLimitPerMinute: 100,
    requestTimeoutMs: 1_000,
    cacheTtlSeconds: 60,
    cacheMaxEntries: 10,
    logLevel: "silent",
    ...overrides,
  });
  return { app, calls: () => calls };
}

const auth = { "x-api-key": "secret-key" };

describe("HTTP API", () => {
  it("serves health probes without auth", async () => {
    const { app } = await make();
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
  });

  it("rejects missing or wrong API keys", async () => {
    const { app } = await make();
    const res1 = await app.inject({ method: "POST", url: "/v1/digests", payload: { keyword: "ai" } });
    const res2 = await app.inject({
      method: "POST",
      url: "/v1/digests",
      headers: { authorization: "Bearer nope" },
      payload: { keyword: "ai" },
    });
    expect(res1.statusCode).toBe(401);
    expect(res2.statusCode).toBe(401);
  });

  it("validates the request body", async () => {
    const { app } = await make();
    const res = await app.inject({
      method: "POST",
      url: "/v1/digests",
      headers: auth,
      payload: { keyword: "x", maxArticles: 99 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });

  it("returns a digest and caches repeat requests", async () => {
    const { app, calls } = await make();
    const req = { method: "POST" as const, url: "/v1/digests", headers: auth, payload: { keyword: "Solar Power" } };
    const r1 = await app.inject(req);
    const r2 = await app.inject({ ...req, payload: { keyword: "solar power" } });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().keyword).toBe("Solar Power");
    expect(r1.headers["x-cache"]).toBe("MISS");
    expect(r2.headers["x-cache"]).toBe("HIT");
    expect(calls()).toBe(1);
  });

  it("maps a timeout to 504 and upstream errors to 502", async () => {
    const slow = await make({
      runDigest: (_req, opts) =>
        new Promise((_res, rej) => opts?.signal?.addEventListener("abort", () => rej(new Error("aborted")))),
      requestTimeoutMs: 50,
    });
    const r1 = await slow.app.inject({ method: "POST", url: "/v1/digests", headers: auth, payload: { keyword: "ai news" } });
    expect(r1.statusCode).toBe(504);
    await slow.app.close();

    const broken = await make({
      runDigest: async () => {
        throw new Error("openai down");
      },
    });
    const r2 = await broken.app.inject({ method: "POST", url: "/v1/digests", headers: auth, payload: { keyword: "ai news" } });
    expect(r2.statusCode).toBe(502);
    expect(r2.json()).not.toHaveProperty("message"); // don't leak internals
  });

  it("rate limits per API key", async () => {
    const { app } = await make({ rateLimitPerMinute: 2, cacheTtlSeconds: 0 });
    const send = () =>
      app.inject({ method: "POST", url: "/v1/digests", headers: auth, payload: { keyword: "rate test" } });
    await send();
    await send();
    expect((await send()).statusCode).toBe(429);
  });
});

import { LRUCache } from "lru-cache";
import type { Digest, DigestRequest } from "../types.js";

/**
 * TTL cache for finished digests plus single-flight for in-progress ones,
 * so N identical concurrent requests cost one graph run.
 */
export class DigestCache {
  private readonly done: LRUCache<string, Digest> | null;
  private readonly inflight = new Map<string, Promise<Digest>>();

  constructor(ttlSeconds: number, maxEntries: number) {
    this.done = ttlSeconds > 0 ? new LRUCache({ max: maxEntries, ttl: ttlSeconds * 1000 }) : null;
  }

  static key(req: DigestRequest): string {
    return [req.keyword.trim().toLowerCase(), req.maxArticles, req.days, req.language.toLowerCase(), req.mode].join("|");
  }

  async getOrCompute(
    req: DigestRequest,
    compute: () => Promise<Digest>,
  ): Promise<{ digest: Digest; cached: boolean }> {
    const key = DigestCache.key(req);
    const hit = this.done?.get(key);
    if (hit) return { digest: hit, cached: true };

    const pending = this.inflight.get(key);
    if (pending) return { digest: await pending, cached: true };

    const p = compute()
      .then((d) => {
        this.done?.set(key, d);
        return d;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return { digest: await p, cached: false };
  }
}

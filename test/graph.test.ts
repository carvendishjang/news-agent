import { describe, expect, it } from "vitest";
import { buildNewsGraph } from "../src/graph/build.js";
import { createRunner } from "../src/agent.js";
import { FakeLLM, FakeSearch, NOW, hit, idsIn } from "./fakes.js";

function standardLLM(overrides: Record<string, (req: { user: string }) => unknown> = {}) {
  return new FakeLLM({
    plan_queries: () => ({ queries: ["solar power policy", "Solar Power"] }),
    rank_articles: ({ user }) => ({
      scores: idsIn(user).map((id, i) => ({
        id,
        relevance: i === 1 ? 2 : 8, // a2 is off-topic
        importance: 10 - i,
        sameStoryAs: null,
      })),
    }),
    summarize_digest: ({ user }) => ({
      overview: "Overview text.",
      articles: idsIn(user).map((id) => ({
        id,
        headline: `Headline ${id}`,
        summary: `Summary ${id}`,
        whyItMatters: `Matters ${id}`,
      })),
    }),
    ...overrides,
  });
}

describe("news graph", () => {
  it("produces a ranked digest whose links come only from search results", async () => {
    const llm = standardLLM();
    const search = new FakeSearch((q) => (q === "solar power" ? [hit(1), hit(2), hit(3), hit(4)] : [hit(5)]));
    const run = createRunner(buildNewsGraph({ llm, search, now: () => NOW }));

    const d = await run({ keyword: "solar power", maxArticles: 3, days: 7, language: "en" });

    // literal keyword first, case-insensitive duplicate dropped
    expect(d.queries).toEqual(["solar power", "solar power policy"]);
    expect(d.articles).toHaveLength(3);
    expect(d.articles.map((a) => a.rank)).toEqual([1, 2, 3]);
    // a2 (relevance 2) was filtered out
    expect(d.articles.find((a) => a.url.includes("story-2"))).toBeUndefined();
    const searchedUrls = new Set([1, 2, 3, 4, 5].map((n) => hit(n).url));
    for (const a of d.articles) expect(searchedUrls.has(a.url)).toBe(true);
    expect(d.overview).toBe("Overview text.");
  });

  it("ignores hallucinated ids and duplicate-story picks from the ranker", async () => {
    const llm = standardLLM({
      rank_articles: () => ({
        scores: [
          { id: "a1", relevance: 9, importance: 9, sameStoryAs: null },
          { id: "a2", relevance: 9, importance: 8, sameStoryAs: "a1" },
          { id: "a99", relevance: 10, importance: 10, sameStoryAs: null },
        ],
      }),
    });
    const search = new FakeSearch(() => [hit(1), hit(2), hit(3)]);
    const run = createRunner(buildNewsGraph({ llm, search, now: () => NOW }));

    const d = await run({ keyword: "solar power", maxArticles: 2, days: 7, language: "en" });
    expect(d.articles.map((a) => a.url)).toEqual([hit(1).url]);
  });

  it("widens the time window once when too few articles are found", async () => {
    const llm = standardLLM();
    const search = new FakeSearch((_q, opts) => (opts.days > 7 ? [hit(1), hit(3), hit(4)] : [hit(1)]));
    const run = createRunner(buildNewsGraph({ llm, search, now: () => NOW, maxBroadenAttempts: 1 }));

    const d = await run({ keyword: "solar power", maxArticles: 3, days: 7, language: "en" });
    expect(d.timeWindowDays).toBe(21);
    expect(d.warnings.some((w) => w.includes("widened window"))).toBe(true);
    expect(d.articles.length).toBeGreaterThan(1);
  });

  it("returns an empty digest without calling rank/summarize when nothing is found", async () => {
    const llm = standardLLM();
    const search = new FakeSearch(() => []);
    const run = createRunner(buildNewsGraph({ llm, search, now: () => NOW }));

    const d = await run({ keyword: "zzqx nothing", maxArticles: 5, days: 7, language: "en" });
    expect(d.articles).toEqual([]);
    expect(d.overview).toMatch(/No featured news/);
    expect(llm.calls.map((c) => c.name)).toEqual(["plan_queries"]);
  });

  it("tolerates one failing query but fails when all searches fail", async () => {
    const llm = standardLLM();
    const partial = new FakeSearch((q) => {
      if (q !== "solar power") throw new Error("429");
      return [hit(1), hit(3), hit(4)];
    });
    const d = await createRunner(buildNewsGraph({ llm, search: partial, now: () => NOW }))({
      keyword: "solar power",
      maxArticles: 2,
      days: 7,
      language: "en",
    });
    expect(d.articles.length).toBeGreaterThan(0);
    expect(d.warnings.some((w) => w.includes("search failed"))).toBe(true);

    const down = new FakeSearch(() => {
      throw new Error("503");
    });
    const run = createRunner(buildNewsGraph({ llm: standardLLM(), search: down, now: () => NOW }));
    await expect(run({ keyword: "solar power", maxArticles: 2, days: 7, language: "en" })).rejects.toThrow(
      /All news searches failed/,
    );
  }, 30_000);
});

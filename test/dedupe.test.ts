import { describe, expect, it } from "vitest";
import { canonicalUrl, dedupeHits, titleSimilarity } from "../src/graph/dedupe.js";
import { NOW, hit } from "./fakes.js";

describe("canonicalUrl", () => {
  it("strips www, tracking params, hash and trailing slash", () => {
    expect(canonicalUrl("https://www.Example.com/a/b/?utm_source=x&id=2&fbclid=1#top")).toBe(
      "example.com/a/b?id=2",
    );
  });
  it("rejects non-http URLs", () => {
    expect(canonicalUrl("javascript:alert(1)")).toBeNull();
    expect(canonicalUrl("not a url")).toBeNull();
  });
});

describe("titleSimilarity", () => {
  it("is high for near-identical headlines", () => {
    expect(
      titleSimilarity("Nvidia unveils new Blackwell chip at GTC", "Nvidia unveils new Blackwell chip at GTC!"),
    ).toBe(1);
  });
  it("is low for different stories", () => {
    expect(titleSimilarity("Nvidia earnings beat estimates", "Apple launches new iPad")).toBeLessThan(0.2);
  });
});

describe("dedupeHits", () => {
  it("collapses duplicate URLs and headlines, keeps the higher score, assigns ids", () => {
    const out = dedupeHits(
      [
        hit(1, { url: "https://a.com/x?utm_campaign=1", score: 0.5 }),
        hit(1, { url: "https://www.a.com/x", score: 0.9 }),
        hit(2, { title: "Big merger announced today", score: 0.8 }),
        hit(3, { title: "Big merger announced today!", url: "https://b.com/y", score: 0.7 }),
      ],
      { days: 7, now: NOW },
    );
    expect(out.map((c) => c.id)).toEqual(["a1", "a2"]);
    expect(out[0]!.searchScore).toBe(0.9);
    expect(out[0]!.source).toBe("a.com");
  });

  it("drops items far outside the time window but keeps undated ones", () => {
    const out = dedupeHits(
      [hit(1, { publishedDate: "2026-01-01T00:00:00Z" }), hit(2, { publishedDate: null })],
      { days: 7, now: NOW },
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.publishedAt).toBeNull();
  });
});

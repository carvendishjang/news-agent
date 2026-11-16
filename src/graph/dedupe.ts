import type { Candidate } from "../types.js";
import type { SearchHit } from "../providers/search.js";

const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|cmpid|ocid)$/i;

/** Normalizes a URL so the same article shared with different tracking params collapses to one key. */
export function canonicalUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
  }
  u.searchParams.sort();
  let s = `${u.hostname}${u.pathname.replace(/\/+$/, "")}`;
  const qs = u.searchParams.toString();
  if (qs) s += `?${qs}`;
  return s;
}

export function sourceOf(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .normalize("NFKC")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1),
  );
}

export function titleSimilarity(a: string, b: string): number {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

function parseDate(d: string | null | undefined): string | null {
  if (!d) return null;
  const t = Date.parse(d);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export interface DedupeOptions {
  /** Drop items whose known publish date is older than this many days (with some slack). */
  days: number;
  now?: Date;
  titleThreshold?: number;
}

/**
 * Turns raw hits into unique candidates:
 *  - drops invalid URLs / empty titles
 *  - drops items clearly outside the time window
 *  - collapses duplicate URLs and near-identical headlines (keeps the higher search score)
 *  - assigns stable ids (a1, a2, ...) in score order
 */
export function dedupeHits(hits: SearchHit[], opts: DedupeOptions): Candidate[] {
  const now = (opts.now ?? new Date()).getTime();
  const maxAgeMs = opts.days * 1.5 * 24 * 3600 * 1000;
  const threshold = opts.titleThreshold ?? 0.75;

  const sorted = [...hits].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const seenUrls = new Set<string>();
  const kept: Omit<Candidate, "id">[] = [];

  for (const h of sorted) {
    const title = h.title?.trim();
    if (!title) continue;
    const key = canonicalUrl(h.url);
    if (!key || seenUrls.has(key)) continue;

    const publishedAt = parseDate(h.publishedDate);
    if (publishedAt && now - Date.parse(publishedAt) > maxAgeMs) continue;

    if (kept.some((k) => titleSimilarity(k.title, title) >= threshold)) continue;

    seenUrls.add(key);
    kept.push({
      title,
      url: h.url,
      source: sourceOf(h.url),
      snippet: (h.content ?? "").replace(/\s+/g, " ").trim().slice(0, 600),
      publishedAt,
      searchScore: h.score ?? 0,
    });
  }

  return kept.map((c, i) => ({ ...c, id: `a${i + 1}` }));
}

import { z } from "zod";

/** Public request contract (HTTP API, CLI, and graph input). */
export const DigestRequestSchema = z.object({
  keyword: z.string().trim().min(2).max(100),
  maxArticles: z.number().int().min(1).max(15).default(8),
  days: z.number().int().min(1).max(30).default(7),
  /** Language the digest is written in (BCP-47-ish, e.g. "en", "ja", "zh-TW"). */
  language: z
    .string()
    .trim()
    .regex(/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/, "invalid language code")
    .default("en"),
  /** "pipeline": fixed plan → search steps. "agent": the model searches in a loop and decides when coverage is enough. */
  mode: z.enum(["pipeline", "agent"]).default("pipeline"),
});
export type DigestRequest = z.infer<typeof DigestRequestSchema>;
/** What callers may pass: fields with defaults are optional. */
export type DigestRequestInput = z.input<typeof DigestRequestSchema>;

/** A raw search hit after normalization. Everything here comes from the search provider, never the LLM. */
export interface Candidate {
  id: string;
  title: string;
  url: string;
  source: string;
  snippet: string;
  publishedAt: string | null;
  searchScore: number;
}

export interface RankedCandidate extends Candidate {
  relevance: number;
  importance: number;
}

export const FeaturedArticleSchema = z.object({
  rank: z.number().int(),
  headline: z.string(),
  summary: z.string(),
  whyItMatters: z.string(),
  url: z.string(),
  source: z.string(),
  publishedAt: z.string().nullable(),
  relevance: z.number(),
  importance: z.number(),
});
export type FeaturedArticle = z.infer<typeof FeaturedArticleSchema>;

export const DigestSchema = z.object({
  keyword: z.string(),
  generatedAt: z.string(),
  timeWindowDays: z.number(),
  language: z.string(),
  overview: z.string(),
  articles: z.array(FeaturedArticleSchema),
  queries: z.array(z.string()),
  warnings: z.array(z.string()),
  /** Present in agent mode: how the research loop went. */
  research: z
    .object({
      searches: z.number().int(),
      steps: z.number().int(),
      tokens: z.number().int(),
      stopReason: z.string(),
    })
    .optional(),
});
export type Digest = z.infer<typeof DigestSchema>;

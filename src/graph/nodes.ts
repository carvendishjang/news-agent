import { z } from "zod";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { StructuredLLM, ToolCallingLLM } from "../providers/llm.js";
import type { NewsSearchProvider, SearchHit } from "../providers/search.js";
import type { Digest, RankedCandidate } from "../types.js";
import { dedupeHits } from "./dedupe.js";
import { planQueriesPrompt, rankPrompt, summarizePrompt } from "./prompts.js";
import type { AgentBudget } from "./research.js";
import type { NewsStateType, NewsStateUpdate } from "./state.js";

export interface GraphDeps {
  llm: StructuredLLM;
  search: NewsSearchProvider;
  /** Results requested per query. */
  resultsPerQuery?: number;
  /** Max times the time window is widened when too few articles are found. */
  maxBroadenAttempts?: number;
  /** Minimum relevance (0-10) for an article to be featured. */
  minRelevance?: number;
  now?: () => Date;
  /** Agent mode only: the model that drives the research loop. */
  agentLLM?: ToolCallingLLM;
  /** Agent mode only: overrides for the research budget. */
  agentBudget?: Partial<AgentBudget>;
}

const MAX_DAYS = 30;

// ---------- planQueries ----------
const PlanSchema = z.object({ queries: z.array(z.string()).min(1).max(6) });

export const planQueries =
  (deps: GraphDeps) =>
  async (state: NewsStateType, config: LangGraphRunnableConfig): Promise<NewsStateUpdate> => {
    const plan = await deps.llm.generate(PlanSchema, {
      name: "plan_queries",
      system: planQueriesPrompt.system,
      user: planQueriesPrompt.user(state.keyword, state.days),
      signal: config.signal,
    });
    // Always search the literal keyword first; de-duplicate case-insensitively; cap at 4.
    const seen = new Set<string>();
    const queries = [state.keyword, ...plan.queries]
      .map((q) => q.trim())
      .filter((q) => q && !seen.has(q.toLowerCase()) && seen.add(q.toLowerCase()))
      .slice(0, 4);
    return { queries };
  };

// ---------- search ----------
export const search =
  (deps: GraphDeps) =>
  async (state: NewsStateType, config: LangGraphRunnableConfig): Promise<NewsStateUpdate> => {
    const settled = await Promise.allSettled(
      state.queries.map((q) =>
        deps.search.searchNews(q, {
          days: state.days,
          maxResults: deps.resultsPerQuery ?? 10,
          signal: config.signal,
        }),
      ),
    );
    const hits: SearchHit[] = [];
    const warnings: string[] = [];
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") hits.push(...r.value);
      else warnings.push(`search failed for query "${state.queries[i]}": ${errMsg(r.reason)}`);
    });
    if (hits.length === 0 && warnings.length === settled.length && settled.length > 0) {
      // Every query failed: this is an upstream outage, not "no news". Let retry policy / caller handle it.
      throw new Error(`All news searches failed. ${warnings.join("; ")}`);
    }
    return { hits, warnings };
  };

// ---------- dedupe ----------
export const dedupe =
  (deps: GraphDeps) =>
  async (state: NewsStateType): Promise<NewsStateUpdate> => ({
    candidates: dedupeHits(state.hits, { days: state.days, now: deps.now?.() }),
  });

// ---------- routing after dedupe ----------
export const routeAfterDedupe =
  (deps: GraphDeps) =>
  (state: NewsStateType): "broaden" | "rank" | "finalizeEmpty" => {
    // In agent mode the model already decided how widely to search; never broaden on its behalf.
    if (state.mode === "agent") return state.candidates.length === 0 ? "finalizeEmpty" : "rank";
    const canBroaden =
      state.broadenAttempts < (deps.maxBroadenAttempts ?? 1) && state.days < MAX_DAYS;
    if (state.candidates.length < state.maxArticles && canBroaden) return "broaden";
    if (state.candidates.length === 0) return "finalizeEmpty";
    return "rank";
  };

export const broaden = async (state: NewsStateType): Promise<NewsStateUpdate> => {
  const days = Math.min(MAX_DAYS, Math.max(state.days * 3, state.days + 7));
  return {
    days,
    broadenAttempts: state.broadenAttempts + 1,
    warnings: [`only ${state.candidates.length} article(s) found; widened window to ${days} days`],
  };
};

// ---------- rank ----------
const RankSchema = z.object({
  scores: z.array(
    z.object({
      id: z.string(),
      relevance: z.number().min(0).max(10),
      importance: z.number().min(0).max(10),
      sameStoryAs: z.string().nullable(),
    }),
  ),
});

export const rank =
  (deps: GraphDeps) =>
  async (state: NewsStateType, config: LangGraphRunnableConfig): Promise<NewsStateUpdate> => {
    // Cap what we send to the model: the top 40 by search score is plenty to pick from.
    const pool = state.candidates.slice(0, 40);
    const out = await deps.llm.generate(RankSchema, {
      name: "rank_articles",
      system: rankPrompt.system,
      user: rankPrompt.user(state.keyword, pool, state.researchFocus),
      signal: config.signal,
    });

    const byId = new Map(pool.map((c) => [c.id, c]));
    const minRelevance = deps.minRelevance ?? 5;
    const ranked: RankedCandidate[] = [];
    for (const s of out.scores) {
      const c = byId.get(s.id);
      if (!c) continue; // ignore hallucinated ids
      if (s.sameStoryAs && s.sameStoryAs !== s.id && byId.has(s.sameStoryAs)) continue;
      if (s.relevance < minRelevance) continue;
      if (ranked.some((r) => r.id === c.id)) continue;
      ranked.push({ ...c, relevance: s.relevance, importance: s.importance });
    }
    ranked.sort(
      (a, b) =>
        b.relevance * 0.6 + b.importance * 0.4 - (a.relevance * 0.6 + a.importance * 0.4) ||
        b.searchScore - a.searchScore,
    );
    const selected = ranked.slice(0, state.maxArticles);
    const warnings =
      selected.length === 0 ? ["no article was judged relevant enough to feature"] : [];
    return { selected, warnings };
  };

// ---------- summarize ----------
const SummarySchema = z.object({
  overview: z.string(),
  articles: z.array(
    z.object({
      id: z.string(),
      headline: z.string(),
      summary: z.string(),
      whyItMatters: z.string(),
    }),
  ),
});

export const summarize =
  (deps: GraphDeps) =>
  async (state: NewsStateType, config: LangGraphRunnableConfig): Promise<NewsStateUpdate> => {
    if (state.selected.length === 0) return { digest: buildDigest(state, deps, "", []) };

    const out = await deps.llm.generate(SummarySchema, {
      name: "summarize_digest",
      system: summarizePrompt.system,
      user: summarizePrompt.user(state.keyword, state.language, state.selected, state.researchFocus),
      signal: config.signal,
    });

    const written = new Map(out.articles.map((a) => [a.id, a]));
    const warnings: string[] = [];
    // URLs, sources and dates always come from the search results, never from the model.
    const articles = state.selected.map((c, i) => {
      const w = written.get(c.id);
      if (!w) warnings.push(`no summary generated for ${c.url}`);
      return {
        rank: i + 1,
        headline: w?.headline ?? c.title,
        summary: w?.summary ?? c.snippet,
        whyItMatters: w?.whyItMatters ?? "",
        url: c.url,
        source: c.source,
        publishedAt: c.publishedAt,
        relevance: c.relevance,
        importance: c.importance,
      };
    });
    return {
      digest: buildDigest({ ...state, warnings: state.warnings.concat(warnings) }, deps, out.overview, articles),
      warnings,
    };
  };

export const finalizeEmpty =
  (deps: GraphDeps) =>
  async (state: NewsStateType): Promise<NewsStateUpdate> => ({
    digest: buildDigest(state, deps, "", []),
  });

function buildDigest(
  state: NewsStateType,
  deps: GraphDeps,
  overview: string,
  articles: Digest["articles"],
): Digest {
  return {
    keyword: state.keyword,
    generatedAt: (deps.now?.() ?? new Date()).toISOString(),
    timeWindowDays: state.days,
    language: state.language,
    overview:
      overview ||
      (articles.length === 0
        ? `No featured news found for "${state.keyword}" in the last ${state.days} day(s).`
        : ""),
    articles,
    queries: state.queries,
    warnings: state.warnings,
    ...(state.mode === "agent"
      ? {
          research: {
            searches: state.searchesUsed,
            steps: state.researchSteps,
            tokens: state.researchTokens,
            stopReason: state.researchStopReason ?? "unknown",
            focus: state.researchFocus,
          },
        }
      : {}),
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

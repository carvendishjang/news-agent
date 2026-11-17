/*
 * Agent mode: a research loop where the model decides what to search next and when to stop.
 *
 *   seedSearch → agent ⇄ tools → (dedupe → rank → summarize, shared with the pipeline)
 *
 * The model only chooses searches. Code enforces every budget, stores the real search hits in state
 * (so URLs still come only from search results), and reports coverage numbers back to the model.
 */
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { z } from "zod";
import type { AgentMessage, ToolCallingLLM, ToolSpec } from "../providers/llm.js";
import type { SearchHit } from "../providers/search.js";
import { canonicalUrl, dedupeHits } from "./dedupe.js";
import type { GraphDeps } from "./nodes.js";
import { researchPrompt } from "./prompts.js";
import type { NewsStateType, NewsStateUpdate } from "./state.js";

export interface AgentBudget {
  /** Total searches, including the seed search of the literal keyword. */
  maxSearches: number;
  /** Model turns in the research loop. */
  maxSteps: number;
  /** Input + output tokens across the research loop. */
  maxTokens: number;
  /** Wall-clock time for research. */
  maxResearchMs: number;
  /** A search finding fewer new stories than this counts as low-yield. */
  minNewStories: number;
  /** Stop after this many low-yield searches in a row. */
  lowYieldLimit: number;
}

export const DEFAULT_AGENT_BUDGET: AgentBudget = {
  maxSearches: 8,
  maxSteps: 6,
  maxTokens: 60_000,
  maxResearchMs: 45_000,
  minNewStories: 2,
  lowYieldLimit: 2,
};

export type StopReason =
  | "finished"
  | "model_stopped"
  | "max_searches"
  | "max_steps"
  | "token_budget"
  | "time_budget"
  | "low_yield";

/** Calls past this per turn are dropped, so one runaway turn can't flood the tool step. */
const MAX_CALLS_PER_TURN = 6;
const MAX_TITLE_CHARS = 140;

// ---------- tools ----------

export const SEARCH_TOOL = "search_news";
export const FINISH_TOOL = "finish_research";

const SearchArgs = z.object({
  query: z.string().trim().min(2).max(100).describe("News search query, under 12 words"),
  days: z.number().int().min(1).max(30).optional().describe("Look-back window in days; defaults to the request's window"),
});
const FinishArgs = z.object({
  focus: z
    .string()
    .trim()
    .min(2)
    .max(100)
    .describe('The meaning of the keyword the digest covers, e.g. "Jaguar, the car brand (Jaguar Land Rover)"'),
  reason: z.string().max(500).describe("Why coverage is good enough"),
});

export const RESEARCH_TOOLS: ToolSpec[] = [
  { name: SEARCH_TOOL, description: "Search recent news. Returns titles, sources and dates, plus coverage so far.", schema: SearchArgs },
  { name: FINISH_TOOL, description: "End research when coverage is good enough.", schema: FinishArgs },
];

// ---------- helpers ----------

export function resolveBudget(b?: Partial<AgentBudget>): AgentBudget {
  return { ...DEFAULT_AGENT_BUDGET, ...b };
}

function requireAgentLLM(deps: GraphDeps): ToolCallingLLM {
  if (!deps.agentLLM) throw new Error('agent mode needs a tool-calling LLM (GraphDeps.agentLLM)');
  return deps.agentLLM;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Titles are untrusted: strip characters that could break the result markup, and cap length. */
const clean = (s: string) => s.replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_CHARS);

/** Results for one search, plus coverage computed by code (not the model's guess). */
function report(opts: {
  query: string;
  days: number;
  found: SearchHit[];
  knownUrls: Set<string | null>;
  freshStories: number;
  allHits: SearchHit[];
  coverageDays: number;
  now: Date;
  searchesLeft: number;
  turnsLeft: number;
}): string {
  const lines = opts.found.map((h) => {
    const isNew = !opts.knownUrls.has(canonicalUrl(h.url));
    const date = h.publishedDate ? h.publishedDate.slice(0, 10) : "date unknown";
    let source = "unknown";
    try {
      source = new URL(h.url).hostname.replace(/^www\./, "");
    } catch {}
    return `- ${isNew ? "[new] " : ""}${clean(h.title ?? "")} (${source}, ${date})`;
  });
  const cands = dedupeHits(opts.allHits, { days: opts.coverageDays, now: opts.now });
  const sources = new Set(cands.map((c) => c.source)).size;
  const dates = cands.map((c) => c.publishedAt).filter((d): d is string => !!d).sort();
  const span = dates.length ? `, newest ${dates.at(-1)!.slice(0, 10)}, oldest ${dates[0]!.slice(0, 10)}` : "";
  return [
    `Results for "${clean(opts.query)}" (last ${opts.days} days): ${opts.found.length} found, ${opts.freshStories} new stories.`,
    "<results>",
    ...(lines.length ? lines : ["(none)"]),
    "</results>",
    `Coverage so far: ${cands.length} unique stories from ${sources} sources${span}.`,
    `Budget left: ${opts.searchesLeft} searches, ${opts.turnsLeft} turns.`,
  ].join("\n");
}

function stopReason(s: {
  finished: boolean;
  searches: number;
  steps: number;
  tokens: number;
  startedAt: number | null;
  lowYield: number;
  budget: AgentBudget;
}): StopReason | null {
  const b = s.budget;
  if (s.finished) return "finished";
  if (s.searches >= b.maxSearches) return "max_searches";
  if (s.steps >= b.maxSteps) return "max_steps";
  if (s.tokens >= b.maxTokens) return "token_budget";
  if (s.startedAt !== null && Date.now() - s.startedAt >= b.maxResearchMs) return "time_budget";
  if (s.lowYield >= b.lowYieldLimit) return "low_yield";
  return null;
}

// ---------- nodes ----------

/** Searches the literal keyword (so it is always covered) and writes the agent's brief. */
export const seedSearch =
  (deps: GraphDeps) =>
  async (state: NewsStateType, config: LangGraphRunnableConfig): Promise<NewsStateUpdate> => {
    requireAgentLLM(deps);
    const budget = resolveBudget(deps.agentBudget);
    const now = deps.now?.() ?? new Date();
    // A failure here throws, so the node's retry policy handles outages.
    const found = await deps.search.searchNews(state.keyword, {
      days: state.days,
      maxResults: deps.resultsPerQuery ?? 10,
      signal: config.signal,
    });
    const fresh = dedupeHits(found, { days: state.days, now }).length;
    const seed = report({
      query: state.keyword,
      days: state.days,
      found,
      knownUrls: new Set(),
      freshStories: fresh,
      allHits: found,
      coverageDays: state.days,
      now,
      searchesLeft: budget.maxSearches - 1,
      turnsLeft: budget.maxSteps,
    });
    const messages: AgentMessage[] = [
      {
        role: "system",
        content: researchPrompt.system({
          maxSearches: budget.maxSearches,
          maxSteps: budget.maxSteps,
          targetStories: state.maxArticles * 2,
        }),
      },
      { role: "user", content: researchPrompt.user(state.keyword, now.toISOString().slice(0, 10), state.days, seed) },
    ];
    return {
      queries: [state.keyword],
      hits: found,
      searchesUsed: 1,
      researchStartedAt: Date.now(),
      agentMessages: messages,
    };
  };

/** One model turn: it either calls tools or stops. */
export const agent =
  (deps: GraphDeps) =>
  async (state: NewsStateType, config: LangGraphRunnableConfig): Promise<NewsStateUpdate> => {
    const llm = requireAgentLLM(deps);
    const turn = await llm.next(state.agentMessages as AgentMessage[], RESEARCH_TOOLS, { signal: config.signal });
    const toolCalls = turn.toolCalls.slice(0, MAX_CALLS_PER_TURN);
    return {
      agentMessages: [{ role: "assistant", content: turn.content, toolCalls }],
      researchSteps: state.researchSteps + 1,
      researchTokens: state.researchTokens + (turn.tokens ?? 0),
      researchStopReason: toolCalls.length === 0 ? "model_stopped" : null,
    };
  };

/** Runs the model's tool calls under the budget and answers every call with a tool message. */
export const tools =
  (deps: GraphDeps) =>
  async (state: NewsStateType, config: LangGraphRunnableConfig): Promise<NewsStateUpdate> => {
    const budget = resolveBudget(deps.agentBudget);
    const now = deps.now?.() ?? new Date();
    const last = state.agentMessages.at(-1);
    if (last?.role !== "assistant") throw new Error("tools step expected a model turn");

    const replies: AgentMessage[] = [];
    const warnings: string[] = [];
    const newHits: SearchHit[] = [];
    const queries = [...state.queries];
    let allHits = [...state.hits] as SearchHit[];
    let searches = state.searchesUsed;
    let lowYield = state.lowYieldStreak;
    let days = state.days;
    let finished = false;
    let focus = state.researchFocus;

    for (const call of last.toolCalls) {
      const reply = (content: string) => replies.push({ role: "tool", toolCallId: call.id, content });

      if (call.name === FINISH_TOOL) {
        const fin = FinishArgs.safeParse(call.args);
        if (!fin.success) {
          reply(`Error: invalid arguments: ${z.prettifyError(fin.error)}`);
          continue;
        }
        finished = true;
        // The focus reaches later prompts, and the model wrote it after reading untrusted results: keep it plain.
        focus = clean(fin.data.focus);
        reply("Research finished.");
        continue;
      }
      if (call.name !== SEARCH_TOOL) {
        reply(`Error: unknown tool "${call.name}". Available tools: ${SEARCH_TOOL}, ${FINISH_TOOL}.`);
        continue;
      }
      const args = SearchArgs.safeParse(call.args);
      if (!args.success) {
        reply(`Error: invalid arguments: ${z.prettifyError(args.error)}`);
        continue;
      }
      if (searches >= budget.maxSearches) {
        reply(`Error: search budget used up. Call ${FINISH_TOOL}.`);
        continue;
      }

      searches++;
      const query = args.data.query;
      const queryDays = args.data.days ?? state.days;
      let found: SearchHit[];
      try {
        found = await deps.search.searchNews(query, {
          days: queryDays,
          maxResults: deps.resultsPerQuery ?? 10,
          signal: config.signal,
        });
      } catch (e) {
        warnings.push(`search failed for query "${query}": ${errMsg(e)}`);
        reply(`Error: search failed: ${errMsg(e)}`);
        continue;
      }

      queries.push(query);
      days = Math.max(days, queryDays);
      const knownUrls = new Set(allHits.map((h) => canonicalUrl(h.url)));
      const before = dedupeHits(allHits, { days, now }).length;
      allHits = allHits.concat(found);
      newHits.push(...found);
      const fresh = dedupeHits(allHits, { days, now }).length - before;
      lowYield = fresh < budget.minNewStories ? lowYield + 1 : 0;

      reply(
        report({
          query,
          days: queryDays,
          found,
          knownUrls,
          freshStories: fresh,
          allHits,
          coverageDays: days,
          now,
          searchesLeft: Math.max(0, budget.maxSearches - searches),
          turnsLeft: Math.max(0, budget.maxSteps - state.researchSteps),
        }),
      );
    }

    const reason = stopReason({
      finished,
      searches,
      steps: state.researchSteps,
      tokens: state.researchTokens,
      startedAt: state.researchStartedAt,
      lowYield,
      budget,
    });
    if (reason && reason !== "finished") warnings.push(`research stopped early (${reason}) after ${searches} searches`);

    return {
      agentMessages: replies,
      hits: newHits,
      queries,
      days,
      searchesUsed: searches,
      lowYieldStreak: lowYield,
      researchStopReason: reason,
      researchFocus: focus,
      warnings,
    };
  };

// ---------- routing ----------

export const routeStart = (state: NewsStateType): "seedSearch" | "planQueries" =>
  state.mode === "agent" ? "seedSearch" : "planQueries";

export const routeAfterAgent = (state: NewsStateType): "tools" | "dedupe" =>
  state.researchStopReason ? "dedupe" : "tools";

export const routeAfterTools = (state: NewsStateType): "agent" | "dedupe" =>
  state.researchStopReason ? "dedupe" : "agent";

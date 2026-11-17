import { ReducedValue, StateSchema } from "@langchain/langgraph";
import { z } from "zod";
import { DigestSchema } from "../types.js";

/*
 * State is defined with Zod (StateSchema) rather than Annotation so the LangGraph server
 * can produce the JSON schema at runtime. With Annotation it falls back to compiling the
 * TypeScript types, which can time out (30s) on slow filesystems such as WSL's /mnt/c.
 */

const SearchHitSchema = z.object({
  title: z.string(),
  url: z.string(),
  content: z.string(),
  score: z.number(),
  publishedDate: z.string().nullable().optional(),
});

const CandidateSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  source: z.string(),
  snippet: z.string(),
  publishedAt: z.string().nullable(),
  searchScore: z.number(),
});

const RankedCandidateSchema = CandidateSchema.extend({
  relevance: z.number(),
  importance: z.number(),
});

const ToolCallSchema = z.object({ id: z.string(), name: z.string(), args: z.unknown() });
const AgentMessageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("system"), content: z.string() }),
  z.object({ role: z.literal("user"), content: z.string() }),
  z.object({ role: z.literal("assistant"), content: z.string(), toolCalls: z.array(ToolCallSchema) }),
  z.object({ role: z.literal("tool"), toolCallId: z.string(), content: z.string() }),
]);

const appendList = <T extends z.ZodType>(item: T) =>
  new ReducedValue(z.array(item).default(() => []), {
    inputSchema: z.array(item),
    reducer: (prev: z.infer<T>[], next: z.infer<T>[]) => prev.concat(next),
  });

export const NewsState = new StateSchema({
  // ---- input ----
  keyword: z.string().describe("Topic to build a featured-news digest for"),
  maxArticles: z.number().int().min(1).max(15).default(8).describe("How many stories to feature"),
  days: z.number().int().min(1).max(30).default(7).describe("Look-back window in days"),
  language: z.string().default("en").describe("Language the digest is written in"),
  mode: z.enum(["pipeline", "agent"]).default("pipeline").describe("Fixed pipeline or research agent"),

  // ---- working state (filled by the graph) ----
  queries: z.array(z.string()).default(() => []),
  /** All raw hits gathered so far (accumulates across broadening passes). */
  hits: appendList(SearchHitSchema),
  candidates: z.array(CandidateSchema).default(() => []),
  broadenAttempts: z.number().int().default(0),
  selected: z.array(RankedCandidateSchema).default(() => []),
  warnings: appendList(z.string()),

  // ---- agent mode: the research loop ----
  /** The agent's conversation (system prompt, user brief, model turns, tool results). */
  agentMessages: appendList(AgentMessageSchema),
  searchesUsed: z.number().int().default(0),
  researchSteps: z.number().int().default(0),
  researchTokens: z.number().int().default(0),
  /** Epoch ms when research started, for the time budget. */
  researchStartedAt: z.number().nullable().default(null),
  /** Consecutive searches that found too few new stories. */
  lowYieldStreak: z.number().int().default(0),
  /** Why research ended; null while it is still running. */
  researchStopReason: z.string().nullable().default(null),

  // ---- output ----
  digest: DigestSchema.nullable().default(null),
});

/** What callers (and the Studio input form) provide. */
export const NewsInput = new StateSchema({
  keyword: NewsState.fields.keyword,
  maxArticles: NewsState.fields.maxArticles,
  days: NewsState.fields.days,
  language: NewsState.fields.language,
  mode: NewsState.fields.mode,
});

/** What the graph returns. */
export const NewsOutput = new StateSchema({
  digest: NewsState.fields.digest,
  warnings: NewsState.fields.warnings,
});

export type NewsStateType = typeof NewsState.State;
export type NewsStateUpdate = typeof NewsState.Update;

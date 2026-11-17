import type { z } from "zod";
import type {
  AgentMessage,
  AgentTurn,
  StructuredLLM,
  StructuredRequest,
  ToolCallingLLM,
  ToolSpec,
} from "../src/providers/llm.js";
import type { NewsSearchProvider, SearchHit, SearchOptions } from "../src/providers/search.js";

type Handler = (req: StructuredRequest) => unknown;

/** Fake LLM: responds per schema name (plan_queries / rank_articles / summarize_digest). */
export class FakeLLM implements StructuredLLM {
  calls: StructuredRequest[] = [];
  constructor(private readonly handlers: Record<string, Handler>) {}

  async generate<S extends z.ZodType>(schema: S, req: StructuredRequest): Promise<z.infer<S>> {
    this.calls.push(req);
    const h = this.handlers[req.name];
    if (!h) throw new Error(`FakeLLM: no handler for ${req.name}`);
    return schema.parse(h(req)) as z.infer<S>;
  }
}

export class FakeSearch implements NewsSearchProvider {
  calls: { query: string; opts: SearchOptions }[] = [];
  constructor(private readonly fn: (query: string, opts: SearchOptions) => SearchHit[] | Promise<SearchHit[]>) {}

  async searchNews(query: string, opts: SearchOptions): Promise<SearchHit[]> {
    this.calls.push({ query, opts });
    return this.fn(query, opts);
  }
}

export const NOW = new Date("2026-11-16T12:00:00Z");

export function hit(n: number, extra: Partial<SearchHit> = {}): SearchHit {
  return {
    title: `Story number ${n} about distinct topic ${"xyz".repeat(n)}`,
    url: `https://news${n}.example.com/story-${n}`,
    content: `Snippet for story ${n}.`,
    score: 1 - n / 100,
    publishedDate: "2026-11-15T08:00:00Z",
    ...extra,
  };
}

/** Pulls article ids out of a rendered prompt. */
export function idsIn(user: string): string[] {
  return [...user.matchAll(/<article id="(a\d+)">/g)].map((m) => m[1]!);
}

/** Scripted tool-calling model: `script` sees the conversation so far and returns the next turn. */
export class FakeAgentLLM implements ToolCallingLLM {
  calls: AgentMessage[][] = [];
  constructor(private readonly script: (messages: AgentMessage[], turn: number) => AgentTurn) {}

  async next(messages: AgentMessage[], _tools: ToolSpec[]): Promise<AgentTurn> {
    this.calls.push(structuredClone(messages));
    return this.script(messages, this.calls.length - 1);
  }
}

let callSeq = 0;
export const searchCall = (query: string, days?: number) => ({
  id: `call_${++callSeq}`,
  name: "search_news",
  args: days === undefined ? { query } : { query, days },
});
export const finishCall = (focus = "solar power", reason = "enough coverage") => ({
  id: `call_${++callSeq}`,
  name: "finish_research",
  args: { focus, reason },
});
export const turn = (...toolCalls: AgentTurn["toolCalls"]): AgentTurn => ({ content: "", toolCalls, tokens: 1000 });

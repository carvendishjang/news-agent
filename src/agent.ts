import type { Config } from "./config.js";
import { buildNewsGraph, type NewsGraph } from "./graph/build.js";
import type { GraphDeps } from "./graph/nodes.js";
import { OpenAIStructuredLLM, OpenAIToolCallingLLM } from "./providers/llm.js";
import { TavilyNewsSearch } from "./providers/search.js";
import { DigestRequestSchema, type Digest, type DigestRequestInput } from "./types.js";

export function createDefaultDeps(cfg: Config): GraphDeps {
  return {
    llm: new OpenAIStructuredLLM({
      apiKey: cfg.OPENAI_API_KEY,
      model: cfg.OPENAI_MODEL,
      timeoutMs: cfg.LLM_TIMEOUT_MS,
      reasoningEffort: cfg.OPENAI_REASONING_EFFORT,
    }),
    search: new TavilyNewsSearch(cfg.TAVILY_API_KEY, cfg.SEARCH_TIMEOUT_MS),
    agentLLM: new OpenAIToolCallingLLM({
      apiKey: cfg.OPENAI_API_KEY,
      model: cfg.OPENAI_MODEL,
      timeoutMs: cfg.LLM_TIMEOUT_MS,
      reasoningEffort: cfg.OPENAI_REASONING_EFFORT,
    }),
    agentBudget: {
      maxSearches: cfg.AGENT_MAX_SEARCHES,
      maxSteps: cfg.AGENT_MAX_STEPS,
      maxTokens: cfg.AGENT_MAX_TOKENS,
      maxResearchMs: cfg.AGENT_MAX_RESEARCH_MS,
    },
  };
}

export type RunDigest = (req: DigestRequestInput, opts?: { signal?: AbortSignal }) => Promise<Digest>;

export function createRunner(graph: NewsGraph): RunDigest {
  return async (req, opts) => {
    const input = DigestRequestSchema.parse(req);
    const final = await graph.invoke(input, {
      signal: opts?.signal,
      runName: "news_digest",
      tags: ["news-agent"],
      metadata: { keyword: input.keyword, days: input.days, mode: input.mode },
      // Agent mode runs up to 2 graph steps per research turn (AGENT_MAX_STEPS ≤ 15), plus the fixed steps.
      recursionLimit: 50,
    });
    if (!final.digest) throw new Error("graph finished without producing a digest");
    return final.digest;
  };
}

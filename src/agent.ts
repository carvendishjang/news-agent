import type { Config } from "./config.js";
import { buildNewsGraph, type NewsGraph } from "./graph/build.js";
import type { GraphDeps } from "./graph/nodes.js";
import { OpenAIStructuredLLM } from "./providers/llm.js";
import { TavilyNewsSearch } from "./providers/search.js";
import { DigestRequestSchema, type Digest, type DigestRequest } from "./types.js";

export function createDefaultDeps(cfg: Config): GraphDeps {
  return {
    llm: new OpenAIStructuredLLM({
      apiKey: cfg.OPENAI_API_KEY,
      model: cfg.OPENAI_MODEL,
      timeoutMs: cfg.LLM_TIMEOUT_MS,
      reasoningEffort: cfg.OPENAI_REASONING_EFFORT,
    }),
    search: new TavilyNewsSearch(cfg.TAVILY_API_KEY, cfg.SEARCH_TIMEOUT_MS),
  };
}

export type RunDigest = (req: DigestRequest, opts?: { signal?: AbortSignal }) => Promise<Digest>;

export function createRunner(graph: NewsGraph): RunDigest {
  return async (req, opts) => {
    const input = DigestRequestSchema.parse(req);
    const final = await graph.invoke(input, {
      signal: opts?.signal,
      runName: "news_digest",
      tags: ["news-agent"],
      metadata: { keyword: input.keyword, days: input.days },
      recursionLimit: 25,
    });
    if (!final.digest) throw new Error("graph finished without producing a digest");
    return final.digest;
  };
}

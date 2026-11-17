import { END, START, StateGraph, type RetryPolicy } from "@langchain/langgraph";
import { NewsInput, NewsOutput, NewsState } from "./state.js";
import {
  broaden,
  dedupe,
  finalizeEmpty,
  planQueries,
  rank,
  routeAfterDedupe,
  search,
  summarize,
  type GraphDeps,
} from "./nodes.js";
import { agent, routeAfterAgent, routeAfterTools, routeStart, seedSearch, tools } from "./research.js";

/** Retries transient failures (network, 429, 5xx, bad structured output) on the nodes that call external services. */
const externalRetry: RetryPolicy = {
  maxAttempts: 3,
  initialInterval: 500,
  backoffFactor: 2,
  maxInterval: 8_000,
  retryOn: (err: unknown) => {
    const name = (err as { name?: string })?.name ?? "";
    // Never retry aborts/timeouts we caused ourselves.
    return name !== "AbortError" && name !== "TimeoutError";
  },
};

/**
 *  pipeline mode:
 *  START → planQueries → search → dedupe ─┬─(too few)→ broaden → search
 *                                          ├─(none)───→ finalizeEmpty → END
 *                                          └─────────→ rank → summarize → END
 *
 *  agent mode:
 *  START → seedSearch → agent ⇄ tools ──(finished or out of budget)──→ dedupe → (as above, no broaden)
 */
export function buildNewsGraph(deps: GraphDeps) {
  return new StateGraph({ state: NewsState, input: NewsInput, output: NewsOutput })
    .addNode("planQueries", planQueries(deps), { retryPolicy: externalRetry })
    .addNode("search", search(deps), { retryPolicy: externalRetry })
    .addNode("dedupe", dedupe(deps))
    .addNode("broaden", broaden)
    .addNode("rank", rank(deps), { retryPolicy: externalRetry })
    .addNode("summarize", summarize(deps), { retryPolicy: externalRetry })
    .addNode("finalizeEmpty", finalizeEmpty(deps))
    // agent mode: the tools step is not retried as a whole; failed searches go back to the model as errors.
    .addNode("seedSearch", seedSearch(deps), { retryPolicy: externalRetry })
    .addNode("agent", agent(deps), { retryPolicy: externalRetry })
    .addNode("tools", tools(deps))
    .addConditionalEdges(START, routeStart, ["planQueries", "seedSearch"])
    .addEdge("seedSearch", "agent")
    .addConditionalEdges("agent", routeAfterAgent, ["tools", "dedupe"])
    .addConditionalEdges("tools", routeAfterTools, ["agent", "dedupe"])
    .addEdge("planQueries", "search")
    .addEdge("search", "dedupe")
    .addConditionalEdges("dedupe", routeAfterDedupe(deps), ["broaden", "rank", "finalizeEmpty"])
    .addEdge("broaden", "search")
    .addEdge("rank", "summarize")
    .addEdge("summarize", END)
    .addEdge("finalizeEmpty", END)
    .compile();
}

export type NewsGraph = ReturnType<typeof buildNewsGraph>;

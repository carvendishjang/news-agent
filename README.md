# news-agent

An LLM service that turns a keyword into a **ranked, summarized news digest** in any language. Built with LangGraph (TypeScript), OpenAI and Tavily, served over a Fastify API.

## How it works

**Pipeline mode** (default): fixed steps.

```
plan queries → search (parallel) → dedupe ─┬─ too few → widen window once → search
                                           ├─ none ───→ empty digest
                                           └─────────→ rank → summarize
```

**Agent mode** (`"mode": "agent"`): the model researches in a loop. It chooses each search, sees what came back, and decides when coverage is good enough.

```
seed search → agent ⇄ tools ── finished, or out of budget ──→ dedupe → rank → summarize
```

- The agent has two tools: `search_news(query, days?)` and `finish_research(focus, reason)`.
- For ambiguous keywords ("Jaguar"), it must name the meaning it covers; ranking treats other meanings as off-topic.
- After each search, code (not the model) reports new stories found, total coverage and budget left.

## Design guarantees

- **No made-up links:** URLs, sources and dates come only from search results, never from the LLM.
- **Untrusted web text:** article content is fenced off in prompts and stripped of markup, so it can't act as instructions.
- **Validated output:** every LLM response is checked with Zod; external calls retry with backoff.
- **Code-enforced agent budgets:** max searches, turns, tokens and time, plus a stop when searches stop finding new stories. A prompt can be ignored; these can't.

## Performance

Reasoning effort (`OPENAI_REASONING_EFFORT`, default `low`), measured on 6 keywords with `gpt-5-mini`:

| Effort | Median latency | LLM cost / digest | Ranking agreement with `medium` |
|---|---|---|---|
| `medium` | ~88s | ~$0.015 | 6.2 / 8 (run-to-run) |
| **`low` (default)** | **~43s** | **~$0.008** | **5.8 / 8** |
| `minimal` | ~30s | ~$0.006 | 5.2 / 8 |

`medium` agrees with itself only 6.2/8 times on identical input, so `low` is within normal variation. Search adds ~$0.03 per digest.

## Quick start

```bash
cp .env.example .env        # set OPENAI_API_KEY and TAVILY_API_KEY
npm install

npm run digest -- "solar power"                  # markdown digest
npm run digest -- "半導體" --lang zh-TW --json    # JSON, written in Traditional Chinese
npm run digest -- "Jaguar" --mode agent          # research agent
npm run dev                                      # HTTP API on :8080
npm test                                         # offline tests, no API calls
```

## API

`POST /v1/digests` with header `x-api-key: <key>`:

```json
{ "keyword": "solar power", "maxArticles": 8, "days": 7, "language": "en", "mode": "pipeline" }
```

Returns an `overview`, ranked `articles` (headline, summary, why it matters, URL, source, date, scores), the `queries` used, `warnings`, and in agent mode `research` stats (searches, turns, tokens, stop reason, focus).

Errors: `400` invalid input, `401` bad key, `429` rate-limited, `502` upstream failure, `504` timeout. Identical requests are cached and concurrent ones share a single run.

## Configuration

All settings are environment variables, validated at startup; see `.env.example`. In production the server refuses to start without `API_KEYS`. Set `LANGSMITH_TRACING=true` to trace every run.

## Deploy

```bash
docker build -t news-agent .
docker run -p 8080:8080 --env-file .env -e API_KEYS=change-me news-agent
```

Multi-stage, non-root image with a health check and graceful shutdown. The service is stateless, so it scales horizontally.

## Project layout

```
src/
  cli.ts               terminal entry point
  agent.ts             wires real providers → graph → runDigest()
  config.ts            env validation
  types.ts             request and digest schemas
  graph/
    build.ts           graph topology + retry policy
    state.ts           graph state (Zod schemas)
    nodes.ts           pipeline steps + routing
    research.ts        agent mode: seed search, agent ⇄ tools loop, budgets
    dedupe.ts          URL canonicalization, headline similarity
    prompts.ts         all prompts in one place
    studio.ts          export for LangGraph Studio
  providers/
    llm.ts             StructuredLLM + ToolCallingLLM interfaces, OpenAI implementations
    search.ts          NewsSearchProvider interface, Tavily implementation
  server/
    app.ts             Fastify app: auth, rate limit, timeouts, errors
    cache.ts           TTL cache + single-flight
    index.ts           process entry, graceful shutdown
test/                  offline tests with a fake LLM and fake search
```

To swap the model or news source, implement `StructuredLLM`, `ToolCallingLLM` or `NewsSearchProvider` and pass it to `buildNewsGraph()`.

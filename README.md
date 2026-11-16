# news-agent

A LangGraph (TypeScript) agent that builds a **featured-news digest** for a keyword: it plans searches, pulls recent news, removes duplicates, ranks stories by relevance and importance, and writes concise summaries with links.

```
START → planQueries → search → dedupe ─┬─(too few results)→ broaden → search   (widen time window, max 1x)
                                       ├─(nothing found)──→ finalizeEmpty → END
                                       └──────────────────→ rank → summarize → END
```

| Node | What it does |
|---|---|
| `planQueries` | LLM writes 2–4 search angles; the literal keyword is always searched first |
| `search` | Tavily `news` search, all queries in parallel; a single failed query becomes a warning, all failing is an error |
| `dedupe` | Canonicalizes URLs (strips tracking params), collapses near-identical headlines, drops stale items |
| `broaden` | If fewer than `maxArticles` unique stories, widens the window (7 → 21 days, capped at 30) and searches again |
| `rank` | LLM scores relevance and importance and flags same-story duplicates; code filters, sorts, and picks the top N |
| `summarize` | LLM writes headline, summary, and why-it-matters for each pick plus an overview, in the requested language |

**Safety and reliability**
- URLs, sources, and dates always come from search results, never from the LLM, so links can't be hallucinated. Unknown article ids returned by the model are ignored.
- Web content goes into prompts as delimited, untrusted data, with instructions to ignore anything that looks like a command.
- All LLM output is validated with Zod; nodes that call external services retry with exponential backoff.

## Quick start

```bash
cp .env.example .env        # fill OPENAI_API_KEY and TAVILY_API_KEY
npm install

npm run digest -- "solar power" --days 7 --max 5           # markdown to stdout
npm run digest -- "半導體" --lang zh-TW --json              # JSON, digest written in Traditional Chinese
npm run dev                                                # HTTP API with reload on :8080
npm run studio                                             # LangGraph Studio (visual graph + traces)
npm test                                                   # offline tests, no API calls
```

## HTTP API

`POST /v1/digests` (auth: `x-api-key: <key>` or `Authorization: Bearer <key>`)

```json
{ "keyword": "solar power", "maxArticles": 8, "days": 7, "language": "en" }
```

| Field | Type | Default | Limits |
|---|---|---|---|
| `keyword` | string | required | 2–100 chars |
| `maxArticles` | int | 8 | 1–15 |
| `days` | int | 7 | 1–30 |
| `language` | string | `en` | language code such as `en`, `ja`, `zh-TW` |

Response `200`:

```json
{
  "keyword": "solar power",
  "generatedAt": "2026-11-16T12:00:00.000Z",
  "timeWindowDays": 7,
  "language": "en",
  "overview": "…",
  "articles": [
    { "rank": 1, "headline": "…", "summary": "…", "whyItMatters": "…",
      "url": "https://…", "source": "reuters.com", "publishedAt": "2026-11-15T08:00:00.000Z",
      "relevance": 9, "importance": 8 }
  ],
  "queries": ["solar power", "…"],
  "warnings": []
}
```

Errors: `400 invalid_request`, `401 unauthorized`, `429` rate-limited, `502 upstream_failure` (includes `requestId` for log lookup), `504 timeout`.
The `x-cache: HIT|MISS` response header shows whether the cache was used. Identical concurrent requests share one graph run.

Probes: `GET /healthz` (liveness) and `GET /readyz` (returns 503 while shutting down).

## Configuration

All settings come from environment variables and are validated at startup (`src/config.ts`); see `.env.example`.
In production (`NODE_ENV=production`) the server refuses to start without `API_KEYS`.

Set `LANGSMITH_TRACING=true` and `LANGSMITH_API_KEY` to trace every run. Each node and each LLM call (`plan_queries`, `rank_articles`, `summarize_digest`) appears as a span tagged with the keyword.

## Deploy

```bash
docker build -t news-agent .
docker run -p 8080:8080 --env-file .env -e API_KEYS=change-me news-agent
```

The image is a multi-stage build that runs as non-root, with a built-in `HEALTHCHECK` and graceful shutdown on SIGTERM (drains in-flight requests for up to 30s).
It's stateless, so you can scale horizontally on Cloud Run, ECS, Fly.io, or Kubernetes. The cache is per-instance; swap `DigestCache` for Redis if you need a cache shared across replicas.

## Project layout

```
src/
  config.ts            env validation
  types.ts             request/digest schemas
  agent.ts             wires real providers → graph → runDigest()
  cli.ts               terminal entry point
  graph/
    state.ts           LangGraph state (Annotation)
    nodes.ts           node implementations + routing
    build.ts           graph topology + retry policy
    dedupe.ts          URL canonicalization, headline similarity
    prompts.ts         all prompts in one place
    studio.ts          export for LangGraph Studio
  providers/
    llm.ts             StructuredLLM interface + OpenAI implementation
    search.ts          NewsSearchProvider interface + Tavily implementation
  server/
    app.ts             Fastify app (auth, rate limit, timeouts, errors)
    cache.ts           TTL cache + single-flight
    index.ts           process entry, graceful shutdown
test/                  offline tests with fake LLM + fake search
```

To change the model provider or news source, implement `StructuredLLM` or `NewsSearchProvider` and pass it to `buildNewsGraph()`.

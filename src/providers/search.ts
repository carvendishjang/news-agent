import { tavily } from "@tavily/core";

export interface SearchHit {
  title: string;
  url: string;
  content: string;
  score: number;
  publishedDate?: string | null;
}

export interface SearchOptions {
  days: number;
  maxResults: number;
  signal?: AbortSignal;
}

export interface NewsSearchProvider {
  searchNews(query: string, opts: SearchOptions): Promise<SearchHit[]>;
}

export class TavilyNewsSearch implements NewsSearchProvider {
  private client;

  constructor(
    apiKey: string,
    private readonly timeoutMs: number,
  ) {
    this.client = tavily({ apiKey, clientName: "news-agent" });
  }

  async searchNews(query: string, opts: SearchOptions): Promise<SearchHit[]> {
    opts.signal?.throwIfAborted();
    const res = await this.client.search(query, {
      topic: "news",
      days: opts.days,
      maxResults: opts.maxResults,
      searchDepth: "basic",
      includeAnswer: false,
      includeRawContent: false,
      timeout: Math.ceil(this.timeoutMs / 1000),
    });
    return res.results.map((r) => ({
      title: r.title,
      url: r.url,
      content: r.content,
      score: r.score,
      publishedDate: r.publishedDate ?? null,
    }));
  }
}

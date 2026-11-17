// Usage: npm run digest -- "<keyword>" [--days 7] [--max 8] [--lang en] [--mode pipeline|agent] [--json]
import "dotenv/config";
import { parseArgs } from "node:util";
import { ZodError } from "zod";
import { loadConfig } from "./config.js";
import { createDefaultDeps, createRunner } from "./agent.js";
import { buildNewsGraph } from "./graph/build.js";
import type { Digest } from "./types.js";

function toMarkdown(d: Digest): string {
  const lines = [`# Featured news: ${d.keyword}`, `_last ${d.timeWindowDays} day(s) · ${d.generatedAt}_`, "", d.overview, ""];
  for (const a of d.articles) {
    const date = a.publishedAt ? a.publishedAt.slice(0, 10) : "date unknown";
    lines.push(`## ${a.rank}. ${a.headline}`, `${a.source} · ${date} · ${a.url}`, "", a.summary);
    if (a.whyItMatters) lines.push("", `**Why it matters:** ${a.whyItMatters}`);
    lines.push("");
  }
  if (d.research) {
    const r = d.research;
    lines.push("---", `_research: ${r.searches} searches, ${r.steps} turns, ${r.tokens} tokens, stopped: ${r.stopReason}_`);
  }
  if (d.warnings.length) lines.push("---", ...d.warnings.map((w) => `> note: ${w}`));
  return lines.join("\n");
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      days: { type: "string", default: "7" },
      max: { type: "string", default: "8" },
      lang: { type: "string", default: "en" },
      mode: { type: "string", default: "pipeline" },
      json: { type: "boolean", default: false },
    },
  });
  const keyword = positionals.join(" ").trim();
  if (!keyword) {
    console.error('Usage: npm run digest -- "<keyword>" [--days 7] [--max 8] [--lang en] [--mode pipeline|agent] [--json]');
    process.exit(2);
  }

  const run = createRunner(buildNewsGraph(createDefaultDeps(loadConfig())));
  const digest = await run({
    keyword,
    days: Number(values.days),
    maxArticles: Number(values.max),
    language: values.lang!,
    mode: values.mode as "pipeline" | "agent",
  });
  console.log(values.json ? JSON.stringify(digest, null, 2) : toMarkdown(digest));
}

main().catch((err) => {
  if (err instanceof ZodError) {
    for (const issue of err.issues) console.error(`Invalid ${issue.path.join(".") || "input"}: ${issue.message}`);
    console.error('Usage: npm run digest -- "<keyword>" [--days 7] [--max 8] [--lang en] [--mode pipeline|agent] [--json]');
    console.error('Note the space after "--", e.g.  npm run digest -- "solar power" --days 5');
    process.exit(2);
  }
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

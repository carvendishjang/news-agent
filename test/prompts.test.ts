import { describe, expect, it } from "vitest";
import { summarizePrompt } from "../src/graph/prompts.js";

describe("summarize prompt", () => {
  it("tells the model to write for readers, never about its source text", () => {
    const s = summarizePrompt.system;
    expect(s).toContain("Write for a reader who never sees the article text");
    expect(s).toMatch(/Never mention snippets/);
    expect(s).toContain("write a shorter summary instead of explaining what is missing");
  });

  it("does not itself frame the input as snippets to report on", () => {
    // The old wording ("If a snippet is thin…") invited the model to talk about snippets.
    expect(summarizePrompt.system).not.toMatch(/if a snippet is/i);
  });
});

import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { z } from "zod";

export interface StructuredRequest {
  /** Name of the output schema (shows up in traces). */
  name: string;
  system: string;
  user: string;
  signal?: AbortSignal;
}

/**
 * The only thing the graph needs from an LLM: "give me an object matching this schema".
 * Keeping it this small makes the graph trivial to test with a fake.
 */
export interface StructuredLLM {
  generate<S extends z.ZodType>(schema: S, req: StructuredRequest): Promise<z.infer<S>>;
}

export class OpenAIStructuredLLM implements StructuredLLM {
  private readonly model: ChatOpenAI;

  constructor(opts: {
    apiKey: string;
    model: string;
    timeoutMs: number;
    reasoningEffort?: "minimal" | "low" | "medium" | "high";
  }) {
    this.model = new ChatOpenAI({
      apiKey: opts.apiKey,
      model: opts.model,
      timeout: opts.timeoutMs,
      maxRetries: 2,
      ...(opts.reasoningEffort ? { reasoning: { effort: opts.reasoningEffort } } : {}),
    });
  }

  async generate<S extends z.ZodType>(schema: S, req: StructuredRequest): Promise<z.infer<S>> {
    const runnable = this.model.withStructuredOutput(schema as z.ZodType<Record<string, unknown>>, {
      name: req.name,
    });
    const out = await runnable.invoke([new SystemMessage(req.system), new HumanMessage(req.user)], {
      signal: req.signal,
      runName: req.name,
    });
    // Re-validate: never trust model output shape blindly.
    return schema.parse(out) as z.infer<S>;
  }
}

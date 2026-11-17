import { ChatOpenAI } from "@langchain/openai";
import { randomUUID } from "node:crypto";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { z } from "zod";

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

// ---------------------------------------------------------------------------
// Tool calling (agent mode)
// ---------------------------------------------------------------------------

/** A tool the model may call. `schema` validates its arguments. */
export interface ToolSpec {
  name: string;
  description: string;
  schema: z.ZodObject;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Raw arguments from the model: always validate before use. */
  args: unknown;
}

/** Plain, serializable messages so they can live in graph state and be scripted in tests. */
export type AgentMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface AgentTurn {
  content: string;
  toolCalls: ToolCall[];
  /** Total tokens used by this call (input + output), when the provider reports it. */
  tokens?: number;
}

/** What the research loop needs from an LLM: "given this conversation and these tools, what next?" */
export interface ToolCallingLLM {
  next(messages: AgentMessage[], tools: ToolSpec[], opts?: { signal?: AbortSignal }): Promise<AgentTurn>;
}

function toLangChain(m: AgentMessage): BaseMessage {
  switch (m.role) {
    case "system":
      return new SystemMessage(m.content);
    case "user":
      return new HumanMessage(m.content);
    case "assistant":
      return new AIMessage({
        content: m.content,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          name: c.name,
          args: (c.args ?? {}) as Record<string, unknown>,
          type: "tool_call" as const,
        })),
      });
    case "tool":
      return new ToolMessage({ content: m.content, tool_call_id: m.toolCallId });
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "string" ? b : (b as { type?: string; text?: string }).type === "text" ? (b as { text: string }).text : ""))
      .join("");
  }
  return "";
}

export class OpenAIToolCallingLLM implements ToolCallingLLM {
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

  async next(messages: AgentMessage[], tools: ToolSpec[], opts?: { signal?: AbortSignal }): Promise<AgentTurn> {
    const bound = this.model.bindTools(
      tools.map((t) => {
        const { $schema: _ignored, ...parameters } = z.toJSONSchema(t.schema) as Record<string, unknown>;
        return { type: "function" as const, function: { name: t.name, description: t.description, parameters } };
      }),
    );
    const res = await bound.invoke(messages.map(toLangChain), { signal: opts?.signal, runName: "research_agent" });
    const usage = res.usage_metadata;
    return {
      content: textOf(res.content),
      toolCalls: (res.tool_calls ?? []).map((c) => ({ id: c.id ?? randomUUID(), name: c.name, args: c.args })),
      tokens: usage ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) : undefined,
    };
  }
}

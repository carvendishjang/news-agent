import { z } from "zod";

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
    OPENAI_MODEL: z.string().default("gpt-5-mini"),
    /** Reasoning effort for reasoning models (ignored by others). Lower = faster and cheaper. */
    OPENAI_REASONING_EFFORT: z.enum(["minimal", "low", "medium", "high"]).default("low"),
    TAVILY_API_KEY: z.string().min(1, "TAVILY_API_KEY is required"),

    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().positive().default(8080),
    TRUST_PROXY: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

    /** Comma-separated list of accepted API keys for the HTTP API. Required in production. */
    API_KEYS: csv,
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(30),
    REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
    LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
    SEARCH_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
    CACHE_TTL_SECONDS: z.coerce.number().int().nonnegative().default(900),
    CACHE_MAX_ENTRIES: z.coerce.number().int().positive().default(500),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.NODE_ENV === "production" && cfg.API_KEYS.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["API_KEYS"],
        message: "API_KEYS must be set in production",
      });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${details}`);
  }
  return parsed.data;
}

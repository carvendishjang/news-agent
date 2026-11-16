import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // First import of Fastify/LangChain is slow on WSL's /mnt/c filesystem.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

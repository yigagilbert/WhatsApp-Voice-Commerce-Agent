import { defineConfig } from 'vitest/config';

// EXTERNAL tests: call real PayPal Sandbox and a real LLM. Opt-in only (`pnpm test:external`),
// never part of `pnpm test` / `pnpm verify`. Each suite skips itself when credentials are absent.
export default defineConfig({
  test: {
    include: ['tests/external/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 90_000,
  },
});

import { defineConfig } from 'vitest/config';

// Integration tests: need a migrated Postgres (DATABASE_URL). Run with `pnpm test:integration`.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

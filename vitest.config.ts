import { defineConfig } from 'vitest/config';

// Unit tests: fast, no external services. Co-located next to the code (`*.test.ts`).
export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      'apps/web/lib/**/*.test.ts',
    ],
    environment: 'node',
  },
});

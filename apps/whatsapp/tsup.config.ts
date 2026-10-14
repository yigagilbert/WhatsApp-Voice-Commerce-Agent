import { defineConfig } from 'tsup';

// Workspace packages export TypeScript source, so they are bundled into the worker build.
// Third-party dependencies stay external and are resolved from node_modules at runtime.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  noExternal: [/^@vca\//],
});

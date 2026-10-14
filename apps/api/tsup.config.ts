import { defineConfig } from 'tsup';

// Workspace packages export TypeScript source, so they are bundled into the API build.
// Third-party dependencies stay external and are resolved from node_modules at runtime.
export default defineConfig({
  // index: the API server. seed / operator-add: production maintenance commands run inside the
  // image (`node dist/seed.js`, `node dist/operator-add.js <id>`), so the VM needs no Node toolchain.
  entry: {
    index: 'src/index.ts',
    seed: '../../packages/database/prisma/seed.ts',
    'operator-add': '../../scripts/operator-add.ts',
    // Demo/development only; guarded (see the script header).
    'demo-reset': '../../scripts/demo-reset.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  noExternal: [/^@vca\//],
});

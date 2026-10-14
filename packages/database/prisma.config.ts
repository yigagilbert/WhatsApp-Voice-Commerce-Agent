import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { defineConfig } from 'prisma/config';

// Load the single repository-root .env (Prisma 7 no longer loads .env files itself).
let dir = resolve(process.cwd());
while (!existsSync(join(dir, 'pnpm-workspace.yaml')) && dirname(dir) !== dir) dir = dirname(dir);
if (existsSync(join(dir, '.env'))) loadDotenv({ path: join(dir, '.env'), quiet: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // `prisma generate` needs no database (e.g. Docker builds, CI, fresh clones), so a missing
    // DATABASE_URL must not be fatal. Commands that connect (migrate, studio) fail clearly
    // against this unreachable placeholder instead.
    url: process.env.DATABASE_URL ?? 'postgresql://unset:unset@127.0.0.1:1/DATABASE_URL_not_set',
  },
});

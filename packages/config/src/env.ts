import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

let loaded = false;

/** Walks up from `start` until it finds the directory containing pnpm-workspace.yaml. */
export function findRepoRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

/**
 * Loads the single root `.env` file (if present) into process.env.
 * Existing environment variables always win, so Docker/CI configuration is never overridden.
 */
export function loadEnvFile(): void {
  if (loaded) return;
  loaded = true;
  const path = join(findRepoRoot(), '.env');
  if (existsSync(path)) loadDotenv({ path, override: false, quiet: true });
}

/** Resolves a possibly-relative path against the repository root. */
export function resolveFromRoot(path: string): string {
  return resolve(findRepoRoot(), path);
}

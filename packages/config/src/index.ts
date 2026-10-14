import type { z } from 'zod';
import { loadEnvFile } from './env';
import { apiSchema, whatsappSchema, webSchema } from './schemas';

export * from './schemas';
export { findRepoRoot, loadEnvFile, resolveFromRoot } from './env';

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/** Parses an environment object against a schema, reporting every problem at once. */
export function parseConfig<S extends z.ZodType>(
  schema: S,
  env: Record<string, string | undefined> = process.env,
): z.infer<S> {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data;
}

export const loadApiConfig = () => {
  loadEnvFile();
  return parseConfig(apiSchema);
};

export const loadWhatsAppConfig = () => {
  loadEnvFile();
  return parseConfig(whatsappSchema);
};

export const loadWebConfig = () => {
  loadEnvFile();
  return parseConfig(webSchema);
};

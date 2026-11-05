import type { Database } from '@vca/database';
import { ValidationError } from '@vca/shared';
import { open, seal } from './secret-box';

/** The keys that can be set from the dashboard. */
export const SECRET_NAMES = ['AI_API_KEY', 'AG_STUDIO_LICENSE_KEY'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

export const isSecretName = (name: string): name is SecretName =>
  (SECRET_NAMES as readonly string[]).includes(name);

/** Keys go into HTTP headers: no spaces or control characters, so none can inject a header. */
const FORMATS: Record<SecretName, { pattern: RegExp; max: number; label: string }> = {
  AI_API_KEY: { pattern: /^[\x21-\x7e]+$/, max: 512, label: 'OpenAI API key' },
  AG_STUDIO_LICENSE_KEY: { pattern: /^[\x20-\x7e]+$/, max: 4096, label: 'AG Studio licence key' },
};

export type SecretSource = 'dashboard' | 'environment' | 'none';

export interface SecretStatus {
  name: SecretName;
  source: SecretSource;
  /** Saved but no longer readable: the master key changed, so it must be entered again. */
  unreadable: boolean;
  /** Last four characters. Never more. */
  hint: string | null;
  updatedAt: Date | null;
  updatedBy: string | null;
}

const lastFour = (value: string) => value.slice(-4);

type Env = Partial<Record<SecretName, string | undefined>>;

/**
 * API keys set from the dashboard, encrypted in the database. A saved key wins over the server's
 * environment; removing it falls back to the environment again, so existing deployments keep working
 * and a key can't be lost by mistake. The API runs as one process and every change goes through it,
 * so an in-memory copy refreshed on change is always current.
 */
export class AppSecretsService {
  private readonly values = new Map<SecretName, string>();

  constructor(
    private readonly db: Database,
    private readonly env: Env,
    private readonly master: string,
  ) {}

  /** The key in effect. */
  get(name: SecretName): string | undefined {
    return this.values.get(name) ?? this.env[name];
  }

  /** Loads saved keys. Call at startup and after any change. */
  async refresh(): Promise<void> {
    const rows = await this.db.appSecret.findMany();
    this.values.clear();
    for (const row of rows) {
      if (!isSecretName(row.name)) continue;
      const value = open(row.ciphertext, row.name, this.master);
      if (value !== null) this.values.set(row.name, value);
    }
  }

  async status(): Promise<SecretStatus[]> {
    const rows = await this.db.appSecret.findMany();
    return SECRET_NAMES.map((name) => {
      const row = rows.find((r) => r.name === name);
      const saved = row ? open(row.ciphertext, name, this.master) : null;
      const fallback = this.env[name];
      return {
        name,
        source: saved !== null ? 'dashboard' : fallback ? 'environment' : 'none',
        unreadable: !!row && saved === null,
        hint: saved !== null ? row!.hint : fallback ? lastFour(fallback) : null,
        updatedAt: saved !== null ? row!.updatedAt : null,
        updatedBy: saved !== null ? row!.updatedBy : null,
      };
    });
  }

  /** Checks a value before use. Messages never repeat the value. */
  normalize(name: SecretName, raw: string): string {
    const value = raw.trim();
    const { pattern, max, label } = FORMATS[name];
    if (!value) throw new ValidationError(`Enter the ${label}.`);
    if (value.length > max || !pattern.test(value))
      throw new ValidationError(`That doesn't look like a valid ${label}.`);
    return value;
  }

  async save(name: SecretName, value: string, by: string): Promise<void> {
    const data = {
      ciphertext: seal(value, name, this.master),
      hint: lastFour(value),
      updatedBy: by,
    };
    await this.db.appSecret.upsert({ where: { name }, create: { name, ...data }, update: data });
    await this.refresh();
  }

  async remove(name: SecretName): Promise<void> {
    await this.db.appSecret.deleteMany({ where: { name } });
    await this.refresh();
  }
}

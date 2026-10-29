import { AwsClient } from 'aws4fetch';
import { ProviderError } from '@vca/shared';

/** Where image bytes are kept. Keys are opaque paths chosen by the caller. */
export interface ObjectStore {
  readonly kind: 'R2';
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** The object's bytes, or null if it doesn't exist. */
  get(key: string): Promise<Buffer | null>;
  /** Deletes the object; deleting a missing object is not an error. */
  delete(key: string): Promise<void>;
}

export interface R2Options {
  accountId?: string | undefined;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Defaults to https://<accountId>.r2.cloudflarestorage.com (override for S3-compatible tests). */
  endpoint?: string | undefined;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const KEY = /^[A-Za-z0-9!_.*'()/-]{1,512}$/;

/**
 * Cloudflare R2 through its S3-compatible API (SigV4 via aws4fetch: a few KB instead of the AWS
 * SDK). The bucket stays private; credentials never leave the API server.
 */
export class R2ObjectStore implements ObjectStore {
  readonly kind = 'R2' as const;
  private readonly client: AwsClient;
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: R2Options) {
    const endpoint =
      options.endpoint ??
      (options.accountId ? `https://${options.accountId}.r2.cloudflarestorage.com` : undefined);
    if (!endpoint) throw new Error('R2 needs R2_ACCOUNT_ID (or R2_ENDPOINT)');
    this.base = `${endpoint.replace(/\/$/, '')}/${encodeURIComponent(options.bucket)}`;
    this.client = new AwsClient({
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      service: 's3',
      region: 'auto',
    });
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private url(key: string) {
    if (!KEY.test(key) || key.includes('..')) throw new Error(`Invalid object key '${key}'`);
    return `${this.base}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  private async send(method: string, key: string, init: RequestInit = {}) {
    const url = this.url(key); // invalid keys fail here, before any network call
    try {
      const signed = await this.client.sign(url, { method, ...init });
      return await this.fetchImpl(signed, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (cause) {
      throw new ProviderError('r2', `${method} failed`, { cause });
    }
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    const res = await this.send('PUT', key, {
      body,
      headers: {
        'content-type': contentType,
        'content-length': String(body.byteLength),
        // Keys are unique per upload, so the bytes behind a key never change.
        'cache-control': 'private, max-age=31536000, immutable',
      },
    });
    if (!res.ok) throw new ProviderError('r2', `PUT ${res.status}`);
  }

  async get(key: string): Promise<Buffer | null> {
    const res = await this.send('GET', key);
    if (res.status === 404) return null;
    if (!res.ok) throw new ProviderError('r2', `GET ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const res = await this.send('DELETE', key);
    if (!res.ok && res.status !== 404) throw new ProviderError('r2', `DELETE ${res.status}`);
  }
}

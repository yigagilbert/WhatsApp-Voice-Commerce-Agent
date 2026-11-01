import { describe, expect, it } from 'vitest';
import { HttpStatusPoster } from './status-poster';

const post = {
  botIds: ['256700000001@c.us'],
  media: { mimeType: 'image/jpeg' as const, dataBase64: '/9j/4AAQ' },
  caption: 'Fresh baskets',
};

const answering = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

const throwing = (error: unknown) =>
  (async () => {
    throw error;
  }) as unknown as typeof fetch;

describe('HttpStatusPoster', () => {
  it('sends the post with the internal token to /internal/status', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ posted: true, messageId: 'm1' }), { status: 202 });
    }) as unknown as typeof fetch;
    const result = await new HttpStatusPoster('http://worker:3001/', 'tok', fetchImpl).post(post);
    expect(result).toEqual({ outcome: 'posted', messageId: 'm1' });
    expect(seen!.url).toBe('http://worker:3001/internal/status');
    expect((seen!.init.headers as Record<string, string>)['x-internal-token']).toBe('tok');
    expect(JSON.parse(String(seen!.init.body))).toEqual(post);
  });

  it('reports a refusal from the worker as a failure with its reason', async () => {
    const poster = new HttpStatusPoster(
      'http://w',
      't',
      answering(409, { error: 'The connected WhatsApp number is not this shop’s number' }),
    );
    expect(await poster.post(post)).toEqual({
      outcome: 'failed',
      reason: 'The connected WhatsApp number is not this shop’s number',
    });
    const down = new HttpStatusPoster('http://w', 't', answering(503, {}));
    expect(await down.post(post)).toEqual({
      outcome: 'failed',
      reason: 'WhatsApp is not connected.',
    });
  });

  it('treats a refused connection as a failure, and no answer as an unknown outcome', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNREFUSED' },
    });
    expect(await new HttpStatusPoster('http://w', 't', throwing(refused)).post(post)).toMatchObject(
      { outcome: 'failed' },
    );
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    expect(await new HttpStatusPoster('http://w', 't', throwing(timeout)).post(post)).toMatchObject(
      { outcome: 'unknown' },
    );
  });
});

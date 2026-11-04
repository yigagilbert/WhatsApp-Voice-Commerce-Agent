import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { rateLimitOptions } from './rate-limit';

const TOKEN = 'test-dashboard-token-123456';

async function appWithLimit(max: number) {
  const app = Fastify();
  await app.register(rateLimit, { ...rateLimitOptions(TOKEN, max), timeWindow: '1 minute' });
  app.get('/', async () => ({ ok: true }));
  return app;
}

const hit = (app: Awaited<ReturnType<typeof appWithLimit>>, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url: '/', headers }).then((r) => r.statusCode);

const asUser = (user: string, token = TOKEN) => ({
  authorization: `Bearer ${token}`,
  'x-dashboard-user': user,
});

describe('rate limit keys', () => {
  it('gives each dashboard account its own allowance', async () => {
    const app = await appWithLimit(1);
    for (let i = 0; i < 5; i++) expect(await hit(app, asUser('owner'))).toBe(200);
    expect(await hit(app, asUser('owner'))).toBe(429);
    expect(await hit(app, asUser('staff'))).toBe(200);
  });

  it('ignores the user header without the dashboard token', async () => {
    const app = await appWithLimit(1);
    expect(await hit(app, asUser('a', 'wrong-token-000000000000'))).toBe(200);
    expect(await hit(app, asUser('b', 'wrong-token-000000000000'))).toBe(429);
    expect(await hit(app, { 'x-dashboard-user': 'c' })).toBe(429);
  });
});

import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { apiSchema } from '@vca/config';

const parseTrustProxy = (value: string) =>
  apiSchema.shape.TRUST_PROXY.parse(value) as boolean | string;

/** The client IP Fastify reports behind Nginx on a private Docker network. */
async function clientIp(trustProxy: boolean | string, forwardedFor: string) {
  const app = Fastify({ trustProxy });
  app.get('/', async (request) => ({ ip: request.ip }));
  const res = await app.inject({
    method: 'GET',
    url: '/',
    remoteAddress: '172.18.0.5', // the proxy container
    headers: { 'x-forwarded-for': forwardedFor },
  });
  await app.close();
  return (res.json() as { ip: string }).ip;
}

describe('TRUST_PROXY', () => {
  it('parses booleans (incl. legacy 1/0) and proxy address lists, and rejects hop counts', () => {
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('1')).toBe(true);
    expect(parseTrustProxy('0')).toBe(false);
    expect(parseTrustProxy('loopback,uniquelocal')).toBe('loopback,uniquelocal');
    expect(() => parseTrustProxy('2')).toThrow();
  });

  it('production setting: a spoofed X-Forwarded-For prefix cannot change the client IP', async () => {
    const production = parseTrustProxy('loopback,uniquelocal');
    // Nginx appends the real client (41.1.1.1) after whatever the client sent.
    expect(await clientIp(production, '9.9.9.9, 41.1.1.1')).toBe('41.1.1.1');
    expect(await clientIp(production, '10.0.0.7, 41.1.1.1')).toBe('41.1.1.1');
  });

  it('"true" would let the client choose its IP (why it is no longer used)', async () => {
    expect(await clientIp(true, '9.9.9.9, 41.1.1.1')).toBe('9.9.9.9');
  });
});

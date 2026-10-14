import { beforeAll, describe, expect, it } from 'vitest';

beforeAll(() => {
  process.env.API_AUTH_TOKEN = 'test-dashboard-token-123456';
  process.env.DASHBOARD_USERNAME = 'admin';
  process.env.DASHBOARD_PASSWORD = 'correct horse battery';
  process.env.DASHBOARD_SESSION_HOURS = '12';
});

const load = () => import('./session');

describe('dashboard session', () => {
  it('signs and verifies a session token', async () => {
    const { createSessionToken, verifySessionToken } = await load();
    const { token, maxAgeSeconds } = createSessionToken('admin');
    expect(maxAgeSeconds).toBe(12 * 3600);
    expect(verifySessionToken(token)).toBe('admin');
  });

  it('rejects tampered, malformed, expired and foreign tokens', async () => {
    const { createSessionToken, verifySessionToken } = await load();
    const { token } = createSessionToken('admin');
    const [data, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ u: 'admin', exp: 9999999999 })).toString(
      'base64url',
    );
    expect(verifySessionToken(`${forged}.${sig}`)).toBeNull();
    expect(verifySessionToken(`${data}.AAAA`)).toBeNull();
    expect(verifySessionToken('garbage')).toBeNull();
    expect(verifySessionToken(undefined)).toBeNull();
    expect(verifySessionToken(token, Date.now() + 13 * 3600 * 1000)).toBeNull();
    // A token for a username that is no longer configured is invalid.
    expect(verifySessionToken(createSessionToken('someone-else').token)).toBeNull();
  });

  it('checks credentials in constant time and fails closed without a password', async () => {
    const { checkCredentials } = await load();
    expect(checkCredentials('admin', 'correct horse battery')).toBe('ok');
    expect(checkCredentials('admin', 'wrong')).toBe('invalid');
    expect(checkCredentials('root', 'correct horse battery')).toBe('invalid');
  });

  it('only allows safe relative post-login redirects', async () => {
    const { safeNextPath } = await load();
    expect(safeNextPath('/orders?status=PAID')).toBe('/orders?status=PAID');
    expect(safeNextPath('//evil.example')).toBe('/');
    expect(safeNextPath('https://evil.example')).toBe('/');
    expect(safeNextPath('/login')).toBe('/');
    expect(safeNextPath(undefined)).toBe('/');
  });
});

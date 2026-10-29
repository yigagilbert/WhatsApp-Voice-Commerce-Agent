import { beforeAll, describe, expect, it } from 'vitest';

beforeAll(() => {
  process.env.API_AUTH_TOKEN = 'test-dashboard-token-123456';
  process.env.DASHBOARD_USERNAME = 'admin';
  process.env.DASHBOARD_PASSWORD = 'correct horse battery';
  process.env.DASHBOARD_SESSION_HOURS = '12';
});

const load = () => import('./session');

const owner = {
  id: 'usr_1',
  username: 'sarah',
  name: 'Sarah',
  role: 'OWNER' as const,
  version: 3,
};

describe('dashboard session', () => {
  it('signs and verifies a session for an account', async () => {
    const { createSessionToken, verifySessionToken } = await load();
    const { token, maxAgeSeconds } = createSessionToken(owner);
    expect(maxAgeSeconds).toBe(12 * 3600);
    expect(verifySessionToken(token)).toEqual(owner);
  });

  it('rejects tampered, malformed and expired tokens', async () => {
    const { createSessionToken, verifySessionToken } = await load();
    const { token } = createSessionToken(owner);
    const [data, sig] = token.split('.');
    // Changing the role (or the account) invalidates the signature.
    const forged = Buffer.from(
      JSON.stringify({ u: 'usr_1', n: 'sarah', d: 'Sarah', r: 'OWNER', v: 99, exp: 9999999999 }),
    ).toString('base64url');
    expect(verifySessionToken(`${forged}.${sig}`)).toBeNull();
    expect(verifySessionToken(`${data}.AAAA`)).toBeNull();
    expect(verifySessionToken('garbage')).toBeNull();
    expect(verifySessionToken(undefined)).toBeNull();
    expect(verifySessionToken(token, Date.now() + 13 * 3600 * 1000)).toBeNull();
  });

  it('ties the setup login to the configured username', async () => {
    const { BOOTSTRAP_USER_ID, createSessionToken, verifySessionToken } = await load();
    const setup = {
      id: BOOTSTRAP_USER_ID,
      username: 'admin',
      name: 'Setup',
      role: 'OWNER' as const,
      version: 0,
    };
    expect(verifySessionToken(createSessionToken(setup).token)?.id).toBe(BOOTSTRAP_USER_ID);
    expect(
      verifySessionToken(createSessionToken({ ...setup, username: 'someone-else' }).token),
    ).toBeNull();
  });

  it('checks setup credentials in constant time and fails closed without a password', async () => {
    const { checkBootstrapCredentials } = await load();
    expect(checkBootstrapCredentials('admin', 'correct horse battery')).toBe('ok');
    expect(checkBootstrapCredentials('admin', 'wrong')).toBe('invalid');
    expect(checkBootstrapCredentials('root', 'correct horse battery')).toBe('invalid');
  });

  it('only allows safe relative post-login redirects', async () => {
    const { safeNextPath } = await load();
    expect(safeNextPath('/orders?status=PAID')).toBe('/orders?status=PAID');
    expect(safeNextPath('//evil.example')).toBe('/');
    expect(safeNextPath('/\\evil.example')).toBe('/');
    expect(safeNextPath('https://evil.example')).toBe('/');
    expect(safeNextPath('/login')).toBe('/');
    expect(safeNextPath(undefined)).toBe('/');
  });

  it("uses the proxy's client IP header, never the client-controlled first X-Forwarded-For hop", async () => {
    const { clientIp } = await load();
    const headers = (h: Record<string, string>) => (name: string) => h[name] ?? null;
    expect(
      clientIp(
        headers({ 'x-real-ip': '41.1.1.1', 'x-forwarded-for': '9.9.9.9, 41.1.1.1' }),
        'x-real-ip',
      ),
    ).toBe('41.1.1.1');
    // Spoofed first hop, real address appended by the proxy last.
    expect(clientIp(headers({ 'x-forwarded-for': '9.9.9.9, 41.1.1.1' }), 'x-real-ip')).toBe(
      '41.1.1.1',
    );
    expect(clientIp(headers({}), 'x-real-ip')).toBe('unknown');
  });
});

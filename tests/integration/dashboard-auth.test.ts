/**
 * Dashboard accounts and API authorization, against a real Postgres: the setup login only while no
 * account exists, per-account lockout, session revocation (password change, deactivation, role
 * change), owner-only routes, last-owner protection, and merchant isolation by account.
 *
 * Creates dashboard accounts, so it removes them again in afterAll: other suites rely on the
 * setup (no-accounts) mode.
 *
 * Run: pnpm test:integration
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { apiSchema, loadEnvFile, parseConfig } from '@vca/config';
import { createLogger } from '@vca/shared';
import { buildApp } from '../../apps/api/src/app';
import { createContainer, type Container } from '../../apps/api/src/container';
import { ChannelRegistry } from '../../apps/api/src/modules/notifications/channel-registry';
import { FakePayPal, testEnv } from '../support/fakes';

loadEnvFile();

const run = randomUUID().slice(0, 8);
const shop = `au_shop_${run}`;
const otherShop = `au_other_${run}`;
const token = { authorization: 'Bearer test-dashboard-token-123456' };
const OWNER_PASSWORD = 'owner passphrase 2026';
const STAFF_PASSWORD = 'staff passphrase 2026';

describe('dashboard accounts and authorization (integration)', () => {
  let container: Container;
  let app: FastifyInstance;
  let ownerId: string;
  let staffId: string;
  const sessions: Record<string, { id: string; version: number }> = {};

  const as = (who: { id: string; version: number }) => ({
    ...token,
    'x-dashboard-user': who.id,
    'x-dashboard-session': String(who.version),
  });
  const login = (username: string, password: string) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: token,
      payload: { username, password },
    });
  const signIn = async (username: string, password: string) => {
    const res = await login(username, password);
    expect(res.statusCode).toBe(200);
    const user = res.json().user as { id: string; sessionVersion: number };
    return { id: user.id, version: user.sessionVersion };
  };

  beforeAll(async () => {
    container = createContainer(
      parseConfig(apiSchema, testEnv()),
      createLogger({ name: 'it-auth', level: 'silent' }),
      {
        paypal: new FakePayPal(`AU-${run}`),
        chatModel: null,
        speech: null,
        channels: new ChannelRegistry(),
      },
    );
    app = await buildApp(container);
    // Other suites leave no accounts behind; this suite needs the same starting point.
    expect(await container.dashboardUsers.count()).toBe(0);
    for (const [id, name] of [
      [shop, 'Auth Shop'],
      [otherShop, 'Other Auth Shop'],
    ] as const)
      await container.db.merchant.create({
        data: { id, businessName: name, ownerName: 'Owner', preferredCurrency: 'USD' },
      });
    await container.db.customer.create({
      data: { merchantId: otherShop, name: 'Hidden Customer' },
    });
  });

  afterAll(async () => {
    await container.db.dashboardUser.deleteMany({
      where: { merchantId: { in: [shop, otherShop] } },
    });
    await container.db.merchant.deleteMany({ where: { id: { in: [shop, otherShop] } } });
    await app.close();
    await container.close();
  });

  describe('setup mode (no accounts yet)', () => {
    it('reports that no accounts exist, so the dashboard can use the setup login', async () => {
      const res = await login('anyone', 'whatever password');
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('NO_ACCOUNTS');
    });

    it('requires the first account to be an owner', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/dashboard-users',
        headers: { ...token, 'x-merchant-id': shop },
        payload: { username: 'early', name: 'Early', role: 'STAFF', password: STAFF_PASSWORD },
      });
      expect(res.statusCode).toBe(409);
    });

    it('rejects weak passwords', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/dashboard-users',
        headers: { ...token, 'x-merchant-id': shop },
        payload: { username: `own-${run}`, name: 'Owner', role: 'OWNER', password: 'short' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('creates the first owner, after which the setup mode ends', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/dashboard-users',
        headers: { ...token, 'x-merchant-id': shop },
        payload: {
          username: `Own-${run}`,
          name: 'Olivia Owner',
          role: 'OWNER',
          password: OWNER_PASSWORD,
        },
      });
      expect(res.statusCode).toBe(201);
      const user = res.json();
      expect(user).not.toHaveProperty('passwordHash');
      expect(user.username).toBe(`own-${run}`);
      ownerId = user.id;

      const setup = await app.inject({ method: 'GET', url: '/api/orders', headers: token });
      expect(setup.statusCode).toBe(401);
    });
  });

  describe('sign-in', () => {
    it('signs in (case-insensitive username) and scopes data to the account’s merchant', async () => {
      sessions.owner = await signIn(`OWN-${run}`, OWNER_PASSWORD);
      expect(sessions.owner.id).toBe(ownerId);
      const me = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        // x-merchant-id can't move an account to another merchant.
        headers: { ...as(sessions.owner), 'x-merchant-id': otherShop },
      });
      expect(me.json()).toMatchObject({ user: { role: 'OWNER' }, merchant: { id: shop } });
      const customers = await app.inject({
        method: 'GET',
        url: '/api/customers',
        headers: { ...as(sessions.owner), 'x-merchant-id': otherShop },
      });
      expect(JSON.stringify(customers.json())).not.toContain('Hidden Customer');
    });

    it('rejects forged or stale session headers', async () => {
      for (const headers of [
        as({ id: ownerId, version: sessions.owner!.version + 1 }),
        as({ id: 'usr_does_not_exist', version: 1 }),
        { ...token, 'x-dashboard-user': ownerId, 'x-dashboard-session': 'abc' },
        { 'x-dashboard-user': ownerId, 'x-dashboard-session': String(sessions.owner!.version) },
      ]) {
        const res = await app.inject({ method: 'GET', url: '/api/orders', headers });
        expect(res.statusCode).toBe(401);
      }
    });

    it('gives the same answer for unknown users and wrong passwords', async () => {
      const unknown = await login('nobody-here', 'some password 123');
      const wrong = await login(`own-${run}`, 'not the password');
      expect(unknown.statusCode).toBe(401);
      expect(wrong.statusCode).toBe(401);
      expect(unknown.json().error.message).toBe(wrong.json().error.message);
    });
  });

  describe('roles', () => {
    beforeAll(async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/dashboard-users',
        headers: as(sessions.owner!),
        payload: {
          username: `staff-${run}`,
          name: 'Sam Staff',
          role: 'STAFF',
          password: STAFF_PASSWORD,
        },
      });
      expect(res.statusCode).toBe(201);
      staffId = res.json().id;
      sessions.staff = await signIn(`staff-${run}`, STAFF_PASSWORD);
    });

    it('lets staff do day-to-day work but not owner-only changes', async () => {
      const staff = as(sessions.staff!);
      expect(
        (await app.inject({ method: 'GET', url: '/api/orders', headers: staff })).statusCode,
      ).toBe(200);
      for (const [method, url] of [
        ['GET', '/api/dashboard-users'],
        ['POST', '/api/dashboard-users'],
        ['POST', '/api/admins'],
        ['PUT', '/api/reports/schedule'],
        ['POST', '/api/whatsapp/session/logout'],
        ['POST', '/api/whatsapp/account/connect'],
      ] as const) {
        const res = await app.inject({ method, url, headers: staff, payload: {} });
        expect(res.statusCode, `${method} ${url}`).toBe(403);
      }
    });

    it('protects the last active owner', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/dashboard-users/${ownerId}`,
        headers: as(sessions.owner!),
        payload: { role: 'STAFF' },
      });
      expect(res.statusCode).toBe(409);
    });
  });

  describe('revocation', () => {
    it('ends other sessions when a password changes', async () => {
      const second = await signIn(`staff-${run}`, STAFF_PASSWORD);
      const changed = await app.inject({
        method: 'POST',
        url: '/api/auth/password',
        headers: as(second),
        payload: { current: STAFF_PASSWORD, next: 'a brand new staff phrase' },
      });
      expect(changed.statusCode).toBe(200);
      const version = changed.json().sessionVersion as number;
      expect(version).toBeGreaterThan(second.version);
      expect(
        (await app.inject({ method: 'GET', url: '/api/orders', headers: as(sessions.staff!) }))
          .statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/api/orders',
            headers: as({ id: staffId, version }),
          })
        ).statusCode,
      ).toBe(200);
      sessions.staff = { id: staffId, version };
    });

    it('signs out and blocks a deactivated account', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/dashboard-users/${staffId}`,
        headers: as(sessions.owner!),
        payload: { active: false },
      });
      expect(res.statusCode).toBe(200);
      expect(
        (await app.inject({ method: 'GET', url: '/api/orders', headers: as(sessions.staff!) }))
          .statusCode,
      ).toBe(401);
      expect((await login(`staff-${run}`, 'a brand new staff phrase')).statusCode).toBe(401);
    });
  });

  describe('lockout', () => {
    it('locks an account after 5 wrong passwords, whatever the caller', async () => {
      for (let i = 0; i < 5; i++) await login(`own-${run}`, `wrong guess ${i}`);
      // Even the right password is refused while locked.
      expect((await login(`own-${run}`, OWNER_PASSWORD)).statusCode).toBe(401);
      const user = await container.db.dashboardUser.findUniqueOrThrow({ where: { id: ownerId } });
      expect(user.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
      const events = await container.db.auditEvent.findMany({
        where: { entityId: ownerId, type: { startsWith: 'auth.' } },
      });
      expect(events.map((e) => e.type)).toContain('auth.account_locked');
      // Audit records never contain passwords.
      expect(JSON.stringify(events)).not.toContain('wrong guess');
      expect(JSON.stringify(events)).not.toContain(OWNER_PASSWORD);

      await container.db.dashboardUser.update({
        where: { id: ownerId },
        data: { lockedUntil: null },
      });
      expect((await login(`own-${run}`, OWNER_PASSWORD)).statusCode).toBe(200);
    });
  });
});

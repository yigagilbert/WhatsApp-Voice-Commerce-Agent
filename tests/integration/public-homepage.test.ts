/**
 * The public homepage's WhatsApp number, against a real Postgres and a stand-in WhatsApp gateway:
 *   - nothing is published until an owner lists the linked bot's number AND customers can shop on
 *     it (server flag and the number's own setting);
 *   - the endpoint returns only the digits, never IDs or settings, and needs no credentials;
 *   - a number that is no longer the linked bot, or that the owner unlists, is withdrawn at once.
 * (Saving the setting is owner-only like every other WhatsApp account change.)
 *
 * Run: pnpm test:integration
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { apiSchema, loadEnvFile, parseConfig } from '@vca/config';
import { createLogger } from '@vca/shared';
import { buildApp } from '../../apps/api/src/app';
import { createContainer, type Container } from '../../apps/api/src/container';
import { forgetPublicNumber } from '../../apps/api/src/modules/public/public.routes';
import { FakePayPal, testEnv } from '../support/fakes';

loadEnvFile();

const run = randomUUID().slice(0, 8);
const digits = run.replace(/\D/g, '').padEnd(6, '7').slice(0, 6);
const shop = `ph_shop_${run}`;
const bot = `25670${digits}9@c.us`;
const headers = { authorization: 'Bearer test-dashboard-token-123456', 'x-merchant-id': shop };

describe('public homepage WhatsApp number (integration)', () => {
  let container: Container;
  let app: FastifyInstance;
  let gateway: Server;
  let linked: string | null = bot;
  let accountId: string;

  const publicNumber = async () => {
    const res = await app.inject({ method: 'GET', url: '/api/public/whatsapp' });
    expect(res.statusCode).toBe(200);
    return res.json() as { available: boolean; phone?: string };
  };
  const save = (payload: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url: `/api/whatsapp/account/${accountId}`, headers, payload });

  beforeAll(async () => {
    gateway = createServer((req, res) => {
      res.writeHead(req.url === '/internal/session' ? 200 : 404, {
        'content-type': 'application/json',
      });
      res.end(JSON.stringify({ state: 'ready', botId: linked }));
    });
    await new Promise<void>((done) => gateway.listen(0, '127.0.0.1', done));
    const { port } = gateway.address() as AddressInfo;
    container = createContainer(
      parseConfig(
        apiSchema,
        testEnv({
          CUSTOMER_COMMERCE_ENABLED: 'true',
          WHATSAPP_GATEWAY_URL: `http://127.0.0.1:${port}`,
        }),
      ),
      createLogger({ name: 'it-public', level: 'silent' }),
      { paypal: new FakePayPal(`PH-${run}`), chatModel: null, speech: null },
    );
    app = await buildApp(container);
    await container.db.merchant.create({
      data: { id: shop, businessName: 'Homepage Shop', ownerName: 'Owner' },
    });
    const account = await container.db.whatsAppAccount.create({
      data: { merchantId: shop, wid: bot },
    });
    accountId = account.id;
    forgetPublicNumber();
  });

  afterAll(async () => {
    await container.db.merchant.deleteMany({ where: { id: shop } });
    await app.close();
    await container.close();
    await new Promise((done) => gateway.close(done));
  });

  it('publishes nothing until the owner lists the number', async () => {
    expect(await publicNumber()).toEqual({ available: false });
  });

  it('needs customer shopping on before the number is shown', async () => {
    const listed = await save({ listedOnHomepage: true });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ listedOnHomepage: true });
    expect(await publicNumber()).toEqual({ available: false });

    expect((await save({ customerCommerceEnabled: true })).statusCode).toBe(200);
    expect(await publicNumber()).toEqual({ available: true, phone: bot.split('@')[0] });

    const settings = await app.inject({ method: 'GET', url: '/api/whatsapp/account', headers });
    expect(settings.json().accounts[0]).toMatchObject({ listedOnHomepage: true });
  });

  it('withdraws the number when another phone is linked, and when the owner unlists it', async () => {
    linked = `25670${digits}8@c.us`;
    forgetPublicNumber();
    expect(await publicNumber()).toEqual({ available: false });

    linked = bot;
    forgetPublicNumber();
    expect((await publicNumber()).available).toBe(true);

    expect((await save({ listedOnHomepage: false })).statusCode).toBe(200);
    expect(await publicNumber()).toEqual({ available: false });
  });

  it('records the change in the audit log', async () => {
    const events = await container.db.auditEvent.findMany({
      where: { merchantId: shop, type: 'whatsapp.account_updated' },
    });
    expect(events.some((e) => (e.data as { listedOnHomepage?: boolean }).listedOnHomepage)).toBe(
      true,
    );
  });
});

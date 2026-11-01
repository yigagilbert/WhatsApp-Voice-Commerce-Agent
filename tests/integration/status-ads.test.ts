/**
 * WhatsApp Status adverts against a real Postgres: eligibility (in stock, visible, with a photo),
 * guarded AI copy with template fallback, rotation, image rendering from the live catalogue,
 * approval and posting records, scheduling without duplicates, retries, merchant isolation,
 * owner/staff permissions, the feature flag, and that nothing is ever sent on WhatsApp.
 *
 * Run: pnpm test:integration
 */
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { apiSchema, loadEnvFile, parseConfig } from '@vca/config';
import { createLogger, type ChannelSender, type OutboundChannelMessage } from '@vca/shared';
import { buildApp } from '../../apps/api/src/app';
import { createContainer, type Container } from '../../apps/api/src/container';
import { ChannelRegistry } from '../../apps/api/src/modules/notifications/channel-registry';
import { FakePayPal, ScriptedChatModel, testEnv } from '../support/fakes';

loadEnvFile();

const run = randomUUID().slice(0, 8);
const shop = `sa_shop_${run}`;
const otherShop = `sa_other_${run}`;
const PASSWORD = 'status adverts passphrase 2026';

/** Records anything sent on WhatsApp: this feature must never send. */
class RecordingSender implements ChannelSender {
  readonly channel = 'whatsapp' as const;
  readonly sent: OutboundChannelMessage[] = [];
  async send(message: OutboundChannelMessage) {
    this.sent.push(message);
  }
}

const jpeg = (color: string) =>
  sharp({ create: { width: 900, height: 700, channels: 3, background: color } })
    .jpeg()
    .toBuffer();

const reply = (content: string) => () => ({ role: 'assistant' as const, content });

describe('WhatsApp Status adverts (integration)', () => {
  const sender = new RecordingSender();
  const model = new ScriptedChatModel([]);
  let container: Container;
  let app: FastifyInstance;
  const sessions: Record<'owner' | 'staff' | 'other', Record<string, string>> = {
    owner: {},
    staff: {},
    other: {},
  };
  const ids: Record<string, string> = {};

  const api = (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT',
    url: string,
    payload?: Record<string, unknown>,
    who: keyof typeof sessions = 'owner',
  ) =>
    app.inject({
      method,
      url,
      headers: { authorization: 'Bearer test-dashboard-token-123456', ...sessions[who] },
      ...(payload !== undefined ? { payload } : {}),
    });

  const settings = (overrides: Record<string, unknown> = {}) => ({
    enabled: true,
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    times: ['09:00'],
    timezone: null,
    approval: 'MANUAL',
    productIds: [],
    ...overrides,
  });

  beforeAll(async () => {
    container = createContainer(
      parseConfig(apiSchema, testEnv({ STATUS_ADS_ENABLED: 'true' })),
      createLogger({ name: 'it-status', level: 'silent' }),
      {
        paypal: new FakePayPal(`SA-${run}`),
        chatModel: model,
        speech: null,
        channels: new ChannelRegistry().register(sender),
        objectStore: null,
      },
    );
    app = await buildApp(container);
    for (const [id, name] of [
      [shop, 'Status Shop'],
      [otherShop, 'Other Status Shop'],
    ] as const)
      await container.db.merchant.create({
        data: { id, businessName: name, ownerName: 'Owner', preferredCurrency: 'USD' },
      });
    for (const [key, merchantId, role] of [
      ['owner', shop, 'OWNER'],
      ['staff', shop, 'STAFF'],
      ['other', otherShop, 'OWNER'],
    ] as const) {
      const user = await container.dashboardUsers.create(
        merchantId,
        { username: `sa-${key}-${run}`, name: key, role, password: PASSWORD },
        'test',
      );
      const row = await container.db.dashboardUser.findUniqueOrThrow({ where: { id: user.id } });
      sessions[key] = {
        'x-dashboard-user': row.id,
        'x-dashboard-session': String(row.sessionVersion),
      };
    }
    const products: [string, Record<string, unknown>, string | null][] = [
      ['tote', { name: 'Woven Tote', unitPriceMinor: 1850, stockQuantity: 10 }, '#aa7744'],
      ['mug', { name: 'Clay Mug', unitPriceMinor: 600, stockQuantity: null }, '#335577'],
      ['bowl', { name: 'Wooden Bowl', unitPriceMinor: 900, stockQuantity: 0 }, '#775533'],
      [
        'vase',
        { name: 'Glass Vase', unitPriceMinor: 2500, stockQuantity: 4, visibleToCustomers: false },
        '#557733',
      ],
      ['spoon', { name: 'Wooden Spoon', unitPriceMinor: 300, stockQuantity: 9 }, null],
    ];
    for (const [key, data, color] of products) {
      const product = await container.db.product.create({
        data: {
          merchantId: shop,
          currency: 'USD',
          description: `${data.name as string} from our workshop. Sturdy and simple.`,
          ...data,
        } as never,
      });
      ids[key] = product.id;
      if (color) await container.productImages.save(shop, product.id, await jpeg(color), 'test');
    }
    const foreign = await container.db.product.create({
      data: { merchantId: otherShop, name: 'Foreign Hat', unitPriceMinor: 100, currency: 'USD' },
    });
    ids.foreign = foreign.id;
  });

  afterAll(async () => {
    await container.db.merchant.deleteMany({ where: { id: { in: [shop, otherShop] } } });
    await app.close();
    await container.close();
  });

  it('lists only in-stock, visible products with a photo as eligible', async () => {
    const res = await api('GET', '/api/status-ads/settings');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ enabled: false, approval: 'MANUAL', times: ['09:00'] });
    const eligible = body.products
      .filter((p: { eligible: boolean }) => p.eligible)
      .map((p: { name: string }) => p.name);
    expect(eligible.sort()).toEqual(['Clay Mug', 'Woven Tote']);
  });

  let first: { id: string; productId: string };
  it('generates a draft; AI copy with an invented discount falls back to a template', async () => {
    model.enqueue(reply('{"headline":"50% off today","caption":"Huge sale! Message us to order"}'));
    const res = await api('POST', '/api/status-ads/generate', {}, 'staff');
    expect(res.statusCode).toBe(201);
    first = res.json();
    expect(res.json()).toMatchObject({ status: 'DRAFT', source: 'template', attempts: 1 });
    expect([ids.tote, ids.mug]).toContain(first.productId);
    expect(res.json().caption).not.toMatch(/\d|%|sale|off/i);
  });

  it('rotates to another product and uses guarded AI copy', async () => {
    model.enqueue(
      reply(
        '{"headline":"Made for busy mornings","caption":"Simple and sturdy. Chat with us to see more"}',
      ),
    );
    const res = await api('POST', '/api/status-ads/generate', {});
    expect(res.statusCode).toBe(201);
    expect(res.json().productId).not.toBe(first.productId);
    expect(res.json()).toMatchObject({ source: 'ai', headline: 'Made for busy mornings' });
    // The model saw only the product's name and description, never the price.
    const request = JSON.stringify(model.requests.at(-1));
    expect(request).not.toMatch(/18\.50|1850|600/);
  });

  it('renders a 1080 × 1920 image from the live catalogue', async () => {
    const res = await api('GET', `/api/status-ads/${first.id}/image`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    const meta = await sharp(res.rawPayload).metadata();
    expect(meta).toMatchObject({ width: 1080, height: 1920 });
  });

  it('edits, approves and records a post; an edit in manual mode needs approval again', async () => {
    const edit = {
      headline: 'Take a closer look',
      caption: 'Our tote. Message us to order 💬',
      cta: 'Message us to order',
      theme: 2,
    };
    expect((await api('POST', `/api/status-ads/${first.id}/posted`)).statusCode).toBe(409);
    expect((await api('POST', `/api/status-ads/${first.id}/approve`)).json().status).toBe('READY');
    const edited = await api('PATCH', `/api/status-ads/${first.id}`, edit, 'staff');
    expect(edited.json()).toMatchObject({ status: 'DRAFT', source: 'edited', theme: 2 });
    expect(
      (await api('PATCH', `/api/status-ads/${first.id}`, { ...edit, cta: 'Buy 2 get 1 free' }))
        .statusCode,
    ).toBe(400);
    await api('POST', `/api/status-ads/${first.id}/approve`, {}, 'staff');
    const posted = await api('POST', `/api/status-ads/${first.id}/posted`);
    expect(posted.json()).toMatchObject({ status: 'POSTED' });
    expect(posted.json().postedBy).toContain('sa-owner');
    const audit = await container.db.auditEvent.findMany({
      where: { merchantId: shop, entityId: first.id },
      select: { type: true },
    });
    expect(audit.map((a) => a.type)).toEqual(
      expect.arrayContaining(['status_ad.prepared', 'status_ad.ready', 'status_ad.posted']),
    );
  });

  it('refuses an advert whose product went out of stock or was hidden', async () => {
    model.enqueue(reply('not json'));
    const ad = (await api('POST', '/api/status-ads/generate', {})).json();
    const product = ad.productId as string;
    await container.db.product.update({
      where: { id: product },
      data: product === ids.mug ? { visibleToCustomers: false } : { stockQuantity: 0 },
    });
    const approve = await api('POST', `/api/status-ads/${ad.id}/approve`);
    expect(approve.statusCode).toBe(409);
    expect((await api('GET', `/api/status-ads/${ad.id}/image`)).statusCode).toBe(409);
    await api('POST', `/api/status-ads/${ad.id}/skip`);
    await container.db.product.update({
      where: { id: product },
      data: { visibleToCustomers: true, stockQuantity: product === ids.mug ? null : 10 },
    });
  });

  it('keeps merchants apart and limits settings to owners', async () => {
    expect(
      (await api('GET', `/api/status-ads/${first.id}/image`, undefined, 'other')).statusCode,
    ).toBe(404);
    expect((await api('POST', `/api/status-ads/${first.id}/skip`, {}, 'other')).statusCode).toBe(
      404,
    );
    expect((await api('GET', '/api/status-ads', undefined, 'other')).json()).toEqual([]);
    expect(
      (await api('PUT', '/api/status-ads/settings', settings({ productIds: [ids.foreign] })))
        .statusCode,
    ).toBe(400);
    expect((await api('PUT', '/api/status-ads/settings', settings(), 'staff')).statusCode).toBe(
      403,
    );
    expect(
      (
        await api(
          'PUT',
          '/api/status-ads/settings',
          settings({ times: ['08:00', '12:00', '15:00', '18:00'] }),
        )
      ).statusCode,
    ).toBe(400);
  });

  it('prepares each scheduled slot once, fails clearly with nothing eligible, and retries', async () => {
    const res = await api('PUT', '/api/status-ads/settings', settings({ productIds: [ids.bowl] }));
    expect(res.statusCode).toBe(200);
    // Monday 2 Nov 2026, 09:30 in Kampala (UTC+3): the 09:00 slot is due.
    const now = new Date('2026-11-02T06:30:00Z');
    await container.statusAds.tick(now);
    await container.statusAds.tick(now);
    await container.statusAds.tick(new Date(now.getTime() + 60_000));
    const slot = await container.db.statusAd.findMany({
      where: { merchantId: shop, trigger: 'SCHEDULED' },
    });
    expect(slot).toHaveLength(1);
    expect(slot[0]).toMatchObject({
      slotKey: 'SLOT:2026-11-02T09:00',
      status: 'FAILED',
      attempts: 1,
      productId: null,
    });
    expect(slot[0]!.lastError).toMatch(/None of the chosen products/);
    // Automatic retry after 5 minutes, still nothing eligible.
    await container.statusAds.tick(new Date(now.getTime() + 6 * 60_000));
    expect(
      (await container.db.statusAd.findUniqueOrThrow({ where: { id: slot[0]!.id } })).attempts,
    ).toBe(2);
    // Restocked: the dashboard's Retry prepares it.
    await container.db.product.update({ where: { id: ids.bowl }, data: { stockQuantity: 3 } });
    model.enqueue(reply('{"headline":"Organic goodness","caption":"Message us to order"}'));
    const retried = await api('POST', `/api/status-ads/${slot[0]!.id}/retry`);
    expect(retried.json()).toMatchObject({
      status: 'DRAFT',
      productId: ids.bowl,
      source: 'template', // "Organic" is a claim the shop never made
      lastError: null,
    });
    // A slot long past (API down all day) is not prepared late.
    await container.statusAds.tick(new Date('2026-11-03T12:00:00Z'));
    expect(
      await container.db.statusAd.count({ where: { merchantId: shop, trigger: 'SCHEDULED' } }),
    ).toBe(1);
  });

  it('skips days that are switched off, and auto-approval makes adverts ready', async () => {
    await api(
      'PUT',
      '/api/status-ads/settings',
      settings({ weekdays: [3], approval: 'AUTO', times: ['09:00', '17:30'] }),
    );
    // Tuesday 3 Nov: off.
    await container.statusAds.tick(new Date('2026-11-03T06:10:00Z'));
    // Wednesday 4 Nov, 17:40 local: the 17:30 slot.
    model.enqueue(reply('{}'));
    await container.statusAds.tick(new Date('2026-11-04T14:40:00Z'));
    const scheduled = await container.db.statusAd.findMany({
      where: { merchantId: shop, trigger: 'SCHEDULED' },
      orderBy: { createdAt: 'asc' },
    });
    expect(scheduled.map((a) => a.slotKey)).toEqual([
      'SLOT:2026-11-02T09:00',
      'SLOT:2026-11-04T17:30',
    ]);
    expect(scheduled[1]).toMatchObject({ status: 'READY', approvedBy: 'auto' });
    const view = (await api('GET', '/api/status-ads/settings')).json();
    expect(view.enabled).toBe(true);
    expect(view.nextAt).toBeTruthy();
  });

  it('never promoted an ineligible product and never sent anything on WhatsApp', async () => {
    const ads = await container.db.statusAd.findMany({
      where: { merchantId: shop, productId: { not: null } },
    });
    expect(ads.some((a) => a.productId === ids.vase || a.productId === ids.spoon)).toBe(false);
    expect(sender.sent).toEqual([]);
  });

  it('does not exist while STATUS_ADS_ENABLED is off', async () => {
    const off = createContainer(
      parseConfig(apiSchema, testEnv()),
      createLogger({ name: 'it-status-off', level: 'silent' }),
      { paypal: new FakePayPal(`SA-OFF-${run}`), chatModel: null, speech: null, objectStore: null },
    );
    const offApp = await buildApp(off);
    try {
      const res = await offApp.inject({
        method: 'GET',
        url: '/api/status-ads/settings',
        headers: { authorization: 'Bearer test-dashboard-token-123456', ...sessions.owner },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await offApp.close();
      await off.close();
    }
  });
});

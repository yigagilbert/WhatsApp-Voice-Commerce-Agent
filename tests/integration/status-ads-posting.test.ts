/**
 * Katale posting Status adverts to the shop number's own Status, against a real Postgres: the
 * shop's number is checked, posts are claimed so they never go out twice, failures leave the
 * advert ready for the phone with automatic retries, unknown outcomes are never retried, the
 * daily limit, the scheduler's auto-post, the server switch, and that customers get nothing.
 *
 * The WhatsApp worker is replaced by a scripted poster; its own checks are unit-tested in
 * apps/whatsapp. Run: pnpm test:integration
 */
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { apiSchema, loadEnvFile, parseConfig } from '@vca/config';
import {
  createLogger,
  type ChannelSender,
  type OutboundChannelMessage,
  type StatusPost,
} from '@vca/shared';
import { buildApp } from '../../apps/api/src/app';
import { createContainer, type Container } from '../../apps/api/src/container';
import { ChannelRegistry } from '../../apps/api/src/modules/notifications/channel-registry';
import {
  KATALE_DAILY_LIMIT,
  MAX_PUBLISH_ATTEMPTS,
} from '../../apps/api/src/modules/status-ads/status-ad.service';
import type {
  StatusPoster,
  StatusPostResult,
} from '../../apps/api/src/modules/status-ads/status-poster';
import { FakePayPal, testEnv } from '../support/fakes';

loadEnvFile();

const run = randomUUID().slice(0, 8);
const shop = `sp_shop_${run}`;
const otherShop = `sp_other_${run}`;
const WID = `2567${run.replace(/\D/g, '1').padEnd(8, '1').slice(0, 8)}@c.us`;
const OTHER_WID = `2567${run.replace(/\D/g, '2').padEnd(8, '2').slice(0, 8)}@c.us`;
const PASSWORD = 'status posting passphrase 2026';

class RecordingSender implements ChannelSender {
  readonly channel = 'whatsapp' as const;
  readonly sent: OutboundChannelMessage[] = [];
  async send(message: OutboundChannelMessage) {
    this.sent.push(message);
  }
}

/** Stands in for the WhatsApp worker: records posts, answers from a script (default: posted). */
class ScriptedPoster implements StatusPoster {
  readonly posts: StatusPost[] = [];
  readonly next: StatusPostResult[] = [];
  async post(post: StatusPost): Promise<StatusPostResult> {
    this.posts.push(post);
    return (
      this.next.shift() ?? {
        outcome: 'posted',
        messageId: `true_status@broadcast_${this.posts.length}`,
      }
    );
  }
}

describe('Katale posting Status adverts (integration)', () => {
  const sender = new RecordingSender();
  const poster = new ScriptedPoster();
  let container: Container;
  let app: FastifyInstance;
  const sessions: Record<'owner' | 'staff' | 'other', Record<string, string>> = {
    owner: {},
    staff: {},
    other: {},
  };

  const api = (
    method: 'GET' | 'POST' | 'PUT',
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
    enabled: false,
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    times: ['09:00'],
    timezone: null,
    approval: 'AUTO',
    publish: 'PHONE',
    productIds: [],
    ...overrides,
  });

  /** A schedule whose only slot is ~12 hours from the real clock, so real-time ticks prepare nothing. */
  const quiet = () => ({
    times: [`${String((new Date().getUTCHours() + 12) % 24).padStart(2, '0')}:00`],
    timezone: 'UTC',
  });

  /** A ready advert (auto-approval), made directly so the route's rate limit isn't spent. */
  const readyAd = async () => {
    const merchant = await container.db.merchant.findUniqueOrThrow({ where: { id: shop } });
    const ad = await container.statusAds.generateNow(merchant, 'test');
    expect(ad.status).toBe('READY');
    return ad;
  };
  const reload = (id: string) => container.db.statusAd.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    container = createContainer(
      parseConfig(apiSchema, testEnv({ STATUS_ADS_ENABLED: 'true' })),
      createLogger({ name: 'it-status-posting', level: 'silent' }),
      {
        paypal: new FakePayPal(`SP-${run}`),
        chatModel: null,
        speech: null,
        channels: new ChannelRegistry().register(sender),
        objectStore: null,
        statusPoster: poster,
      },
    );
    app = await buildApp(container);
    for (const [id, name] of [
      [shop, 'Posting Shop'],
      [otherShop, 'Other Posting Shop'],
    ] as const)
      await container.db.merchant.create({
        data: { id, businessName: name, ownerName: 'Owner', preferredCurrency: 'USD' },
      });
    await container.db.whatsAppAccount.create({ data: { merchantId: otherShop, wid: OTHER_WID } });
    for (const [key, merchantId, role] of [
      ['owner', shop, 'OWNER'],
      ['staff', shop, 'STAFF'],
      ['other', otherShop, 'OWNER'],
    ] as const) {
      const user = await container.dashboardUsers.create(
        merchantId,
        { username: `sp-${key}-${run}`, name: key, role, password: PASSWORD },
        'test',
      );
      const row = await container.db.dashboardUser.findUniqueOrThrow({ where: { id: user.id } });
      sessions[key] = {
        'x-dashboard-user': row.id,
        'x-dashboard-session': String(row.sessionVersion),
      };
    }
    for (const [name, color] of [
      ['Woven Basket', '#aa7744'],
      ['Clay Pot', '#335577'],
    ] as const) {
      const product = await container.db.product.create({
        data: {
          merchantId: shop,
          name,
          unitPriceMinor: 1200,
          currency: 'USD',
          stockQuantity: 5,
          description: `${name} made by hand.`,
        },
      });
      const photo = await sharp({
        create: { width: 800, height: 800, channels: 3, background: color },
      })
        .jpeg()
        .toBuffer();
      await container.productImages.save(shop, product.id, photo, 'test');
    }
    expect((await api('PUT', '/api/status-ads/settings', settings())).statusCode).toBe(200);
  });

  afterAll(async () => {
    await container.db.merchant.deleteMany({ where: { id: { in: [shop, otherShop] } } });
    await app.close();
    await container.close();
  });

  it('tells the dashboard that posting is available, and saves the choice', async () => {
    const view = (await api('GET', '/api/status-ads/settings')).json();
    expect(view).toMatchObject({ posting: true, publish: 'PHONE', katalePostsToday: 0 });
    const saved = await api('PUT', '/api/status-ads/settings', settings({ publish: 'KATALE' }));
    expect(saved.json()).toMatchObject({ publish: 'KATALE' });
    await api('PUT', '/api/status-ads/settings', settings());
  });

  it('refuses to post without the shop’s own number connected; the advert stays ready', async () => {
    const ad = await readyAd();
    const res = await api('POST', `/api/status-ads/${ad.id}/publish`, {}, 'staff');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'READY', publishingAt: null });
    expect(res.json().publishError).toMatch(/no WhatsApp number connected/);
    expect(poster.posts).toHaveLength(0);
    // The phone route still works.
    expect((await api('GET', `/api/status-ads/${ad.id}/image`)).statusCode).toBe(200);
    await api('POST', `/api/status-ads/${ad.id}/skip`);
  });

  it('posts now: the image, the caption and only this shop’s numbers go to the worker', async () => {
    await container.db.whatsAppAccount.create({ data: { merchantId: shop, wid: WID } });
    const ad = await readyAd();
    const res = await api('POST', `/api/status-ads/${ad.id}/publish`, {}, 'staff');
    expect(res.json()).toMatchObject({
      status: 'POSTED',
      postedVia: 'katale',
      statusMessageId: 'true_status@broadcast_1',
      publishError: null,
    });
    expect(res.json().postedBy).toContain('sp-staff');
    const post = poster.posts[0]!;
    expect(post.botIds).toEqual([WID]);
    expect(post.caption).toBe((await reload(ad.id)).caption);
    const meta = await sharp(Buffer.from(post.media.dataBase64, 'base64')).metadata();
    expect(meta).toMatchObject({ width: 1080, height: 1920, format: 'jpeg' });
    // Posting twice is refused.
    expect((await api('POST', `/api/status-ads/${ad.id}/publish`)).statusCode).toBe(409);
    expect(poster.posts).toHaveLength(1);
    const audit = await container.db.auditEvent.findMany({
      where: { merchantId: shop, entityId: ad.id, type: 'status_ad.posted' },
    });
    expect(audit[0]?.data).toMatchObject({ via: 'katale' });
  });

  it('never posts another shop’s advert, and an advert being posted is locked', async () => {
    const ad = await readyAd();
    expect((await api('POST', `/api/status-ads/${ad.id}/publish`, {}, 'other')).statusCode).toBe(
      404,
    );
    await container.db.statusAd.update({
      where: { id: ad.id },
      data: { publishingAt: new Date() },
    });
    for (const action of ['publish', 'posted', 'skip'])
      expect((await api('POST', `/api/status-ads/${ad.id}/${action}`)).statusCode).toBe(409);
    await container.db.statusAd.update({ where: { id: ad.id }, data: { publishingAt: null } });
    await api('POST', `/api/status-ads/${ad.id}/skip`);
  });

  it('a failure leaves the advert ready and the scheduler retries it', async () => {
    await api(
      'PUT',
      '/api/status-ads/settings',
      settings({ enabled: true, publish: 'KATALE', ...quiet() }),
    );
    const ad = await readyAd();
    poster.next.push({ outcome: 'failed', reason: 'WhatsApp is not connected.' });
    const now = new Date();
    const failed = (await api('POST', `/api/status-ads/${ad.id}/publish`)).json();
    expect(failed).toMatchObject({
      status: 'READY',
      publishAttempts: 1,
      publishError: 'WhatsApp is not connected.',
    });
    expect(new Date(failed.nextPublishAt).getTime()).toBeGreaterThan(now.getTime() + 4 * 60_000);
    // Not due yet.
    const posts = poster.posts.length;
    await container.statusAds.tick(new Date(now.getTime() + 60_000));
    expect(poster.posts).toHaveLength(posts);
    await container.statusAds.tick(new Date(now.getTime() + 6 * 60_000));
    expect(await reload(ad.id)).toMatchObject({
      status: 'POSTED',
      postedBy: 'Katale',
      postedVia: 'katale',
      publishAttempts: 2,
    });
  });

  it('never retries automatically when the outcome is unknown', async () => {
    const ad = await readyAd();
    poster.next.push({ outcome: 'unknown', reason: 'No answer from the WhatsApp worker.' });
    const res = (await api('POST', `/api/status-ads/${ad.id}/publish`)).json();
    expect(res).toMatchObject({
      status: 'READY',
      publishAttempts: MAX_PUBLISH_ATTEMPTS,
      nextPublishAt: null,
    });
    const posts = poster.posts.length;
    await container.statusAds.tick(new Date(Date.now() + 60 * 60_000));
    expect(poster.posts).toHaveLength(posts);
    // The merchant can still post it from the phone.
    expect((await api('POST', `/api/status-ads/${ad.id}/posted`)).json()).toMatchObject({
      status: 'POSTED',
      postedVia: 'phone',
    });
  });

  it('settles a post interrupted by a restart without posting it again', async () => {
    const ad = await readyAd();
    const now = new Date();
    await container.db.statusAd.update({
      where: { id: ad.id },
      data: { publishingAt: new Date(now.getTime() - 11 * 60_000) },
    });
    const posts = poster.posts.length;
    await container.statusAds.tick(now);
    expect(poster.posts).toHaveLength(posts);
    const settled = await reload(ad.id);
    expect(settled).toMatchObject({ status: 'READY', publishingAt: null, nextPublishAt: null });
    expect(settled.publishError).toMatch(/Check the shop phone/);
    await api('POST', `/api/status-ads/${ad.id}/skip`);
  });

  it(`stops at ${KATALE_DAILY_LIMIT} Katale posts a day`, async () => {
    const already = await container.db.statusAd.count({
      where: { merchantId: shop, postedVia: 'katale' },
    });
    for (let i = already; i < KATALE_DAILY_LIMIT; i++) {
      const ad = await readyAd();
      // Directly: the route allows 6 posts a minute per person.
      expect((await container.statusAds.publishNow(shop, ad.id, 'test')).status).toBe('POSTED');
    }
    const ad = await readyAd();
    const res = await container.statusAds.publishNow(shop, ad.id, 'test');
    expect(res).toMatchObject({ status: 'READY', nextPublishAt: null });
    expect(res.publishError).toMatch(/daily limit/);
    expect((await api('GET', '/api/status-ads/settings')).json().katalePostsToday).toBe(
      KATALE_DAILY_LIMIT,
    );
  });

  it('the scheduler prepares and posts a slot in one pass, and only once', async () => {
    await container.db.statusAd.updateMany({
      where: { merchantId: shop, postedVia: 'katale' },
      data: { postedAt: new Date('2026-10-01T00:00:00Z') },
    });
    await api(
      'PUT',
      '/api/status-ads/settings',
      settings({ enabled: true, publish: 'KATALE', times: ['10:00'] }),
    );
    // Wednesday 4 Nov 2026, 10:05 in Kampala.
    const now = new Date('2026-11-04T07:05:00Z');
    const posts = poster.posts.length;
    await container.statusAds.tick(now);
    await container.statusAds.tick(new Date(now.getTime() + 60_000));
    const slot = await container.db.statusAd.findFirstOrThrow({
      where: { merchantId: shop, slotKey: 'SLOT:2026-11-04T10:00' },
    });
    expect(slot).toMatchObject({ status: 'POSTED', postedVia: 'katale', postedBy: 'Katale' });
    expect(poster.posts).toHaveLength(posts + 1);
  });

  it('leaves adverts for the phone when the shop chose to post them itself', async () => {
    await api('PUT', '/api/status-ads/settings', settings({ enabled: true, times: ['11:00'] }));
    const now = new Date('2026-11-04T08:05:00Z');
    const posts = poster.posts.length;
    await container.statusAds.tick(now);
    const slot = await container.db.statusAd.findFirstOrThrow({
      where: { merchantId: shop, slotKey: 'SLOT:2026-11-04T11:00' },
    });
    expect(slot.status).toBe('READY');
    expect(poster.posts).toHaveLength(posts);
  });

  it('never messaged a customer', () => {
    expect(sender.sent).toEqual([]);
  });

  it('posting by Katale is off unless the server allows it', async () => {
    const off = createContainer(
      parseConfig(apiSchema, testEnv({ STATUS_ADS_ENABLED: 'true' })),
      createLogger({ name: 'it-status-posting-off', level: 'silent' }),
      {
        paypal: new FakePayPal(`SP-OFF-${run}`),
        chatModel: null,
        speech: null,
        objectStore: null,
      },
    );
    const offApp = await buildApp(off);
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
      offApp.inject({
        method,
        url,
        headers: { authorization: 'Bearer test-dashboard-token-123456', ...sessions.owner },
        ...(payload ? { payload } : {}),
      });
    try {
      expect((await call('GET', '/api/status-ads/settings')).json().posting).toBe(false);
      const save = await call('PUT', '/api/status-ads/settings', settings({ publish: 'KATALE' }));
      expect(save.statusCode).toBe(400);
      const ad = await container.db.statusAd.findFirstOrThrow({
        where: { merchantId: shop, status: 'READY' },
      });
      expect((await call('POST', `/api/status-ads/${ad.id}/publish`)).statusCode).toBe(409);
    } finally {
      await offApp.close();
      await off.close();
    }
  });
});

/**
 * WhatsApp admin management and proactive business reports against a real Postgres, with a
 * scripted LLM and a recording (optionally failing) WhatsApp sender:
 *   - admins are added/edited/deactivated/removed per merchant, numbers normalised to E.164;
 *   - only active admins reach the agent; inactive admins, customers and strangers get a short
 *     refusal and never reach the model or tools; linked (@lid) senders match by phone;
 *   - the report's figures match the seeded records;
 *   - one run per scheduled slot (restarts/overlapping ticks never duplicate), stale slots skipped;
 *   - every opted-in active admin gets the report; failures retry without resending what arrived;
 *   - alerts go to every opted-in admin.
 *
 * Run: pnpm test:integration
 */
import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { apiSchema, loadEnvFile, parseConfig } from '@vca/config';
import {
  createLogger,
  type ChannelSender,
  type InboundChannelMessage,
  type OutboundChannelMessage,
} from '@vca/shared';
import { buildApp } from '../../apps/api/src/app';
import { createContainer, type Container } from '../../apps/api/src/container';
import { ChannelRegistry } from '../../apps/api/src/modules/notifications/channel-registry';
import { FakePayPal, ScriptedChatModel, testEnv } from '../support/fakes';

loadEnvFile();

const run = randomUUID().slice(0, 8);
const merchantId = `adm_merchant_${run}`;
const otherMerchantId = `adm_other_${run}`;
/** A valid, random Ugandan mobile number (+25677xxxxxxx). */
const phone = () => `+25677${String(randomInt(0, 10_000_000)).padStart(7, '0')}`;
const chatOf = (e164: string) => `${e164.slice(1)}@c.us`;
const headers = (merchant = merchantId) => ({
  authorization: 'Bearer test-dashboard-token-123456',
  'x-merchant-id': merchant,
});

/** Records every message; `failFor` makes sends to a chat throw (text, media or both). */
class FlakySender implements ChannelSender {
  readonly channel = 'whatsapp' as const;
  readonly sent: OutboundChannelMessage[] = [];
  readonly failFor = new Map<string, 'all' | 'media'>();
  async send(message: OutboundChannelMessage) {
    const mode = this.failFor.get(message.externalChatId);
    if (mode === 'all' || (mode === 'media' && message.media))
      throw new Error('WhatsApp is not connected');
    this.sent.push(message);
  }
  to(chatId: string) {
    return this.sent.filter((m) => m.externalChatId === chatId);
  }
}

// Monday 19 Oct 2026, 09:05 in Kampala (UTC+3).
const NOW = new Date('2026-10-19T06:05:00Z');
const at = (iso: string) => new Date(iso);
const WELCOME =
  "Hello! 👋 Welcome to Katale AI. Our team will get back to you as soon as they're available.";

describe('admins and proactive reports (integration)', () => {
  const sender = new FlakySender();
  const model = new ScriptedChatModel([]);
  let container: Container;
  let app: FastifyInstance;
  const owner = { phone: phone(), id: '' };
  const manager = { phone: phone(), id: '' };
  const quiet = { phone: phone(), id: '' }; // opted out of reports and alerts
  const former = { phone: phone(), id: '' }; // deactivated

  const send = async (senderId: string, text: string, senderPhone?: string) => {
    const message: InboundChannelMessage = {
      channel: 'whatsapp',
      externalMessageId: randomUUID(),
      externalChatId: senderId,
      senderId,
      ...(senderPhone ? { senderPhone } : {}),
      sentAt: new Date(),
      type: 'text',
      text,
    };
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/message',
      headers: { 'x-internal-token': 'test-internal-token-123456' },
      payload: message,
    });
    return res.json() as { status: string; replies: { text: string }[] };
  };
  const addAdmin = (body: object, merchant = merchantId) =>
    app.inject({ method: 'POST', url: '/api/admins', headers: headers(merchant), payload: body });

  beforeAll(async () => {
    const channels = new ChannelRegistry();
    channels.register(sender);
    const config = parseConfig(apiSchema, testEnv());
    container = createContainer(config, createLogger({ name: 'it-adm', level: 'silent' }), {
      paypal: new FakePayPal(`ADM-${run}`),
      chatModel: model,
      speech: null,
      channels,
    });
    app = await buildApp(container);
    const db = container.db;
    for (const [id, businessName] of [
      [merchantId, 'Admin Crafts'],
      [otherMerchantId, 'Other Shop'],
    ] as const) {
      await db.merchant.create({
        data: {
          id,
          businessName,
          ownerName: 'Owner',
          preferredCurrency: 'USD',
          timezone: 'Africa/Kampala',
        },
      });
    }

    // Inventory: one low, one out of stock.
    const basket = await db.product.create({
      data: {
        merchantId,
        name: 'Handmade Basket',
        sku: `AB-${run}`,
        unitPriceMinor: 2500,
        currency: 'USD',
        stockQuantity: 3,
        reorderLevel: 10,
      },
    });
    await db.product.create({
      data: {
        merchantId,
        name: 'Barkcloth Wallet',
        sku: `AW-${run}`,
        unitPriceMinor: 1800,
        currency: 'USD',
        stockQuantity: 0,
        reorderLevel: 5,
      },
    });
    const customer = await db.customer.create({
      data: {
        merchantId,
        name: 'Sarah Thompson',
        phone: '+447700900123',
        whatsappId: '447700900123@c.us',
      },
    });

    // Paid: $50 + $25 yesterday (Sun 18 Oct), $30 the day before.
    let n = 0;
    const order = async (
      status: 'PAID' | 'AWAITING_PAYMENT',
      amount: number,
      paidAt: Date | null,
      createdAt: Date,
    ) => {
      n++;
      await db.order.create({
        data: {
          merchantId,
          customerId: customer.id,
          reference: `ORD-A${run.slice(0, 4).toUpperCase()}${n}`,
          status,
          currency: 'USD',
          subtotalMinor: amount,
          totalMinor: amount,
          source: 'whatsapp',
          items: {
            create: [
              {
                productId: basket.id,
                description: 'Handmade Basket',
                quantity: amount / 2500 || 1,
                unitPriceMinor: 2500,
                lineTotalMinor: amount,
              },
            ],
          },
          payments: {
            create: {
              merchantId,
              provider: 'PAYPAL',
              kind: 'CHECKOUT_ORDER',
              status: paidAt ? 'COMPLETED' : 'CREATED',
              amountMinor: amount,
              currency: 'USD',
              idempotencyKey: `adm-${run}-${n}`,
              createdAt,
              completedAt: paidAt,
            },
          },
        },
      });
    };
    await order('PAID', 5000, at('2026-10-18T10:00:00Z'), at('2026-10-18T09:00:00Z'));
    await order('PAID', 2500, at('2026-10-18T12:00:00Z'), at('2026-10-18T11:00:00Z'));
    await order('PAID', 3000, at('2026-10-17T10:00:00Z'), at('2026-10-17T09:00:00Z'));
    await order('AWAITING_PAYMENT', 2500, null, at('2026-10-15T08:00:00Z')); // 3 days unpaid

    await db.dispute.create({
      data: {
        merchantId,
        paypalDisputeId: `PP-D-ADM-${run}`,
        reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
        status: 'WAITING_FOR_SELLER_RESPONSE',
        amountMinor: 5000,
        currency: 'USD',
        sellerResponseDueAt: at('2026-10-25T00:00:00Z'),
        openedAt: at('2026-10-16T00:00:00Z'),
      },
    });
  });

  afterAll(async () => {
    await container.db.dispute.deleteMany({ where: { merchantId } });
    await container.db.order.deleteMany({ where: { merchantId } });
    await container.db.merchant.deleteMany({
      where: { id: { in: [merchantId, otherMerchantId] } },
    });
    await app.close();
    await container.close();
  });

  describe('admin numbers', () => {
    it('adds, edits, deactivates and removes admins for the signed-in merchant only', async () => {
      const local = `0${owner.phone.slice(4)}`; // "077…" → +25677…
      const created = await addAdmin({ name: 'Grace (owner)', phone: local });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ phone: owner.phone });
      owner.id = created.json().id;

      for (const [who, body] of [
        [manager, { name: 'Manager', phone: manager.phone }],
        [
          quiet,
          { name: 'Accountant', phone: quiet.phone, receiveReports: false, receiveAlerts: false },
        ],
        [former, { name: 'Former staff', phone: former.phone }],
      ] as const) {
        const res = await addAdmin(body);
        expect(res.statusCode).toBe(201);
        who.id = res.json().id;
      }

      // The same number can't be added twice, here or for another merchant.
      expect((await addAdmin({ name: 'Dup', phone: manager.phone })).statusCode).toBe(409);
      expect(
        (await addAdmin({ name: 'Dup', phone: manager.phone }, otherMerchantId)).statusCode,
      ).toBe(409);
      expect((await addAdmin({ name: 'Bad', phone: '123' })).statusCode).toBe(400);

      // Another merchant can't see or change these admins.
      const otherList = await app.inject({
        method: 'GET',
        url: '/api/admins',
        headers: headers(otherMerchantId),
      });
      expect(otherList.json()).toEqual([]);
      const foreign = await app.inject({
        method: 'PATCH',
        url: `/api/admins/${manager.id}`,
        headers: headers(otherMerchantId),
        payload: { active: false },
      });
      expect(foreign.statusCode).toBe(404);

      const deactivate = await app.inject({
        method: 'PATCH',
        url: `/api/admins/${former.id}`,
        headers: headers(),
        payload: { active: false },
      });
      expect(deactivate.json()).toMatchObject({ active: false });

      const rename = await app.inject({
        method: 'PATCH',
        url: `/api/admins/${manager.id}`,
        headers: headers(),
        payload: { name: 'Store manager' },
      });
      expect(rename.statusCode).toBe(200);

      // A temporary admin added then removed.
      const temp = await addAdmin({ name: 'Temp', phone: phone() });
      const del = await app.inject({
        method: 'DELETE',
        url: `/api/admins/${temp.json().id}`,
        headers: headers(),
        payload: {},
      });
      expect(del.statusCode).toBe(204);

      const list = (
        await app.inject({ method: 'GET', url: '/api/admins', headers: headers() })
      ).json() as {
        name: string;
        phone: string;
        active: boolean;
      }[];
      expect(list.map((a) => [a.name, a.phone, a.active])).toEqual([
        ['Grace (owner)', owner.phone, true],
        ['Store manager', manager.phone, true],
        ['Accountant', quiet.phone, true],
        ['Former staff', former.phone, false],
      ]);
      const events = await container.db.auditEvent.findMany({
        where: { merchantId, type: { startsWith: 'admin.' } },
        select: { type: true, data: true },
      });
      expect(events.filter((e) => e.type === 'admin.added')).toHaveLength(5);
      expect(events.some((e) => e.type === 'admin.removed')).toBe(true);
      // Audit data never contains the full number.
      expect(JSON.stringify(events)).not.toContain(owner.phone);
    });

    it('lets an active admin use the agent, matched by chat ID or by phone behind a linked ID', async () => {
      model.enqueue(() => ({ role: 'assistant', content: 'Hello Grace.' }));
      const direct = await send(chatOf(owner.phone), 'hi');
      expect(direct.replies[0]?.text).toContain('Hello Grace.');

      const lid = `9${run.replace(/\D/g, '')}12345@lid`;
      model.enqueue(() => ({ role: 'assistant', content: 'Hello again.' }));
      const linked = await send(lid, 'hi', manager.phone);
      expect(linked.replies[0]?.text).toContain('Hello again.');
      // The linked ID is learned, so the next message matches even without a resolved phone.
      const saved = await container.db.merchantOperator.findUniqueOrThrow({
        where: { id: manager.id },
      });
      expect(saved.whatsappLid).toBe(lid);
      model.enqueue(() => ({ role: 'assistant', content: 'Still you.' }));
      expect((await send(lid, 'hi')).replies[0]?.text).toContain('Still you.');
    });

    it('gives inactive admins, customers and strangers the same generic welcome, nothing else', async () => {
      const calls = model.requests.length;
      const customerChat = '447700900123@c.us';
      const strangerChat = chatOf(phone());
      const replies = [
        await send(chatOf(former.phone), 'show me sales'),
        await send(customerChat, 'where is my order?'),
        await send(strangerChat, 'list my customers'),
      ];
      for (const reply of replies) {
        expect(reply.status).toBe('ignored');
        expect(reply.replies.map((r) => r.text)).toEqual([WELCOME]);
      }
      // No business names, IDs, numbers or amounts leak in the reply.
      const text = replies.map((r) => r.replies[0]!.text).join('\n');
      expect(text).not.toMatch(/Admin Crafts|@c\.us|@lid|\+\d|\$|ORD-|admin/i);

      // Approval codes and voice notes from these senders do nothing either.
      const code = await send(chatOf(former.phone), 'CONFIRM 1234');
      expect(code).toMatchObject({ status: 'ignored', replies: [] });
      const voice = await app.inject({
        method: 'POST',
        url: '/api/agent/message',
        headers: { 'x-internal-token': 'test-internal-token-123456' },
        payload: {
          channel: 'whatsapp',
          externalMessageId: randomUUID(),
          externalChatId: customerChat,
          senderId: customerChat,
          sentAt: new Date(),
          type: 'audio',
          media: { mimeType: 'audio/ogg; codecs=opus', dataBase64: 'AAAA', durationSeconds: 3 },
        },
      });
      expect(voice.json()).toMatchObject({ status: 'ignored', replies: [] });

      expect(model.requests.length).toBe(calls);
      const conversations = await container.db.conversation.count({
        where: { externalChatId: { in: [chatOf(former.phone), customerChat, strangerChat] } },
      });
      expect(conversations).toBe(0);
    });

    it('repeats the welcome only after the cooldown (24 h by default)', async () => {
      const chat = chatOf(phone());
      expect((await send(chat, 'hi')).replies).toHaveLength(1);
      expect((await send(chat, 'hello?')).replies).toHaveLength(0);
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(Date.now() + 23 * 60 * 60_000);
        expect((await send(chat, 'anyone?')).replies).toHaveLength(0);
        vi.setSystemTime(Date.now() + 2 * 60 * 60_000);
        expect((await send(chat, 'hi again')).replies.map((r) => r.text)).toEqual([WELCOME]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('a re-activated admin gets full access again', async () => {
      await container.admins.update(merchantId, former.id, { active: true });
      model.enqueue(() => ({ role: 'assistant', content: 'Welcome back.' }));
      expect((await send(chatOf(former.phone), 'hi')).replies[0]?.text).toContain('Welcome back.');
      await container.admins.update(merchantId, former.id, { active: false });
    });
  });

  describe('owner and staff roles', () => {
    const draft = async (chat: string) => {
      model.enqueue(
        () => ({
          role: 'assistant',
          content: null,
          toolCalls: [
            {
              id: randomUUID().slice(0, 8),
              name: 'create_draft_order',
              arguments: JSON.stringify({
                customer: { name: 'Sarah' },
                items: [{ name: 'handmade basket', quantity: 1 }],
              }),
            },
          ],
        }),
        () => ({ role: 'assistant', content: 'Drafted.' }),
      );
      return (await send(chat, 'Create an order for Sarah for 1 basket.')).replies
        .map((r) => r.text)
        .join('\n');
    };
    const patch = (id: string, body: object) =>
      app.inject({ method: 'PATCH', url: `/api/admins/${id}`, headers: headers(), payload: body });

    it('new admins are staff; staff can draft orders but not request payment', async () => {
      const list = (
        await app.inject({ method: 'GET', url: '/api/admins', headers: headers() })
      ).json() as {
        id: string;
        role: string;
      }[];
      expect(list.find((a) => a.id === manager.id)?.role).toBe('STAFF');
      const text = await draft(chatOf(manager.phone));
      expect(text).toMatch(/ORD-[A-Z0-9]{6}/);
      expect(text).toContain('🔒 Only an owner can approve this');
      expect(text).not.toMatch(/CONFIRM \d{4}/);
    });

    it('an owner gets the approval code; a role change before approving blocks it', async () => {
      expect((await patch(owner.id, { role: 'OWNER' })).json()).toMatchObject({ role: 'OWNER' });
      const text = await draft(chatOf(owner.phone));
      const code = /CONFIRM (\d{4})/.exec(text)![1];
      const reference = /ORD-[A-Z0-9]{6}/.exec(text)![0];

      // Promote the manager so the owner can be demoted, then try to approve as staff.
      expect((await patch(manager.id, { role: 'OWNER' })).statusCode).toBe(200);
      expect((await patch(owner.id, { role: 'STAFF' })).statusCode).toBe(200);
      const reply = await send(chatOf(owner.phone), `CONFIRM ${code}`);
      expect(reply.replies[0]?.text).toContain('Only an owner can approve payment requests');
      const order = await container.orders.getByReference(merchantId, reference);
      expect(order.status).toBe('DRAFT');
      expect(order.payments).toHaveLength(0);
    });

    it('keeps at least one active owner', async () => {
      // The manager is now the only active owner.
      const demote = await patch(manager.id, { role: 'STAFF' });
      expect(demote.statusCode).toBe(409);
      expect(demote.json().error.message).toMatch(/only active owner/);
      expect((await patch(manager.id, { active: false })).statusCode).toBe(409);
      const del = await app.inject({
        method: 'DELETE',
        url: `/api/admins/${manager.id}`,
        headers: headers(),
        payload: {},
      });
      expect(del.statusCode).toBe(409);
      // Restore for the report tests: owner back to OWNER, manager stays OWNER.
      await patch(owner.id, { role: 'OWNER' });
    });
  });

  describe('business reports', () => {
    const putSchedule = (body: object) =>
      app.inject({
        method: 'PUT',
        url: '/api/reports/schedule',
        headers: headers(),
        payload: {
          enabled: true,
          frequency: 'WEEKLY',
          weekday: 1,
          hour: 9,
          minute: 0,
          timezone: null,
          includeSales: true,
          includeInventory: true,
          includeUnpaid: true,
          includeDisputes: true,
          includeChart: true,
          includeInsights: true,
          ...body,
        },
      });
    const runs = () =>
      container.db.reportRun.findMany({
        where: { merchantId },
        include: { deliveries: true },
        orderBy: { createdAt: 'asc' },
      });

    it('builds the report from the merchant records', async () => {
      const merchant = await container.db.merchant.findUniqueOrThrow({ where: { id: merchantId } });
      const all = {
        includeSales: true,
        includeInventory: true,
        includeUnpaid: true,
        includeDisputes: true,
        includeChart: true,
        includeInsights: true,
      };
      const report = await container.reportScheduler['builder'].build(
        merchant,
        { title: 'Weekly business report', sections: all },
        NOW,
      );
      expect(report.facts).toEqual({
        yesterday: { revenue: ['$75.00'], paidOrders: 2, changePercent: 150 },
        week: { revenue: ['$105.00'], paidOrders: 3, topProduct: 'Handmade Basket' },
        lowStock: expect.arrayContaining([
          expect.objectContaining({ name: 'Barkcloth Wallet', stock: 0, status: 'OUT_OF_STOCK' }),
          expect.objectContaining({
            name: 'Handmade Basket',
            stock: 3,
            reorderLevel: 10,
            status: 'LOW',
          }),
        ]),
        unpaid: { count: 1, total: ['$25.00'], oldestDays: 3 },
        disputes: { open: 1, needsResponse: 1 },
        // Seeded links have no PayPal order ID, so there is nothing to ask PayPal about.
        reconciliation: { checked: 0, recovered: [], expired: [], mismatches: [] },
      });
      expect(report.text).toContain('*Payment check (PayPal)*\n✅ Records match PayPal.');
      expect(report.text).toContain('*Yesterday (Sun 18 Oct)*');
      expect(report.text).toContain('Revenue $75.00 from 2 paid orders (↑ 150% vs the day before)');
      expect(report.text).toContain('⛔ Barkcloth Wallet — out of stock');
      expect(report.text).toContain('⚠️ Handmade Basket — 3 left (reorder at 10)');
      expect(report.text).toMatch(/1 awaiting payment · \$25\.00/);
      expect(report.text).toContain(`PP-D-ADM-${run}`);
      expect(report.text).toContain('*needs your response* by 25 Oct');
      expect(report.text).toMatch(/payment link has been unpaid for 2\+ days/);
      expect(report.chart?.media.mimeType).toBe('image/png');

      // Turning sections off removes them (and the chart).
      const slim = await container.reportScheduler['builder'].build(
        merchant,
        {
          title: 'Weekly business report',
          sections: { ...all, includeDisputes: false, includeChart: false },
        },
        NOW,
      );
      expect(slim.text).not.toContain('Open PayPal disputes');
      expect(slim.chart).toBeNull();
    });

    it('builds the monthly report from last calendar month', async () => {
      const merchant = await container.db.merchant.findUniqueOrThrow({ where: { id: merchantId } });
      const sections = {
        includeSales: true,
        includeInventory: false,
        includeUnpaid: false,
        includeDisputes: false,
        includeChart: true,
        includeInsights: true,
      };
      // 1 Nov 2026, 09:00 Kampala: last month is October (all seeded sales), September had none.
      const report = await container.reportScheduler['builder'].build(
        merchant,
        { title: 'Monthly business report', sections, monthly: true },
        new Date('2026-11-01T06:00:00Z'),
      );
      expect(report.facts.month).toEqual({
        revenue: ['$105.00'],
        paidOrders: 3,
        changePercent: null,
        topProduct: 'Handmade Basket',
      });
      expect(report.text).toContain('*Last month (October 2026)*');
      expect(report.text).toContain('Revenue $105.00 from 3 paid orders');
      expect(report.text).toContain('Best seller: Handmade Basket');
      expect(report.text).not.toContain('*Yesterday');
      expect(report.text).toContain('30-day revenue chart below');
    });

    it('skips a slot that was missed by more than the catch-up window', async () => {
      // Monday 00:00 Kampala = Sun 21:00 UTC: 9 hours before NOW.
      expect((await putSchedule({ hour: 0 })).statusCode).toBe(200);
      await container.reportScheduler.tick(NOW);
      expect(await runs()).toHaveLength(0);
    });

    it('validates the schedule and reports the next run time and recipients', async () => {
      expect((await putSchedule({ timezone: 'Mars/Olympus' })).statusCode).toBe(400);
      expect((await putSchedule({})).statusCode).toBe(200);
      const res = await app.inject({
        method: 'GET',
        url: '/api/reports/schedule',
        headers: headers(),
      });
      // Owner and manager receive reports; the accountant opted out; former staff is inactive.
      expect(res.json()).toMatchObject({ enabled: true, weekday: 1, hour: 9, recipients: 2 });
    });

    it('sends one run per slot to every opted-in active admin, retrying failures without duplicates', async () => {
      sender.sent.length = 0;
      // The manager's phone is offline for the chart on the first attempt.
      sender.failFor.set(chatOf(manager.phone), 'media');

      await Promise.all([container.reportScheduler.tick(NOW), container.reportScheduler.tick(NOW)]);
      await container.reportScheduler.tick(new Date(NOW.getTime() + 30_000)); // a restart/second tick

      const all = await runs();
      expect(all).toHaveLength(1);
      let first = all[0];
      expect(first!.periodKey).toBe('WEEKLY:2026-10-19');
      expect(first!.status).toBe('SENDING');
      expect(first!.deliveries.map((d) => d.operatorId).sort()).toEqual(
        [owner.id, manager.id].sort(),
      );

      expect(sender.to(chatOf(owner.phone)).map((m) => !!m.media)).toEqual([false, true]);
      expect(sender.to(chatOf(manager.phone)).map((m) => !!m.media)).toEqual([false]);
      expect(sender.to(chatOf(quiet.phone))).toHaveLength(0);
      expect(sender.to(chatOf(former.phone))).toHaveLength(0);
      const managerDelivery = first!.deliveries.find((d) => d.operatorId === manager.id)!;
      expect(managerDelivery).toMatchObject({
        status: 'FAILED',
        attempts: 1,
        lastError: 'WhatsApp is not connected',
      });
      expect(managerDelivery.textSentAt).not.toBeNull();

      // Before the backoff (2 min) nothing is retried.
      await container.reportScheduler.tick(new Date(NOW.getTime() + 60_000));
      expect(sender.to(chatOf(manager.phone))).toHaveLength(1);

      // WhatsApp is back: only the missing chart is sent.
      sender.failFor.clear();
      await container.reportScheduler.tick(new Date(NOW.getTime() + 3 * 60_000));
      expect(sender.to(chatOf(manager.phone)).map((m) => !!m.media)).toEqual([false, true]);
      expect(sender.to(chatOf(owner.phone))).toHaveLength(2);
      [first] = await runs();
      expect(first!.status).toBe('SENT');
      expect(first!.deliveries.every((d) => d.status === 'SENT')).toBe(true);

      // The report and chart were stored in each admin's conversation.
      const stored = await container.db.message.count({
        where: {
          conversation: { merchantId, externalChatId: chatOf(owner.phone) },
          direction: 'OUTBOUND',
        },
      });
      expect(stored).toBeGreaterThanOrEqual(2);
      const audit = await container.db.auditEvent.findMany({
        where: { merchantId, type: { in: ['report.generated', 'report.sent'] } },
      });
      expect(audit.map((e) => e.type).sort()).toEqual(['report.generated', 'report.sent']);
    });

    it('gives up after the last retry and marks the run partial', async () => {
      sender.failFor.set(chatOf(manager.phone), 'all');
      const later = new Date(NOW.getTime() + 60 * 60_000);
      const manual = (await container.reportScheduler.sendNow(merchantId, later))!;
      expect(manual).toMatchObject({ trigger: 'MANUAL', status: 'SENDING' });
      expect(manual.deliveries).toHaveLength(2);
      for (const minutes of [3, 9, 30])
        await container.reportScheduler.tick(new Date(later.getTime() + minutes * 60_000));
      const settled = await container.db.reportRun.findUniqueOrThrow({
        where: { id: manual.id },
        include: { deliveries: true },
      });
      expect(settled.status).toBe('PARTIAL');
      expect(settled.deliveries.find((d) => d.operatorId === manager.id)).toMatchObject({
        status: 'FAILED',
        attempts: 4,
      });
      // A later tick does not try again.
      const before = sender.sent.length;
      await container.reportScheduler.tick(new Date(later.getTime() + 120 * 60_000));
      expect(sender.sent.length).toBe(before);
      sender.failFor.clear();
    });

    it('does not send to an admin deactivated after the run was created', async () => {
      sender.failFor.set(chatOf(manager.phone), 'all');
      const later = new Date(NOW.getTime() + 4 * 60 * 60_000);
      await container.reportScheduler.sendNow(merchantId, later);
      sender.failFor.clear();
      await container.admins.update(merchantId, manager.id, { active: false });
      const before = sender.to(chatOf(manager.phone)).length;
      await container.reportScheduler.tick(new Date(later.getTime() + 10 * 60_000));
      expect(sender.to(chatOf(manager.phone)).length).toBe(before);
      const latest = (await runs()).at(-1)!;
      expect(latest.deliveries.find((d) => d.operatorId === manager.id)).toMatchObject({
        status: 'FAILED',
        lastError: 'admin no longer receives reports',
      });
      await container.admins.update(merchantId, manager.id, { active: true });
    });

    it('sends a monthly schedule once, on the 1st', async () => {
      expect((await putSchedule({ frequency: 'MONTHLY', hour: 9 })).statusCode).toBe(200);
      const first = new Date('2026-11-01T06:03:00Z');
      await container.reportScheduler.tick(first);
      await container.reportScheduler.tick(new Date(first.getTime() + 60_000));
      const monthly = (await runs()).filter((r) => r.periodKey.startsWith('MONTHLY:'));
      expect(monthly.map((r) => r.periodKey)).toEqual(['MONTHLY:2026-11-01']);
      expect(monthly[0]!.text).toContain('*Katale AI · Monthly business report*');
      expect((await putSchedule({})).statusCode).toBe(200); // back to weekly
    });

    it('marks a run failed when no admin receives reports', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/reports/send-now',
        headers: headers(otherMerchantId),
        payload: {},
      });
      expect(res.json()).toMatchObject({ status: 'FAILED', deliveries: 0 });
    });
  });

  it('sends stock and dispute alerts to every opted-in active admin', async () => {
    sender.sent.length = 0;
    sender.failFor.set(chatOf(manager.phone), 'all');
    const delivered = await container.notifications.toAdmins(
      merchantId,
      '⚠️ *Low stock:* Handmade Basket — 3 left.',
    );
    expect(delivered).toBe(1);
    expect(sender.sent.map((m) => m.externalChatId)).toEqual([chatOf(owner.phone)]);
    const failed = await container.db.auditEvent.findFirst({
      where: { merchantId, type: 'notification.failed', entityId: manager.id },
    });
    expect(failed).not.toBeNull();
    sender.failFor.clear();
  });
});

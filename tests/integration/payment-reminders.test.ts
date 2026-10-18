/**
 * Payment reminders against a real Postgres, with simulated PayPal and a scripted LLM:
 *   - the agent only proposes; the customer is messaged only after REMIND <code> (not yes/CONFIRM);
 *   - a replayed code never sends twice; one reminder per 24 h and three per link;
 *   - PayPal is checked first: paid/approved orders are captured instead of reminded, and
 *     expired links are replaced with a new one for the same amount;
 *   - customers with only a phone number are reached; customers without one are refused;
 *   - delivery failures give the reminder slot back; the dashboard button is merchant-scoped.
 *
 * Run: pnpm test:integration
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
const merchantId = `rem_merchant_${run}`;
const operatorChat = `1888${run.replace(/\D/g, '').padEnd(6, '1')}@c.us`;
const sarahChat = `44770${run.replace(/\D/g, '').padEnd(6, '2').slice(0, 6)}@c.us`;
const bobPhone = `+25677${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
const bobChat = `${bobPhone.slice(1)}@c.us`;
const headers = (merchant = merchantId) => ({
  authorization: 'Bearer test-dashboard-token-123456',
  'x-merchant-id': merchant,
});
const HOUR = 3_600_000;

class FlakySender implements ChannelSender {
  readonly channel = 'whatsapp' as const;
  readonly sent: OutboundChannelMessage[] = [];
  readonly failFor = new Set<string>();
  async send(message: OutboundChannelMessage) {
    if (this.failFor.has(message.externalChatId)) throw new Error('WhatsApp is not connected');
    this.sent.push(message);
  }
  to(chatId: string) {
    return this.sent.filter((m) => m.externalChatId === chatId).map((m) => m.text);
  }
}

describe('payment reminders (integration)', () => {
  const paypal = new FakePayPal(`REM-${run}`);
  const sender = new FlakySender();
  const model = new ScriptedChatModel([]);
  let container: Container;
  let app: FastifyInstance;

  const send = async (body: string) => {
    const message: InboundChannelMessage = {
      channel: 'whatsapp',
      externalMessageId: randomUUID(),
      externalChatId: operatorChat,
      senderId: operatorChat,
      sentAt: new Date(),
      type: 'text',
      text: body,
    };
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/message',
      headers: { 'x-internal-token': 'test-internal-token-123456' },
      payload: message,
    });
    return (res.json() as { replies: { text: string }[] }).replies.map((r) => r.text).join('\n');
  };
  const scriptTool = (name: string, args: object, after = 'Done.') =>
    model.enqueue(
      () => ({
        role: 'assistant',
        content: null,
        toolCalls: [{ id: randomUUID().slice(0, 8), name, arguments: JSON.stringify(args) }],
      }),
      () => ({ role: 'assistant', content: after }),
    );
  const merchant = () => container.db.merchant.findUniqueOrThrow({ where: { id: merchantId } });
  const paymentOf = (reference: string) =>
    container.db.payment.findFirstOrThrow({
      where: { order: { reference } },
      orderBy: { createdAt: 'desc' },
    });

  /** Draft → CONFIRM: an order awaiting payment (link already sent to the customer if reachable). */
  const requestPayment = async (customer: string, quantity: number) => {
    scriptTool('create_draft_order', {
      customer: { name: customer },
      items: [{ name: 'handmade baskets', quantity }],
    });
    const draft = await send(`Create an order for ${customer} for ${quantity} baskets.`);
    const reference = /ORD-[A-Z0-9]{6}/.exec(draft)![0];
    await send(`CONFIRM ${/CONFIRM (\d{4})/.exec(draft)![1]}`);
    const payment = await paymentOf(reference);
    paypal.orderStatus.set(payment.externalId!, 'PAYER_ACTION_REQUIRED');
    return { reference, payment };
  };

  beforeAll(async () => {
    const channels = new ChannelRegistry();
    channels.register(sender);
    const config = parseConfig(apiSchema, testEnv());
    container = createContainer(config, createLogger({ name: 'it-rem', level: 'silent' }), {
      paypal,
      chatModel: model,
      speech: null,
      channels,
    });
    app = await buildApp(container);
    const db = container.db;
    await db.merchant.create({
      data: {
        id: merchantId,
        businessName: 'Reminder Crafts',
        ownerName: 'Owner',
        preferredCurrency: 'USD',
        timezone: 'Africa/Kampala',
      },
    });
    await db.merchantOperator.create({
      data: { merchantId, name: 'Owner', channel: 'whatsapp', externalId: operatorChat },
    });
    await db.product.create({
      data: {
        merchantId,
        name: 'Handmade Basket',
        sku: `RB-${run}`,
        unitPriceMinor: 1200,
        currency: 'USD',
      },
    });
    await db.customer.createMany({
      data: [
        { merchantId, name: 'Sarah Thompson', whatsappId: sarahChat },
        { merchantId, name: 'Bob Okello', phone: bobPhone.replace('+256', '0') },
        { merchantId, name: 'Nora Nakato' },
      ],
    });
  });

  afterAll(async () => {
    await container.db.order.deleteMany({ where: { merchantId } });
    await container.db.merchant.delete({ where: { id: merchantId } });
    await app.close();
    await container.close();
  });

  let sarahOrder: { reference: string; payment: { id: string; externalId: string | null } };

  it('proposes a reminder and sends it only after REMIND <code>', async () => {
    sarahOrder = await requestPayment('Sarah', 2);
    const before = sender.to(sarahChat).length; // the original payment link

    scriptTool('remind_customer', { order_reference: sarahOrder.reference });
    const proposal = await send(`Remind Sarah to pay for ${sarahOrder.reference}`);
    expect(proposal).toContain('*Payment reminder*');
    expect(proposal).toContain('To: Sarah Thompson');
    expect(proposal).toContain('Reminders so far: 0 of 3');
    expect(proposal).toMatch(/Reply \*REMIND \d{4}\*/);
    const code = /REMIND (\d{4})/.exec(proposal)![1]!;
    expect(sender.to(sarahChat)).toHaveLength(before);

    // A bare yes or CONFIRM never sends a reminder.
    await send('yes');
    await send(`CONFIRM ${code}`);
    expect(sender.to(sarahChat)).toHaveLength(before);

    const done = await send(`REMIND ${code}`);
    expect(done).toContain('*Reminder sent* to Sarah Thompson');
    expect(done).toContain('Reminder 1 of 3');
    const reminder = sender.to(sarahChat).at(-1)!;
    expect(reminder).toContain('A friendly reminder from *Reminder Crafts*');
    expect(reminder).toContain(`order ${sarahOrder.reference} (*$24.00*)`);
    expect(reminder).toContain(`token=${sarahOrder.payment.externalId}`);
    expect(await paymentOf(sarahOrder.reference)).toMatchObject({ reminderCount: 1 });

    // Replaying the code doesn't send again.
    expect(await send(`REMIND ${code}`)).toMatch(/already sent/);
    expect(sender.to(sarahChat)).toHaveLength(before + 1);
    const audit = await container.db.auditEvent.findMany({
      where: { merchantId, type: 'payment.reminder_sent' },
    });
    expect(audit).toHaveLength(1);
  });

  it('allows one reminder per 24 hours', async () => {
    await expect(
      container.reminders.prepare(await merchant(), sarahOrder.reference),
    ).rejects.toThrow(/already sent 1 hour ago.*one every 24 hours/);
  });

  it('replaces an expired PayPal link with a new one for the same amount', async () => {
    paypal.expired.add(sarahOrder.payment.externalId!);
    const later = new Date(Date.now() + 25 * HOUR);
    const m = await merchant();
    const { payload } = await container.reminders.prepare(m, sarahOrder.reference, later);
    const outcome = await container.reminders.send(m, payload, 'dashboard', later);
    expect(outcome).toMatchObject({ status: 'sent', renewed: true, reminderNumber: 2 });

    const payments = await container.db.payment.findMany({
      where: { order: { reference: sarahOrder.reference } },
      orderBy: { createdAt: 'asc' },
    });
    expect(payments.map((p) => [p.status, p.reminderCount])).toEqual([
      ['CANCELLED', 1],
      ['CREATED', 2],
    ]);
    expect(payments[1]!.amountMinor).toBe(2400);
    expect(sender.to(sarahChat).at(-1)).toContain(`token=${payments[1]!.externalId}`);
    const order = await container.orders.getByReference(merchantId, sarahOrder.reference);
    expect(order.status).toBe('AWAITING_PAYMENT');
  });

  it('stops after three reminders', async () => {
    const payment = await paymentOf(sarahOrder.reference);
    await container.db.payment.update({
      where: { id: payment.id },
      data: { reminderCount: 3, lastReminderAt: new Date(Date.now() - 48 * HOUR) },
    });
    await expect(
      container.reminders.prepare(await merchant(), sarahOrder.reference),
    ).rejects.toThrow(/3 reminders have already been sent/);
  });

  it('records the payment instead of reminding when PayPal shows the buyer approved', async () => {
    const { reference, payment } = await requestPayment('Sarah', 1);
    const before = sender.to(sarahChat).length;
    paypal.orderStatus.set(payment.externalId!, 'APPROVED');
    const m = await merchant();
    const { payload } = await container.reminders.prepare(m, reference);
    expect(await container.reminders.send(m, payload, 'whatsapp')).toEqual({ status: 'paid' });
    expect((await container.orders.getByReference(merchantId, reference)).status).toBe('PAID');
    expect(sender.to(sarahChat).slice(before).join('\n')).not.toContain('friendly reminder');
    // And a paid order can't be reminded.
    await expect(container.reminders.prepare(m, reference)).rejects.toThrow(/already paid/);
  });

  it('reaches customers who only have a phone number, and refuses those with neither', async () => {
    const bob = await requestPayment('Bob', 1);
    const m = await merchant();
    const { payload, summary } = await container.reminders.prepare(m, bob.reference);
    expect(payload.chatId).toBe(bobChat);
    expect(summary).toContain(`(${bobPhone})`);
    expect(await container.reminders.send(m, payload, 'whatsapp')).toMatchObject({
      status: 'sent',
    });
    expect(sender.to(bobChat).at(-1)).toContain('Hello Bob Okello');

    const nora = await requestPayment('Nora', 1);
    await expect(container.reminders.prepare(m, nora.reference)).rejects.toThrow(
      /Nora Nakato has no WhatsApp number on file/,
    );
  });

  it('gives the slot back when WhatsApp delivery fails', async () => {
    const { reference } = await requestPayment('Sarah', 3);
    sender.failFor.add(sarahChat);
    const m = await merchant();
    const { payload } = await container.reminders.prepare(m, reference);
    await expect(container.reminders.send(m, payload, 'whatsapp')).rejects.toThrow(
      /couldn't be delivered on WhatsApp/,
    );
    expect(await paymentOf(reference)).toMatchObject({ reminderCount: 0, lastReminderAt: null });
    sender.failFor.clear();
    expect(await container.reminders.send(m, payload, 'whatsapp')).toMatchObject({
      status: 'sent',
      reminderNumber: 1,
    });
  });

  it('sends from the dashboard button for the signed-in merchant only', async () => {
    const { reference } = await requestPayment('Bob', 2);
    const payment = await paymentOf(reference);
    const foreign = await app.inject({
      method: 'POST',
      url: `/api/payments/${payment.id}/remind`,
      headers: headers('some_other_merchant'),
      payload: {},
    });
    expect(foreign.statusCode).toBe(404);
    const res = await app.inject({
      method: 'POST',
      url: `/api/payments/${payment.id}/remind`,
      headers: headers(),
      payload: {},
    });
    expect(res.json()).toMatchObject({
      status: 'sent',
      reminderNumber: 1,
      customer: 'Bob Okello',
      orderReference: reference,
    });
    const again = await app.inject({
      method: 'POST',
      url: `/api/payments/${payment.id}/remind`,
      headers: headers(),
      payload: {},
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.message).toMatch(/already sent/);
  });

  describe('reconciliation with PayPal', () => {
    it('records a payment that completed at PayPal without a webhook', async () => {
      const { reference, payment } = await requestPayment('Sarah', 4);
      paypal.orderStatus.set(payment.externalId!, 'APPROVED'); // buyer paid; webhook lost

      // Too young to check: the buyer may be paying right now.
      await container.reconciler.sweep(new Date(), { merchantId });
      expect((await paymentOf(reference)).providerCheckedAt).toBeNull();

      await container.reconciler.sweep(new Date(Date.now() + 31 * 60_000), { merchantId });
      expect((await container.orders.getByReference(merchantId, reference)).status).toBe('PAID');
      expect(sender.to(operatorChat).join('\n')).toContain(reference);
      const audit = await container.db.auditEvent.findFirst({
        where: { merchantId, type: 'payment.reconciled' },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit?.data).toMatchObject({ recovered: [reference] });
    });

    it('re-checks an open link at most every 6 hours', async () => {
      const { reference } = await requestPayment('Bob', 3);
      const t0 = Date.now() + 31 * 60_000;
      await container.reconciler.sweep(new Date(t0), { merchantId });
      const first = (await paymentOf(reference)).providerCheckedAt;
      expect(first).not.toBeNull();
      await container.reconciler.sweep(new Date(t0 + 60 * 60_000), { merchantId });
      expect((await paymentOf(reference)).providerCheckedAt).toEqual(first);
      await container.reconciler.sweep(new Date(t0 + 7 * 60 * 60_000), { merchantId });
      expect((await paymentOf(reference)).providerCheckedAt!.getTime()).toBeGreaterThan(
        first!.getTime(),
      );
      expect((await container.orders.getByReference(merchantId, reference)).status).toBe(
        'AWAITING_PAYMENT',
      );
    });

    it('flags expired links and orders that disagree with their payments', async () => {
      const { reference, payment } = await requestPayment('Sarah', 5);
      paypal.expired.add(payment.externalId!);
      const customer = await container.db.customer.findFirstOrThrow({ where: { merchantId } });
      const orphan = await container.db.order.create({
        data: {
          merchantId,
          customerId: customer.id,
          reference: `ORD-X${run.slice(0, 5).toUpperCase()}`,
          status: 'PAID',
          currency: 'USD',
          subtotalMinor: 1000,
          totalMinor: 1000,
          source: 'whatsapp',
        },
      });
      const result = await container.reconciler.reconcile(
        merchantId,
        new Date(Date.now() + 31 * 60_000),
      );
      expect(result.expired).toContain(reference);
      expect(result.mismatches).toContain(
        `${orphan.reference} is marked paid but has no completed PayPal payment`,
      );
      expect(result.errors).toBe(0);
      // Nothing was changed for the expired link: a reminder renews it.
      expect((await paymentOf(reference)).status).toBe('CREATED');
      await container.db.order.delete({ where: { id: orphan.id } });
    });
  });
});

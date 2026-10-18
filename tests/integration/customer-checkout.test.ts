/**
 * Customer checkout on WhatsApp (Phase 2), against a real Postgres with simulated PayPal and a
 * scripted LLM. The full journey — browse → add to cart → checkout (name, delivery, address) →
 * ORDER → PayPal link → buyer pays (verified return/capture) → confirmation → order status — and
 * the edge cases: stock and reservations, changed prices, duplicate and concurrent ORDERs,
 * expired carts, unpaid-order limits, PayPal failures, admin approval mode, idempotent stock,
 * and cross-merchant isolation.
 *
 * Run: pnpm test:integration
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { apiSchema, loadEnvFile, parseConfig } from '@vca/config';
import {
  ProviderError,
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
const digits = run.replace(/\D/g, '').padEnd(6, '3').slice(0, 6);
const shop = `co_shop_${run}`;
const otherShop = `co_other_${run}`;
const bot = `25670${digits}5@c.us`;
const otherBot = `25670${digits}6@c.us`;
const admin = `25671${digits}5@c.us`;
const jane = `25678${digits}5@c.us`;
const bob = `25678${digits}6@c.us`;

class RecordingSender implements ChannelSender {
  readonly channel = 'whatsapp' as const;
  readonly sent: OutboundChannelMessage[] = [];
  async send(message: OutboundChannelMessage) {
    this.sent.push(message);
  }
  to(chatId: string) {
    return this.sent.filter((m) => m.externalChatId === chatId).map((m) => m.text);
  }
}

describe('customer checkout (integration)', () => {
  const paypal = new FakePayPal(`CO-${run}`);
  const sender = new RecordingSender();
  const model = new ScriptedChatModel([]);
  let container: Container;
  let app: FastifyInstance;
  let basketId: string;
  let accountId: string;

  const send = async (
    from: string,
    text: string,
    extra: Partial<InboundChannelMessage> = {},
  ): Promise<{ status: string; replies: { text: string }[] }> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/message',
      headers: { 'x-internal-token': 'test-internal-token-123456' },
      payload: {
        channel: 'whatsapp',
        externalMessageId: randomUUID(),
        externalChatId: from,
        senderId: from,
        sentAt: new Date(),
        type: 'text',
        text,
        recipientId: bot,
        ...extra,
      },
    });
    return res.json();
  };
  const say = async (from: string, text: string) =>
    (await send(from, text)).replies.map((r) => r.text).join('\n');
  const customerOf = (chat: string, merchantId = shop) =>
    container.db.customer.findFirstOrThrow({ where: { merchantId, whatsappId: chat } });
  const ordersOf = async (chat: string) =>
    container.db.order.findMany({
      where: { merchantId: shop, customerId: (await customerOf(chat)).id },
      include: { items: true, payments: { orderBy: { createdAt: 'asc' } } },
      orderBy: { createdAt: 'asc' },
    });
  const basket = () => container.db.product.findUniqueOrThrow({ where: { id: basketId } });
  const setAccount = (data: object) =>
    container.whatsappAccounts.update(shop, accountId, data, { customerCommerceAvailable: true });

  beforeAll(async () => {
    const channels = new ChannelRegistry();
    channels.register(sender);
    container = createContainer(
      parseConfig(
        apiSchema,
        testEnv({ CUSTOMER_COMMERCE_ENABLED: 'true', CUSTOMER_MESSAGES_PER_MINUTE: '1000' }),
      ),
      createLogger({ name: 'it-co', level: 'silent' }),
      { paypal, chatModel: model, speech: null, channels },
    );
    app = await buildApp(container);
    const db = container.db;
    for (const [id, name] of [
      [shop, 'Kampala Baskets'],
      [otherShop, 'Jinja Crafts'],
    ] as const)
      await db.merchant.create({
        data: { id, businessName: name, ownerName: 'Owner', preferredCurrency: 'USD' },
      });
    await db.merchantOperator.create({
      data: { merchantId: shop, name: 'Owner', channel: 'whatsapp', externalId: admin },
    });
    accountId = (await container.whatsappAccounts.connect(shop, bot)).id;
    await setAccount({
      customerCommerceEnabled: true,
      deliveryEnabled: true,
      deliveryFeeMinor: 500,
      pickupEnabled: true,
      pickupInfo: 'Shop 4, Kampala Road, 9–6',
    });
    const other = await container.whatsappAccounts.connect(otherShop, otherBot);
    await container.whatsappAccounts.update(
      otherShop,
      other.id,
      { customerCommerceEnabled: true },
      {
        customerCommerceAvailable: true,
      },
    );
    const product = (merchantId: string, name: string, price: number, stock: number | null) =>
      db.product.create({
        data: {
          merchantId,
          name,
          sku: `${name.replace(/\W/g, '')}-${run}-${merchantId.slice(0, 3)}`,
          unitPriceMinor: price,
          currency: 'USD',
          stockQuantity: stock,
          reorderLevel: stock === null ? null : 1,
        },
      });
    basketId = (await product(shop, 'Handmade Basket', 1200, 5)).id;
    await product(shop, 'Barkcloth Wallet', 1800, null);
    await product(shop, 'Banana Fibre Mat', 900, 0);
    await product(otherShop, 'Jinja Drum', 4000, 10);
  });

  afterAll(async () => {
    await container.db.order.deleteMany({ where: { merchantId: { in: [shop, otherShop] } } });
    await container.db.merchant.deleteMany({ where: { id: { in: [shop, otherShop] } } });
    await app.close();
    await container.close();
  });

  describe('cart', () => {
    it('adds products by number and by "add N" after viewing one', async () => {
      await say(jane, 'hi');
      const list = await say(jane, '1');
      expect(list).toContain('3. Handmade Basket — $12.00 · In stock');
      await say(jane, '3');
      const added = await say(jane, 'add 2');
      expect(added).toContain('✅ Added: Handmade Basket (now 2 in your cart)');
      expect(added).toContain('1. Handmade Basket × 2 — $24.00');
      await say(jane, '1');
      const wallet = await say(jane, 'add 1 of 2');
      expect(wallet).toContain('2. Barkcloth Wallet × 1 — $18.00');
      expect(wallet).toContain('Subtotal: *$42.00*');
    });

    it('refuses out-of-stock products and more than the shop can offer, without revealing stock', async () => {
      await say(jane, '1');
      expect(await say(jane, 'add 1 of 1')).toContain('Banana Fibre Mat is out of stock');
      const tooMany = await say(jane, 'add 4 of 3');
      expect(tooMany).toContain("we can't offer that many Handmade Basket");
      expect(tooMany).not.toMatch(/\b5\b|\b3 left\b/);
      expect(await say(jane, 'add 30 of 2')).toContain('quantity between 1 and 20');
    });

    it('removes items and shows the cart', async () => {
      const removed = await say(jane, 'remove 2');
      expect(removed).toContain('Removed Barkcloth Wallet');
      const cart = await say(jane, 'cart');
      expect(cart).toContain('1. Handmade Basket × 2 — $24.00');
      expect(cart).not.toContain('Wallet');
      // The open cart is not an order for the merchant yet.
      const orders = await container.orders.list(shop);
      expect(orders.map((o) => o.customer.whatsappId)).not.toContain(jane);
    });
  });

  describe('checkout and payment', () => {
    it('collects name, delivery and address, then shows the summary', async () => {
      expect(await say(jane, 'checkout')).toContain('What name should we put on your order?');
      expect(await say(jane, 'x')).toContain('Please send just your name');
      const method = await say(jane, 'Jane Achieng');
      expect(method).toContain('*1* Delivery ($5.00)');
      expect(method).toContain('*2* Pick up — Shop 4, Kampala Road, 9–6');
      expect(await say(jane, '1')).toContain('Where should we deliver?');
      const summary = await say(jane, 'Plot 5, Kampala Road, near the mosque');
      expect(summary).toContain('• Handmade Basket × 2 — $24.00');
      expect(summary).toContain('Delivery: $5.00 to Plot 5, Kampala Road, near the mosque');
      expect(summary).toContain('*Total: $29.00*');
      expect(summary).toContain('Name: Jane Achieng');
      expect(summary).toContain('Reply *ORDER*');
      expect((await customerOf(jane)).name).toBe('Jane Achieng');
    });

    it('shows the new total when a price changed before ORDER', async () => {
      await container.db.product.update({
        where: { id: basketId },
        data: { unitPriceMinor: 1300 },
      });
      const changed = await say(jane, 'ORDER');
      expect(changed).toContain('Something changed');
      expect(changed).toContain('*Total: $31.00*');
      expect(paypal.created).toHaveLength(0);
    });

    it('places the order once and sends the PayPal link (backend amounts only)', async () => {
      const placed = await say(jane, 'order');
      expect(placed).toMatch(/Order ORD-[A-Z0-9]{6} placed!\* Total: \*\$31\.00\*/);
      expect(placed).toContain('https://www.sandbox.paypal.com/checkoutnow?token=');
      const [order] = await ordersOf(jane);
      expect(order).toMatchObject({
        status: 'AWAITING_PAYMENT',
        placedBy: 'CUSTOMER',
        subtotalMinor: 2600,
        shippingMinor: 500,
        totalMinor: 3100,
        deliveryMethod: 'DELIVERY',
        contactName: 'Jane Achieng',
      });
      expect(order!.customerConfirmedAt).not.toBeNull();
      expect(paypal.created).toHaveLength(1);
      expect(paypal.created[0]).toMatchObject({
        total: '31.00',
        shipping: '5.00',
        referenceId: order!.reference,
      });
      expect(sender.to(admin).at(-1)).toContain(`🛒 *New WhatsApp order ${order!.reference}*`);

      // A repeated ORDER (or a resent WhatsApp message) never creates a second order or link.
      const again = await say(jane, 'ORDER');
      expect(again).not.toContain('placed!');
      expect(paypal.created).toHaveLength(1);
      expect(await ordersOf(jane)).toHaveLength(1);
    });

    it('reserves stock for unpaid orders so other customers can’t oversell', async () => {
      await say(bob, 'hi');
      await say(bob, '1');
      expect(await say(bob, 'add 4 of 3')).toContain("can't offer that many");
      expect(await say(bob, 'add 3 of 3')).toContain('Handmade Basket × 3');
    });

    it('completes only with verified PayPal capture: confirms to the customer, notifies admins, deducts stock once', async () => {
      const [order] = await ordersOf(jane);
      const token = order!.payments[0]!.externalId!;
      await app.inject({ method: 'GET', url: `/api/paypal/return?token=${token}` });
      await app.inject({ method: 'GET', url: `/api/paypal/return?token=${token}` }); // replay
      const paid = await container.db.order.findUniqueOrThrow({ where: { id: order!.id } });
      expect(paid.status).toBe('PAID');
      expect((await basket()).stockQuantity).toBe(3);
      expect(
        await container.db.stockMovement.count({ where: { orderId: order!.id, type: 'SALE' } }),
      ).toBe(1);
      const toJane = sender.to(jane);
      expect(toJane.filter((t) => t.includes('Payment received — thank you!'))).toHaveLength(1);
      expect(toJane.join('\n')).not.toMatch(/Low stock|Out of stock|reorder/i);
      expect(sender.to(admin).join('\n')).toContain('Payment received');
    });

    it('shows the customer only their own orders and their status', async () => {
      const mine = await say(jane, 'orders');
      expect(mine).toMatch(/ORD-[A-Z0-9]{6} · \$31\.00 · paid ✅ · being prepared/);
      const [order] = await ordersOf(jane);
      await container.db.shipment.create({
        data: { merchantId: shop, orderId: order!.id, carrier: 'DHL', trackingNumber: '123456789' },
      });
      expect(await say(jane, 'where is my order?')).toContain('shipped 🚚 DHL 123456789');
      const bobs = await say(bob, 'my orders');
      expect(bobs).toContain("You don't have any orders yet");
      expect(bobs).not.toContain(order!.reference);
    });
  });

  describe('edge cases', () => {
    it('handles two ORDERs at the same time: one order, one PayPal link', async () => {
      const shopper = `25678${digits}7@c.us`;
      await say(shopper, 'hi');
      await say(shopper, '1');
      await say(shopper, 'add 1 of 2');
      await say(shopper, 'checkout');
      await say(shopper, 'Ali');
      await say(shopper, '2'); // pick up
      const before = paypal.created.length;
      const [a, b] = await Promise.all([say(shopper, 'ORDER'), say(shopper, 'ORDER')]);
      expect([a, b].filter((t) => t.includes('placed!'))).toHaveLength(1);
      expect(paypal.created.length - before).toBe(1);
      const orders = await ordersOf(shopper);
      expect(orders).toHaveLength(1);
      expect(orders[0]).toMatchObject({
        deliveryMethod: 'PICKUP',
        shippingMinor: 0,
        totalMinor: 1800,
      });
    });

    it('retries after a PayPal failure without a duplicate order', async () => {
      const shopper = `25678${digits}8@c.us`;
      await say(shopper, 'hi');
      await say(shopper, '1');
      await say(shopper, 'add 1 of 2');
      await say(shopper, 'checkout');
      await say(shopper, 'Musa');
      await say(shopper, '2');
      paypal.failNextCreate = new ProviderError('paypal', 'INTERNAL_SERVER_ERROR: try later');
      expect(await say(shopper, 'ORDER')).toContain("PayPal didn't respond");
      const retry = await say(shopper, 'ORDER');
      expect(retry).toContain('placed!');
      const [order] = await ordersOf(shopper);
      expect(order!.payments.map((p) => p.status)).toEqual(['FAILED', 'CREATED']);
      expect(order!.status).toBe('AWAITING_PAYMENT');
    });

    it('expires carts after 48 hours', async () => {
      const shopper = `25678${digits}9@c.us`;
      await say(shopper, 'hi');
      await say(shopper, '1');
      await say(shopper, 'add 1 of 2');
      const customer = await customerOf(shopper);
      await container.db.order.updateMany({
        where: { customerId: customer.id, status: 'DRAFT' },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect(await say(shopper, 'cart')).toContain('Your cart is empty');
      const [expired] = await ordersOf(shopper);
      expect(expired!.status).toBe('CANCELLED');
    });

    it('limits unpaid orders per customer', async () => {
      const shopper = `25678${digits}0@c.us`;
      await say(shopper, 'hi');
      const customer = await customerOf(shopper);
      for (let i = 0; i < 3; i++)
        await container.db.order.create({
          data: {
            reference: `ORD-U${run.slice(0, 4).toUpperCase()}${i}`,
            merchantId: shop,
            customerId: customer.id,
            status: 'AWAITING_PAYMENT',
            placedBy: 'CUSTOMER',
            customerConfirmedAt: new Date(),
            currency: 'USD',
            subtotalMinor: 100,
            totalMinor: 100,
            source: 'whatsapp',
          },
        });
      await say(shopper, '1');
      expect(await say(shopper, 'add 1 of 2')).toContain('You have 3 unpaid orders');
    });

    it('keeps shops apart: another shop’s product can never be added', async () => {
      const drum = await container.db.product.findFirstOrThrow({
        where: { merchantId: otherShop },
      });
      const customer = await customerOf(jane);
      await expect(
        container.shopOrders.add(
          { merchant: { id: shop, businessName: 'x' }, customer, conversationId: 'x' },
          drum.id,
          1,
        ),
      ).rejects.toThrow(/not found/i);
      // The same person on the other shop's number is a different customer with an empty cart.
      const reply = await send(jane, 'cart', { recipientId: otherBot });
      expect(reply.replies[0]!.text).toContain('Your cart is empty');
    });

    it('approval mode: the order waits for an owner, then the link goes to the customer', async () => {
      await setAccount({ paymentLinkMode: 'APPROVAL' });
      const shopper = `25679${digits}1@c.us`;
      await say(shopper, 'hi');
      await say(shopper, '1');
      await say(shopper, 'add 1 of 2');
      await say(shopper, 'checkout');
      await say(shopper, 'Grace');
      await say(shopper, '2');
      const before = paypal.created.length;
      const placed = await say(shopper, 'ORDER');
      expect(placed).toContain('The shop will confirm it and send your secure PayPal payment link');
      expect(paypal.created.length).toBe(before);
      const [order] = await ordersOf(shopper);
      expect(order).toMatchObject({ status: 'DRAFT' });
      expect(order!.customerConfirmedAt).not.toBeNull();
      expect(sender.to(admin).at(-1)).toContain(`request payment for ${order!.reference}`);

      model.enqueue(
        () => ({
          role: 'assistant',
          content: null,
          toolCalls: [
            {
              id: 'rp',
              name: 'request_payment',
              arguments: JSON.stringify({ order_reference: order!.reference }),
            },
          ],
        }),
        () => ({ role: 'assistant', content: 'ok' }),
      );
      const proposal = await say(admin, `request payment for ${order!.reference}`);
      const code = /CONFIRM (\d{4})/.exec(proposal)![1];
      await say(admin, `CONFIRM ${code}`);
      expect((await ordersOf(shopper))[0]!.status).toBe('AWAITING_PAYMENT');
      expect(sender.to(shopper).at(-1)).toContain('Pay securely with PayPal');
      await setAccount({ paymentLinkMode: 'AUTO' });
    });

    it('the assistant can fill the cart but never place the order', async () => {
      const shopper = `25679${digits}2@c.us`;
      await say(shopper, 'hi');
      model.enqueue(
        (req) => {
          expect(req.tools?.map((t) => t.name)).not.toContain('request_payment');
          return {
            role: 'assistant',
            content: null,
            toolCalls: [
              { id: 'a1', name: 'add_to_cart', arguments: '{"product":"wallet","quantity":2}' },
            ],
          };
        },
        () => ({
          role: 'assistant',
          content: null,
          toolCalls: [{ id: 'a2', name: 'start_checkout', arguments: '{}' }],
        }),
        () => ({ role: 'assistant', content: 'Your order is placed and paid!' }),
      );
      const reply = await say(shopper, 'I want two wallets please, then checkout');
      // The backend's checkout prompt is the reply, not the model's claim.
      expect(reply).toContain('What name should we put on your order?');
      expect(reply).not.toContain('placed and paid');
      const [cart] = await ordersOf(shopper);
      expect(cart).toMatchObject({
        status: 'DRAFT',
        customerConfirmedAt: null,
        subtotalMinor: 3600,
      });
    });
  });
});

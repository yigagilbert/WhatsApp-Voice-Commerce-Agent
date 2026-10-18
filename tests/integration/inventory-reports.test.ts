/**
 * Inventory, analytics charts and the WhatsApp connection API against a real Postgres, with
 * simulated PayPal and a scripted LLM:
 *   - a paid order reduces stock exactly once (ledger), and a low-stock alert is sent once;
 *   - merchants restock / count / add and update products through the agent's tools;
 *   - charts are rendered from trusted data and returned as WhatsApp images with captions;
 *   - the WhatsApp session endpoints require the dashboard login.
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
import type { AgentContext } from '../../apps/api/src/modules/agent/tools';
import { FakePayPal, ScriptedChatModel, testEnv } from '../support/fakes';

loadEnvFile();

const run = randomUUID().slice(0, 8);
const merchantId = `inv_merchant_${run}`;
const operatorChat = `1777${run}@c.us`;
const dashboard = {
  authorization: 'Bearer test-dashboard-token-123456',
  'x-merchant-id': merchantId,
};

class RecordingSender implements ChannelSender {
  readonly channel = 'whatsapp' as const;
  readonly sent: OutboundChannelMessage[] = [];
  async send(message: OutboundChannelMessage) {
    this.sent.push(message);
  }
}

describe('inventory, charts and WhatsApp session (integration)', () => {
  const paypal = new FakePayPal(`INV-${run}`);
  const sender = new RecordingSender();
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
    return res.json() as {
      replies: { text: string; media?: { mimeType: string; dataBase64: string } }[];
    };
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
  const basket = () =>
    container.db.product.findFirstOrThrow({ where: { merchantId, name: 'Handmade Basket' } });
  const alerts = () => sender.sent.filter((m) => /Low stock|Out of stock/.test(m.text));

  /** Draft → CONFIRM → buyer return: a paid order for `quantity` baskets. */
  const sell = async (quantity: number) => {
    scriptTool('create_draft_order', {
      customer: { name: 'Sarah' },
      items: [{ name: 'handmade baskets', quantity }],
    });
    const draft = (await send(`Create an order for Sarah for ${quantity} baskets.`)).replies[0]!
      .text;
    const reference = /ORD-[A-Z0-9]{6}/.exec(draft)![0];
    await send(`CONFIRM ${/CONFIRM (\d{4})/.exec(draft)![1]}`);
    const payment = await container.db.payment.findFirstOrThrow({
      where: { order: { reference } },
    });
    await app.inject({ method: 'GET', url: `/api/paypal/return?token=${payment.externalId}` });
    return { reference, payment };
  };

  beforeAll(async () => {
    const channels = new ChannelRegistry();
    channels.register(sender);
    const config = parseConfig(apiSchema, testEnv());
    container = createContainer(config, createLogger({ name: 'it-inv', level: 'silent' }), {
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
        businessName: 'Inventory Crafts',
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
        sku: `IB-${run}`,
        unitPriceMinor: 1200,
        currency: 'USD',
        stockQuantity: 40,
        reorderLevel: 30,
      },
    });
    await db.product.create({
      data: {
        merchantId,
        name: 'Barkcloth Wallet',
        sku: `IW-${run}`,
        unitPriceMinor: 1800,
        currency: 'USD',
      },
    });
    await db.customer.create({ data: { merchantId, name: 'Sarah Thompson' } });
  });

  afterAll(async () => {
    await container.db.order.deleteMany({ where: { merchantId } });
    await container.db.merchant.delete({ where: { id: merchantId } });
    await app.close();
    await container.close();
  });

  it('reduces stock once when an order is paid, and alerts once when it falls below the reorder level', async () => {
    const { reference, payment } = await sell(15);
    expect((await basket()).stockQuantity).toBe(25);
    const moves = await container.db.stockMovement.findMany({ where: { merchantId } });
    expect(moves).toEqual([
      expect.objectContaining({
        type: 'SALE',
        quantity: -15,
        balanceAfter: 25,
        note: `Order ${reference}`,
      }),
    ]);
    expect(alerts().map((a) => a.text)).toEqual([
      expect.stringContaining('⚠️ *Low stock:* Handmade Basket — 25 left (reorder level 30).'),
    ]);

    // Replays (return URL again, webhook) never reduce stock or alert twice.
    await app.inject({ method: 'GET', url: `/api/paypal/return?token=${payment.externalId}` });
    await container.payments.markCompleted(payment.id, 'CAP-again');
    expect((await basket()).stockQuantity).toBe(25);
    expect(await container.db.stockMovement.count({ where: { merchantId } })).toBe(1);
    expect(alerts()).toHaveLength(1);

    // A second sale while still low does not repeat the alert.
    await sell(1);
    expect((await basket()).stockQuantity).toBe(24);
    expect(alerts()).toHaveLength(1);
  });

  it('answers "which products are running low?" from the ledgered stock', async () => {
    const report = await container.inventory.report(merchantId);
    expect(report.find((r) => r.name === 'Handmade Basket')).toMatchObject({
      stock: 24,
      reorderLevel: 30,
      status: 'LOW',
      unitsSoldLastPeriod: 16,
    });
    expect(report.find((r) => r.name === 'Barkcloth Wallet')).toMatchObject({
      status: 'NOT_TRACKED',
    });
  });

  it('records a restock through the agent and re-arms the low-stock alert', async () => {
    scriptTool(
      'adjust_stock',
      { product: 'baskets', change: 50, reason: 'restock' },
      'Added 50 baskets.',
    );
    await send('I just received 50 baskets.');
    const after = await basket();
    expect(after.stockQuantity).toBe(74);
    expect(after.lowStockAlertedAt).toBeNull();
    const restock = await container.db.stockMovement.findFirstOrThrow({
      where: { merchantId, type: 'RESTOCK' },
    });
    expect(restock).toMatchObject({ quantity: 50, balanceAfter: 74, actor: 'MERCHANT' });
    expect(
      await container.db.auditEvent.count({ where: { merchantId, type: 'inventory.adjusted' } }),
    ).toBe(1);

    // Selling below the level again alerts again (new crossing).
    await sell(50);
    expect(alerts()).toHaveLength(2);
    expect(alerts()[1]!.text).toContain('24 left');
  });

  it('refuses stock below zero and conflicting inputs', async () => {
    await expect(
      container.inventory.adjust({
        merchantId,
        product: 'Handmade Basket',
        change: -500,
        type: 'DAMAGED',
      }),
    ).rejects.toThrow('would go below zero');
    await expect(
      container.inventory.adjust({
        merchantId,
        product: 'Handmade Basket',
        change: 1,
        setTo: 5,
        type: 'ADJUSTMENT',
      }),
    ).rejects.toThrow('not both');
    expect((await basket()).stockQuantity).toBe(24);
  });

  it('adds and updates products (typed), refuses prices from voice, audits changes', async () => {
    scriptTool('add_product', { name: 'Kitenge Tote', price: 22.5, stock: 10, reorder_level: 3 });
    await send('Add a product Kitenge Tote at $22.50, 10 in stock, reorder at 3.');
    const tote = await container.db.product.findFirstOrThrow({
      where: { merchantId, name: 'Kitenge Tote' },
    });
    expect(tote).toMatchObject({ unitPriceMinor: 2250, stockQuantity: 10, reorderLevel: 3 });

    scriptTool('update_product', { product: 'tote', price: 25 });
    await send('Change the tote price to $25.');
    expect(
      (await container.db.product.findUniqueOrThrow({ where: { id: tote.id } })).unitPriceMinor,
    ).toBe(2500);
    const types = (
      await container.db.auditEvent.findMany({ where: { merchantId, entityId: tote.id } })
    ).map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining(['product.created', 'product.updated', 'inventory.adjusted']),
    );

    const conversation = await container.db.conversation.findFirstOrThrow({
      where: { merchantId },
    });
    const merchant = await container.db.merchant.findUniqueOrThrow({ where: { id: merchantId } });
    const voiceCtx: AgentContext = {
      merchant,
      conversation,
      channel: 'whatsapp',
      proposals: [],
      notices: [],
      fromVoice: true,
    };
    const result = await container.tools.execute(
      'update_product',
      JSON.stringify({ product: 'tote', price: 1 }),
      voiceCtx,
    );
    expect(result.ok).toBe(false);
    expect(
      (await container.db.product.findUniqueOrThrow({ where: { id: tote.id } })).unitPriceMinor,
    ).toBe(2500);
  });

  it('sends charts as WhatsApp images with a backend-written caption', async () => {
    scriptTool('send_chart', { chart: 'stock_levels' }, 'Here are your stock levels.');
    const { replies } = await send('Send me a chart of my stock levels.');
    expect(replies).toHaveLength(2);
    expect(replies[0]!.media?.mimeType).toBe('image/png');
    expect(Buffer.from(replies[0]!.media!.dataBase64, 'base64').subarray(1, 4).toString()).toBe(
      'PNG',
    );
    expect(replies[0]!.text).toContain('Handmade Basket 24 (reorder at 30)');
    expect(replies[1]!.text).toBe('Here are your stock levels.');

    scriptTool('send_chart', { chart: 'revenue_trend', days: 7 }, 'Revenue for the week.');
    const trend = await send('Show me a revenue graph for the last 7 days.');
    expect(trend.replies[0]!.text).toMatch(/^📈 Revenue per day, last 7 days: \$\d/);
    const stored = await container.db.message.findMany({
      where: { content: { startsWith: '[chart image]' }, conversation: { merchantId } },
    });
    expect(stored).toHaveLength(2); // the transcript records the chart, not its bytes
  });

  it('compares a period with the same span before, computing the change in the backend', async () => {
    const merchant = await container.db.merchant.findUniqueOrThrow({ where: { id: merchantId } });
    const cmp = await container.analytics.compareSales(merchant, 'this_week');
    expect(cmp.comparedWith).toBe('last week (same days)');
    expect(cmp.byCurrency[0]).toMatchObject({
      currency: 'USD',
      revenue: '$792.00',
      paidOrders: 3,
      previousRevenue: '$0.00',
      changePercent: null,
    });
  });

  it('keeps the WhatsApp connection (and its QR) behind the dashboard login', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/whatsapp/session' })).statusCode).toBe(
      401,
    );
    expect(
      (await app.inject({ method: 'POST', url: '/api/whatsapp/session/logout' })).statusCode,
    ).toBe(401);
    const res = await app.inject({
      method: 'GET',
      url: '/api/whatsapp/session',
      headers: dashboard,
    });
    expect(res.statusCode).toBe(503); // no worker configured in tests
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

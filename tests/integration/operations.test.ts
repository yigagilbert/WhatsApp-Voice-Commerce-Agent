/**
 * Post-payment operations against a real Postgres, with SIMULATED PayPal (tests/support/fakes.ts
 * mirrors the Orders v2 tracking and Disputes v1 contracts) and a scripted LLM:
 *   shipment tracking: SHIP confirmation, wrong/expired/reused codes, unpaid/invalid orders,
 *   PayPal failure, idempotency;
 *   disputes: webhook → canonical fetch → link → notify once, evidence, draft-only preparation,
 *   SUBMIT confirmation, single submission, provider-state check.
 *
 * Run: pnpm test:integration
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { apiSchema, loadEnvFile, parseConfig } from '@vca/config';
import {
  NotFoundError,
  PolicyViolationError,
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
const merchantId = `ops_merchant_${run}`;
const operatorChat = `1999${run}@c.us`;
const dashboard = {
  authorization: 'Bearer test-dashboard-token-123456',
  'x-merchant-id': merchantId,
};
const signatureHeaders = {
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-cert-url': 'https://api.sandbox.paypal.com/cert',
  'paypal-transmission-id': 'tid',
  'paypal-transmission-sig': 'sig',
  'paypal-transmission-time': new Date().toISOString(),
};

class RecordingSender implements ChannelSender {
  readonly channel = 'whatsapp' as const;
  readonly sent: OutboundChannelMessage[] = [];
  async send(message: OutboundChannelMessage) {
    this.sent.push(message);
  }
}

describe('shipments and disputes (integration)', () => {
  const paypal = new FakePayPal(`OPS-${run}`);
  const sender = new RecordingSender();
  const model = new ScriptedChatModel([]);
  let container: Container;
  let app: FastifyInstance;

  const text = async (body: string) => {
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
    return (res.json() as { replies: { text: string }[] }).replies[0]?.text ?? '';
  };
  /** Scripts one tool call, then a filler reply (replaced by the backend's prompt on success). */
  const scriptTool = (name: string, args: object, after = 'Done.') =>
    model.enqueue(
      () => ({
        role: 'assistant',
        content: null,
        toolCalls: [{ id: randomUUID().slice(0, 8), name, arguments: JSON.stringify(args) }],
      }),
      () => ({ role: 'assistant', content: after }),
    );
  const codeOf = (reply: string, word: string) =>
    new RegExp(`${word} (\\d{4})`).exec(reply)?.[1] ?? '';
  const webhook = (eventId: string, eventType: string, disputeId: string) =>
    app.inject({
      method: 'POST',
      url: '/api/paypal/webhooks',
      headers: signatureHeaders,
      payload: { id: eventId, event_type: eventType, resource: { dispute_id: disputeId } },
    });
  const notices = () => sender.sent.filter((m) => m.externalChatId === operatorChat);

  let paidRef = '';
  let captureId = '';
  let unpaidRef = '';
  let unshippedPaidRef = '';
  let unshippedCaptureId = '';

  /** Draft → CONFIRM → buyer return (capture): a PAID order. */
  const paidOrder = async (quantity: number) => {
    scriptTool('create_draft_order', {
      customer: { name: 'Sarah' },
      items: [{ name: 'handmade baskets', quantity, unit_price: 12 }],
      shipping: 20,
    });
    const draft = await text(
      `Create an order for Sarah for ${quantity} baskets at $12 and $20 shipping.`,
    );
    const reference = /ORD-[A-Z0-9]{6}/.exec(draft)![0];
    await text(`CONFIRM ${codeOf(draft, 'CONFIRM')}`);
    const payment = await container.db.payment.findFirstOrThrow({
      where: { order: { reference } },
    });
    await app.inject({ method: 'GET', url: `/api/paypal/return?token=${payment.externalId}` });
    const paid = await container.db.payment.findUniqueOrThrow({ where: { id: payment.id } });
    return { reference, captureId: paid.captureId!, paypalOrderId: paid.externalId! };
  };

  beforeAll(async () => {
    const channels = new ChannelRegistry();
    channels.register(sender);
    const config = parseConfig(apiSchema, testEnv());
    container = createContainer(config, createLogger({ name: 'it-ops', level: 'silent' }), {
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
        businessName: 'Ops Crafts',
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
        sku: `OB-${run}`,
        unitPriceMinor: 1200,
        currency: 'USD',
      },
    });
    await db.customer.create({ data: { merchantId, name: 'Sarah Thompson' } });

    ({ reference: paidRef, captureId } = await paidOrder(10));
    ({ reference: unshippedPaidRef, captureId: unshippedCaptureId } = await paidOrder(2));
    scriptTool('create_draft_order', {
      customer: { name: 'Sarah' },
      items: [{ name: 'basket', quantity: 1 }],
    });
    unpaidRef = /ORD-[A-Z0-9]{6}/.exec(await text('Create an order for Sarah for 1 basket.'))![0];
  });

  afterAll(async () => {
    await container.db.dispute.deleteMany({ where: { merchantId } });
    await container.db.order.deleteMany({ where: { merchantId } });
    await container.db.merchant.delete({ where: { id: merchantId } });
    await app.close();
    await container.close();
  });

  // ─── Shipments ─────────────────────────────────────────────────────────────

  let shipCode = '';

  it('proposes a shipment for a paid order and needs SHIP + code (not CONFIRM, not "yes")', async () => {
    scriptTool('add_shipment_tracking', {
      order_reference: paidRef,
      carrier: 'DHL',
      tracking_number: '1234 5678 9',
    });
    const proposal = await text(`Mark ${paidRef} as shipped with DHL tracking 123456789.`);
    expect(proposal).toContain('*Shipment update*');
    expect(proposal).toContain(`Order: ${paidRef}`);
    expect(proposal).toContain('Carrier: DHL');
    expect(proposal).toContain('Tracking: 123456789');
    shipCode = codeOf(proposal, 'SHIP');
    expect(shipCode).toMatch(/^\d{4}$/);

    expect(await text('yes')).toBe(
      `To approve this, reply *SHIP ${shipCode}* (or *CANCEL*). Nothing has been changed.`,
    );
    expect(await text(`CONFIRM ${shipCode}`)).toContain(`reply *SHIP ${shipCode}*`);
    const wrong = shipCode === '1111' ? '2222' : '1111';
    expect(await text(`SHIP ${wrong}`)).toContain(
      "That code doesn't match the pending request. Reply *SHIP",
    );
    expect(paypal.trackingCalls).toHaveLength(0);
  });

  it('sends tracking to PayPal on SHIP, verifies the tracker, records the shipment', async () => {
    const reply = await text(`SHIP ${shipCode}`);
    expect(reply).toContain('📦 *Shipment updated*');
    expect(reply).toContain('Tracking has been updated with PayPal.');
    expect(paypal.trackingCalls).toEqual([
      expect.objectContaining({
        captureId,
        trackingNumber: '123456789',
        carrier: 'DHL',
        notifyPayer: false,
      }),
    ]);
    const order = await container.db.order.findUniqueOrThrow({
      where: { reference: paidRef },
      include: { shipments: true },
    });
    expect(order.status).toBe('PAID'); // payment state untouched
    expect(order.fulfillmentStatus).toBe('SHIPPED');
    expect(order.shipments).toHaveLength(1);
    expect(order.shipments[0]).toMatchObject({
      carrier: 'DHL',
      trackingNumber: '123456789',
      providerTrackerId: `${captureId}-123456789`,
    });
    expect(
      await container.db.auditEvent.count({
        where: { merchantId, type: 'shipment.tracking_added' },
      }),
    ).toBe(1);
  });

  it('never repeats a shipment: a reused SHIP code or the same tracking again', async () => {
    const again = await text(`SHIP ${shipCode}`);
    expect(again).toContain('That tracking was already added');
    expect(paypal.trackingCalls).toHaveLength(1);
    await expect(
      container.shipments.prepare(
        { id: merchantId },
        { orderReference: paidRef, carrier: 'DHL', trackingNumber: '123456789' },
      ),
    ).rejects.toThrow('already has tracking 123456789');
    expect(await container.db.shipment.count({ where: { merchantId } })).toBe(1);
  });

  it('answers "where is it?" from stored shipment data', async () => {
    const { order, shipments } = await container.shipments.statusFor(merchantId, paidRef);
    expect(order.reference).toBe(paidRef);
    expect(shipments.map((s) => s.trackingNumber)).toEqual(['123456789']);
  });

  it('refuses tracking for unpaid and unknown orders, without touching PayPal', async () => {
    await expect(
      container.shipments.prepare(
        { id: merchantId },
        { orderReference: unpaidRef, carrier: 'UPS', trackingNumber: '1Z999AA10123456784' },
      ),
    ).rejects.toThrow(PolicyViolationError);
    await expect(
      container.shipments.prepare(
        { id: merchantId },
        { orderReference: 'ORD-NOPE00', carrier: 'UPS', trackingNumber: '1Z999AA10123456784' },
      ),
    ).rejects.toThrow(NotFoundError);
    expect(paypal.trackingCalls).toHaveLength(1);
  });

  it('expired SHIP codes do nothing', async () => {
    scriptTool('add_shipment_tracking', {
      order_reference: unshippedPaidRef,
      carrier: 'Posta Uganda',
      tracking_number: 'PU-55501',
    });
    const proposal = await text(
      `${unshippedPaidRef} shipped with Posta Uganda, tracking PU-55501.`,
    );
    expect(proposal).toContain('Carrier: Posta Uganda');
    const code = codeOf(proposal, 'SHIP');
    await container.db.actionConfirmation.updateMany({
      where: { merchantId, status: 'PENDING' },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await text(`SHIP ${code}`)).toContain('expired');
    expect(paypal.trackingCalls).toHaveLength(1);
  });

  it('keeps the order unchanged when PayPal rejects the tracking', async () => {
    scriptTool('add_shipment_tracking', {
      order_reference: unshippedPaidRef,
      carrier: 'Posta Uganda',
      tracking_number: 'PU-55501',
    });
    const code = codeOf(
      await text(`${unshippedPaidRef} shipped with Posta Uganda, tracking PU-55501.`),
      'SHIP',
    );
    paypal.failNextTracking = new ProviderError('paypal', 'UNPROCESSABLE_ENTITY', {
      details: { status: 422, name: 'UNPROCESSABLE_ENTITY', issues: ['CAPTURE_STATUS_NOT_VALID'] },
    });
    const reply = await text(`SHIP ${code}`);
    expect(reply).toContain(`I couldn't update tracking for ${unshippedPaidRef}.`);
    expect(reply).toContain('The order is unchanged.');
    const order = await container.db.order.findUniqueOrThrow({
      where: { reference: unshippedPaidRef },
    });
    expect(order.fulfillmentStatus).toBe('NOT_SHIPPED');
    expect(await container.db.shipment.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('reports the shipping backlog for the dashboard', async () => {
    const ops = await container.analytics.operations(merchantId);
    expect(ops).toMatchObject({ awaitingShipment: 1, shipped: 1 });
    const res = await app.inject({ method: 'GET', url: '/api/orders', headers: dashboard });
    const rows = res.json() as {
      reference: string;
      fulfillmentStatus: string;
      shipments: unknown[];
    }[];
    expect(rows.find((r) => r.reference === paidRef)).toMatchObject({
      fulfillmentStatus: 'SHIPPED',
    });
    expect(rows.find((r) => r.reference === paidRef)!.shipments).toHaveLength(1);
  });

  // ─── Disputes ──────────────────────────────────────────────────────────────

  const disputeId = `PP-D-${run}`;
  const unlinkedDisputeId = `PP-D-X${run}`;

  it('stores a new dispute from a verified webhook, linked to the paid order, and notifies once', async () => {
    paypal.disputes.set(disputeId, {
      dispute_id: disputeId,
      create_time: new Date().toISOString(),
      update_time: new Date().toISOString(),
      reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      status: 'OPEN',
      dispute_life_cycle_stage: 'INQUIRY',
      dispute_amount: { currency_code: 'USD', value: '140.00' },
      seller_response_due_date: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      disputed_transactions: [{ seller_transaction_id: captureId }],
      messages: [{ posted_by: 'BUYER', content: 'I never received my baskets.' }],
    });
    const before = notices().length;
    const res = await webhook(`WH-D1-${run}`, 'CUSTOMER.DISPUTE.CREATED', disputeId);
    expect(res.json()).toMatchObject({ outcome: 'processed' });

    const dispute = await container.db.dispute.findUniqueOrThrow({
      where: { paypalDisputeId: disputeId },
      include: { order: true },
    });
    expect(dispute).toMatchObject({
      merchantId,
      reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      status: 'OPEN',
      amountMinor: 14_000,
      currency: 'USD',
      buyerMessage: 'I never received my baskets.',
    });
    expect(dispute.order?.reference).toBe(paidRef);
    const sent = notices().slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('⚠️ *New PayPal dispute*');
    expect(sent[0]!.text).toContain(`Order: ${paidRef}`);
    expect(sent[0]!.text).toContain('Amount: $140.00');
    expect(sent[0]!.text).toContain('Reason: Item not received');

    // Redelivery (same event) and an update without a status change: no duplicates.
    expect(
      (await webhook(`WH-D1-${run}`, 'CUSTOMER.DISPUTE.CREATED', disputeId)).json(),
    ).toMatchObject({ outcome: 'duplicate' });
    await webhook(`WH-D2-${run}`, 'CUSTOMER.DISPUTE.UPDATED', disputeId);
    expect(notices().length).toBe(before + 1);
    expect(await container.db.dispute.count({ where: { paypalDisputeId: disputeId } })).toBe(1);
    expect(
      await container.db.auditEvent.count({
        where: { type: 'dispute.opened', entityId: dispute.id },
      }),
    ).toBe(1);
  });

  it('notifies when the dispute needs the merchant’s response', async () => {
    const d = paypal.disputes.get(disputeId)!;
    paypal.disputes.set(disputeId, { ...d, status: 'WAITING_FOR_SELLER_RESPONSE' });
    const before = notices().length;
    await webhook(`WH-D3-${run}`, 'CUSTOMER.DISPUTE.UPDATED', disputeId);
    expect(
      notices()
        .slice(before)
        .map((n) => n.text),
    ).toEqual([expect.stringContaining('⚠️ *PayPal dispute needs your response*')]);
  });

  it('gathers trusted evidence: order, payment, shipment — and says what is missing', async () => {
    const d = await container.disputes.find(merchantId, disputeId);
    const { facts, missing, evidence } = container.disputes.evidenceFor(d);
    expect(facts.map((f) => f.label)).toEqual([
      'Order',
      'Items',
      'Order total',
      'Payment',
      'Shipment',
    ]);
    expect(facts.find((f) => f.label === 'Shipment')!.value).toContain('DHL, tracking 123456789');
    expect(evidence.map((e) => e.label)).toEqual([
      'Order details',
      'Payment confirmation',
      'Shipment tracking',
    ]);
    expect(missing.join(' ')).toContain('Proof of delivery');
  });

  it('flags missing tracking for an unshipped order, and keeps unlinked disputes safe', async () => {
    paypal.disputes.set(unlinkedDisputeId, {
      dispute_id: unlinkedDisputeId,
      reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      status: 'OPEN',
      dispute_amount: { currency_code: 'USD', value: '44.00' },
      disputed_transactions: [{ seller_transaction_id: unshippedCaptureId }],
    });
    await container.disputes.sync(unlinkedDisputeId, { notify: false });
    const d = await container.disputes.find(merchantId, unlinkedDisputeId);
    expect(d.order?.reference).toBe(unshippedPaidRef);
    expect(container.disputes.evidenceFor(d).missing[0]).toContain(
      'No shipment tracking is attached',
    );

    paypal.disputes.set('PP-D-NOMATCH', {
      dispute_id: 'PP-D-NOMATCH',
      reason: 'OTHER',
      status: 'OPEN',
      disputed_transactions: [{ seller_transaction_id: 'UNKNOWNCAPTURE' }],
    });
    const orphan = await container.disputes.sync('PP-D-NOMATCH', { notify: false });
    expect(orphan.orderId).toBeNull();
    await container.db.dispute.delete({ where: { id: orphan.id } });
  });

  let submitCode = '';
  const responseText = `Order ${paidRef} was paid via PayPal and shipped with DHL, tracking number 123456789. The tracking is registered with PayPal.`;

  it('prepares a response as a draft only — nothing is sent to PayPal', async () => {
    scriptTool('prepare_dispute_response', { dispute: disputeId, response_text: responseText });
    const proposal = await text('Prepare a response to the dispute.');
    expect(proposal).toContain('*Proposed dispute response*');
    expect(proposal).toContain(`"${responseText}"`);
    expect(proposal).toContain('✓ Shipment tracking');
    submitCode = codeOf(proposal, 'SUBMIT');
    expect(submitCode).toMatch(/^\d{4}$/);
    expect(paypal.evidenceCalls).toHaveLength(0);
  });

  it('drafts the response from verified records when the model passes no text', async () => {
    const { payload } = await container.disputes.prepareResponse(
      { id: merchantId, timezone: 'UTC' },
      disputeId,
    );
    expect(payload.responseText).toContain(
      `Order ${paidRef} (10 × Handmade Basket, total $140.00) was paid through PayPal on`,
    );
    expect(payload.responseText).toContain(
      'with DHL, tracking number 123456789, which is registered with PayPal.',
    );
    expect(payload.responseText).not.toMatch(/refund|offer/i);
  });

  it('rejects drafts that invent evidence or concede the dispute', async () => {
    await expect(
      container.disputes.prepareResponse(
        { id: merchantId, timezone: 'UTC' },
        disputeId,
        'The item was delivered with tracking 999888777 last week, signed for.',
      ),
    ).rejects.toThrow("999888777, which isn't in Katale's records");
    await expect(
      container.disputes.prepareResponse(
        { id: merchantId, timezone: 'UTC' },
        disputeId,
        'We are happy to offer a full refund to resolve this quickly.',
      ),
    ).rejects.toThrow('cannot offer refunds');
  });

  it('needs SUBMIT + the right code: CONFIRM, "yes" and wrong codes submit nothing', async () => {
    // Re-propose (the rejected drafts above did not replace the pending one).
    expect(await text('yes')).toContain(`reply *SUBMIT ${submitCode}*`);
    expect(await text(`CONFIRM ${submitCode}`)).toContain(`reply *SUBMIT ${submitCode}*`);
    const wrong = submitCode === '1111' ? '2222' : '1111';
    expect(await text(`SUBMIT ${wrong}`)).toContain("doesn't match");
    expect(paypal.evidenceCalls).toHaveLength(0);
  });

  it('submits the approved response once, with tracking evidence', async () => {
    const reply = await text(`SUBMIT ${submitCode}`);
    expect(reply).toContain('✅ *Dispute response submitted*');
    expect(reply).toContain(`Dispute: ${disputeId}`);
    expect(reply).toContain('- Shipment tracking');
    expect(paypal.evidenceCalls).toEqual([
      {
        disputeId,
        evidences: [
          {
            evidence_type: 'PROOF_OF_FULFILLMENT',
            evidence_info: {
              tracking_info: [{ carrier_name: 'DHL', tracking_number: '123456789' }],
            },
            notes: responseText,
          },
        ],
      },
    ]);
    const responses = await container.db.disputeResponse.findMany({ where: { merchantId } });
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ status: 'SUBMITTED', responseText });
    const dispute = await container.db.dispute.findUniqueOrThrow({
      where: { paypalDisputeId: disputeId },
    });
    expect(dispute.status).toBe('UNDER_REVIEW'); // re-read from PayPal after submission

    expect(await text(`SUBMIT ${submitCode}`)).toContain('already submitted');
    expect(paypal.evidenceCalls).toHaveLength(1);
  });

  it('checks PayPal before submitting: no submission when PayPal is not waiting for the seller', async () => {
    const d = paypal.disputes.get(unlinkedDisputeId)!;
    paypal.disputes.set(unlinkedDisputeId, { ...d, status: 'UNDER_REVIEW' });
    scriptTool('prepare_dispute_response', {
      dispute: unlinkedDisputeId,
      response_text: `Order ${unshippedPaidRef} was paid through PayPal; we are preparing the shipment.`,
    });
    const code = codeOf(await text('Respond to the other dispute.'), 'SUBMIT');
    const reply = await text(`SUBMIT ${code}`);
    expect(reply).toContain("isn't accepting evidence");
    expect(paypal.evidenceCalls).toHaveLength(1);
  });

  it('serves disputes to the dashboard with evidence and history', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/disputes', headers: dashboard });
    const body = list.json() as {
      disputes: { paypalDisputeId: string; reasonLabel: string; orderReference: string | null }[];
    };
    expect(body.disputes.find((d) => d.paypalDisputeId === disputeId)).toMatchObject({
      reasonLabel: 'Item not received',
      orderReference: paidRef,
    });
    const detail = await app.inject({
      method: 'GET',
      url: `/api/disputes/${disputeId}`,
      headers: dashboard,
    });
    const d = detail.json() as {
      responses: { status: string }[];
      shipments: unknown[];
      timeline: { type: string }[];
    };
    expect(d.responses.map((r) => r.status)).toEqual(['SUBMITTED']);
    expect(d.shipments).toHaveLength(1);
    expect(d.timeline.map((e) => e.type)).toEqual(
      expect.arrayContaining([
        'payment.completed',
        'shipment.tracking_added',
        'dispute.opened',
        'dispute.response_submitted',
      ]),
    );
    const ops = await container.analytics.operations(merchantId);
    expect(ops.openDisputes).toBe(2);
  });
});

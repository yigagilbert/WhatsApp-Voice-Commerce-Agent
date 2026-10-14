import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Container } from '../../container';
import { renderBuyerPage, type BuyerPage } from './buyer-pages';

const tokenQuery = z.object({ token: z.string().min(1).max(64) });

const CLOSE = 'You can close this page.';

export async function paypalRoutes(app: FastifyInstance, { container }: { container: Container }) {
  const sandbox = container.config.PAYPAL_ENV === 'sandbox';
  const send = (reply: FastifyReply, page: Omit<BuyerPage, 'sandbox'>, status = 200) =>
    reply
      .status(status)
      .type('text/html')
      .header('cache-control', 'no-store')
      .send(renderBuyerPage({ ...page, sandbox }));
  const invalidLink = (reply: FastifyReply) =>
    send(
      reply,
      { tone: 'error', title: 'Link not valid', message: 'This payment link is not valid.' },
      400,
    );
  const notFound = (reply: FastifyReply) =>
    send(
      reply,
      {
        tone: 'error',
        title: 'Payment not found',
        message: "We couldn't find this payment. Please use the link the merchant sent you.",
      },
      404,
    );

  /** PayPal webhooks — authenticated by signature verification, not by token. */
  app.post('/api/paypal/webhooks', async (request, reply) => {
    const outcome = await container.webhooks.handle(request.rawBody ?? '', request.headers);
    return reply.status(200).send({ received: true, outcome });
  });

  /**
   * Buyer is redirected here after approving on PayPal (?token=<PayPal order ID>).
   * We capture server-side using PayPal's own state; query params are never trusted for amounts.
   */
  app.get('/api/paypal/return', async (request, reply) => {
    const query = tokenQuery.safeParse(request.query);
    if (!query.success) return invalidLink(reply);
    const token = query.data.token;
    const view = await container.payments.buyerView(token);
    if (!view) return notFound(reply);

    const processing = {
      tone: 'pending' as const,
      title: 'Payment processing',
      message: `PayPal is confirming your payment. The merchant will be notified as soon as it completes. ${CLOSE}`,
      details: view.details,
    };
    if (!container.config.PAYPAL_CAPTURE_ON_RETURN && view.status !== 'COMPLETED') {
      // Webhook-only capture mode: CHECKOUT.ORDER.APPROVED completes the payment.
      return send(reply, processing);
    }
    try {
      const result = await container.payments.captureApproved(token);
      const after = (await container.payments.buyerView(token)) ?? view;
      switch (result) {
        case 'unknown_order':
          return notFound(reply);
        case 'pending':
          return send(reply, { ...processing, details: after.details });
        case 'failed':
          return send(
            reply,
            {
              tone: 'error',
              title: 'Payment declined',
              message: `PayPal declined the payment, so no money was taken. Please try again with another payment method or contact the merchant.`,
              details: after.details,
            },
            402,
          );
        default:
          // Completed now, or already completed by an earlier callback/webhook.
          if (after.status !== 'COMPLETED')
            return send(reply, { ...processing, details: after.details });
          return send(reply, {
            tone: 'success',
            title: 'Payment successful',
            message: `Thank you! Your payment has been received and the merchant has been notified. ${CLOSE}`,
            details: after.details,
          });
      }
    } catch (error) {
      request.log.error({ err: error }, 'capture on return failed');
      return send(reply, processing, 502);
    }
  });

  /**
   * Buyer left the PayPal checkout without paying. Read-only: a cancel never changes the
   * order or payment, so the original link keeps working.
   */
  app.get('/api/paypal/cancel', async (request, reply) => {
    const query = tokenQuery.safeParse(request.query);
    const view = query.success ? await container.payments.buyerView(query.data.token) : null;
    if (view?.status === 'COMPLETED') {
      return send(reply, {
        tone: 'success',
        title: 'Already paid',
        message: `This order has already been paid. ${CLOSE}`,
        details: view.details,
      });
    }
    const canRetry = view && (view.status === 'CREATED' || view.status === 'APPROVED');
    return send(reply, {
      tone: 'neutral',
      title: 'Payment not completed',
      message: view
        ? `No money was taken. Order ${view.details.reference} is still awaiting payment.`
        : 'No money was taken.',
      details: view?.details,
      action:
        canRetry && view.checkoutUrl
          ? { label: 'Return to PayPal', href: view.checkoutUrl }
          : undefined,
      footnote: canRetry
        ? `You can close this page and pay later using the original payment link.`
        : CLOSE,
    });
  });
}

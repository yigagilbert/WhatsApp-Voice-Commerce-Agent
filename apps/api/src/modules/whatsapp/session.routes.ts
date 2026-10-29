import type { FastifyInstance } from 'fastify';
import { HEADERS, getCorrelationId } from '@vca/shared';
import type { Container } from '../../container';
import { actorLabel, ownerOnly } from '../../http/merchant-scope';

/**
 * The dashboard's view of the WhatsApp connection (status, pairing QR, reconnect, unlink),
 * proxied to the WhatsApp worker's internal gateway. Registered inside the dashboard-auth scope,
 * so the QR — which links a device to the bot's WhatsApp account — is only ever shown to a
 * signed-in operator. Responses are never cached.
 */
export async function whatsappSessionRoutes(
  app: FastifyInstance,
  { container }: { container: Container },
) {
  const { WHATSAPP_GATEWAY_URL: gateway, INTERNAL_SERVICE_TOKEN: token } = container.config;

  const call = async (method: 'GET' | 'POST', path: string) => {
    if (!gateway)
      return {
        status: 503,
        body: { error: { message: 'WhatsApp worker not configured (WHATSAPP_GATEWAY_URL)' } },
      };
    try {
      const res = await fetch(`${gateway.replace(/\/$/, '')}${path}`, {
        method,
        headers: {
          [HEADERS.internalToken]: token,
          [HEADERS.correlationId]: getCorrelationId() ?? '',
        },
        signal: AbortSignal.timeout(5_000),
      });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as unknown };
    } catch {
      return { status: 503, body: { error: { message: 'WhatsApp worker unreachable' } } };
    }
  };

  /** Cached connection health for the dashboard banner (no worker call). */
  app.get('/api/whatsapp/health', async (_request, reply) =>
    reply.header('cache-control', 'no-store').send(container.whatsappMonitor.current),
  );

  app.get('/api/whatsapp/session', async (_request, reply) => {
    const { status, body } = await call('GET', '/internal/session');
    // The full bot number stays server-side (the page shows the masked one).
    const { botId: _botId, ...rest } = (body ?? {}) as Record<string, unknown>;
    return reply.status(status).header('cache-control', 'no-store').send(rest);
  });

  for (const action of ['reconnect', 'logout'] as const) {
    // Unlinking the device takes the shop offline: owners only. Reconnecting is harmless.
    const guard = action === 'logout' ? { preHandler: ownerOnly } : {};
    app.post(`/api/whatsapp/session/${action}`, guard, async (request, reply) => {
      await container.audit.record({
        merchantId: request.merchant.id,
        actor: 'MERCHANT',
        type: `whatsapp.${action}_requested`,
        data: { via: actorLabel(request) },
      });
      const { status, body } = await call('POST', `/internal/session/${action}`);
      return reply.status(status).send(body);
    });
  }
}

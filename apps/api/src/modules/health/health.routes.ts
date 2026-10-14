import type { FastifyInstance } from 'fastify';
import type { Container } from '../../container';

export async function healthRoutes(app: FastifyInstance, { container }: { container: Container }) {
  /** Liveness: the process is up. No dependencies touched. */
  app.get('/api/health', async () => ({
    status: 'ok',
    service: 'api',
    time: new Date().toISOString(),
  }));

  /** Readiness: dependencies reachable, plus which optional providers are configured. */
  app.get('/api/health/ready', async (_request, reply) => {
    let database: 'ok' | 'unavailable' = 'ok';
    try {
      await container.db.$queryRaw`SELECT 1`;
    } catch {
      database = 'unavailable';
    }
    const body = {
      status: database === 'ok' ? 'ok' : 'degraded',
      checks: { database },
      providers: {
        ai: container.chatModel ? container.chatModel.id : 'not_configured',
        speech: container.speech ? 'configured' : 'not_configured',
        paypal: container.paypal.configured ? container.config.PAYPAL_ENV : 'not_configured',
        whatsappGateway: container.config.WHATSAPP_GATEWAY_URL ? 'configured' : 'not_configured',
      },
    };
    return reply.status(database === 'ok' ? 200 : 503).send(body);
  });
}

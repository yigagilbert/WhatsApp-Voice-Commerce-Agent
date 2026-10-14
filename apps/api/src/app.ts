import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { HEADERS, runWithContext } from '@vca/shared';
import type { Container } from './container';
import type {} from './fastify-augment';
import { registerErrorHandler } from './http/errors';
import { registerDashboardScope } from './http/merchant-scope';
import { agentRoutes } from './modules/agent/agent.routes';
import { catalogRoutes } from './modules/catalog/catalog.routes';
import { dashboardRoutes } from './modules/dashboard/dashboard.routes';
import { healthRoutes } from './modules/health/health.routes';
import { ordersRoutes } from './modules/orders/orders.routes';
import { paypalRoutes } from './modules/paypal/paypal.routes';
import { disputesRoutes } from './modules/disputes/disputes.routes';

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export async function buildApp(container: Container): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: container.logger as FastifyBaseLogger,
    bodyLimit: 1024 * 1024,
    // Behind Nginx the client IP comes from X-Forwarded-For (rate limiting, logs).
    trustProxy: container.config.TRUST_PROXY,
    // Reuse an incoming correlation ID (e.g. from the WhatsApp worker) or mint one.
    genReqId: (req) => {
      const incoming = req.headers[HEADERS.correlationId];
      const value = Array.isArray(incoming) ? incoming[0] : incoming;
      return value && CORRELATION_ID_PATTERN.test(value) ? value : crypto.randomUUID();
    },
  });

  // Every log line and audit event emitted while handling this request carries its correlation ID.
  app.addHook('onRequest', (request, reply, done) => {
    reply.header(HEADERS.correlationId, request.id);
    runWithContext({ correlationId: request.id }, done);
  });

  // Keep the raw JSON body: PayPal signature verification needs the exact bytes.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const text = body as string;
    request.rawBody = text;
    if (!text) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      const error = Object.assign(new Error('Malformed JSON body'), {
        statusCode: 400,
        code: 'BAD_REQUEST',
      });
      done(error, undefined);
    }
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: container.config.CORS_ORIGINS });
  await app.register(rateLimit, { max: container.config.RATE_LIMIT_MAX, timeWindow: '1 minute' });

  registerErrorHandler(app);

  // Public / self-authenticating routes.
  await app.register(healthRoutes, { container });
  await app.register(paypalRoutes, { container });
  await app.register(agentRoutes, { container });

  // Dashboard routes: service-token auth + merchant scope (encapsulated plugin).
  await app.register(async (scope) => {
    registerDashboardScope(scope, container);
    await scope.register(catalogRoutes, { container });
    await scope.register(ordersRoutes, { container });
    await scope.register(dashboardRoutes, { container });
    await scope.register(disputesRoutes, { container });
  });

  return app;
}

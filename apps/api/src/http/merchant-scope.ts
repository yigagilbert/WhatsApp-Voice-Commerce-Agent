import type { FastifyInstance } from 'fastify';
import { HEADERS, NotFoundError, getContext } from '@vca/shared';
import type { Container } from '../container';
import { authenticate } from './auth';

/**
 * Hook for dashboard routes: authenticate the dashboard's service token and resolve the
 * merchant. Single-tenant development shortcut: `x-merchant-id` selects a merchant,
 * otherwise the first (seeded) merchant is used. Per-user auth is on the roadmap.
 */
export function registerDashboardScope(app: FastifyInstance, container: Container): void {
  app.decorateRequest('merchant', null as never);
  app.addHook('preHandler', async (request) => {
    authenticate(
      request,
      {
        dashboard: container.config.API_AUTH_TOKEN,
        internal: container.config.INTERNAL_SERVICE_TOKEN,
      },
      ['dashboard'],
    );
    const requested = request.headers['x-merchant-id'];
    const merchantId = Array.isArray(requested) ? requested[0] : requested;
    const merchant = merchantId
      ? await container.db.merchant.findUnique({ where: { id: merchantId } })
      : await container.db.merchant.findFirst({ orderBy: { createdAt: 'asc' } });
    if (!merchant) throw new NotFoundError('Merchant', merchantId ?? '(none — run `pnpm db:seed`)');
    request.merchant = merchant;
    const ctx = getContext();
    if (ctx) ctx.merchantId = merchant.id;
  });
}

export { HEADERS };

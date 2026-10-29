import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ForbiddenError, HEADERS, NotFoundError, UnauthorizedError, getContext } from '@vca/shared';
import type { Container } from '../container';
import { authenticate } from './auth';

/** Headers the dashboard server sends for the signed-in person (from its signed session cookie). */
export const DASHBOARD_USER_HEADER = 'x-dashboard-user';
export const DASHBOARD_SESSION_HEADER = 'x-dashboard-session';

const header = (request: FastifyRequest, name: string) => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/**
 * Hook for dashboard routes: authenticate the dashboard server's service token, then the person.
 *
 * - With dashboard accounts: the session (user ID + session version) must belong to an active
 *   account; its merchant is the request's merchant. Changing a password or deactivating an
 *   account bumps the version, so older sessions stop working on their next request.
 * - Bootstrap (no dashboard account exists yet): the shared setup login acts as the owner of the
 *   first merchant (`x-merchant-id` may pick another, for tests/single-tenant setups). This mode
 *   ends as soon as the first account is created.
 */
export function registerDashboardScope(app: FastifyInstance, container: Container): void {
  app.decorateRequest('merchant', null as never);
  app.decorateRequest('dashboardUser', null as never);
  app.addHook('preHandler', async (request) => {
    authenticate(
      request,
      {
        dashboard: container.config.API_AUTH_TOKEN,
        internal: container.config.INTERNAL_SERVICE_TOKEN,
      },
      ['dashboard'],
    );
    const userId = header(request, DASHBOARD_USER_HEADER);
    let merchant;
    if (userId) {
      const version = Number(header(request, DASHBOARD_SESSION_HEADER));
      const user = Number.isInteger(version)
        ? await container.dashboardUsers.session(userId, version)
        : null;
      if (!user) throw new UnauthorizedError('Your session has ended. Please sign in again.');
      merchant = await container.db.merchant.findUniqueOrThrow({ where: { id: user.merchantId } });
      request.dashboardUser = {
        id: user.id,
        username: user.username,
        role: user.role,
        bootstrap: false,
      };
    } else {
      if ((await container.dashboardUsers.count()) > 0)
        throw new UnauthorizedError('Please sign in with your dashboard account.');
      const requested = header(request, 'x-merchant-id');
      merchant = requested
        ? await container.db.merchant.findUnique({ where: { id: requested } })
        : await container.db.merchant.findFirst({ orderBy: { createdAt: 'asc' } });
      if (!merchant)
        throw new NotFoundError('Merchant', requested ?? '(none — run `pnpm db:seed`)');
      request.dashboardUser = {
        id: 'bootstrap',
        username: 'setup',
        role: 'OWNER',
        bootstrap: true,
      };
    }
    request.merchant = merchant;
    const ctx = getContext();
    if (ctx) ctx.merchantId = merchant.id;
  });
}

/** Route guard: only owners may change admins, accounts and the WhatsApp connection. */
export async function ownerOnly(request: FastifyRequest): Promise<void> {
  if (request.dashboardUser?.role !== 'OWNER')
    throw new ForbiddenError('Only an owner can do this. Ask the shop owner.');
}

/** "who did it" for audit records. */
export const actorLabel = (request: FastifyRequest) =>
  request.dashboardUser?.bootstrap
    ? 'dashboard (setup login)'
    : `dashboard:${request.dashboardUser?.username}`;

export { HEADERS };

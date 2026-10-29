import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ConflictError, ForbiddenError } from '@vca/shared';
import type { Container } from '../../container';
import { actorLabel, ownerOnly } from '../../http/merchant-scope';
import { parse } from '../../http/validation';

const role = z.enum(['OWNER', 'STAFF']);
const createBody = z.object({
  username: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  role,
  password: z.string().min(1).max(200),
});
const updateBody = z.object({
  name: z.string().min(1).max(120).optional(),
  role: role.optional(),
  active: z.boolean().optional(),
  password: z.string().min(1).max(200).optional(),
});
const idParams = z.object({ id: z.string().min(1).max(64) });
const passwordBody = z.object({
  current: z.string().min(1).max(200),
  next: z.string().min(1).max(200),
});

/** Dashboard accounts (owners manage them) and "change my password" (everyone). */
export async function dashboardUserRoutes(
  app: FastifyInstance,
  { container }: { container: Container },
) {
  const users = container.dashboardUsers;

  app.get('/api/auth/me', async (request) => ({
    user: request.dashboardUser,
    merchant: {
      id: request.merchant.id,
      businessName: request.merchant.businessName,
      currency: request.merchant.preferredCurrency,
      timezone: request.merchant.timezone,
    },
    accounts: await users.count(),
  }));

  app.post('/api/auth/password', async (request) => {
    if (request.dashboardUser.bootstrap)
      throw new ForbiddenError('The setup login has no password to change: create your account.');
    const { current, next } = parse(passwordBody, request.body);
    const user = await users.changePassword(request.dashboardUser.id, current, next);
    // The dashboard re-issues its session cookie with the new version; other sessions end.
    return { sessionVersion: user.sessionVersion };
  });

  app.get('/api/dashboard-users', { preHandler: ownerOnly }, async (request) =>
    users.list(request.merchant.id),
  );

  app.post('/api/dashboard-users', { preHandler: ownerOnly }, async (request, reply) => {
    const body = parse(createBody, request.body);
    // The first account replaces the setup login, so it must be an owner.
    if (request.dashboardUser.bootstrap && body.role !== 'OWNER')
      throw new ConflictError('The first account must be an owner.');
    const user = await users.create(request.merchant.id, body, actorLabel(request));
    return reply.status(201).send(user);
  });

  app.patch('/api/dashboard-users/:id', { preHandler: ownerOnly }, async (request) => {
    const { id } = parse(idParams, request.params);
    return users.update(
      request.merchant.id,
      id,
      parse(updateBody, request.body),
      actorLabel(request),
    );
  });
}

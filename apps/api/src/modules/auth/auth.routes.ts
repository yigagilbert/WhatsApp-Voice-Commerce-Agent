import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LOCKOUT_MINUTES, MAX_FAILED_LOGINS } from '@vca/commerce';
import type { Container } from '../../container';
import { authenticate } from '../../http/auth';
import { parse } from '../../http/validation';

const loginBody = z.object({
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(200),
});

/**
 * Dashboard sign-in, called server-to-server by the dashboard (service token), never by browsers:
 * the public proxy doesn't route /api/auth. The answer is deliberately the same for an unknown
 * user, a wrong password, a locked account and a deactivated account.
 */
export async function authRoutes(app: FastifyInstance, { container }: { container: Container }) {
  app.post('/api/auth/login', async (request, reply) => {
    authenticate(
      request,
      {
        dashboard: container.config.API_AUTH_TOKEN,
        internal: container.config.INTERNAL_SERVICE_TOKEN,
      },
      ['dashboard'],
    );
    const { username, password } = parse(loginBody, request.body);
    const result = await container.dashboardUsers.login(username, password);
    if (result.status === 'no_users')
      return reply.status(401).send({
        error: { code: 'NO_ACCOUNTS', message: 'No dashboard accounts exist yet.' },
      });
    if (result.status !== 'ok')
      return reply.status(401).send({
        error: {
          code: 'UNAUTHORIZED',
          message: `Incorrect username or password. After ${MAX_FAILED_LOGINS} wrong attempts an account is locked for ${LOCKOUT_MINUTES} minutes.`,
        },
      });
    const { user } = result;
    return {
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        role: user.role,
        merchantId: user.merchantId,
        sessionVersion: user.sessionVersion,
      },
    };
  });
}

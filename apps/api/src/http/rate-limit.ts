import type { FastifyRequest } from 'fastify';
import { DASHBOARD_USER_HEADER } from './merchant-scope';
import { safeEqual } from './auth';

const DASHBOARD_KEY_PREFIX = 'dashboard:';

/** One dashboard page makes several API calls, so a signed-in person gets more than a visitor. */
const DASHBOARD_MULTIPLIER = 5;

/**
 * Every dashboard request reaches the API from the web server's address, so limiting by address
 * would make all staff share one allowance. Requests carrying the dashboard token are limited per
 * account; the user header only counts with that token, so outsiders can't choose their own key.
 */
export function rateLimitOptions(dashboardToken: string, max: number) {
  return {
    keyGenerator: (request: FastifyRequest) => {
      const header = request.headers.authorization;
      if (!header?.startsWith('Bearer ') || !safeEqual(header.slice(7), dashboardToken))
        return request.ip;
      const user = request.headers[DASHBOARD_USER_HEADER];
      return `${DASHBOARD_KEY_PREFIX}${typeof user === 'string' ? user : 'service'}`;
    },
    max: (_request: FastifyRequest, key: string) =>
      key.startsWith(DASHBOARD_KEY_PREFIX) ? max * DASHBOARD_MULTIPLIER : max,
  };
}

import type { FastifyInstance } from 'fastify';
import { NotFoundError, ValidationError } from '@vca/shared';
import { z } from 'zod';
import type { Container } from '../../container';
import { actorLabel, ownerOnly } from '../../http/merchant-scope';
import { parse } from '../../http/validation';
import { CAPTION_MAX, CTAS, HEADLINE_MAX } from './copy';
import { MAX_TIMES } from './status-ad.service';
import { THEMES } from './status-image';

const idParams = z.object({ id: z.string().min(1).max(64) });
const validTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};
const settingsBody = z.object({
  enabled: z.boolean(),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  times: z
    .array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM'))
    .min(1)
    .max(MAX_TIMES),
  timezone: z.string().max(64).nullable(),
  approval: z.enum(['MANUAL', 'AUTO']),
  publish: z.enum(['PHONE', 'KATALE']).default('PHONE'),
  productIds: z.array(z.string().min(1).max(64)).max(500),
});
/**
 * Per-person limits: dashboard requests all come from the web server's address, so the key is the
 * signed-in account (or the merchant header in setup mode), not the IP.
 */
const perPerson = (max: number) => ({
  rateLimit: {
    max,
    timeWindow: '1 minute',
    keyGenerator: (request: { headers: Record<string, unknown>; ip: string }) =>
      String(request.headers['x-dashboard-user'] ?? request.headers['x-merchant-id'] ?? request.ip),
  },
});
const editBody = z.object({
  headline: z.string().trim().min(1).max(HEADLINE_MAX),
  caption: z
    .string()
    .trim()
    .min(1)
    .max(CAPTION_MAX + 40),
  cta: z.enum(CTAS),
  theme: z
    .number()
    .int()
    .min(0)
    .max(THEMES.length - 1),
});

/**
 * WhatsApp Status adverts (dashboard). Owners change settings; owners and staff prepare, edit,
 * approve, post and record posts. Every query is scoped to the signed-in merchant. Posting goes
 * only to the shop number's own Status, never to customers.
 */
export async function statusAdRoutes(app: FastifyInstance, opts: { container: Container }) {
  const { container } = opts;
  const ads = container.statusAds;

  // Behind STATUS_ADS_ENABLED (off by default): the routes don't exist while it is off.
  app.addHook('preHandler', async (request) => {
    if (request.url.startsWith('/api/status-ads') && !container.config.STATUS_ADS_ENABLED)
      throw new NotFoundError('Route', request.url.split('?')[0]);
  });

  app.get('/api/status-ads/settings', async (request) => ({
    ...(await ads.settings(request.merchant)),
    products: await ads.productChoices(request.merchant.id),
    ctas: CTAS,
    themes: THEMES.map((t) => t.name),
  }));

  app.put('/api/status-ads/settings', { preHandler: ownerOnly }, async (request) => {
    const body = parse(settingsBody, request.body);
    if (body.timezone && !validTimeZone(body.timezone))
      throw new ValidationError(`Unknown time zone '${body.timezone}'.`);
    return ads.saveSettings(request.merchant.id, body, actorLabel(request));
  });

  app.get('/api/status-ads', async (request) => ads.list(request.merchant.id));

  app.post('/api/status-ads/generate', { config: perPerson(6) }, async (request, reply) =>
    reply.status(201).send(await ads.generateNow(request.merchant, actorLabel(request))),
  );

  app.patch('/api/status-ads/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    return ads.edit(request.merchant.id, id, parse(editBody, request.body), actorLabel(request));
  });

  for (const [action, run] of [
    ['approve', ads.approve.bind(ads)],
    ['posted', ads.markPosted.bind(ads)],
    ['skip', ads.skip.bind(ads)],
    ['retry', ads.retry.bind(ads)],
  ] as const)
    app.post(`/api/status-ads/:id/${action}`, async (request) => {
      const { id } = parse(idParams, request.params);
      return run(request.merchant.id, id, actorLabel(request));
    });

  /** Katale posts a ready advert to the shop number's Status now (STATUS_ADS_POSTING_ENABLED). */
  app.post('/api/status-ads/:id/publish', { config: perPerson(6) }, async (request) => {
    const { id } = parse(idParams, request.params);
    return ads.publishNow(request.merchant.id, id, actorLabel(request));
  });

  /** The advert image (1080 × 1920 JPEG), rendered from the live catalogue. */
  app.get('/api/status-ads/:id/image', { config: perPerson(60) }, async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const image = await ads.image(request.merchant, id);
    const etag = `"${image.version}"`;
    if (request.headers['if-none-match'] === etag) return reply.status(304).send();
    return reply
      .header('content-type', 'image/jpeg')
      .header('etag', etag)
      .header('cache-control', 'private, no-cache')
      .send(image.bytes);
  });
}

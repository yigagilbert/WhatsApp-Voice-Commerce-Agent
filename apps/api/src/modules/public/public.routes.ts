import type { FastifyInstance } from 'fastify';
import type { Container } from '../../container';
import { linkedBot } from '../whatsapp/linked-bot';

/** How long the public number is reused before the gateway and database are asked again. */
const CACHE_MS = 30_000;

let cached: { at: number; phone: string | null } | null = null;

/** Called when an owner changes WhatsApp settings, so the homepage reflects them at once. */
export const forgetPublicNumber = () => {
  cached = null;
};

/**
 * Unauthenticated routes for the public website. They return only what an owner chose to
 * publish: never business data, IDs or settings.
 */
export async function publicRoutes(app: FastifyInstance, { container }: { container: Container }) {
  /** The WhatsApp number visitors can message, for the homepage link, QR code and /chat. */
  app.get('/api/public/whatsapp', async (_request, reply) => {
    if (!cached || Date.now() - cached.at > CACHE_MS) {
      const phone = await container.whatsappAccounts.publicNumber(
        await linkedBot(container.config),
        { customerCommerceAvailable: container.config.CUSTOMER_COMMERCE_ENABLED },
      );
      cached = { at: Date.now(), phone };
    }
    reply.header('Cache-Control', 'public, max-age=30');
    return cached.phone ? { available: true, phone: cached.phone } : { available: false };
  });
}

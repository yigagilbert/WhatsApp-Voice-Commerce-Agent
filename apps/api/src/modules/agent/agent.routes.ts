import type { FastifyInstance } from 'fastify';
import { inboundChannelMessageSchema } from '@vca/shared';
import type { Container } from '../../container';
import { authenticate } from '../../http/auth';
import { parse } from '../../http/validation';

export async function agentRoutes(app: FastifyInstance, { container }: { container: Container }) {
  const { config } = container;
  // Base64 voice notes are ~4/3 of the binary size; allow headroom for the JSON envelope.
  const bodyLimit = Math.ceil(config.MEDIA_MAX_BYTES * 1.4) + 64 * 1024;

  /**
   * Channel-agnostic entry point. Channel workers (WhatsApp) and the dashboard console post
   * normalized messages here and deliver the returned replies on their channel.
   */
  app.post('/api/agent/message', { bodyLimit }, async (request) => {
    const caller = authenticate(
      request,
      { dashboard: config.API_AUTH_TOKEN, internal: config.INTERNAL_SERVICE_TOKEN },
      ['dashboard', 'internal'],
    );
    const message = parse(inboundChannelMessageSchema, request.body);
    // The dashboard may only speak as the web channel; channel workers speak for their channel.
    if (caller === 'dashboard' && message.channel !== 'web') {
      return { status: 'ignored', replies: [] };
    }
    return container.inbound.handle(message);
  });
}

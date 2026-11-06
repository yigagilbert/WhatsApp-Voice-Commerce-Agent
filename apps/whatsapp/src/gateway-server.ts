import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import {
  HEADERS,
  isStatusChatId,
  newCorrelationId,
  outboundChannelMessageSchema,
  runWithContext,
  statusPostSchema,
  type Logger,
} from '@vca/shared';
import type { WhatsAppTransport } from './whatsapp-adapter';

/** Charts are sent as base64 PNGs (~1.5 MB max by the shared schema). */
const MAX_BODY_BYTES = 2.5 * 1024 * 1024;

const sameSecret = (a: string, b: string) =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Internal HTTP gateway so the API can push proactive messages (e.g. "Payment received", charts)
 * through this worker's WhatsApp session, and read/control the connection (QR, reconnect, unlink).
 * Every /internal/* route requires INTERNAL_SERVICE_TOKEN; the gateway is never exposed publicly.
 */
export function createGatewayServer(params: {
  transport: WhatsAppTransport;
  internalToken: string;
  logger: Logger;
}): Server {
  const { transport, internalToken, logger } = params;

  return createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const headerId = req.headers[HEADERS.correlationId];
    const correlationId = (Array.isArray(headerId) ? headerId[0] : headerId) || newCorrelationId();

    runWithContext({ correlationId }, async () => {
      try {
        if (req.method === 'GET' && req.url === '/health') {
          return send(200, {
            status: 'ok',
            service: 'whatsapp',
            whatsapp: transport.isReady() ? 'ready' : 'not_ready',
          });
        }
        const internal = req.url?.startsWith('/internal/');
        if (internal) {
          const token = req.headers[HEADERS.internalToken];
          if (typeof token !== 'string' || !sameSecret(token, internalToken))
            return send(401, { error: 'unauthorized' });
        }
        if (req.method === 'POST' && req.url === '/internal/send') {
          const parsed = outboundChannelMessageSchema.safeParse(JSON.parse(await readBody(req)));
          // Statuses only go through /internal/status, so a reply can never become a Status.
          if (
            !parsed.success ||
            parsed.data.channel !== 'whatsapp' ||
            isStatusChatId(parsed.data.externalChatId)
          )
            return send(400, { error: 'invalid message' });
          if (!transport.isReady()) return send(503, { error: 'whatsapp not ready' });
          const { externalChatId, text, media } = parsed.data;
          const stanzaId = media
            ? await transport.sendImage(externalChatId, media, text)
            : await transport.sendText(externalChatId, text);
          logger.info({ media: !!media }, 'outbound message delivered');
          return send(202, { delivered: true, stanzaId: stanzaId ?? null });
        }
        if (req.method === 'POST' && req.url === '/internal/status') {
          const parsed = statusPostSchema.safeParse(JSON.parse(await readBody(req)));
          if (!parsed.success) return send(400, { error: 'invalid status' });
          if (!transport.isReady()) return send(503, { error: 'WhatsApp is not connected' });
          // One worker session can serve any shop: never post one shop's advert from another's number.
          const bot = transport.botId();
          if (!bot || !parsed.data.botIds.includes(bot))
            return send(409, { error: 'The connected WhatsApp number is not this shop’s number' });
          try {
            const messageId = await transport.postStatus(parsed.data.media, parsed.data.caption);
            logger.info({ messageId }, 'status posted');
            return send(202, { posted: true, messageId });
          } catch (error) {
            logger.error({ err: error }, 'status post failed');
            // WhatsApp Web errors are short; keep the first line for the dashboard.
            const reason =
              String(error instanceof Error ? error.message : error).split('\n')[0] ?? '';
            return send(502, { error: `WhatsApp refused the status: ${reason.slice(0, 200)}` });
          }
        }
        // Connection management for the dashboard (via the API, which enforces the dashboard login).
        if (req.method === 'GET' && req.url === '/internal/session') {
          res.setHeader('cache-control', 'no-store');
          return send(200, transport.connection());
        }
        if (req.method === 'POST' && req.url === '/internal/session/reconnect') {
          logger.info('reconnect requested from the dashboard');
          void transport
            .reconnect()
            .catch((error: unknown) => logger.error({ err: error }, 'reconnect failed'));
          return send(202, { reconnecting: true });
        }
        if (req.method === 'POST' && req.url === '/internal/session/logout') {
          logger.warn('logout (unlink device) requested from the dashboard');
          void transport
            .logout()
            .catch((error: unknown) => logger.error({ err: error }, 'logout failed'));
          return send(202, { loggingOut: true });
        }
        return send(404, { error: 'not found' });
      } catch (error) {
        logger.error({ err: error }, 'gateway request failed');
        return send(500, { error: 'internal error' });
      }
    });
  });
}

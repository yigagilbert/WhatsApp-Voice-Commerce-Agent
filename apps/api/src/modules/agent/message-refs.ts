import type { Database } from '@vca/database';
import { z } from 'zod';

/**
 * What an outbound message was about, recorded by the backend when it was written (never by the
 * model). A quoted reply points at one of these; it says what the sender means, and grants nothing.
 */
const messageRefsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('product'), productId: z.string() }),
  z.object({ kind: z.literal('list'), ids: z.array(z.string()).max(200) }),
  z.object({ kind: z.literal('cart') }),
  z.object({ kind: z.literal('summary'), orderId: z.string() }),
  z.object({ kind: z.literal('order'), orderId: z.string() }),
  z.object({ kind: z.literal('offer'), productId: z.string().nullable() }),
  z.object({ kind: z.literal('customer_alert'), customerId: z.string() }),
  z.object({ kind: z.literal('confirmation') }),
]);
export type MessageRefs = z.infer<typeof messageRefsSchema>;

export interface ResolvedQuote {
  /** Null when the message was ours but about nothing specific. */
  refs: MessageRefs | null;
}

/**
 * Looks a quoted message up in this conversation's own outbound records. Stanza IDs from another
 * chat, or forged ones, simply don't resolve, so a quote can never reach another customer's data.
 */
export async function resolveQuote(
  db: Pick<Database, 'message'>,
  conversationId: string,
  stanzaId: string | undefined,
): Promise<ResolvedQuote | null> {
  if (!stanzaId) return null;
  const found = await db.message.findFirst({
    where: { conversationId, stanzaId, direction: 'OUTBOUND' },
    select: { refs: true },
  });
  if (!found) return null;
  const parsed = messageRefsSchema.safeParse(found.refs);
  return { refs: parsed.success ? parsed.data : null };
}

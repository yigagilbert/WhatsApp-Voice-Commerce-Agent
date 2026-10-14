import type { ActionConfirmation, ConfirmationAction, Database, Prisma } from '@vca/database';
import { getCorrelationId } from '@vca/shared';
import {
  ACTION_VERBS,
  generateConfirmationCode,
  hashPayload,
  requiresConfirmation,
  type ConfirmationReply,
} from '../confirmation';
import type { AuditService } from './audit.service';

export type ClaimResult =
  | { status: 'none' }
  | { status: 'expired'; confirmation: ActionConfirmation }
  | { status: 'code_mismatch'; confirmation: ActionConfirmation }
  /** Right conversation, wrong approval word (e.g. CONFIRM for a shipment) or no code. */
  | { status: 'wrong_verb'; confirmation: ActionConfirmation }
  | { status: 'cancelled'; confirmation: ActionConfirmation }
  | { status: 'integrity_failed'; confirmation: ActionConfirmation }
  | { status: 'claimed'; confirmation: ActionConfirmation };

/**
 * Pending sensitive actions. A confirmation is bound to merchant + conversation + action +
 * exact payload (hash) + expiry + unique code. At most one is PENDING per conversation:
 * proposing a new one supersedes the previous, so "yes" is never ambiguous.
 */
export class ConfirmationService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async propose(params: {
    merchantId: string;
    conversationId: string;
    action: ConfirmationAction;
    payload: Prisma.InputJsonObject;
    summary: string;
    ttlSeconds: number;
    /** File under an existing transaction trace (e.g. the paid order's) instead of this request's. */
    correlationId?: string | null;
  }): Promise<ActionConfirmation> {
    const traceId = params.correlationId ?? getCorrelationId() ?? null;
    if (!requiresConfirmation(params.action)) {
      throw new Error(`Action ${params.action} is not configured as confirmable`);
    }
    return this.db.$transaction(async (tx) => {
      await tx.actionConfirmation.updateMany({
        where: { conversationId: params.conversationId, status: 'PENDING' },
        data: { status: 'CANCELLED', error: 'Superseded by a newer request' },
      });
      const confirmation = await tx.actionConfirmation.create({
        data: {
          merchantId: params.merchantId,
          conversationId: params.conversationId,
          action: params.action,
          payload: params.payload,
          payloadHash: hashPayload(params.payload),
          code: generateConfirmationCode(),
          summary: params.summary,
          expiresAt: new Date(Date.now() + params.ttlSeconds * 1000),
          correlationId: traceId,
        },
      });
      await this.audit.record(
        {
          merchantId: params.merchantId,
          actor: 'AGENT',
          type: 'confirmation.proposed',
          entityType: 'confirmation',
          entityId: confirmation.id,
          correlationId: traceId,
          data: { action: params.action, payload: params.payload },
        },
        tx,
      );
      return confirmation;
    });
  }

  findPending(conversationId: string) {
    return this.db.actionConfirmation.findFirst({
      where: { conversationId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * The most recent confirmation in this conversation with `code` that was already confirmed
   * (e.g. a duplicated "CONFIRM 4821"), so the merchant can be told what happened instead of
   * "nothing pending". Read-only: it never re-executes anything.
   */
  findSettledByCode(
    conversationId: string,
    code: string,
    since = new Date(Date.now() - 86_400_000),
  ) {
    return this.db.actionConfirmation.findFirst({
      where: {
        conversationId,
        code,
        status: { in: ['CONFIRMED', 'EXECUTED'] },
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Applies a merchant's confirm/cancel reply to the conversation's pending action.
   * Claiming is atomic (PENDING -> CONFIRMED with a conditional update), so a duplicated
   * "yes" can never execute the same action twice.
   */
  async claim(
    merchantId: string,
    conversationId: string,
    reply: ConfirmationReply,
    now = new Date(),
  ): Promise<ClaimResult> {
    const pending = await this.findPending(conversationId);
    if (!pending || pending.merchantId !== merchantId) return { status: 'none' };

    if (pending.expiresAt <= now) {
      await this.db.actionConfirmation.updateMany({
        where: { id: pending.id, status: 'PENDING' },
        data: { status: 'EXPIRED' },
      });
      return { status: 'expired', confirmation: pending };
    }
    if (reply.code && reply.code !== pending.code)
      return { status: 'code_mismatch', confirmation: pending };

    if (reply.kind === 'cancel') {
      await this.db.actionConfirmation.updateMany({
        where: { id: pending.id, status: 'PENDING' },
        data: { status: 'CANCELLED' },
      });
      await this.audit.record({
        merchantId,
        actor: 'MERCHANT',
        type: 'confirmation.cancelled',
        entityType: 'confirmation',
        entityId: pending.id,
        correlationId: pending.correlationId,
        data: { requestCorrelationId: getCorrelationId() ?? null },
      });
      return { status: 'cancelled', confirmation: pending };
    }

    // Each action has its own approval word; shipments and dispute responses also need the code,
    // so a bare "yes" can never update tracking or submit to PayPal.
    const rule = ACTION_VERBS[pending.action];
    if ((reply.verb ?? 'confirm') !== rule.verb || (rule.codeRequired && !reply.code)) {
      return { status: 'wrong_verb', confirmation: pending };
    }

    if (hashPayload(pending.payload) !== pending.payloadHash) {
      await this.markFailed(pending.id, 'Payload integrity check failed');
      return { status: 'integrity_failed', confirmation: pending };
    }

    const { count } = await this.db.actionConfirmation.updateMany({
      where: { id: pending.id, status: 'PENDING', expiresAt: { gt: now } },
      data: { status: 'CONFIRMED', confirmedAt: now },
    });
    if (count !== 1) return { status: 'none' };

    await this.audit.record({
      merchantId,
      actor: 'MERCHANT',
      type: 'confirmation.received',
      entityType: 'confirmation',
      entityId: pending.id,
      // Filed under the transaction trace; the confirm message's own request ID is kept too.
      correlationId: pending.correlationId,
      data: {
        action: pending.action,
        code: pending.code,
        requestCorrelationId: getCorrelationId() ?? null,
      },
    });
    return {
      status: 'claimed',
      confirmation: { ...pending, status: 'CONFIRMED', confirmedAt: now },
    };
  }

  async markExecuted(id: string, result: Prisma.InputJsonValue): Promise<void> {
    await this.db.actionConfirmation.update({
      where: { id },
      data: { status: 'EXECUTED', executedAt: new Date(), result },
    });
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.db.actionConfirmation.update({ where: { id }, data: { status: 'FAILED', error } });
  }
}

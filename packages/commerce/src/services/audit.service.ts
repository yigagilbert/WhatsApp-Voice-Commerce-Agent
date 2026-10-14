import type { AuditActor, Database, DatabaseTx, Prisma } from '@vca/database';
import { getCorrelationId } from '@vca/shared';

export interface AuditEventInput {
  merchantId?: string | null;
  actor: AuditActor;
  /** Dotted type, e.g. "agent.intent_interpreted", "confirmation.received", "payment.completed". */
  type: string;
  entityType?: string;
  entityId?: string;
  data?: Prisma.InputJsonValue;
  /** Overrides the ambient correlation ID (e.g. to file an event under a transaction trace). */
  correlationId?: string | null;
  /** When it happened, if not now (e.g. an AI run recorded after it finishes). */
  at?: Date;
}

/** Append-only audit trail for AI decisions and financial events. */
export class AuditService {
  constructor(private readonly db: Database) {}

  async record(event: AuditEventInput, tx: DatabaseTx = this.db): Promise<void> {
    await tx.auditEvent.create({
      data: {
        merchantId: event.merchantId ?? null,
        actor: event.actor,
        type: event.type,
        entityType: event.entityType ?? null,
        entityId: event.entityId ?? null,
        data: event.data ?? undefined,
        correlationId: event.correlationId ?? getCorrelationId() ?? null,
        ...(event.at ? { createdAt: event.at } : {}),
      },
    });
  }

  /** Newest first. Pass `correlationId` to see one transaction's full trace. */
  list(merchantId: string, limit = 50, correlationId?: string) {
    return this.db.auditEvent.findMany({
      where: { merchantId, ...(correlationId ? { correlationId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
    });
  }
}

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Per-request/per-message context. The correlation ID follows a message from the
 * channel (WhatsApp) through speech, agent, confirmation, PayPal and the final notification.
 */
export interface RequestContext {
  correlationId: string;
  merchantId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const newCorrelationId = (): string => randomUUID();

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export const getContext = (): RequestContext | undefined => storage.getStore();

export const getCorrelationId = (): string | undefined => storage.getStore()?.correlationId;

/** Header names shared by every service. */
export const HEADERS = {
  correlationId: 'x-correlation-id',
  internalToken: 'x-internal-token',
} as const;

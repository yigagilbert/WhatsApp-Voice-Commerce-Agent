/** Fastify type augmentation (imported by app.ts so every consumer of the app sees it). */
import type { Merchant } from '@vca/database';

declare module 'fastify' {
  interface FastifyRequest {
    /** Raw request body (JSON requests) — needed for PayPal webhook signature verification. */
    rawBody?: string;
    /** Merchant the dashboard request operates on (set by the dashboard scope hook). */
    merchant: Merchant;
  }
}

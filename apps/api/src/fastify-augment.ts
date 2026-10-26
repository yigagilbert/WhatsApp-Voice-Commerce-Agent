/** Fastify type augmentation (imported by app.ts so every consumer of the app sees it). */
import type { Merchant, OperatorRole } from '@vca/database';

/** The person behind a dashboard request. */
export interface DashboardActor {
  /** DashboardUser ID, or "bootstrap" for the shared setup login (only while no account exists). */
  id: string;
  username: string;
  role: OperatorRole;
  bootstrap: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Raw request body (JSON requests) — needed for PayPal webhook signature verification. */
    rawBody?: string;
    /** Merchant the dashboard request operates on (set by the dashboard scope hook). */
    merchant: Merchant;
    /** Signed-in dashboard person (set by the dashboard scope hook). */
    dashboardUser: DashboardActor;
  }
}

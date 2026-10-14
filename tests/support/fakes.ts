import type { ChatCompletionRequest, ChatCompletionResponse, ChatModel } from '@vca/ai';
import { ProviderError } from '@vca/shared';
import type {
  AddTrackingParams,
  CreateCheckoutOrderParams,
  DisputeEvidence,
  PayPalApi,
  PayPalDispute,
  PayPalOrder,
} from '@vca/paypal';

/** In-memory PayPal double that records calls and mimics idempotency by request ID. */
export class FakePayPal implements PayPalApi {
  readonly configured = true;
  verifyResult = true;
  readonly created: CreateCheckoutOrderParams[] = [];
  readonly captures: string[] = [];
  private readonly ordersByRequestId = new Map<string, string>();
  /** Set to make the next order creation fail like a PayPal outage. */
  failNextCreate: Error | null = null;

  /** `idPrefix` keeps PayPal order IDs unique across test files sharing one database. */
  constructor(private readonly idPrefix = 'PP') {}

  async createCheckoutOrder(params: CreateCheckoutOrderParams) {
    if (this.failNextCreate) {
      const error = this.failNextCreate;
      this.failNextCreate = null;
      throw error;
    }
    this.created.push(params);
    const id =
      this.ordersByRequestId.get(params.requestId) ??
      `${this.idPrefix}-${this.ordersByRequestId.size + 1}`;
    this.ordersByRequestId.set(params.requestId, id);
    return {
      order: { id, status: 'PAYER_ACTION_REQUIRED' } as PayPalOrder,
      approveUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${id}`,
    };
  }
  /** Orders already captured at "PayPal" outside our app (e.g. a racing callback). */
  readonly capturedElsewhere = new Set<string>();

  private completed(orderId: string): PayPalOrder {
    return {
      id: orderId,
      status: 'COMPLETED',
      purchase_units: [{ payments: { captures: [{ id: `CAP-${orderId}`, status: 'COMPLETED' }] } }],
    };
  }
  async getOrder(orderId: string): Promise<PayPalOrder> {
    return this.capturedElsewhere.has(orderId) || this.captures.includes(orderId)
      ? this.completed(orderId)
      : { id: orderId, status: 'APPROVED' };
  }
  async captureOrder(orderId: string): Promise<PayPalOrder> {
    if (this.capturedElsewhere.has(orderId)) {
      // Same shape PayPal returns: 422 UNPROCESSABLE_ENTITY with issue ORDER_ALREADY_CAPTURED.
      throw new ProviderError('paypal', 'UNPROCESSABLE_ENTITY: already captured', {
        details: { status: 422, name: 'UNPROCESSABLE_ENTITY', issues: ['ORDER_ALREADY_CAPTURED'] },
      });
    }
    this.captures.push(orderId);
    return this.completed(orderId);
  }
  // ─── Tracking (SIMULATED PAYPAL: mirrors Orders v2 /track semantics) ─────────
  readonly trackingCalls: AddTrackingParams[] = [];
  private readonly trackers = new Map<string, Set<string>>();
  /** Set to make the next tracking call fail like PayPal (e.g. CAPTURE_STATUS_NOT_VALID). */
  failNextTracking: Error | null = null;
  async addTracking(params: AddTrackingParams): Promise<PayPalOrder> {
    this.trackingCalls.push(params);
    if (this.failNextTracking) {
      const error = this.failNextTracking;
      this.failNextTracking = null;
      throw error;
    }
    // Idempotent on capture_id + tracking_number, like PayPal.
    const ids = this.trackers.get(params.paypalOrderId) ?? new Set<string>();
    ids.add(`${params.captureId}-${params.trackingNumber}`);
    this.trackers.set(params.paypalOrderId, ids);
    return {
      id: params.paypalOrderId,
      status: 'COMPLETED',
      purchase_units: [
        { shipping: { trackers: [...ids].map((id) => ({ id, status: 'SHIPPED' })) } },
      ],
    };
  }
  /** Distinct trackers PayPal holds for an order. */
  trackerCount(paypalOrderId: string) {
    return this.trackers.get(paypalOrderId)?.size ?? 0;
  }

  // ─── Disputes (SIMULATED PAYPAL: Disputes v1 shapes) ────────────────────────
  readonly disputes = new Map<string, PayPalDispute>();
  readonly evidenceCalls: { disputeId: string; evidences: DisputeEvidence[] }[] = [];
  async listDisputes() {
    return [...this.disputes.values()].map((d) => ({ dispute_id: d.dispute_id, status: d.status }));
  }
  async getDispute(disputeId: string): Promise<PayPalDispute> {
    const d = this.disputes.get(disputeId);
    if (!d) {
      throw new ProviderError('paypal', 'RESOURCE_NOT_FOUND', {
        details: { status: 404, name: 'RESOURCE_NOT_FOUND', issues: [] },
      });
    }
    return structuredClone(d);
  }
  async provideDisputeEvidence(disputeId: string, evidences: DisputeEvidence[]) {
    const d = await this.getDispute(disputeId);
    if (d.status !== 'WAITING_FOR_SELLER_RESPONSE') {
      throw new ProviderError('paypal', 'UNPROCESSABLE_ENTITY', {
        details: { status: 422, name: 'UNPROCESSABLE_ENTITY', issues: ['NOT_AUTHORIZED'] },
      });
    }
    this.evidenceCalls.push({ disputeId, evidences });
    this.disputes.set(disputeId, { ...d, status: 'UNDER_REVIEW' });
  }

  async createDraftInvoice(): Promise<never> {
    throw new Error('not used');
  }
  async sendInvoice(): Promise<never> {
    throw new Error('not used');
  }
  /** Set to an HTTP status to make verification fail like PayPal does for malformed input. */
  verifyErrorStatus: number | null = null;
  async verifyWebhookSignature() {
    if (this.verifyErrorStatus) {
      throw new ProviderError('paypal', 'INVALID_REQUEST', {
        details: { status: this.verifyErrorStatus, name: 'INVALID_REQUEST', issues: [] },
      });
    }
    return this.verifyResult;
  }
}

/** Chat model that plays back a script; `respond` can inspect the request. */
export class ScriptedChatModel implements ChatModel {
  readonly id = 'scripted-test-model';
  readonly requests: ChatCompletionRequest[] = [];
  constructor(
    private readonly script: ((req: ChatCompletionRequest) => ChatCompletionResponse['message'])[],
  ) {}

  /** Appends more scripted turns (used by tests that add scenarios). */
  enqueue(...steps: ((req: ChatCompletionRequest) => ChatCompletionResponse['message'])[]) {
    this.script.push(...steps);
  }

  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    this.requests.push(request);
    const next = this.script.shift();
    if (!next) throw new Error('ScriptedChatModel: script exhausted');
    return { message: next(request) };
  }
}

export const testEnv = (overrides: Record<string, string> = {}) => ({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://vca:vca@localhost:5433/vca?schema=public',
  API_AUTH_TOKEN: 'test-dashboard-token-123456',
  INTERNAL_SERVICE_TOKEN: 'test-internal-token-123456',
  PAYPAL_WEBHOOK_ID: 'WH-TEST',
  ...overrides,
});

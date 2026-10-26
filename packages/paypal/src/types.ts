/**
 * Minimal, hand-written types for the PayPal REST endpoints we use.
 * Amounts are always decimal STRINGS in major units ("680.00") as PayPal requires;
 * conversion from integer minor units happens in the calling layer (@vca/commerce money utils).
 */
export type PayPalEnvironment = 'sandbox' | 'live';

export const PAYPAL_BASE_URLS: Record<PayPalEnvironment, string> = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
};

export interface PayPalMoney {
  currency_code: string;
  value: string;
}

export interface PayPalLink {
  href: string;
  rel: string;
  method?: string;
}

export interface CheckoutLineItem {
  name: string;
  quantity: number;
  /** Major-unit decimal string. */
  unitAmount: string;
}

export interface CreateCheckoutOrderParams {
  /** Idempotency key sent as PayPal-Request-Id. */
  requestId: string;
  /** Our order reference (purchase_units[].reference_id). */
  referenceId: string;
  /** Our payment ID (purchase_units[].custom_id) — echoed back on captures/webhooks. */
  customId: string;
  description?: string;
  currency: string;
  items: CheckoutLineItem[];
  itemTotal: string;
  shipping: string;
  taxTotal: string;
  total: string;
  returnUrl: string;
  cancelUrl: string;
  brandName: string;
}

export interface PayPalRefund {
  id: string;
  /** COMPLETED, PENDING, CANCELLED, FAILED. */
  status: string;
  amount?: PayPalMoney;
  create_time?: string;
}

export interface PayPalOrder {
  id: string;
  status:
    'CREATED' | 'SAVED' | 'APPROVED' | 'VOIDED' | 'COMPLETED' | 'PAYER_ACTION_REQUIRED' | string;
  links?: PayPalLink[];
  purchase_units?: {
    reference_id?: string;
    custom_id?: string;
    payments?: {
      captures?: { id: string; status: string; amount?: PayPalMoney }[];
      /** Refunds of this unit's captures (full and partial), as PayPal reports them. */
      refunds?: PayPalRefund[];
    };
    shipping?: { trackers?: PayPalTracker[] };
  }[];
}

export interface AddTrackingParams {
  /** PayPal order ID (our Payment.externalId). */
  paypalOrderId: string;
  /** PayPal capture ID (our Payment.captureId); the capture must be COMPLETED. */
  captureId: string;
  trackingNumber: string;
  /** PayPal carrier code, or OTHER with carrierNameOther. */
  carrier: string;
  carrierNameOther?: string | undefined;
  notifyPayer?: boolean;
}

/** One tracker in purchase_units[].shipping.trackers[] (Orders v2). */
export interface PayPalTracker {
  id: string;
  status?: 'SHIPPED' | 'CANCELLED' | string;
  create_time?: string;
  update_time?: string;
}

/** Disputes v1 (GET /v1/customer/disputes/{id}); only the fields Katale reads. */
export interface PayPalDispute {
  dispute_id: string;
  create_time?: string;
  update_time?: string;
  reason?: string;
  status?: string;
  dispute_state?: string;
  dispute_life_cycle_stage?: string;
  dispute_channel?: string;
  dispute_amount?: PayPalMoney;
  seller_response_due_date?: string;
  buyer_response_due_date?: string;
  dispute_outcome?: { outcome_code?: string; amount_refunded?: PayPalMoney };
  disputed_transactions?: {
    seller_transaction_id?: string;
    buyer_transaction_id?: string;
    invoice_number?: string;
    custom?: string;
    gross_amount?: PayPalMoney;
    items?: { item_description?: string; reason?: string; notes?: string }[];
  }[];
  messages?: { posted_by?: string; time_posted?: string; content?: string }[];
  links?: PayPalLink[];
}

export interface PayPalDisputeSummary {
  dispute_id: string;
  create_time?: string;
  update_time?: string;
  reason?: string;
  status?: string;
  dispute_amount?: PayPalMoney;
  dispute_life_cycle_stage?: string;
}

/** One evidence entry for POST /v1/customer/disputes/{id}/provide-evidence (input part). */
export interface DisputeEvidence {
  evidence_type: string;
  evidence_info?: {
    tracking_info?: {
      carrier_name: string;
      carrier_name_other?: string;
      tracking_number: string;
    }[];
  };
  notes?: string;
}

export interface CreateInvoiceParams {
  requestId: string;
  invoiceNumber?: string;
  currency: string;
  businessName: string;
  note?: string;
  recipient: { givenName: string; surname?: string; email: string };
  items: CheckoutLineItem[];
  shipping?: string;
}

export interface PayPalInvoice {
  id: string;
  status?: string;
  links?: PayPalLink[];
  detail?: { metadata?: { recipient_view_url?: string; invoicer_view_url?: string } };
}

/** Headers PayPal sends with every webhook delivery. */
export interface WebhookSignatureHeaders {
  authAlgo: string;
  certUrl: string;
  transmissionId: string;
  transmissionSig: string;
  transmissionTime: string;
}

/** The subset of PayPal operations the application depends on — easy to fake in tests. */
export interface PayPalApi {
  readonly configured: boolean;
  createCheckoutOrder(
    params: CreateCheckoutOrderParams,
  ): Promise<{ order: PayPalOrder; approveUrl: string }>;
  getOrder(orderId: string): Promise<PayPalOrder>;
  captureOrder(orderId: string, requestId: string): Promise<PayPalOrder>;
  createDraftInvoice(params: CreateInvoiceParams): Promise<PayPalInvoice>;
  sendInvoice(invoiceId: string, requestId: string): Promise<{ href?: string }>;
  /** Orders v2: add tracking to a captured order. Idempotent on capture ID + tracking number. */
  addTracking(params: AddTrackingParams): Promise<PayPalOrder>;
  listDisputes(params?: { pageSize?: number }): Promise<PayPalDisputeSummary[]>;
  getDispute(disputeId: string): Promise<PayPalDispute>;
  /** Disputes v1 provide-evidence (seller). Only valid while the dispute awaits the seller. */
  provideDisputeEvidence(disputeId: string, evidences: DisputeEvidence[]): Promise<void>;
  verifyWebhookSignature(params: {
    headers: WebhookSignatureHeaders;
    rawBody: string;
    webhookId: string;
  }): Promise<boolean>;
}

/** Shapes returned by the API (dates arrive as ISO strings). */
export interface CurrencyAmount {
  currency: string;
  amountMinor: number;
  formatted: string;
  count: number;
}

export interface Customer {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  whatsappId: string | null;
  country: string | null;
  createdAt: string;
}

export interface Product {
  id: string;
  name: string;
  sku: string | null;
  description: string | null;
  unitPriceMinor: number;
  currency: string;
  stockQuantity: number | null;
  active: boolean;
  visibleToCustomers?: boolean;
  category?: string | null;
  /** Customers may bargain on WhatsApp (needs minPriceMinor). */
  bargainingEnabled?: boolean;
  /** Lowest price the merchant accepts; dashboard only, never shown to customers. */
  minPriceMinor?: number | null;
  quantityDiscounts?: QuantityDeal[] | null;
}

export interface QuantityDeal {
  minQuantity: number;
  percentOff: number;
}

export interface Order {
  id: string;
  reference: string;
  status: 'DRAFT' | 'AWAITING_PAYMENT' | 'PAID' | 'CANCELLED' | 'REFUNDED';
  currency: string;
  subtotalMinor: number;
  shippingMinor: number;
  taxMinor: number;
  totalMinor: number;
  source: string;
  inputMode: 'TEXT' | 'VOICE';
  fulfillmentStatus: 'NOT_SHIPPED' | 'SHIPPED';
  shipments?: Shipment[];
  disputes?: { paypalDisputeId: string; status: string }[];
  notes?: string | null;
  placedBy?: 'MERCHANT' | 'CUSTOMER';
  deliveryMethod?: 'DELIVERY' | 'PICKUP' | null;
  deliveryAddress?: string | null;
  contactName?: string | null;
  /** Unpaid orders are cancelled at this time (null = no deadline). */
  paymentDueAt?: string | null;
  cancelledAt?: string | null;
  cancelReason?: 'PAYMENT_EXPIRED' | 'MERCHANT' | 'CUSTOMER' | null;
  /** Completed refunds (minor units); equals totalMinor when fully refunded. */
  refundedMinor?: number;
  /** Needs an owner's review before fulfilment (paid after cancellation / paid twice). */
  attention?: 'PAID_AFTER_CANCEL' | 'DUPLICATE_PAYMENT' | null;
  createdAt: string;
  customer: { name: string; phone?: string | null };
  items?: {
    id: string;
    description: string;
    quantity: number;
    unitPriceMinor: number;
    lineTotalMinor: number;
    productId: string | null;
  }[];
  /** Latest payment (the orders list includes at most one). */
  payments?: Pick<
    Payment,
    | 'id'
    | 'status'
    | 'providerStatus'
    | 'checkoutUrl'
    | 'correlationId'
    | 'completedAt'
    | 'refundedMinor'
  >[];
}

export interface Shipment {
  id: string;
  carrier: string;
  carrierNameOther: string | null;
  trackingNumber: string;
  status: 'SHIPPED' | 'CANCELLED';
  providerTrackerId: string | null;
  providerSyncedAt: string | null;
  shippedAt: string;
}

export interface DisputeRow {
  id: string;
  paypalDisputeId: string;
  orderReference: string | null;
  customer: string | null;
  inputMode: 'TEXT' | 'VOICE' | null;
  reason: string;
  reasonLabel: string;
  status: string;
  statusLabel: string;
  lifecycleStage: string | null;
  outcome: string | null;
  amountMinor: number | null;
  currency: string | null;
  openedAt: string | null;
  sellerResponseDueAt: string | null;
  updatedAt: string;
}

export interface DisputeDetail {
  id: string;
  paypalDisputeId: string;
  reasonLabel: string;
  status: string;
  statusLabel: string;
  lifecycleStage: string | null;
  outcome: string | null;
  amountMinor: number | null;
  currency: string | null;
  buyerMessage: string | null;
  openedAt: string | null;
  sellerResponseDueAt: string | null;
  order: {
    reference: string;
    customer: string;
    totalMinor: number;
    currency: string;
    status: string;
    fulfillmentStatus: string;
  } | null;
  payment: {
    status: string;
    amountMinor: number;
    currency: string;
    captureId: string | null;
    completedAt: string | null;
  } | null;
  shipments: {
    carrier: string;
    trackingNumber: string;
    shippedAt: string;
    registeredWithPayPal: boolean;
  }[];
  evidence: {
    facts: { label: string; value: string }[];
    missing: string[];
    evidence: { type: string; label: string; detail: string }[];
  };
  responses: {
    id: string;
    status: string;
    responseText: string;
    evidence: { label: string }[];
    submittedAt: string | null;
    createdAt: string;
  }[];
  timeline: AuditEvent[];
}

export interface CustomerStat {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  country: string | null;
  hasWhatsApp: boolean;
  orders: number;
  paidOrders: number;
  revenueMinor: number;
  currency: string | null;
  lastOrderAt: string | null;
  createdAt: string;
}

export interface ProductStat {
  id: string;
  name: string;
  sku: string | null;
  description: string | null;
  unitPriceMinor: number;
  currency: string;
  stockQuantity: number | null;
  active: boolean;
  reorderLevel?: number | null;
  visibleToCustomers?: boolean;
  category?: string | null;
  /** Changes with each new photo (thumbnail cache key); null = no photo. */
  imageVersion?: string | null;
  unitsSold: number;
  revenueMinor: number;
  bargainingEnabled?: boolean;
  minPriceMinor?: number | null;
  quantityDiscounts?: QuantityDeal[];
}

/** GET /api/pricing: the bundle rule and bargaining results for the Bargaining page. */
export interface PricingOverview {
  currency: string;
  bundle: { minItems: number; percentOff: number } | null;
  products: { active: number; bargaining: number; quantityDeals: number };
  last30Days: {
    offersMade: number;
    dealsAgreed: number;
    paidDiscountedOrders: number;
    paidNegotiatedOrders: number;
    revenueMinor: number;
    discountMinor: number;
  };
  orders: {
    id: string;
    reference: string;
    customer: string;
    status: Order['status'];
    createdAt: string;
    currency: string;
    totalMinor: number;
    regularMinor: number;
    discountMinor: number;
    negotiated: boolean;
    items: {
      description: string;
      quantity: number;
      unitPriceMinor: number;
      listUnitPriceMinor: number | null;
      pricing: 'LIST' | 'QUANTITY' | 'BUNDLE' | 'NEGOTIATED';
    }[];
  }[];
}

/** One product for the edit page (GET /api/products/:id). */
export interface ProductDetail extends Product {
  reorderLevel: number | null;
  image: {
    version: string;
    storage: 'DATABASE' | 'R2';
    width: number | null;
    height: number | null;
    sizeBytes: number;
  } | null;
}

export interface MoneyFigure {
  currency: string;
  amountMinor: number;
  formatted: string;
}

export interface Payment {
  id: string;
  status: 'CREATED' | 'APPROVED' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'REFUNDED';
  provider: string;
  providerStatus: string | null;
  correlationId: string | null;
  amountMinor: number;
  currency: string;
  checkoutUrl: string | null;
  externalId: string | null;
  createdAt: string;
  completedAt: string | null;
  reminderCount?: number;
  lastReminderAt?: string | null;
  /** Completed refunds (minor units). Partial: status stays COMPLETED; full: REFUNDED. */
  refundedMinor?: number;
  refunds?: {
    id: string;
    externalId: string;
    amountMinor: number;
    status: string;
    kind: string;
    createdAt: string;
  }[];
  order: { reference: string; status?: string; customer?: { name: string } };
}

export interface AuditEvent {
  id: string;
  actor: 'AGENT' | 'MERCHANT' | 'SYSTEM' | 'PROVIDER';
  type: string;
  entityType: string | null;
  entityId: string | null;
  data: unknown;
  correlationId: string | null;
  createdAt: string;
}

export interface DashboardSummary {
  merchant: { id: string; businessName: string; preferredCurrency: string; timezone: string };
  revenue: CurrencyAmount[];
  revenueThisWeek: CurrencyAmount[];
  outstanding: CurrencyAmount[];
  averageOrderValue: MoneyFigure[];
  topProducts: (MoneyFigure & { name: string; quantity: number; sharePercent: number })[];
  topCustomers: (MoneyFigure & { name: string; orders: number })[];
  bySource: (MoneyFigure & { name: string; orders: number })[];
  operations: {
    awaitingShipment: number;
    shipped: number;
    openDisputes: number;
    needsResponse: number;
    disputedAmount: MoneyFigure[];
  };
  counts: {
    orders: number;
    paidOrders: number;
    awaitingPayment: number;
    drafts: number;
    customers: number;
    products: number;
  };
  generatedAt: string;
  /** Changes whenever the records behind the dashboard change. */
  dataVersion: string;
  /** One block per currency: amounts in different currencies are never added together. */
  pulse: PulseFigures[];
  attention: AttentionItem[];
}

export interface PulsePeriodFigures {
  period: 'today' | 'this_week' | 'this_month';
  net: string;
  netMinor: number;
  paidOrders: number;
  previousNet: string;
  comparedWith: string | null;
  /** null when the earlier period had no sales: growth from nothing has no percentage. */
  changePercent: number | null;
}

export interface PulseFigures {
  currency: string;
  gross: string;
  refunds: string;
  net: string;
  netMinor: number;
  paidOrders: number;
  averageOrderValue: string | null;
  outstanding: string;
  outstandingOrders: number;
  disputed: string;
  periods: PulsePeriodFigures[];
}

export interface AttentionItem {
  id: string;
  severity: 'urgent' | 'warning' | 'info';
  title: string;
  detail: string;
  count: number;
  href: string;
  action: string;
}

/** Flat tables for AG Studio (amounts in major units). */
export interface AnalyticsDataset {
  meta: { generatedAt: string; timezone: string; truncated: boolean };
  orders: Record<string, string | number | boolean | null>[];
  orderItems: Record<string, string | number | boolean | null>[];
  payments: Record<string, string | number | boolean | null>[];
  customers: Record<string, string | number | boolean | null>[];
  products: Record<string, string | number | boolean | null>[];
  shipments: Record<string, string | number | boolean | null>[];
  disputes: Record<string, string | number | boolean | null>[];
}

export interface StorefrontSettings {
  slug: string;
  saved: boolean;
  enabled: boolean;
  tagline: string | null;
  about: string | null;
  logoVersion: string | null;
  /** Why customers can't be sent to WhatsApp yet; null when checkout works. */
  checkoutBlocker: string | null;
  products: { shown: number; hidden: number; withoutPhoto: number; withoutCategory: number };
  categories: { name: string; count: number }[];
}

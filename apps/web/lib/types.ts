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
  createdAt: string;
  customer: { name: string };
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
    'id' | 'status' | 'providerStatus' | 'checkoutUrl' | 'correlationId' | 'completedAt'
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
  unitsSold: number;
  revenueMinor: number;
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
  order: { reference: string; customer?: { name: string } };
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
  recentOrders: Order[];
  recentPayments: Payment[];
}

/** Flat tables for AG Studio (amounts in major units). */
export interface AnalyticsDataset {
  orders: Record<string, string | number | boolean | null>[];
  orderItems: Record<string, string | number | boolean | null>[];
  payments: Record<string, string | number | boolean | null>[];
  customers: Record<string, string | number | boolean | null>[];
  products: Record<string, string | number | boolean | null>[];
  shipments: Record<string, string | number | boolean | null>[];
  disputes: Record<string, string | number | boolean | null>[];
}

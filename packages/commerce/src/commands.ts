import { z } from 'zod';

/**
 * Structured commerce commands — the contract between the AI interpretation layer and
 * the commerce core. The LLM produces these (via tool calls); the backend validates them
 * with these schemas and then applies deterministic business rules.
 *
 * Amounts here are in MAJOR units as spoken ("12", "80.50") because that is what the model
 * extracts. They are converted to integer minor units by `toMinorUnits` before any use.
 */

export const COMMERCE_INTENTS = [
  'create_order',
  'request_payment',
  'check_payment_status',
  'sales_summary',
  'product_query',
  'customer_query',
  'inventory_query',
  'general',
] as const;
export const commerceIntentSchema = z.enum(COMMERCE_INTENTS);
export type CommerceIntent = z.infer<typeof commerceIntentSchema>;

const amount = z.number().nonnegative().max(10_000_000);

export const customerRefSchema = z.object({
  id: z.string().optional().describe('Customer ID if already known from a previous tool result'),
  name: z.string().trim().min(1).max(120).describe('Customer name as said by the merchant'),
  phone: z.string().max(32).optional(),
  email: z.string().email().optional(),
});

export const orderItemCommandSchema = z.object({
  product_id: z
    .string()
    .optional()
    .describe('Catalog product ID if known from a previous tool result'),
  name: z.string().trim().min(1).max(200).describe('Item name as said by the merchant'),
  quantity: z.number().int().positive().max(100_000),
  unit_price: amount
    .optional()
    .describe(
      'Unit price in major units ONLY if the merchant stated it; omit to use the catalog price',
    ),
});

export const draftOrderCommandSchema = z.object({
  customer: customerRefSchema,
  items: z.array(orderItemCommandSchema).min(1).max(50),
  currency: z
    .string()
    .length(3)
    .optional()
    .describe("ISO-4217 code; omit to use the merchant's default currency"),
  shipping: amount.optional().describe('Shipping in major units, if stated'),
  tax: amount.optional().describe('Tax in major units, if stated'),
  claimed_total: z
    .number()
    .optional()
    .describe(
      'Total the merchant mentioned, if any. Informational only — the backend recalculates.',
    ),
  notes: z.string().max(500).optional(),
});
export type DraftOrderCommand = z.infer<typeof draftOrderCommandSchema>;

export const orderRefSchema = z.object({
  order_reference: z.string().trim().min(1).max(40).describe('Order reference such as ORD-7K2M9Q'),
});
export type OrderRefCommand = z.infer<typeof orderRefSchema>;

export const SALES_PERIODS = [
  'today',
  'yesterday',
  'this_week',
  'last_7_days',
  'this_month',
  'last_month',
  'last_30_days',
  'all_time',
] as const;
export const salesPeriodSchema = z.enum(SALES_PERIODS);
export type SalesPeriod = z.infer<typeof salesPeriodSchema>;

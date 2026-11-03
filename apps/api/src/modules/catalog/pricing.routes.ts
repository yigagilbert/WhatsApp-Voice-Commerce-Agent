import type { FastifyInstance } from 'fastify';
import { toMinorUnits, validateBundleRule, type ProductPricingInput } from '@vca/commerce';
import { z } from 'zod';
import type { Container } from '../../container';
import { parse } from '../../http/validation';

/** Bargaining fields accepted with a product (create and edit). */
export const productPricingFields = {
  bargainingEnabled: z.boolean().optional(),
  /** Lowest unit price accepted, major units ("24" / 24.5); null clears it. */
  minPrice: z.union([z.number().positive(), z.string().min(1), z.null()]).optional(),
  quantityDiscounts: z
    .array(
      z.object({
        minQuantity: z.number().int().min(2).max(1000),
        percentOff: z.number().int().min(1).max(90),
      }),
    )
    .max(3)
    .optional(),
};

/** Converts the request fields to minor units for ProductService (which validates the rules). */
export function productPricingInput(
  body: {
    bargainingEnabled?: boolean | undefined;
    minPrice?: number | string | null | undefined;
    quantityDiscounts?: { minQuantity: number; percentOff: number }[] | undefined;
  },
  currency: string,
): ProductPricingInput {
  return {
    ...(body.bargainingEnabled !== undefined ? { bargainingEnabled: body.bargainingEnabled } : {}),
    ...(body.minPrice !== undefined
      ? { minPriceMinor: body.minPrice === null ? null : toMinorUnits(body.minPrice, currency) }
      : {}),
    ...(body.quantityDiscounts !== undefined ? { quantityDiscounts: body.quantityDiscounts } : {}),
  };
}

const bundleBody = z.object({
  /** null switches the bundle discount off. */
  bundle: z
    .object({
      minItems: z.number().int().min(2).max(20),
      percentOff: z.number().int().min(1).max(90),
    })
    .nullable(),
});

/** Smart pricing for the dashboard: the shop's bundle discount and bargaining results. */
export async function pricingRoutes(app: FastifyInstance, { container }: { container: Container }) {
  const { db } = container;

  app.get('/api/pricing', async (request) => {
    const merchantId = request.merchant.id;
    const since = new Date(Date.now() - 30 * 24 * 3_600_000);
    const [merchant, products, offers, discounted] = await Promise.all([
      db.merchant.findUniqueOrThrow({
        where: { id: merchantId },
        select: { bundleMinItems: true, bundlePercentOff: true, preferredCurrency: true },
      }),
      db.product.findMany({
        where: { merchantId, active: true },
        select: { bargainingEnabled: true, minPriceMinor: true, quantityDiscounts: true },
      }),
      db.priceOffer.groupBy({
        by: ['status'],
        where: { merchantId, createdAt: { gte: since } },
        _count: { _all: true },
      }),
      // Paid orders with a discounted line (bargain, quantity or bundle), newest first.
      db.order.findMany({
        where: {
          merchantId,
          status: { in: ['PAID', 'AWAITING_PAYMENT', 'DRAFT'] },
          customerConfirmedAt: { not: null },
          items: { some: { listUnitPriceMinor: { not: null } } },
        },
        include: {
          customer: { select: { name: true } },
          items: { orderBy: { position: 'asc' } },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);
    const count = (status: string) => offers.find((o) => o.status === status)?._count._all ?? 0;
    const orders = discounted.map((o) => {
      const discountMinor = o.items.reduce(
        (sum, i) =>
          sum +
          (i.listUnitPriceMinor !== null
            ? (i.listUnitPriceMinor - i.unitPriceMinor) * i.quantity
            : 0),
        0,
      );
      return {
        id: o.id,
        reference: o.reference,
        customer: o.contactName ?? o.customer.name,
        status: o.status,
        createdAt: o.createdAt,
        currency: o.currency,
        totalMinor: o.totalMinor,
        regularMinor: o.subtotalMinor + discountMinor + o.shippingMinor + o.taxMinor,
        discountMinor,
        negotiated: o.items.some((i) => i.pricing === 'NEGOTIATED'),
        items: o.items.map((i) => ({
          description: i.description,
          quantity: i.quantity,
          unitPriceMinor: i.unitPriceMinor,
          listUnitPriceMinor: i.listUnitPriceMinor,
          pricing: i.pricing,
        })),
      };
    });
    const paid = orders.filter((o) => o.status === 'PAID');
    const accepted = count('ACCEPTED');
    const asked = accepted + count('REJECTED') + count('SUPERSEDED') + count('OPEN');
    return {
      currency: merchant.preferredCurrency,
      bundle:
        merchant.bundleMinItems && merchant.bundlePercentOff
          ? { minItems: merchant.bundleMinItems, percentOff: merchant.bundlePercentOff }
          : null,
      products: {
        active: products.length,
        bargaining: products.filter((p) => p.bargainingEnabled && p.minPriceMinor !== null).length,
        quantityDeals: products.filter(
          (p) => Array.isArray(p.quantityDiscounts) && p.quantityDiscounts.length > 0,
        ).length,
      },
      last30Days: {
        offersMade: asked,
        dealsAgreed: accepted,
        paidDiscountedOrders: paid.length,
        paidNegotiatedOrders: paid.filter((o) => o.negotiated).length,
        // Same-currency sums only (the merchant's currency); other currencies are listed per order.
        revenueMinor: paid
          .filter((o) => o.currency === merchant.preferredCurrency && o.createdAt >= since)
          .reduce((sum, o) => sum + o.totalMinor, 0),
        discountMinor: paid
          .filter((o) => o.currency === merchant.preferredCurrency && o.createdAt >= since)
          .reduce((sum, o) => sum + o.discountMinor, 0),
      },
      orders,
    };
  });

  app.put('/api/pricing/bundle', async (request) => {
    const { bundle } = parse(bundleBody, request.body);
    validateBundleRule(bundle);
    const before = await db.merchant.findUniqueOrThrow({
      where: { id: request.merchant.id },
      select: { bundleMinItems: true, bundlePercentOff: true },
    });
    await db.merchant.update({
      where: { id: request.merchant.id },
      data: {
        bundleMinItems: bundle?.minItems ?? null,
        bundlePercentOff: bundle?.percentOff ?? null,
      },
    });
    await container.audit.record({
      merchantId: request.merchant.id,
      actor: 'MERCHANT',
      type: 'pricing.bundle_updated',
      entityType: 'merchant',
      entityId: request.merchant.id,
      data: {
        before: before.bundleMinItems
          ? { minItems: before.bundleMinItems, percentOff: before.bundlePercentOff }
          : null,
        after: bundle,
      },
    });
    return { bundle };
  });
}

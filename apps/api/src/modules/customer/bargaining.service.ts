import {
  automaticUnitPrice,
  bundleQualifies,
  formatMoney,
  negotiate,
  pricingRulesOf,
  quantityTier,
  unitFromTotal,
  type AuditService,
  type PricingRules,
} from '@vca/commerce';
import type { Database, PriceOffer, Product } from '@vca/database';
import { AppError } from '@vca/shared';
import { MAX_LINE_QUANTITY, ShopOrderService, type ShopActor } from './shop-order.service';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** An offer the customer hasn't answered stays open this long. */
export const OPEN_OFFER_MINUTES = 60;
/** An agreed price holds for the cart this long (then the cart goes back to the regular price). */
export const DEAL_HOURS = 24;
/** Counter-offers per product are counted over this window, so starting over doesn't reset them. */
export const BARGAIN_WINDOW_HOURS = 24;

/**
 * Every outcome carries the customer-facing `message` (built here, from the database), the money
 * amounts the assistant may mention (`amountsMinor`) and the one it must mention (`keyMinor`).
 */
export type BargainResult = {
  status:
    | 'not_found'
    | 'invalid'
    | 'fixed_price'
    | 'best_price'
    | 'counter'
    | 'final'
    | 'agreed'
    | 'no_offer'
    | 'expired'
    | 'declined'
    | 'unavailable';
  message: string;
  product?: string;
  quantity?: number;
  regularPrice?: string;
  offerPrice?: string;
  final?: boolean;
  amountsMinor: number[];
  keyMinor: number | null;
};

const each = (quantity: number) => (quantity > 1 ? ` each (× ${quantity})` : '');

/**
 * WhatsApp bargaining. The customer asks for a better price or names one; the shop answers with
 * negotiate() from @vca/commerce, inside the merchant's minimum, and records every offer. An
 * accepted offer is bound to this customer's open cart and expires; the cart applies it through
 * ShopOrderService pricing, which re-validates it on every change and at ORDER. Nothing here
 * takes a price from the AI: the model only passes the customer's own words through (their
 * proposed price), and whatever it passes, the result stays within the merchant's rules.
 */
export class BargainingService {
  constructor(
    private readonly db: Database,
    private readonly shop: ShopOrderService,
    private readonly audit: AuditService,
  ) {}

  private money(minor: number, currency: string) {
    return formatMoney(minor, currency);
  }

  /** The bundle rule that applies if `productId` is in the cart with what's already there. */
  private async bundleFor(merchantId: string, cartProductIds: string[], productId: string) {
    const merchant = await this.db.merchant.findUniqueOrThrow({
      where: { id: merchantId },
      select: { bundleMinItems: true, bundlePercentOff: true },
    });
    if (!merchant.bundleMinItems || !merchant.bundlePercentOff) return null;
    const rule = { minItems: merchant.bundleMinItems, percentOff: merchant.bundlePercentOff };
    const ids = [...new Set([...cartProductIds, productId])];
    const products = await this.db.product.findMany({
      where: { id: { in: ids }, merchantId },
      select: {
        id: true,
        unitPriceMinor: true,
        bargainingEnabled: true,
        minPriceMinor: true,
        quantityDiscounts: true,
      },
    });
    return bundleQualifies(
      rule,
      products.map((p) => ({
        productId: p.id,
        bargainingEnabled: pricingRulesOf(p).bargainingEnabled,
      })),
    )
      ? rule
      : null;
  }

  /** Public, customer-safe wording of a product's quantity discounts (never the minimum). */
  static quantityDeals(rules: PricingRules): string | null {
    if (!rules.quantityDiscounts.length) return null;
    return rules.quantityDiscounts
      .map((t) => `buy ${t.minQuantity}+ and get ${t.percentOff}% off each`)
      .join('; ');
  }

  /**
   * The customer asks for a better price on one product, optionally naming a price (per unit or
   * for the whole quantity). Serialised per customer so two quick messages can't both take a round.
   */
  async ask(
    actor: ShopActor,
    productId: string,
    input: {
      quantity?: number | null;
      customerUnitMinor?: number | null;
      customerTotalMinor?: number | null;
    },
    now = new Date(),
  ): Promise<BargainResult> {
    const merchantId = actor.merchant.id;
    const outcome = await this.db.$transaction(
      async (tx): Promise<{ result: BargainResult } | { acceptId: string }> => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`bargain:${actor.customer.id}`}))`;
        const product = await tx.product.findFirst({
          where: { id: productId, merchantId, active: true, visibleToCustomers: true },
        });
        if (!product)
          return {
            result: this.result(
              'not_found',
              "I couldn't find that product. Reply *1* to see what we have.",
            ),
          };
        const cart = await this.shop.cart(merchantId, actor.customer.id, now);
        const line = cart?.items.find((i) => i.productId === product.id);
        const quantity = input.quantity ?? line?.quantity ?? 1;
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_LINE_QUANTITY)
          return {
            result: this.result(
              'invalid',
              `I can discuss prices for 1 to ${MAX_LINE_QUANTITY} units here. For more, reply *4* to talk to the team.`,
            ),
          };
        const rules = pricingRulesOf(product);
        const money = (m: number) => this.money(m, product.currency);
        const bundle = await this.bundleFor(
          merchantId,
          (cart?.items ?? []).map((i) => i.productId).filter((id): id is string => !!id),
          product.id,
        );
        const auto = automaticUnitPrice(rules, quantity, bundle);
        const base = {
          product: product.name,
          quantity,
          regularPrice: money(product.unitPriceMinor),
        };

        if (!rules.bargainingEnabled) {
          const deals = BargainingService.quantityDeals(rules);
          const tier = quantityTier(rules, quantity);
          return {
            result: {
              ...this.result(
                'fixed_price',
                [
                  `${product.name} has a fixed price of ${money(product.unitPriceMinor)}, so I can't lower it, sorry.`,
                  tier
                    ? `For ${quantity} you already get ${tier.percentOff}% off: ${money(auto.unitMinor)} each.`
                    : deals
                      ? `Good news: ${deals}.`
                      : null,
                ]
                  .filter(Boolean)
                  .join(' '),
                [product.unitPriceMinor, auto.unitMinor],
                product.unitPriceMinor,
              ),
              ...base,
            },
          };
        }

        const history = await tx.priceOffer.findMany({
          where: {
            merchantId,
            customerId: actor.customer.id,
            productId: product.id,
            // Declined offers still count: saying "no deal" and asking again doesn't reset the ladder.
            createdAt: { gte: new Date(now.getTime() - BARGAIN_WINDOW_HOURS * HOUR) },
          },
          orderBy: { createdAt: 'desc' },
        });
        const round = Math.max(0, ...history.map((o) => o.round));
        const standing =
          history.find(
            (o) =>
              o.quantity === quantity &&
              o.expiresAt > now &&
              (o.status === 'OPEN' ||
                (o.status === 'ACCEPTED' && (!o.orderId || o.orderId === cart?.id))),
          )?.offerUnitMinor ?? null;
        const customerUnit =
          input.customerUnitMinor ??
          (input.customerTotalMinor ? unitFromTotal(input.customerTotalMinor, quantity) : null);
        const decision = negotiate({
          baseUnitMinor: auto.unitMinor,
          floorMinor: rules.minPriceMinor!,
          round,
          standingOfferMinor: standing,
          customerUnitMinor: customerUnit,
        });
        // The reply may echo the customer's own figure ("I can't do $20, but…"); the guard still
        // requires the shop's actual offer in it.
        const amounts = [
          product.unitPriceMinor,
          auto.unitMinor,
          ...(standing ? [standing] : []),
          ...(customerUnit ? [customerUnit] : []),
          ...(input.customerTotalMinor ? [input.customerTotalMinor] : []),
        ];

        const record = (offerUnitMinor: number, nextRound: number) =>
          tx.priceOffer.create({
            data: {
              merchantId,
              customerId: actor.customer.id,
              productId: product.id,
              quantity,
              currency: product.currency,
              listUnitMinor: product.unitPriceMinor,
              offerUnitMinor,
              customerUnitMinor: customerUnit,
              round: nextRound,
              status: 'OPEN',
              expiresAt: new Date(now.getTime() + OPEN_OFFER_MINUTES * MINUTE),
            },
          });
        const supersedeOpen = () =>
          tx.priceOffer.updateMany({
            where: {
              merchantId,
              customerId: actor.customer.id,
              productId: product.id,
              status: 'OPEN',
            },
            data: { status: 'SUPERSEDED' },
          });

        switch (decision.kind) {
          case 'best_price':
            return {
              result: {
                ...this.result(
                  'best_price',
                  `${money(decision.unitMinor)}${each(quantity)} is already my best price for ${product.name}. Reply *add* to put it in your cart.`,
                  amounts,
                  decision.unitMinor,
                ),
                ...base,
                offerPrice: money(decision.unitMinor),
              },
            };
          case 'final':
            return {
              result: {
                ...this.result(
                  'final',
                  `I'm sorry, ${money(decision.offerUnitMinor)}${each(quantity)} is really my best price for ${product.name}. Reply *deal* to take it, or *no deal* to keep the regular price.`,
                  [...amounts, decision.offerUnitMinor],
                  decision.offerUnitMinor,
                ),
                ...base,
                offerPrice: money(decision.offerUnitMinor),
                final: true,
              },
            };
          case 'counter': {
            await supersedeOpen();
            await record(decision.offerUnitMinor, decision.round);
            const opener = decision.final ? 'This is my best price:' : 'I can offer you';
            return {
              result: {
                ...this.result(
                  'counter',
                  `${opener} ${product.name} for *${money(decision.offerUnitMinor)}*${each(quantity)} (regular price ${money(product.unitPriceMinor)}). Reply *deal* to accept${decision.final ? '.' : ', or make me an offer.'}`,
                  [...amounts, decision.offerUnitMinor],
                  decision.offerUnitMinor,
                ),
                ...base,
                offerPrice: money(decision.offerUnitMinor),
                final: decision.final,
              },
            };
          }
          case 'accept': {
            // The customer's own price is within range: it becomes the shop's offer, accepted below.
            await supersedeOpen();
            const offer = await record(decision.unitMinor, round);
            return { acceptId: offer.id };
          }
        }
        throw new Error('unreachable bargaining decision');
      },
    );
    if ('result' in outcome) return outcome.result;
    return this.accept(actor, { offerId: outcome.acceptId }, now);
  }

  /**
   * The customer accepts the shop's open offer(s) — "deal". The offer is claimed atomically (a
   * repeated "deal" accepts nothing twice), the product is put in the cart at the offer's quantity
   * and the agreed price is bound to that cart.
   */
  async accept(
    actor: ShopActor,
    target: { productId?: string | null; offerId?: string },
    now = new Date(),
  ): Promise<BargainResult> {
    const merchantId = actor.merchant.id;
    const where = {
      merchantId,
      customerId: actor.customer.id,
      ...(target.offerId ? { id: target.offerId } : {}),
      ...(target.productId ? { productId: target.productId } : {}),
    };
    const open = await this.db.priceOffer.findMany({
      where: { ...where, status: 'OPEN' },
      include: { product: true },
      orderBy: { createdAt: 'desc' },
    });
    const live = open.filter(
      (o, i) => o.expiresAt > now && open.findIndex((x) => x.productId === o.productId) === i,
    );
    if (!live.length) {
      if (open.length)
        return this.result(
          'expired',
          'That offer has expired. Ask me again and I will check the best price I can give you now.',
        );
      return this.result(
        'no_offer',
        "There's no price offer waiting for you. Tell me which product you'd like a better price on.",
      );
    }

    const agreed: { offer: PriceOffer; product: Product }[] = [];
    const problems: string[] = [];
    for (const offer of live) {
      const claimed = await this.db.priceOffer.updateMany({
        where: { id: offer.id, status: 'OPEN', expiresAt: { gt: now } },
        data: {
          status: 'ACCEPTED',
          acceptedAt: now,
          expiresAt: new Date(now.getTime() + DEAL_HOURS * HOUR),
        },
      });
      if (claimed.count !== 1) continue; // a concurrent "deal" got it
      try {
        await this.putInCart(actor, offer, now);
      } catch (error) {
        // Stock or cart limits: the offer stays open so the customer can adjust and accept again.
        await this.db.priceOffer.update({
          where: { id: offer.id },
          data: { status: 'OPEN', acceptedAt: null, expiresAt: offer.expiresAt },
        });
        if (!(error instanceof AppError) || error.httpStatus >= 500) throw error;
        problems.push(error.message);
        continue;
      }
      agreed.push({ offer, product: offer.product });
    }

    if (!agreed.length)
      return problems.length
        ? this.result('unavailable', problems.join('\n'))
        : this.result(
            'no_offer',
            'That offer was already accepted. Reply *cart* to see your cart.',
          );

    const cart = await this.shop.reprice(actor, now);
    for (const { offer, product } of agreed)
      await this.audit.record({
        merchantId,
        actor: 'SYSTEM',
        type: 'price_offer.accepted',
        entityType: 'product',
        entityId: product.id,
        data: {
          product: product.name,
          customerId: actor.customer.id,
          quantity: offer.quantity,
          currency: offer.currency,
          listUnitMinor: offer.listUnitMinor,
          agreedUnitMinor: offer.offerUnitMinor,
          round: offer.round,
          cart: cart?.reference ?? null,
        },
      });
    const lines = agreed.map(
      ({ offer, product }) =>
        `${product.name} for *${this.money(offer.offerUnitMinor, offer.currency)}*${each(offer.quantity)} (regular ${this.money(offer.listUnitMinor, offer.currency)})`,
    );
    const first = agreed[0]!;
    return {
      ...this.result(
        'agreed',
        [
          `🤝 Deal! ${lines.join(', ')}. The agreed price is held for you for ${DEAL_HOURS} hours.`,
          ...problems,
          '',
          ShopOrderService.formatCart(cart),
        ].join('\n'),
        agreed.flatMap(({ offer }) => [offer.offerUnitMinor, offer.listUnitMinor]),
        first.offer.offerUnitMinor,
      ),
      product: first.product.name,
      quantity: first.offer.quantity,
      regularPrice: this.money(first.offer.listUnitMinor, first.offer.currency),
      offerPrice: this.money(first.offer.offerUnitMinor, first.offer.currency),
    };
  }

  /** Makes sure the cart holds at least the offer's quantity, then binds the offer to that cart. */
  private async putInCart(actor: ShopActor, offer: PriceOffer, now: Date) {
    const cart = await this.shop.cart(actor.merchant.id, actor.customer.id, now);
    const line = cart?.items.find((i) => i.productId === offer.productId);
    if (!line) await this.shop.add(actor, offer.productId, offer.quantity, now);
    else if (line.quantity < offer.quantity)
      await this.shop.setQuantity(actor, { productId: offer.productId }, offer.quantity, now);
    const current = await this.shop.cart(actor.merchant.id, actor.customer.id, now);
    if (!current) throw new Error('cart missing after adding the agreed product');
    await this.db.$transaction([
      this.db.priceOffer.update({ where: { id: offer.id }, data: { orderId: current.id } }),
      // One agreed price per product and cart: the newest wins.
      this.db.priceOffer.updateMany({
        where: {
          merchantId: actor.merchant.id,
          customerId: actor.customer.id,
          productId: offer.productId,
          status: 'ACCEPTED',
          id: { not: offer.id },
        },
        data: { status: 'SUPERSEDED' },
      }),
    ]);
  }

  /** "No deal" / "regular price": drops open and agreed offers, the cart goes back to normal prices. */
  async decline(
    actor: ShopActor,
    productId: string | null,
    now = new Date(),
  ): Promise<BargainResult> {
    const declined = await this.db.priceOffer.updateMany({
      where: {
        merchantId: actor.merchant.id,
        customerId: actor.customer.id,
        status: { in: ['OPEN', 'ACCEPTED'] },
        ...(productId ? { productId } : {}),
      },
      data: { status: 'REJECTED' },
    });
    const cart = await this.shop.reprice(actor, now);
    if (!declined.count)
      return this.result('no_offer', `No problem.\n\n${ShopOrderService.formatCart(cart)}`);
    return this.result(
      'declined',
      `No problem, we'll keep the regular price.\n\n${ShopOrderService.formatCart(cart)}`,
      (cart?.items ?? []).map((i) => i.unitPriceMinor),
    );
  }

  private result(
    status: BargainResult['status'],
    message: string,
    amountsMinor: number[] = [],
    keyMinor: number | null = null,
  ): BargainResult {
    return { status, message, amountsMinor, keyMinor };
  }
}

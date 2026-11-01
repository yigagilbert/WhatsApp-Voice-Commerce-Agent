import type { ChatModel } from '@vca/ai';
import { formatMoney, latestSlot, localDate, nextSlot, type AuditService } from '@vca/commerce';
import type { Database, Merchant, StatusAd, StatusAdSettings } from '@vca/database';
import { ConflictError, NotFoundError, ValidationError, type Logger } from '@vca/shared';
import type { CustomerCatalog } from '../customer/catalog';
import type { ProductImageService } from '../images/product-image.service';
import {
  aiCopy,
  CTAS,
  nextCta,
  pickProduct,
  templateCaption,
  templateHeadline,
  type AdCopy,
} from './copy';
import { renderStatusImage, THEMES } from './status-image';

/** Automatic retries of a failed advert: 5 and 30 minutes; after that, the dashboard's Retry. */
const BACKOFF_MINUTES = [5, 30];
export const MAX_AUTO_ATTEMPTS = BACKOFF_MINUTES.length + 1;
/** A slot missed while the API was down is still prepared for this long, then skipped. */
const CATCH_UP_MS = 3 * 60 * 60 * 1000;
/** "Generate now" per merchant per local day. */
export const MANUAL_DAILY_LIMIT = 20;
export const MAX_TIMES = 3;

export const DEFAULT_SETTINGS = {
  enabled: false,
  weekdays: [1, 2, 3, 4, 5, 6, 7],
  times: ['09:00'],
  timezone: null as string | null,
  approval: 'MANUAL' as 'MANUAL' | 'AUTO',
  productIds: [] as string[],
};
export type StatusAdSettingsInput = typeof DEFAULT_SETTINGS;

const isUniqueViolation = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';

const parseTime = (t: string) => {
  const [hour, minute] = t.split(':').map(Number);
  return { hour: hour!, minute: minute! };
};

const isoWeekday = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
};

/** Why an advert's product can't be promoted right now (null when it can). */
type Ineligible = 'missing' | 'hidden' | 'out_of_stock' | 'no_photo';
const INELIGIBLE_MESSAGE: Record<Ineligible, string> = {
  missing: 'The product was deleted.',
  hidden: 'The product is hidden from customers or inactive.',
  out_of_stock: 'The product is out of stock.',
  no_photo: 'The product has no photo.',
};

/**
 * WhatsApp Status adverts, prepared for the merchant to post from their own phone.
 *
 * This service never sends anything on WhatsApp (it has no access to the notification service or
 * the gateway): automated Status publishing was assessed as unsupported and unsafe, see
 * docs/architecture/whatsapp-status-marketing.md. It picks in-stock, visible products with photos,
 * writes guarded copy (AI optional, templates otherwise) and renders the image from the live
 * catalogue on request, so a price is never invented and never stale.
 */
export class StatusAdService {
  constructor(
    private readonly db: Database,
    private readonly catalog: Pick<CustomerCatalog, 'purchasable'>,
    private readonly images: Pick<ProductImageService, 'read'>,
    private readonly audit: AuditService,
    private readonly chatModel: ChatModel | null,
    private readonly logger: Logger,
  ) {}

  // ─── Settings ──────────────────────────────────────────────────────────

  async settings(merchant: Pick<Merchant, 'id' | 'timezone'>, now = new Date()) {
    const saved = await this.db.statusAdSettings.findUnique({ where: { merchantId: merchant.id } });
    const settings = { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
    return {
      ...settings,
      merchantTimezone: merchant.timezone,
      nextAt: settings.enabled ? this.nextAt(settings, merchant.timezone, now) : null,
      aiCopy: !!this.chatModel,
    };
  }

  /** The next preparation time, for the dashboard. */
  private nextAt(settings: StatusAdSettingsInput, merchantTz: string, now: Date) {
    const timeZone = settings.timezone ?? merchantTz;
    let best: Date | null = null;
    for (const time of settings.times) {
      let at = now;
      // Walk forward at most a week to find a day that is switched on.
      for (let i = 0; i < 8; i++) {
        at = nextSlot({ frequency: 'DAILY', weekday: 1, ...parseTime(time), timeZone }, at);
        if (settings.weekdays.includes(isoWeekday(localDate(at, timeZone)))) break;
      }
      if (settings.weekdays.includes(isoWeekday(localDate(at, timeZone))) && (!best || at < best))
        best = at;
    }
    return best?.toISOString() ?? null;
  }

  async saveSettings(merchantId: string, input: StatusAdSettingsInput, by: string) {
    const times = [...new Set(input.times)].sort();
    if (!times.length) throw new ValidationError('Choose at least one time.');
    if (times.length > MAX_TIMES)
      throw new ValidationError(`Choose at most ${MAX_TIMES} times a day.`);
    if (!input.weekdays.length) throw new ValidationError('Choose at least one day.');
    // Only this merchant's products can be chosen.
    const owned = input.productIds.length
      ? await this.db.product.findMany({
          where: { merchantId, id: { in: input.productIds } },
          select: { id: true },
        })
      : [];
    if (owned.length !== new Set(input.productIds).size)
      throw new ValidationError('One of the chosen products does not exist.');
    const data = {
      enabled: input.enabled,
      weekdays: [...new Set(input.weekdays)].sort(),
      times,
      timezone: input.timezone,
      approval: input.approval,
      productIds: owned.map((p) => p.id),
    };
    const saved = await this.db.statusAdSettings.upsert({
      where: { merchantId },
      update: data,
      create: { merchantId, ...data },
    });
    await this.audit.record({
      merchantId,
      actor: 'MERCHANT',
      type: 'status_ad.settings_updated',
      entityType: 'status_ad_settings',
      entityId: saved.id,
      data: { ...data, productIds: data.productIds.length, by },
    });
    return saved;
  }

  // ─── Products ──────────────────────────────────────────────────────────

  /** Products that may be promoted: chosen in settings, visible, active, in stock, with a photo. */
  async eligibleProducts(merchantId: string, productIds: string[] = []) {
    const products = (await this.catalog.purchasable(merchantId)).filter((p) => p.image);
    return productIds.length ? products.filter((p) => productIds.includes(p.id)) : products;
  }

  /** Every product with whether it could be promoted now (the dashboard's product picker). */
  async productChoices(merchantId: string) {
    const [all, eligible] = await Promise.all([
      this.db.product.findMany({
        where: { merchantId },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
        take: 500,
      }),
      this.eligibleProducts(merchantId),
    ]);
    const ok = new Set(eligible.map((p) => p.id));
    return all.map((p) => ({ ...p, eligible: ok.has(p.id) }));
  }

  private async ineligible(
    merchantId: string,
    productId: string | null,
  ): Promise<Ineligible | null> {
    if (!productId) return 'missing';
    const product = await this.db.product.findFirst({
      where: { id: productId, merchantId },
      include: { image: { select: { id: true } } },
    });
    if (!product) return 'missing';
    if (!product.active || !product.visibleToCustomers) return 'hidden';
    if (!product.image) return 'no_photo';
    const purchasable = await this.catalog.purchasable(merchantId);
    return purchasable.some((p) => p.id === productId) ? null : 'out_of_stock';
  }

  // ─── Generation ────────────────────────────────────────────────────────

  /** One scheduler pass: prepares due slots, then retries failed adverts that are due. */
  async tick(now = new Date()) {
    const all = await this.db.statusAdSettings.findMany({
      where: { enabled: true },
      include: { merchant: true },
    });
    for (const settings of all) {
      const timeZone = settings.timezone ?? settings.merchant.timezone;
      for (const time of settings.times) {
        const slot = latestSlot(
          { frequency: 'DAILY', weekday: 1, ...parseTime(time), timeZone },
          now,
        );
        if (now.getTime() - slot.at.getTime() > CATCH_UP_MS) continue;
        const date = localDate(slot.at, timeZone);
        if (!settings.weekdays.includes(isoWeekday(date))) continue;
        await this.create(settings.merchant, settings, {
          slotKey: `SLOT:${date}T${time}`,
          trigger: 'SCHEDULED',
          scheduledFor: slot.at,
          now,
        }).catch((error: unknown) =>
          this.logger.error({ err: error, merchantId: settings.merchantId }, 'status ad failed'),
        );
      }
    }
    const due = await this.db.statusAd.findMany({
      where: {
        status: 'FAILED',
        attempts: { lt: MAX_AUTO_ATTEMPTS },
        nextAttemptAt: { lte: now },
        merchant: { statusAdSettings: { is: { enabled: true } } },
      },
      take: 50,
    });
    for (const ad of due) await this.prepare(ad, now, 'SYSTEM');
  }

  /** "Generate now" in the dashboard (works while the schedule is off). */
  async generateNow(merchant: Merchant, by: string, now = new Date()) {
    const settings = await this.db.statusAdSettings.findUnique({
      where: { merchantId: merchant.id },
    });
    const timeZone = settings?.timezone ?? merchant.timezone;
    const today = localDate(now, timeZone);
    const recent = await this.db.statusAd.findMany({
      where: {
        merchantId: merchant.id,
        trigger: 'MANUAL',
        createdAt: { gte: new Date(now.getTime() - 26 * 60 * 60 * 1000) },
      },
      select: { createdAt: true },
    });
    if (
      recent.filter((a) => localDate(a.createdAt, timeZone) === today).length >= MANUAL_DAILY_LIMIT
    )
      throw new ValidationError(
        `You can generate up to ${MANUAL_DAILY_LIMIT} adverts a day. Edit or retry an existing one instead.`,
      );
    const ad = await this.create(merchant, settings, {
      slotKey: `MANUAL:${now.toISOString()}`,
      trigger: 'MANUAL',
      scheduledFor: now,
      now,
      by,
    });
    if (!ad) throw new ConflictError('An advert is already being prepared. Try again.');
    return ad;
  }

  /** Creates the advert for a slot (once per slot key) and prepares its content. */
  private async create(
    merchant: Merchant,
    settings: StatusAdSettings | null,
    slot: { slotKey: string; trigger: string; scheduledFor: Date; now: Date; by?: string },
  ): Promise<StatusAd | null> {
    const where = { merchantId_slotKey: { merchantId: merchant.id, slotKey: slot.slotKey } };
    if (await this.db.statusAd.findUnique({ where })) return null;
    let ad: StatusAd;
    try {
      ad = await this.db.statusAd.create({
        data: {
          merchantId: merchant.id,
          slotKey: slot.slotKey,
          trigger: slot.trigger,
          scheduledFor: slot.scheduledFor,
          status: 'FAILED',
          lastError: 'Preparing…',
          // If this process stops mid-way, the scheduler picks the advert up again.
          nextAttemptAt: new Date(slot.now.getTime() + 2 * 60_000),
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) return null; // another tick or instance got there first
      throw error;
    }
    return this.prepare(ad, slot.now, slot.by ?? 'SYSTEM', settings, merchant);
  }

  /**
   * Fills an advert: product, copy, CTA, theme. Ends DRAFT (manual approval) or READY (auto), or
   * FAILED with a reason and the next automatic attempt.
   */
  private async prepare(
    ad: StatusAd,
    now: Date,
    by: string,
    settingsRow?: StatusAdSettings | null,
    merchantRow?: Merchant,
  ): Promise<StatusAd> {
    const merchant =
      merchantRow ?? (await this.db.merchant.findUniqueOrThrow({ where: { id: ad.merchantId } }));
    const settingsRaw =
      settingsRow !== undefined
        ? settingsRow
        : await this.db.statusAdSettings.findUnique({ where: { merchantId: ad.merchantId } });
    const settings = { ...DEFAULT_SETTINGS, ...(settingsRaw ?? {}) };
    const attempts = ad.attempts + 1;
    try {
      const eligible = await this.eligibleProducts(ad.merchantId, settings.productIds);
      const history = await this.db.statusAd.findMany({
        where: { merchantId: ad.merchantId, id: { not: ad.id }, productId: { not: null } },
        select: { productId: true, headline: true, cta: true, theme: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 30,
      });
      const lastFeatured = new Map<string, Date>();
      for (const h of history)
        if (h.productId && !lastFeatured.has(h.productId))
          lastFeatured.set(h.productId, h.createdAt);
      const timeZone = settings.timezone ?? merchant.timezone;
      const todayStart = new Date(`${localDate(now, timeZone)}T00:00:00Z`);
      // Comparing against UTC midnight of the local date is close enough to "featured today".
      const product = pickProduct(eligible, lastFeatured, todayStart);
      if (!product)
        throw new ValidationError(
          settings.productIds.length
            ? 'None of the chosen products is in stock, visible to customers and has a photo.'
            : 'No product is in stock, visible to customers and has a photo.',
        );
      const recentHeadlines = history.map((h) => h.headline).filter(Boolean);
      const cta = nextCta(history.map((h) => h.cta));
      const facts = { name: product.name, description: product.description };
      let copy: AdCopy | null = null;
      try {
        const result = await aiCopy(this.chatModel, facts, cta, recentHeadlines);
        copy = result.copy;
        if (result.rejected)
          this.logger.info({ adId: ad.id, reason: result.rejected }, 'AI status copy rejected');
      } catch (error) {
        this.logger.warn({ err: error, adId: ad.id }, 'AI status copy failed; using a template');
      }
      copy ??= {
        headline: templateHeadline(recentHeadlines, history.length + now.getUTCDate()),
        caption: templateCaption(facts, cta),
        source: 'template',
      };
      const theme = ((history[0]?.theme ?? -1) + 1) % THEMES.length;
      const status = settings.approval === 'AUTO' ? 'READY' : 'DRAFT';
      const updated = await this.db.statusAd.update({
        where: { id: ad.id },
        data: {
          productId: product.id,
          status,
          headline: copy.headline,
          caption: copy.caption,
          cta,
          theme,
          source: copy.source,
          attempts,
          lastError: null,
          nextAttemptAt: null,
          ...(status === 'READY' ? { approvedAt: now, approvedBy: 'auto' } : {}),
        },
      });
      await this.audit.record({
        merchantId: ad.merchantId,
        actor: by === 'SYSTEM' ? 'SYSTEM' : 'MERCHANT',
        type: 'status_ad.prepared',
        entityType: 'status_ad',
        entityId: ad.id,
        data: { product: product.name, status, source: copy.source, trigger: ad.trigger, by },
      });
      this.logger.info(
        { merchantId: ad.merchantId, adId: ad.id, status, source: copy.source },
        'status ad prepared',
      );
      return updated;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const wait = BACKOFF_MINUTES[attempts - 1];
      this.logger.warn({ err: error, adId: ad.id, attempts }, 'status ad could not be prepared');
      const failed = await this.db.statusAd.update({
        where: { id: ad.id },
        data: {
          status: 'FAILED',
          attempts,
          lastError: message.slice(0, 300),
          nextAttemptAt: wait === undefined ? null : new Date(now.getTime() + wait * 60_000),
        },
      });
      await this.audit.record({
        merchantId: ad.merchantId,
        actor: 'SYSTEM',
        type: 'status_ad.failed',
        entityType: 'status_ad',
        entityId: ad.id,
        data: { error: message.slice(0, 300), attempts },
      });
      return failed;
    }
  }

  // ─── Review and posting ────────────────────────────────────────────────

  async list(merchantId: string) {
    return this.db.statusAd.findMany({
      where: { merchantId },
      include: { product: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 60,
    });
  }

  private async get(merchantId: string, id: string) {
    const ad = await this.db.statusAd.findFirst({ where: { id, merchantId } });
    if (!ad) throw new NotFoundError('Status advert', id);
    return ad;
  }

  private async assertPromotable(ad: StatusAd) {
    const reason = await this.ineligible(ad.merchantId, ad.productId);
    if (reason) throw new ConflictError(`${INELIGIBLE_MESSAGE[reason]} This advert can’t be used.`);
  }

  /** Edits the wording. In manual-approval mode an edited advert needs approving again. */
  async edit(
    merchantId: string,
    id: string,
    input: { headline: string; caption: string; cta: string; theme: number },
    by: string,
  ) {
    const ad = await this.get(merchantId, id);
    if (ad.status !== 'DRAFT' && ad.status !== 'READY')
      throw new ConflictError('Only drafts and adverts ready to post can be edited.');
    if (!(CTAS as readonly string[]).includes(input.cta))
      throw new ValidationError('Choose one of the listed calls to action.');
    const settings = await this.db.statusAdSettings.findUnique({ where: { merchantId } });
    const reapprove = (settings?.approval ?? 'MANUAL') === 'MANUAL';
    const updated = await this.db.statusAd.update({
      where: { id },
      data: {
        headline: input.headline,
        caption: input.caption,
        cta: input.cta,
        theme: input.theme % THEMES.length,
        source: 'edited',
        ...(reapprove ? { status: 'DRAFT', approvedAt: null, approvedBy: null } : {}),
      },
    });
    await this.audit.record({
      merchantId,
      actor: 'MERCHANT',
      type: 'status_ad.edited',
      entityType: 'status_ad',
      entityId: id,
      data: { by },
    });
    return updated;
  }

  async approve(merchantId: string, id: string, by: string) {
    const ad = await this.get(merchantId, id);
    if (ad.status !== 'DRAFT') throw new ConflictError('Only drafts can be approved.');
    await this.assertPromotable(ad);
    return this.transition(ad, { status: 'READY', approvedAt: new Date(), approvedBy: by }, by);
  }

  /** Recorded by the merchant after posting it on their phone (Katale never posts it). */
  async markPosted(merchantId: string, id: string, by: string) {
    const ad = await this.get(merchantId, id);
    if (ad.status !== 'READY') throw new ConflictError('Approve the advert before posting it.');
    await this.assertPromotable(ad);
    return this.transition(ad, { status: 'POSTED', postedAt: new Date(), postedBy: by }, by);
  }

  async skip(merchantId: string, id: string, by: string) {
    const ad = await this.get(merchantId, id);
    if (ad.status === 'POSTED' || ad.status === 'SKIPPED')
      throw new ConflictError('This advert is already closed.');
    return this.transition(ad, { status: 'SKIPPED', nextAttemptAt: null }, by);
  }

  /** Retries a failed advert now, or prepares a skipped/stale one again with a fresh product. */
  async retry(merchantId: string, id: string, by: string, now = new Date()) {
    const ad = await this.get(merchantId, id);
    if (ad.status !== 'FAILED') throw new ConflictError('Only failed adverts can be retried.');
    return this.prepare(ad, now, by);
  }

  private async transition(ad: StatusAd, data: Partial<StatusAd>, by: string) {
    const updated = await this.db.statusAd.update({ where: { id: ad.id }, data });
    await this.audit.record({
      merchantId: ad.merchantId,
      actor: 'MERCHANT',
      type: `status_ad.${String(data.status).toLowerCase()}`,
      entityType: 'status_ad',
      entityId: ad.id,
      data: { from: ad.status, by },
    });
    return updated;
  }

  /** The advert's image, rendered from the live catalogue (price, name, photo). */
  async image(merchant: Pick<Merchant, 'id' | 'businessName'>, id: string) {
    const ad = await this.get(merchant.id, id);
    if (!ad.productId || ad.status === 'FAILED')
      throw new ConflictError('This advert has no image yet.');
    // Posted/skipped adverts stay viewable in the history; open ones must still be promotable.
    if (ad.status === 'DRAFT' || ad.status === 'READY') await this.assertPromotable(ad);
    const product = await this.db.product.findFirst({
      where: { id: ad.productId, merchantId: merchant.id },
    });
    const photo = await this.images.read(merchant.id, ad.productId, 'main');
    if (!product || !photo) throw new ConflictError('The product photo is no longer available.');
    const bytes = await renderStatusImage({
      shopName: merchant.businessName,
      headline: ad.headline,
      productName: product.name,
      price: formatMoney(product.unitPriceMinor, product.currency),
      cta: ad.cta,
      theme: ad.theme,
      photo: photo.bytes,
    });
    return {
      bytes,
      version: `${ad.updatedAt.getTime()}-${product.updatedAt.getTime()}-${photo.version}`,
    };
  }
}

import type { Database, PaymentLinkMode, WhatsAppAccount } from '@vca/database';
import { ConflictError, NotFoundError, ValidationError } from '@vca/shared';
import type { AuditService } from './audit.service';

export interface WhatsAppAccountSettings {
  customerCommerceEnabled?: boolean;
  paymentLinkMode?: PaymentLinkMode;
  handoffHours?: number;
  shopInfo?: string | null;
  deliveryEnabled?: boolean;
  /** Flat delivery fee in minor units of the merchant's currency. */
  deliveryFeeMinor?: number;
  pickupEnabled?: boolean;
  pickupInfo?: string | null;
}

const BOT_ID = /^\d{6,15}@c\.us$/;

/**
 * Bot numbers and the merchant each one serves. A number belongs to exactly one merchant, so a
 * customer's messages (and the catalog they see) can never cross shops.
 */
export class WhatsAppAccountService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  /** The account for the bot that received a message (with its merchant), or null. */
  forBot(wid: string | null | undefined) {
    if (!wid) return Promise.resolve(null);
    return this.db.whatsAppAccount.findUnique({ where: { wid }, include: { merchant: true } });
  }

  forMerchant(merchantId: string) {
    return this.db.whatsAppAccount.findMany({
      where: { merchantId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Assigns the currently linked bot number to a merchant. Never takes it from another one. */
  async connect(merchantId: string, wid: string): Promise<WhatsAppAccount> {
    if (!BOT_ID.test(wid)) throw new ValidationError('The WhatsApp bot is not connected yet.');
    const existing = await this.db.whatsAppAccount.findUnique({ where: { wid } });
    if (existing && existing.merchantId !== merchantId) {
      throw new ConflictError('This WhatsApp number is already connected to another business.');
    }
    if (existing) return existing;
    const account = await this.db.whatsAppAccount.create({ data: { merchantId, wid } });
    await this.audit.record({
      merchantId,
      actor: 'MERCHANT',
      type: 'whatsapp.account_connected',
      entityType: 'whatsapp_account',
      entityId: account.id,
      data: { number: `•••• ${wid.split('@')[0]!.slice(-4)}` },
    });
    return account;
  }

  async update(
    merchantId: string,
    id: string,
    settings: WhatsAppAccountSettings,
    options: { customerCommerceAvailable: boolean },
  ): Promise<WhatsAppAccount> {
    const account = await this.db.whatsAppAccount.findFirst({ where: { id, merchantId } });
    if (!account) throw new NotFoundError('WhatsApp account', id);
    if (settings.customerCommerceEnabled && !options.customerCommerceAvailable) {
      throw new ConflictError('Customer shopping on WhatsApp is not available on this server yet.');
    }
    if (
      settings.handoffHours !== undefined &&
      (!Number.isInteger(settings.handoffHours) ||
        settings.handoffHours < 1 ||
        settings.handoffHours > 168)
    ) {
      throw new ValidationError('Hand-off pause must be between 1 and 168 hours.');
    }
    if (
      settings.deliveryFeeMinor !== undefined &&
      (!Number.isInteger(settings.deliveryFeeMinor) ||
        settings.deliveryFeeMinor < 0 ||
        settings.deliveryFeeMinor > 1_000_000)
    ) {
      throw new ValidationError('Delivery fee must be a positive amount.');
    }
    const delivery = settings.deliveryEnabled ?? account.deliveryEnabled;
    const pickup = settings.pickupEnabled ?? account.pickupEnabled;
    if (!delivery && !pickup)
      throw new ValidationError('Offer delivery, pickup or both so customers can receive orders.');
    const updated = await this.db.whatsAppAccount.update({
      where: { id: account.id },
      data: {
        ...(settings.customerCommerceEnabled !== undefined
          ? { customerCommerceEnabled: settings.customerCommerceEnabled }
          : {}),
        ...(settings.paymentLinkMode ? { paymentLinkMode: settings.paymentLinkMode } : {}),
        ...(settings.handoffHours !== undefined ? { handoffHours: settings.handoffHours } : {}),
        ...(settings.shopInfo !== undefined
          ? { shopInfo: settings.shopInfo?.trim().slice(0, 2000) || null }
          : {}),
        ...(settings.deliveryEnabled !== undefined
          ? { deliveryEnabled: settings.deliveryEnabled }
          : {}),
        ...(settings.deliveryFeeMinor !== undefined
          ? { deliveryFeeMinor: settings.deliveryFeeMinor }
          : {}),
        ...(settings.pickupEnabled !== undefined ? { pickupEnabled: settings.pickupEnabled } : {}),
        ...(settings.pickupInfo !== undefined
          ? { pickupInfo: settings.pickupInfo?.trim().slice(0, 300) || null }
          : {}),
      },
    });
    await this.audit.record({
      merchantId,
      actor: 'MERCHANT',
      type: 'whatsapp.account_updated',
      entityType: 'whatsapp_account',
      entityId: account.id,
      data: {
        customerCommerceEnabled: updated.customerCommerceEnabled,
        paymentLinkMode: updated.paymentLinkMode,
        handoffHours: updated.handoffHours,
      },
    });
    return updated;
  }
}

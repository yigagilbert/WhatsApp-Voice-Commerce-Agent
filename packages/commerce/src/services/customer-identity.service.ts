import type { Customer, Database } from '@vca/database';
import { chatIdToPhone, normalizePhone, phoneToChatId } from './admin.service';
import type { AuditService } from './audit.service';

export interface WhatsAppSender {
  /** WhatsApp chat ID: "256700000000@c.us" or a linked ID "…@lid". */
  senderId: string;
  /** E.164 phone resolved by WhatsApp itself (worker), when available. */
  senderPhone?: string | null | undefined;
  /** Profile name (user-controlled): used only as a display name for new customers. */
  senderName?: string | null | undefined;
}

export interface IdentifiedCustomer {
  customer: Customer;
  /** First message from this person to this merchant. */
  created: boolean;
  /** Matched to a customer the merchant had already created (by WhatsApp-verified phone). */
  linked: boolean;
}

const isUniqueViolation = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';

/** Profile names are untrusted text: strip control characters and keep them short. */
export const displayName = (name: string | null | undefined) =>
  (name ?? '')
    .replace(/\p{Cc}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || 'WhatsApp customer';

/**
 * Who is this customer? Identity is the WhatsApp ID the message came from (phone-number ID or
 * linked ID), scoped to one merchant. Records are linked automatically only when WhatsApp itself
 * reveals a phone number that matches; names and numbers typed in the chat are never trusted.
 */
export class CustomerIdentityService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly defaultRegion = 'UG',
  ) {}

  async identify(merchantId: string, sender: WhatsAppSender): Promise<IdentifiedCustomer> {
    const { senderId } = sender;
    const isLid = senderId.endsWith('@lid');
    const phone = sender.senderPhone ?? chatIdToPhone(senderId);

    const known = await this.db.customer.findFirst({
      where: { merchantId, OR: [{ whatsappId: senderId }, { whatsappLid: senderId }] },
    });
    if (known) {
      if (phone && !known.whatsappPhone) {
        return {
          customer: await this.db.customer.update({
            where: { id: known.id },
            data: { whatsappPhone: phone },
          }),
          created: false,
          linked: false,
        };
      }
      return { customer: known, created: false, linked: false };
    }

    if (phone) {
      const match = await this.matchByPhone(merchantId, phone);
      if (match) {
        const customer = await this.db.customer.update({
          where: { id: match.id },
          data: {
            whatsappPhone: phone,
            ...(match.whatsappId ? {} : { whatsappId: senderId }),
            ...(isLid ? { whatsappLid: senderId } : {}),
          },
        });
        await this.audit.record({
          merchantId,
          actor: 'SYSTEM',
          type: 'customer.whatsapp_linked',
          entityType: 'customer',
          entityId: customer.id,
          data: { name: customer.name, via: isLid ? 'linked ID + verified phone' : 'phone' },
        });
        return { customer, created: false, linked: true };
      }
    }

    try {
      const customer = await this.db.customer.create({
        data: {
          merchantId,
          name: displayName(sender.senderName),
          whatsappId: senderId,
          whatsappLid: isLid ? senderId : null,
          whatsappPhone: phone,
          phone,
          source: 'WHATSAPP',
        },
      });
      await this.audit.record({
        merchantId,
        actor: 'SYSTEM',
        type: 'customer.created_from_whatsapp',
        entityType: 'customer',
        entityId: customer.id,
        data: { name: customer.name, linkedId: isLid },
      });
      return { customer, created: true, linked: false };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Two messages raced: the other one created the record.
      const customer = await this.db.customer.findFirstOrThrow({
        where: { merchantId, OR: [{ whatsappId: senderId }, { whatsappLid: senderId }] },
      });
      return { customer, created: false, linked: false };
    }
  }

  /**
   * One existing customer whose number is this WhatsApp-verified phone: already verified, set as
   * their WhatsApp ID, or typed by the merchant (normalised). Ambiguous matches link nothing.
   */
  private async matchByPhone(merchantId: string, phone: string): Promise<Customer | null> {
    const direct = await this.db.customer.findMany({
      where: {
        merchantId,
        OR: [{ whatsappPhone: phone }, { whatsappId: phoneToChatId(phone) }],
        whatsappLid: null,
      },
      take: 2,
    });
    if (direct.length === 1) return direct[0]!;
    if (direct.length > 1) return null;
    const typed = await this.db.customer.findMany({
      where: { merchantId, whatsappId: null, phone: { not: null } },
      select: { id: true, phone: true },
      take: 2000,
    });
    const same = typed.filter((c) => {
      try {
        return normalizePhone(c.phone!, this.defaultRegion) === phone;
      } catch {
        return false;
      }
    });
    if (same.length !== 1) return null;
    return this.db.customer.findUnique({ where: { id: same[0]!.id } });
  }
}

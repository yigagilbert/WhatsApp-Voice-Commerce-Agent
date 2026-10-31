import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import type { Database, MerchantOperator, Prisma } from '@vca/database';
import { ConflictError, NotFoundError, ValidationError } from '@vca/shared';
import type { AuditService } from './audit.service';

/**
 * Normalises a phone number to E.164 ("+256700000000"). Local numbers ("0700 000000") use
 * `defaultRegion`. Throws a ValidationError for anything that isn't a valid number.
 */
export function normalizePhone(input: string, defaultRegion: string = 'UG'): string {
  const parsed = parsePhoneNumberFromString(
    input.trim(),
    defaultRegion.toUpperCase() as CountryCode,
  );
  if (!parsed?.isValid()) {
    throw new ValidationError(
      `'${input}' is not a valid phone number. Use international format, e.g. +256 700 000000.`,
    );
  }
  return parsed.number;
}

/** WhatsApp chat ID for a phone number ("+256700000000" → "256700000000@c.us"). */
export const phoneToChatId = (e164: string) => `${e164.replace(/^\+/, '')}@c.us`;

/** The E.164 phone behind a phone-number chat ID, or null for linked IDs (@lid) and others. */
export const chatIdToPhone = (chatId: string): string | null => {
  const match = /^(\d{6,15})@c\.us$/.exec(chatId);
  return match ? `+${match[1]}` : null;
};

export interface AdminInput {
  name: string;
  phone: string;
  receiveReports?: boolean;
  receiveAlerts?: boolean;
  active?: boolean;
  /** OWNER can approve payment requests and dispute responses; STAFF can't (default STAFF). */
  role?: 'OWNER' | 'STAFF';
}

export type AuthorizeResult =
  | { ok: true; operator: MerchantOperator & { merchant: Prisma.MerchantGetPayload<object> } }
  | { ok: false; reason: 'unknown' | 'inactive' };

/**
 * WhatsApp administrators: the only numbers that can operate Katale AI or receive business data.
 * Stored on MerchantOperator (channel "whatsapp"), scoped to one merchant each.
 */
export class AdminService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly defaultRegion = 'UG',
  ) {}

  list(merchantId: string) {
    return this.db.merchantOperator.findMany({
      where: { merchantId, channel: 'whatsapp' },
      orderBy: [{ active: 'desc' }, { createdAt: 'asc' }],
    });
  }

  private async get(merchantId: string, id: string) {
    const admin = await this.db.merchantOperator.findFirst({
      where: { id, merchantId, channel: 'whatsapp' },
    });
    if (!admin) throw new NotFoundError('Admin', id);
    return admin;
  }

  /** A number can belong to one merchant only; the error doesn't reveal which. */
  private async assertPhoneFree(phone: string, exceptId?: string) {
    const taken = await this.db.merchantOperator.findFirst({
      where: {
        channel: 'whatsapp',
        OR: [{ phone }, { externalId: phoneToChatId(phone) }],
        ...(exceptId ? { NOT: { id: exceptId } } : {}),
      },
    });
    if (taken) throw new ConflictError(`${phone} is already registered as an admin.`);
  }

  async create(merchantId: string, input: AdminInput, actor = 'dashboard') {
    const name = input.name.trim();
    if (!name) throw new ValidationError('Name is required.');
    const phone = normalizePhone(input.phone, this.defaultRegion);
    await this.assertPhoneFree(phone);
    const admin = await this.db.merchantOperator.create({
      data: {
        merchantId,
        name: name.slice(0, 80),
        channel: 'whatsapp',
        externalId: phoneToChatId(phone),
        phone,
        role: input.role ?? 'STAFF',
        active: input.active ?? true,
        receiveReports: input.receiveReports ?? true,
        receiveAlerts: input.receiveAlerts ?? true,
      },
    });
    await this.audit.record({
      merchantId,
      actor: 'MERCHANT',
      type: 'admin.added',
      entityType: 'operator',
      entityId: admin.id,
      data: { name: admin.name, phone: maskPhone(phone), via: actor },
    });
    return admin;
  }

  async update(merchantId: string, id: string, patch: Partial<AdminInput>) {
    const admin = await this.get(merchantId, id);
    const data: Prisma.MerchantOperatorUpdateInput = {};
    if (patch.name !== undefined) {
      if (!patch.name.trim()) throw new ValidationError('Name is required.');
      data.name = patch.name.trim().slice(0, 80);
    }
    if (patch.phone !== undefined) {
      const phone = normalizePhone(patch.phone, this.defaultRegion);
      if (phone !== admin.phone) {
        await this.assertPhoneFree(phone, admin.id);
        data.phone = phone;
        data.externalId = phoneToChatId(phone);
        data.whatsappLid = null; // re-learned from the new number's first message
      }
    }
    if (patch.active !== undefined) data.active = patch.active;
    if (patch.role !== undefined) data.role = patch.role;
    const stillOwner = (patch.role ?? admin.role) === 'OWNER' && (patch.active ?? admin.active);
    if (admin.role === 'OWNER' && admin.active && !stillOwner)
      await this.assertAnotherOwner(merchantId, admin.id);
    if (patch.receiveReports !== undefined) data.receiveReports = patch.receiveReports;
    if (patch.receiveAlerts !== undefined) data.receiveAlerts = patch.receiveAlerts;
    const updated = await this.db.merchantOperator.update({ where: { id: admin.id }, data });
    await this.audit.record({
      merchantId,
      actor: 'MERCHANT',
      type: 'admin.updated',
      entityType: 'operator',
      entityId: admin.id,
      data: {
        name: updated.name,
        changed: Object.keys(data).filter((k) => k !== 'externalId' && k !== 'whatsappLid'),
        ...(patch.active !== undefined ? { active: patch.active } : {}),
        ...(patch.role !== undefined ? { role: patch.role } : {}),
      },
    });
    return updated;
  }

  /** Someone must always be able to approve payments over WhatsApp. */
  private async assertAnotherOwner(merchantId: string, exceptId: string) {
    const others = await this.db.merchantOperator.count({
      where: {
        merchantId,
        channel: 'whatsapp',
        role: 'OWNER',
        active: true,
        NOT: { id: exceptId },
      },
    });
    if (!others)
      throw new ConflictError('This is the only active owner. Make another admin an owner first.');
  }

  async remove(merchantId: string, id: string) {
    const admin = await this.get(merchantId, id);
    if (admin.role === 'OWNER' && admin.active) await this.assertAnotherOwner(merchantId, admin.id);
    await this.db.merchantOperator.delete({ where: { id: admin.id } });
    await this.audit.record({
      merchantId,
      actor: 'MERCHANT',
      type: 'admin.removed',
      entityType: 'operator',
      entityId: admin.id,
      data: { name: admin.name, phone: admin.phone ? maskPhone(admin.phone) : null },
    });
  }

  /**
   * Who is sending? Matches the chat ID, a learned linked ID (@lid) or — when the WhatsApp worker
   * resolved it — the sender's phone. Inactive admins are refused like strangers.
   */
  async authorize(
    channel: string,
    senderId: string,
    senderPhone?: string | null,
    /**
     * The merchant of the bot that received the message, when known. Admins of other shops are
     * not admins on this number: their shop's data must never flow through it.
     */
    merchantId?: string,
  ): Promise<AuthorizeResult> {
    const phone = senderPhone ?? (channel === 'whatsapp' ? chatIdToPhone(senderId) : null);
    // One person can match several rows (an old row keyed by their linked ID, a newer one by
    // phone). An active row wins, so a deactivated duplicate never locks a working admin out.
    const operator = await this.db.merchantOperator.findFirst({
      where: {
        channel,
        ...(merchantId ? { merchantId } : {}),
        OR: [{ externalId: senderId }, { whatsappLid: senderId }, ...(phone ? [{ phone }] : [])],
      },
      orderBy: [{ active: 'desc' }, { createdAt: 'asc' }],
      include: { merchant: true },
    });
    if (!operator) return { ok: false, reason: 'unknown' };
    if (!operator.active) return { ok: false, reason: 'inactive' };
    // Remember the linked ID so later messages match even without a resolved phone.
    if (channel === 'whatsapp' && senderId.endsWith('@lid') && operator.whatsappLid !== senderId) {
      await this.db.merchantOperator.update({
        where: { id: operator.id },
        data: { whatsappLid: senderId },
      });
    }
    return { ok: true, operator };
  }

  /** Active WhatsApp admins who opted in to reports or alerts. */
  recipients(merchantId: string, kind: 'reports' | 'alerts') {
    return this.db.merchantOperator.findMany({
      where: {
        merchantId,
        channel: 'whatsapp',
        active: true,
        ...(kind === 'reports' ? { receiveReports: true } : { receiveAlerts: true }),
      },
      orderBy: { createdAt: 'asc' },
    });
  }
}

/** "+256 ••• •• 0000" style mask for audit logs. */
export const maskPhone = (e164: string) => `${e164.slice(0, 4)}•••${e164.slice(-4)}`;

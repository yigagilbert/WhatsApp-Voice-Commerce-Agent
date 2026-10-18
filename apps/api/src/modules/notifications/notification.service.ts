import type { AdminService } from '@vca/commerce';
import type { Customer, Database } from '@vca/database';
import { ProviderError, getCorrelationId, type Logger, type OutboundMedia } from '@vca/shared';
import type { ChannelRegistry } from './channel-registry';

/**
 * Proactive (not reply) messages: payment received, payment link to a customer, ...
 * Messages are always stored; delivery failures are logged and audited, never thrown,
 * so a flaky channel can't break webhook processing.
 */
export class NotificationService {
  constructor(
    private readonly db: Database,
    private readonly channels: ChannelRegistry,
    private readonly logger: Logger,
    private readonly admins?: AdminService,
  ) {}

  /**
   * Sends to one WhatsApp chat of a merchant (an admin), throwing on failure so the caller can
   * retry (reports). The message is stored in that chat's conversation.
   */
  async sendToChat(
    merchantId: string,
    chatId: string,
    text: string,
    media?: OutboundMedia,
  ): Promise<void> {
    const sender = this.channels.get('whatsapp');
    if (!sender) throw new ProviderError('whatsapp-gateway', 'WhatsApp channel not configured');
    await sender.send({
      channel: 'whatsapp',
      externalChatId: chatId,
      text,
      ...(media ? { media } : {}),
    });
    const conversation = await this.db.conversation.upsert({
      where: {
        merchantId_channel_externalChatId: {
          merchantId,
          channel: 'whatsapp',
          externalChatId: chatId,
        },
      },
      update: { lastMessageAt: new Date() },
      create: { merchantId, channel: 'whatsapp', externalChatId: chatId },
    });
    await this.db.message.create({
      data: {
        conversationId: conversation.id,
        channel: 'whatsapp',
        direction: 'OUTBOUND',
        type: 'TEXT',
        content: media ? `[chart image] ${text}` : text,
        correlationId: getCorrelationId() ?? null,
      },
    });
  }

  /**
   * Alerts (low stock, disputes) to every active admin who opted in. Failures are logged and
   * audited per admin, never thrown. Returns how many admins received it.
   */
  async toAdmins(merchantId: string, text: string): Promise<number> {
    if (!this.admins) return 0;
    const recipients = await this.admins.recipients(merchantId, 'alerts');
    let delivered = 0;
    for (const admin of recipients) {
      try {
        await this.sendToChat(merchantId, admin.externalId, text);
        delivered++;
      } catch (error) {
        this.logger.warn({ err: error, operatorId: admin.id }, 'admin alert delivery failed');
        await this.db.auditEvent.create({
          data: {
            merchantId,
            actor: 'SYSTEM',
            type: 'notification.failed',
            entityType: 'operator',
            entityId: admin.id,
            correlationId: getCorrelationId() ?? null,
            data: {
              channel: 'whatsapp',
              error: error instanceof Error ? error.message : String(error),
            },
          },
        });
      }
    }
    if (delivered) {
      await this.db.auditEvent.create({
        data: {
          merchantId,
          actor: 'SYSTEM',
          type: 'notification.sent',
          entityType: 'merchant',
          entityId: merchantId,
          correlationId: getCorrelationId() ?? null,
          data: {
            channel: 'whatsapp',
            recipients: delivered,
            preview: text.replace(/\*/g, '').slice(0, 80),
          },
        },
      });
    }
    return delivered;
  }

  /** Sends to an existing conversation (e.g. the merchant chat an order came from). */
  async toConversation(conversationId: string, text: string): Promise<boolean> {
    const conversation = await this.db.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation) return false;
    return this.deliver(conversation, text);
  }

  /** Sends to a customer over WhatsApp if we know their WhatsApp ID. */
  async toCustomer(customer: Customer, text: string): Promise<boolean> {
    if (!customer.whatsappId) return false;
    const conversation = await this.db.conversation.upsert({
      where: {
        merchantId_channel_externalChatId: {
          merchantId: customer.merchantId,
          channel: 'whatsapp',
          externalChatId: customer.whatsappId,
        },
      },
      update: {},
      create: {
        merchantId: customer.merchantId,
        customerId: customer.id,
        channel: 'whatsapp',
        externalChatId: customer.whatsappId,
      },
    });
    return this.deliver(conversation, text);
  }

  private async deliver(
    conversation: { id: string; merchantId: string; channel: string; externalChatId: string },
    text: string,
  ): Promise<boolean> {
    await this.db.message.create({
      data: {
        conversationId: conversation.id,
        channel: conversation.channel,
        direction: 'OUTBOUND',
        type: 'TEXT',
        content: text,
        correlationId: getCorrelationId() ?? null,
      },
    });
    const sender = this.channels.get(conversation.channel);
    if (!sender) {
      // e.g. the web channel: the dashboard reads messages from the database instead.
      return false;
    }
    try {
      await sender.send({
        channel: sender.channel,
        externalChatId: conversation.externalChatId,
        text,
      });
      await this.db.auditEvent.create({
        data: {
          merchantId: conversation.merchantId,
          actor: 'SYSTEM',
          type: 'notification.sent',
          entityType: 'conversation',
          entityId: conversation.id,
          correlationId: getCorrelationId() ?? null,
          data: { channel: conversation.channel, preview: text.replace(/\*/g, '').slice(0, 80) },
        },
      });
      return true;
    } catch (error) {
      this.logger.warn(
        { err: error, channel: conversation.channel },
        'notification delivery failed',
      );
      await this.db.auditEvent.create({
        data: {
          merchantId: conversation.merchantId,
          actor: 'SYSTEM',
          type: 'notification.failed',
          entityType: 'conversation',
          entityId: conversation.id,
          correlationId: getCorrelationId() ?? null,
          data: {
            channel: conversation.channel,
            error: error instanceof Error ? error.message : String(error),
          },
        },
      });
      return false;
    }
  }
}

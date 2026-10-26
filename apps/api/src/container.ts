import { OpenAICompatibleChatModel, type ChatModel } from '@vca/ai';
import {
  AnalyticsService,
  InventoryService,
  AdminService,
  CustomerIdentityService,
  WhatsAppAccountService,
  AuditService,
  ConfirmationService,
  CustomerService,
  DashboardUserService,
  OrderService,
  ProductService,
  type PaymentPolicyConfig,
} from '@vca/commerce';
import type { ApiConfig } from '@vca/config';
import { createPrismaClient, type Database } from '@vca/database';
import { PayPalClient, type PayPalApi } from '@vca/paypal';
import type { Logger } from '@vca/shared';
import {
  CascadeSpeechToText,
  FfmpegAudioNormalizer,
  normalizeLugandaNumbers,
  OpenAICompatibleSpeechToText,
  SpeechPipeline,
  SunbirdSpeechToText,
  SunbirdTranslator,
} from '@vca/speech';
import { ConfirmationExecutor } from './modules/agent/confirmation-executor';
import { InboundMessageService } from './modules/agent/inbound.service';
import { createCommerceTools } from './modules/agent/tools';
import { ChannelRegistry, HttpWhatsAppSender } from './modules/notifications/channel-registry';
import { NotificationService } from './modules/notifications/notification.service';
import { PaymentService } from './modules/payments/payment.service';
import { RefundService } from './modules/payments/refund.service';
import { OrderLifecycleService } from './modules/orders/order-lifecycle.service';
import { OpsAlerts } from './modules/ops/ops-alerts';
import { PaymentReminderService } from './modules/payments/reminder.service';
import { PaymentReconciler } from './modules/payments/reconciliation.service';
import { WhatsAppConnectionMonitor } from './modules/whatsapp/connection-monitor';
import { CustomerCatalog } from './modules/customer/catalog';
import { CustomerConversationService } from './modules/customer/customer-conversation.service';
import { createCustomerTools } from './modules/customer/customer-tools';
import { ShopOrderService } from './modules/customer/shop-order.service';
import { PayPalWebhookService } from './modules/paypal/webhook.service';
import { DisputeService } from './modules/disputes/dispute.service';
import { ShipmentService } from './modules/shipments/shipment.service';
import { ReportService } from './modules/reports/report.service';
import { BusinessReportBuilder } from './modules/reports/business-report';
import { ReportScheduler } from './modules/reports/report-scheduler';

export interface ContainerOverrides {
  db?: Database;
  paypal?: PayPalApi;
  chatModel?: ChatModel | null;
  speech?: SpeechPipeline | null;
  channels?: ChannelRegistry;
  alerts?: OpsAlerts;
}

function createChatModel(config: ApiConfig): ChatModel | null {
  if (!config.AI_API_KEY) return null;
  return new OpenAICompatibleChatModel({
    baseUrl: config.AI_BASE_URL,
    apiKey: config.AI_API_KEY,
    model: config.AI_MODEL,
    timeoutMs: config.AI_TIMEOUT_MS,
  });
}

function createSpeechPipeline(config: ApiConfig, logger: Logger): SpeechPipeline | null {
  // Voice is gated separately from STT credentials so a configured key can't switch it on early.
  if (!config.VOICE_NOTES_ENABLED || config.STT_PROVIDER === 'none' || !config.STT_API_KEY)
    return null;
  const whisper = new OpenAICompatibleSpeechToText({
    baseUrl: config.STT_BASE_URL,
    apiKey: config.STT_API_KEY,
    model: config.STT_MODEL,
  });
  const sunbird =
    config.VOICE_EXPERIMENTAL_LUGANDA && config.SUNBIRD_API_KEY
      ? { baseUrl: config.SUNBIRD_API_URL, apiKey: config.SUNBIRD_API_KEY }
      : undefined;
  // English via Whisper (fast, reports language + confidence). Luganda via Sunbird is an opt-in
  // experiment (frozen): see docs/architecture/voice-commerce.md.
  const stt = sunbird
    ? new CascadeSpeechToText({
        primary: whisper,
        primaryLanguages: ['en'],
        secondary: {
          language: 'lg',
          provider: new SunbirdSpeechToText({ ...sunbird, defaultLanguage: 'lg' }),
        },
      })
    : whisper;
  logger.info(
    sunbird
      ? 'voice: English (Whisper) + EXPERIMENTAL Luganda (Sunbird)'
      : 'voice: English (Whisper); other languages are read back for confirmation',
  );
  return new SpeechPipeline({
    stt,
    ...(config.AUDIO_NORMALIZER === 'ffmpeg'
      ? { normalizer: new FfmpegAudioNormalizer({ ffmpegPath: config.FFMPEG_PATH }) }
      : {}),
    ...(config.TRANSLATION_PROVIDER === 'sunbird' && sunbird
      ? { translator: new SunbirdTranslator(sunbird) }
      : {}),
    translateLanguages: config.VOICE_TRANSLATE_LANGUAGES,
    // Money/quantities must not depend on the LLM reading Luganda number words (see voice-commerce.md).
    textNormalizers: { lg: normalizeLugandaNumbers },
    workingLanguage: 'en',
    maxDurationSeconds: config.VOICE_MAX_DURATION_SECONDS,
  });
}

/**
 * Composition root: the one place where concrete providers are chosen and wired.
 * Everything else depends on interfaces, so tests pass fakes through `overrides`.
 */
export function createContainer(
  config: ApiConfig,
  logger: Logger,
  overrides: ContainerOverrides = {},
) {
  const db = overrides.db ?? createPrismaClient({ databaseUrl: config.DATABASE_URL });
  const paypal =
    overrides.paypal ??
    new PayPalClient({
      clientId: config.PAYPAL_CLIENT_ID,
      clientSecret: config.PAYPAL_CLIENT_SECRET,
      environment: config.PAYPAL_ENV,
      logger: logger.child({ component: 'paypal' }),
    });
  const chatModel =
    overrides.chatModel !== undefined ? overrides.chatModel : createChatModel(config);
  const speech =
    overrides.speech !== undefined ? overrides.speech : createSpeechPipeline(config, logger);

  const alerts =
    overrides.alerts ??
    new OpsAlerts({
      webhookUrl: config.ALERT_WEBHOOK_URL,
      heartbeatUrl: config.HEARTBEAT_URL,
      logger: logger.child({ component: 'ops-alerts' }),
    });

  const channels = overrides.channels ?? new ChannelRegistry();
  if (!overrides.channels && config.WHATSAPP_GATEWAY_URL) {
    channels.register(
      new HttpWhatsAppSender(config.WHATSAPP_GATEWAY_URL, config.INTERNAL_SERVICE_TOKEN),
    );
  }

  const policy: PaymentPolicyConfig = {
    maxPaymentRequestAmount: config.MAX_PAYMENT_REQUEST_AMOUNT,
  };

  const audit = new AuditService(db);
  const customers = new CustomerService(db);
  const products = new ProductService(db, audit);
  const orders = new OrderService(db, customers, audit);
  const confirmations = new ConfirmationService(db, audit);
  const analytics = new AnalyticsService(db);
  const inventory = new InventoryService(db, audit);
  const admins = new AdminService(db, audit, config.DEFAULT_PHONE_REGION);
  const dashboardUsers = new DashboardUserService(db, audit);
  const reports = new ReportService(analytics, inventory);
  const notifications = new NotificationService(
    db,
    channels,
    logger.child({ component: 'notifications' }),
    admins,
  );
  const payments = new PaymentService(
    db,
    paypal,
    orders,
    audit,
    notifications,
    logger.child({ component: 'payments' }),
    {
      publicBaseUrl: config.API_PUBLIC_URL.replace(/\/$/, ''),
      brandName: config.PAYPAL_BRAND_NAME,
      policy,
      unpaidOrderExpiryHours: config.UNPAID_ORDER_EXPIRY_HOURS,
      alerts,
    },
    inventory,
  );
  const refunds = new RefundService(
    db,
    paypal,
    audit,
    notifications,
    logger.child({ component: 'refunds' }),
  );
  const orderLifecycle = new OrderLifecycleService(
    db,
    paypal,
    payments,
    notifications,
    audit,
    logger.child({ component: 'order-lifecycle' }),
  );
  const shipments = new ShipmentService(
    db,
    paypal,
    orders,
    audit,
    logger.child({ component: 'shipments' }),
  );
  const disputes = new DisputeService(
    db,
    paypal,
    audit,
    notifications,
    logger.child({ component: 'disputes' }),
  );
  const webhooks = new PayPalWebhookService(
    db,
    paypal,
    payments,
    disputes,
    logger.child({ component: 'paypal-webhooks' }),
    {
      webhookId: config.PAYPAL_WEBHOOK_ID,
      skipVerification:
        config.PAYPAL_WEBHOOK_SKIP_VERIFICATION && config.NODE_ENV === 'development',
      alerts,
    },
    refunds,
  );
  const reminders = new PaymentReminderService(
    db,
    paypal,
    orders,
    payments,
    notifications,
    audit,
    logger.child({ component: 'reminders' }),
    config.DEFAULT_PHONE_REGION,
  );
  const executor = new ConfirmationExecutor({
    orders,
    payments,
    reminders,
    shipments,
    disputes,
    confirmations,
    notifications,
    audit,
    policy,
    logger: logger.child({ component: 'executor' }),
  });
  // Customer commerce: its own catalog view, tools and conversation flow (admin tools never used).
  const whatsappAccounts = new WhatsAppAccountService(db, audit);
  const customerIdentity = new CustomerIdentityService(db, audit, config.DEFAULT_PHONE_REGION);
  const customerCatalog = new CustomerCatalog(db);
  const shopOrders = new ShopOrderService(
    db,
    orders,
    payments,
    notifications,
    audit,
    logger.child({ component: 'shop-orders' }),
  );
  const customerChats = new CustomerConversationService({
    db,
    audit,
    catalog: customerCatalog,
    shop: shopOrders,
    perMinute: config.CUSTOMER_MESSAGES_PER_MINUTE,
    tools: createCustomerTools(customerCatalog, shopOrders),
    chatModel,
    notifications,
    lifecycle: orderLifecycle,
    logger: logger.child({ component: 'customer-chat' }),
  });
  const tools = createCommerceTools({
    customerChats,
    customers,
    products,
    orders,
    confirmations,
    analytics,
    payments,
    reminders,
    shipments,
    disputes,
    inventory,
    reports,
    policy,
    confirmationTtlSeconds: config.CONFIRMATION_TTL_SECONDS,
  });
  const reconciler = new PaymentReconciler(
    db,
    paypal,
    payments,
    audit,
    logger.child({ component: 'reconciliation' }),
  );
  const reportScheduler = new ReportScheduler(
    db,
    new BusinessReportBuilder(db, analytics, inventory, disputes, reports, reconciler),
    admins,
    notifications,
    audit,
    logger.child({ component: 'reports' }),
    config.PAYMENT_RECONCILIATION_ENABLED ? reconciler : undefined,
    [
      {
        name: 'order-expiry',
        run: async (now) => {
          const expired = await orderLifecycle.expireDue(config.UNPAID_ORDER_EXPIRY_HOURS, now);
          if (expired.length) logger.info({ orders: expired }, 'unpaid orders expired');
        },
      },
    ],
    alerts,
  );
  const whatsappMonitor = new WhatsAppConnectionMonitor(
    db,
    notifications,
    config.WHATSAPP_GATEWAY_URL,
    config.INTERNAL_SERVICE_TOKEN,
    logger.child({ component: 'whatsapp-monitor' }),
    fetch,
    alerts,
  );
  const inbound = new InboundMessageService({
    db,
    audit,
    confirmations,
    executor,
    tools,
    chatModel,
    speech,
    mediaMaxBytes: config.MEDIA_MAX_BYTES,
    voiceMaxDurationSeconds: config.VOICE_MAX_DURATION_SECONDS,
    voiceMinConfidence: config.VOICE_MIN_CONFIDENCE,
    voiceLanguages:
      config.VOICE_EXPERIMENTAL_LUGANDA && config.SUNBIRD_API_KEY ? ['en', 'lg'] : ['en'],
    admins,
    customers: {
      enabled: config.CUSTOMER_COMMERCE_ENABLED,
      pilotNumbers: config.CUSTOMER_COMMERCE_PILOT_NUMBERS,
      accounts: whatsappAccounts,
      identity: customerIdentity,
      conversations: customerChats,
    },
    welcomeCooldownMs: config.UNAUTHORIZED_REPLY_COOLDOWN_HOURS * 60 * 60 * 1000,
    logger: logger.child({ component: 'inbound' }),
  });

  return {
    config,
    logger,
    db,
    paypal,
    chatModel,
    speech,
    channels,
    audit,
    customers,
    products,
    orders,
    confirmations,
    analytics,
    admins,
    dashboardUsers,
    inventory,
    notifications,
    payments,
    refunds,
    orderLifecycle,
    reminders,
    reconciler,
    whatsappAccounts,
    customerCatalog,
    customerChats,
    shopOrders,
    shipments,
    disputes,
    webhooks,
    tools,
    inbound,
    reportScheduler,
    whatsappMonitor,
    alerts,
    close: async () => {
      reportScheduler.stop();
      whatsappMonitor.stop();
      await db.$disconnect();
    },
  };
}

export type Container = ReturnType<typeof createContainer>;

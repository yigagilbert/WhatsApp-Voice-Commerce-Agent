import { z } from 'zod';

const emptyToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

/** Optional string where an empty value in .env means "not configured". */
const optionalString = z.preprocess(emptyToUndefined, z.string().min(1).optional());

const booleanString = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

const port = z.coerce.number().int().min(1).max(65535);

export const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
});

export const databaseSchema = z.object({
  DATABASE_URL: z.string().url(),
});

export const aiSchema = z.object({
  // Accepts "openai-compatible" or "openai_compatible".
  AI_PROVIDER: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim().replace(/_/g, '-') : v),
    z.enum(['openai-compatible']).default('openai-compatible'),
  ),
  AI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  AI_API_KEY: optionalString,
  AI_MODEL: z.string().min(1).default('gpt-4.1-mini'),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
});

export const speechSchema = z.object({
  /** Voice notes are answered with "coming soon" unless enabled. */
  VOICE_NOTES_ENABLED: booleanString,
  /** Longest voice note processed (checked before any STT call). */
  VOICE_MAX_DURATION_SECONDS: z.coerce.number().int().min(5).max(600).default(60),
  /** Below this ASR confidence (0..1) Katale AI asks "I heard: …, is that right?" first. */
  VOICE_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.5),
  /**
   * EXPERIMENTAL, frozen: route non-English voice notes to Sunbird AI (Luganda). Off by default:
   * English is the supported voice language; anything else is read back for a typed YES.
   */
  VOICE_EXPERIMENTAL_LUGANDA: booleanString,
  /** Sunbird AI (Luganda); used only when VOICE_EXPERIMENTAL_LUGANDA=true. */
  SUNBIRD_API_URL: z.string().url().default('https://api.sunbird.ai'),
  SUNBIRD_API_KEY: optionalString,
  STT_PROVIDER: z.enum(['openai-compatible', 'none']).default('openai-compatible'),
  STT_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  STT_API_KEY: optionalString,
  STT_MODEL: z.string().min(1).default('whisper-1'),
  TRANSLATION_PROVIDER: z.enum(['none', 'sunbird']).default('none'),
  /** Spoken languages translated to English before the agent (e.g. "lg"); empty = LLM reads them directly. */
  VOICE_TRANSLATE_LANGUAGES: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean),
    ),
  AUDIO_NORMALIZER: z.enum(['ffmpeg', 'none']).default('none'),
  FFMPEG_PATH: z.string().min(1).default('ffmpeg'),
  MEDIA_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),
});

export const paypalSchema = z.object({
  PAYPAL_ENV: z.enum(['sandbox', 'live']).default('sandbox'),
  PAYPAL_CLIENT_ID: optionalString,
  PAYPAL_CLIENT_SECRET: optionalString,
  PAYPAL_WEBHOOK_ID: optionalString,
  PAYPAL_BRAND_NAME: z.string().min(1).max(127).default('Katale AI'),
  PAYPAL_WEBHOOK_SKIP_VERIFICATION: booleanString,
  /**
   * Capture when the buyer returns to /api/paypal/return (default). When false, capture happens
   * only via the CHECKOUT.ORDER.APPROVED webhook (used to prove the "buyer never returns" path).
   */
  PAYPAL_CAPTURE_ON_RETURN: booleanString.default(true),
});

export const commerceSchema = z.object({
  DEFAULT_CURRENCY: z
    .string()
    .length(3)
    .transform((s) => s.toUpperCase())
    .default('USD'),
  CONFIRMATION_TTL_SECONDS: z.coerce.number().int().min(30).max(86_400).default(600),
  MAX_PAYMENT_REQUEST_AMOUNT: z.coerce.number().positive().default(10_000),
  /** Country used for admin phone numbers typed without a country code (ISO 3166 alpha-2). */
  DEFAULT_PHONE_REGION: z
    .string()
    .length(2)
    .transform((s) => s.toUpperCase())
    .default('UG'),
  /** Run the proactive report scheduler in this process (one API instance only). */
  REPORT_SCHEDULER_ENABLED: booleanString.default(true),
  /**
   * Unpaid orders (awaiting payment, or placed by a customer and awaiting approval) are cancelled
   * this many hours after they were sent for payment / placed, releasing reserved stock.
   * 0 turns expiry off. Runs on the report scheduler's tick.
   */
  UNPAID_ORDER_EXPIRY_HOURS: z.coerce
    .number()
    .min(0)
    .max(24 * 60)
    .default(72),
  /** Background re-check of open PayPal links (runs on the report scheduler's tick). */
  PAYMENT_RECONCILIATION_ENABLED: booleanString.default(true),
  /**
   * Server-wide switch for customer shopping on WhatsApp (off by default). Each bot number must
   * also turn it on in the dashboard; while off, customers get the generic welcome.
   */
  CUSTOMER_COMMERCE_ENABLED: booleanString.default(false),
  /**
   * Comma-separated E.164 numbers (e.g. "+256700000000") that may use customer shopping on a
   * connected shop number while it is off for everyone else: controlled end-to-end testing.
   * Admin numbers of that shop always get the admin assistant instead.
   */
  /** Messages per customer per minute before the shop bot asks them to slow down. */
  CUSTOMER_MESSAGES_PER_MINUTE: z.coerce.number().int().min(5).max(1000).default(15),
  CUSTOMER_COMMERCE_PILOT_NUMBERS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((n) => n.trim())
        .filter((n) => /^\+\d{6,15}$/.test(n)),
    ),
  /** Unregistered WhatsApp numbers get the generic welcome at most once per this many hours. */
  UNAUTHORIZED_REPLY_COOLDOWN_HOURS: z.coerce.number().min(0).max(8760).default(24),
});

export const apiSchema = baseSchema
  .extend(databaseSchema.shape)
  .extend(aiSchema.shape)
  .extend(speechSchema.shape)
  .extend(paypalSchema.shape)
  .extend(commerceSchema.shape)
  .extend({
    API_HOST: z.string().default('0.0.0.0'),
    API_PORT: port.default(4000),
    API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
    API_AUTH_TOKEN: z.string().min(16, 'API_AUTH_TOKEN must be at least 16 characters'),
    INTERNAL_SERVICE_TOKEN: z
      .string()
      .min(16, 'INTERNAL_SERVICE_TOKEN must be at least 16 characters'),
    CORS_ORIGINS: z
      .string()
      .default('http://localhost:3000')
      .transform((s) =>
        s
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean),
      ),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
    /**
     * Which X-Forwarded-For hops to trust for the client IP (rate limiting, logs). A number is a
     * hop count: 1 behind one Nginx (production) — the client can't spoof it. "true" trusts every
     * hop, so the left-most (client-supplied) value wins: avoid it. "false" = no proxy.
     */
    TRUST_PROXY: z
      .string()
      .default('false')
      .refine(
        (v) => /^(true|false|0|[1-9]\d?)$/.test(v),
        'TRUST_PROXY must be a hop count, true or false',
      )
      .transform((v): boolean | number =>
        v === 'true' ? true : v === 'false' || v === '0' ? false : Number(v),
      ),
    WHATSAPP_GATEWAY_URL: optionalString.pipe(z.string().url().optional()),
    /**
     * Operator alerts (failed webhooks, payment links, reports, background jobs; WhatsApp offline
     * 5+ min) as a plain-text POST — e.g. an ntfy.sh topic URL. Not WhatsApp: it may be what's down.
     */
    ALERT_WEBHOOK_URL: optionalString.pipe(z.string().url().optional()),
    /** Dead-man's switch (e.g. healthchecks.io): pinged at most every 5 min after healthy scheduler passes. */
    HEARTBEAT_URL: optionalString.pipe(z.string().url().optional()),
  });

export const whatsappSchema = baseSchema.extend({
  WHATSAPP_API_BASE_URL: z.string().url().default('http://localhost:4000'),
  WHATSAPP_SESSION_DIR: z.string().min(1).default('.data/whatsapp-session'),
  WHATSAPP_CLIENT_ID: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/, 'WHATSAPP_CLIENT_ID may only contain letters, digits, _ and -')
    .default('katale-dev'),
  WHATSAPP_HEADLESS: booleanString.default(true),
  WHATSAPP_CHROME_PATH: optionalString,
  WHATSAPP_GATEWAY_PORT: port.default(4100),
  /** Bind address of the internal gateway. 127.0.0.1 locally; 0.0.0.0 inside Docker. */
  WHATSAPP_GATEWAY_HOST: z.string().default('127.0.0.1'),
  /** Print the pairing QR in the logs. The dashboard's WhatsApp page shows it too; set false in production. */
  WHATSAPP_PRINT_QR: booleanString.default(true),
  /** Decline incoming WhatsApp calls (the bot can't take them) and suggest a voice note instead. */
  WHATSAPP_REJECT_CALLS: booleanString.default(true),
  INTERNAL_SERVICE_TOKEN: z
    .string()
    .min(16, 'INTERNAL_SERVICE_TOKEN must be at least 16 characters'),
  MEDIA_MAX_BYTES: speechSchema.shape.MEDIA_MAX_BYTES,
  /** Same flag as the API: when false, voice notes are not downloaded (forwarded as unsupported). */
  VOICE_NOTES_ENABLED: speechSchema.shape.VOICE_NOTES_ENABLED,
  VOICE_MAX_DURATION_SECONDS: speechSchema.shape.VOICE_MAX_DURATION_SECONDS,
});

export const webSchema = baseSchema.extend({
  API_BASE_URL: z.string().url().default('http://localhost:4000'),
  /** Shown as a "PayPal Sandbox" badge so nobody mistakes demo payments for real money. */
  PAYPAL_ENV: paypalSchema.shape.PAYPAL_ENV,
  /** AG Studio's analytics assistant calls the LLM through the dashboard server (key stays server-side). */
  ...aiSchema.pick({ AI_BASE_URL: true, AI_API_KEY: true, AI_MODEL: true, AI_TIMEOUT_MS: true })
    .shape,
  /** Optional AG Studio licence key (removes the evaluation watermark). */
  AG_STUDIO_LICENSE_KEY: optionalString,
  API_AUTH_TOKEN: z.string().min(16),
  /**
   * Bootstrap ("setup") login, accepted only while no dashboard account exists, so the first owner
   * can be created from the dashboard. It stops working as soon as one account exists.
   */
  DASHBOARD_USERNAME: z.string().min(1).default('admin'),
  /** No default: without it the setup login is refused (fails closed). */
  DASHBOARD_PASSWORD: optionalString.pipe(z.string().min(8).optional()),
  /**
   * Request header carrying the client IP, set by the reverse proxy (Nginx: X-Real-IP
   * $remote_addr), for the login throttle. Never X-Forwarded-For's first value: clients control it.
   */
  DASHBOARD_CLIENT_IP_HEADER: z
    .string()
    .min(1)
    .default('x-real-ip')
    .transform((v) => v.toLowerCase()),
  /** Session lifetime in hours. */
  DASHBOARD_SESSION_HOURS: z.coerce
    .number()
    .positive()
    .max(24 * 30)
    .default(12),
});

export type ApiConfig = z.infer<typeof apiSchema>;
export type WhatsAppConfig = z.infer<typeof whatsappSchema>;
export type WebConfig = z.infer<typeof webSchema>;

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import qrcode from 'qrcode-terminal';
import wwebjs from 'whatsapp-web.js';
import type { Logger } from '@vca/shared';
import type { WhatsAppMessageLike } from './message-mapper';

const { Client, LocalAuth, MessageMedia } = wwebjs;

/** Connection lifecycle shown on the dashboard's WhatsApp page. */
export type ConnectionState =
  'starting' | 'qr' | 'authenticated' | 'ready' | 'disconnected' | 'auth_failure';

export interface ConnectionStatus {
  state: ConnectionState;
  /** The current pairing code to render as a QR (only while state = qr). Never logged. */
  qr: string | null;
  qrUpdatedAt: string | null;
  stateChangedAt: string;
  /** Linked number, masked (e.g. "•••• 4821"). */
  account: string | null;
  /** Full bot ID for the API (internal gateway only; the dashboard proxy strips it). */
  botId?: string | null;
  lastDisconnectReason: string | null;
}

/** An incoming WhatsApp call (whatsapp-web.js can only report and reject calls, not carry audio). */
export interface IncomingCall {
  from: string | undefined;
  isGroup: boolean;
  isVideo: boolean;
  fromMe: boolean;
  reject(): Promise<void>;
}

export interface OutgoingImage {
  mimeType: string;
  dataBase64: string;
  filename?: string | undefined;
}

export interface DownloadedMedia {
  mimeType: string;
  dataBase64: string;
  filename?: string;
}

export interface IncomingWhatsAppMessage extends WhatsAppMessageLike {
  downloadMedia(): Promise<DownloadedMedia | null>;
  showTyping(): Promise<void>;
}

/**
 * The ONLY module that touches whatsapp-web.js. It exposes a tiny transport surface
 * (start / onMessage / sendText / isReady) so it can be swapped for the official
 * WhatsApp Cloud API without touching anything else.
 */
export interface WhatsAppTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: (message: IncomingWhatsAppMessage) => Promise<void>): void;
  sendText(chatId: string, text: string): Promise<void>;
  /** Sends an image with a caption (charts). */
  sendImage(chatId: string, image: OutgoingImage, caption: string): Promise<void>;
  isReady(): boolean;
  connection(): ConnectionStatus;
  /** Restarts the WhatsApp Web session (e.g. after a disconnect). Keeps the linked device. */
  reconnect(): Promise<void>;
  /** Unlinks this device; a new QR appears for pairing. */
  logout(): Promise<void>;
  onCall(handler: (call: IncomingCall) => Promise<void>): void;
  /** The E.164 phone behind a sender (resolves WhatsApp linked IDs), or null if unknown. */
  resolvePhone(chatId: string): Promise<string | null>;
  /** This bot's own WhatsApp ID ("256700000000@c.us") once ready, else null. */
  botId(): string | null;
}

export interface WhatsAppWebOptions {
  clientId: string;
  sessionDir: string;
  headless: boolean;
  chromePath?: string | undefined;
  /** Also print the QR in the logs (development). */
  printQr?: boolean;
  logger: Logger;
}

/**
 * Chromium refuses to open a profile whose Singleton* lock files exist ("profile appears to be in
 * use"). They survive container recreation on a persisted volume, so remove them before launch.
 * Safe because exactly one worker owns a session directory.
 */
export async function removeStaleProfileLocks(profileDir: string, log?: Logger): Promise<string[]> {
  const removed: string[] = [];
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try {
      await rm(join(profileDir, name), { force: true });
      removed.push(name);
    } catch (error) {
      log?.warn({ err: error, name }, 'could not remove Chromium lock file');
    }
  }
  return removed;
}

export class WhatsAppWebTransport implements WhatsAppTransport {
  private readonly client: InstanceType<typeof Client>;
  private readonly profileDir: string;
  private readonly log: Logger;
  private ready = false;
  private status: ConnectionStatus = {
    state: 'starting',
    qr: null,
    qrUpdatedAt: null,
    stateChangedAt: new Date().toISOString(),
    account: null,
    lastDisconnectReason: null,
  };
  private reconnecting: Promise<void> | null = null;
  private readonly phoneCache = new Map<string, string | null>();
  private readonly chatIdCache = new Map<string, string>();

  private setState(state: ConnectionState, patch: Partial<ConnectionStatus> = {}) {
    this.status = {
      ...this.status,
      ...patch,
      state,
      stateChangedAt: new Date().toISOString(),
      ...(state === 'qr' ? {} : { qr: null }),
    };
  }

  constructor(options: WhatsAppWebOptions) {
    // LocalAuth keeps the Chromium profile in <dataPath>/session-<clientId>.
    this.profileDir = join(options.sessionDir, `session-${options.clientId}`);
    this.log = options.logger;
    this.client = new Client({
      // LocalAuth persists the session under sessionDir so the QR is scanned once.
      authStrategy: new LocalAuth({ clientId: options.clientId, dataPath: options.sessionDir }),
      puppeteer: {
        headless: options.headless,
        ...(options.chromePath ? { executablePath: options.chromePath } : {}),
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      },
    });

    const log = options.logger;
    this.client.on('qr', (qr: string) => {
      this.setState('qr', { qr, qrUpdatedAt: new Date().toISOString() });
      log.info('WhatsApp needs pairing: open the dashboard (WhatsApp page) or scan the QR');
      if (options.printQr !== false) qrcode.generate(qr, { small: true });
    });
    // whatsapp-web.js can emit 'authenticated' several times per login; log it once.
    let authenticated = false;
    this.client.on('authenticated', () => {
      if (!authenticated) log.info('WhatsApp authenticated (session saved)');
      authenticated = true;
      if (this.status.state !== 'ready') this.setState('authenticated');
    });
    this.client.on('auth_failure', (message: string) => {
      this.setState('auth_failure');
      log.error({ message }, 'WhatsApp authentication failed');
    });
    this.client.on('ready', () => {
      this.ready = true;
      const user = (this.client.info as { wid?: { user?: string } } | undefined)?.wid?.user;
      this.setState('ready', { account: user ? `•••• ${user.slice(-4)}` : null });
      log.info('WhatsApp client ready');
    });
    this.client.on('disconnected', (reason: string) => {
      this.ready = false;
      authenticated = false;
      this.setState('disconnected', { lastDisconnectReason: String(reason) });
      log.error({ reason }, 'WhatsApp disconnected — reconnecting in 10 s (or use the dashboard)');
      // One automatic attempt; after a logout this shows a fresh QR on the dashboard.
      setTimeout(() => {
        if (this.status.state === 'disconnected') void this.reconnect().catch(() => undefined);
      }, 10_000);
    });
  }

  async start(): Promise<void> {
    await removeStaleProfileLocks(this.profileDir, this.log);
    await this.client.initialize();
  }

  async stop(): Promise<void> {
    this.ready = false;
    await this.client.destroy();
  }

  isReady(): boolean {
    return this.ready;
  }

  botId(): string | null {
    if (!this.ready) return null;
    return (
      (this.client.info as { wid?: { _serialized?: string } } | undefined)?.wid?._serialized ?? null
    );
  }

  connection(): ConnectionStatus {
    return { ...this.status, botId: this.botId() };
  }

  reconnect(): Promise<void> {
    // Serialise: concurrent requests share one restart.
    this.reconnecting ??= (async () => {
      this.ready = false;
      this.setState('starting');
      await this.client.destroy().catch(() => undefined);
      await removeStaleProfileLocks(this.profileDir, this.log);
      await this.client.initialize();
    })().finally(() => {
      this.reconnecting = null;
    });
    return this.reconnecting;
  }

  async logout(): Promise<void> {
    this.ready = false;
    await this.client
      .logout()
      .catch((error: unknown) =>
        this.log.warn({ err: error }, 'WhatsApp logout reported an error'),
      );
    this.setState('disconnected', { account: null, lastDisconnectReason: 'LOGOUT' });
    await this.reconnect();
  }

  onCall(handler: (call: IncomingCall) => Promise<void>): void {
    this.client.on('call', (call: wwebjs.Call) => {
      void handler({
        from: call.from,
        isGroup: call.isGroup,
        isVideo: call.isVideo,
        fromMe: call.fromMe,
        reject: () => call.reject(),
      });
    });
  }

  async sendImage(chatId: string, image: OutgoingImage, caption: string): Promise<void> {
    if (!this.ready) throw new Error('WhatsApp client is not ready');
    const media = new MessageMedia(image.mimeType, image.dataBase64, image.filename ?? 'chart.png');
    await this.client.sendMessage(await this.toChatId(chatId), media, { caption });
  }

  onMessage(handler: (message: IncomingWhatsAppMessage) => Promise<void>): void {
    // 'message' fires for messages received by this account (not ones it sends).
    const onIncoming = (msg: wwebjs.Message) => {
      const incoming: IncomingWhatsAppMessage = Object.assign(Object.create(null) as object, {
        // Passed through as-is; serializeMessageId() copes with missing `_serialized`.
        id: { ...(msg.id as object) },
        from: msg.from,
        fromMe: msg.fromMe,
        isStatus: msg.isStatus,
        broadcast: msg.broadcast,
        type: msg.type,
        body: msg.body,
        timestamp: msg.timestamp,
        hasMedia: msg.hasMedia,
        // WhatsApp reports voice-note length (seconds, as a string) — used as a duration hint.
        duration: (msg as unknown as { duration?: string | number }).duration,
        _data: {
          notifyName: (msg as unknown as { _data?: { notifyName?: string } })._data?.notifyName,
        },
        downloadMedia: async () => {
          const media = await msg.downloadMedia();
          if (!media) return null;
          return {
            mimeType: media.mimetype,
            dataBase64: media.data,
            ...(media.filename ? { filename: media.filename } : {}),
          };
        },
        showTyping: async () => {
          const chat = await msg.getChat();
          await chat.sendStateTyping();
        },
      });
      void handler(incoming);
    };
    // 'message' fires for received messages, but current WhatsApp Web builds don't always emit
    // it (observed with @lid contacts). 'message_create' fires for every new message, so we
    // listen to both and take only incoming ones; the caller de-duplicates by message ID.
    this.client.on('message', onIncoming);
    this.client.on('message_create', (msg: wwebjs.Message) => {
      if (!msg.fromMe) onIncoming(msg);
    });
  }

  async sendText(chatId: string, text: string): Promise<void> {
    if (!this.ready) throw new Error('WhatsApp client is not ready');
    await this.client.sendMessage(await this.toChatId(chatId), text);
  }

  /**
   * Phone-number chats (admins added by number, "2567…@c.us") are checked with getNumberId so a
   * number that isn't on WhatsApp fails clearly instead of silently.
   */
  private async toChatId(chatId: string): Promise<string> {
    if (!chatId.endsWith('@c.us')) return chatId;
    const cached = this.chatIdCache.get(chatId);
    if (cached) return cached;
    const id = await this.client.getNumberId(chatId.replace('@c.us', ''));
    if (!id) throw new Error('This number is not on WhatsApp');
    this.chatIdCache.set(chatId, id._serialized);
    return id._serialized;
  }

  async resolvePhone(chatId: string): Promise<string | null> {
    const direct = /^(\d{6,15})@c\.us$/.exec(chatId);
    if (direct) return `+${direct[1]}`;
    if (!chatId.endsWith('@lid')) return null;
    if (this.phoneCache.has(chatId)) return this.phoneCache.get(chatId)!;
    let phone: string | null = null;
    try {
      const [entry] = await this.client.getContactLidAndPhone([chatId]);
      const digits = /^(\d{6,15})@/.exec(entry?.pn ?? '')?.[1];
      phone = digits ? `+${digits}` : null;
    } catch (error) {
      this.log.debug({ err: error }, 'could not resolve linked ID to a phone number');
    }
    this.phoneCache.set(chatId, phone);
    if (this.phoneCache.size > 5000) this.phoneCache.delete(this.phoneCache.keys().next().value!);
    return phone;
  }
}

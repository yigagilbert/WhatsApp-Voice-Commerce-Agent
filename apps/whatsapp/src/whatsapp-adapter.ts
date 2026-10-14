import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import qrcode from 'qrcode-terminal';
import wwebjs from 'whatsapp-web.js';
import type { Logger } from '@vca/shared';
import type { WhatsAppMessageLike } from './message-mapper';

const { Client, LocalAuth } = wwebjs;

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
  isReady(): boolean;
}

export interface WhatsAppWebOptions {
  clientId: string;
  sessionDir: string;
  headless: boolean;
  chromePath?: string | undefined;
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
      log.info('Scan this QR code with WhatsApp → Settings → Linked devices → Link a device');
      qrcode.generate(qr, { small: true });
    });
    // whatsapp-web.js can emit 'authenticated' several times per login; log it once.
    let authenticated = false;
    this.client.on('authenticated', () => {
      if (!authenticated) log.info('WhatsApp authenticated (session saved)');
      authenticated = true;
    });
    this.client.on('auth_failure', (message: string) =>
      log.error({ message }, 'WhatsApp authentication failed'),
    );
    this.client.on('ready', () => {
      this.ready = true;
      log.info('WhatsApp client ready');
    });
    this.client.on('disconnected', (reason: string) => {
      this.ready = false;
      log.error({ reason }, 'WhatsApp disconnected — restart the worker to reconnect');
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
    await this.client.sendMessage(chatId, text);
  }
}

import { describe, expect, it } from 'vitest';
import { inboundChannelMessageSchema } from '@vca/shared';
import { RecentIds } from './dedupe';
import { mapWhatsAppMessage, serializeMessageId, type WhatsAppMessageLike } from './message-mapper';

const base: WhatsAppMessageLike = {
  id: { _serialized: 'false_15550001111@c.us_ABC' },
  from: '15550001111@c.us',
  fromMe: false,
  isStatus: false,
  type: 'chat',
  body: 'Create an order for Sarah',
  timestamp: 1_790_000_000,
  hasMedia: false,
  _data: { notifyName: 'Demo Owner' },
};

describe('mapWhatsAppMessage', () => {
  it('maps text messages to the channel contract', () => {
    const mapped = mapWhatsAppMessage(base);
    expect(mapped).toEqual({
      kind: 'text',
      message: {
        channel: 'whatsapp',
        externalMessageId: 'false_15550001111@c.us_ABC',
        externalChatId: '15550001111@c.us',
        senderId: '15550001111@c.us',
        senderName: 'Demo Owner',
        sentAt: new Date(1_790_000_000_000),
        type: 'text',
        text: 'Create an order for Sarah',
      },
    });
  });

  it('marks voice notes for media download only when voice is enabled', () => {
    const voice = { ...base, type: 'ptt', body: '', hasMedia: true };
    expect(mapWhatsAppMessage(voice, { voiceNotesEnabled: true }).kind).toBe('audio');
    // Disabled (default): no download, forwarded as unsupported "voice".
    expect(mapWhatsAppMessage(voice)).toMatchObject({
      kind: 'unsupported',
      message: { type: 'unsupported', unsupportedKind: 'voice' },
    });
  });

  it.each([
    [{ fromMe: true }, 'from_me'],
    [{ isStatus: true }, 'status'],
    [{ from: '12345@g.us' }, 'group'],
    [{ from: '120363000000000000@newsletter' }, 'broadcast'],
    [{ type: 'revoked' }, 'unsupported_type'],
    [{ type: 'e2e_notification' }, 'unsupported_type'],
    [{ body: '   ' }, 'empty'],
  ] as const)('skips %o', (override, reason) => {
    expect(mapWhatsAppMessage({ ...base, ...override })).toEqual({ kind: 'skip', reason });
  });
});

describe('unsupported user content', () => {
  it.each([
    ['image', 'image'],
    ['video', 'video'],
    ['document', 'document'],
    ['sticker', 'sticker'],
    ['location', 'location'],
    ['vcard', 'contact'],
  ] as const)('forwards %s as unsupported (%s) without media', (type, kind) => {
    const mapped = mapWhatsAppMessage({ ...base, type, body: '', hasMedia: true });
    expect(mapped).toMatchObject({
      kind: 'unsupported',
      message: {
        type: 'unsupported',
        unsupportedKind: kind,
        externalMessageId: base.id._serialized,
      },
    });
    expect(mapped.kind === 'unsupported' && mapped.message.media).toBeFalsy();
  });

  it('produces messages the API contract accepts', () => {
    const mapped = mapWhatsAppMessage({ ...base, type: 'image', body: '', hasMedia: true });
    expect(
      mapped.kind === 'unsupported' &&
        inboundChannelMessageSchema.safeParse(mapped.message).success,
    ).toBe(true);
    const text = mapWhatsAppMessage(base);
    expect(
      text.kind === 'text' && inboundChannelMessageSchema.safeParse(text.message).success,
    ).toBe(true);
  });
});

describe('serializeMessageId', () => {
  it('uses _serialized when present', () => {
    expect(
      serializeMessageId({
        _serialized: 'false_1@c.us_ABC',
        fromMe: false,
        remote: '1@c.us',
        id: 'ABC',
      }),
    ).toBe('false_1@c.us_ABC');
  });

  it('rebuilds the ID when _serialized is missing (observed with current WhatsApp Web)', () => {
    expect(serializeMessageId({ fromMe: false, remote: '15550001111@c.us', id: '3EB0ABC' })).toBe(
      'false_15550001111@c.us_3EB0ABC',
    );
    expect(
      serializeMessageId({ fromMe: false, remote: { user: '123456789', server: 'lid' }, id: 'X1' }),
    ).toBe('false_123456789@lid_X1');
    expect(serializeMessageId({ fromMe: true, remote: { _serialized: '1@c.us' }, id: 'Y' })).toBe(
      'true_1@c.us_Y',
    );
  });

  it('accepts the `$1` serialized id used by current WhatsApp Web', () => {
    expect(
      serializeMessageId({ $1: 'false_1@lid_ABC', fromMe: false, remote: '1@lid', id: 'ABC' }),
    ).toBe('false_1@lid_ABC');
  });

  it('returns null rather than inventing an ID', () => {
    expect(serializeMessageId({ remote: '1@c.us' })).toBeNull();
    expect(serializeMessageId(undefined)).toBeNull();
  });

  it('skips messages without a usable ID (never forwards undefined)', () => {
    expect(mapWhatsAppMessage({ ...base, id: { fromMe: false } })).toEqual({
      kind: 'skip',
      reason: 'no_id',
    });
    const rebuilt = mapWhatsAppMessage({
      ...base,
      id: { fromMe: false, remote: '15550001111@c.us', id: 'ABC' },
    });
    expect(rebuilt.kind === 'text' && rebuilt.message.externalMessageId).toBe(
      'false_15550001111@c.us_ABC',
    );
  });
});

describe('RecentIds', () => {
  it('drops repeats and evicts the oldest entries', () => {
    const recent = new RecentIds(2);
    expect(recent.add('a')).toBe(true);
    expect(recent.add('a')).toBe(false);
    recent.add('b');
    recent.add('c');
    expect(recent.add('a')).toBe(true);
  });
});

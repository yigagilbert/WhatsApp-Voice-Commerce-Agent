import { describe, expect, it } from 'vitest';
import { deliverReplies, type ReplyToSend } from './deliver';

const photo = { mimeType: 'image/jpeg', dataBase64: 'AAAA', filename: 'product.jpg' };

const transport = (imageFails: boolean) => {
  const sent: string[] = [];
  return {
    sent,
    sendText: async (_chat: string, text: string) => void sent.push(`text: ${text}`),
    sendImage: async (_chat: string, _image: unknown, caption: string) => {
      if (imageFails) throw new Error('Evaluation failed: b');
      sent.push(`image: ${caption}`);
    },
  };
};

// Production (2 Nov): a customer replying "2" to the product list got "Sorry, something went
// wrong" because the product photo failed to send and the details after it were never sent.
const productDetails: ReplyToSend[] = [
  { externalChatId: 'c@c.us', text: 'Coffee Gift Pack — $25.00', media: photo },
  { externalChatId: 'c@c.us', text: '*Coffee Gift Pack*\n$25.00 · In stock' },
];

describe('deliverReplies', () => {
  it('sends the photo, then the details', async () => {
    const t = transport(false);
    await deliverReplies(t, productDetails, { warn: () => undefined });
    expect(t.sent).toEqual([
      'image: Coffee Gift Pack — $25.00',
      'text: *Coffee Gift Pack*\n$25.00 · In stock',
    ]);
  });

  it('still sends the details when WhatsApp refuses the photo', async () => {
    const t = transport(true);
    const warnings: string[] = [];
    await deliverReplies(t, productDetails, { warn: (_o, m) => void warnings.push(m) });
    expect(t.sent).toEqual([
      'text: Coffee Gift Pack — $25.00',
      'text: *Coffee Gift Pack*\n$25.00 · In stock',
    ]);
    expect(warnings).toEqual(['image reply could not be sent; sending its text instead']);
  });

  it('lets text failures through (nothing useful could be sent)', async () => {
    const t = {
      sendText: async () => {
        throw new Error('WhatsApp client is not ready');
      },
      sendImage: async () => undefined,
    };
    await expect(
      deliverReplies(t, [{ externalChatId: 'c@c.us', text: 'hi' }], { warn: () => undefined }),
    ).rejects.toThrow('not ready');
  });
});

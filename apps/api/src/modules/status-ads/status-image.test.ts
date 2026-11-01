import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { renderStatusImage, STATUS_H, STATUS_W, wrapText } from './status-image';

describe('wrapText', () => {
  it('wraps by width and ends overflow with an ellipsis', () => {
    expect(wrapText('Woven tote', 50, 1000, 2)).toEqual(['Woven tote']);
    const lines = wrapText('one two three four five six seven eight nine ten', 50, 300, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1]!.endsWith('…')).toBe(true);
  });

  it('cuts a single word longer than a line', () => {
    expect(wrapText('x'.repeat(80), 50, 300, 1)[0]!.endsWith('…')).toBe(true);
  });
});

describe('renderStatusImage', () => {
  it('renders a 1080 × 1920 JPEG around the product photo, escaping text', async () => {
    const photo = await sharp({
      create: { width: 800, height: 600, channels: 3, background: '#aa7744' },
    })
      .png()
      .toBuffer();
    const image = await renderStatusImage({
      shopName: 'Rose & Co <Crafts>',
      headline: 'Have you seen this?',
      productName: 'Woven "Market" Tote',
      price: '$18.50',
      cta: 'Message us to order',
      theme: 5,
      photo,
    });
    const meta = await sharp(image).metadata();
    expect(meta).toMatchObject({ format: 'jpeg', width: STATUS_W, height: STATUS_H });
  });
});

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { ProviderError, ValidationError } from '@vca/shared';
import { processProductImage } from './image-processing';
import { R2ObjectStore } from './object-store';

const photo = (width: number, height: number, format: 'jpeg' | 'png' | 'webp' = 'jpeg') => {
  const image = sharp({ create: { width, height, channels: 4, background: '#3366cc80' } });
  return (
    format === 'png' ? image.png() : format === 'webp' ? image.webp() : image.jpeg()
  ).toBuffer();
};

describe('processProductImage', () => {
  it('resizes large photos to 1600 px JPEG and makes a 320 px square thumbnail', async () => {
    const out = await processProductImage(await photo(3200, 1800));
    expect(out).toMatchObject({ width: 1600, height: 900, mimeType: 'image/jpeg' });
    expect((await sharp(out.main).metadata()).format).toBe('jpeg');
    const thumb = await sharp(out.thumb).metadata();
    expect([thumb.width, thumb.height, thumb.format]).toEqual([320, 320, 'jpeg']);
  });

  it('keeps small photos at their size and converts PNG/WebP to JPEG', async () => {
    for (const format of ['png', 'webp'] as const) {
      const out = await processProductImage(await photo(800, 600, format));
      expect([out.width, out.height]).toEqual([800, 600]);
      expect((await sharp(out.main).metadata()).format).toBe('jpeg');
    }
  });

  it('strips metadata such as GPS location', async () => {
    const withExif = await sharp(await photo(800, 600))
      .withExif({ IFD0: { Make: 'PhoneCo', Model: 'X1' } })
      .jpeg()
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();
    const out = await processProductImage(withExif);
    expect((await sharp(out.main).metadata()).exif).toBeUndefined();
  });

  it('rejects files that are not images, whatever their name or type', async () => {
    await expect(processProductImage(Buffer.from('%PDF-1.7 not a photo'))).rejects.toThrow(
      ValidationError,
    );
    await expect(processProductImage(await photo(32, 32))).rejects.toThrow(/too small/);
  });
});

describe('R2ObjectStore', () => {
  const recording = (status = 200, body = 'bytes') => {
    const calls: { url: string; method: string; headers: Headers }[] = [];
    const fetchImpl = (async (input: Request | string | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      calls.push({ url: req.url, method: req.method, headers: req.headers });
      return new Response(status === 204 ? null : body, { status });
    }) as typeof fetch;
    const store = new R2ObjectStore({
      accountId: 'acct123',
      accessKeyId: 'AKID',
      secretAccessKey: 'secret',
      bucket: 'katale-products',
      fetch: fetchImpl,
    });
    return { store, calls };
  };

  it('signs requests to the account endpoint and bucket (SigV4, region auto)', async () => {
    const { store, calls } = recording();
    await store.put('merchants/m1/products/p1/a.jpg', new Uint8Array([1, 2, 3]), 'image/jpeg');
    expect(calls[0]!.url).toBe(
      'https://acct123.r2.cloudflarestorage.com/katale-products/merchants/m1/products/p1/a.jpg',
    );
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.headers.get('authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/auto\/s3\/aws4_request/,
    );
    expect(calls[0]!.headers.get('content-type')).toBe('image/jpeg');
  });

  it('returns null for a missing object and treats deleting it as done', async () => {
    const { store } = recording(404);
    expect(await store.get('a/b.jpg')).toBeNull();
    await expect(store.delete('a/b.jpg')).resolves.toBeUndefined();
  });

  it('reports provider errors and refuses unsafe keys', async () => {
    const { store } = recording(500);
    await expect(store.get('a/b.jpg')).rejects.toThrow(ProviderError);
    await expect(store.get('../other-bucket/x.jpg')).rejects.toThrow(/Invalid object key/);
  });
});

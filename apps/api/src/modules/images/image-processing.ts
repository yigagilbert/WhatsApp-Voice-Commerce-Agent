import sharp from 'sharp';
import { ValidationError } from '@vca/shared';

/** Longest side of the stored main image: sharp on a phone, light for WhatsApp. */
export const MAIN_MAX_PX = 1600;
export const THUMB_PX = 320;
/** Refuse decompression bombs: no source image larger than this many pixels. */
const MAX_INPUT_PIXELS = 40_000_000;
const ACCEPTED = new Set(['jpeg', 'png', 'webp', 'heif', 'avif']);

export interface ProcessedImage {
  main: Buffer;
  thumb: Buffer;
  width: number;
  height: number;
  mimeType: 'image/jpeg';
}

/**
 * Turns an uploaded photo into what Katale stores: the file is decoded (so a renamed non-image is
 * rejected whatever its extension or declared type), rotated by its EXIF orientation, stripped of
 * metadata (EXIF/GPS), and re-encoded as a ≤1600 px JPEG plus a 320 px square thumbnail. JPEG is
 * what WhatsApp shows best; PNG/WebP/HEIC uploads are converted.
 */
export async function processProductImage(input: Buffer): Promise<ProcessedImage> {
  let meta: sharp.Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch {
    throw new ValidationError('That file is not a photo we can read. Upload a JPEG, PNG or WebP.');
  }
  if (!meta.format || !ACCEPTED.has(meta.format))
    throw new ValidationError('Upload a JPEG, PNG or WebP photo.');
  if (!meta.width || !meta.height || meta.width < 64 || meta.height < 64)
    throw new ValidationError('That photo is too small. Use one at least 64 × 64 pixels.');

  const base = () =>
    sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      // Transparent PNGs get a white background instead of black when flattened to JPEG.
      .flatten({ background: '#ffffff' });
  try {
    const { data: main, info } = await base()
      .resize(MAIN_MAX_PX, MAIN_MAX_PX, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    const thumb = await base()
      .resize(THUMB_PX, THUMB_PX, { fit: 'cover', position: 'attention' })
      .jpeg({ quality: 76, mozjpeg: true })
      .toBuffer();
    return { main, thumb, width: info.width, height: info.height, mimeType: 'image/jpeg' };
  } catch {
    throw new ValidationError('That photo could not be processed. Try another file.');
  }
}

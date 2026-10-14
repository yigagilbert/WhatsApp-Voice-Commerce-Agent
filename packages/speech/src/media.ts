import { ValidationError } from '@vca/shared';

/** Audio formats we accept from channels. WhatsApp voice notes are OGG/Opus. */
export const ALLOWED_AUDIO_MIME_TYPES = new Set([
  'audio/ogg',
  'audio/opus',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/x-m4a',
  'audio/wav',
  'audio/x-wav',
  'audio/webm',
]);

/** "audio/ogg; codecs=opus" -> "audio/ogg" */
export const normalizeMimeType = (mimeType: string): string =>
  mimeType.split(';')[0]!.trim().toLowerCase();

const EXTENSIONS: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
};
export const extensionForMimeType = (mimeType: string): string =>
  EXTENSIONS[normalizeMimeType(mimeType)] ?? 'bin';

/**
 * Safely decodes channel-provided audio: MIME allow-list, size limit checked BEFORE decoding,
 * strict base64, and a magic-byte check for OGG. The bytes are only ever kept in memory and
 * streamed to providers — never written to a user-controlled path.
 */
export function decodeAudioMedia(params: {
  dataBase64: string;
  mimeType: string;
  maxBytes: number;
}): {
  data: Buffer;
  mimeType: string;
} {
  const mimeType = normalizeMimeType(params.mimeType);
  if (!ALLOWED_AUDIO_MIME_TYPES.has(mimeType)) {
    throw new ValidationError(`Unsupported audio type '${mimeType}'`);
  }
  const estimatedBytes = Math.floor((params.dataBase64.length * 3) / 4);
  if (estimatedBytes > params.maxBytes) {
    throw new ValidationError(`Audio exceeds the ${params.maxBytes}-byte limit`);
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(params.dataBase64)) {
    throw new ValidationError('Audio payload is not valid base64');
  }
  const data = Buffer.from(params.dataBase64, 'base64');
  if (data.length === 0) throw new ValidationError('Audio payload is empty');
  if (
    (mimeType === 'audio/ogg' || mimeType === 'audio/opus') &&
    data.subarray(0, 4).toString('latin1') !== 'OggS'
  ) {
    throw new ValidationError('Audio payload does not look like an OGG file');
  }
  return { data, mimeType };
}

/** The voice note is longer than the configured maximum (checked before any STT call). */
export class AudioTooLongError extends ValidationError {
  constructor(
    public readonly durationSeconds: number,
    public readonly maxSeconds: number,
  ) {
    super(`Audio is ${Math.round(durationSeconds)}s; the maximum is ${maxSeconds}s`, {
      durationSeconds,
      maxSeconds,
    });
  }
}

/**
 * Duration of an Ogg/Opus stream (WhatsApp voice notes) read from the container itself:
 * the last page's granule position minus the OpusHead pre-skip, at Opus' fixed 48 kHz.
 * Pure and fast (no ffmpeg). Returns undefined for anything that isn't Ogg/Opus.
 */
export function oggOpusDurationSeconds(data: Buffer): number | undefined {
  if (data.length < 27 || data.subarray(0, 4).toString('latin1') !== 'OggS') return undefined;
  const head = data.indexOf('OpusHead', 0, 'latin1');
  if (head < 0 || head + 12 > data.length) return undefined;
  const preSkip = data.readUInt16LE(head + 10);
  let page = data.lastIndexOf('OggS', data.length - 4, 'latin1');
  while (page >= 0) {
    if (page + 14 <= data.length) {
      const granule = data.readBigInt64LE(page + 6);
      // -1 means "no packet finishes on this page"; keep looking backwards.
      if (granule >= 0n) return Math.max(0, Number(granule - BigInt(preSkip)) / 48_000);
    }
    page = page > 0 ? data.lastIndexOf('OggS', page - 1, 'latin1') : -1;
  }
  return undefined;
}

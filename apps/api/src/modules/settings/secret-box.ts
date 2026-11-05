import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Authenticated encryption (AES-256-GCM) for API keys stored in the database, so a stolen database
 * or backup doesn't give away the keys. The master key stays in the server's environment: it can't
 * live in the database it protects. The secret's name is bound in, so a row can't be swapped for
 * another without failing to decrypt.
 */
const VERSION = 'v1';
const INFO = 'katale-app-secrets-v1';

const deriveKey = (master: string) =>
  Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), INFO, 32));

export function seal(plaintext: string, name: string, master: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(master), iv);
  cipher.setAAD(Buffer.from(name));
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), data]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join('.');
}

/** The plaintext, or null if it can't be read (for example, the master key was changed). */
export function open(sealed: string, name: string, master: string): string | null {
  const [version, iv, tag, data] = sealed.split('.');
  if (version !== VERSION || !iv || !tag || !data) return null;
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      deriveKey(master),
      Buffer.from(iv, 'base64url'),
    );
    decipher.setAAD(Buffer.from(name));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(data, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

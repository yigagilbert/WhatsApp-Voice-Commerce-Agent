import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { removeStaleProfileLocks, sendImageWithFallback } from './whatsapp-adapter';

describe('removeStaleProfileLocks', () => {
  it('removes Chromium Singleton locks but keeps the session data', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'katale-profile-'));
    for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'Local State']) {
      await writeFile(join(dir, f), 'x');
    }
    await removeStaleProfileLocks(dir);
    expect(await readdir(dir)).toEqual(['Local State']);
  });

  it('is a no-op when the profile does not exist yet (first QR login)', async () => {
    await expect(
      removeStaleProfileLocks(join(tmpdir(), 'katale-missing-profile')),
    ).resolves.toBeDefined();
  });
});

describe('sendImageWithFallback', () => {
  const logger = () => {
    const lines: string[] = [];
    return {
      lines,
      warn: (_o: object, msg: string) => void lines.push(`warn ${msg}`),
      error: (_o: object, msg: string) => void lines.push(`error ${msg}`),
    };
  };

  it('sends inline when that works', async () => {
    const log = logger();
    let documents = 0;
    expect(
      await sendImageWithFallback(
        async () => 'ok',
        async () => documents++,
        log,
      ),
    ).toBe('inline');
    expect(documents).toBe(0);
  });

  it('falls back to a document when the inline image fails', async () => {
    const log = logger();
    const result = await sendImageWithFallback(
      async () => {
        throw new Error('Evaluation failed: media upload');
      },
      async () => 'ok',
      log,
    );
    expect(result).toBe('document');
    expect(log.lines).toEqual(['warn inline image send failed; retrying as a document']);
  });

  it('fails with both reasons logged when neither works', async () => {
    const log = logger();
    await expect(
      sendImageWithFallback(
        async () => {
          throw new Error('inline broke');
        },
        async () => {
          throw new Error('document broke');
        },
        log,
      ),
    ).rejects.toThrow('document broke');
    expect(log.lines.at(-1)).toBe('error image send failed');
  });
});

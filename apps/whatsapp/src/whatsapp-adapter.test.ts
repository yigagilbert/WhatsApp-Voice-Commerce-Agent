import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { removeStaleProfileLocks } from './whatsapp-adapter';

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

import { describe, expect, it } from 'vitest';
import { checkPasswordPolicy, hashPassword, verifyPassword } from './dashboard-user.service';

describe('dashboard passwords', () => {
  it('hashes with a random salt and verifies only the right password', async () => {
    const a = await hashPassword('correct horse battery');
    const b = await hashPassword('correct horse battery');
    expect(a).toMatch(/^scrypt\$\d+\$\d+\$\d+\$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain('correct horse battery');
    expect(await verifyPassword('correct horse battery', a)).toBe(true);
    expect(await verifyPassword('correct horse batterY', a)).toBe(false);
    expect(await verifyPassword('anything', 'plain-text')).toBe(false);
  });

  it('enforces a minimum length and no username in the password', () => {
    expect(() => checkPasswordPolicy('short')).toThrow(/at least 12/);
    expect(() => checkPasswordPolicy('sarah-password-2026', 'sarah')).toThrow(/username/);
    expect(() => checkPasswordPolicy('a long passphrase here', 'sarah')).not.toThrow();
  });
});

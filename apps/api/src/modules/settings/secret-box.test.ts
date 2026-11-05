import { describe, expect, it } from 'vitest';
import { open, seal } from './secret-box';

const master = 'a-long-random-master-secret';

describe('secret box', () => {
  it('round-trips, and never stores the plaintext', () => {
    const sealed = seal('sk-very-secret', 'AI_API_KEY', master);
    expect(sealed).not.toContain('sk-very-secret');
    expect(open(sealed, 'AI_API_KEY', master)).toBe('sk-very-secret');
  });

  it('encrypts the same value differently each time', () => {
    expect(seal('x', 'AI_API_KEY', master)).not.toBe(seal('x', 'AI_API_KEY', master));
  });

  it('returns null for the wrong master key, a swapped row or tampering', () => {
    const sealed = seal('sk-very-secret', 'AI_API_KEY', master);
    expect(open(sealed, 'AI_API_KEY', 'a-different-master-secret')).toBeNull();
    expect(open(sealed, 'AG_STUDIO_LICENSE_KEY', master)).toBeNull();
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(open(parts.join('.'), 'AI_API_KEY', master)).toBeNull();
    expect(open('garbage', 'AI_API_KEY', master)).toBeNull();
  });
});

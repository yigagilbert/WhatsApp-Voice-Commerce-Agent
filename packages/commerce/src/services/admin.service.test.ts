import { describe, expect, it } from 'vitest';
import { chatIdToPhone, maskPhone, normalizePhone, phoneToChatId } from './admin.service';

describe('admin phone numbers', () => {
  it('normalises local and international formats to E.164', () => {
    expect(normalizePhone('0772 123456')).toBe('+256772123456');
    expect(normalizePhone('+256 (772) 123-456')).toBe('+256772123456');
    expect(normalizePhone('  +44 7911 123456 ')).toBe('+447911123456');
    expect(normalizePhone('07911 123456', 'GB')).toBe('+447911123456');
  });

  it('rejects numbers that are not valid', () => {
    expect(() => normalizePhone('12345')).toThrow(/not a valid phone number/);
    expect(() => normalizePhone('hello')).toThrow(/not a valid phone number/);
    expect(() => normalizePhone('+256 12')).toThrow(/not a valid phone number/);
  });

  it('converts between phone numbers and WhatsApp chat IDs', () => {
    expect(phoneToChatId('+256772123456')).toBe('256772123456@c.us');
    expect(chatIdToPhone('256772123456@c.us')).toBe('+256772123456');
    expect(chatIdToPhone('123456789012345@lid')).toBeNull();
    expect(maskPhone('+256772123456')).toBe('+256•••3456');
  });
});
